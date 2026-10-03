#!/usr/bin/env python3
"""Shared Owlet auth + connection handling.

Password is entered via getpass (or a native macOS dialog when there is no TTY)
and is never stored. Only the Ayla auth token and Firebase refresh token are
cached, to .owlet_tokens, mode 0600.
"""
import os
import sys
import json
import ssl
import getpass
import subprocess

import certifi
import aiohttp

from pyowletapi.api import OwletAPI
from pyowletapi.sock import Sock

HERE = os.path.dirname(os.path.abspath(__file__))
TOKENSTORE = os.path.join(HERE, ".owlet_tokens")

# Owlet runs two separate clouds. Accounts are not shared between them.
REGIONS = ("europe", "world")


def make_session():
    """aiohttp session using certifi's CA bundle.

    The python.org build of Python does not read the macOS keychain, so the
    default context has no root certificates and every TLS call fails.
    """
    ctx = ssl.create_default_context(cafile=certifi.where())
    return aiohttp.ClientSession(connector=aiohttp.TCPConnector(ssl=ctx))


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
    with open(TOKENSTORE) as f:
        return json.load(f)


def save_tokens(data):
    """Persist tokens with owner-only permissions."""
    fd = os.open(TOKENSTORE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(data, f, indent=2)


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
        except Exception as e:
            print(f"Cached credentials rejected ({e}); logging in again.", file=sys.stderr)

    user = ask("Owlet account email: ")
    password = ask("Owlet password: ", hidden=True)

    # Try both clouds -- the account only exists on one of them.
    last_error = None
    for region in REGIONS:
        api = OwletAPI(region=region, user=user, password=password, session=session)
        try:
            tokens = await api.authenticate()
        except Exception as e:
            last_error = e
            continue
        if tokens:
            save_tokens({"region": region, **tokens})
        return api, region

    raise SystemExit(f"Login failed on both regions: {last_error}")


async def get_socks(api):
    """Return a list of Sock objects for the account."""
    response = await api.get_devices()
    return [Sock(api, dev["device"]) for dev in response["response"]]
