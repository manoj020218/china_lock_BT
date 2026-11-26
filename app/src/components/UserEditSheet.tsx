import { useState } from "react";
import { FiCreditCard, FiGrid, FiTrash2 } from "react-icons/fi";
import { MdFingerprint } from "react-icons/md";

import { api, ApiError, type EnrollType, type UserDto } from "../services/api";
import type { Gateway, SavedLock } from "../services/store";
import { EnrollSheet } from "./EnrollSheet";
import { Sheet, Spinner } from "./Sheet";
import { useToast } from "./Toast";
import { CredIcons, validityText } from "./UserBits";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const today = () => new Date().toISOString().slice(0, 10);

/**
 * One lock user: rename, access validity (permanent or a date/time window with
 * weekdays), enroll fingerprint / card / PIN, delete.
 */
export function UserEditSheet({
  gw,
  lock,
  user,
  onClose,
  onChanged
}: {
  gw: Gateway;
  lock: SavedLock;
  user: UserDto;
  onClose: () => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [u, setU] = useState(user);
  const [name, setName] = useState(user.name);
  const v = user.validity;
  const [permanent, setPermanent] = useState(!v || v.permanent);
  const [start, setStart] = useState(v && !v.permanent ? v.start : today());
  const [end, setEnd] = useState(v && !v.permanent ? v.end : today());
  const [dStart, setDStart] = useState(v && !v.permanent ? v.daily_start : "00:00");
  const [dEnd, setDEnd] = useState(v && !v.permanent ? v.daily_end : "23:59");
  const [days, setDays] = useState(v && !v.permanent ? v.weekdays & 0x7f : 0x7f);
  const [busy, setBusy] = useState("");
  const [enroll, setEnroll] = useState<EnrollType | null>(null);

  async function saveName() {
    const n = name.trim();
    if (!n || n.length > 21) {
      toast("Name must be 1–21 characters.", "err");
      return;
    }
    setBusy("name");
    try {
      const r = await api.updateUser(gw, lock.lockId, u.id, { name: n });
      setU(r.user);
      toast("Name saved.", "ok");
      onChanged();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Rename failed.", "err");
    } finally {
      setBusy("");
    }
  }

  async function saveValidity() {
    if (!permanent) {
      if (end < start) {
        toast("End date is before the start date.", "err");
        return;
      }
      if (days === 0) {
        toast("Pick at least one day.", "err");
        return;
      }
    }
    setBusy("validity");
    try {
      const r = await api.updateUser(gw, lock.lockId, u.id, {
        validity: permanent ? "permanent" : { start, end, daily_start: dStart, daily_end: dEnd, weekdays: days }
      });
      setU(r.user);
      toast(permanent ? "Access is now permanent." : "Access window saved.", "ok");
      onChanged();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Save failed.", "err");
    } finally {
      setBusy("");
    }
  }

  async function del() {
    if (!window.confirm(`Delete ${u.name || "user #" + u.id} and all their fingerprints, cards and PIN?`)) return;
    setBusy("del");
    try {
      await api.deleteUser(gw, lock.lockId, u.id);
      toast("User deleted.", "ok");
      onChanged();
      onClose();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Delete failed.", "err");
      setBusy("");
    }
  }

  return (
    <Sheet title={`${u.name || "User"} · #${u.id}`} onClose={onClose}>
      <div className="row" style={{ marginBottom: 14 }}>
        <span className="pill">{u.group === "admin" ? "Admin" : "General"}</span>
        <div className="grow" />
        <CredIcons u={u} size={20} />
      </div>

      {/* Name */}
      <div className="field">
        <label>Name</label>
        <div className="row" style={{ gap: 8 }}>
          <input className="input grow" maxLength={21} value={name} onChange={(e) => setName(e.target.value)} />
          <button
            className="btn small primary"
            style={{ width: "auto" }}
            onClick={saveName}
            disabled={busy === "name" || name.trim() === u.name}
          >
            {busy === "name" ? <Spinner /> : "Save"}
          </button>
        </div>
      </div>

      {/* Credentials */}
      <div className="card">
        <div className="title" style={{ marginBottom: 10 }}>
          Credentials
        </div>
        <div className="btn-row">
          <button className="btn small" onClick={() => setEnroll(1)}>
            <MdFingerprint /> {(u.fingers ?? 0) > 0 ? `Finger (${u.fingers})` : "Add finger"}
          </button>
          <button className="btn small" onClick={() => setEnroll(3)}>
            <FiCreditCard /> {u.card ? "Replace card" : "Add card"}
          </button>
          <button className="btn small" onClick={() => setEnroll(2)}>
            <FiGrid /> {u.pin ? "Change PIN" : "Set PIN"}
          </button>
        </div>
      </div>

      {/* Validity */}
      <div className="card">
        <div className="title" style={{ marginBottom: 4 }}>
          Access validity
        </div>
        <div className="meta" style={{ marginBottom: 10 }}>
          Now: {validityText(u.validity)}
        </div>
        <div className="seg">
          <button className={permanent ? "on" : ""} onClick={() => setPermanent(true)}>
            Permanent
          </button>
          <button className={!permanent ? "on" : ""} onClick={() => setPermanent(false)}>
            Custom
          </button>
        </div>
        {!permanent && (
          <>
            <div className="row" style={{ gap: 10 }}>
              <div className="field grow">
                <label>From date</label>
                <input className="input" type="date" value={start} onChange={(e) => setStart(e.target.value)} />
              </div>
              <div className="field grow">
                <label>To date</label>
                <input className="input" type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
              </div>
            </div>
            <div className="row" style={{ gap: 10 }}>
              <div className="field grow">
                <label>Daily from</label>
                <input className="input" type="time" value={dStart} onChange={(e) => setDStart(e.target.value)} />
              </div>
              <div className="field grow">
                <label>Daily to</label>
                <input className="input" type="time" value={dEnd} onChange={(e) => setDEnd(e.target.value)} />
              </div>
            </div>
            <label className="meta">Days</label>
            <div className="seg" style={{ marginTop: 6 }}>
              {DAYS.map((d, i) => (
                <button key={d} className={days & (1 << i) ? "on" : ""} onClick={() => setDays(days ^ (1 << i))}>
                  {d[0]}
                </button>
              ))}
            </div>
            <div className="meta" style={{ marginTop: 4 }}>
              Example: staff Mon–Sat 09:00–18:00. A daily end earlier than the start runs past midnight.
            </div>
          </>
        )}
        <button className="btn primary" style={{ marginTop: 12 }} onClick={saveValidity} disabled={busy === "validity"}>
          {busy === "validity" ? <Spinner /> : "Save access"}
        </button>
      </div>

      <button className="btn danger" onClick={del} disabled={busy === "del"}>
        {busy === "del" ? <Spinner /> : (
          <>
            <FiTrash2 /> Delete user
          </>
        )}
      </button>

      {enroll && (
        <EnrollSheet
          gw={gw}
          lock={lock}
          presetUser={u.id}
          presetType={enroll}
          onClose={() => {
            setEnroll(null);
            onChanged();
          }}
          onEnrolled={async () => {
            // Refresh this user's credential icons.
            try {
              const r = await api.users(gw, lock.lockId);
              const me = r.users.find((x) => x.id === u.id);
              if (me) setU(me);
            } catch {
              /* keep current */
            }
          }}
        />
      )}
    </Sheet>
  );
}
