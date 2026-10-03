import json
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request
from pathlib import Path

from night_fixture import create_fixture

ROOT = Path(__file__).resolve().parents[1]


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class NightHttpTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tempdir = tempfile.TemporaryDirectory()
        cls.db = Path(cls.tempdir.name) / "owlet.db"
        create_fixture(cls.db)
        cls.port = free_port()
        cls.server = subprocess.Popen(
            [sys.executable, "server.py", "--port", str(cls.port), "--db", str(cls.db),
             "--timezone", "Europe/London"],
            cwd=ROOT,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )
        for _ in range(50):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{cls.port}/week", timeout=0.2)
                break
            except Exception:
                time.sleep(0.05)
        else:
            cls.server.terminate()
            _, errors = cls.server.communicate(timeout=5)
            cls.tempdir.cleanup()
            raise AssertionError(errors.decode() or "Fixture service did not start")

    @classmethod
    def tearDownClass(cls):
        cls.server.terminate()
        cls.server.wait(timeout=5)
        cls.server.stderr.close()
        cls.tempdir.cleanup()

    def payload(self, path):
        with urllib.request.urlopen(f"http://127.0.0.1:{self.port}{path}") as response:
            return response, json.loads(response.read())

    def test_nights_use_london_noon_boundaries_and_latest_first(self):
        _, payload = self.payload("/api/nights?days=800")
        self.assertEqual(payload["timezone"], "Europe/London")
        self.assertEqual(payload["nights"][0]["night"], "2026-10-24")
        self.assertEqual(payload["nights"][0]["window_s"], 25 * 3600)

    def test_summary_excludes_gaps_and_invalid_intervals(self):
        _, payload = self.payload("/api/night?night=2026-09-13&bucket=300")
        summary = payload["summary"]
        self.assertEqual(summary["hr_median"], 132)
        self.assertEqual(summary["oxygen_p5"], 94)
        self.assertEqual(summary["interval_s"], 10 * 3600)
        self.assertEqual(summary["recorded_s"], 9 * 3600 + 18 * 60)
        self.assertEqual(summary["gap_s"], 42 * 60)
        self.assertEqual(summary["sleep_s"], 8 * 3600 + 18 * 60)
        self.assertEqual(payload["resolution"], "5-minute bucket averages")
        self.assertGreater(len(payload["gaps"]), 0)

    def test_median_and_fifth_percentile_use_linear_interpolation(self):
        _, payload = self.payload("/api/night?night=2026-09-11&bucket=60")
        self.assertEqual(payload["summary"]["hr_median"], 115.0)
        self.assertEqual(payload["summary"]["oxygen_p5"], 90.3)

    def test_detail_rejects_bad_bucket(self):
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.payload("/api/night?night=2026-09-13&bucket=oops")
        self.assertEqual(caught.exception.code, 400)
        caught.exception.close()

    def test_temperature_keeps_raw_values_and_explicit_invalid_gaps(self):
        _, payload = self.payload("/api/night?night=2026-09-13&bucket=300")
        self.assertFalse(payload["temperature_unit_verified"])
        self.assertEqual(payload["temperature_gap_after_s"], 60)
        points = payload["temperature_points"]
        self.assertEqual(len(points), 571)
        self.assertEqual(sum(point["temp"] is None for point in points), 10)
        self.assertEqual({point["temp"] for point in points}, {34, None})
        self.assertTrue(any(b["t"] - a["t"] > 60 for a, b in zip(points, points[1:])))

    def test_temperature_rejects_missing_flags_and_invalid_values(self):
        # Modify a separate historical fixture, leaving the other cases intact.
        with sqlite3.connect(self.db) as connection:
            first = connection.execute("SELECT MIN(sample_ts) FROM vitals").fetchone()[
                0
            ]
            for column, value in (
                ("skin_temperature", None),
                ("skin_temperature", 0),
                ("skin_temperature", -1),
                ("skin_temperature", 34.5),
                ("sock_off", None),
                ("charging", None),
                ("sock_off", 1),
            ):
                connection.execute(
                    "UPDATE vitals SET skin_temperature=34, sock_off=0, charging=0 WHERE sample_ts=?",
                    (first,),
                )
                connection.execute(
                    f"UPDATE vitals SET {column}=? WHERE sample_ts=?", (value, first)
                )
                connection.commit()
                _, payload = self.payload("/api/night?night=2020-01-01")
                if payload["ok"]:
                    self.assertTrue(
                        all(p["temp"] is None for p in payload["temperature_points"])
                    )
            connection.execute(
                "UPDATE vitals SET skin_temperature=34, sock_off=0, charging=0 WHERE sample_ts=?",
                (first,),
            )

    def test_movement_and_position_use_original_observations(self):
        _, payload = self.payload("/api/night?night=2026-09-13&bucket=300")
        self.assertEqual(len(payload["movement_points"]), 571)
        self.assertEqual(
            {p["movement"] for p in payload["movement_points"]}, {0, 1, None}
        )
        self.assertEqual(
            sum(p["movement"] is None for p in payload["movement_points"]), 10
        )
        self.assertEqual(
            [p["position"] for p in payload["position_points"]], [3, 3, 4, 5, 5, 1, 0]
        )
        self.assertEqual(payload["position_points"][-1]["position_code"], 99)
        self.assertEqual(payload["position_source"], "Owlet position history")

    def test_context_does_not_infer_states_across_gaps_or_transitions(self):
        _, payload = self.payload("/api/night?night=2026-09-13")
        context = payload["recording_context"]
        self.assertEqual(len(context), 7)
        self.assertEqual(
            [p["label"] for p in context],
            [
                "Readings recorded",
                "Nothing recorded",
                "Readings recorded",
                "State change between reports",
                "Charging reported",
                "State change between reports",
                "Readings recorded",
            ],
        )
        charging = context[4]
        self.assertEqual(charging["before"]["charging"], 2)
        self.assertEqual(charging["after"]["charging"], 2)
        self.assertEqual(charging["end"] - charging["start"], 9 * 60)
        self.assertEqual(context[1]["end"] - context[1]["start"], 31 * 60)


if __name__ == "__main__":
    unittest.main()
