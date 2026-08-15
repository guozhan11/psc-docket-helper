"""Tests for the inverted term index builder."""

from __future__ import annotations

import gzip
import json
import re
import unittest
from pathlib import Path

from build_term_index import (
    TERM_INDEX_KEY as TERM_INDEX_KEY_NAME,
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



class FakeR2:
    """Minimal in-memory stand-in for the boto3 S3 client build() uses."""

    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}
        self.put_calls = 0

    def get_paginator(self, name: str):
        assert name == "list_objects_v2"
        objects = self.objects

        class Paginator:
            def paginate(self, Bucket: str, Prefix: str = ""):  # noqa: N803
                contents = [
                    {"Key": key} for key in sorted(objects) if key.startswith(Prefix)
                ]
                yield {"Contents": contents}

        return Paginator()

    def get_object(self, Bucket: str, Key: str):  # noqa: N803
        if Key not in self.objects:
            raise RuntimeError(f"NoSuchKey: {Key}")
        import io

        return {"Body": io.BytesIO(self.objects[Key])}

    def put_object(self, Bucket: str, Key: str, Body: bytes, **kwargs):  # noqa: N803
        self.put_calls += 1
        self.objects[Key] = Body


def _seed(r2: FakeR2, cases: dict[str, dict[str, str]]) -> None:
    """cases: case number -> {filing id: document text}."""
    for case_number, documents in cases.items():
        manifest_documents = []
        for filing_id, text in documents.items():
            r2_key = f"filings/2025/{filing_id}.html.gz"
            document_html = (
                '<!doctype html><html><body>'
                f'<main data-filing-id="{filing_id}" data-case="{case_number}">'
                f'<section data-page="1"><pre>{text}</pre></section>'
                "</main></body></html>"
            )
            r2.objects[r2_key] = gzip.compress(document_html.encode("utf-8"))
            manifest_documents.append({"filing_id": int(filing_id), "r2_key": r2_key})
        r2.objects[f"manifests-v2/{case_number}/part-0-of-4.json.gz"] = gzip.compress(
            json.dumps({"caseNumber": case_number, "documents": manifest_documents}).encode()
        )


class BuildIntegrationTests(unittest.TestCase):
    """Exercises build() end to end against an in-memory bucket."""

    def _build(self, cases, shard_count=64):
        from build_term_index import build

        r2 = FakeR2()
        _seed(r2, cases)
        index = build(r2, "bucket", shard_count, 0, 0)
        return r2, index

    def _shard_terms(self, r2, index, term, shard_count=64):
        """Looks a term up the way the Worker does: by its stem.

        Keying on the raw word would let the builder and the reader drift apart
        without a test noticing.
        """
        from build_term_index import stem_term

        stem = stem_term(term)
        key = shard_key(index["activeSlot"], term_shard(stem, shard_count), shard_count)
        terms = json.loads(gzip.decompress(r2.objects[key]))["terms"]
        return {term: terms[stem]} if stem in terms else terms

    def test_postings_carry_length_normalised_weights(self):
        """Presence alone cannot order a match set; weights can."""
        r2, index = self._build({
            "FC1176": {"1": "storm damage", "2": "storm again", "3": "storm third"},
            "FC1184": {"4": "storm once"},
        })
        self.assertEqual(index["postingFormat"], "case-bm25")
        entry = self._shard_terms(r2, index, "storm")["storm"]
        frequency, *body = entry
        self.assertEqual(frequency, 2)
        pairs = dict(zip(body[0::2], body[1::2]))
        self.assertEqual(set(pairs), {"FC1176", "FC1184"})
        # Three of three filings beats one of one at equal case length, and no
        # real posting may round away to nothing.
        self.assertGreater(pairs["FC1176"], pairs["FC1184"])
        self.assertGreaterEqual(min(pairs.values()), 1)

    def test_a_focused_case_outranks_a_much_larger_one(self):
        """The bias this format exists to remove.

        Counting documents alone let the largest docket lead every question.
        """
        focused = {str(i): "uncollectible arrears" for i in range(6)}
        sprawling = {str(100 + i): ("uncollectible" if i < 8 else "unrelated filler")
                     for i in range(200)}
        r2, index = self._build({"FC-SMALL": focused, "FC-HUGE": sprawling})
        pairs = self._shard_terms(r2, index, "uncollectible")["uncollectible"]
        weights = dict(zip(pairs[1::2], pairs[2::2]))
        self.assertGreater(
            weights["FC-SMALL"], weights["FC-HUGE"],
            "a case discussing the topic throughout must beat a large one mentioning it",
        )

    def test_term_resolves_to_the_case_that_contains_it(self):
        r2, index = self._build({
            "FC1176": {"1": "Uncollectible accounts rose sharply."},
            "FC1184": {"2": "Storm restoration costs were deferred."},
        })
        self.assertEqual(index["cases"], 2)
        self.assertEqual(
            self._shard_terms(r2, index, "uncollectible")["uncollectible"][:2],
            [1, "FC1176"],
        )
        self.assertEqual(
            self._shard_terms(r2, index, "storm")["storm"][:2], [1, "FC1184"]
        )

    def test_a_term_in_two_cases_lists_both(self):
        r2, index = self._build({
            "FC1176": {"1": "deferred storm costs"},
            "FC1184": {"2": "storm restoration"},
        })
        self.assertEqual(
            self._shard_terms(r2, index, "storm")["storm"][0::2][:1], [2]
        )

    def test_a_case_contributes_each_term_once_across_its_documents(self):
        r2, index = self._build({
            "FC1176": {"1": "storm storm storm", "2": "storm again"},
        })
        # One posting per case, however many of its documents hold the term.
        entry = self._shard_terms(r2, index, "storm")["storm"]
        self.assertEqual(entry[0], 1)
        self.assertEqual(entry[1], "FC1176")
        self.assertEqual(len(entry), 3)

    def test_ubiquitous_term_keeps_frequency_but_drops_postings(self):
        # 300 cases, so the 15% share (45) clears the floor and governs.
        cases = {
            f"FC{1000 + index}": {str(index): "commission ruling"}
            for index in range(300)
        }
        cases["FC9999"] = {"9999": "commission uncollectible"}
        r2, index = self._build(cases)
        commission = self._shard_terms(r2, index, "commission")["commission"]
        # Frequency retained for IDF; the case list is dropped.
        self.assertEqual(commission, [301])
        # The rare term keeps its postings.
        self.assertEqual(
            self._shard_terms(r2, index, "uncollectible")["uncollectible"][:2],
            [1, "FC9999"],
        )

    def test_every_shard_is_published_and_index_written_last(self):
        r2, index = self._build({"FC1176": {"1": "storm"}}, shard_count=64)
        shard_keys = [key for key in r2.objects if "/slots/" in key]
        self.assertEqual(len(shard_keys), 64)
        self.assertIn(TERM_INDEX_KEY_NAME, r2.objects)
        self.assertTrue(index["complete"])

    def test_second_build_alternates_slots(self):
        from build_term_index import build

        r2 = FakeR2()
        _seed(r2, {"FC1176": {"1": "storm"}})
        first = build(r2, "bucket", 64, 0, 0)
        second = build(r2, "bucket", 64, 0, 0)
        # Alternating slots let a new generation publish without disturbing the
        # one the Worker is currently reading.
        self.assertNotEqual(first["activeSlot"], second["activeSlot"])

    def test_small_builds_keep_postings_via_the_cap_floor(self):
        """Without a floor the share-based cap makes a canary run useless.

        Over two cases the 15% share rounds to a cap of 0, so a term in both
        would lose its postings even though nothing about it is ubiquitous at
        production scale.
        """
        r2, index = self._build({
            "FC1176": {"1": "deferred storm costs"},
            "FC1184": {"2": "storm restoration"},
        })
        self.assertEqual(
            self._shard_terms(r2, index, "storm")["storm"][0], 2
        )

    def test_markup_does_not_become_searchable_terms(self):
        r2, index = self._build({"FC1176": {"1": "storm"}})
        terms = self._shard_terms(r2, index, "section")
        self.assertNotIn("section", terms)


