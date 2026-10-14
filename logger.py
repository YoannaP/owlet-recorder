#!/usr/bin/env python3
"""Poll the Owlet cloud and append every reading to SQLite.

This is a data recorder, not an alarm. The Owlet app and base station remain
the monitoring device; nothing here is a substitute for them.

Usage:  ./logger.py [--interval 5] [--db data/owlet.db]
"""
import argparse
import asyncio
import datetime as dt
import json
import os
import signal
import sqlite3
import sys
import time

from fetch_summaries import archive
from fetch_summaries import open_db as open_summary_db
from owlet_client import (
    connect,
    describe,
    get_socks,
    load_tokens,
    make_session,
    save_tokens,
)
from position_history import record_history

HERE = os.path.dirname(os.path.abspath(__file__))

# Numeric/boolean fields worth keeping as their own column. Everything else
# still lands in the raw JSON blob.
COLUMNS = [
    ("oxygen_saturation", "REAL"),
    ("heart_rate", "REAL"),
    ("oxygen_10_av", "REAL"),
    ("battery_percentage", "REAL"),
    ("battery_minutes", "REAL"),
    ("signal_strength", "REAL"),
    ("skin_temperature", "INTEGER"),
    ("sleep_state", "INTEGER"),
    ("movement", "INTEGER"),
    ("movement_bucket", "INTEGER"),
    ("charging", "INTEGER"),
    ("sock_connection", "INTEGER"),
    ("base_station_on", "INTEGER"),
    ("sock_off", "INTEGER"),
    ("sock_disconnected", "INTEGER"),
    ("alert_paused_status", "INTEGER"),
    ("alerts_mask", "INTEGER"),
    ("wellness_alert", "INTEGER"),
    ("readings_flag", "INTEGER"),
    ("brick_status", "INTEGER"),
    ("monitoring_start_time", "INTEGER"),
    ("low_oxygen_alert", "INTEGER"),
    ("high_oxygen_alert", "INTEGER"),
    ("low_heart_rate_alert", "INTEGER"),
    ("high_heart_rate_alert", "INTEGER"),
    ("low_battery_alert", "INTEGER"),
    ("lost_power_alert", "INTEGER"),
]


def log(msg):
    print(f"{dt.datetime.now():%Y-%m-%d %H:%M:%S}  {msg}", flush=True)


