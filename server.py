#!/usr/bin/env python3
"""Live Owlet dashboard: JSON API plus a self-refreshing page.

Binds loopback by default. Publish it privately (e.g. `tailscale serve`, or an
SSH tunnel); it has no authentication and must never face the public internet.

    ./server.py [--host 127.0.0.1] [--port 8400] [--db data/owlet.db]
                [--timezone Europe/Paris]
"""

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import sqlite3
from math import ceil, floor, isfinite
from zoneinfo import ZoneInfo

from aiohttp import web

HERE = os.path.dirname(os.path.abspath(__file__))
SLEEP_STATES = {0: "Unknown", 1: "Awake", 8: "Light sleep", 15: "Deep sleep"}
# Nights run local noon to noon. Set with --timezone or OWLET_TIMEZONE (IANA name).
NIGHT_TIMEZONE_NAME = os.environ.get("OWLET_TIMEZONE", "UTC")
NIGHT_TIMEZONE = ZoneInfo(NIGHT_TIMEZONE_NAME)
MAX_RECORDED_INTERVAL_S = 60


def q(db, sql, args=()):
    conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        return [dict(r) for r in conn.execute(sql, args)]
    finally:
        conn.close()


async def latest(request):
    db = request.app["db"]
    rows = q(
        db,
        """SELECT sample_ts, heart_rate, oxygen_saturation, oxygen_10_av,
                           movement, sleep_state, skin_temperature,
                           battery_percentage, battery_minutes, signal_strength,
                           sock_off, charging, sock_connection, base_station_on,
                           alerts_mask
                    FROM vitals ORDER BY sample_ts DESC LIMIT 1""",
    )
    if not rows:
        return web.json_response({"ok": False, "reason": "no data"}, status=503)
    r = rows[0]
    # Decide "is this a real reading" in one place. The sock reports 0 bpm /
    # 0% and an oxygen_10_av sentinel of 255 while it sits on the charger, and
    # `charging` is not a clean boolean -- it reads 2 on the base. Showing a
    # confident "0 bpm" on a baby monitor is the worst possible failure, so
    # anything short of a genuine reading is reported as not monitoring.
    r["monitoring"] = bool(
        r["base_station_on"]
        and not r["sock_off"]
        and not r["charging"]
        and (r["heart_rate"] or 0) > 0
    )
    r["not_monitoring_reason"] = (
        None
        if r["monitoring"]
        else (
            "charging"
            if r["charging"]
            else (
                "sock off"
                if r["sock_off"]
                else "base station off" if not r["base_station_on"] else "no reading"
            )
        )
    )
    r["sleep_label"] = SLEEP_STATES.get(r["sleep_state"], "Unknown")
    r["age_s"] = round(dt.datetime.now().timestamp() - r["sample_ts"])
    # Stale data is the failure mode that matters: say so rather than showing
    # a confident number from twenty minutes ago.
    r["stale"] = r["age_s"] > 120
    r["ok"] = True
    r["temp"] = temperature_point(r)["temp"]
    r["eligible_movement"] = movement_point(r)["movement"]
    return web.json_response(r)


MAX_SERIES_HOURS = 48


