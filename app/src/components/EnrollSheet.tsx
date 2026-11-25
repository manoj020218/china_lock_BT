import { useEffect, useRef, useState } from "react";

import { api, ApiError, type EnrollType } from "../services/api";
import type { Gateway, SavedLock } from "../services/store";
import { Sheet, Spinner } from "./Sheet";
import { useToast } from "./Toast";

const TYPES: { type: EnrollType; label: string; hint: string }[] = [
  { type: 1, label: "Fingerprint", hint: "Swipe the same finger a few times when the lock prompts." },
  { type: 3, label: "Card", hint: "Hold the card to the lock reader." },
  { type: 2, label: "PIN", hint: "Set a numeric PIN for this user." }
];

/**
 * Enroll a credential for an existing user. Fingerprint and card need status
 * polling (the lock reports progress); PIN is set in one call.
 */
export function EnrollSheet({ gw, lock, onClose }: { gw: Gateway; lock: SavedLock; onClose: () => void }) {
  const toast = useToast();
  const [type, setType] = useState<EnrollType>(1);
  const [user, setUser] = useState("1");
  const [pin, setPin] = useState("");
  const [state, setState] = useState<"idle" | "running" | "done">("idle");
  const [progress, setProgress] = useState("");
  const poll = useRef<number>();

  useEffect(() => () => window.clearInterval(poll.current), []);

  async function start() {
    const uid = parseInt(user, 10) || 0;
    if (type === 2 && !pin.trim()) {
      toast("Enter a PIN.", "err");
      return;
    }
    setState("running");
    setProgress("Starting…");
    try {
      const r = await api.enrollStart(gw, lock.lockId, type, uid, pin.trim());
      if (!r.poll) {
        setState("done");
        setProgress("PIN set.");
        toast("PIN enrolled.", "ok");
        return;
      }
      setProgress(type === 1 ? "Swipe finger on the lock…" : "Present the card…");
      poll.current = window.setInterval(async () => {
        try {
          const s = await api.enrollStatus(gw, lock.lockId);
          if (s.done) {
            window.clearInterval(poll.current);
            setState("done");
            setProgress("Enrolled successfully.");
            toast("Credential enrolled.", "ok");
          } else {
            setProgress(`Capturing… (status ${s.status})`);
          }
        } catch {
          // transient; keep polling
        }
      }, 1500);
    } catch (err) {
      setState("idle");
      toast(err instanceof ApiError ? err.message : "Enroll failed.", "err");
    }
  }

  async function cancel() {
    window.clearInterval(poll.current);
    try {
      await api.enrollCancel(gw, lock.lockId);
    } catch {
      /* ignore */
    }
    onClose();
  }

  return (
    <Sheet title="Enroll credential" onClose={state === "running" ? cancel : onClose}>
      {state !== "done" && (
        <>
          <div className="seg">
            {TYPES.map((t) => (
              <button key={t.type} className={type === t.type ? "on" : ""} disabled={state === "running"} onClick={() => setType(t.type)}>
                {t.label}
              </button>
            ))}
          </div>
          <div className="field">
            <label>User id</label>
            <input className="input" inputMode="numeric" value={user} disabled={state === "running"} onChange={(e) => setUser(e.target.value)} />
          </div>
          {type === 2 && (
            <div className="field">
              <label>PIN</label>
              <input className="input" inputMode="numeric" value={pin} disabled={state === "running"} onChange={(e) => setPin(e.target.value)} />
            </div>
          )}
          <div className="meta" style={{ margin: "4px 0 14px" }}>{TYPES.find((t) => t.type === type)?.hint}</div>
        </>
      )}

      {state === "running" && (
        <div className="center">
          <Spinner />
          <div>{progress}</div>
        </div>
      )}
      {state === "done" && (
        <div className="center">
          <div style={{ fontSize: 40 }}>✅</div>
          <div>{progress}</div>
        </div>
      )}

      {state === "idle" && (
        <button className="btn primary" onClick={start}>
          Start enrollment
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
