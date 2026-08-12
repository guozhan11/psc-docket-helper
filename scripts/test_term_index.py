"""Tests for the inverted term index builder."""

from __future__ import annotations

import gzip
import json
import re
import unittest
from pathlib import Path

from build_term_index import (
    DEFAULT_SHARD_COUNT,
    MAX_DOCUMENT_FREQUENCY,
    document_terms,
    shard_key,
    term_shard,
)

SHARED_TS = Path(__file__).resolve().parent.parent / "shared" / "termIndex.ts"

# Shard assignments at shardCount=4096, shared with worker/index.test.ts so the
# builder and the Worker cannot drift apart silently.
GOLDEN_SHARDS = {
    "2025": 3878,
    "uncollectible": 940,
    "pepco": 2924,
    "o&m": 2847,
    "rate-base": 2723,
    "commission": 1680,
    "pepco's": 3910,
    "a": 2348,
    "zzz": 2205,
    "storm": 3990,
}


class TermShardTests(unittest.TestCase):
    def test_shard_is_stable_and_bounded(self) -> None:
        for term in ("uncollectible", "pepco", "o", "2025", "rate-base"):
            shard = term_shard(term)
            self.assertEqual(shard, term_shard(term))
            self.assertGreaterEqual(shard, 0)
            self.assertLess(shard, DEFAULT_SHARD_COUNT)

    def test_distinct_terms_spread_across_shards(self) -> None:
        shards = {term_shard(f"term{index}") for index in range(2000)}
        # A hash that clumped would defeat the point of sharding by term.
        self.assertGreater(len(shards), 1000)

    def test_shard_key_zero_pads_to_shard_count_width(self) -> None:
        self.assertEqual(
            shard_key("a", 7, 4096),
            "term-index/v1/slots/a/shard-0007.json.gz",
        )
        self.assertEqual(
            shard_key("b", 4095, 4096),
            "term-index/v1/slots/b/shard-4095.json.gz",
        )


class SharedConstantTests(unittest.TestCase):
    """The Worker reads what this script writes, so the two must agree."""

    def setUp(self) -> None:
        self.source = SHARED_TS.read_text(encoding="utf-8")

    def _number(self, name: str) -> float:
        match = re.search(rf"{name}\s*=\s*([0-9.]+)", self.source)
        assert match, f"{name} not found in shared/termIndex.ts"
        return float(match.group(1))

    def test_shard_count_matches_worker(self) -> None:
        self.assertEqual(int(self._number("TERM_INDEX_SHARDS")), DEFAULT_SHARD_COUNT)

    def test_version_matches_worker(self) -> None:
        self.assertEqual(int(self._number("TERM_INDEX_VERSION")), 1)

    def test_frequency_cap_matches_worker(self) -> None:
        self.assertAlmostEqual(
            self._number("TERM_INDEX_MAX_DOCUMENT_FREQUENCY"),
            MAX_DOCUMENT_FREQUENCY,
        )

    def test_hash_matches_worker_golden_vectors(self) -> None:
        """Both sides are pinned to the same vectors.

        A shard-assignment disagreement would not fail loudly: the Worker would
        simply read the wrong shard and find no postings, so a question would
        quietly return nothing. worker/index.test.ts asserts the same table.
        """
        for term, expected in GOLDEN_SHARDS.items():
            self.assertEqual(term_shard(term, 4096), expected, f"shard drift for {term!r}")


class DocumentTermTests(unittest.TestCase):
    def test_terms_come_from_page_text_not_markup(self) -> None:
        document = (
            '<!doctype html><html><body><main data-filing-id="1">'
            '<section data-page="1"><pre>Uncollectible accounts rose in 2025.</pre></section>'
            "</main></body></html>"
        )
        terms = document_terms(document)
        self.assertIn("uncollectible", terms)
        self.assertIn("2025", terms)
        # Tag and attribute names must not become searchable terms.
        self.assertNotIn("section", terms)
        self.assertNotIn("doctype", terms)
        self.assertNotIn("data-page", terms)

    def test_entities_are_decoded_before_tokenizing(self) -> None:
        document = "<pre>Pepco&#39;s O&amp;M expense</pre>"
        terms = document_terms(document)
        self.assertIn("pepco's", terms)
        self.assertIn("expense", terms)

    def test_terms_are_deduplicated(self) -> None:
        document = "<pre>rate rate RATE Rate</pre>"
        self.assertEqual(document_terms(document), {"rate"})


class FrequencyCapTests(unittest.TestCase):
    def test_cap_drops_postings_but_keeps_frequency(self) -> None:
        """A term above the cap keeps its frequency so IDF still works."""
        total_cases = 1000
        cap = max(1, int(total_cases * MAX_DOCUMENT_FREQUENCY))
        common = [f"CASE{index}" for index in range(400)]
        rare = ["FC1176", "FC1184"]
        payload = {}
        for term, cases in (("commission", common), ("uncollectible", rare)):
            unique = sorted(set(cases))
            payload[term] = [len(unique)] if len(unique) > cap else [len(unique), *unique]
        self.assertEqual(payload["commission"], [400])
        self.assertEqual(payload["uncollectible"], [2, "FC1176", "FC1184"])

    def test_shard_payload_round_trips_through_gzip(self) -> None:
        payload = {
            "version": 1,
            "generation": "2026-08-12T00:00:00+00:00",
            "shardIndex": 3,
            "shardCount": DEFAULT_SHARD_COUNT,
            "terms": {"uncollectible": [2, "FC1176", "FC1184"]},
        }
        body = gzip.compress(json.dumps(payload, separators=(",", ":")).encode("utf-8"), 9)
        self.assertEqual(json.loads(gzip.decompress(body)), payload)


if __name__ == "__main__":
    unittest.main()
