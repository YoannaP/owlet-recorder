import json
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request
from pathlib import Path

from sleep_fixture import create_fixture

ROOT = Path(__file__).resolve().parents[1]


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class SleepHttpTest(unittest.TestCase):
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
            self.fail(self.server.stderr.read().decode())

    def tearDown(self):
        self.server.terminate()
        self.server.wait(timeout=5)
        self.server.stderr.close()
        self.tempdir.cleanup()

    def get_json(self, path):
        with urllib.request.urlopen(f"http://127.0.0.1:{self.port}{path}") as response:
            return json.load(response)

    def test_live_returns_each_reported_sleep_observation(self):
        payload = self.get_json("/api/series?hours=1")
        self.assertEqual(payload["sleep_resolution"], "Reported observations")
        self.assertEqual(
            [point["sleep"] for point in payload["sleep_points"]],
            [1, None, 8, 42, 15, 0, 8, 15, 1],
        )
        self.assertGreater(
            payload["sleep_points"][6]["t"] - payload["sleep_points"][5]["t"],
            payload["sleep_gap_after_s"],
        )

    def test_night_keeps_mixed_transitions_unknown_and_gap(self):
        payload = self.get_json("/api/night?night=2026-09-13&bucket=60")
        self.assertEqual(payload["sleep_resolution"], "Reported observations")
        self.assertEqual(
            [point["sleep"] for point in payload["sleep_points"]],
            [1, None, 8, 42, 15, 0, 8, 15],
        )
        self.assertGreater(
            payload["sleep_points"][4]["t"] - payload["sleep_points"][3]["t"],
            payload["sleep_gap_after_s"],
        )


if __name__ == "__main__":
    unittest.main()
