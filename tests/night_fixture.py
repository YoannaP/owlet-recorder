#!/usr/bin/env python3
"""Create fixed night records for Night HTTP and browser acceptance tests."""

import argparse
import json
import sqlite3
import sys
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from logger import COLUMNS

LONDON = ZoneInfo("Europe/London")


def _timestamp(day, hour, minute=0):
    return int(
        datetime(day.year, day.month, day.day, hour, minute, tzinfo=LONDON).timestamp()
    )


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

    def insert(sample_ts, *, hr=120, ox=98, sleep=8, valid=True):
        values = {
            "oxygen_saturation": ox if valid else 0,
            "heart_rate": hr if valid else 0,
            "oxygen_10_av": ox if valid else 255,
            "battery_percentage": 80,
            "battery_minutes": 400,
            "signal_strength": 4,
            "skin_temperature": 34,
            "sleep_state": sleep,
            "movement": 1,
            "charging": 0 if valid else 2,
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

    # Two ordinary nights. The latest includes a 30-minute collection gap and
    # ten minutes of invalid charging readings inside the worn interval.
    for day, base_hr in ((datetime(2026, 9, 12), 110), (datetime(2026, 9, 13), 130)):
        start = _timestamp(day, 20)
        for minute in range(0, 601):
            if day.day == 13 and 240 <= minute < 270:
                continue
            valid = not (day.day == 13 and 300 <= minute < 310)
            insert(
                start + minute * 60,
                hr=base_hr + minute % 5,
                ox=94 + minute % 6,
                sleep=15 if minute < 180 else (8 if minute < 540 else 1),
                valid=valid,
            )

    # London clock change: this local noon-to-noon window lasts 25 real hours.
    dst_day = datetime(2026, 10, 24)
    start = _timestamp(dst_day, 12)
    end = int((datetime(2026, 10, 25, 12, tzinfo=LONDON)).timestamp())
    current = start
    while current < end:
        insert(current, hr=101, ox=97, sleep=8)
        current += 60

    short_start = _timestamp(datetime(2026, 9, 11), 20)
    for index, (hr, ox) in enumerate(((100, 90), (110, 92), (120, 94), (130, 96))):
        insert(short_start + index * 60, hr=hr, ox=ox, sleep=8)

    # Available history includes records older than the former 800-day limit.
    insert(_timestamp(datetime(2020, 1, 1), 20), hr=117, ox=98, sleep=8)

    connection.commit()
    connection.close()
    from position_history import open_history_db, store_positions

    connection = open_history_db(path)
    start = _timestamp(datetime(2026, 9, 13), 20)
    connection.execute("UPDATE vitals SET movement=0 WHERE sample_ts=?", (start + 60,))
    connection.commit()
    store_positions(
        connection,
        "fixture",
        "profile",
        "smartSock4",
        {
            "data": {
                "positionTimes": [start + i * 60 for i in [0, 1, 2, 3, 4, 8, 9]],
                "bodyPositions": [4, 5, 6, 10, 11, 1, 99],
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
