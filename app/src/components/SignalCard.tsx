import { useEffect, useRef, useState } from "react";
import { FiBluetooth, FiWifi } from "react-icons/fi";

import { api } from "../services/api";
import type { Gateway, SavedLock } from "../services/store";

/** dBm -> 0..4 bars + label. Bluetooth and Wi-Fi share the same scale. */
export function quality(rssi: number): { bars: number; label: string; color: string } {
  if (!rssi || rssi >= 0) return { bars: 0, label: "No signal", color: "#f87171" };
  if (rssi >= -65) return { bars: 4, label: "Excellent", color: "#35d393" };
  if (rssi >= -75) return { bars: 3, label: "Good", color: "#35d393" };
  if (rssi >= -85) return { bars: 2, label: "Fair", color: "#ffb648" };
  return { bars: 1, label: "Weak", color: "#ff6b6b" };
}

function Bars({ n, color }: { n: number; color: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "flex-end", gap: 3, height: 18 }} aria-hidden>
      {[1, 2, 3, 4].map((i) => (
        <span
          key={i}
          style={{
            width: 5,
            height: 4 + i * 3.5,
            borderRadius: 2,
            background: i <= n ? color : "rgba(255,255,255,0.18)"
          }}
        />
      ))}
    </span>
  );
}

const POLL_MS = 5000;
// Keeping the Bluetooth link open drains the lock's batteries, so live
// measuring runs for a limited window, then pauses until asked again.
const LIVE_WINDOW_MS = 60000;

/**
 * Live link quality: gateway <-> lock (Bluetooth) and gateway <-> router
 * (Wi-Fi). Polls every 5 s while visible; pauses when the app is hidden.
 */
export function SignalCard({ gw, lock }: { gw: Gateway; lock: SavedLock }) {
  const [sig, setSig] = useState<{ ble: number; wifi: number; connected: boolean; err?: string } | null>(null);
  const timer = useRef<number>();
  const [run, setRun] = useState(1); // bump to start another live window
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    let alive = true;
    let busy = false;
    const started = Date.now();
    setPaused(false);
    const tick = async () => {
      if (Date.now() - started > LIVE_WINDOW_MS) {
        window.clearInterval(timer.current);
        if (alive) setPaused(true);
        return;
      }
      if (busy || document.hidden) return;
      busy = true;
      try {
        const r = await api.signal(gw, lock.lockId);
        if (alive) setSig({ ble: r.ble_rssi, wifi: r.wifi_rssi, connected: r.connected, err: r.error });
      } catch {
        if (alive) setSig((s) => ({ ble: 0, wifi: s?.wifi ?? 0, connected: false, err: "Gateway not reachable" }));
      } finally {
        busy = false;
      }
    };
    void tick();
    timer.current = window.setInterval(() => void tick(), POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer.current);
    };
  }, [gw, lock.lockId, run]);

  const ble = quality(sig?.connected ? sig.ble : 0);
  const wifi = quality(sig?.wifi ?? 0);

  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 8 }}>
        <div className="grow title">Connection</div>
        {paused ? (
          <button className="btn small ghost" style={{ width: "auto" }} onClick={() => setRun((n) => n + 1)}>
            Measure again
          </button>
        ) : (
          <span className="meta">{sig ? "● live" : "checking…"}</span>
        )}
      </div>
      <div className="listrow">
        <FiBluetooth style={{ marginRight: 8 }} />
        <div className="grow">
          <div className="title">Lock ↔ gateway (Bluetooth)</div>
          <div className="meta">
            {!sig
              ? "Measuring…"
              : sig.connected
                ? `${ble.label} · ${sig.ble} dBm`
                : sig.err?.includes("weak")
                  ? `Too weak to operate (${sig.ble || "?"} dBm) — move the gateway closer`
                  : "Not connected — touch the keypad to wake the lock"}
          </div>
        </div>
        <Bars n={ble.bars} color={ble.color} />
      </div>
      <div className="listrow">
        <FiWifi style={{ marginRight: 8 }} />
        <div className="grow">
          <div className="title">Gateway ↔ router (Wi-Fi)</div>
          <div className="meta">{sig ? (sig.wifi ? `${wifi.label} · ${sig.wifi} dBm` : "—") : "Measuring…"}</div>
        </div>
        <Bars n={wifi.bars} color={wifi.color} />
      </div>
    </div>
  );
}
