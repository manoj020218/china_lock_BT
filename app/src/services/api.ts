/**
 * Typed client for the Jenix gateway REST API (ESP32-S3 firmware, Phase 5).
 *
 * The gateway speaks the lock BLE protocol itself and exposes an authenticated
 * HTTP API over the LAN. Every call here mirrors a live endpoint in
 * `firmware/src/rest_api.cpp`. One gateway manages several locks; operation
 * calls select a lock with `?lock=<lock_id>` (the firmware falls back to the
 * only bound lock when a gateway has exactly one).
 *
 * All endpoints except /api/health require `Authorization: Bearer <token>`.
 * GET operations pass the lock as a query arg; POST operations send JSON.
 */

import { Capacitor, CapacitorHttp } from "@capacitor/core";

export interface GatewayTarget {
  host: string; // ip or hostname, no scheme — e.g. "192.168.1.217" or "jenixlock.local"
  token: string;
}

// On a device we use Capacitor's native HTTP, which is not subject to browser
// CORS — so the app talks to the gateway's plain-HTTP API directly. In the
// browser dev server we route through a Vite proxy (see vite.config.ts) for the
// same reason. The gateway itself needs no CORS headers for the native app.
const NATIVE = Capacitor.isNativePlatform();
const DEV_PROXY = !NATIVE && typeof import.meta !== "undefined" && import.meta.env?.DEV;

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function cleanHost(host: string): string {
  return host.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

function endpoint(host: string, path: string): string {
  const h = cleanHost(host);
  // Dev proxy: /__gw/<host>/api/... is rewritten to http://<host>/api/... by Vite.
  if (DEV_PROXY) return `/__gw/${h}${path}`;
  return `http://${h}${path}`;
}

type Query = Record<string, string | number | undefined>;

function withQuery(url: string, query?: Query): string {
  if (!query) return url;
  const parts = Object.entries(query)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length ? `${url}?${parts.join("&")}` : url;
}

function parseBody(text: string, ok: boolean): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { ok, raw: text };
  }
}

async function nativeRequest(
  method: "GET" | "POST",
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number
): Promise<{ status: number; data: unknown }> {
  const res = await CapacitorHttp.request({
    method,
    url,
    headers,
    data: body,
    connectTimeout: timeoutMs,
    readTimeout: timeoutMs
  });
  // CapacitorHttp parses JSON responses to objects; strings pass through.
  const data = typeof res.data === "string" ? parseBody(res.data, res.status < 400) : res.data;
  return { status: res.status, data };
}

async function fetchRequest(
  method: "GET" | "POST",
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number
): Promise<{ status: number; data: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });
    const text = await res.text();
    return { status: res.status, data: parseBody(text, res.ok) };
  } finally {
    clearTimeout(timer);
  }
}

async function request<T>(
  gw: GatewayTarget,
  method: "GET" | "POST",
  path: string,
  opts: { query?: Query; body?: unknown; timeoutMs?: number; auth?: boolean } = {}
): Promise<T> {
  const url = withQuery(endpoint(gw.host, path), opts.query);
  const headers: Record<string, string> = {};
  if (opts.auth !== false && gw.token) headers["Authorization"] = `Bearer ${gw.token}`;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const timeoutMs = opts.timeoutMs ?? 15000;

  let status: number;
  let data: unknown;
  try {
    const out = NATIVE
      ? await nativeRequest(method, url, headers, opts.body, timeoutMs)
      : await fetchRequest(method, url, headers, opts.body, timeoutMs);
    status = out.status;
    data = out.data;
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new ApiError("Gateway did not respond (timeout). Check the IP and that you are on the same Wi-Fi.", 0);
    }
    throw new ApiError("Cannot reach the gateway. Check the IP address and Wi-Fi.", 0);
  }

  const ok = status < 400;
  if (!ok || (data && typeof data === "object" && (data as { ok?: boolean }).ok === false)) {
    const apiMsg = data && typeof data === "object" ? (data as { error?: string }).error : undefined;
    const msg = apiMsg ?? (status === 401 ? "Unauthorized — wrong API token." : `Request failed (${status}).`);
    throw new ApiError(msg, status);
  }
  return data as T;
}

