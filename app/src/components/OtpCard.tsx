import { useEffect, useState } from "react";
import { FiCopy, FiMessageSquare, FiShare2 } from "react-icons/fi";
import { FaWhatsapp } from "react-icons/fa";

import { kg5Code, kg5Slot, lockLocalNow } from "../services/kg5";
import { shareText, smsUrl, whatsappUrl } from "../services/share";
import { locks, type Gateway, type SavedLock } from "../services/store";
import { SecretInput } from "./SecretInput";
import { useToast } from "./Toast";

const hm = (d: Date) => d.toISOString().slice(11, 16);

/**
 * One-time 5-minute door code, generated on the phone (same algorithm as the
 * vendor app). The lock checks it against its own clock, so it works offline —
 * a guest just types it on the keypad. Needs the lock's admin PIN.
 */
export function OtpCard({
  gw,
  lock,
  onLockChange
}: {
  gw: Gateway;
  lock: SavedLock;
  onLockChange: (l: SavedLock) => void;
}) {
  const toast = useToast();
  const [admin, setAdmin] = useState(lock.otpAdmin ?? "");
  // The lock checks codes against ITS local time (live-confirmed 2026-11-26:
  // the IST-based code opened the lock). Compute that time from the phone's
  // absolute clock + the LOCK's time zone, so a phone set to another time
  // zone (the test phone was on UTC+6) still produces the right code. The
  // gateway keeps the lock clock on NTP time, so no network read is needed.
  void gw;
  const lockNow = () => lockLocalNow(lock.tzMinutes);
  const [now, setNow] = useState(lockNow);
  const [code, setCode] = useState("");

  useEffect(() => {
    const t = window.setInterval(() => setNow(lockNow()), 1000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const slot = kg5Slot(now);
  const secsLeft = Math.max(0, Math.round((slot.end.getTime() - now.getTime()) / 1000));
  // Recompute when the 5-minute slot rolls over.
  useEffect(() => {
    if (code && lock.otpAdmin) setCode(kg5Code(lock.otpAdmin, now));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slot.start.getTime()]);

  function generate() {
    if (!/^\d{4,16}$/.test(admin)) {
      toast("Enter the lock's admin PIN (digits).", "err");
      return;
    }
    if (admin !== lock.otpAdmin) {
      const next = { ...lock, otpAdmin: admin };
      locks.upsert(next);
      onLockChange(next);
    }
    setCode(kg5Code(admin, now));
  }

  const message = [
    `🔐 Door code for ${lock.name}: ${code}`,
    `Valid today ${hm(slot.start)}–${hm(slot.end)} only.`,
    ``,
    `How to open:`,
    `1. Touch the keypad to wake it up`,
    `2. Press *`,
    `3. Enter the code ${code}`,
    `4. Press # — the lock opens`
  ].join("\n");

  async function share() {
    try {
      const r = await shareText("Door code", message);
      if (r === "copied") toast("Copied — paste it in WhatsApp or SMS.", "ok");
    } catch {
      /* user closed the sheet */
    }
  }

  return (
    <div className="card">
      <div className="title" style={{ marginBottom: 4 }}>
        Temporary door code (OTP)
      </div>
      <div className="meta" style={{ marginBottom: 10 }}>
        A 6-digit code a guest types on the keypad. Works offline, valid for the current 5-minute window only.
      </div>

      {!code ? (
        <>
          <div className="field">
            <label>Keypad admin PIN (not the connection password)</label>
            <SecretInput
              inputMode="numeric"
              maxLength={16}
              placeholder="PIN the admin types on the keypad"
              value={admin}
              onChange={(e) => setAdmin(e.target.value.replace(/\D/g, ""))}
            />
            <div className="meta" style={{ marginTop: 6 }}>
              The PIN of this lock's <b>admin</b> user. Saved on this phone only, to generate codes. A wrong admin PIN
              gives codes the lock rejects.
            </div>
          </div>
          <button className="btn primary" onClick={generate}>
            Generate code
          </button>
        </>
      ) : (
        <>
          <div style={{ textAlign: "center", margin: "6px 0 4px" }}>
            <div style={{ fontSize: 40, fontWeight: 800, letterSpacing: 8 }}>{code}</div>
            <div className="meta">
              Valid {hm(slot.start)}–{hm(slot.end)} · {Math.floor(secsLeft / 60)}:{String(secsLeft % 60).padStart(2, "0")} left
            </div>

          </div>
          <div className="meta" style={{ textAlign: "center", marginTop: 6 }}>
            On the keypad: press <b>*</b>, enter the code, then press <b>#</b> to open.
          </div>
          <div className="btn-row" style={{ marginTop: 10 }}>
            <a className="btn small" href={whatsappUrl(message)} target="_blank" rel="noreferrer">
              <FaWhatsapp /> WhatsApp
            </a>
            <a className="btn small" href={smsUrl(message)}>
              <FiMessageSquare /> SMS
            </a>
          </div>
          <div className="btn-row" style={{ marginTop: 8 }}>
            <button className="btn small" onClick={share}>
              <FiShare2 /> More…
            </button>
            <button
              className="btn small"
              onClick={() => {
                void navigator.clipboard?.writeText(code);
                toast("Code copied.", "ok");
              }}
            >
              <FiCopy /> Copy
            </button>
          </div>
          <button className="btn ghost small" style={{ marginTop: 8 }} onClick={() => setCode("")}>
            Change admin PIN
          </button>
          {secsLeft < 60 && (
            <div className="meta" style={{ marginTop: 6, color: "#fbbf24" }}>
              Less than a minute left — a new code appears automatically when this window ends.
            </div>
          )}
        </>
      )}
    </div>
  );
}
