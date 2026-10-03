#!/usr/bin/env python3
"""Create deterministic-looking recent Owlet records for Live browser tests."""

import argparse
import json
import sqlite3
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from logger import COLUMNS
from position_history import open_history_db, store_positions


def create_fixture(path: Path, state: str = "monitoring", age_seconds: int = 0) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
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
    if state == "no_data":
        connection.close()
        return
    now = int(time.time()) - age_seconds
    rows = []
    for offset in range(-4 * 3600, 1, 30):
        if -5700 < offset < -5100:
            continue
        sample_ts = now + offset
        values = {
            "oxygen_saturation": 98 + ((offset // 30) % 3 == 0),
            "heart_rate": 118 + (offset // 30) % 7,
            "oxygen_10_av": 98,
            "battery_percentage": 82,
            "battery_minutes": 480,
            "signal_strength": 4,
            "skin_temperature": 34,
            "sleep_state": 8,
            "movement": 2,
            "charging": 0,
            "sock_connection": 1,
            "base_station_on": 1,
            "sock_off": 0,
        }
        rows.append((sample_ts, values))

    latest = rows[-1][1]
    latest["movement"] = 0
    if state == "charging":
        latest.update(charging=2, heart_rate=0, oxygen_saturation=0, oxygen_10_av=255)
    elif state == "oxygen_sentinel":
        latest.update(oxygen_saturation=255, oxygen_10_av=255)
    elif state == "sock_off":
        latest.update(sock_off=1, heart_rate=0, oxygen_saturation=0)
    elif state == "base_off":
        latest.update(base_station_on=0, heart_rate=0, oxygen_saturation=0)
    elif state == "stale":
        rows = [(timestamp - 300, values) for timestamp, values in rows]

    names = ["dsn", "sample_ts", "polled_ts", *[name for name, _ in COLUMNS], "raw"]
    placeholders = ",".join("?" for _ in names)
    for sample_ts, values in rows:
        record = ["fixture", sample_ts, sample_ts]
        record.extend(values.get(name) for name, _ in COLUMNS)
        record.append(json.dumps({}))
        connection.execute(
            f"INSERT INTO vitals ({','.join(names)}) VALUES ({placeholders})", record
        )
    connection.commit()
    connection.close()
    history = open_history_db(path)
    store_positions(
        history,
        "fixture",
        "profile",
        "smartSock4",
        {
            "data": {
                "positionTimes": [now - 900, now - 840, now - 600],
                "bodyPositions": [4, 10, 99],
            }
        },
        now - 1000,
        now,
    )
    history.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("path", type=Path)
    parser.add_argument("--age-seconds", type=int, default=0)
    parser.add_argument(
        "--state",
        choices=(
            "monitoring",
            "charging",
            "oxygen_sentinel",
            "sock_off",
            "base_off",
            "stale",
            "no_data",
        ),
    )
    args = parser.parse_args()
    create_fixture(args.path, args.state, args.age_seconds)
