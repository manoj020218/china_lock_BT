/**
 * Low-battery alerts.
 *
 * The gateway measures every bound lock's battery a few times a day and
 * reports them at GET /api/alerts (low = below 25 %). The app:
 *   - in the foreground: shows a red badge on the lock, plays an alarm sound
 *     with vibration (once per lock per app session);
 *   - in the background / closed: Android WorkManager runs BatteryWorker every
 *     ~15 min, which reads the same endpoint and posts a system notification
 *     with sound + vibration (once per lock per 24 h).
 * Both work while the phone is on the same Wi-Fi as the gateway.
 */

import { Capacitor, registerPlugin } from "@capacitor/core";

import { feedback } from "../feedback";
import { api, type GatewayTarget } from "./api";
import { gateways, locks } from "./store";

export const LOW_BATTERY = 25;

export interface LockBattery {
  lock_id: string;
  battery: number; // percent, -1 if never measured
  voltage: number;
  checked_at: number; // epoch seconds, 0 if unknown
  low: boolean;
}

interface AlertPlugin {
  setAlertConfig(cfg: { gateways: { host: string; token: string }[]; lockNames: Record<string, string> }): Promise<void>;
  requestNotifications(): Promise<{ granted: boolean }>;
  testNotification(opts: { name: string; battery: number }): Promise<void>;
}
const Native = registerPlugin<AlertPlugin>("JenixNet");
const NATIVE = Capacitor.isNativePlatform();

/** Hand the saved gateways + lock names to the background checker. */
export async function syncAlertConfig(): Promise<void> {
  if (!NATIVE) return;
  const lockNames: Record<string, string> = {};
  for (const l of locks.all()) lockNames[l.lockId] = l.name;
  try {
    await Native.setAlertConfig({
      gateways: gateways.all().map((g) => ({ host: g.host, token: g.token })),
      lockNames
    });
  } catch {
    /* older native build */
  }
}

export async function askNotificationPermission(): Promise<boolean> {
  if (!NATIVE) return false;
  try {
    return (await Native.requestNotifications()).granted;
  } catch {
    return false;
  }
}

export async function testNotification(name: string): Promise<void> {
  if (NATIVE) await Native.testNotification({ name, battery: 20 });
}

/** Latest battery levels the gateway has measured. */
export async function fetchAlerts(gw: GatewayTarget): Promise<LockBattery[]> {
  const r = await api.alerts(gw);
  return r.locks;
}

const alarmed = new Set<string>();

/** Foreground alarm: sound + vibration, once per lock per app session. */
export function alarmOnce(lockId: string): boolean {
  if (alarmed.has(lockId)) return false;
  alarmed.add(lockId);
  feedback("error");
  setTimeout(() => feedback("warn"), 450);
  setTimeout(() => feedback("error"), 900);
  return true;
}
