"""Command-line interface for the Jenix lock client.

Read-only subcommands run by default. State-changing subcommands (unlock, lock,
set-time, add-user, enroll-pin, set-auto-lock, set-normally-open, reboot,
factory-reset) require the global ``--allow-write`` flag.

Run ``python -m client.cli --help`` for usage. Credentials come from
``--lock-id/--address/--password`` or env vars or a config file; see
``client/config.py``.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from datetime import datetime, timedelta

from .config import load_config
from .session import HahaLock
from . import protocol as P


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="jenix-lock", description="Jenix lock BLE client")
    p.add_argument("--lock-id")
    p.add_argument("--address", help="BLE MAC / platform address of the lock")
    p.add_argument("--password", help="connection (admin) password")
    p.add_argument("--command-version", type=int, default=None)
    p.add_argument("--config", help="path to jenix.config.json")
    p.add_argument("--payload-size", type=int, default=20)
    p.add_argument("--timeout", type=float, default=5.0)
    p.add_argument(
        "--allow-write",
        action="store_true",
        help="permit state-changing operations (unlock, writes, reboot, reset)",
    )
    p.add_argument(
        "--verbose", action="store_true", help="log redacted TX/RX frames to stderr"
    )
    p.add_argument(
        "--show-payloads",
        action="store_true",
        help="UNSAFE: log raw payloads (may contain credentials); never share such logs",
    )
    p.add_argument("--scan-timeout", type=float, default=8.0)

    sub = p.add_subparsers(dest="command", required=True)

    sc = sub.add_parser("scan", help="scan for nearby locks by advertised name")
    sc.add_argument("--rssi", type=int, default=-90, help="minimum RSSI to include")

    sub.add_parser("info", help="read firmware version and capabilities")
    sub.add_parser("battery", help="read battery percentage and voltage")
    sub.add_parser("time", help="read the lock clock")
    sub.add_parser("users", help="list enrolled users")

    rec = sub.add_parser("records", help="download unlock records")
    rec.add_argument("--days", type=int, default=1, help="look back this many days")

    getp = sub.add_parser("settings", help="read a raw settings parameter")
    getp.add_argument("--selector", type=int, default=None, help="selector id, omit for full blob")

    unlock = sub.add_parser("unlock", help="[write] unlock the door")
    unlock.add_argument("--user", type=int, required=True)
    unlock.add_argument("--pin", default="")

    lock = sub.add_parser("lock", help="[write] lock the door")
    lock.add_argument("--user", type=int, required=True)
    lock.add_argument("--pin", default="")

    st = sub.add_parser("set-time", help="[write] set the lock clock to now")
    st.add_argument("--tz-minutes", type=int, default=0, help="timezone offset in minutes")

    al = sub.add_parser("set-auto-lock", help="[write] set auto-lock delay seconds")
    al.add_argument("--seconds", type=int, required=True)

    sub.add_parser("reboot", help="[write] reboot the lock")
    return p


def _print_version(v: P.VersionInfo) -> None:
    print(f"firmware:          {v.firmware}")
    print(f"command version:   {v.command_version}")
    print(f"lock bonded:       {v.lock_bonded}")
    print(f"app bonded:        {v.app_bonded}")
    print(f"admin exists:      {v.admin_exists}")
    caps = []
    if v.has_fingerprint:
        caps.append("fingerprint")
    if v.has_card:
        caps.append("card")
    if v.has_pin:
        caps.append("pin")
    if v.has_face:
        caps.append("face")
    print(f"capabilities:      {', '.join(caps) if caps else 'unknown/none'}")


async def _run(args: argparse.Namespace) -> int:
    config = load_config(
        lock_id=args.lock_id,
        address=args.address,
        password=args.password,
        command_version=args.command_version,
        config_path=args.config,
    )

    logger = None
    if args.verbose or args.show_payloads:
        from .logging_util import FrameLogger
        logger = FrameLogger(show_payloads=args.show_payloads)

    if args.command == "scan":
        from .discover import scan_for_locks
        matches = await scan_for_locks(
            timeout=args.scan_timeout, rssi_threshold=args.rssi,
            lock_id=config.lock_id or None,
        )
        print(f"found {len(matches)} lock(s):")
        for m in matches:
            print(f"  {m.address}  {m.name}  rssi={m.rssi}")
        return 0

    async with HahaLock(
        config,
        allow_write=args.allow_write,
        payload_size=args.payload_size,
        timeout=args.timeout,
        scan_timeout=args.scan_timeout,
        frame_logger=logger,
    ) as lock:
        version = await lock.login()

        if args.command == "info":
            _print_version(version)
        elif args.command == "battery":
            pct, volts = await lock.battery()
            print(f"battery: {pct}%  voltage: {volts:.1f}V")
        elif args.command == "time":
            print(f"lock time: {await lock.get_time():%Y-%m-%d %H:%M:%S}")
        elif args.command == "users":
            users = await lock.list_users()
            print(f"total users: {len(users)}")
            for u in users:
                group = u.group.name.lower() if hasattr(u.group, "name") else u.group
                print(f"  #{u.user_id:<4} {u.name!r:<24} {group}")
        elif args.command == "records":
            end = datetime.now()
            start = end - timedelta(days=max(0, args.days - 1))
            records = await lock.read_records(start, end)
            print(f"records ({args.days}d): {len(records)}")
            for r in records:
                print(f"  {r.timestamp:%Y-%m-%d %H:%M:%S}  user {r.user_id:<4} {r.mode_name}")
        elif args.command == "settings":
            raw = await lock.get_parameter(args.selector)
            label = "full blob" if args.selector is None else f"selector {args.selector}"
            print(f"settings {label}: {raw.hex(' ')}")
        elif args.command == "unlock":
            await lock.unlock(args.user, args.pin)
            print("unlock sent (ack ok)")
        elif args.command == "lock":
            await lock.lock(args.user, args.pin)
            print("lock sent (ack ok)")
        elif args.command == "set-time":
            await lock.set_time(datetime.now(), args.tz_minutes)
            print("time set (ack ok)")
        elif args.command == "set-auto-lock":
            await lock.set_auto_lock_delay(args.seconds)
            print(f"auto-lock delay set to {args.seconds}s (ack ok)")
        elif args.command == "reboot":
            await lock.reboot()
            print("reboot sent (ack ok)")
        else:  # pragma: no cover - argparse enforces choices
            print(f"unknown command: {args.command}", file=sys.stderr)
            return 2
    return 0


def main(argv=None) -> int:
    args = _build_parser().parse_args(argv)
    try:
        return asyncio.run(_run(args))
    except Exception as exc:  # surface a clean message, not a traceback
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
