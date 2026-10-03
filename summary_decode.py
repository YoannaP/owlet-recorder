#!/usr/bin/env python3
"""Decode Owlet's MONITORING_SUMMARY blobs.

Each blob covers a ~600s window. The first 4 bytes are a non-protobuf prefix;
the message starts at offset 4. Field meanings below were established by
comparing decoded values against our own 5-second recordings over four
overlapping windows -- heart-rate and SpO2 averages agreed within 1-3 units,
and field 23 reproduced the recorded per-minute sleep states exactly (modulo
one minute of bucket alignment).

Anything not listed is left undecoded on purpose rather than guessed at.
"""
import base64

FIELDS = {
    1:  "start",      # unix seconds, window start
    3:  "end",        # unix seconds, window end
    4:  "duration",   # seconds, nominally 600
    16: "hr_min", 17: "hr_max", 18: "hr_avg",
    19: "ox_min", 20: "ox_max", 21: "ox_avg",
    # 22 is NOT battery -- it read 94/89/86/96 against actual 81/80/88/87.
    # Unidentified, so not surfaced.
}
SLEEP_ARRAY = 23   # one value per minute; same codes as sleep_state


def _varint(b, i):
    v, sh = 0, 0
    while i < len(b):
        x = b[i]; i += 1
        v |= (x & 0x7f) << sh; sh += 7
        if not x & 0x80:
            break
    return v, i


def _fields(b):
    i = 0
    while i < len(b):
        key, i = _varint(b, i)
        fno, wt = key >> 3, key & 7
        if wt == 0:
            v, i = _varint(b, i); yield fno, 0, v
        elif wt == 2:
            ln, i = _varint(b, i)
            if i + ln > len(b):
                return
            yield fno, 2, b[i:i + ln]; i += ln
        elif wt == 5:
            i += 4
        elif wt == 1:
            i += 8
        else:
            return


def _packed(b):
    out, i = [], 0
    while i < len(b):
        v, i = _varint(b, i); out.append(v)
    return out


def decode(value_b64):
    """base64 blob -> dict of the fields we have verified."""
    raw = base64.b64decode(value_b64)
    out = {}
    for fno, wt, v in _fields(raw[4:]):
        if wt == 0 and fno in FIELDS:
            out[FIELDS[fno]] = v
        elif wt == 2 and fno == SLEEP_ARRAY:
            # one nested length-delimited field holding the packed array
            inner = list(_fields(v))
            if len(inner) == 1 and inner[0][1] == 2:
                out["sleep"] = _packed(inner[0][2])
    return out


if __name__ == "__main__":
    import sqlite3, os, datetime as dt
    db = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "owlet.db")
    c = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    for ws, raw in c.execute("SELECT window_start, raw FROM summaries "
                             "ORDER BY window_start LIMIT 5"):
        d = decode(raw)
        print(f"{dt.datetime.fromtimestamp(ws):%a %d %H:%M}  "
              f"HR {d.get('hr_min')}/{d.get('hr_avg')}/{d.get('hr_max')}  "
              f"SpO2 {d.get('ox_min')}/{d.get('ox_avg')}/{d.get('ox_max')}  "
              f"sleep {d.get('sleep')}")
