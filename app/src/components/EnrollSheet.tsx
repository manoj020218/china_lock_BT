import { useEffect, useRef, useState } from "react";

import { api, ApiError, type EnrollType } from "../services/api";
import type { Gateway, SavedLock } from "../services/store";
import { SecretInput } from "./SecretInput";
import { Sheet, Spinner } from "./Sheet";
import { useToast } from "./Toast";

const TYPES: { type: EnrollType; label: string; hint: string }[] = [
  { type: 1, label: "Fingerprint", hint: "When the lock beeps, place the same finger on the sensor, lift, and repeat ~3 times." },
  { type: 3, label: "Card", hint: "When the lock beeps, hold the RFID card / tag flat on the keypad." },
  { type: 2, label: "PIN", hint: "Numbers only, 4–16 digits (6 is typical). Set instantly — nothing to do at the lock." }
];

const TIMEOUT_MS = 60000;

/**
 * Enroll a credential for a user. Fingerprint and card are presented at the
 * lock while the app polls the gateway; PIN is set in one call.
 */
export function EnrollSheet({
  gw,
  lock,
  presetUser,
  presetType,
  onClose,
  onEnrolled
}: {
  gw: Gateway;
  lock: SavedLock;
  presetUser?: number;
  presetType?: EnrollType;
  onClose: () => void;
  onEnrolled?: () => void;
}) {
  const toast = useToast();
  const [type, setType] = useState<EnrollType>(presetType ?? 1);
  const [user, setUser] = useState(String(presetUser ?? 1));
  const [pin, setPin] = useState("");
  const [state, setState] = useState<"idle" | "running" | "done" | "failed">("idle");
  const [progress, setProgress] = useState("");
  const [steps, setSteps] = useState(0);
  const poll = useRef<number>();
  const started = useRef(0);

  useEffect(() => () => window.clearInterval(poll.current), []);

  async function start() {
    const uid = parseInt(user, 10) || 0;
    if (!uid) {
      toast("Enter the user ID.", "err");
      return;
    }
    if (type === 2 && !/^\d{4,16}$/.test(pin)) {
      toast("PIN must be 4–16 digits.", "err");
      return;
    }
    setState("running");
    setSteps(0);
    setProgress("Starting…");
    try {
      const r = await api.enrollStart(gw, lock.lockId, type, uid, pin);
      if (!r.poll) {
        setState("done");
        setProgress("PIN set.");
        toast("PIN saved on the lock.", "ok");
        onEnrolled?.();
        return;
      }
      started.current = Date.now();
      setProgress(type === 1 ? "Place your finger on the lock sensor…" : "Hold the card on the lock…");
      poll.current = window.setInterval(async () => {
        if (Date.now() - started.current > TIMEOUT_MS) {
          window.clearInterval(poll.current);
          await api.enrollCancel(gw, lock.lockId).catch(() => undefined);
          setState("failed");
          setProgress("Timed out — nothing was captured. Try again.");
          return;
        }
        try {
          const s = await api.enrollStatus(gw, lock.lockId);
          if (s.done) {
            window.clearInterval(poll.current);
            setState("done");
            setProgress(type === 1 ? "Fingerprint saved." : "Card saved.");
            toast("Credential enrolled.", "ok");
            onEnrolled?.();
            return;
          }
          switch (s.phase) {
            case "progress":
            case "capturing":
              setSteps((n) => n + 1);
              setProgress(type === 1 ? "Got it — lift and place the same finger again…" : "Reading card…");
              break;
            case "waiting_card":
              setProgress("Hold the card on the lock…");
              break;
            case "card_read":
              setProgress("Card read — saving…");
              break;
            default:
              break;
          }
        } catch {
          // transient; keep polling
        }
      }, 1000);
    } catch (err) {
      setState("idle");
      toast(err instanceof ApiError ? err.message : "Enroll failed (wake the lock by touching the keypad).", "err");
    }
  }

  async function cancel() {
    window.clearInterval(poll.current);
    await api.enrollCancel(gw, lock.lockId).catch(() => undefined);
    onClose();
  }

  const meta = TYPES.find((t) => t.type === type)!;

  return (
    <Sheet title={presetUser ? `Add ${meta.label.toLowerCase()} · user #${presetUser}` : "Enroll credential"} onClose={state === "running" ? cancel : onClose}>
      {(state === "idle" || state === "failed") && (
        <>
          {!presetType && (
            <div className="seg">
              {TYPES.map((t) => (
                <button key={t.type} className={type === t.type ? "on" : ""} onClick={() => setType(t.type)}>
                  {t.label}
                </button>
              ))}
            </div>
          )}
          {!presetUser && (
            <div className="field">
              <label>User ID</label>
              <input className="input" inputMode="numeric" value={user} onChange={(e) => setUser(e.target.value)} />
            </div>
          )}
          {type === 2 && (
            <div className="field">
              <label>New PIN</label>
              <SecretInput inputMode="numeric" maxLength={16} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} />
            </div>
          )}
          <div className="meta" style={{ margin: "4px 0 14px" }}>{meta.hint}</div>
          {state === "failed" && <div className="meta" style={{ color: "#f87171", marginBottom: 10 }}>{progress}</div>}
        </>
      )}

      {state === "running" && (
        <div className="center" style={{ gap: 10 }}>
          <Spinner />
          <div className="title">{progress}</div>
          {type === 1 && steps > 0 && <div className="meta">Scans so far: {steps}</div>}
        </div>
      )}
      {state === "done" && (
        <div className="center">
          <div style={{ fontSize: 40 }}>✅</div>
          <div className="title">{progress}</div>
        </div>
      )}

      {(state === "idle" || state === "failed") && (
        <button className="btn primary" onClick={start}>
          {state === "failed" ? "Try again" : type === 2 ? "Save PIN" : "Start"}
        </button>
      )}
      {state === "running" && (
        <button className="btn danger" onClick={cancel}>
          Cancel
        </button>
      )}
      {state === "done" && (
        <button className="btn primary" onClick={onClose}>
          Done
        </button>
      )}
    </Sheet>
  );
}