async def series(request):
    db = request.app["db"]
    try:
        hours = float(request.query.get("hours", 12))
    except ValueError:
        hours = float("nan")
    # Bounded so one request cannot load the whole history into memory.
    if not (isfinite(hours) and 0 < hours <= MAX_SERIES_HOURS):
        return web.json_response(
            {"ok": False, "reason": f"hours must be above 0 and at most {MAX_SERIES_HOURS}"},
            status=400,
        )
    now = dt.datetime.now().timestamp()
    since = int(now - hours * 3600)
    # Keep the payload small on long ranges without hiding gaps.
    bucket = 5 if hours <= 3 else (30 if hours <= 12 else (60 if hours <= 48 else 300))
    rows = q(
        db,
        f"""
        SELECT CAST(sample_ts / {bucket} AS INT) * {bucket} AS t,
               AVG(heart_rate) AS hr, MIN(heart_rate) AS hr_lo, MAX(heart_rate) AS hr_hi,
               AVG(CASE WHEN oxygen_saturation > 0 AND oxygen_saturation <= 100
                        THEN oxygen_saturation END) AS ox,
               MIN(CASE WHEN oxygen_saturation > 0 AND oxygen_saturation <= 100
                        THEN oxygen_saturation END) AS ox_lo,
               MAX(movement) AS mv, COUNT(*) AS n
        FROM vitals
        WHERE sample_ts >= ? AND sock_off = 0 AND charging = 0
              AND base_station_on = 1 AND heart_rate > 0
        GROUP BY t ORDER BY t""",
        (since,),
    )
    sleep_points = q(
        db,
        """SELECT sample_ts AS t, sleep_state AS sleep
        FROM vitals
        WHERE sample_ts >= ? AND sock_off = 0 AND charging = 0
              AND base_station_on = 1 AND heart_rate > 0
        ORDER BY sample_ts""",
        (since,),
    )
    raw = q(
        db,
        """SELECT sample_ts, heart_rate, skin_temperature, movement,
                  charging, sock_off, base_station_on, battery_percentage
           FROM vitals WHERE sample_ts >= ? ORDER BY sample_ts""",
        (since,),
    )
    return web.json_response(
        {
            "bucket": bucket,
            "gap_after_s": max(45, round(bucket * 1.5)),
            "hours": hours,
            "resolution": f"{bucket}-second bucket averages",
            "rows": rows,
            "sleep_resolution": "Reported observations",
            "sleep_gap_after_s": MAX_RECORDED_INTERVAL_S,
            "sleep_points": sleep_points,
            "temperature_points": [temperature_point(row) for row in raw],
            "movement_points": [movement_point(row) for row in raw],
            "position_points": position_points(db, since, int(now) + 1),
            "recording_context": recording_context(raw),
            "observation_gap_after_s": MAX_RECORDED_INTERVAL_S,
            "timezone": NIGHT_TIMEZONE_NAME,
        }
    )


async def health(request):
    db = request.app["db"]
    rows = q(db, "SELECT MAX(sample_ts) AS last, COUNT(*) AS n FROM vitals")
    last = rows[0]["last"] or 0
    age = round(dt.datetime.now().timestamp() - last) if last else None
    ok = age is not None and age < 120
    return web.json_response(
        {
            "ok": ok,
            "rows": rows[0]["n"],
            "last_sample_age_s": age,
            "web_revision": request.app["web_revision"],
        },
        status=200 if ok else 503,
    )


def _pct(sorted_vals, q):
    """Linearly interpolated percentile, matching the conventional median."""
    if not sorted_vals:
        return None
    rank = max(0, min(len(sorted_vals) - 1, q / 100 * (len(sorted_vals) - 1)))
    lower, upper = floor(rank), ceil(rank)
    if lower == upper:
        return sorted_vals[lower]
    value = sorted_vals[lower] + (sorted_vals[upper] - sorted_vals[lower]) * (
        rank - lower
    )
    return round(value, 1)


def _spans(rows, pred, cap=60):
    """Total seconds and longest run where pred(row) holds.

    Time is measured between consecutive samples, capped at `cap` so a gap in
    collection is never counted as if it were continuous sleep.
    """
    total = longest = cur = 0
    runs = 0
    prev = None
    for r in rows:
        if prev is not None:
            dt_ = min(r["sample_ts"] - prev["sample_ts"], cap)
            if pred(prev):
                total += dt_
                cur += dt_
                longest = max(longest, cur)
            else:
                if cur:
                    runs += 1
                cur = 0
        prev = r
    if cur:
        runs += 1
    return total, longest, runs


def night_key(ts):
    """Nights run noon to noon, so one night is never split across two dates."""
    local = dt.datetime.fromtimestamp(ts, NIGHT_TIMEZONE)
    if local.hour < 12:
        local -= dt.timedelta(days=1)
    return local.date().isoformat()


def night_bounds(key):
    day = dt.date.fromisoformat(key)
    start = dt.datetime.combine(day, dt.time(12), NIGHT_TIMEZONE)
    end = dt.datetime.combine(day + dt.timedelta(days=1), dt.time(12), NIGHT_TIMEZONE)
    return int(start.timestamp()), int(end.timestamp())


