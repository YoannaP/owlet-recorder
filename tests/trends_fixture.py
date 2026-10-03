#!/usr/bin/env python3
"""Create fixed nightly records for Trends acceptance tests."""

import argparse
import json
import sqlite3
import sys
from datetime import datetime, time, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from logger import COLUMNS

LONDON = ZoneInfo("Europe/London")


def create_fixture(path: Path) -> None:
    connection = sqlite3.connect(path)
    columns = ", ".join(f"{name} {kind}" for name, kind in COLUMNS)
    connection.execute(
        f"""CREATE TABLE vitals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            dsn TEXT NOT NULL,
            sample_ts INTEGER NOT NULL,
            polled_ts INTEGER NOT NULL,
            {columns}, raw TEXT, UNIQUE(dsn, sample_ts)
        )"""
    )
    names = ["dsn", "sample_ts", "polled_ts", *[name for name, _ in COLUMNS], "raw"]
    placeholders = ",".join("?" for _ in names)

    def insert(sample_ts, heart_rate, oxygen, sleep_state=8, movement=1, temp=34):
        values = {
            "oxygen_saturation": oxygen,
            "heart_rate": heart_rate,
            "oxygen_10_av": oxygen,
            "battery_percentage": 80,
            "battery_minutes": 400,
            "signal_strength": 4,
            "skin_temperature": temp,
            "sleep_state": sleep_state,
            "movement": movement,
            "charging": 0,
            "sock_connection": 1,
            "base_station_on": 1,
            "sock_off": 0,
        }
        record = ["fixture", sample_ts, sample_ts]
        record.extend(values.get(name) for name, _ in COLUMNS)
        record.append(json.dumps({}))
        connection.execute(
            f"INSERT INTO vitals ({','.join(names)}) VALUES ({placeholders})", record
        )

    today = datetime.now(LONDON).date()
    # Leave one missing night inside the seven-day view and records outside
    # each longer period so period changes are observable.
    # The newest night reports movement for the first hour only, and its
    # temperature varies around 34, so nightly shares and medians are checkable.
    for offset, heart_rate in ((0, 120), (1, 110), (3, 100), (8, 90), (31, 80)):
        day = today - timedelta(days=offset)
        start = datetime.combine(day, time(20), LONDON)
        for minute in range(0, 121):
            insert(
                int((start + timedelta(minutes=minute)).timestamp()),
                heart_rate + minute % 3,
                94 + minute % 5,
                8 if minute < 90 else 1,
                movement=1 if offset or minute < 60 else 0,
                temp=33 + minute % 3 if offset == 0 else 34,
            )
    connection.commit()
    connection.close()

    from position_history import open_history_db, store_positions

    connection = open_history_db(path)
    start = int(datetime.combine(today, time(20), LONDON).timestamp())
    # Only the newest night has archived positions: two back, one side, one
    # tummy, plus a "moving" code that is not a posture.
    store_positions(
        connection,
        "fixture",
        "profile",
        "smartSock4",
        {
            "data": {
                "positionTimes": [start + i * 60 for i in range(5)],
                "bodyPositions": [4, 5, 6, 10, 1],
            }
        },
        start,
        start + 600,
    )
    connection.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("path", type=Path)
    args = parser.parse_args()
    create_fixture(args.path)
