#!/usr/bin/env python3
"""Build a compact, sharded all-case router from R2 filing manifests."""

from __future__ import annotations

import argparse
import base64
import gzip
import json
import os
import re
import zlib
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any, Iterable

import boto3

from compact_search import TERM_FILTER_BYTES

ROUTER_VERSION = 2
ROUTER_FILTER_BYTES = 256
ROUTER_FILTER_BANDS = 4
DEFAULT_ROUTER_SHARDS = 16
ROUTER_INDEX_KEY = f"case-router/v{ROUTER_VERSION}/index.json"
MAX_COMPRESSED_PART_BYTES = 8 * 1024 * 1024
MANIFEST_KEY_PATTERN = re.compile(
    r"^manifests-v2/([A-Z][A-Z0-9-]{2,30})/part-\d+-of-\d+\.json\.gz$"
)


def require_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


def fold_term_filter(encoded: str, byte_length: int = ROUTER_FILTER_BYTES) -> int:
    """Fold a document Bloom filter without changing its hash semantics."""
    raw = base64.b64decode(encoded, validate=True)
    if len(raw) != TERM_FILTER_BYTES or TERM_FILTER_BYTES % byte_length:
        raise ValueError(f"Unexpected term filter size: {len(raw)}")
    folded = 0
    for offset in range(0, len(raw), byte_length):
        folded |= int.from_bytes(raw[offset:offset + byte_length], "little")
    return folded


def case_router_entry(
    case_number: str,
    manifests: Iterable[dict[str, Any]],
    byte_length: int = ROUTER_FILTER_BYTES,
) -> tuple[list[Any], bytes] | None:
    documents: dict[int, dict[str, Any]] = {}
    for manifest in manifests:
        for document in manifest.get("documents") or []:
            try:
                filing_id = int(document["filing_id"])
            except (KeyError, TypeError, ValueError):
                continue
            existing = documents.get(filing_id)
            if not existing or (not existing.get("term_filter_b64") and document.get("term_filter_b64")):
                documents[filing_id] = document

    filter_bands = [0] * ROUTER_FILTER_BANDS
    content_documents = 0
    latest_received_date: str | None = None
    for filing_id, document in documents.items():
        received_date = document.get("received_date")
        if isinstance(received_date, str) and (
            latest_received_date is None or received_date > latest_received_date
        ):
            latest_received_date = received_date
        encoded = document.get("term_filter_b64")
        if not isinstance(encoded, str) or not document.get("r2_key"):
            continue
        try:
            # Keep independent filing groups so terms that recur across several
            # documents rank above one-off Bloom-filter false positives.
            filter_bands[filing_id % ROUTER_FILTER_BANDS] |= fold_term_filter(
                encoded,
                byte_length,
            )
            content_documents += 1
        except (ValueError, TypeError):
            continue

    if content_documents == 0:
        return None
    return (
        [
            case_number,
            len(documents),
            content_documents,
            latest_received_date,
            sum(term_filter.bit_count() for term_filter in filter_bands),
        ],
        b"".join(term_filter.to_bytes(byte_length, "little") for term_filter in filter_bands),
    )


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


def load_manifest(r2: Any, bucket: str, key: str) -> dict[str, Any]:
    response = r2.get_object(Bucket=bucket, Key=key)
    raw = response["Body"].read()
    return json.loads(gzip.decompress(raw))


def load_previous_index(r2: Any, bucket: str) -> dict[str, Any] | None:
    try:
        response = r2.get_object(Bucket=bucket, Key=ROUTER_INDEX_KEY)
        return json.loads(response["Body"].read())
    except Exception as error:
        if "NoSuchKey" in str(error) or "404" in str(error) or "Not Found" in str(error):
            return None
        raise


