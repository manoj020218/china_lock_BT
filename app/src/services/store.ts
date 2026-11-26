/**
 * Local persistence for gateways and the locks saved under each one.
 *
 * A Gateway is one ESP32-S3 (host + API token). Each gateway can manage
 * several locks; a SavedLock pairs a gateway with a bound lock_id and the
 * actuator credentials (user id + PIN) the app sends with unlock/lock. Lock
 * BLE passwords are NOT stored here — they live only in the gateway's NVS,
 * sent once at bind time. This store keeps only what the phone needs to drive
 * the gateway. Persisted to localStorage; no secrets are sent anywhere but the
 * gateway itself.
 */

export interface Gateway {
  id: string;
  name: string;
  host: string; // last known LAN IP; refreshed automatically by discovery
  token: string;
  deviceId?: string; // from /api/health; lets the app find the gateway if its IP changes
}

export interface SavedLock {
  gatewayId: string;
  lockId: string;
  name: string;
  actuatorUser: number; // user id used for unlock/lock (usually the admin, 1)
  actuatorPin: string; // that user's PIN
  tzMinutes: number;
  otpAdmin?: string; // keypad admin PIN used to generate temporary codes (stays on this phone)
}

const GW_KEY = "jenixlock:gateways";
const LOCK_KEY = "jenixlock:locks";

function read<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function write<T>(key: string, value: T): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable (private mode): choices apply for the session only.
  }
}

export function uid(): string {
  return "g_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

// ---- gateways ------------------------------------------------------------- //

export const gateways = {
  all: (): Gateway[] => read<Gateway[]>(GW_KEY, []),
  get: (id: string): Gateway | undefined => gateways.all().find((g) => g.id === id),
  upsert: (gw: Gateway): void => {
    const list = gateways.all();
    const i = list.findIndex((g) => g.id === gw.id);
    if (i >= 0) list[i] = gw;
    else list.push(gw);
    write(GW_KEY, list);
  },
  remove: (id: string): void => {
    write(
      GW_KEY,
      gateways.all().filter((g) => g.id !== id)
    );
    write(
      LOCK_KEY,
      locks.all().filter((l) => l.gatewayId !== id)
    );
  }
};

// ---- locks ---------------------------------------------------------------- //

export const locks = {
  all: (): SavedLock[] => read<SavedLock[]>(LOCK_KEY, []),
  forGateway: (gatewayId: string): SavedLock[] => locks.all().filter((l) => l.gatewayId === gatewayId),
  get: (gatewayId: string, lockId: string): SavedLock | undefined =>
    locks.all().find((l) => l.gatewayId === gatewayId && l.lockId === lockId),
  upsert: (lock: SavedLock): void => {
    const list = locks.all();
    const i = list.findIndex((l) => l.gatewayId === lock.gatewayId && l.lockId === lock.lockId);
    if (i >= 0) list[i] = lock;
    else list.push(lock);
    write(LOCK_KEY, list);
  },
  remove: (gatewayId: string, lockId: string): void => {
    write(
      LOCK_KEY,
      locks.all().filter((l) => !(l.gatewayId === gatewayId && l.lockId === lockId))
    );
  }
};
