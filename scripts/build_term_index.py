#!/usr/bin/env python3
"""Build a term-partitioned inverted index over case filing text.

The case router stores case -> terms, so answering "which cases contain these
terms?" costs O(cases) and forced the Worker to sample one partition. This index
stores term -> cases, so the same question costs O(terms) and can cover the whole
corpus.

Mirrors shared/termIndex.ts. scripts/test_term_index.py checks that both sides
agree on shard assignment and on the frequency cap.

Memory: the corpus holds roughly 30-40M (term, case) postings, far more than a
runner can hold as Python objects. Postings are streamed to intermediate bucket
files first, then each bucket is loaded on its own to write its shards.
"""

from __future__ import annotations

import argparse
import gzip
import html
import json
import os
import re
import shutil
import tempfile
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

import boto3
from botocore.config import Config as BotoConfig

TERM_INDEX_VERSION = 1
DEFAULT_SHARD_COUNT = 4096
INTERMEDIATE_BUCKETS = 64
TERM_INDEX_KEY = f"term-index/v{TERM_INDEX_VERSION}/index.json"
MAX_DOCUMENT_FREQUENCY = 0.15
# A share is meaningless on a small corpus: over 200 cases the cap would be 30,
# so ordinary terms would lose their postings and a canary run would not
# resemble production. Against the real corpus the share is ~6,000 and this
# floor never binds.
MIN_DOCUMENT_FREQUENCY_CAP = 32
# Postings interleave each case with the number of its documents holding the
# term. Readers that predate this fall back to treating every posting as one.
POSTING_FORMAT = "case-bm25"
# BM25 term weighting. Counting documents alone rewards size on its own: the
# 2,084-filing Exelon/Pepco merger docket led most cross-case questions because
# any word appears somewhere in a case that large. Dividing by case length lets
# a mid-sized case that discusses a topic throughout outrank it.
BM25_K1 = 1.2
BM25_B = 0.75
# Weights are stored as integers so the wire format stays plain numbers.
BM25_WEIGHT_SCALE = 100
MAX_COMPRESSED_SHARD_BYTES = 8 * 1024 * 1024
STATE_KEY = f"term-index/v{TERM_INDEX_VERSION}/build-state.json"

MANIFEST_KEY_PATTERN = re.compile(
    r"^manifests-v2/([A-Z][A-Z0-9-]{2,30})/part-\d+-of-\d+\.json\.gz$"
)
TOKEN_PATTERN = re.compile(r"[a-z0-9][a-z0-9'-]{1,39}")
# Must match stemTerm() in shared/termIndex.ts. The stem is always a prefix of
# the word it came from, which is what lets the Worker verify excerpts with a
# plain substring match instead of needing morphology at read time.
MIN_STEM_LENGTH = 5
# Derivational endings remove more letters than plural or tense endings, so they
# need more left over to stay meaningful. Stripping "-ation" at the inflectional
# threshold turned "generation" into "gener", which substring-matches "general"
# — a word on nearly every page of a legal filing.
MIN_DERIVED_STEM_LENGTH = 7
INFLECTIONAL_SUFFIXES = ("ing", "ed", "es", "s")
DERIVATIONAL_SUFFIXES = ("ations", "ation", "ions", "ion")
TAG_PATTERN = re.compile(r"<[^>]*>")


def require_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


def term_shard(term: str, shard_count: int = DEFAULT_SHARD_COUNT) -> int:
    """FNV-1a. Must match termShard() in shared/termIndex.ts."""
    value = 0x811C9DC5
    for character in term:
        value = ((value ^ ord(character)) * 0x01000193) & 0xFFFFFFFF
    return value % shard_count


def shard_key(slot: str, shard_index: int, shard_count: int) -> str:
    width = len(str(shard_count - 1))
    return (
        f"term-index/v{TERM_INDEX_VERSION}/slots/{slot}/"
        f"shard-{str(shard_index).zfill(width)}.json.gz"
    )


def stem_term(term: str) -> str:
    """Prefix-preserving stem. Must match stemTerm() in shared/termIndex.ts."""
    word = term.lower()
    if len(word) <= MIN_STEM_LENGTH:
        return word
    # A possessive is not a plural: stripping its "s" leaves a dangling
    # apostrophe rather than a word.
    if word.endswith("'s"):
        return word
    for suffix in DERIVATIONAL_SUFFIXES:
        if not word.endswith(suffix):
            continue
        stem = word[: len(word) - len(suffix)]
        if len(stem) >= MIN_DERIVED_STEM_LENGTH:
            return stem
    for suffix in INFLECTIONAL_SUFFIXES:
        if not word.endswith(suffix):
            continue
        stem = word[: len(word) - len(suffix)]
        if len(stem) >= MIN_STEM_LENGTH:
            return stem
    return word