def open_db(path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    conn = sqlite3.connect(path)
    # WAL lets the web server read while we are still writing.
    conn.execute("PRAGMA journal_mode=WAL")
    cols = ",\n  ".join(f"{n} {t}" for n, t in COLUMNS)
    conn.execute(
        f"""
        CREATE TABLE IF NOT EXISTS vitals (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          dsn TEXT NOT NULL,
          sample_ts INTEGER NOT NULL,   -- unix seconds, from the sock's own clock
          polled_ts INTEGER NOT NULL,   -- unix seconds, when we fetched it
          {cols},
          raw TEXT,
          UNIQUE(dsn, sample_ts)
        )
    """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_vitals_ts ON vitals(sample_ts)")
    conn.commit()
    return conn


def parse_sample_ts(props):
    """The sock reports 'last_updated' as 'YYYY/MM/DD HH:MM:SS' in UTC."""
    raw = props.get("last_updated")
    if not raw:
        return None
    try:
        naive = dt.datetime.strptime(raw, "%Y/%m/%d %H:%M:%S")
        return int(naive.replace(tzinfo=dt.timezone.utc).timestamp())
    except ValueError:
        return None


def insert(conn, dsn, props, raw_vitals, no_raw=False):
    sample_ts = parse_sample_ts(props)
    if sample_ts is None:
        return False

    names = ["dsn", "sample_ts", "polled_ts"] + [n for n, _ in COLUMNS] + ["raw"]
    values = [dsn, sample_ts, int(time.time())]
    for name, _ in COLUMNS:
        v = props.get(name)
        values.append(int(v) if isinstance(v, bool) else v)
    values.append(None if no_raw else json.dumps(raw_vitals))

    placeholders = ",".join("?" * len(names))
    cur = conn.execute(
        f"INSERT OR IGNORE INTO vitals ({','.join(names)}) VALUES ({placeholders})",
        values,
    )
    conn.commit()
    return cur.rowcount > 0


async def run(args):
    conn = open_db(args.db)
    stopping = asyncio.Event()

    def stop(*_):
        log("Shutting down.")
        stopping.set()

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)

    async with make_session() as session:
        api, region = await connect(session)
        socks = await get_socks(api)
        if not socks:
            raise SystemExit("No devices on this account.")
        sock = socks[0]
        # The device serial stays out of the journal; the model is enough.
        log(
            f"Logging {sock.oem_model} (region={region}) "
            f"every {args.interval}s -> {args.db}"
        )

        last_active = 0.0
        last_summary = 0.0
        last_beat = 0.0
        stored = skipped = errors = summaries = 0
        # Same database; open_db() only adds the summaries table if missing.
        open_summary_db(args.db)
        position_task = asyncio.create_task(
            record_history(args.db, region, sock.serial, stopping, log)
        )

        while not stopping.is_set():
            try:
                # The base station only streams while an app is marked active,
                # and the flag lapses, so re-assert it periodically.
                if time.time() - last_active > args.active_interval:
                    await api.activate(sock.serial)
                    last_active = time.time()

                # Owlet drops these after ~2 days, so grab them while we can.
                if time.time() - last_summary > args.summary_interval:
                    try:
                        new, seen = await archive(session, api, sock, conn)
                        summaries += new
                        # Log every attempt, not just productive ones -- otherwise
                        # a silently broken archive looks identical to "nothing new".
                        log(
                            f"summary archive: {seen} returned, {new} new "
                            f"({summaries} this run)"
                        )
                    except Exception as e:
                        log(f"summary fetch failed: {describe(e)}")
                    last_summary = time.time()

                result = await sock.update_properties()
                if "tokens" in result:
                    save_tokens({"region": region, **result["tokens"]})

                props = result["properties"]
                raw = result["raw_properties"].get("REAL_TIME_VITALS", {}).get("value")
                if insert(conn, sock.serial, props, raw, args.no_raw):
                    stored += 1
                    if args.log_vitals:
                        log(
                            f"HR {props.get('heart_rate'):>5}  "
                            f"SpO2 {props.get('oxygen_saturation'):>5}  "
                            f"mv {props.get('movement')}  "
                            f"sleep {props.get('sleep_state')}  "
                            f"batt {props.get('battery_percentage')}%  "
                            f"[{stored} stored, {skipped} dup, {errors} err]"
                        )
                else:
                    skipped += 1
                errors = 0

                # Heartbeat instead of per-sample logging: counts and whether the
                # sock is reporting, never a vital sign. Logs stay clean of
                # personal data.
                if not args.log_vitals and time.time() - last_beat > args.log_interval:
                    worn = not props.get("sock_off") and not props.get("charging")
                    log(
                        f"{stored} stored, {skipped} dup, {errors} err, "
                        f"{summaries} summaries · "
                        f"{'recording' if worn else 'sock not worn'}"
                    )
                    last_beat = time.time()

            except Exception as e:
                errors += 1
                log(f"Error ({errors}): {describe(e)}")
                # Back off on repeated failures rather than hammering the API.
                await asyncio.sleep(min(60, 2 ** min(errors, 6)))
                continue

            try:
                await asyncio.wait_for(stopping.wait(), timeout=args.interval)
            except asyncio.TimeoutError:
                pass

        position_task.cancel()
        try:
            await position_task
        except asyncio.CancelledError:
            pass
        await api.close()
        conn.close()


if __name__ == "__main__":
    # Recordings and tokens are created owner-only, whatever the shell's umask.
    os.umask(0o077)
    p = argparse.ArgumentParser()
    p.add_argument(
        "--interval",
        type=float,
        default=10.0,
        help="seconds between polls (default 10)",
    )
    p.add_argument(
        "--active-interval",
        type=float,
        default=60.0,
        help="seconds between APP_ACTIVE refreshes (default 60)",
    )
    p.add_argument(
        "--log-vitals",
        action="store_true",
        help="log every reading's values. Off by default: heart rate "
        "and oxygen are personal health data and do not belong "
        "in the journal. Use for local debugging only.",
    )
    p.add_argument(
        "--log-interval",
        type=float,
        default=300.0,
        help="seconds between heartbeat log lines (default 300)",
    )
    p.add_argument(
        "--no-raw",
        action="store_true",
        help="do not store the raw REAL_TIME_VITALS JSON per sample. "
        "Roughly halves the database, but loses keys with no column "
        "(e.g. bp, mrs; see docs/owlet-api.md)",
    )
    p.add_argument(
        "--summary-interval",
        type=float,
        default=1800.0,
        help="seconds between MONITORING_SUMMARY archive runs "
        "(default 1800; Owlet keeps ~2 days of them)",
    )
    p.add_argument("--db", default=os.path.join(HERE, "data", "owlet.db"))
    asyncio.run(run(p.parse_args()))
