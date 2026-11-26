import { useCallback, useEffect, useState } from "react";
import { FiArrowLeft, FiClock, FiDownload, FiEdit2, FiLock, FiRefreshCw, FiUnlock, FiUserPlus } from "react-icons/fi";

import { AddUserSheet } from "../components/AddUserSheet";
import { describeNormallyOpen, NormallyOpenCard, type NormallyOpen } from "../components/NormallyOpenCard";
import { OtpCard } from "../components/OtpCard";
import { SignalCard } from "../components/SignalCard";
import { SecretInput } from "../components/SecretInput";
import { Center, Spinner } from "../components/Sheet";
import { CredIcons, isExpired, UserPicker, validityText } from "../components/UserBits";
import { EnrollSheet } from "../components/EnrollSheet";
import { UserEditSheet } from "../components/UserEditSheet";
import { attendanceWorkbook } from "../services/attendance";
import { shareFile } from "../services/share";
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
  const [closeIn, setCloseIn] = useState(0); // seconds until the gateway re-locks

  useEffect(() => {
    if (closeIn <= 0) return;
    const t = window.setTimeout(() => setCloseIn((n) => n - 1), 1000);
    return () => window.clearTimeout(t);
  }, [closeIn]);
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(initial.name);

  function saveName() {
    const n = nameDraft.trim();
    setRenaming(false);
    if (!n || n === lock.name) {
      setNameDraft(lock.name);
      return;
    }
    const next = { ...lock, name: n.slice(0, 40) };
    locks.upsert(next);
    setLock(next);
    toast("Lock renamed.", "ok");
  }

  async function actuate(kind: "unlock" | "lock") {
    if (acting) return;
    setActing(kind);
    feedback(kind); // immediate sound+haptic on the big button
    try {
      if (kind === "unlock") {
        const r = await api.unlock(gw, lock.lockId, lock.actuatorUser, lock.actuatorPin);
        setCloseIn(r.auto_close_in ?? 0);
        toast(r.auto_close_in ? `Unlocked ✓ — closes again in ${r.auto_close_in} s` : "Unlocked ✓", "ok");
      } else {
        await api.lock(gw, lock.lockId, lock.actuatorUser, lock.actuatorPin);
        setCloseIn(0);
        toast("Locked ✓", "ok");
      }
    } catch (err) {
      // A weak-signal / unreachable error means the command did NOT reach the lock.
      const msg = err instanceof ApiError ? err.message : `${kind} failed.`;
      // "rejected" = the lock got the command but refused this user ID + PIN.
      toast(
        /rejected/i.test(msg)
          ? `Lock refused user #${lock.actuatorUser}'s PIN. Set the right user + PIN in this lock's Settings tab.`
          : msg,
        "err"
      );
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
          {renaming ? (
            <input
              className="input"
              autoFocus
              maxLength={40}
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={saveName}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveName();
                if (e.key === "Escape") {
                  setNameDraft(lock.name);
                  setRenaming(false);
                }
              }}
              style={{ fontSize: 18, padding: "6px 10px" }}
            />
          ) : (
            <button
              onClick={() => setRenaming(true)}
              aria-label="Rename lock"
              style={{ background: "none", border: "none", color: "inherit", padding: 0, textAlign: "left", display: "flex", alignItems: "center", gap: 8 }}
            >
              <h1 style={{ fontSize: 20, margin: 0 }}>{lock.name}</h1>
              <FiEdit2 style={{ opacity: 0.6, fontSize: 16 }} />
            </button>
          )}
          <div className="sub">
            {gw.name} · {lock.lockId}
          </div>
        </div>
      </div>

      <div className="actuators">
        <button className="actuator unlock" data-fb="unlock" disabled={!!acting} onClick={() => actuate("unlock")}>
          <span className="ico">{acting === "unlock" ? <Spinner /> : <FiUnlock />}</span>
          {closeIn > 0 ? `Closes in ${closeIn}s` : "Unlock"}
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

      {tab === "control" && <ControlTab gw={gw} lock={lock} onLockChange={setLock} />}
      {tab === "users" && <UsersTab gw={gw} lock={lock} />}
      {tab === "records" && <RecordsTab gw={gw} lock={lock} />}
      {tab === "settings" && <SettingsTab gw={gw} lock={lock} onLockChange={setLock} onRemoved={onBack} />}
    </div>
  );
}