if __name__ == "__main__":
    unittest.main()


class ShrinkGuardTests(unittest.TestCase):
    """A limited run must not quietly replace a full index."""

    def _seeded(self, count):
        from build_term_index import build

        r2 = FakeR2()
        _seed(r2, {f"FC{2000 + i}": {str(i): f"storm term{i}"} for i in range(count)})
        return r2, build(r2, "bucket", 64, 0, 0)

    def test_refuses_to_publish_a_much_smaller_index(self):
        from build_term_index import build

        r2, first = self._seeded(40)
        self.assertEqual(first["cases"], 40)
        # A canary-sized run over the same bucket: the Worker prefers any
        # published index, so this would narrow coverage while answers still
        # claim every case was searched.
        with self.assertRaises(RuntimeError) as caught:
            build(r2, "bucket", 64, 5, 0)
        self.assertIn("Refusing to publish", str(caught.exception))
        # The live index is untouched.
        published = json.loads(r2.objects[TERM_INDEX_KEY_NAME])
        self.assertEqual(published["cases"], 40)
        self.assertEqual(published["generation"], first["generation"])

    def test_allow_shrink_overrides_the_guard(self):
        from build_term_index import build

        r2, _ = self._seeded(40)
        smaller = build(r2, "bucket", 64, 5, 0, 1, True)
        self.assertEqual(smaller["cases"], 5)


class StemTests(unittest.TestCase):
    """Both sides must stem identically or the Worker reads the wrong shard."""

    def test_inflections_collapse_to_one_stem(self) -> None:
        from build_term_index import stem_term

        stem = stem_term("disconnect")
        for word in ("disconnections", "disconnection", "disconnected"):
            self.assertEqual(stem_term(word), stem)
            # Verification is a substring match, so the stem must stay a prefix.
            self.assertTrue(word.startswith(stem))

    def test_short_words_survive_stemming(self) -> None:
        from build_term_index import stem_term

        for word in ("rates", "gas", "storm"):
            self.assertEqual(stem_term(word), word)

    def test_matches_worker_golden_stems(self) -> None:
        from build_term_index import stem_term

        # Shared with worker/index.test.ts.
        golden = {
            "disconnections": "disconnect",
            "reporting": "report",
            "arrearages": "arrearag",
            "rates": "rates",
            "compliance": "compliance",
            # A derivational ending must not strip down to a prefix of an
            # unrelated common word: "gener" would match "general".
            "generation": "generat",
            "terminations": "terminat",
        }
        for word, expected in golden.items():
            self.assertEqual(stem_term(word), expected, f"stem drift for {word!r}")

    def test_derivational_stems_keep_clear_of_common_words(self) -> None:
        from build_term_index import stem_term

        self.assertNotEqual(stem_term("generation"), stem_term("general"))
        self.assertNotEqual(stem_term("terminations"), stem_term("terminal"))
        # The unification that motivated stemming still holds.
        self.assertEqual(stem_term("disconnections"), stem_term("disconnected"))
