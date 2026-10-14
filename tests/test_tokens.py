"""The token file must end up owner-only however it existed before."""
import importlib
import json
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def mode(path):
    return stat.S_IMODE(os.lstat(path).st_mode)


class TokenFileTest(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.path = Path(self.tempdir.name) / "owlet_tokens"
        os.environ["OWLET_TOKENS"] = str(self.path)
        import owlet_client

        self.client = importlib.reload(owlet_client)
        self.old_umask = os.umask(0o022)

    def tearDown(self):
        os.umask(self.old_umask)
        del os.environ["OWLET_TOKENS"]
        self.tempdir.cleanup()

    def test_new_file_is_owner_only(self):
        self.client.save_tokens({"refresh": "fake"})
        self.assertEqual(mode(self.path), 0o600)

    def test_existing_loose_file_is_not_inherited(self):
        for loose in (0o644, 0o666):
            with self.subTest(mode=oct(loose)):
                self.path.write_text("{}")
                os.chmod(self.path, loose)
                self.client.save_tokens({"refresh": "fake"})
                self.assertEqual(mode(self.path), 0o600)
                self.assertEqual(json.loads(self.path.read_text()), {"refresh": "fake"})

    def test_symlink_is_replaced_not_followed(self):
        target = Path(self.tempdir.name) / "elsewhere"
        target.write_text("untouched")
        self.path.symlink_to(target)
        self.client.save_tokens({"refresh": "fake"})
        self.assertEqual(target.read_text(), "untouched")
        self.assertFalse(self.path.is_symlink())
        self.assertEqual(mode(self.path), 0o600)

    def test_loading_a_loose_file_restricts_it(self):
        self.path.write_text(json.dumps({"refresh": "fake"}))
        os.chmod(self.path, 0o644)
        self.assertEqual(self.client.load_tokens(), {"refresh": "fake"})
        self.assertEqual(mode(self.path), 0o600)

    def test_no_temporary_files_are_left(self):
        self.client.save_tokens({"refresh": "fake"})
        self.assertEqual(os.listdir(self.tempdir.name), ["owlet_tokens"])



class ConnectTest(unittest.TestCase):
    """A saved login is only abandoned when Owlet rejects it, and a headless
    service never waits on a password prompt."""

    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        path = Path(self.tempdir.name) / "owlet_tokens"
        path.write_text(json.dumps({"region": "europe", "refresh": "fake"}))
        os.chmod(path, 0o600)
        os.environ["OWLET_TOKENS"] = str(path)
        import owlet_client

        self.client = importlib.reload(owlet_client)
        self.asked = []
        self.client.ask = lambda *a, **k: self.asked.append(a) or "x"

    def tearDown(self):
        del os.environ["OWLET_TOKENS"]
        self.tempdir.cleanup()

    def connect_with(self, error, can_prompt):
        import asyncio
        from unittest import mock

        api = mock.Mock()
        api.authenticate = mock.AsyncMock(side_effect=error)
        with mock.patch.object(self.client, "OwletAPI", return_value=api), \
                mock.patch.object(self.client, "can_prompt", return_value=can_prompt):
            return asyncio.run(self.client.connect())

    def test_network_error_propagates_without_prompting(self):
        import aiohttp

        with self.assertRaises(aiohttp.ClientConnectionError):
            self.connect_with(aiohttp.ClientConnectionError("blip"), can_prompt=True)
        self.assertEqual(self.asked, [])

    def test_rejected_login_without_a_terminal_exits_clearly(self):
        from pyowletapi.exceptions import OwletAuthenticationError

        with self.assertRaises(SystemExit) as raised:
            self.connect_with(OwletAuthenticationError("expired"), can_prompt=False)
        self.assertIn("probe.py", str(raised.exception))
        self.assertEqual(self.asked, [])

    def test_describe_omits_the_message(self):
        error = RuntimeError("https://ads-field.example/dsns/SERIAL123/properties token=abc")
        error.status = 401
        self.assertEqual(self.client.describe(error), "RuntimeError (HTTP 401)")


if __name__ == "__main__":
    unittest.main()
