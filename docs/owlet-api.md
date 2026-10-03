# Notes on Owlet's cloud API

What this project relies on, and how sure we are of each part. None of this is
documented by Owlet. It comes from `pyowletapi`, other public integrations,
static inspection of the Owlet Dream Android app (3.30 and 3.40), and
comparisons against our own recordings. Treat anything marked _unverified_
as a hypothesis.

Three levels of evidence are used below:

- **Mapped**: an unofficial integration names or types the field.
- **App**: Owlet's own Android app uses that name for the field.
- **Observed**: seen in recordings. This shows the field exists and what values
  appeared, not what it means.

## Data path

```
sock --Bluetooth--> base station --wifi--> Owlet cloud --HTTPS poll--> recorder
```

There is no local API on the sock or base station. Authentication is Firebase
-> Owlet mini-token -> Ayla, handled by `pyowletapi`. Accounts live in one of
two regions, `europe` or `world`, and hosts differ by region (`.eu` suffix).

The base station only uploads while an app is marked active. The recorder sets
the `APP_ACTIVE` property every 60 seconds, as the phone app does. Without it,
the cloud stops receiving fresh vitals unless the phone app is open.

## Real-time vitals

Version 3 socks publish one JSON object in the Ayla property
`REAL_TIME_VITALS`, not individual properties. Clients written before about
2021 read the older per-property model and record nothing.

The cloud keeps **no history** of it. `GET /apiv1/dsns/{dsn}/properties/
REAL_TIME_VITALS/datapoints.json` caps at 100 rows (about 8 minutes),
silently ignores `filter[created_at_begin]` and `filter[created_at_end]`, and
its `next_page` cursors return the same window forever.