def valid_reading(row):
    return bool(
        row["base_station_on"]
        and not row["sock_off"]
        and not row["charging"]
        and (row["heart_rate"] or 0) > 0
    )


def temperature_point(row):
    """Preserve raw sensor integers; nulls break the experimental chart."""
    value = row["skin_temperature"]
    eligible = (
        row["base_station_on"] == 1
        and row["sock_off"] == 0
        and row["charging"] == 0
        and valid_reading(row)
        and isinstance(value, (int, float))
        and isfinite(value)
        and value > 0
        and value == int(value)
    )
    return {"t": row["sample_ts"], "temp": value if eligible else None}


def recording_state(row):
    if row["charging"] is not None and row["charging"] != 0:
        return "Charging reported"
    if row["sock_off"] == 1:
        return "Sock off reported"
    if row["base_station_on"] == 0:
        return "Base off reported"
    if row["charging"] != 0 or row["sock_off"] != 0 or row["base_station_on"] != 1:
        return "Device state unknown"
    return "Readings recorded" if valid_reading(row) else "Reading unavailable"


def movement_point(row):
    value = row["movement"]
    eligible = (
        recording_state(row) == "Readings recorded"
        and isinstance(value, (int, float))
        and isfinite(value)
        and value >= 0
        and value == int(value)
    )
    return {"t": row["sample_ts"], "movement": value if eligible else None}


def recording_context(rows):
    intervals = []
    flag_names = ("charging", "sock_off", "base_station_on")
    for previous, current in zip(rows, rows[1:]):
        start, end = previous["sample_ts"], current["sample_ts"]
        if end <= start:
            continue
        state = recording_state(previous)
        if end - start > MAX_RECORDED_INTERVAL_S:
            label = "Nothing recorded"
        elif state != recording_state(current) or any(
            previous[k] != current[k] for k in flag_names
        ):
            label = "State change between reports"
        else:
            label = state
        interval = {
            "start": start,
            "end": end,
            "label": label,
            "before": {
                key: previous[key]
                for key in (
                    "sample_ts",
                    "charging",
                    "sock_off",
                    "base_station_on",
                    "battery_percentage",
                )
            },
            "after": {
                key: current[key]
                for key in (
                    "sample_ts",
                    "charging",
                    "sock_off",
                    "base_station_on",
                    "battery_percentage",
                )
            },
        }
        if (
            intervals
            and label not in ("Nothing recorded", "State change between reports")
            and intervals[-1]["label"] == label
            and intervals[-1]["end"] == start
            and all(intervals[-1]["after"][k] == previous[k] for k in flag_names)
        ):
            intervals[-1]["end"] = end
            intervals[-1]["after"] = interval["after"]
        else:
            intervals.append(interval)
    return intervals


def position_points(db, start, end):
    if not q(
        db,
        "SELECT name FROM sqlite_master WHERE type='table' AND name='position_history'",
    ):
        return []
    rows = q(
        db,
        """SELECT sample_ts, code FROM position_history
        WHERE sample_ts >= ? AND sample_ts < ? ORDER BY sample_ts""",
        (start, end),
    )
    labels = {0: 0, 3: 0, 1: 1, 2: 2, 4: 3, 5: 3, 6: 4, 7: 4, 8: 4, 9: 4, 10: 5, 11: 5}
    return [
        {
            "t": row["sample_ts"],
            "position": labels.get(row["code"], 0),
            "position_code": row["code"],
        }
        for row in rows
    ]


