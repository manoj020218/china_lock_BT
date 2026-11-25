import { useEffect, useState } from "react";

import { api, ApiError, type LockEntryDto, type ScanHitDto } from "../services/api";
import { locks, type Gateway, type SavedLock } from "../services/store";
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
  const [tz, setTz] = useState(String(-new Date().getTimezoneOffset()));
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
    setLockId(h.name || "");
    setName(h.name || "Lock");
  }
  function bindManual() {
    setSel({ id: "manual", mode: "bind" });
    setLockId("");
    setName("Lock");
  }

  async function save() {
    const id = lockId.trim();
    if (!id) {
      toast("Enter the lock ID.", "err");
      return;
    }
    const tzMinutes = parseInt(tz, 10) || 0;
    setBusy(true);
    try {
      if (sel?.mode === "bind") {
        if (!password.trim()) {
          toast("Enter the lock BLE password.", "err");
          setBusy(false);
          return;
        }
        await api.bind(gw, id, password.trim(), tzMinutes);
      }
      const saved: SavedLock = {
        gatewayId: gw.id,
        lockId: id,
        name: name.trim() || id,
        actuatorUser: parseInt(user, 10) || 1,
        actuatorPin: pin.trim(),
        tzMinutes
      };
      locks.upsert(saved);
      toast(sel?.mode === "import" ? "Lock added." : "Lock bound and saved.", "ok");
      onBound();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Failed.", "err");
    } finally {
      setBusy(false);
    }
  }

  // ---- form view ---- //
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
          <label>Display name</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        {sel.mode === "bind" && (
          <div className="field">
            <label>Lock BLE password (sent to gateway only)</label>
            <input
              className="input"
              autoCapitalize="none"
              autoCorrect="off"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
        )}
        <div className="row" style={{ gap: 10 }}>
          <div className="field grow">
            <label>Actuator user id</label>
            <input className="input" inputMode="numeric" value={user} onChange={(e) => setUser(e.target.value)} />
          </div>
          <div className="field grow">
            <label>That user's PIN</label>
            <input className="input" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value)} />
          </div>
        </div>
        <div className="field">
          <label>Time zone offset (minutes east of UTC)</label>
          <input className="input" inputMode="numeric" value={tz} onChange={(e) => setTz(e.target.value)} />
        </div>
        <div className="btn-row">
          <button className="btn ghost" onClick={() => setSel(null)}>
            Back
          </button>
          <button className="btn primary" onClick={save} disabled={busy}>
            {busy ? <Spinner /> : sel.mode === "import" ? "Add lock" : "Bind lock"}
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
