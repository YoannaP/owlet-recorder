#!/usr/bin/env python3
"""Shared Owlet auth + connection handling.

Password is entered via getpass (or a native macOS dialog when there is no TTY)
and is never stored. Only the Ayla auth token and Firebase refresh token are
cached, to .owlet_tokens (or $OWLET_TOKENS), mode 0600.
"""
import os
import sys
import json
import stat
import tempfile
import ssl
import getpass
import subprocess

import certifi
import aiohttp

from pyowletapi.api import OwletAPI
from pyowletapi.exceptions import OwletAuthenticationError, OwletCredentialsError
from pyowletapi.sock import Sock

HERE = os.path.dirname(os.path.abspath(__file__))
TOKENSTORE = os.environ.get("OWLET_TOKENS") or os.path.join(HERE, ".owlet_tokens")

# Owlet runs two separate clouds. Accounts are not shared between them.
REGIONS = ("europe", "world")


def make_session():
    """aiohttp session using certifi's CA bundle.

    The python.org build of Python does not read the macOS keychain, so the
    default context has no root certificates and every TLS call fails.
    """
    ctx = ssl.create_default_context(cafile=certifi.where())
    return aiohttp.ClientSession(connector=aiohttp.TCPConnector(ssl=ctx))


def describe(error):
    """Name an error for logs without its message, which can carry request
    URLs, device serials or headers."""
    status = getattr(error, "status", None)
    return type(error).__name__ + (f" (HTTP {status})" if status else "")


def can_prompt():
    return sys.stdin.isatty() or sys.platform == "darwin"


def ask(message, hidden=False):
    """Prompt the user. Uses the terminal if interactive, otherwise a native
    macOS dialog (so it works even when run without a TTY, e.g. via `!`)."""
    if sys.stdin.isatty():
        return getpass.getpass(message) if hidden else input(message).strip()
    msg = message.replace('"', '\\"')
    hidden_clause = "with hidden answer" if hidden else ""
    script = (
        f'display dialog "{msg}" default answer "" {hidden_clause} '
        f'buttons {{"Cancel", "OK"}} default button "OK" with title "Owlet Monitor"'
    )
    r = subprocess.run(["osascript", "-e", script], capture_output=True, text=True)
    if r.returncode != 0:
        raise SystemExit("Cancelled.")
    return r.stdout.split("text returned:")[-1].strip()


def load_tokens():
    if not os.path.exists(TOKENSTORE):
        return {}
    mode = os.stat(TOKENSTORE).st_mode
    if mode & (stat.S_IRWXG | stat.S_IRWXO):
        print(f"{TOKENSTORE} was readable by others; restricting it to you.",
              file=sys.stderr)
        os.chmod(TOKENSTORE, 0o600)
    with open(TOKENSTORE) as f:
        return json.load(f)


def save_tokens(data):
    """Replace the token file atomically, always owner-only.

    Writing a fresh file and renaming it over the old one means an existing
    file's looser permissions are never inherited, a symlink at the path is
    replaced rather than followed, and a crash cannot leave half a file.
    """
    directory = os.path.dirname(os.path.abspath(TOKENSTORE))
    fd, temporary = tempfile.mkstemp(prefix=".owlet_tokens.", dir=directory)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump(data, f, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temporary, TOKENSTORE)
    except BaseException:
        os.unlink(temporary)
        raise


async def connect(session=None):
    """Return (api, region). Reuses cached tokens; only prompts if they are gone."""
    cached = load_tokens()

    if cached.get("refresh"):
        api = OwletAPI(
            region=cached["region"],
            token=cached.get("api_token"),
            expiry=cached.get("expiry"),
            refresh=cached["refresh"],
            session=session,
        )
        try:
            tokens = await api.authenticate()
            if tokens:
                save_tokens({"region": cached["region"], **tokens})
            return api, cached["region"]
        except (OwletAuthenticationError, OwletCredentialsError) as e:
            # Only a rejected login prompts again. Network errors propagate, so
            # a service retries instead of asking for a password nobody sees.
            print(f"Saved Owlet login rejected ({describe(e)}).", file=sys.stderr)
            if not can_prompt():
                raise SystemExit(
                    "Owlet rejected the saved login and there is no terminal to "
                    "log in again. Run probe.py where you can type, then copy "
                    "the new tokens over (box/deploy.sh does this)."
                )

    if not can_prompt():
        raise SystemExit(
            "No saved Owlet login. Run probe.py where you can type to create one."
        )
    user = ask("Owlet account email: ")
    password = ask("Owlet password: ", hidden=True)

    # Try both clouds -- the account only exists on one of them.
    last_error = None
    for region in REGIONS:
        api = OwletAPI(region=region, user=user, password=password, session=session)
        try:
            tokens = await api.authenticate()
        except Exception as e:
            last_error = describe(e)
            continue
        if tokens:
            save_tokens({"region": region, **tokens})
        return api, region

    raise SystemExit(f"Login failed on both regions: {last_error}")


async def get_socks(api):
    """Return a list of Sock objects for the account."""
    response = await api.get_devices()
    return [Sock(api, dev["device"]) for dev in response["response"]]
