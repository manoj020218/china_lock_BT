import { useCallback, useEffect, useState } from "react";
import { FiArrowLeft, FiClock, FiLock, FiRefreshCw, FiTrash2, FiUnlock, FiUserPlus } from "react-icons/fi";

import { AddUserSheet } from "../components/AddUserSheet";
import { EnrollSheet } from "../components/EnrollSheet";
import { Center, Spinner } from "../components/Sheet";
import { useToast } from "../components/Toast";
import { feedback } from "../feedback";
import { api, ApiError, type RecordDto, type UserDto } from "../services/api";
import { gateways, locks, type SavedLock } from "../services/store";

type Tab = "control" | "users" | "records" | "settings";

export function LockScreen({ lock: initial, onBack }: { lock: SavedLock; onBack: () => void }) {
  const toast = useToast();
  const gw = gateways.get(initial.gatewayId)!;
  const [lock, setLock] = useState(initial);
  const [tab, setTab] = useState<Tab>("control");
  const [acting, setActing] = useState<"" | "unlock" | "lock">("");

  async function actuate(kind: "unlock" | "lock") {
    if (acting) return;
    setActing(kind);
    feedback(kind); // immediate sound+haptic on the big button
    try {
      if (kind === "unlock") await api.unlock(gw, lock.lockId, lock.actuatorUser, lock.actuatorPin);
      else await api.lock(gw, lock.lockId, lock.actuatorUser, lock.actuatorPin);
      toast(kind === "unlock" ? "Unlocked ✓" : "Locked ✓", "ok");
    } catch (err) {
      // A weak-signal / unreachable error means the command did NOT reach the lock.
      toast(err instanceof ApiError ? err.message : `${kind} failed.`, "err");
    } finally {
      setActing("");
    }
  }

  return (
    <div className="screen">
      <div className="appbar">
        <button className="iconbtn" aria-label="Back" data-fb="close" onClick={onBack}>
          <FiArrowLeft />
        </button>
        <div className="grow">
          <h1 style={{ fontSize: 20 }}>{lock.name}</h1>
          <div className="sub">
            {gw.name} · {lock.lockId}
          </div>
        </div>
      </div>

      <div className="actuators">
        <button className="actuator unlock" data-fb="unlock" disabled={!!acting} onClick={() => actuate("unlock")}>
          <span className="ico">{acting === "unlock" ? <Spinner /> : <FiUnlock />}</span>
          Unlock
        </button>
        <button className="actuator lock" data-fb="lock" disabled={!!acting} onClick={() => actuate("lock")}>
          <span className="ico">{acting === "lock" ? <Spinner /> : <FiLock />}</span>
          Lock
        </button>
      </div>

      <div className="seg">
        {(["control", "users", "records", "settings"] as Tab[]).map((t) => (
          <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
            {t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {tab === "control" && <ControlTab gw={gw} lock={lock} />}
      {tab === "users" && <UsersTab gw={gw} lock={lock} />}
      {tab === "records" && <RecordsTab gw={gw} lock={lock} />}
      {tab === "settings" && <SettingsTab gw={gw} lock={lock} onLockChange={setLock} onRemoved={onBack} />}
    </div>
  );
}

// ---- Control tab ---------------------------------------------------------- //
function ControlTab({ gw, lock }: { gw: ReturnType<typeof gateways.get> & object; lock: SavedLock }) {
  const toast = useToast();
  const [info, setInfo] = useState<{ fw?: string; battery?: string; time?: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [v, b, t] = await Promise.allSettled([
        api.version(gw, lock.lockId),
        api.battery(gw, lock.lockId),
        api.getTime(gw, lock.lockId)
      ]);
      setInfo({
        fw: v.status === "fulfilled" ? v.value.firmware : "—",
        battery: b.status === "fulfilled" ? `${b.value.percent}% · ${b.value.voltage.toFixed(1)} V` : "—",
        time: t.status === "fulfilled" ? t.value.time : "—"
      });
    } catch {
      toast("Could not read the lock.", "err");
    } finally {
      setLoading(false);
    }
  }, [gw, lock.lockId, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  async function syncTime() {
    setSyncing(true);
    try {
      const now = new Date();
      const local = new Date(now.getTime() + lock.tzMinutes * 60000);
      await api.setTime(gw, lock.lockId, {
        year: local.getUTCFullYear(),
        month: local.getUTCMonth() + 1,
        day: local.getUTCDate(),
        hour: local.getUTCHours(),
        minute: local.getUTCMinutes(),
        second: local.getUTCSeconds(),
        tz_minutes: lock.tzMinutes
      });
      toast("Lock clock set from phone.", "ok");
      void load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Set time failed.", "err");
    } finally {
      setSyncing(false);
    }
  }

  async function reboot() {
    try {
      await api.reboot(gw, lock.lockId);
      toast("Reboot command sent.", "ok");
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Reboot failed.", "err");
    }
  }

  if (loading && !info) return <Center><Spinner /> Reading lock…</Center>;

  return (
    <>
      <div className="card">
        <div className="listrow">
          <div className="grow title">Firmware</div>
          <div className="meta">{info?.fw}</div>
        </div>
        <div className="listrow">
          <div className="grow title">Battery</div>
          <div className="meta">{info?.battery}</div>
        </div>
        <div className="listrow">
          <div className="grow title">Lock clock</div>
          <div className="meta">{info?.time}</div>
        </div>
      </div>
      <div className="btn-row">
        <button className="btn" onClick={load}>
          <FiRefreshCw /> Refresh
        </button>
        <button className="btn" onClick={syncTime} disabled={syncing}>
          {syncing ? <Spinner /> : <FiClock />} Sync time
        </button>
      </div>
      <button className="btn ghost" style={{ marginTop: 10 }} onClick={reboot}>
        Reboot lock
      </button>
      <div className="meta" style={{ marginTop: 10, lineHeight: 1.5 }}>
        These locks have no clock. The gateway re-sets the time automatically after a battery change — use Sync time if the
        clock ever looks wrong.
      </div>
    </>
  );
}

// ---- Users tab ------------------------------------------------------------ //
function UsersTab({ gw, lock }: { gw: ReturnType<typeof gateways.get> & object; lock: SavedLock }) {
  const toast = useToast();
  const [users, setUsers] = useState<UserDto[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [enrolling, setEnrolling] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.users(gw, lock.lockId);
      setUsers(r.users);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Could not load users.", "err");
      setUsers([]);
    } finally {
      setLoading(false);
    }
  }, [gw, lock.lockId, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  async function del(u: UserDto) {
    try {
      await api.deleteUser(gw, lock.lockId, u.id);
      toast(`Deleted #${u.id}.`, "ok");
      void load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Delete failed.", "err");
    }
  }

  return (
    <>
      <div className="btn-row" style={{ marginBottom: 12 }}>
        <button className="btn" onClick={() => setAdding(true)}>
          <FiUserPlus /> Add user
        </button>
        <button className="btn" onClick={() => setEnrolling(true)}>
          Enroll
        </button>
      </div>
      {loading ? (
        <Center><Spinner /></Center>
      ) : users && users.length > 0 ? (
        <div className="card">
          {users.map((u) => (
            <div key={u.id} className="listrow">
              <div className="grow">
                <div className="title">
                  {u.name} <span className="meta">#{u.id}</span>
                </div>
                <div className="meta">{u.group}</div>
              </div>
              {u.group === "admin" && <span className="pill warn">admin</span>}
              <button className="iconbtn danger" aria-label="Delete user" data-fb="warn" onClick={() => del(u)}>
                <FiTrash2 />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="empty">
          <div className="big">👤</div>No users on this lock.
        </div>
      )}
      {adding && <AddUserSheet gw={gw} lock={lock} onClose={() => setAdding(false)} onAdded={() => { setAdding(false); void load(); }} />}
      {enrolling && <EnrollSheet gw={gw} lock={lock} onClose={() => { setEnrolling(false); void load(); }} />}
    </>
  );
}

// ---- Records tab ---------------------------------------------------------- //
function RecordsTab({ gw, lock }: { gw: ReturnType<typeof gateways.get> & object; lock: SavedLock }) {
  const toast = useToast();
  const [recs, setRecs] = useState<RecordDto[] | null>(null);
  const [days, setDays] = useState(7);
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    async (d: number) => {
      setLoading(true);
      try {
        const r = await api.records(gw, lock.lockId, d);
        setRecs(r.records);
      } catch (err) {
        toast(err instanceof ApiError ? err.message : "Could not load records.", "err");
        setRecs([]);
      } finally {
        setLoading(false);
      }
    },
    [gw, lock.lockId, toast]
  );

  useEffect(() => {
    void load(days);
  }, [load, days]);

  return (
    <>
      <div className="seg">
        {[1, 7, 30].map((d) => (
          <button key={d} className={days === d ? "on" : ""} onClick={() => setDays(d)}>
            {d === 1 ? "Today" : `${d} days`}
          </button>
        ))}
      </div>
      {loading ? (
        <Center><Spinner /></Center>
      ) : recs && recs.length > 0 ? (
        <div className="card">
          {recs.map((r, i) => (
            <div key={i} className="listrow">
              <div className="grow">
                <div className="title">User #{r.user}</div>
                <div className="meta">{r.time}</div>
              </div>
              <span className="pill">{r.mode}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="empty">
          <div className="big">🗒️</div>No entries in this range.
          <div className="meta" style={{ marginTop: 6 }}>App unlocks are not logged by the lock.</div>
        </div>
      )}
    </>
  );
}

// ---- Settings tab --------------------------------------------------------- //
function SettingsTab({
  gw,
  lock,
  onLockChange,
  onRemoved
}: {
  gw: ReturnType<typeof gateways.get> & object;
  lock: SavedLock;
  onLockChange: (l: SavedLock) => void;
  onRemoved: () => void;
}) {
  const toast = useToast();
  const [autolock, setAutolock] = useState("5");
  const [busy, setBusy] = useState("");

  async function saveAutolock() {
    setBusy("autolock");
    try {
      await api.setAutoLock(gw, lock.lockId, parseInt(autolock, 10) || 5);
      toast("Auto-lock delay saved.", "ok");
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Failed.", "err");
    } finally {
      setBusy("");
    }
  }

  function saveActuator(user: number, pin: string) {
    const next = { ...lock, actuatorUser: user, actuatorPin: pin };
    locks.upsert(next);
    onLockChange(next);
  }

  async function factoryReset() {
    if (!window.confirm(`Factory-reset ${lock.name}? This wipes all users and settings on the lock.`)) return;
    setBusy("reset");
    try {
      await api.factoryReset(gw, lock.lockId);
      toast("Lock factory reset.", "ok");
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Reset failed.", "err");
    } finally {
      setBusy("");
    }
  }

  function forget() {
    if (!window.confirm(`Remove ${lock.name} from this app? The lock stays bound on the gateway.`)) return;
    locks.remove(lock.gatewayId, lock.lockId);
    onRemoved();
  }

  return (
    <>
      <div className="card">
        <div className="title" style={{ marginBottom: 10 }}>Actuator credentials</div>
        <div className="meta" style={{ marginBottom: 12 }}>User id + PIN the app sends with every unlock/lock.</div>
        <div className="row" style={{ gap: 10 }}>
          <div className="field grow">
            <label>User id</label>
            <input
              className="input"
              inputMode="numeric"
              defaultValue={String(lock.actuatorUser)}
              onBlur={(e) => saveActuator(parseInt(e.target.value, 10) || 1, lock.actuatorPin)}
            />
          </div>
          <div className="field grow">
            <label>PIN</label>
            <input
              className="input"
              inputMode="numeric"
              defaultValue={lock.actuatorPin}
              onBlur={(e) => saveActuator(lock.actuatorUser, e.target.value)}
            />
          </div>
        </div>
      </div>

      <div className="card">
        <div className="title" style={{ marginBottom: 10 }}>Auto-lock delay</div>
        <div className="row" style={{ gap: 10 }}>
          <input className="input grow" inputMode="numeric" value={autolock} onChange={(e) => setAutolock(e.target.value)} />
          <button className="btn small primary" style={{ width: "auto" }} onClick={saveAutolock} disabled={busy === "autolock"}>
            {busy === "autolock" ? <Spinner /> : "Save"}
          </button>
        </div>
        <div className="meta" style={{ marginTop: 8 }}>Seconds before the lock re-locks after an unlock.</div>
      </div>

      <button className="btn danger" onClick={factoryReset} disabled={busy === "reset"}>
        {busy === "reset" ? <Spinner /> : "Factory reset lock"}
      </button>
      <button className="btn ghost" style={{ marginTop: 10 }} onClick={forget}>
        Remove from app
      </button>
    </>
  );
}
