"""Archive Owlet's named position-history response, independently of raw bp."""

import asyncio
import base64
import json
import os
import sqlite3
import time

import aiohttp
from pyowletapi.api import OwletAPI

from owlet_client import load_tokens, make_session

DEVICE_VERSIONS = {
    "DEVICE_TYPE_SMARTSOCK4": "smartSock4",
    "DEVICE_TYPE_SMARTSOCK3_SLEEP": "smartSock3Sleep",
}


class HistoryAPI(OwletAPI):
    async def get_mini_token(self, token):
        self.firebase_token = token
        return await super().get_mini_token(token)


def open_history_db(path):
    connection = sqlite3.connect(path, timeout=5)
    connection.execute(
        """CREATE TABLE IF NOT EXISTS position_history (
        dsn TEXT NOT NULL, profile TEXT NOT NULL, sample_ts INTEGER NOT NULL,
        code INTEGER NOT NULL, version TEXT NOT NULL, fetched_at INTEGER NOT NULL,
        PRIMARY KEY(dsn, profile, sample_ts)
    )"""
    )
    connection.commit()
    return connection


def store_positions(connection, dsn, profile, version, payload, start, end):
    data = payload.get("data", {})
    times, codes = data.get("positionTimes"), data.get("bodyPositions")
    if (
        not isinstance(times, list)
        or not isinstance(codes, list)
        or len(times) != len(codes)
    ):
        raise ValueError("Mismatched position arrays")
    if any(
        type(t) is not int or type(c) is not int or not start <= t < end
        for t, c in zip(times, codes)
    ):
        raise ValueError("Invalid position observations")
    if any(b <= a for a, b in zip(times, times[1:])):
        raise ValueError("Position timestamps are not strictly increasing")
    now = int(time.time())
    with connection:
        connection.executemany(
            """INSERT INTO position_history VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(dsn, profile, sample_ts) DO UPDATE SET
            code=excluded.code, version=excluded.version, fetched_at=excluded.fetched_at""",
            [(dsn, profile, t, c, version, now) for t, c in zip(times, codes)],
        )
    return len(times)


async def fetch_history(session, region, dsn, cached, start, end):
    api = HistoryAPI(
        region=region,
        token=cached.get("api_token"),
        expiry=cached.get("expiry"),
        refresh=cached.get("refresh"),
        session=session,
    )
    # Use the library's authentication headers and exchange. Never activate a
    # device or persist this background worker's tokens over the recorder's.
    await api.refresh_authentication()
    claims = json.loads(
        base64.urlsafe_b64decode(api.firebase_token.split(".")[1] + "===")
    )
    account = claims["user_id"]
    suffix = ".eu" if region == "europe" else ""
    headers = {"Authorization": "Bearer " + api.firebase_token}

    async def get(service, path, params=None):
        async with session.get(
            f"https://{service}{suffix}.owletdata.com/{path}",
            headers=headers,
            params=params,
            timeout=aiohttp.ClientTimeout(total=20),
        ) as response:
            if response.status != 200:
                raise RuntimeError(f"Position history HTTP {response.status}")
            return await response.json()

    profiles = (await get("accounts", f"v2/accounts/{account}/profiles"))["profiles"]
    if len(profiles) != 1:
        raise ValueError("Position history requires an unambiguous single profile")
    profile = profiles[0]["name"].split("/")[-1]
    devices = (await get("devices-public", f"v2/accounts/{account}/devices"))["devices"]
    device = next(
        (d for d in devices if d["name"].split("/")[-1].upper() == dsn.upper()), None
    )
    if device is None or device.get("deviceType") not in DEVICE_VERSIONS:
        raise ValueError("Unsupported position-history device type")
    version = DEVICE_VERSIONS[device["deviceType"]]
    payload = await get(
        "sleep-data",
        f"v1/accounts/{account}/profiles/{profile}/sleep",
        {
            "startTime": start,
            "endTime": end,
            "timeZone": os.environ.get("OWLET_TIMEZONE", "UTC"),
            "version": version,
            "returnBodyPositions": "true",
        },
    )
    return profile, version, payload


async def record_history(path, region, dsn, stopping, log, interval=600):
    """A slow history fetch must not delay the five-second vitals poll."""
    connection = open_history_db(path)
    try:
        async with make_session() as session:
            while not stopping.is_set():
                end = int(time.time())
                start = end - 2 * 86400
                try:
                    profile, version, payload = await asyncio.wait_for(
                        fetch_history(session, region, dsn, load_tokens(), start, end),
                        timeout=90,
                    )
                    count = store_positions(
                        connection, dsn, profile, version, payload, start, end
                    )
                    log(f"position archive: {count} reported observations refreshed")
                except Exception as error:
                    # Exception text can contain account-specific request URLs.
                    log(f"position archive unavailable: {type(error).__name__}")
                try:
                    await asyncio.wait_for(stopping.wait(), timeout=interval)
                except asyncio.TimeoutError:
                    pass
    finally:
        connection.close()
