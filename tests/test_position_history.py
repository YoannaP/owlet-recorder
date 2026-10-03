import asyncio
import sqlite3
import unittest
from unittest.mock import patch

import position_history
from position_history import open_history_db, store_positions


class PositionArchiveTest(unittest.TestCase):
    def setUp(self):
        self.connection = open_history_db(":memory:")

    def tearDown(self):
        self.connection.close()

    def store(self, times, codes):
        return store_positions(
            self.connection,
            "fixture",
            "profile",
            "smartSock4",
            {"data": {"positionTimes": times, "bodyPositions": codes}},
            100,
            1000,
        )

    def test_archive_preserves_codes_and_refreshes_existing_timestamps(self):
        self.store([100, 160, 220], [4, 10, 99])
        self.store([160], [11])
        self.assertEqual(
            self.connection.execute(
                "SELECT sample_ts, code FROM position_history ORDER BY sample_ts"
            ).fetchall(),
            [(100, 4), (160, 11), (220, 99)],
        )

    def test_malformed_response_does_not_partially_store(self):
        for times, codes in [
            ([100, 160], [4]),
            ([100, 90], [4, 5]),
            ([100, 100], [4, 5]),
            ([100, 1000], [4, 5]),
            ([100], [None]),
            ([100.5], [4]),
        ]:
            with self.assertRaises(ValueError):
                self.store(times, codes)
        self.assertEqual(
            self.connection.execute("SELECT COUNT(*) FROM position_history").fetchone()[
                0
            ],
            0,
        )


class PositionWorkerTest(unittest.IsolatedAsyncioTestCase):
    async def test_slow_history_is_cancellable_without_waiting_for_the_network(self):
        started = asyncio.Event()

        async def slow(*args):
            started.set()
            await asyncio.Event().wait()

        with (
            patch.object(position_history, "fetch_history", slow),
            patch.object(position_history, "load_tokens", return_value={}),
        ):
            task = asyncio.create_task(
                position_history.record_history(
                    ":memory:",
                    "europe",
                    "fixture",
                    asyncio.Event(),
                    lambda message: None,
                )
            )
            await asyncio.wait_for(started.wait(), timeout=1)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await asyncio.wait_for(task, timeout=1)


if __name__ == "__main__":
    unittest.main()