def summarize_night(rows):
    worn = [row for row in rows if valid_reading(row)]
    if not worn:
        return None
    start, end = worn[0]["sample_ts"], worn[-1]["sample_ts"]
    interval_s = end - start
    recorded_s = sleep_s = movement_eligible_s = movement_active_s = 0
    gaps = []
    for previous, current in zip(rows, rows[1:]):
        if previous["sample_ts"] < start or current["sample_ts"] > end:
            continue
        seconds = current["sample_ts"] - previous["sample_ts"]
        recorded = (
            seconds <= MAX_RECORDED_INTERVAL_S
            and valid_reading(previous)
            and valid_reading(current)
        )
        if recorded:
            recorded_s += seconds
            if previous["sleep_state"] in (8, 15):
                sleep_s += seconds
            movement = movement_point(previous)["movement"]
            if movement is not None:
                movement_eligible_s += seconds
                if movement > 0:
                    movement_active_s += seconds
        elif seconds > 0:
            gaps.append({"start": previous["sample_ts"], "end": current["sample_ts"]})
    hr = sorted(row["heart_rate"] for row in worn)
    oxygen = sorted(
        row["oxygen_saturation"]
        for row in worn
        if 0 < (row["oxygen_saturation"] or 0) <= 100
    )
    temperatures = sorted(
        value
        for value in (temperature_point(row)["temp"] for row in worn)
        if value is not None
    )
    return {
        "start": start,
        "end": end,
        "interval_s": interval_s,
        "recorded_s": recorded_s,
        "gap_s": max(0, interval_s - recorded_s),
        "coverage": round(recorded_s / interval_s, 3) if interval_s else 1.0,
        "sleep_s": sleep_s,
        "hr_median": _pct(hr, 50),
        "oxygen_p5": _pct(oxygen, 5),
        "temp_median": _pct(temperatures, 50) if temperatures else None,
        "movement_eligible_s": movement_eligible_s,
        "movement_active_s": movement_active_s,
        "movement_active": (
            round(movement_active_s / movement_eligible_s, 3)
            if movement_eligible_s
            else None
        ),
        "samples": len(worn),
        "gaps": gaps,
    }


def position_shares(db, start, end):
    """Share of archived posture observations per night. Counts observations,
    not time, because the history cadence is not established."""
    counts = {"back": 0, "side": 0, "tummy": 0}
    names = {3: "back", 4: "side", 5: "tummy"}
    for point in position_points(db, start, end):
        name = names.get(point["position"])
        if name:
            counts[name] += 1
    total = sum(counts.values())
    return {
        "position_observations": total,
        **{
            f"position_{name}": round(count / total, 3) if total else None
            for name, count in counts.items()
        },
    }


async def nights(request):
    db = request.app["db"]
    value = request.query.get("days", "14")
    if value == "all":
        since = None
    else:
        try:
            days = int(value)
        except ValueError:
            return web.json_response({"ok": False, "reason": "bad days"}, status=400)
        if not 1 <= days <= 3650:
            return web.json_response({"ok": False, "reason": "bad days"}, status=400)
        current_night = dt.date.fromisoformat(night_key(dt.datetime.now().timestamp()))
        first_night = current_night - dt.timedelta(days=days - 1)
        since = night_bounds(first_night.isoformat())[0]

    out = []
    for key, all_rows in read_night_history(db, since):
        summary = summarize_night(all_rows)
        if not summary:
            continue
        window_start, window_end = night_bounds(key)
        out.append(
            {
                "night": key,
                "window_start": window_start,
                "window_end": window_end,
                "window_s": window_end - window_start,
                **{key: value for key, value in summary.items() if key != "gaps"},
                **position_shares(db, window_start, window_end),
            }
        )
    return web.json_response(
        {
            "timezone": NIGHT_TIMEZONE_NAME,
            "nights": sorted(out, key=lambda n: n["night"], reverse=True),
        }
    )


def read_night_history(db, since=None):
    """Yield one noon-to-noon group at a time without retaining all history."""
    connection = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    sql = """SELECT sample_ts, heart_rate, oxygen_saturation, sleep_state,
                    skin_temperature, movement, sock_off, charging, base_station_on
             FROM vitals"""
    args = ()
    if since is not None:
        sql += " WHERE sample_ts >= ?"
        args = (since,)
    sql += " ORDER BY sample_ts"
    try:
        current_key = None
        current_rows = []
        for raw in connection.execute(sql, args):
            row = dict(raw)
            key = night_key(row["sample_ts"])
            if current_key is not None and key != current_key:
                yield current_key, current_rows
                current_rows = []
            current_key = key
            current_rows.append(row)
        if current_key is not None:
            yield current_key, current_rows
    finally:
        connection.close()