def build_router(r2: Any, bucket: str, shard_count: int) -> dict[str, Any]:
    grouped = manifest_keys_by_case(r2, bucket)
    if not grouped:
        raise RuntimeError("No v2 case manifests were found in R2")

    partitions: list[list[list[Any]]] = [[] for _ in range(shard_count)]
    partition_filters = [bytearray() for _ in range(shard_count)]
    document_total = 0
    content_document_total = 0
    manifest_total = 0
    content_cases = 0

    for case_number in sorted(grouped):
        keys = sorted(grouped[case_number])
        manifests = [load_manifest(r2, bucket, key) for key in keys]
        manifest_total += len(keys)
        result = case_router_entry(case_number, manifests)
        if result is None:
            continue
        entry, term_filter = result
        shard_index = zlib.crc32(case_number.encode("utf-8")) % shard_count
        partitions[shard_index].append(entry)
        partition_filters[shard_index].extend(term_filter)
        document_total += int(entry[1])
        content_document_total += int(entry[2])
        content_cases += 1

    generation = datetime.now(timezone.utc).isoformat()
    previous = load_previous_index(r2, bucket)
    active_slot = "b" if previous and previous.get("activeSlot") == "a" else "a"
    part_keys: list[str] = []
    part_sizes: list[int] = []
    for shard_index, entries in enumerate(partitions):
        key = (
            f"case-router/v{ROUTER_VERSION}/slots/{active_slot}/"
            f"part-{shard_index:02d}-of-{shard_count:02d}.json.gz"
        )
        payload = {
            "version": ROUTER_VERSION,
            "generation": generation,
            "shardIndex": shard_index,
            "shardCount": shard_count,
            "filterBytes": ROUTER_FILTER_BYTES,
            "filterBands": ROUTER_FILTER_BANDS,
            "cases": entries,
            "filtersB64": base64.b64encode(partition_filters[shard_index]).decode("ascii"),
        }
        body = gzip.compress(
            json.dumps(payload, separators=(",", ":")).encode("utf-8"),
            compresslevel=9,
        )
        if len(body) > MAX_COMPRESSED_PART_BYTES:
            raise RuntimeError(f"Router part exceeds 8 MiB: {key} ({len(body)} bytes)")
        r2.put_object(
            Bucket=bucket,
            Key=key,
            Body=body,
            ContentType="application/json",
            ContentEncoding="gzip",
            CacheControl="private, max-age=300",
        )
        part_keys.append(key)
        part_sizes.append(len(body))

    index = {
        "version": ROUTER_VERSION,
        "generation": generation,
        "activeSlot": active_slot,
        "updatedAt": generation,
        "complete": True,
        "shardCount": shard_count,
        "filterBytes": ROUTER_FILTER_BYTES,
        "filterBands": ROUTER_FILTER_BANDS,
        "manifestObjects": manifest_total,
        "cases": len(grouped),
        "contentCases": content_cases,
        "documentAssociations": document_total,
        "contentDocumentAssociations": content_document_total,
        "partKeys": part_keys,
        "compressedBytes": sum(part_sizes),
    }
    r2.put_object(
        Bucket=bucket,
        Key=ROUTER_INDEX_KEY,
        Body=json.dumps(index, indent=2).encode("utf-8"),
        ContentType="application/json",
        CacheControl="no-store",
    )
    return index


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--shard-count", type=int, default=DEFAULT_ROUTER_SHARDS)
    args = parser.parse_args()
    if not 4 <= args.shard_count <= 32:
        raise RuntimeError("--shard-count must be between 4 and 32")

    account_id = require_env("CLOUDFLARE_ACCOUNT_ID")
    endpoint = os.environ.get("R2_ENDPOINT") or f"https://{account_id}.r2.cloudflarestorage.com"
    bucket = require_env("R2_BUCKET_NAME")
    r2 = boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=require_env("R2_ACCESS_KEY_ID"),
        aws_secret_access_key=require_env("R2_SECRET_ACCESS_KEY"),
        region_name="auto",
    )
    index = build_router(r2, bucket, args.shard_count)
    print(
        "Global case router complete: "
        f"{index['contentCases']:,}/{index['cases']:,} cases with full-text filters; "
        f"{index['contentDocumentAssociations']:,} routed document associations; "
        f"{index['shardCount']} parts; "
        f"{index['compressedBytes'] / 1024 / 1024:.1f} MiB compressed.",
        flush=True,
    )


if __name__ == "__main__":
    main()
