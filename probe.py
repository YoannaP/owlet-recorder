#!/usr/bin/env python3
"""One-shot connection test: log in, list devices, and dump a single reading.

Run this first. It confirms the account, region and sock version, and shows
exactly which fields your Dream Sock reports.
"""
import asyncio
import json
import sys

from owlet_client import connect, get_socks, make_session


async def main():
    async with make_session() as session:
        api, region = await connect(session)
        print(f"Authenticated. Region: {region}\n")

        socks = await get_socks(api)
        if not socks:
            print("No devices on this account.")
            return

        for sock in socks:
            print(f"  {sock.name}  dsn={sock.serial}  model={sock.model} "
                  f"oem={sock.oem_model}  fw={sock.sw_version}  "
                  f"link={sock.connection_status}")
        print()

        sock = socks[0]

        # The base station only streams vitals while an app is marked active.
        await api.activate(sock.serial)
        await asyncio.sleep(3)

        result = await sock.update_properties()
        print(f"Sock version: {sock.version}  (3 = REAL_TIME_VITALS / Dream Sock)")
        print(f"Revision: {sock.revision}\n")

        print("--- normalised properties ---")
        print(json.dumps(result["properties"], indent=2, default=str))

        if "--raw" in sys.argv:
            print("\n--- raw property names ---")
            for name in sorted(result["raw_properties"]):
                print(" ", name)

        await api.close()


asyncio.run(main())