def document_terms(document_html: str) -> set[str]:
    """Distinct stems in stored page HTML, tokenized as the filters are.

    Indexing the stem is what lets a question about "disconnections" reach a
    filing that only ever wrote "disconnection".
    """
    text = html.unescape(TAG_PATTERN.sub(" ", document_html))
    return {stem_term(token) for token in TOKEN_PATTERN.findall(text.lower())}


def manifest_keys_by_case(r2: Any, bucket: str) -> dict[str, list[str]]:
    grouped: dict[str, list[str]] = defaultdict(list)
    paginator = r2.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=bucket, Prefix="manifests-v2/"):
        for item in page.get("Contents") or []:
            key = str(item.get("Key") or "")
            match = MANIFEST_KEY_PATTERN.fullmatch(key)
            if match:
                grouped[match.group(1)].append(key)
    return grouped


def load_gzip_json(r2: Any, bucket: str, key: str) -> Any:
    response = r2.get_object(Bucket=bucket, Key=key)
    return json.loads(gzip.decompress(response["Body"].read()))


def bm25_weight(
    documents_with_term: int,
    case_documents: int,
    average_documents: float,
    k1: float = BM25_K1,
    b: float = BM25_B,
) -> float:
    """BM25 term-frequency component, normalised by case length."""
    if documents_with_term <= 0:
        return 0.0
    length_ratio = case_documents / average_documents if average_documents > 0 else 1.0
    denominator = documents_with_term + k1 * (1 - b + b * length_ratio)
    if denominator <= 0:
        return 0.0
    return (documents_with_term * (k1 + 1)) / denominator


def case_terms(r2: Any, bucket: str, manifest_keys: Iterable[str]) -> tuple[Counter[str], int]:
    """Terms in one case, counted by how many of its documents contain each.

    Presence alone cannot rank within a match set: IDF is a per-term constant,
    so every case holding the same terms scores identically. The document count
    is what separates a case that discusses a topic throughout from one that
    mentions it once.
    """
    seen_r2_keys: set[str] = set()
    for manifest_key in manifest_keys:
        try:
            manifest = load_gzip_json(r2, bucket, manifest_key)
        except Exception:
            continue
        for document in manifest.get("documents") or []:
            r2_key = document.get("r2_key")
            if isinstance(r2_key, str) and r2_key:
                seen_r2_keys.add(r2_key)

    counts: Counter[str] = Counter()
    documents_read = 0
    for r2_key in sorted(seen_r2_keys):
        try:
            response = r2.get_object(Bucket=bucket, Key=r2_key)
            raw = response["Body"].read()
            document_html = gzip.decompress(raw).decode("utf-8", "replace")
        except Exception:
            continue
        documents_read += 1
        counts.update(document_terms(document_html))
    return counts, documents_read


def write_postings(
    r2: Any,
    bucket: str,
    grouped: dict[str, list[str]],
    work_dir: Path,
    shard_count: int,
    progress_every: int,
    concurrency: int = 1,
) -> tuple[int, int, dict[str, int]]:
    """Stream (term, case) postings into intermediate bucket files.

    A full pass makes roughly 200,000 R2 round trips. Serially that runs past
    GitHub's six-hour job limit, so cases are fetched by a thread pool while
    writing stays on this thread — the file handles are not thread-safe.
    Batching bounds how many case term-sets are held at once.
    """
    handles = [
        (work_dir / f"bucket-{index:03d}.txt").open("w", encoding="utf-8")
        for index in range(INTERMEDIATE_BUCKETS)
    ]
    cases_written = 0
    postings = 0
    # Case sizes drive BM25 length normalisation at publish time. One integer
    # per case is small enough to hold for the whole corpus.
    case_documents: dict[str, int] = {}
    ordered = sorted(grouped)
    batch_size = max(1, concurrency * 8)
    try:
        with ThreadPoolExecutor(max_workers=max(1, concurrency)) as pool:
            for start in range(0, len(ordered), batch_size):
                batch = ordered[start:start + batch_size]
                results = pool.map(
                    lambda case_number: (
                        case_number,
                        *case_terms(r2, bucket, sorted(grouped[case_number])),
                    ),
                    batch,
                )
                for case_number, terms, documents_read in results:
                    if not terms:
                        continue
                    cases_written += 1
                    case_documents[case_number] = documents_read
                    for term, documents_with_term in terms.items():
                        shard = term_shard(term, shard_count)
                        handles[shard % INTERMEDIATE_BUCKETS].write(
                            f"{shard}\t{term}\t{case_number}\t{documents_with_term}\n"
                        )
                        postings += 1
                scanned = min(start + batch_size, len(ordered))
                if progress_every and scanned % progress_every < batch_size:
                    print(
                        f"  scanned {scanned:,}/{len(ordered):,} cases; "
                        f"{postings:,} postings so far",
                        flush=True,
                    )
    finally:
        for handle in handles:
            handle.close()
    return cases_written, postings, case_documents


