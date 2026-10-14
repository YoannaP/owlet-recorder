#!/usr/bin/env python3
"""Pull MONITORING_SUMMARY blobs from Owlet and archive them in SQLite.

Owlet keeps roughly two days of these 10-minute summaries and then drops them,
so this stores the raw base64 verbatim whether or not we can decode it yet.
Run it at least daily; re-runs are idempotent.
"""
import os
import sys
import json
import base64
import sqlite3
import asyncio
import datetime as dt

from owlet_client import connect, get_socks, make_session

HERE = os.path.dirname(os.path.abspath(__file__))
DB = os.path.join(HERE, "data", "owlet.db")


def open_db(path=DB):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    conn = sqlite3.connect(path)
    for name in (path, f"{path}-wal", f"{path}-shm"):
        if os.path.exists(name):
            os.chmod(name, 0o600)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS summaries (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          dsn TEXT NOT NULL,
          created_at TEXT NOT NULL,      -- when Ayla recorded the datapoint
          window_start INTEGER,          -- unix seconds, from inside the blob
          window_end INTEGER,
          duration INTEGER,
          nbytes INTEGER,
          raw TEXT NOT NULL,             -- base64, exactly as returned
          fetched_at INTEGER NOT NULL,
          UNIQUE(dsn, created_at)
        )
    """)
    conn.commit()
    return conn


def header(raw):
    """First 4 bytes are a non-protobuf prefix; the message starts at offset 4.

    Fields 1/2 are the window start, 3 the end, 4 the duration in seconds.
    """
    b, i, out = raw[4:], 0, {}
    while i < len(b) and len(out) < 4:
        key = b[i]; i += 1
        fno, wt = key >> 3, key & 7
        if wt != 0:
            break
        v, sh = 0, 0
        while i < len(b):
            x = b[i]; i += 1
            v |= (x & 0x7f) << sh; sh += 7
            if not x & 0x80:
                break
        out[fno] = v
    return out.get(1), out.get(3), out.get(4)


async def archive(session, api, sock, conn):
    """Fetch the current summary page and store anything new. Returns count."""
    url = (f"{api._api_url}/dsns/{sock.serial}"
           f"/properties/MONITORING_SUMMARY/datapoints.json")
    async with session.get(url, headers=api.headers,
                           params={"limit": "100"}) as r:
        if r.status != 200:
            # The body is not logged: it can echo account or device details.
            raise RuntimeError(f"HTTP {r.status}")
        dps = json.loads(await r.text())
    return _store(conn, sock.serial, dps), len(dps)


def _store(conn, dsn, dps):
    new = 0
    for row in dps:
        dp = row["datapoint"]
        raw = base64.b64decode(dp["value"])
        start, end, dur = header(raw)
        cur = conn.execute(
            """INSERT OR IGNORE INTO summaries
               (dsn, created_at, window_start, window_end, duration,
                nbytes, raw, fetched_at)
               VALUES (?,?,?,?,?,?,?,?)""",
            (dsn, dp["created_at"], start, end, dur,
             len(raw), dp["value"], int(dt.datetime.now().timestamp())))
        new += cur.rowcount
    conn.commit()
    return new


async def main():
    conn = open_db()
    async with make_session() as session:
        api, region = await connect(session)
        sock = (await get_socks(api))[0]
        new, fetched = await archive(session, api, sock, conn)
        await api.close()
    n, lo, hi = conn.execute(
        "SELECT COUNT(*), MIN(window_start), MAX(window_end) FROM summaries"
    ).fetchone()
    f = lambda t: dt.datetime.fromtimestamp(t).strftime("%a %d %b %H:%M") if t else "?"
    print(f"fetched {fetched}, {new} new")
    print(f"archive: {n} summaries, {f(lo)} .. {f(hi)}")
    conn.close()


if __name__ == "__main__":
    os.umask(0o077)
    try:
        asyncio.run(main())
    except Exception as error:
        # A traceback could print request URLs with the device serial.
        from owlet_client import describe

        sys.exit(f"Stopped: {describe(error)}")