| Key   | Column               | Meaning and confidence                                                                                                         |
| ----- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `hr`  | `heart_rate`         | Pulse, bpm. 0 when not reading.                                                                                                |
| `ox`  | `oxygen_saturation`  | SpO2, percent. 0 when not reading.                                                                                             |
| `oxta`| `oxygen_10_av`       | Owlet's own 10-minute SpO2 average. 255 is a sentinel.                                                                         |
| `ss`  | `sleep_state`        | 0 unknown, 1 awake, 8 light sleep, 15 deep sleep. Matches per-minute summary states.                                           |
| `mv`  | `movement`           | Mapped as movement. Unitless, observed 0–200. Zero occurs in valid readings, so it is not "missing".                           |
| `mvb` | `movement_bucket`    | Mapped. Quantised in steps of about 8.3 (0, 8, 16 … 100). Not interchangeable with `mv`.                                       |
| `st`  | `skin_temperature`   | **App** calls it `skinTemperature`, an integer passed through unchanged. Unit _unverified_; whole-degree Celsius is the community convention and fits observed values. 0 while charging and when absent. A positive value does not prove the sock is worn. |
| `bat` | `battery_percentage` | Battery, percent.                                                                                                              |
| `btt` | `battery_minutes`    | Mapped as remaining runtime in minutes. Accuracy unverified.                                                                   |
| `rsi` | `signal_strength`    | Mapped as signal. Not dBm as far as anyone has shown; shown raw.                                                               |
| `chg` | `charging`           | **Not a boolean.** Observed 0, 1 and 2. Test for nonzero, and prefer the server's derived `monitoring` flag.                   |
| `bso` | `base_station_on`    | 0 or 1.                                                                                                                        |
| `sc`  | `sock_connection`    | Observed 1 and 2. Enum unverified.                                                                                             |
| `srf` | `readings_flag`      | Observed 0–3. Enum unverified.                                                                                                 |
| `onm`, `sb` | `wellness_alert`, `brick_status` | Library names only. Constant in our recordings; do not treat as active warnings.                         |
| `mst` | `monitoring_start_time` | Unix seconds while monitoring, 0 while charging. Session rules unverified.                                                  |
| `aps`, `alrt` | `alert_paused_status`, `alerts_mask` | Status and a bitmask-like value. Layout unverified.                                                |
| `mrs` | (not stored)         | **App** names it `recoveryModeStatus` (Owlet's Recovery Mode feature). Numeric values unverified.                              |
| `bp`  | (not stored)         | Not in the app's real-time model. Uses the same code set as position history below and correlates with movement (`bp=1` almost always has positive `mv`). Probably body position, but _unverified_. |
| `ota`, `bsb`, `hw` | (not stored) | Mapped as update status, base battery status and hardware version.                                                 |

Raw payloads can be kept with the logger's default settings; `--no-raw` drops
them. Unmapped keys such as `bp` and `mrs` survive only in raw payloads.

## `MONITORING_SUMMARY`

The one source of history: about two days of 10-minute summaries, available
through the same `datapoints.json` endpoint (subject to the same 100-row cap).
Each value is base64 of a 4-byte prefix followed by protobuf.

```
1,2  window start (unix)     16,17,18  heart rate min, max, avg
3    window end              19,20,21  SpO2 min, max, avg
4,5  duration (600s)         23        per-minute sleep state (10 values)
```

Checked against 5-second recordings over overlapping windows: averages agreed
within 1–3 units, and field 23 matched recorded per-minute sleep states
exactly.

Not decoded:

- **Field 22** is not battery percentage.
- **Fields 26 and 27** are fixed-length arrays, probably histograms.
- **Fields 28–35** are scalars.
- **Field 36** is a ten-element nested array of codes 1–11. It agrees with the
  nearest raw `bp` about 85% of the time, so it is probably per-minute
  position.
- **Short blobs** (around 30 bytes, keys 1, 4, 7, 36) appear while the sock is
  on the charger. They carry no vitals.

`summary_decode.py` reads only the verified fields. Archive the raw blobs, so a
better decoder can reread them later.

## Sleep-position history

Owlet's app reads position history from a separate service, authenticated with
the Firebase ID token rather than Ayla.

```http
GET https://sleep-data{suffix}.owletdata.com/v1/accounts/{firebase_uid}/profiles/{profile_id}/sleep
    ?startTime={unix}&endTime={unix}&timeZone={IANA zone}
    &version={device type, e.g. smartSock4}&returnBodyPositions=true
Authorization: Bearer {firebase_id_token}
```

- `{suffix}` is `.eu` for the europe region and empty otherwise.
- `firebase_uid` is the `user_id` claim of the Firebase token.
- `profile_id` is the last path segment of `profiles[].name` from
  `GET https://accounts{suffix}.owletdata.com/v2/accounts/{uid}/profiles`.
  The profile response also contains the child's name, birthdate, gender and
  weight. This project reads only the ID and stores nothing else from it.
- `version` is the device type from
  `GET https://devices-public{suffix}.owletdata.com/v2/accounts/{uid}/devices`
  (`DEVICE_TYPE_SMARTSOCK4` -> `smartSock4`). It is not a numeric API version;
  `version=1` returns HTTP 400. Some hardware reporting `SS3-Sleep` is served
  as `smartSock4`.

The response's `data` object holds `bodyPositions` and `positionTimes`. Pair
them by index; each time is the Unix start of a one-minute window. Keep the
supplied timestamps rather than generating a grid, because ranges can contain
gaps. The app decodes the codes as follows:

| Code       | App enum     | Label      |
| ---------- | ------------ | ---------- |
| 0, 3       | `NO_DATA`    | No data    |
| 1          | `MOVING`     | Moving     |
| 2          | `UNDETECTED` | Undetected |
| 4, 5       | `ON_BACK`    | On back    |
| 6, 7, 8, 9 | `SIDE`       | Side       |
| 10, 11     | `TUMMY`      | Tummy      |

The app falls back to `TUMMY` for unknown codes. This project leaves an unknown
code unlabelled instead. `position_history.py` fetches this every 10 minutes
and stores the integer code alongside the request version.

## Things that look useful but are not available

- No respiratory rate, HRV, beat-to-beat intervals or PPG waveforms appear in
  the sock's real-time fields. `PPG_LOG_FILE` is a separate Ayla property and is
  not evidence that waveforms are available.
- Room temperature and humidity come from the Owlet camera, not the sock. The
  app's Celsius helpers belong to the camera, so they say nothing about `st`.

## Prior art

- [`ryanbdclark/pyowletapi`](https://github.com/ryanbdclark/pyowletapi) and its
  [Home Assistant integration](https://github.com/ryanbdclark/owlet)
- [`dcondomitti/owlet-dream`](https://github.com/dcondomitti/owlet-dream), which
  includes a reverse-engineered API description
- [`jlamendo/ha-sensor.owlet`](https://github.com/jlamendo/ha-sensor.owlet), for
  the older property model
