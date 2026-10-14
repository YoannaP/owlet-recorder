"""demo_data.py must never replace a database holding real recordings."""
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from live_fixture import create_fixture

ROOT = Path(__file__).resolve().parents[1]


def demo(path, *flags):
    return subprocess.run(
        [sys.executable, "scripts/demo_data.py", str(path), "--nights", "1", *flags],
        cwd=ROOT, capture_output=True, text=True,
    )


class DemoDataTest(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.path = Path(self.tempdir.name) / "demo.db"

    def tearDown(self):
        self.tempdir.cleanup()

    def count(self, sql):
        with sqlite3.connect(self.path) as connection:
            return connection.execute(sql).fetchone()[0]

    def test_new_file_is_written(self):
        self.assertEqual(demo(self.path).returncode, 0)
        self.assertGreater(self.count("SELECT COUNT(*) FROM vitals"), 0)

    def test_existing_demo_needs_overwrite(self):
        demo(self.path)
        refused = demo(self.path)
        self.assertNotEqual(refused.returncode, 0)
        self.assertIn("--overwrite", refused.stderr)
        replaced = demo(self.path, "--overwrite")
        self.assertEqual(replaced.returncode, 0, replaced.stderr)

    def test_real_vitals_are_never_replaced(self):
        create_fixture(self.path)  # dsn "fixture" stands in for a real device
        before = self.count("SELECT COUNT(*) FROM vitals")
        refused = demo(self.path, "--overwrite")
        self.assertNotEqual(refused.returncode, 0)
        self.assertIn("did not write", refused.stderr)
        self.assertEqual(self.count("SELECT COUNT(*) FROM vitals"), before)

    def test_real_position_rows_are_never_replaced(self):
        demo(self.path)
        with sqlite3.connect(self.path) as connection:
            connection.execute(
                "INSERT INTO position_history VALUES ('REALSERIAL', 'p', 1, 4, 'v', 1)")
        refused = demo(self.path, "--overwrite")
        self.assertNotEqual(refused.returncode, 0)
        self.assertIn("did not write", refused.stderr)

    def test_logger_shaped_database_is_never_replaced(self):
        with sqlite3.connect(self.path) as connection:
            connection.execute("CREATE TABLE summaries (x)")
        self.assertNotEqual(demo(self.path, "--overwrite").returncode, 0)
        self.assertEqual(self.count("SELECT COUNT(*) FROM sqlite_master WHERE name='summaries'"), 1)


if __name__ == "__main__":
    unittest.main()