def publish_shards(
    r2: Any,
    bucket: str,
    work_dir: Path,
    shard_count: int,
    total_cases: int,
    slot: str,
    generation: str,
    case_documents: dict[str, int],
) -> tuple[int, int, int]:
    """Aggregate each intermediate bucket and upload its shards."""
    frequency_cap = max(MIN_DOCUMENT_FREQUENCY_CAP, int(total_cases * MAX_DOCUMENT_FREQUENCY))
    average_documents = (
        sum(case_documents.values()) / len(case_documents) if case_documents else 1.0
    )
    total_terms = 0
    kept_postings = 0
    compressed_bytes = 0

    for bucket_index in range(INTERMEDIATE_BUCKETS):
        path = work_dir / f"bucket-{bucket_index:03d}.txt"
        by_shard: dict[int, dict[str, dict[str, int]]] = defaultdict(lambda: defaultdict(dict))
        if path.exists():
            with path.open("r", encoding="utf-8") as handle:
                for line in handle:
                    parts = line.rstrip("\n").split("\t")
                    if len(parts) != 4:
                        continue
                    shard_text, term, case_number, count_text = parts
                    if not term or not case_number:
                        continue
                    try:
                        count = int(count_text)
                    except ValueError:
                        continue
                    by_shard[int(shard_text)][term][case_number] = count

        for shard_index in range(bucket_index, shard_count, INTERMEDIATE_BUCKETS):
            terms_payload: dict[str, list[Any]] = {}
            for term, case_counts in by_shard.get(shard_index, {}).items():
                frequency = len(case_counts)
                total_terms += 1
                if frequency > frequency_cap:
                    # Keep the frequency so IDF still works, drop the postings:
                    # a term this common cannot separate one case from another.
                    terms_payload[term] = [frequency]
                    continue
                interleaved: list[Any] = [frequency]
                for case_number in sorted(case_counts):
                    weight = bm25_weight(
                        case_counts[case_number],
                        case_documents.get(case_number, 1),
                        average_documents,
                    )
                    interleaved.append(case_number)
                    # At least 1: a real posting must never round away to zero.
                    interleaved.append(max(1, round(weight * BM25_WEIGHT_SCALE)))
                terms_payload[term] = interleaved
                kept_postings += frequency

            payload = {
                "version": TERM_INDEX_VERSION,
                "generation": generation,
                "shardIndex": shard_index,
                "shardCount": shard_count,
                "postingFormat": POSTING_FORMAT,
                "terms": terms_payload,
            }
            body = gzip.compress(
                json.dumps(payload, separators=(",", ":")).encode("utf-8"),
                compresslevel=9,
            )
            if len(body) > MAX_COMPRESSED_SHARD_BYTES:
                raise RuntimeError(
                    f"Term shard exceeds 8 MiB: {shard_index} ({len(body)} bytes)"
                )
            r2.put_object(
                Bucket=bucket,
                Key=shard_key(slot, shard_index, shard_count),
                Body=body,
                ContentType="application/json",
                ContentEncoding="gzip",
                CacheControl="private, max-age=300",
            )
            compressed_bytes += len(body)

        by_shard.clear()
        path.unlink(missing_ok=True)
        print(f"  published bucket {bucket_index + 1}/{INTERMEDIATE_BUCKETS}", flush=True)

    return total_terms, kept_postings, compressed_bytes


def load_previous_index(r2: Any, bucket: str) -> dict[str, Any] | None:
    try:
        response = r2.get_object(Bucket=bucket, Key=TERM_INDEX_KEY)
        return json.loads(response["Body"].read())
    except Exception as error:
        if any(token in str(error) for token in ("NoSuchKey", "404", "Not Found")):
            return None
        raise


