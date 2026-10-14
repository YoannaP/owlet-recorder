#!/usr/bin/env python3
"""Write a synthetic recording so the app can be tried without a sock.

Every value is generated. Nothing here comes from a real child.

    uv run python scripts/demo_data.py data/demo.db --timezone America/New_York
    uv run python scripts/demo_data.py data/demo.db --live    # keeps adding readings
    uv run python scripts/demo_data.py data/demo.db --overwrite   # start again
    uv run python server.py --db data/demo.db --timezone America/New_York

Three weeks of nights (about 19:30 to 06:30 local) with sleep cycles, wakings,
small oxygen dips, a charging gap on some nights and position changes. Tonight
runs up to now and, with --live, continues every few seconds.
"""

import argparse
import datetime as dt
import json
import math
import os
import random
import sqlite3
import sys
import time
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from logger import COLUMNS  # noqa: E402
from position_history import open_history_db, store_positions  # noqa: E402

DSN = "DEMO00000000"
STEP = 5
AWAKE, LIGHT, DEEP = 1, 8, 15
POSITIONS = {AWAKE: [1, 1, 4, 6], LIGHT: [4, 5, 6, 8, 10], DEEP: [4, 5, 6, 10, 11]}


def holds_real_data(path):
    """True if the file has anything this script did not write."""
    connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        tables = {row[0] for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type='table'")}
        if tables - {"vitals", "position_history", "sqlite_sequence"}:
            return True
        for table in {"vitals", "position_history"} & tables:
            if connection.execute(
                    f"SELECT 1 FROM {table} WHERE dsn != ? LIMIT 1", (DSN,)).fetchone():
                return True
        return False
    except sqlite3.DatabaseError:
        return True
    finally:
        connection.close()


def create(path, overwrite):
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        # Never delete a real recording by pointing this at the wrong file.
        if holds_real_data(path):
            raise SystemExit(f"{path} holds data this script did not write; refusing to replace it.")
        if not overwrite:
            raise SystemExit(f"{path} exists; pass --overwrite to replace the demo data.")
        for suffix in ("", "-wal", "-shm"):
            Path(f"{path}{suffix}").unlink(missing_ok=True)
    connection = sqlite3.connect(path)
    columns = ", ".join(f"{name} {kind}" for name, kind in COLUMNS)
    connection.execute(
        f"""CREATE TABLE vitals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            dsn TEXT NOT NULL, sample_ts INTEGER NOT NULL, polled_ts INTEGER NOT NULL,
            {columns}, raw TEXT, UNIQUE(dsn, sample_ts))"""
    )
    connection.execute("PRAGMA journal_mode=WAL")
    return connection


class Night:
    """A random walk through sleep stages with physiology that follows them."""

    def __init__(self, rng, start, days_ago=0):
        self.rng = rng
        self.start = start
        # Each night differs a little, and heart rate drifts down over weeks.
        self.hr_shift = rng.gauss(0, 3) + days_ago * 0.35
        self.ox_base = rng.choice([96, 97, 97, 98])
        self.stage = AWAKE
        self.stage_left = rng.randint(600, 1500)
        self.hr = 135.0
        self.cry = 0
        self.dip = 0
        self.position = 1
        self.battery = 100.0
        self.positions = []

    def advance(self, ts):
        rng = self.rng
        self.stage_left -= STEP
        if self.stage_left <= 0:
            if self.stage == AWAKE:
                self.stage = LIGHT
            elif self.stage == LIGHT:
                self.stage = DEEP if rng.random() < 0.6 else AWAKE
            else:
                self.stage = LIGHT
            self.stage_left = {AWAKE: rng.randint(180, 1200),
                               LIGHT: rng.randint(900, 2400),
                               DEEP: rng.randint(1200, 3000)}[self.stage]
            if self.stage == AWAKE and rng.random() < 0.5:
                self.cry = rng.randint(60, 300)
        if rng.random() < (0.02 if self.stage == AWAKE else 0.004):
            self.position = rng.choice(POSITIONS[self.stage])
            minute = max(self.start, ts - ts % 60)
            if self.positions and self.positions[-1][0] == minute:
                self.positions.pop()
            self.positions.append((minute, self.position))
        if self.dip == 0 and self.stage != AWAKE and rng.random() < 0.0004:
            self.dip = rng.randint(15, 45)

        target = {AWAKE: 145, LIGHT: 124, DEEP: 108}[self.stage] + self.hr_shift
        if self.cry:
            target = 175 + 15 * math.sin(ts / 9)
            self.cry = max(0, self.cry - STEP)
        self.hr += (target - self.hr) * 0.15 + rng.gauss(0, 3 if self.stage == DEEP else 5)
        oxygen = self.ox_base + rng.choice([0, 1, 1, 2, 2, 3, 3])
        if self.dip:
            oxygen = rng.choice([95, 96, 96, 97])
            self.dip = max(0, self.dip - STEP)
        movement = {AWAKE: rng.randint(20, 160), LIGHT: rng.choice([0, 0, 2, 5, 12, 30]),
                    DEEP: rng.choice([0, 0, 0, 0, 1, 3])}[self.stage]
        if self.cry:
            movement = rng.randint(120, 200)
        self.battery = max(20.0, self.battery - 0.0012)
        return {
            "heart_rate": round(min(205, max(85, self.hr))),
            "oxygen_saturation": min(100, oxygen),
            "oxygen_10_av": 99,
            "battery_percentage": round(self.battery),
            "battery_minutes": round(self.battery * 9),
            "signal_strength": rng.randint(60, 90),
            "skin_temperature": 33 + (self.stage == DEEP) + (rng.random() < 0.2),
            "sleep_state": self.stage,
            "movement": movement,
            "movement_bucket": min(100, round(movement / 2 / 8.33) * 8 + (movement > 0) * 8),
            "charging": 0, "sock_connection": 1, "base_station_on": 1, "sock_off": 0,
            "sock_disconnected": 0, "alert_paused_status": 0, "alerts_mask": 0,
            "wellness_alert": 3, "readings_flag": 0, "brick_status": 0,
            "monitoring_start_time": self.start,
            "low_oxygen_alert": 0, "high_oxygen_alert": 0, "low_heart_rate_alert": 0,
            "high_heart_rate_alert": 0, "low_battery_alert": 0, "lost_power_alert": 0,
        }


def charging(ts):
    return {name: 0 for name, _ in COLUMNS} | {
        "charging": 2, "base_station_on": 1, "oxygen_10_av": 255,
        "battery_percentage": 100, "monitoring_start_time": 0, "sock_connection": 2,
    }


NAMES = ["dsn", "sample_ts", "polled_ts", *[name for name, _ in COLUMNS], "raw"]
INSERT = f"INSERT OR IGNORE INTO vitals ({','.join(NAMES)}) VALUES ({','.join('?' * len(NAMES))})"


def insert(connection, ts, values):
    connection.execute(INSERT, [DSN, ts, ts, *(values.get(n) for n, _ in COLUMNS), json.dumps({})])


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("db", type=Path)
    parser.add_argument("--nights", type=int, default=21)
    parser.add_argument("--timezone", default="UTC")
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--live", action="store_true", help="keep adding a reading every 5 s")
    parser.add_argument("--overwrite", action="store_true",
                        help="replace an existing demo database (never a real one)")
    args = parser.parse_args()

    rng = random.Random(args.seed)
    zone = ZoneInfo(args.timezone)
    connection = create(args.db, args.overwrite)
    history = open_history_db(args.db)
    now = int(time.time())
    today = dt.datetime.fromtimestamp(now, zone).date()

    night = None
    for days_ago in range(args.nights, -1, -1):
        day = today - dt.timedelta(days=days_ago)
        bedtime = dt.datetime.combine(day, dt.time(19, 30), zone) + dt.timedelta(minutes=rng.randint(-20, 40))
        start = int(bedtime.timestamp())
        if start > now:
            start = now - 4 * 3600
        end = min(now, start + rng.randint(10 * 3600, 11 * 3600 + 1800))
        night = Night(rng, start, days_ago)
        gap = None
        if rng.random() < 0.3:
            gap_start = start + rng.randint(3, 7) * 3600
            gap = (gap_start, gap_start + rng.randint(15, 50) * 60)
        for ts in range(start, end, STEP):
            if gap and gap[0] <= ts < gap[1]:
                if ts % 60 == 0:
                    insert(connection, ts, charging(ts))
                continue
            insert(connection, ts, night.advance(ts))
        if end < now:
            insert(connection, end + 60, charging(end + 60))
        connection.commit()
        if night.positions:
            times, codes = zip(*night.positions)
            store_positions(history, DSN, "demo", "smartSock4",
                            {"data": {"positionTimes": list(times), "bodyPositions": list(codes)}},
                            start, end)
        connection.commit()

    print(f"wrote {args.nights + 1} synthetic nights to {args.db}")
    if not args.live:
        return
    # Keep tonight lively for screenshots: lean towards light sleep and wakings.
    night.stage, night.stage_left = AWAKE, 120
    ts = now - now % STEP
    print("adding a reading every 5 s; Ctrl-C to stop")
    try:
        while True:
            ts += STEP
            time.sleep(max(0, ts - time.time()))
            insert(connection, ts, night.advance(ts))
            connection.commit()
            if night.positions and night.positions[-1][0] >= ts - 60:
                t, code = night.positions[-1]
                store_positions(history, DSN, "demo", "smartSock4",
                                {"data": {"positionTimes": [t], "bodyPositions": [code]}}, t, t + 60)
            connection.commit()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    os.umask(0o077)
    main()
