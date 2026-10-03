import json
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

from trends_fixture import create_fixture

ROOT = Path(__file__).resolve().parents[1]


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class TrendsHttpTest(unittest.TestCase):
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
                urllib.request.urlopen(
                    f"http://127.0.0.1:{cls.port}/trends", timeout=0.2
                )
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

    def test_period_returns_complete_nights_latest_first(self):
        _, payload = self.payload("/api/nights?days=7")
        self.assertEqual(payload["timezone"], "Europe/London")
        self.assertEqual(len(payload["nights"]), 3)
        self.assertGreater(payload["nights"][0]["night"], payload["nights"][1]["night"])
        self.assertEqual(payload["nights"][-1]["hr_median"], 101)
        self.assertEqual(payload["nights"][-1]["recorded_s"], 2 * 3600)

    def test_nights_carry_movement_temperature_and_position_statistics(self):
        _, payload = self.payload("/api/nights?days=7")
        newest, older = payload["nights"][0], payload["nights"][1]
        self.assertEqual(newest["movement_eligible_s"], 120 * 60)
        self.assertEqual(newest["movement_active_s"], 60 * 60)
        self.assertEqual(newest["movement_active"], 0.5)
        self.assertEqual(newest["temp_median"], 34)
        self.assertEqual(newest["position_observations"], 4)
        self.assertEqual(newest["position_back"], 0.5)
        self.assertEqual(newest["position_side"], 0.25)
        self.assertEqual(newest["position_tummy"], 0.25)
        self.assertEqual(older["movement_active"], 1.0)
        self.assertEqual(older["temp_median"], 34)
        self.assertEqual(older["position_observations"], 0)
        self.assertIsNone(older["position_back"])
        _, detail = self.payload(f"/api/night?night={newest['night']}")
        self.assertEqual(detail["summary"]["movement_active"], 0.5)
        self.assertEqual(detail["summary"]["position_back"], 0.5)

    def test_all_returns_available_history(self):
        _, payload = self.payload("/api/nights?days=all")
        self.assertEqual(len(payload["nights"]), 5)
        self.assertTrue(all("temp_median" in night for night in payload["nights"]))

    def test_period_validation_is_bounded(self):
        for value in ("0", "-1", "oops", "3651"):
            with self.assertRaises(urllib.error.HTTPError) as caught:
                self.payload(f"/api/nights?days={value}")
            self.assertEqual(caught.exception.code, 400)
            caught.exception.close()


if __name__ == "__main__":
    unittest.main()
