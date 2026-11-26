import { useState } from "react";

import { api, ApiError } from "../services/api";
import type { Gateway, SavedLock } from "../services/store";
import { Spinner } from "./Sheet";
import { useToast } from "./Toast";

export interface NormallyOpen {
  enabled: boolean;
  start_minute: number;
  end_minute: number;
  weekday_mask: number;
}

const DAYS = ["S", "M", "T", "W", "T", "F", "S"]; // bit0 = Sunday
const toHm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const fromHm = (s: string) => {
  const [h, m] = s.split(":").map((x) => parseInt(x, 10) || 0);
  return Math.min(1439, h * 60 + m);
};

export function describeNormallyOpen(n: NormallyOpen | null): string {
  if (!n || !n.enabled) return "Off";
  const days =
    (n.weekday_mask & 0x7f) === 0x7f
      ? "every day"
      : ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].filter((_, i) => n.weekday_mask & (1 << i)).join(", ");
  const allDay = n.start_minute === 0 && n.end_minute >= 1439;
  return `${allDay ? "All day" : `${toHm(n.start_minute)}–${toHm(n.end_minute)}`} · ${days}`;
}

/**
 * Normally-open schedule: the lock stays UNLOCKED during this window (e.g. an
 * office during working hours). Auto close does not act inside the window.
 */
export function NormallyOpenCard({
  gw,
  lock,
  value,
  onChange
}: {
  gw: Gateway;
  lock: SavedLock;
  value: NormallyOpen | null;
  onChange: (n: NormallyOpen) => void;
}) {
  const toast = useToast();
  const [on, setOn] = useState(value?.enabled ?? false);
  const [start, setStart] = useState(toHm(value?.enabled ? value.start_minute : 9 * 60));
  const [end, setEnd] = useState(toHm(value?.enabled ? value.end_minute : 18 * 60));
  const [days, setDays] = useState(value?.enabled ? value.weekday_mask & 0x7f : 0x3e); // Mon–Fri
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      if (!on) {
        await api.setNormallyOpen(gw, lock.lockId, { enabled: false });
        onChange({ enabled: false, start_minute: 0, end_minute: 0, weekday_mask: 0 });
        toast("Normally open turned off — the lock closes normally.", "ok");
      } else {
        if (days === 0) {
          toast("Pick at least one day.", "err");
          setBusy(false);
          return;
        }
        const s = fromHm(start);
        const e = fromHm(end);
        if (
          !window.confirm(
            `The lock will stay UNLOCKED ${start}–${end} on the selected days — anyone can open the door then. Continue?`
          )
        ) {
          setBusy(false);
          return;
        }
        await api.setNormallyOpen(gw, lock.lockId, { start_minute: s, end_minute: e, weekday_mask: days });
        onChange({ enabled: true, start_minute: s, end_minute: e, weekday_mask: days });
        toast("Normally-open schedule saved.", "ok");
      }
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Save failed.", "err");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 4 }}>
        <div className="grow title">Normally open</div>
        <span className={`pill ${value?.enabled ? "warn" : ""}`}>{value ? describeNormallyOpen(value) : "…"}</span>
      </div>
      <div className="meta" style={{ marginBottom: 10 }}>
        Keep the door unlocked during set hours (e.g. office hours). Auto close does not work inside this time.
      </div>
      <div className="seg">
        <button className={!on ? "on" : ""} onClick={() => setOn(false)}>
          Off
        </button>
        <button className={on ? "on" : ""} onClick={() => setOn(true)}>
          On
        </button>
      </div>
      {on && (
        <>
          <div className="row" style={{ gap: 10, marginTop: 10 }}>
            <div className="field grow">
              <label>From</label>
              <input className="input" type="time" value={start} onChange={(e) => setStart(e.target.value)} />
            </div>
            <div className="field grow">
              <label>To</label>
              <input className="input" type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
            </div>
          </div>
          <button
            className="btn ghost small"
            style={{ marginBottom: 8 }}
            onClick={() => {
              setStart("00:00");
              setEnd("23:59");
            }}
          >
            Whole day
          </button>
          <label className="meta">Days</label>
          <div className="seg" style={{ marginTop: 6 }}>
            {DAYS.map((d, i) => (
              <button key={i} className={days & (1 << i) ? "on" : ""} onClick={() => setDays(days ^ (1 << i))}>
                {d}
              </button>
            ))}
          </div>
          <div className="meta" style={{ color: "#ffb648", marginTop: 6 }}>
            ⚠️ During this time the door is not locked. Press and hold 0 on the keypad to lock it manually.
          </div>
        </>
      )}
      <button className="btn primary" style={{ marginTop: 12 }} onClick={save} disabled={busy}>
        {busy ? <Spinner /> : "Save normally open"}
      </button>
    </div>
  );
}