def build(
    r2: Any,
    bucket: str,
    shard_count: int,
    limit: int,
    progress_every: int,
    concurrency: int = 1,
    allow_shrink: bool = False,
) -> dict[str, Any]:
    grouped = manifest_keys_by_case(r2, bucket)
    if not grouped:
        raise RuntimeError("No v2 case manifests were found in R2")
    if limit:
        grouped = {key: grouped[key] for key in sorted(grouped)[:limit]}

    generation = datetime.now(timezone.utc).isoformat()
    previous = load_previous_index(r2, bucket)
    slot = "b" if previous and previous.get("activeSlot") == "a" else "a"

    work_dir = Path(tempfile.mkdtemp(prefix="term-index-"))
    try:
        print(f"Scanning {len(grouped):,} cases...", flush=True)
        cases_written, postings, case_documents = write_postings(
            r2, bucket, grouped, work_dir, shard_count, progress_every, concurrency
        )
        print(f"Publishing {shard_count} shards to slot {slot}...", flush=True)
        total_terms, kept_postings, compressed_bytes = publish_shards(
            r2, bucket, work_dir, shard_count, cases_written, slot, generation, case_documents
        )
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)

    # The Worker prefers any published index over the case router, so replacing
    # a full index with a limited one silently narrows cross-case coverage while
    # answers still claim every case was searched. Refuse rather than publish it.
    if previous and not allow_shrink:
        previous_cases = int(previous.get("cases") or 0)
        if previous_cases and cases_written < previous_cases * 0.5:
            raise RuntimeError(
                f"Refusing to publish {cases_written:,} cases over an existing "
                f"index of {previous_cases:,}. Re-run without --limit, or pass "
                "--allow-shrink if the corpus really did shrink."
            )

    index = {
        "version": TERM_INDEX_VERSION,
        "generation": generation,
        "updatedAt": generation,
        "complete": True,
        "activeSlot": slot,
        "shardCount": shard_count,
        "cases": cases_written,
        "terms": total_terms,
        "postings": kept_postings,
        "scannedPostings": postings,
        "compressedBytes": compressed_bytes,
        "postingFormat": POSTING_FORMAT,
        "shardKeyPrefix": f"term-index/v{TERM_INDEX_VERSION}/slots/{slot}/",
    }
    # The index object is written last, so readers only ever see a complete
    # generation. Switching it swaps slots atomically.
    r2.put_object(
        Bucket=bucket,
        Key=TERM_INDEX_KEY,
        Body=json.dumps(index, indent=2).encode("utf-8"),
        ContentType="application/json",
        CacheControl="no-store",
    )
    return index


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--shard-count", type=int, default=DEFAULT_SHARD_COUNT)
    parser.add_argument("--limit", type=int, default=0, help="Only index the first N cases")
    parser.add_argument("--progress-every", type=int, default=250)
    parser.add_argument("--concurrency", type=int, default=8, help="Parallel R2 readers")
    parser.add_argument(
        "--allow-shrink",
        action="store_true",
        help="Publish even if the new index covers far fewer cases than the current one",
    )
    args = parser.parse_args()
    if not 64 <= args.shard_count <= 16384:
        raise RuntimeError("--shard-count must be between 64 and 16384")

    account_id = require_env("CLOUDFLARE_ACCOUNT_ID")
    endpoint = os.environ.get("R2_ENDPOINT") or f"https://{account_id}.r2.cloudflarestorage.com"
    bucket = require_env("R2_BUCKET_NAME")
    r2 = boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=require_env("R2_ACCESS_KEY_ID"),
        aws_secret_access_key=require_env("R2_SECRET_ACCESS_KEY"),
        region_name="auto",
        # R2 issues transient InternalErrors; the boto3 default of four
        # attempts is not enough for a pass this long.
        config=BotoConfig(retries={"max_attempts": 10, "mode": "adaptive"}),
    )
    index = build(
        r2,
        bucket,
        args.shard_count,
        args.limit,
        args.progress_every,
        args.concurrency,
        args.allow_shrink,
    )
    print(
        "Term index complete: "
        f"{index['cases']:,} cases; {index['terms']:,} terms; "
        f"{index['postings']:,} stored postings of {index['scannedPostings']:,} scanned; "
        f"{index['shardCount']} shards; "
        f"{index['compressedBytes'] / 1024 / 1024:.1f} MiB compressed.",
        flush=True,
    )


if __name__ == "__main__":
    main()
