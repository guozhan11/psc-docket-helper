from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

import metadata_r2_ingest as metadata


class MetadataShardTests(unittest.TestCase):
    def test_shard_bounds_match_full_text_ranges(self) -> None:
        total = 204_191
        self.assertEqual(metadata.shard_bounds(total, 0, 4), (0, 62_500))
        self.assertEqual(metadata.shard_bounds(total, 1, 4), (62_500, 125_000))
        self.assertEqual(metadata.shard_bounds(total, 2, 4), (125_000, 187_500))
        self.assertEqual(metadata.shard_bounds(total, 3, 4), (187_500, total))

    def test_metadata_state_keys_are_independent(self) -> None:
        keys = {metadata.metadata_state_key(index, 4) for index in range(4)}
        self.assertEqual(len(keys), 4)
        self.assertIn("ingestion/metadata-coverage-v3-0-of-4.json", keys)
        self.assertIn("ingestion/metadata-coverage-v3-3-of-4.json", keys)

    def test_page_iterator_preserves_contiguous_offset_order(self) -> None:
        def filing(filing_id: int, *, archived: bool = False) -> dict[str, object]:
            return {
                "filingId": filing_id,
                "docketNumber": "FC1176",
                "attachment": f"{filing_id}.pdf",
                "attachmentId": filing_id,
                "isConfidential": False,
                "isArchived": archived,
            }

        def fake_fetch(offset: int):
            if offset == 0:
                return offset, [filing(1), filing(2, archived=True)]
            return offset, [filing(3)]

        with patch.object(metadata, "fetch_metadata_page", side_effect=fake_fetch):
            pages = list(metadata.public_pdf_metadata_pages(0, 200, page_concurrency=2))

        self.assertEqual([page_end for page_end, _ in pages], [100, 200])
        self.assertEqual(
            [[row[1]["filingId"] for row in rows] for _, rows in pages],
            [[1], [3]],
        )

    def test_checkpoint_flushes_manifests_before_publishing_cursor(self) -> None:
        events: list[tuple[str, object]] = []

        class FakeR2:
            def put_object(self, **kwargs) -> None:
                events.append(("status", json.loads(kwargs["Body"])))

        class FakeStore:
            shard_index = 1
            shard_count = 4
            bucket = "test-bucket"
            r2 = FakeR2()

            def flush_manifests(self) -> None:
                events.append(("flush", None))

            def save_state(self) -> None:
                events.append(("save-write-accounting", None))

        status = metadata.checkpoint_full_scan(
            FakeStore(),
            metadata.metadata_state_key(1, 4),
            {},
            total_records=204_191,
            shard_start=62_500,
            shard_end=125_000,
            next_offset=67_500,
            public_pdf_records=3_200,
            complete=False,
        )

        self.assertEqual([event[0] for event in events], [
            "flush",
            "save-write-accounting",
            "status",
        ])
        self.assertEqual(status["nextOffset"], 67_500)
        self.assertEqual(status["officialRecordsScanned"], 5_000)
        self.assertFalse(status["fullScanComplete"])

    def test_local_coordinator_launches_all_four_shards(self) -> None:
        commands: list[list[str]] = []

        class FakeProcess:
            def wait(self) -> int:
                return 0

        def fake_popen(command: list[str]) -> FakeProcess:
            commands.append(command)
            return FakeProcess()

        args = SimpleNamespace(
            mode="auto",
            since_days=3,
            shard_count=4,
            max_hours=1.0,
            checkpoint_records=5_000,
        )
        with patch.object(metadata.subprocess, "Popen", side_effect=fake_popen):
            metadata.run_all_shards(args)

        self.assertEqual(len(commands), 4)
        shard_indexes = [
            command[command.index("--shard-index") + 1]
            for command in commands
        ]
        self.assertEqual(shard_indexes, ["0", "1", "2", "3"])


if __name__ == "__main__":
    unittest.main()
