"""Regression checks for the v1 security review (DNS rebinding, request limits,
static scope and response headers), against the real HTTP service."""
import http.client
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

from live_fixture import create_fixture

ROOT = Path(__file__).resolve().parents[1]
ROUTES = ["/", "/week", "/trends", "/api/latest", "/api/series?hours=3",
          "/api/nights", "/api/night?night=2026-01-01", "/healthz",
          "/static/live.js"]


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class SecurityHttpTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tempdir = tempfile.TemporaryDirectory()
        cls.db = Path(cls.tempdir.name) / "owlet.db"
        create_fixture(cls.db)
        cls.port = free_port()
        cls.server = subprocess.Popen(
            [sys.executable, "server.py", "--port", str(cls.port), "--db", str(cls.db),
             "--allowed-host", "box.example.ts.net"],
            cwd=ROOT,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )
        for _ in range(50):
            try:
                cls.request("/healthz")
                break
            except OSError:
                time.sleep(0.1)

    @classmethod
    def tearDownClass(cls):
        cls.server.terminate()
        cls.server.wait(timeout=5)
        cls.server.stderr.close()
        cls.tempdir.cleanup()

    @classmethod
    def request(cls, path, host=None):
        connection = http.client.HTTPConnection("127.0.0.1", cls.port, timeout=5)
        headers = {"Host": host} if host else {}
        connection.request("GET", path, headers=headers)
        response = connection.getresponse()
        body = response.read()
        connection.close()
        return response.status, dict(response.getheaders()), body

    def test_foreign_host_is_refused_on_every_route(self):
        for path in ROUTES:
            with self.subTest(path=path):
                status, _, body = self.request(path, host=f"rebind.attacker.example:{self.port}")
                self.assertEqual(status, 421)
                self.assertNotIn(b"heart_rate", body)

    def test_expected_hosts_are_served(self):
        for host in (f"127.0.0.1:{self.port}", f"localhost:{self.port}",
                     f"[::1]:{self.port}", "Box.Example.ts.net:8443"):
            with self.subTest(host=host):
                status, _, _ = self.request("/api/latest", host=host)
                self.assertEqual(status, 200)

    def test_series_range_is_bounded(self):
        for hours in ("nan", "inf", "-inf", "1e308", "abc", "1e6", "0", "-1", "49"):
            with self.subTest(hours=hours):
                status, _, _ = self.request(f"/api/series?hours={hours}")
                self.assertEqual(status, 400)
        self.assertEqual(self.request("/api/series?hours=48")[0], 200)

    def test_out_of_range_night_is_a_bad_request(self):
        self.assertEqual(self.request("/api/night?night=9999-12-31")[0], 400)

    def test_only_manifest_assets_are_static(self):
        for path in ("/static/deploy.sh", "/static/owlet-web.service",
                     "/static/ui-assets.sh", "/static/../server.py",
                     "/static/%2e%2e/server.py", "/.owlet_tokens"):
            with self.subTest(path=path):
                self.assertEqual(self.request(path)[0], 404)
        self.assertEqual(self.request("/static/plotly.min.js")[0], 200)

    def test_malformed_host_is_refused(self):
        for host in ("127.0.0.1:80@evil", "localhost evil", "evil:1:2", "[::1"):
            with self.subTest(host=host):
                self.assertEqual(self.request("/api/latest", host=host)[0], 421)

    def test_security_headers(self):
        for path in ("/", "/api/latest", "/static/missing.js"):
            with self.subTest(path=path):
                _, headers, _ = self.request(path)
                self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
                self.assertEqual(headers["Server"], "owlet-recorder")
        _, headers, _ = self.request("/")
        self.assertIn("frame-ancestors 'none'", headers["Content-Security-Policy"])
        self.assertIn("script-src 'self'", headers["Content-Security-Policy"])



class DeployedLayoutTest(unittest.TestCase):
    """deploy.sh ships server.py and only the manifest assets in box/; the
    server must start and serve from exactly that layout."""

    def test_server_runs_from_the_deployed_layout(self):
        assets = subprocess.run(
            ["bash", "-c", 'source box/ui-assets.sh; printf "%s\\n" "${UI_ASSETS[@]}"'],
            cwd=ROOT, check=True, capture_output=True, text=True,
        ).stdout.split()
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)
            (target / "box").mkdir()
            shutil.copy(ROOT / "server.py", target)
            for name in assets:
                shutil.copy(ROOT / "box" / name, target / "box")
            create_fixture(target / "owlet.db")
            port = free_port()
            server = subprocess.Popen(
                [sys.executable, "server.py", "--port", str(port), "--db", "owlet.db"],
                cwd=target, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
            )
            try:
                statuses = {}
                for _ in range(50):
                    try:
                        for path in ("/", "/static/live.js", "/static/plotly.min.js",
                                     "/api/latest"):
                            connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
                            connection.request("GET", path)
                            statuses[path] = connection.getresponse().status
                            connection.close()
                        break
                    except OSError:
                        time.sleep(0.1)
                self.assertEqual(set(statuses.values()), {200}, statuses)
            finally:
                server.terminate()
                server.wait(timeout=5)
                server.stderr.close()


if __name__ == "__main__":
    unittest.main()