// ---- response shapes (match rest_api.cpp) -------------------------------- //

export interface HealthResponse {
  ok: boolean;
  firmware: string;
  device_id?: string; // MAC-derived, stable per gateway (provisioning firmware+)
  fw_version?: string; // gateway firmware version (1.2.0+); compared with the app's bundled build
  build?: string; // gateway firmware build time
  hostname?: string; // jenixlock-xxxx.local
  setup?: boolean; // factory-fresh: can be provisioned without a token
  ap?: string; // setup AP SSID while it is up
  wifi: string;
  ntp: boolean;
  locks: number;
  lock_connected: boolean;
}

export interface LockEntryDto {
  lock_id: string;
  tz_minutes: number;
}

export interface ScanHitDto {
  address: string;
  name: string;
  rssi: number;
}

export interface VersionResponse {
  ok: boolean;
  firmware: string;
  command_version: number;
  admin_exists: boolean;
}

export interface BatteryResponse {
  ok: boolean;
  percent: number;
  voltage: number;
}

export interface UserValidity {
  permanent: boolean;
  start: string; // YYYY-MM-DD
  end: string;
  daily_start: string; // HH:MM
  daily_end: string;
  weekdays: number; // bit0 = Sunday … bit6 = Saturday (0x7F = every day)
}

export interface UserDto {
  id: number;
  name: string;
  group: "admin" | "general";
  fingers?: number; // enrolled fingerprints
  card?: boolean; // RFID card enrolled
  pin?: boolean; // keypad PIN set
  validity?: UserValidity;
}

export interface RecordDto {
  user: number;
  time: string; // lock local time, "YYYY-MM-DD HH:MM:SS"
  // Lock log: fingerprint/card/pin/other. Gateway log: app/cloud/serial.
  mode: "fingerprint" | "card" | "pin" | "other" | "app" | "cloud" | "serial" | "auto";
  mode_byte?: number;
  direction?: number;
  source?: "lock" | "app" | "cloud" | "serial" | "auto"; // who recorded it
  action?: "unlock" | "lock";
  ok?: boolean; // gateway commands: did the lock accept it
}

export interface WifiNetworkDto {
  ssid: string;
  rssi: number;
  secure: boolean;
}

export interface ProvisionStatus {
  ok: boolean;
  state: "idle" | "connecting" | "connected" | "failed";
  device_id: string;
  ssid: string;
  ip?: string;
  error?: string;
}

export type EnrollType = 1 | 2 | 3; // 1 finger, 2 pin, 3 card

// ---- API surface ---------------------------------------------------------- //

