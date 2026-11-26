import { useEffect, useState } from "react";
import { FiCreditCard, FiGrid } from "react-icons/fi";
import { MdFingerprint } from "react-icons/md";

import { api, ApiError, type UserDto, type UserValidity } from "../services/api";
import type { Gateway } from "../services/store";
import { Spinner } from "./Sheet";

const ON = "#22c55e";
const OFF = "rgba(255,255,255,0.22)";

/** Fingerprint / card / PIN icons — green when that credential is enrolled. */
export function CredIcons({ u, size = 18 }: { u: UserDto; size?: number }) {
  const item = (on: boolean, icon: JSX.Element, label: string) => (
    <span
      title={`${label}: ${on ? "enrolled" : "not set"}`}
      aria-label={`${label} ${on ? "enrolled" : "not set"}`}
      style={{ color: on ? ON : OFF, fontSize: size, display: "inline-flex" }}
    >
      {icon}
    </span>
  );
  return (
    <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
      {item((u.fingers ?? 0) > 0, <MdFingerprint />, "Fingerprint")}
      {item(!!u.card, <FiCreditCard />, "Card")}
      {item(!!u.pin, <FiGrid />, "PIN")}
    </span>
  );
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Short human text for a validity window. */
export function validityText(v?: UserValidity): string {
  if (!v || v.permanent) return "Permanent access";
  const days =
    (v.weekdays & 0x7f) === 0x7f ? "every day" : DAYS.filter((_, i) => v.weekdays & (1 << i)).join(", ") || "no days";
  const hours = v.daily_start === "00:00" && v.daily_end === "23:59" ? "all day" : `${v.daily_start}–${v.daily_end}`;
  return `${v.start} → ${v.end} · ${hours} · ${days}`;
}

export function isExpired(v?: UserValidity): boolean {
  if (!v || v.permanent) return false;
  return v.end < new Date().toISOString().slice(0, 10);
}

/**
 * Pick one of the lock's users (with credential icons). Loads the list from
 * the lock via the gateway.
 */
export function UserPicker({
  gw,
  lockId,
  value,
  onPick
}: {
  gw: Gateway;
  lockId: string;
  value: number;
  onPick: (u: UserDto) => void;
}) {
  const [users, setUsers] = useState<UserDto[] | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    let alive = true;
    api
      .users(gw, lockId)
      .then((r) => alive && setUsers(r.users))
      .catch((e) => {
        if (!alive) return;
        setErr(e instanceof ApiError ? e.message : "Could not read users.");
        setUsers([]);
      });
    return () => {
      alive = false;
    };
  }, [gw, lockId]);

  if (users === null)
    return (
      <div className="meta" style={{ padding: 8 }}>
        <Spinner /> Reading users from the lock…
      </div>
    );
  if (users.length === 0)
    return <div className="meta">{err || "No users on this lock yet — add one in the Users tab."}</div>;
  return (
    <div>
      {users.map((u) => (
        <button
          key={u.id}
          className="listrow"
          style={{ width: "100%", textAlign: "left" }}
          onClick={() => onPick(u)}
        >
          <div className="grow">
            <div className="title">
              {u.name || "(no name)"} <span className="meta">#{u.id}</span>
            </div>
            <div className="meta">{u.group === "admin" ? "Admin" : "General"}</div>
          </div>
          <CredIcons u={u} size={16} />
          {value === u.id && (
            <span className="pill ok" style={{ marginLeft: 8 }}>
              selected
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