async def night_detail(request):
    """One night's trace, for the single-night chart."""
    db = request.app["db"]
    key = request.query.get("night")
    if not key:
        return web.json_response({"ok": False, "reason": "night required"}, status=400)
    try:
        start, end = night_bounds(key)
    except (ValueError, OverflowError):
        return web.json_response({"ok": False, "reason": "bad date"}, status=400)

    try:
        bucket = int(request.query.get("bucket", 60))
    except ValueError:
        return web.json_response({"ok": False, "reason": "bad bucket"}, status=400)
    if bucket not in (5, 30, 60, 300):
        return web.json_response({"ok": False, "reason": "bad bucket"}, status=400)
    raw = q(
        db,
        """SELECT sample_ts, heart_rate, oxygen_saturation, sleep_state, skin_temperature,
                  movement, battery_percentage, sock_off, charging, base_station_on
        FROM vitals
        WHERE sample_ts >= ? AND sample_ts < ?
        ORDER BY sample_ts""",
        (start, end),
    )
    summary = summarize_night(raw)
    if not summary:
        return web.json_response(
            {"ok": False, "night": key, "timezone": NIGHT_TIMEZONE_NAME, "points": []}
        )
    groups = {}
    for row in raw:
        if valid_reading(row):
            groups.setdefault(row["sample_ts"] // bucket * bucket, []).append(row)
    points = []
    for timestamp, group in sorted(groups.items()):
        hrs = [row["heart_rate"] for row in group]
        oxygen = [
            row["oxygen_saturation"]
            for row in group
            if 0 < (row["oxygen_saturation"] or 0) <= 100
        ]
        points.append(
            {
                "t": timestamp,
                "display_t": dt.datetime.fromtimestamp(
                    timestamp, NIGHT_TIMEZONE
                ).strftime("%Y-%m-%dT%H:%M:%S"),
                "hr": round(sum(hrs) / len(hrs), 1),
                "ox": round(sum(oxygen) / len(oxygen), 1) if oxygen else None,
            }
        )
    sleep_points = [
        {"t": row["sample_ts"], "sleep": row["sleep_state"]}
        for row in raw
        if valid_reading(row)
    ]
    return web.json_response(
        {
            "ok": True,
            "night": key,
            "timezone": NIGHT_TIMEZONE_NAME,
            "bucket": bucket,
            "resolution": {
                5: "5-second bucket averages",
                30: "30-second bucket averages",
                60: "1-minute bucket averages",
                300: "5-minute bucket averages",
            }[bucket],
            "gap_after_s": max(MAX_RECORDED_INTERVAL_S, round(bucket * 1.5)),
            "sleep_resolution": "Reported observations",
            "sleep_gap_after_s": MAX_RECORDED_INTERVAL_S,
            "summary": {
                **{key: value for key, value in summary.items() if key != "gaps"},
                **position_shares(db, start, end),
            },
            "gaps": summary["gaps"],
            "points": points,
            "sleep_points": sleep_points,
            "temperature_points": [
                temperature_point(row)
                for row in raw
                if summary["start"] <= row["sample_ts"] <= summary["end"]
            ],
            "temperature_gap_after_s": MAX_RECORDED_INTERVAL_S,
            "temperature_resolution": "Stored observations · Celsius assumed",
            "temperature_unit_verified": False,
            "movement_points": [
                movement_point(row)
                for row in raw
                if summary["start"] <= row["sample_ts"] <= summary["end"]
            ],
            "movement_gap_after_s": MAX_RECORDED_INTERVAL_S,
            "position_points": position_points(db, start, end),
            "position_gap_after_s": MAX_RECORDED_INTERVAL_S,
            "position_source": "Owlet position history",
            "recording_context": recording_context(raw),
        }
    )


async def week(request):
    return web.FileResponse(
        os.path.join(HERE, "box", "week.html"), headers=PAGE_HEADERS
    )


async def trends(request):
    return web.FileResponse(
        os.path.join(HERE, "box", "trends.html"), headers=PAGE_HEADERS
    )


# Without Cache-Control the browser applies heuristic caching and can serve a
# stale page from memory without ever revalidating -- so a pushed UI change
# appears not to have landed. "no-cache" still allows 304s; it only forces the
# revalidation round-trip.
PAGE_HEADERS = {"Cache-Control": "no-cache"}


# Plotly injects its own <style> element, hence 'unsafe-inline' for styles only.
SECURITY_HEADERS = {
    "Content-Security-Policy": (
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; "
        "base-uri 'none'; form-action 'self'"
    ),
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Server": "owlet-recorder",
}
LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}