export const api = {
  health: (gw: GatewayTarget, timeoutMs = 6000) =>
    request<HealthResponse>(gw, "GET", "/api/health", { auth: false, timeoutMs }),

  // ---- setup (phone on the gateway's "JenixLock-XXXX" AP, host 192.168.4.1) ----
  // A factory-fresh gateway needs no token here and returns its token.
  wifiScan: (gw: GatewayTarget) =>
    request<{ ok: boolean; networks: WifiNetworkDto[] }>(gw, "GET", "/api/wifi/scan", { timeoutMs: 15000 }),

  provision: (gw: GatewayTarget, ssid: string, pass: string) =>
    request<{ ok: boolean; device_id: string; token: string; hostname: string }>(gw, "POST", "/api/provision", {
      body: { ssid, pass }
    }),

  provisionStatus: (gw: GatewayTarget) =>
    request<ProvisionStatus>(gw, "GET", "/api/provision/status", { auth: false, timeoutMs: 4000 }),

  provisionFinish: (gw: GatewayTarget) =>
    request<{ ok: boolean }>(gw, "POST", "/api/provision/finish", { body: {}, timeoutMs: 4000 }),

  locks: (gw: GatewayTarget) =>
    request<{ ok: boolean; locks: LockEntryDto[] }>(gw, "GET", "/api/locks"),

  scan: (gw: GatewayTarget) =>
    request<{ ok: boolean; locks: ScanHitDto[] }>(gw, "GET", "/api/scan", { timeoutMs: 20000 }),

  // setPassword: a NEW / factory-reset lock — the gateway sets this as its
  // connection password. Otherwise the password must already be the lock's.
  bind: (gw: GatewayTarget, lockId: string, password: string, tzMinutes?: number, setPassword = false) =>
    request<{ ok: boolean; lock_id: string }>(gw, "POST", "/api/bind", {
      body: { lock_id: lockId, password, tz_minutes: tzMinutes, set_password: setPassword },
      timeoutMs: 40000
    }),

  unbind: (gw: GatewayTarget, lockId: string) =>
    request<{ ok: boolean }>(gw, "POST", "/api/unbind", { body: { lock_id: lockId } }),

  version: (gw: GatewayTarget, lock: string) =>
    request<VersionResponse>(gw, "GET", "/api/version", { query: { lock } }),

  battery: (gw: GatewayTarget, lock: string) =>
    request<BatteryResponse>(gw, "GET", "/api/battery", { query: { lock } }),

  getTime: (gw: GatewayTarget, lock: string) =>
    request<{ ok: boolean; time: string }>(gw, "GET", "/api/time", { query: { lock } }),

  setTime: (
    gw: GatewayTarget,
    lock: string,
    t: { year: number; month: number; day: number; hour: number; minute: number; second: number; tz_minutes: number }
  ) => request<{ ok: boolean }>(gw, "POST", "/api/time", { query: { lock }, body: t }),

  unlock: (gw: GatewayTarget, lock: string, user: number, pin: string) =>
    request<{ ok: boolean; auto_close_in?: number }>(gw, "POST", "/api/unlock", { query: { lock }, body: { user, pin } }),

  lock: (gw: GatewayTarget, lock: string, user: number, pin: string) =>
    request<{ ok: boolean }>(gw, "POST", "/api/lock", { query: { lock }, body: { user, pin } }),

  reboot: (gw: GatewayTarget, lock: string) =>
    request<{ ok: boolean }>(gw, "POST", "/api/reboot", { query: { lock }, body: {} }),

  users: (gw: GatewayTarget, lock: string) =>
    request<{ ok: boolean; users: UserDto[] }>(gw, "GET", "/api/users", { query: { lock }, timeoutMs: 20000 }),

  addUser: (gw: GatewayTarget, lock: string, name: string, group: "admin" | "general", pin: string) =>
    request<{ ok: boolean; id: number }>(gw, "POST", "/api/users", { query: { lock }, body: { name, group, pin } }),

  updateUser: (
    gw: GatewayTarget,
    lock: string,
    user: number,
    change: { name?: string; validity?: "permanent" | Omit<UserValidity, "permanent"> }
  ) =>
    request<{ ok: boolean; user: UserDto }>(gw, "POST", "/api/users/update", {
      query: { lock },
      body: { user, ...change },
      timeoutMs: 30000
    }),

  deleteUser: (gw: GatewayTarget, lock: string, user: number) =>
    request<{ ok: boolean }>(gw, "POST", "/api/users/delete", { query: { lock }, body: { user } }),

  enrollStart: (gw: GatewayTarget, lock: string, type: EnrollType, user: number, pin?: string) =>
    request<{ ok: boolean; poll: boolean }>(gw, "POST", "/api/enroll", {
      query: { lock },
      body: { type, user, pin: pin ?? "" }
    }),

  enrollStatus: (gw: GatewayTarget, lock: string) =>
    request<{
      ok: boolean;
      status: number;
      payload_len: number;
      done: boolean;
      phase?: "waiting" | "capturing" | "progress" | "waiting_card" | "card_read" | "done";
    }>(gw, "GET", "/api/enroll/status", {
      query: { lock }
    }),

  enrollCancel: (gw: GatewayTarget, lock: string) =>
    request<{ ok: boolean }>(gw, "POST", "/api/enroll/cancel", { query: { lock }, body: {} }),

  records: (gw: GatewayTarget, lock: string, days = 7) =>
    request<{ ok: boolean; count: number; records: RecordDto[]; lock_unreachable?: boolean; lock_error?: string }>(gw, "GET", "/api/records", {
      query: { lock, days },
      timeoutMs: 25000
    }),

  setAutoLock: (gw: GatewayTarget, lock: string, seconds: number) =>
    request<{ ok: boolean }>(gw, "POST", "/api/settings/autolock", { query: { lock }, body: { seconds } }),

  setNormallyOpen: (
    gw: GatewayTarget,
    lock: string,
    cfg: { start_minute: number; end_minute: number; weekday_mask: number } | { enabled: false }
  ) => request<{ ok: boolean }>(gw, "POST", "/api/settings/normally-open", { query: { lock }, body: cfg }),

  // Gateway auto close: re-lock N s after an app/cloud unlock (0 = off). 1.2.5+.
  setAppAutoClose: (gw: GatewayTarget, lock: string, seconds: number) =>
    request<{ ok: boolean; app_auto_close_s: number }>(gw, "POST", "/api/settings/app-autoclose", {
      query: { lock },
      body: { seconds }
    }),

  // Auto-lock delay + normally-open schedule as stored on the lock (gateway 1.2.3+).
  settings: (gw: GatewayTarget, lock: string) =>
    request<{
      ok: boolean;
      auto_lock_s: number;
      app_auto_close_s?: number; // gateway re-locks after app unlocks (0 = off)
      normally_open: { enabled: boolean; start_minute: number; end_minute: number; weekday_mask: number };
    }>(gw, "GET", "/api/settings", { query: { lock }, timeoutMs: 20000 }),

  factoryReset: (gw: GatewayTarget, lock: string) =>
    request<{ ok: boolean }>(gw, "POST", "/api/settings/factory-reset", { query: { lock }, body: { confirm: "RESET" } }),

  cloudGet: (gw: GatewayTarget) => request<Record<string, unknown>>(gw, "GET", "/api/cloud"),

  cloudSet: (gw: GatewayTarget, cfg: Record<string, unknown>) =>
    request<{ ok: boolean }>(gw, "POST", "/api/cloud", { body: cfg }),

  // Live Bluetooth signal of the gateway<->lock link + gateway Wi-Fi signal.
  signal: (gw: GatewayTarget, lock: string) =>
    request<{ ok: boolean; connected: boolean; ble_rssi: number; wifi_rssi: number; min_rssi: number; error?: string }>(
      gw,
      "GET",
      "/api/signal",
      { query: { lock }, timeoutMs: 20000 }
    ),

  // Battery levels the gateway measured (it checks every lock a few times a day).
  alerts: (gw: GatewayTarget) =>
    request<{
      ok: boolean;
      threshold: number;
      locks: { lock_id: string; battery: number; voltage: number; checked_at: number; low: boolean }[];
    }>(gw, "GET", "/api/alerts", { timeoutMs: 8000 }),

  // Ask the gateway to measure every lock's battery now (takes ~10 s per lock).
  alertsCheck: (gw: GatewayTarget) =>
    request<{ ok: boolean }>(gw, "POST", "/api/alerts/check", { body: {}, timeoutMs: 60000 }),

  radioGet: (gw: GatewayTarget) =>
    request<{ ok: boolean; wifi_dbm: number; ble_dbm: number; wifi_rssi: number; stepped_down: boolean }>(gw, "GET", "/api/radio"),

  radioSet: (gw: GatewayTarget, cfg: { wifi_dbm?: number; ble_dbm?: number }) =>
    request<{ ok: boolean; wifi_dbm: number; ble_dbm: number; wifi_rssi: number; stepped_down: boolean }>(gw, "POST", "/api/radio", {
      body: cfg
    }),

  ota: (gw: GatewayTarget, url: string) =>
    request<{ ok: boolean }>(gw, "POST", "/api/ota", { body: { url }, timeoutMs: 60000 })
};
