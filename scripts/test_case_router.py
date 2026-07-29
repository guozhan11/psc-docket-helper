from __future__ import annotations

import base64
import gzip
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import build_case_router as router
from compact_search import create_term_filter


class CaseRouterTests(unittest.TestCase):
    def test_folded_filter_preserves_term_membership(self) -> None:
        source = create_term_filter("bad debt uncollectible accounts")
        folded = router.fold_term_filter(base64.b64encode(source).decode("ascii"))
        folded_bytes = folded.to_bytes(router.ROUTER_FILTER_BYTES, "little")

        # Use the same dependency-free implementation as the ingestion filter
        # and verify every original keyword remains a possible match.
        for term in ("bad", "debt", "uncollectible", "accounts"):
            query = create_term_filter(term, router.ROUTER_FILTER_BYTES)
            self.assertTrue(all(
                not byte or (folded_bytes[index] & byte) == byte
                for index, byte in enumerate(query)
            ))

    def test_case_entry_deduplicates_filings_and_prefers_content(self) -> None:
        encoded = base64.b64encode(create_term_filter("grid reliability")).decode("ascii")
        manifests = [
            {"documents": [{
                "filing_id": 7,
                "received_date": "2025-01-01",
                "metadata_only": True,
            }]},
            {"documents": [{
                "filing_id": 7,
                "received_date": "2025-01-01",
                "r2_key": "filings/2025/7.html.gz",
                "term_filter_b64": encoded,
            }, {
                "filing_id": 8,
                "received_date": "2026-01-01",
                "metadata_only": True,
            }]},
        ]

        result = router.case_router_entry("FC1176", manifests)

        self.assertIsNotNone(result)
        entry, term_filter = result or ([], b"")
        self.assertEqual(entry[:4], ["FC1176", 2, 1, "2026-01-01"])
        self.assertGreater(entry[4], 0)
        self.assertEqual(
            len(term_filter),
            router.ROUTER_FILTER_BYTES * router.ROUTER_FILTER_BANDS,
        )

    def test_case_entry_preserves_recurrence_across_filing_bands(self) -> None:
        encoded = base64.b64encode(create_term_filter("bad debt")).decode("ascii")
        manifests = [{"documents": [
            {
                "filing_id": filing_id,
                "received_date": "2026-01-01",
                "r2_key": f"filings/2026/{filing_id}.html.gz",
                "term_filter_b64": encoded,
            }
            for filing_id in (4, 5, 6)
        ]}]

        result = router.case_router_entry("FC1176", manifests)

        self.assertIsNotNone(result)
        _entry, filters = result or ([], b"")
        matching_bands = 0
        query = create_term_filter("debt", router.ROUTER_FILTER_BYTES)
        for band_index in range(router.ROUTER_FILTER_BANDS):
            start = band_index * router.ROUTER_FILTER_BYTES
            band = filters[start:start + router.ROUTER_FILTER_BYTES]
            if all(not byte or (band[index] & byte) == byte for index, byte in enumerate(query)):
                matching_bands += 1
        self.assertEqual(matching_bands, 3)

    def test_metadata_only_case_is_not_routable(self) -> None:
        result = router.case_router_entry("FC1", [{
            "documents": [{"filing_id": 1, "metadata_only": True}]
        }])
        self.assertIsNone(result)

    def test_build_router_publishes_parts_before_atomic_index_switch(self) -> None:
        encoded = base64.b64encode(create_term_filter("bad debt")).decode("ascii")
        manifest_key = "manifests-v2/FC1176/part-3-of-4.json.gz"
        manifest = {"documents": [{
            "filing_id": 7,
            "received_date": "2026-01-01",
            "r2_key": "filings/2026/7.html.gz",
            "term_filter_b64": encoded,
        }]}

        class Body:
            def __init__(self, value: bytes) -> None:
                self.value = value

            def read(self) -> bytes:
                return self.value

        class Paginator:
            def __init__(self, objects: dict[str, bytes]) -> None:
                self.objects = objects

            def paginate(self, **kwargs):
                prefix = kwargs.get("Prefix", "")
                yield {"Contents": [
                    {"Key": key, "Size": len(value)}
                    for key, value in sorted(self.objects.items())
                    if key.startswith(prefix)
                ]}

        class FakeR2:
            def __init__(self) -> None:
                self.objects = {
                    manifest_key: gzip.compress(json.dumps(manifest).encode("utf-8"))
                }
                self.writes: list[str] = []

            def get_paginator(self, _name: str) -> Paginator:
                return Paginator(self.objects)

            def get_object(self, **kwargs):
                key = kwargs["Key"]
                if key not in self.objects:
                    raise RuntimeError("NoSuchKey")
                return {"Body": Body(self.objects[key])}

            def put_object(self, **kwargs) -> None:
                self.writes.append(kwargs["Key"])
                self.objects[kwargs["Key"]] = kwargs["Body"]

        r2 = FakeR2()
        index = router.build_router(r2, "test", shard_count=4)

        self.assertEqual(index["contentCases"], 1)
        self.assertEqual(index["contentDocumentAssociations"], 1)
        self.assertEqual(index["filterBands"], router.ROUTER_FILTER_BANDS)
        self.assertEqual(index["activeSlot"], "a")
        self.assertEqual(len(index["partKeys"]), 4)
        self.assertEqual(r2.writes[-1], router.ROUTER_INDEX_KEY)
        populated_key = next(
            key for key in index["partKeys"]
            if json.loads(gzip.decompress(r2.objects[key]))["cases"]
        )
        populated_part = json.loads(gzip.decompress(r2.objects[populated_key]))
        self.assertEqual(populated_part["filterBands"], router.ROUTER_FILTER_BANDS)
        self.assertEqual(
            len(base64.b64decode(populated_part["filtersB64"])),
            router.ROUTER_FILTER_BYTES * router.ROUTER_FILTER_BANDS,
        )

        next_index = router.build_router(r2, "test", shard_count=4)
        self.assertEqual(next_index["activeSlot"], "b")
        self.assertEqual(r2.writes[-1], router.ROUTER_INDEX_KEY)


if __name__ == "__main__":
    unittest.main()
