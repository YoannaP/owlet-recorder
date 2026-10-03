#!/usr/bin/env python3
"""Create reported-sleep records for HTTP and browser acceptance tests."""

import argparse
import json
import sqlite3
import sys
import time
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from logger import COLUMNS


def create_fixture(path: Path) -> None:
    connection = sqlite3.connect(path)
    columns = ", ".join(f"{name} {kind}" for name, kind in COLUMNS)
    connection.execute(
        f"""CREATE TABLE vitals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            dsn TEXT NOT NULL,
            sample_ts INTEGER NOT NULL,
            polled_ts INTEGER NOT NULL,
            {columns},
            raw TEXT,
            UNIQUE(dsn, sample_ts)
        )"""
    )

    def insert(sample_ts: int, sleep_state: int | None) -> None:
        values = {
            "oxygen_saturation": 98,
            "heart_rate": 120,
            "oxygen_10_av": 98,
            "battery_percentage": 80,
            "battery_minutes": 400,
            "signal_strength": 4,
            "skin_temperature": 34,
            "sleep_state": sleep_state,
            "movement": 1,
            "charging": 0,
            "sock_connection": 1,
            "base_station_on": 1,
            "sock_off": 0,
        }
        names = [
            "dsn",
            "sample_ts",
            "polled_ts",
            *[name for name, _ in COLUMNS],
            "raw",
        ]
        record = ["fixture", sample_ts, sample_ts]
        record.extend(values.get(name) for name, _ in COLUMNS)
        record.append(json.dumps({}))
        connection.execute(
            f"INSERT INTO vitals ({','.join(names)}) VALUES ({','.join('?' for _ in names)})",
            record,
        )

    now = int(time.time()) // 60 * 60
    for offset, sleep_state in [
        (-300, 1),
        (-285, None),
        (-270, 8),
        (-255, 42),
        (-240, 15),
        (-210, 0),
        (-60, 8),
        (-30, 15),
        (0, 1),
    ]:
        insert(now + offset, sleep_state)

    london = ZoneInfo("Europe/London")
    for day, states in [
        (12, [1, 8, 15]),
        (13, [1, None, 8, 42, 15, 0, 8, 15]),
    ]:
        start = int(datetime(2026, 9, day, 20, tzinfo=london).timestamp())
        for index, sleep_state in enumerate(states):
            offset = index * 30
            if index >= 4:
                offset += 150
            insert(start + offset, sleep_state)

    connection.commit()
    connection.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("path", type=Path)
    args = parser.parse_args()
    create_fixture(args.path)
