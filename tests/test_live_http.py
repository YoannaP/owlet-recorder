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

from live_fixture import create_fixture

ROOT = Path(__file__).resolve().parents[1]


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class LiveHttpTest(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db = Path(self.tempdir.name) / "owlet.db"
        create_fixture(self.db)
        self.port = free_port()
        self.server = subprocess.Popen(
            [
                sys.executable,
                "server.py",
                "--port",
                str(self.port),
                "--db",
                str(self.db),
                "--timezone",
                "Europe/London",
            ],
            cwd=ROOT,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )
        for _ in range(50):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{self.port}/", timeout=0.2)
                break
            except Exception:
                time.sleep(0.05)
        else:
            self.server.terminate()
            _, errors = self.server.communicate(timeout=5)
            self.tempdir.cleanup()
            self.fail(errors.decode() or "Fixture service did not start")

    def tearDown(self):
        self.server.terminate()
        self.server.wait(timeout=5)
        self.server.stderr.close()
        self.tempdir.cleanup()

    def get(self, path):
        response = urllib.request.urlopen(f"http://127.0.0.1:{self.port}{path}")
        return response, response.read()

    def test_live_assets_and_real_series_are_served(self):
        page, body = self.get("/")
        self.assertEqual(page.headers["Cache-Control"], "no-cache")
        self.assertIn(b"/static/live.css", body)
        self.assertIn(b"/static/chart.js", body)
        self.assertIn(b"/static/live.js", body)
        self.assertNotIn(b"Sample data", body)
        asset, _ = self.get("/static/live.js")
        self.assertEqual(asset.headers["Cache-Control"], "no-cache")

        response, body = self.get("/api/series?hours=3")
        payload = json.loads(body)
        self.assertEqual(response.status, 200)
        self.assertEqual(payload["bucket"], 5)
        self.assertEqual(payload["resolution"], "5-second bucket averages")
        self.assertGreater(len(payload["rows"]), 100)

        _, body = self.get("/healthz")
        self.assertEqual(len(json.loads(body)["web_revision"]), 64)

    def test_non_boolean_charging_is_not_a_reading(self):
        self.server.terminate()
        self.server.wait(timeout=5)
        self.server.stderr.close()
        self.db.unlink()
        create_fixture(self.db, "charging")
        self.server = subprocess.Popen(
            [
                sys.executable,
                "server.py",
                "--port",
                str(self.port),
                "--db",
                str(self.db),
                "--timezone",
                "Europe/London",
            ],
            cwd=ROOT,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )
        for _ in range(50):
            try:
                _, body = self.get("/api/latest")
                break
            except Exception:
                time.sleep(0.05)
        payload = json.loads(body)
        self.assertFalse(payload["monitoring"])
        self.assertEqual(payload["not_monitoring_reason"], "charging")
        self.assertIsNone(payload["temp"])
        self.assertIsNone(payload["eligible_movement"])

    def test_original_observations_and_independent_position_timestamps(self):
        _, body = self.get("/api/latest")
        latest = json.loads(body)
        self.assertEqual(latest["temp"], 34)
        self.assertEqual(latest["eligible_movement"], 0)
        _, body = self.get("/api/series?hours=12")
        data = json.loads(body)
        self.assertEqual(
            data["movement_points"][-1], {"t": latest["sample_ts"], "movement": 0}
        )
        self.assertEqual({p["temp"] for p in data["temperature_points"]}, {34})
        self.assertEqual([p["position"] for p in data["position_points"]], [3, 5, 0])
        self.assertEqual(data["position_points"][-1]["t"], latest["sample_ts"] - 600)
        self.assertIn(
            "Nothing recorded", [p["label"] for p in data["recording_context"]]
        )
        with sqlite3.connect(self.db) as connection:
            connection.execute(
                "UPDATE vitals SET charging=NULL WHERE sample_ts=?",
                (latest["sample_ts"],),
            )
        _, body = self.get("/api/latest")
        invalid = json.loads(body)
        self.assertIsNone(invalid["temp"])
        self.assertIsNone(invalid["eligible_movement"])
        _, body = self.get("/api/series?hours=12")
        invalid_series = json.loads(body)
        self.assertIsNone(invalid_series["temperature_points"][-1]["temp"])
        self.assertIsNone(invalid_series["movement_points"][-1]["movement"])


if __name__ == "__main__":
    unittest.main()
