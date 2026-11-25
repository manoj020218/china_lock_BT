# Jenix Lock app

Mobile/web client for Jenix/HAHA BLE locks. The phone talks to an **ESP32-S3
gateway** over Wi-Fi (the gateway speaks the lock's BLE protocol — see
`../firmware`). One gateway manages **several locks**; the app can hold several
gateways.

Stack: Capacitor 7 + React 18 + TypeScript + Vite. Glassmorphism UI with the
shared touch-feedback (water bubble + per-button haptics + synthesised sound)
ported from the Smart Token Display app.

## What it does

- **Gateways** — add an ESP32-S3 by IP + API token; the card shows live online
  status. Per-gateway settings: cloud (MQTT) config, OTA firmware update, edit,
  remove.
- **Locks** — import a lock already bound on the gateway (no BLE password
  needed), or scan + bind a new one. Each lock stores a friendly name, time-zone
  and the actuator user+PIN used for unlock/lock.
- **Control** — big Unlock / Lock actuators; firmware, battery and lock clock;
  "Sync time" (these locks have no RTC) and reboot.
- **Users** — list / add / delete users; enroll fingerprint, card or PIN (with
  live status polling).
- **Records** — access log for the last 1 / 7 / 30 days.
- **Settings** — auto-lock delay, factory-reset the lock, remove from app; app
  feedback (sound / haptics) toggles.

A weak-signal / unreachable response from the gateway is surfaced as an error —
the command did **not** reach the lock.

## How it reaches the gateway (CORS)

The gateway serves a plain-HTTP API with no CORS headers. The app handles this
without any firmware change:

- **On device** (installed APK) it uses Capacitor's **native HTTP**
  (`CapacitorHttp`), which is not subject to browser CORS.
- **In the Vite dev server** requests are routed through a small proxy
  (`/__gw/<host>/...` → `http://<host>/...`, see `vite.config.ts`) so you can
  test in a desktop browser.

## Develop

```bash
cd app
pnpm install
pnpm dev            # http://localhost:5173 — add the gateway by its LAN IP + token
```

Get the gateway's API token from its serial console (`TOKEN`) or boot log.

## Build the Android app

```bash
pnpm build
pnpm exec cap add android   # first time only
pnpm android:sync           # build web + copy into the native project
pnpm android:debug          # assembleDebug -> android/app/build/outputs/apk/debug
```

`capacitor.config.ts` enables cleartext HTTP so the WebView can reach the
gateway at `http://<lan-ip>`. The phone must be on the same Wi-Fi as the
gateway.

## Verified live

Against gateway `192.168.1.217` (lock `8F3EE684ECE3`): gateway health, import of
the bound lock, and live reads over BLE — firmware `BK50D-V2.5`, battery
`100% / 5.7 V`, lock clock, and the user list.
