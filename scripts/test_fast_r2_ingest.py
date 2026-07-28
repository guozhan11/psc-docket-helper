from __future__ import annotations

import sys
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

import fast_r2_ingest as fast


class FastR2MigrationTests(unittest.TestCase):
    def test_v3_migration_restarts_each_shard_and_preserves_budget(self) -> None:
        state = fast.migrated_ingest_state(
            {
                "nextOffset": 99_999,
                "documentsIndexed": 1_595,
                "r2WritesThisMonth": 12_209,
                "failedFilingIds": [2474],
            },
            shard_index=2,
            shard_count=4,
        )

        self.assertEqual(state["version"], 3)
        self.assertEqual(state["nextOffset"], 125_000)
        self.assertEqual(state["documentsIndexed"], 1_595)
        self.assertEqual(state["r2WritesThisMonth"], 12_209)
        self.assertEqual(state["failedFilingIds"], [2474])
        self.assertEqual(state["failureAttempts"], {"2474": 1})

    def test_existing_document_requires_compact_format_to_skip(self) -> None:
        store = fast.FastR2Store.__new__(fast.FastR2Store)
        store.load_legacy_manifest = lambda _case: {}

        store.load_manifest = lambda _case: {
            7: {"r2_key": "filings/2020/7.html.gz", "term_filter_b64": "AA=="}
        }
        self.assertEqual(store.existing_document_status(["FC1"], 7), "legacy")

        store.load_manifest = lambda _case: {
            7: {
                "r2_key": "filings/2020/7.html.gz",
                "term_filter_b64": "AA==",
                "content_format": fast.CONTENT_FORMAT,
            }
        }
        self.assertEqual(store.existing_document_status(["FC1"], 7), "compact")

    def test_overwrite_accounts_only_for_net_storage_growth(self) -> None:
        writes: list[dict[str, object]] = []

        class FakeR2:
            def head_object(self, **_kwargs):
                return {"ContentLength": 5_000}

            def put_object(self, **kwargs) -> None:
                writes.append(kwargs)

        store = fast.FastR2Store.__new__(fast.FastR2Store)
        store.bucket = "test"
        store.r2 = FakeR2()
        store.lock = threading.Lock()
        store.shard_index = 0
        store.shard_count = 4
        store.monthly_writes = 0
        store.storage_bytes = 8_000

        previous_size = store.upload_html("filings/2020/7.html.gz", b"x" * 100)

        self.assertEqual(previous_size, 5_000)
        self.assertEqual(store.storage_bytes, 3_100)
        self.assertEqual(store.monthly_writes, 1)
        self.assertEqual(len(writes), 1)

    def test_save_state_tracks_retryable_and_unavailable_filings(self) -> None:
        writes: list[dict[str, object]] = []

        class FakeR2:
            def head_object(self, **_kwargs):
                raise RuntimeError("404")

            def put_object(self, **kwargs) -> None:
                writes.append(kwargs)

        store = fast.FastR2Store.__new__(fast.FastR2Store)
        store.bucket = "test"
        store.r2 = FakeR2()
        store.lock = threading.Lock()
        store.state_key = "state.json"
        store.shard_index = 0
        store.shard_count = 4
        store.monthly_writes = 0
        store.storage_bytes = 0
        store.state = {
            "failedFilingIds": [10, 11],
            "unavailableFilingIds": [],
        }

        exhausted = store.update_filing_failures(
            failures=[12],
            resolved=[10],
            unavailable=[11],
        )
        store.save_state(100)

        self.assertEqual(exhausted, [])
        self.assertEqual(store.state["failedFilingIds"], [12])
        self.assertEqual(store.state["failureAttempts"], {"12": 1})
        self.assertEqual(store.state["unavailableFilingIds"], [11])
        self.assertEqual(store.state["nextOffset"], 100)
        self.assertEqual(len(writes), 1)

    def test_retry_limit_moves_filing_to_unavailable(self) -> None:
        store = fast.FastR2Store.__new__(fast.FastR2Store)
        store.state = {
            "failedFilingIds": [12],
            "failureAttempts": {"12": fast.MAX_FILING_ATTEMPTS - 1},
            "unavailableFilingIds": [],
        }

        exhausted = store.update_filing_failures(failures=[12])

        self.assertEqual(exhausted, [12])
        self.assertEqual(store.state["failedFilingIds"], [])
        self.assertEqual(store.state["failureAttempts"], {})
        self.assertEqual(store.state["unavailableFilingIds"], [12])

    def test_legacy_pending_failure_starts_with_one_attempt(self) -> None:
        store = fast.FastR2Store.__new__(fast.FastR2Store)
        store.state = {
            "failedFilingIds": [12],
            "unavailableFilingIds": [],
        }

        exhausted = store.update_filing_failures(failures=[12])

        self.assertEqual(exhausted, [])
        self.assertEqual(store.state["failedFilingIds"], [12])
        self.assertEqual(store.state["failureAttempts"], {"12": 2})

    def test_incomplete_shard_cannot_report_success_without_scanning(self) -> None:
        class FakeStore:
            shard_index = 1
            shard_count = 4
            state = {"nextOffset": 62_500}

        arguments = [
            "fast_r2_ingest.py",
            "--all",
            "--shard-index",
            "1",
            "--shard-count",
            "4",
        ]
        with (
            patch.object(sys, "argv", arguments),
            patch.object(fast, "FastR2Store", return_value=FakeStore()),
            patch.object(fast, "official_filing_total", return_value=204_301),
            patch.object(fast, "iter_filings", return_value=iter(())),
        ):
            with self.assertRaisesRegex(RuntimeError, "returned no pages"):
                fast.main()


if __name__ == "__main__":
    unittest.main()
