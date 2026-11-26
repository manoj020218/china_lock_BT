/**
 * Attendance report from lock records, for payroll.
 *
 * The lock logs each entry (PIN / fingerprint / card) with the user and time;
 * phone-app opens come from the gateway log. Per person per day we take the
 * first punch as IN and the last punch as OUT (standard for door-access
 * attendance) and the span between them as hours.
 */

import type { RecordDto, UserDto } from "./api";
import { buildXlsx, type Cell } from "./xlsx";

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

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function attendanceWorkbook(opts: {
  lockName: string;
  records: RecordDto[];
  users: UserDto[];
  from: string; // YYYY-MM-DD
  to: string;
  includeApp: boolean; // count phone-app opens as punches
}): Uint8Array {
  const name = (id: number) => opts.users.find((u) => u.id === id)?.name || `User #${id}`;
  const valid = opts.records.filter((r) => r.ok !== false && r.action !== "lock" && /^\d{4}-\d{2}-\d{2} /.test(r.time));
  const punches = valid.filter((r) => opts.includeApp || !r.source || r.source === "lock");

  // ---- Attendance sheet: one row per user per day ----
  const byKey = new Map<string, RecordDto[]>();
  for (const r of punches) {
    const key = `${r.time.slice(0, 10)}|${r.user}`;
    (byKey.get(key) ?? byKey.set(key, []).get(key)!).push(r);
  }
  const att: Cell[][] = [["Date", "Day", "User ID", "Name", "First IN", "Last OUT", "Hours", "Punches", "Methods"]];
  const keys = [...byKey.keys()].sort((a, b) => {
    const [da, ua] = a.split("|");
    const [db, ub] = b.split("|");
    return da === db ? Number(ua) - Number(ub) : da.localeCompare(db);
  });
  const totals = new Map<number, { days: number; hours: number }>();
  for (const k of keys) {
    const rs = byKey.get(k)!.sort((a, b) => a.time.localeCompare(b.time));
    const [date, uid] = k.split("|");
    const first = rs[0].time.slice(11, 16);
    const last = rs[rs.length - 1].time.slice(11, 16);
    const mins = (t: string) => Number(t.slice(11, 13)) * 60 + Number(t.slice(14, 16));
    const hours = rs.length > 1 ? Math.round(((mins(rs[rs.length - 1].time) - mins(rs[0].time)) / 60) * 100) / 100 : 0;
    const methods = [...new Set(rs.map((r) => METHOD[r.mode] ?? r.mode))].join(", ");
    const d = new Date(`${date}T00:00:00Z`);
    att.push([date, DOW[d.getUTCDay()], Number(uid), name(Number(uid)), first, rs.length > 1 ? last : "", hours, rs.length, methods]);
    const t = totals.get(Number(uid)) ?? { days: 0, hours: 0 };
    t.days += 1;
    t.hours += hours;
    totals.set(Number(uid), t);
  }

  // ---- Summary sheet: per user totals for the period ----
  const sum: Cell[][] = [["User ID", "Name", "Days present", "Total hours", "Period"]];
  for (const [uid, t] of [...totals.entries()].sort((a, b) => a[0] - b[0])) {
    sum.push([uid, name(uid), t.days, Math.round(t.hours * 100) / 100, `${opts.from} to ${opts.to}`]);
  }

  // ---- Full log ----
  const log: Cell[][] = [["Date", "Time", "User ID", "Name", "Action", "Method", "Source", "Accepted"]];
  for (const r of [...opts.records].sort((a, b) => a.time.localeCompare(b.time))) {
    log.push([
      r.time.slice(0, 10),
      r.time.slice(11),
      r.user,
      name(r.user),
      r.action === "lock" ? "Lock" : "Unlock",
      METHOD[r.mode] ?? r.mode,
      r.source === "lock" || !r.source ? "Lock memory" : "Gateway",
      r.ok === false ? "No" : "Yes"
    ]);
  }

  return buildXlsx([
    { name: "Attendance", rows: att, widths: [12, 6, 9, 22, 10, 10, 8, 9, 26] },
    { name: "Summary", rows: sum, widths: [9, 22, 13, 12, 26] },
    { name: "Full log", rows: log, widths: [12, 10, 9, 22, 9, 16, 13, 10] }
  ]);
}