HOST_HEADER = re.compile(
    r"(?P<name>[a-z0-9.-]+|\[(?P<v6>[0-9a-f:.]+)\]|(?P<bare>[0-9a-f]*:[0-9a-f:.]+))"
    r"(?::\d{1,5})?"
)


def host_name(header):
    """'Example.ts.net:8443' -> 'example.ts.net'; '[::1]:8400' -> '::1'.
    Anything that is not a plain host, address or port gives ''."""
    match = HOST_HEADER.fullmatch(header.strip().lower())
    if not match:
        return ""
    return (match["v6"] or match["bare"] or match["name"]).rstrip(".")


@web.middleware
async def host_check(request, handler):
    # The app has no login; it relies on being reachable only from loopback or
    # a private network. A web page can still re-point its own domain at
    # 127.0.0.1 (DNS rebinding) and read the API as same-origin, so only
    # answer requests addressed to a name this install was told to expect.
    if host_name(request.headers.get("Host", "")) not in request.app["allowed_hosts"]:
        return web.Response(status=421, text="Misdirected request", headers=SECURITY_HEADERS)
    return await handler(request)


@web.middleware
async def cache_headers(request, handler):
    try:
        response = await handler(request)
    except web.HTTPException as error:
        error.headers.update(SECURITY_HEADERS)
        raise
    response.headers.update(SECURITY_HEADERS)
    if (
        request.path == "/"
        or request.path in ("/week", "/trends")
        or request.path.startswith("/static/")
    ):
        response.headers["Cache-Control"] = "no-cache"
    return response


# Only page assets directly inside box/ are served, never the deploy scripts,
# unit files or notices that share the folder in a checkout. Decided per
# request, so it works in a deployed layout that holds only the assets.
STATIC_NAME = re.compile(r"[a-z0-9][a-z0-9._-]*\.(?:html|js|css)")


async def static_asset(request):
    name = request.match_info["name"]
    path = os.path.join(HERE, "box", name)
    if not STATIC_NAME.fullmatch(name) or os.path.islink(path) or not os.path.isfile(path):
        raise web.HTTPNotFound()
    return web.FileResponse(path)


async def index(request):
    return web.FileResponse(
        os.path.join(HERE, "box", "live.html"), headers=PAGE_HEADERS
    )


def allowed_hosts(extra=()):
    names = set(LOOPBACK_HOSTS)
    configured = os.environ.get("OWLET_ALLOWED_HOSTS", "").split(",")
    names.update(host_name(name) for name in [*configured, *extra] if name.strip())
    return names


def create_app(db, extra_hosts=()):
    app = web.Application(middlewares=[host_check, cache_headers])
    app["db"] = db
    app["allowed_hosts"] = allowed_hosts(extra_hosts)
    with open(__file__, "rb") as source:
        app["web_revision"] = hashlib.sha256(source.read()).hexdigest()
    app.add_routes(
        [
            web.get("/", index),
            web.get("/week", week),
            web.get("/trends", trends),
            web.get("/api/nights", nights),
            web.get("/api/night", night_detail),
            web.get("/api/latest", latest),
            web.get("/api/series", series),
            web.get("/healthz", health),
            web.get("/static/{name}", static_asset),
        ]
    )
    return app


def main():
    global NIGHT_TIMEZONE_NAME, NIGHT_TIMEZONE
    p = argparse.ArgumentParser()
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8400)
    p.add_argument("--db", default=os.path.join(HERE, "data", "owlet.db"))
    p.add_argument("--timezone", default=NIGHT_TIMEZONE_NAME,
                   help="IANA zone that defines a night, e.g. America/New_York")
    p.add_argument("--allowed-host", action="append", default=[],
                   help="extra host name the dashboard is reached by, e.g. a "
                   "tailnet name; repeatable. Also OWLET_ALLOWED_HOSTS=a,b")
    a = p.parse_args()
    NIGHT_TIMEZONE_NAME, NIGHT_TIMEZONE = a.timezone, ZoneInfo(a.timezone)

    web.run_app(create_app(a.db, a.allowed_host), host=a.host, port=a.port,
                access_log=None)


if __name__ == "__main__":
    main()
