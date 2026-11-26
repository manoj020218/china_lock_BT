/**
 * Gateway setup + discovery, so users never type an IP address.
 *
 * - The native JenixNet plugin (android/.../JenixNetPlugin.java) reports the
 *   phone's Wi-Fi IPv4 and can bind app traffic to Wi-Fi while the phone is
 *   on the gateway's internet-less setup AP.
 * - discoverGateways() probes /api/health (no token needed) across the phone's
 *   /24 subnet, plus the subnets of previously known gateway IPs, and matches
 *   gateways by their stable device_id.
 * - resolveGateway() checks a saved gateway and, if its IP changed (DHCP),
 *   finds it again by device_id and updates the store.
 */

import { Capacitor, registerPlugin } from "@capacitor/core";

import { api, type HealthResponse } from "./api";
import { gateways, type Gateway } from "./store";

interface JenixNetPlugin {
  wifiInfo(): Promise<{ connected: boolean; ip?: string; prefixLength?: number }>;
  bindToWifi(): Promise<{ bound: boolean }>;
  unbind(): Promise<void>;
}

const JenixNet = registerPlugin<JenixNetPlugin>("JenixNet");
const NATIVE = Capacitor.isNativePlatform();

/** The gateway's address on its own setup AP. */
export const SETUP_HOST = "192.168.4.1";

export async function phoneWifi(): Promise<{ ip: string; prefixLength: number } | null> {
  if (!NATIVE) return null;
  try {
    const info = await JenixNet.wifiInfo();
    return info.connected && info.ip ? { ip: info.ip, prefixLength: info.prefixLength ?? 24 } : null;
  } catch {
    return null;
  }
}

/** Route app traffic over Wi-Fi (needed on the setup AP, which has no internet). */
export async function bindToWifi(): Promise<boolean> {
  if (!NATIVE) return true;
  try {
    return (await JenixNet.bindToWifi()).bound;
  } catch {
    return false;
  }
}

export async function unbindWifi(): Promise<void> {
  if (!NATIVE) return;
  try {
    await JenixNet.unbind();
  } catch {
    // nothing to undo
  }
}

export interface FoundGateway {
  host: string;
  health: HealthResponse;
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function subnetOf(ip: string): string | null {
  const m = IPV4.exec(ip.trim());
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

function isGateway(h: HealthResponse | null): h is HealthResponse {
  return !!h && h.firmware === "jenix-gateway";
}

async function probe(host: string, timeoutMs: number): Promise<HealthResponse | null> {
  try {
    const h = await api.health({ host, token: "" }, timeoutMs);
    return isGateway(h) ? h : null;
  } catch {
    return null;
  }
}

/**
 * Find gateways on the phone's network. With `deviceId`, stops as soon as that
 * gateway answers. `hints` are hosts to try first and whose subnets to search.
 */
export async function discoverGateways(
  opts: { deviceId?: string; hints?: string[]; onFound?: (g: FoundGateway) => void; cancel?: { cancelled: boolean } } = {}
): Promise<FoundGateway[]> {
  const found = new Map<string, FoundGateway>();
  const want = opts.deviceId?.toUpperCase();
  let done = false;
  const take = (host: string, health: HealthResponse) => {
    const key = health.device_id ?? host;
    if (found.has(key)) return;
    const g = { host, health };
    found.set(key, g);
    opts.onFound?.(g);
    if (want && health.device_id?.toUpperCase() === want) done = true;
  };
  const stop = () => done || !!opts.cancel?.cancelled;

  // 1. Direct hints (last known IPs, mDNS names) — quick.
  const hints = [...new Set((opts.hints ?? []).map((h) => h.trim()).filter(Boolean))];
  await Promise.all(
    hints.map(async (h) => {
      const r = await probe(h, 2500);
      if (r) take(h, r);
    })
  );
  if (stop()) return [...found.values()];

  // 2. Sweep /24 subnets: the phone's own first, then those of the hints.
  const me = await phoneWifi();
  const subnets = new Set<string>();
  if (me) {
    const s = subnetOf(me.ip);
    if (s) subnets.add(s);
  }
  for (const h of hints) {
    const s = subnetOf(h);
    if (s && s !== "192.168.4") subnets.add(s);
  }
  if (!me && subnets.size === 0) {
    // Browser / no Wi-Fi info: try the most common home subnets.
    ["192.168.1", "192.168.0"].forEach((s) => subnets.add(s));
  }

  const queue: string[] = [];
  for (const s of subnets) {
    for (let i = 1; i < 255; i++) {
      const ip = `${s}.${i}`;
      if (ip !== me?.ip && !hints.includes(ip)) queue.push(ip);
    }
  }

  const CONCURRENCY = 32;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (queue.length && !stop()) {
        const ip = queue.shift()!;
        const r = await probe(ip, 1500);
        if (r) take(ip, r);
      }
    })
  );
  return [...found.values()];
}

/**
 * Make sure a saved gateway is reachable at its stored host. If it is not (or
 * a different device answers there) and we know its device_id, search the
 * network and store the new IP. Returns the up-to-date gateway, or null.
 */
export async function resolveGateway(gw: Gateway): Promise<{ gw: Gateway; health: HealthResponse } | null> {
  const h = await probe(gw.host, 4000);
  const same = h && (!gw.deviceId || !h.device_id || h.device_id.toUpperCase() === gw.deviceId.toUpperCase());
  if (h && same) {
    if (!gw.deviceId && h.device_id) {
      const next = { ...gw, deviceId: h.device_id };
      gateways.upsert(next);
      return { gw: next, health: h };
    }
    return { gw, health: h };
  }
  if (!gw.deviceId) return null;

  const hints = [gw.host];
  if (h?.hostname) hints.push(h.hostname);
  const hits = await discoverGateways({ deviceId: gw.deviceId, hints });
  const hit = hits.find((x) => x.health.device_id?.toUpperCase() === gw.deviceId!.toUpperCase());
  if (!hit) return null;
  const next = { ...gw, host: hit.host };
  gateways.upsert(next);
  return { gw: next, health: hit.health };
}
