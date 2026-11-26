import { useEffect, useState } from "react";

import { api, ApiError, type LockEntryDto, type ScanHitDto } from "../services/api";
import { locks, type Gateway, type SavedLock } from "../services/store";
import { SecretInput, TIME_ZONES } from "./SecretInput";
import { UserPicker } from "./UserBits";
import { Sheet, Spinner } from "./Sheet";
import { useToast } from "./Toast";

/**
 * Add a lock to the app for a gateway. Two paths:
 *  - Import a lock already bound on the gateway (no BLE password needed).
 *  - Scan for a nearby lock and bind it fresh (password stored in the gateway's
 *    NVS, sent once). The app itself keeps only the lock_id, a friendly name and
 *    the actuator user+PIN used for unlock/lock.
 */
export function ScanBindSheet({ gw, onClose, onBound }: { gw: Gateway; onClose: () => void; onBound: () => void }) {
  const toast = useToast();
  const [bound, setBound] = useState<LockEntryDto[] | null>(null);
  const [hits, setHits] = useState<ScanHitDto[] | null>(null);
  const [scanning, setScanning] = useState(false);

  // form state (shared by import + bind)
  const [sel, setSel] = useState<{ id: string; mode: "import" | "bind" } | null>(null);
  const [lockId, setLockId] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [user, setUser] = useState("1");
  const [pin, setPin] = useState("");
  // Bind: is this a NEW / reset lock (we choose its connection password) or
  // one that already has a connection password?
  const [fresh, setFresh] = useState(true);
  const [password2, setPassword2] = useState("");
  // Step 2 after connecting: which lock user the app opens the door as.
  const [step, setStep] = useState<"connect" | "user">("connect");
  const [boundId, setBoundId] = useState("");
  // Default India (IST); the gateway applies this offset when it sets the lock clock.
  const [tz, setTz] = useState("330");
  const [busy, setBusy] = useState(false);

  // Load locks already bound on the gateway (not yet saved in the app).
  useEffect(() => {
    api
      .locks(gw)
      .then((r) => {
        const saved = new Set(locks.forGateway(gw.id).map((l) => l.lockId));
        setBound(r.locks.filter((l) => !saved.has(l.lock_id)));
      })
      .catch(() => setBound([]));
  }, [gw]);

  async function scan() {
    setScanning(true);
    setHits(null);
    try {
      const r = await api.scan(gw);
      setHits(r.locks);
      if (r.locks.length === 0) toast("No locks found. Move the gateway closer and retry.", "info");
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Scan failed.", "err");
      setHits([]);
    } finally {
      setScanning(false);
    }
  }

  function importExisting(l: LockEntryDto) {
    setSel({ id: l.lock_id, mode: "import" });
    setLockId(l.lock_id);
    setName(l.lock_id);
    setTz(String(l.tz_minutes));
  }
  function bindScanned(h: ScanHitDto) {
    setSel({ id: h.address, mode: "bind" });
    // The login key is MD5(password + lockId) with the BARE id, not the
    // advertised name ("Lck1_8F3EE684ECE3" -> "8F3EE684ECE3").
    setLockId(bareLockId(h.name || ""));
    setName(h.name ? `Lock ${bareLockId(h.name).slice(-4)}` : "Lock");
  }
  function bindManual() {
    setSel({ id: "manual", mode: "bind" });
    setLockId("");
    setName("Lock");
  }

  async function connect() {
    const id = bareLockId(lockId);
    if (!id) {
      toast("Enter the lock ID.", "err");
      return;
    }
    if (sel?.mode === "bind") {
      if (!/^\d{6}$/.test(password)) {
        toast("Connection password must be 6 digits.", "err");
        return;
      }
      if (fresh && password !== password2) {
        toast("The two passwords don't match.", "err");
        return;
      }
    }
    const tzMinutes = parseInt(tz, 10) || 0;
    setBusy(true);
    try {
      if (sel?.mode === "bind") {
        await api.bind(gw, id, password, tzMinutes, fresh);
        // Prove the password with a real login before saving anything. The
        // first login after connecting can time out (error -1) even when the
        // password is wrong, so retry; only a successful login counts.
        let verdict: "ok" | "wrong" | "noanswer" = "noanswer";
        for (let attempt = 0; attempt < 3 && verdict === "noanswer"; attempt++) {
          try {
            await api.version(gw, id);
            verdict = "ok";
          } catch (err) {
            const msg = err instanceof ApiError ? err.message : "";
            if (/login error (19|33)(?!\d)/.test(msg)) verdict = "wrong";
            else await new Promise((r) => setTimeout(r, 1500));
          }
        }
        if (verdict !== "ok") {
          await api.unbind(gw, id).catch(() => undefined);
          toast(
            verdict === "wrong"
              ? fresh
                ? "The lock refused the new password — it may already be set up. Choose 'Already set up'."
                : "Wrong connection password — the lock rejected it (this is not the keypad PIN)."
              : "The lock didn't answer. Touch its keypad to wake it, then try again. Nothing was saved.",
            "err"
          );
          setBusy(false);
          return;
        }
      }
      setBoundId(id);
      setStep("user");
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Failed.";
      if (/already has a connection password/i.test(msg)) {
        setFresh(false);
        setPassword2("");
        toast("This lock is already set up — enter its existing connection password.", "err");
      } else toast(msg, "err");
    } finally {
      setBusy(false);
    }
  }

  function finish(skipUser = false) {
    if (!skipUser && pin && !/^\d{4,16}$/.test(pin)) {
      toast("PIN must be 4–16 digits (numbers only).", "err");
      return;
    }
    const saved: SavedLock = {
      gatewayId: gw.id,
      lockId: boundId,
      name: name.trim() || boundId,
      actuatorUser: parseInt(user, 10) || 1,
      actuatorPin: skipUser ? "" : pin,
      tzMinutes: parseInt(tz, 10) || 0
    };
    locks.upsert(saved);
    toast(sel?.mode === "import" ? "Lock added." : "Lock bound and saved.", "ok");
    onBound();
  }

  // ---- form view ---- //
  if (sel && step === "user") {
    return (
      <Sheet title="Who opens the door?" onClose={onClose}>
        <div className="meta" style={{ marginBottom: 10 }}>
          Pick the lock user the app opens the door as, then enter that user's keypad PIN.
        </div>
        <div className="card">
          <UserPicker gw={gw} lockId={boundId} value={parseInt(user, 10) || 0} onPick={(u) => setUser(String(u.id))} />
        </div>
        <div className="field">
          <label>PIN of user #{user}</label>
          <SecretInput
            inputMode="numeric"
            maxLength={16}
            placeholder="numbers only, e.g. 6 digits"
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
          />
        </div>
        <button className="btn primary" onClick={() => finish(false)} disabled={!pin}>
          Finish
        </button>
        <button className="btn ghost small" style={{ marginTop: 10 }} onClick={() => finish(true)}>
          No users yet — add them later in the Users tab
        </button>
      </Sheet>
    );
  }

  if (sel) {
    return (
      <Sheet title={sel.mode === "import" ? "Add this lock" : "Bind lock"} onClose={onClose}>
        <div className="field">
          <label>Lock ID</label>
          <input
            className="input"
            autoCapitalize="none"
            value={lockId}
            readOnly={sel.mode === "import"}
            onChange={(e) => setLockId(e.target.value)}
          />
        </div>
        <div className="field">
          <label>Lock name</label>
          <input className="input" placeholder="e.g. Main door" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        {sel.mode === "bind" && (
          <>
            <div className="seg">
              <button className={fresh ? "on" : ""} onClick={() => setFresh(true)}>
                New / reset lock
              </button>
              <button className={!fresh ? "on" : ""} onClick={() => setFresh(false)}>
                Already set up
              </button>
            </div>
            <div className="field">
              <label>{fresh ? "Choose a connection password" : "Lock connection password"}</label>
              <SecretInput
                inputMode="numeric"
                maxLength={6}
                placeholder="6 digits"
                value={password}
                onChange={(e) => setPassword(e.target.value.replace(/\D/g, ""))}
              />
            </div>
            {fresh && (
              <div className="field">
                <label>Repeat password</label>
                <SecretInput
                  inputMode="numeric"
                  maxLength={6}
                  placeholder="6 digits"
                  value={password2}
                  onChange={(e) => setPassword2(e.target.value.replace(/\D/g, ""))}
                />
              </div>
            )}
            <div className="meta" style={{ marginTop: -4, marginBottom: 12 }}>
              {fresh
                ? "For a new or factory-reset lock: this app sets the lock's connection password now. Keep it safe — it is needed to add this lock again."
                : "The 6-digit connection password set when this lock was first added (not the keypad admin PIN)."}
            </div>
          </>
        )}
        <div className="field">
          <label>Time zone (sets the lock clock)</label>
          <select className="select" value={tz} onChange={(e) => setTz(e.target.value)}>
            {!TIME_ZONES.some((z) => String(z.minutes) === tz) && <option value={tz}>Custom (UTC{fmtOffset(+tz)})</option>}
            {TIME_ZONES.map((z) => (
              <option key={z.label} value={String(z.minutes)}>
                {z.label}
              </option>
            ))}
          </select>
        </div>
        <div className="btn-row">
          <button className="btn ghost" onClick={() => setSel(null)}>
            Back
          </button>
          <button className="btn primary" onClick={connect} disabled={busy}>
            {busy ? <Spinner /> : sel.mode === "import" ? "Next" : "Connect lock"}
          </button>
        </div>
      </Sheet>
    );
  }

  // ---- picker view ---- //
  return (
    <Sheet title="Add a lock" onClose={onClose}>
      {bound === null ? (
        <div className="center">
          <Spinner />
        </div>
      ) : bound.length > 0 ? (
        <>
          <div className="meta" style={{ marginBottom: 8 }}>Already bound on this gateway</div>
          {bound.map((l) => (
            <button key={l.lock_id} className="listrow" style={{ width: "100%", textAlign: "left" }} onClick={() => importExisting(l)}>
              <div className="grow">
                <div className="title">{l.lock_id}</div>
                <div className="meta">bound · add to app</div>
              </div>
              <span className="pill ok">add ›</span>
            </button>
          ))}
          <div style={{ height: 14 }} />
        </>
      ) : null}

      <div className="row" style={{ margin: "6px 0 12px" }}>
        <div className="grow meta">Or scan for a new lock near the gateway</div>
        <button className="btn small" onClick={scan} disabled={scanning}>
          {scanning ? <Spinner /> : "Scan"}
        </button>
      </div>
      {scanning && !hits && (
        <div className="center">
          <Spinner />
          <div>Scanning…</div>
        </div>
      )}
      {hits?.map((h) => (
        <button key={h.address} className="listrow" style={{ width: "100%", textAlign: "left" }} onClick={() => bindScanned(h)}>
          <div className="grow">
            <div className="title">{h.name || "(unnamed)"}</div>
            <div className="meta">{h.address}</div>
          </div>
          <span className={`pill ${h.rssi >= -70 ? "ok" : h.rssi >= -85 ? "warn" : "bad"}`}>{h.rssi} dBm</span>
        </button>
      ))}
      <button className="btn ghost" style={{ marginTop: 12 }} onClick={bindManual}>
        Enter lock ID manually
      </button>
    </Sheet>
  );
}

/** "Lck1_8F3EE684ECE3" -> "8F3EE684ECE3"; a bare id is returned unchanged. */
function bareLockId(raw: string): string {
  const t = raw.trim();
  const m = /^Lck\d*_(.+)$/i.exec(t);
  return (m ? m[1] : t).toUpperCase();
}

function fmtOffset(min: number): string {
  const sign = min < 0 ? "-" : "+";
  const a = Math.abs(min || 0);
  return `${sign}${Math.floor(a / 60)}:${String(a % 60).padStart(2, "0")}`;
}