// ---- Control tab ---------------------------------------------------------- //
function ControlTab({
  gw,
  lock,
  onLockChange
}: {
  gw: ReturnType<typeof gateways.get> & object;
  lock: SavedLock;
  onLockChange: (l: SavedLock) => void;
}) {
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

  // Don't block the tab while the gateway connects: actions, signal and the
  // door code work immediately; lock details fill in as they arrive.
  const pending = loading && !info;

  return (
    <>
      <SignalCard gw={gw} lock={lock} />
      <OtpCard gw={gw} lock={lock} onLockChange={onLockChange} />
      <div className="card">
        <div className="listrow">
          <div className="grow title">Firmware</div>
          <div className="meta">{pending ? <Spinner /> : info?.fw}</div>
        </div>
        <div className="listrow">
          <div className="grow title">Battery</div>
          <div className="meta">{pending ? <Spinner /> : info?.battery}</div>
        </div>
        <div className="listrow">
          <div className="grow title">Lock clock</div>
          <div className="meta">{pending ? <Spinner /> : info?.time}</div>
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
    </>
  );
}

// ---- Users tab ------------------------------------------------------------ //
function UsersTab({ gw, lock }: { gw: ReturnType<typeof gateways.get> & object; lock: SavedLock }) {
  const toast = useToast();
  const [users, setUsers] = useState<UserDto[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<UserDto | null>(null);
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

  return (
    <>
      <div className="btn-row" style={{ marginBottom: 12 }}>
        <button className="btn" onClick={() => setAdding(true)}>
          <FiUserPlus /> Add user
        </button>
        <button className="btn" onClick={() => setEnrolling(true)}>
          Enroll finger / card
        </button>
        <button className="btn" onClick={() => void load()} aria-label="Refresh">
          <FiRefreshCw />
        </button>
      </div>
      {loading ? (
        <Center><Spinner /></Center>
      ) : users && users.length > 0 ? (
        <div className="card">
          {users.map((u) => (
            <button key={u.id} className="listrow" style={{ width: "100%", textAlign: "left" }} onClick={() => setEditing(u)}>
              <div className="grow">
                <div className="title">
                  {u.name || "(no name)"} <span className="meta">#{u.id}</span>
                </div>
                <div className="meta" style={isExpired(u.validity) ? { color: "#f87171" } : undefined}>
                  {isExpired(u.validity) ? "Expired · " : ""}
                  {validityText(u.validity)}
                </div>
              </div>
              {u.group === "admin" && <span className="pill warn" style={{ marginRight: 8 }}>admin</span>}
              <CredIcons u={u} />
            </button>
          ))}
        </div>
      ) : (
        <div className="empty">
          <div className="big">👤</div>No users on this lock.
        </div>
      )}
      <div className="meta" style={{ marginTop: 8 }}>
        Tap a user to rename, add fingerprint / card / PIN, or set when they may enter. Green = enrolled.
      </div>
      {adding && <AddUserSheet gw={gw} lock={lock} onClose={() => setAdding(false)} onAdded={() => { setAdding(false); void load(); }} />}
      {editing && (
        <UserEditSheet gw={gw} lock={lock} user={editing} onClose={() => setEditing(null)} onChanged={() => void load()} />
      )}
      {enrolling && (
        <EnrollSheet
          gw={gw}
          lock={lock}
          onClose={() => {
            setEnrolling(false);
            void load();
          }}
        />
      )}
    </>
  );
}

// ---- Records tab ---------------------------------------------------------- //
// User names per lock, cached while the app runs (reading users takes a few s).
const userNameCache = new Map<string, Map<number, string>>();
function RecordsTab({ gw, lock }: { gw: ReturnType<typeof gateways.get> & object; lock: SavedLock }) {
  const toast = useToast();
  const [recs, setRecs] = useState<RecordDto[] | null>(null);
  const [lockWarn, setLockWarn] = useState("");
  const [names, setNames] = useState<Map<number, string>>(() => userNameCache.get(lock.lockId) ?? new Map());

  useEffect(() => {
    let alive = true;
    api
      .users(gw, lock.lockId)
      .then((r) => {
        const m = new Map(r.users.map((u) => [u.id, u.name] as [number, string]));
        userNameCache.set(lock.lockId, m);
        if (alive) setNames(m);
      })
      .catch(() => undefined); // keep "#id" if the lock can't be read
    return () => {
      alive = false;
    };
  }, [gw, lock.lockId]);
  const who = (id: number) => {
    const n = names.get(id);
    return n ? `${n} (#${id})` : `User #${id}`;
  };
  const [days, setDays] = useState(7);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);

  async function exportExcel() {
    setExporting(true);
    try {
      const [r, u] = await Promise.all([
        api.records(gw, lock.lockId, days),
        api.users(gw, lock.lockId).catch(() => ({ users: [] as UserDto[] }))
      ]);
      const nowLocal = Date.now() + lock.tzMinutes * 60000;
      const to = new Date(nowLocal).toISOString().slice(0, 10);
      const from = new Date(nowLocal - (days - 1) * 86400000).toISOString().slice(0, 10);
      const bytes = attendanceWorkbook({ lockName: lock.name, records: r.records, users: u.users, from, to, includeApp: true });
      const safe = lock.name.replace(/[^A-Za-z0-9_-]+/g, "_");
      await shareFile(
        `Attendance_${safe}_${from}_to_${to}.xlsx`,
        bytes,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Attendance report"
      );
      if (r.lock_unreachable) toast("Lock didn't answer — the file has phone opens only.", "info");
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Export failed.", "err");
    } finally {
      setExporting(false);
    }
  }

  const load = useCallback(
    async (d: number) => {
      setLoading(true);
      try {
        const r = await api.records(gw, lock.lockId, d);
        setRecs(r.records);
        setLockWarn(r.lock_unreachable ? "Lock didn't answer — showing app opens only. Touch the keypad and refresh." : "");
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
        {[1, 7, 30, 90].map((d) => (
          <button key={d} className={days === d ? "on" : ""} onClick={() => setDays(d)}>
            {d === 1 ? "Today" : `${d} days`}
          </button>
        ))}
      </div>
      <button className="btn" style={{ margin: "10px 0" }} onClick={exportExcel} disabled={exporting}>
        {exporting ? <Spinner /> : <FiDownload />} Download Excel (attendance)
      </button>
      {lockWarn && !loading && (
        <div className="meta" style={{ margin: "8px 4px" }}>
          ⚠️ {lockWarn}
        </div>
      )}
      {loading ? (
        <Center><Spinner /></Center>
      ) : recs && recs.length > 0 ? (
        <div className="card">
          {recs.map((r, i) => {
            const how = METHOD[r.mode] ?? r.mode;
            const act = r.action === "lock" ? "Locked" : "Unlocked";
            return (
              <div key={i} className="listrow">
                <div className="grow">
                  <div className="title">
                    {act} · {who(r.user)}
                  </div>
                  <div className="meta">
                    {r.time}
                    {r.ok === false && " · rejected by lock"}
                  </div>
                </div>
                <span className={`pill ${r.ok === false ? "bad" : r.source && r.source !== "lock" ? "ok" : ""}`}>{how}</span>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="empty">
          <div className="big">🗒️</div>No entries in this range.
          <div className="meta" style={{ marginTop: 6 }}>
            Shows keypad PIN, fingerprint and card opens (from the lock) and phone/app opens (from the gateway).
          </div>
        </div>
      )}
    </>
  );
}

const METHOD: Record<string, string> = {
  pin: "Keypad PIN",
  fingerprint: "Fingerprint",
  card: "Card",
  other: "Lock (other)",
  app: "Phone app",
  cloud: "Cloud",
  serial: "Service console",
  auto: "Auto close"
};

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
  const [appClose, setAppClose] = useState(true); // also re-lock after app unlocks (gateway)
  const [busy, setBusy] = useState("");
  const [nopen, setNopen] = useState<NormallyOpen | null>(null);
  const [settingsErr, setSettingsErr] = useState("");

  // Current values from the lock (gateway firmware 1.2.3+).
  useEffect(() => {
    let alive = true;
    api
      .settings(gw, lock.lockId)
      .then((r) => {
        if (!alive) return;
        setAutolock(String(r.auto_lock_s));
        if (r.app_auto_close_s !== undefined) setAppClose(r.app_auto_close_s > 0);
        setNopen(r.normally_open);
      })
      .catch((e) => alive && setSettingsErr(e instanceof ApiError ? e.message : "Could not read the lock settings."));
    return () => {
      alive = false;
    };
  }, [gw, lock.lockId]);

  async function saveAutolock() {
    const sec = parseInt(autolock, 10);
    if (!(sec >= 3 && sec <= 60)) {
      toast("Choose 3–60 seconds.", "err");
      return;
    }
    // Normally open keeps the lock unlocked, so auto close can't act then.
    let turnOffSchedule = false;
    if (nopen?.enabled) {
      turnOffSchedule = window.confirm(
        `Normally open is ON (${describeNormallyOpen(nopen)}). During that time the lock stays unlocked and auto close does not work.

Turn normally open OFF and use auto close?`
      );
      if (!turnOffSchedule) toast("Saved, but auto close won't work while normally open is active.", "info");
    }
    setBusy("autolock");
    try {
      if (turnOffSchedule) {
        await api.setNormallyOpen(gw, lock.lockId, { enabled: false });
        setNopen({ enabled: false, start_minute: 0, end_minute: 0, weekday_mask: 0 });
      }
      await api.setAutoLock(gw, lock.lockId, sec);
      try {
        await api.setAppAutoClose(gw, lock.lockId, appClose ? sec : 0);
      } catch {
        if (appClose) toast("Update the gateway firmware to close after app unlocks.", "info");
      }
      toast(`Saved — closes ${sec} s after opening${appClose ? " (app opens too)" : ""}.`, "ok");
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Failed.", "err");
    } finally {
      setBusy("");
    }
  }

  function saveActuator(user: number, pin: string) {
    if (user === lock.actuatorUser && pin === lock.actuatorPin) return;
    const next = { ...lock, actuatorUser: user, actuatorPin: pin };
    locks.upsert(next);
    onLockChange(next);
    toast(`Saved — the app opens as user #${user}.`, "ok");
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
        <div className="title" style={{ marginBottom: 4 }}>App opens the door as</div>
        <div className="meta" style={{ marginBottom: 10 }}>
          Pick a lock user; the app sends that user's PIN with every unlock/lock.
        </div>
        <UserPicker gw={gw} lockId={lock.lockId} value={lock.actuatorUser} onPick={(u) => saveActuator(u.id, lock.actuatorPin)} />
        <div className="field" style={{ marginTop: 10 }}>
          <label>PIN of user #{lock.actuatorUser}</label>
          <SecretInput
            inputMode="numeric"
            maxLength={16}
            defaultValue={lock.actuatorPin}
            onBlur={(e) => saveActuator(lock.actuatorUser, e.target.value.replace(/\D/g, ""))}
          />
          <div className="meta" style={{ marginTop: 6 }}>Saved when you leave the field.</div>
        </div>
      </div>

      <div className="card">
        <div className="title" style={{ marginBottom: 4 }}>Auto close the lock</div>
        <div className="meta" style={{ marginBottom: 10 }}>
          After opening (by app, PIN, finger or card) the lock closes again by itself after:
        </div>
        <div className="seg">
          {[5, 10, 15, 30, 60].map((sec) => (
            <button key={sec} className={autolock === String(sec) ? "on" : ""} onClick={() => setAutolock(String(sec))}>
              {sec < 60 ? `${sec}s` : "1 min"}
            </button>
          ))}
        </div>
        <div className="row" style={{ gap: 10, marginTop: 10 }}>
          <input
            className="input grow"
            inputMode="numeric"
            maxLength={2}
            value={autolock}
            onChange={(e) => setAutolock(e.target.value.replace(/\D/g, ""))}
            aria-label="Seconds"
          />
          <span className="meta">seconds</span>
          <button className="btn small primary" style={{ width: "auto" }} onClick={saveAutolock} disabled={busy === "autolock"}>
            {busy === "autolock" ? <Spinner /> : "Save"}
          </button>
        </div>
        <div className="listrow" style={{ marginTop: 8 }}>
          <div className="grow">
            <div className="title">Also close after app unlock</div>
            <div className="meta">The gateway locks again itself — works without a door magnet.</div>
          </div>
          <button
            role="switch"
            aria-checked={appClose}
            className="btn small"
            style={{ width: "auto" }}
            onClick={() => setAppClose(!appClose)}
          >
            {appClose ? "On" : "Off"}
          </button>
        </div>
        <div className="meta" style={{ marginTop: 8 }}>
          3–60 seconds. Keypad, fingerprint and card opens are closed by the lock itself, which needs its door magnet to
          see the door shut.
        </div>
      </div>

      {settingsErr ? (
        <div className="meta" style={{ margin: "0 4px 12px" }}>
          ⚠️ {settingsErr} Update the gateway firmware to see the current auto close / normally-open values.
        </div>
      ) : (
        <NormallyOpenCard key={nopen ? "loaded" : "loading"} gw={gw} lock={lock} value={nopen} onChange={setNopen} />
      )}

      <button className="btn danger" onClick={factoryReset} disabled={busy === "reset"}>
        {busy === "reset" ? <Spinner /> : "Factory reset lock"}
      </button>
      <button className="btn ghost" style={{ marginTop: 10 }} onClick={forget}>
        Remove from app
      </button>
    </>
  );
}
