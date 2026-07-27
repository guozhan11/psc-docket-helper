#!/usr/bin/env python3
"""Build the all-case RAG corpus quickly with parallel extraction and R2 manifests."""

from __future__ import annotations

import argparse
import base64
import gzip
import hashlib
import json
import os
import re
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import boto3

from cloud_ingest import (
    PermanentFilingError,
    clean_text,
    compact_document_html,
    download_pdf,
    extract_pages,
    iter_filings,
    official_filing_total,
    related_case_numbers,
)
from compact_search import create_term_filter

MAX_R2_BYTES = 8 * 1024 * 1024 * 1024
MAX_R2_WRITES_PER_MONTH = 700_000
MANIFEST_FLUSH_BATCH = 100
MANIFEST_VERSION = 2
INGEST_STATE_VERSION = 3
CONTENT_FORMAT = "compact-text-v1"
SHARD_RECORD_CAPACITY = 250_000


def migrated_ingest_state(
    legacy_state: dict[str, Any],
    shard_index: int,
    shard_count: int,
) -> dict[str, Any]:
    shard_width = SHARD_RECORD_CAPACITY // shard_count
    return {
        **legacy_state,
        "version": INGEST_STATE_VERSION,
        "shardIndex": shard_index,
        "shardCount": shard_count,
        # Restart at the shard boundary so legacy image-heavy objects are
        # overwritten in place; already-compact objects are cheaply reused.
        "nextOffset": shard_width * shard_index,
        "documentsIndexed": int(legacy_state.get("documentsIndexed") or 0),
        "documentsCompacted": 0,
        "failedFilingIds": legacy_state.get("failedFilingIds") or [],
        "migrationFromStateVersion": MANIFEST_VERSION,
    }


def require_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


def safe_case_number(value: str) -> str:
    normalized = value.upper().replace(" ", "")
    if not re.fullmatch(r"[A-Z][A-Z0-9-]{2,30}", normalized):
        raise ValueError(f"Unsafe case number: {value}")
    return normalized


class FastR2Store:
    def __init__(
        self,
        shard_index: int = 0,
        shard_count: int = 1,
        shared_connection: "FastR2Store | None" = None,
    ) -> None:
        if shard_count < 1 or shard_index < 0 or shard_index >= shard_count:
            raise ValueError("Invalid shard configuration")
        self.shard_index = shard_index
        self.shard_count = shard_count
        self.state_key = (
            f"ingestion/fast-r2-state-v{INGEST_STATE_VERSION}-"
            f"{shard_index}-of-{shard_count}.json"
        )
        self.legacy_state_key = (
            f"ingestion/fast-r2-state-v{MANIFEST_VERSION}-"
            f"{shard_index}-of-{shard_count}.json"
        )
        if shared_connection:
            self.bucket = shared_connection.bucket
            self.r2 = shared_connection.r2
        else:
            account_id = require_env("CLOUDFLARE_ACCOUNT_ID")
            endpoint = os.environ.get("R2_ENDPOINT") or f"https://{account_id}.r2.cloudflarestorage.com"
            self.bucket = require_env("R2_BUCKET_NAME")
            self.r2 = boto3.client(
                "s3",
                endpoint_url=endpoint,
                aws_access_key_id=require_env("R2_ACCESS_KEY_ID"),
                aws_secret_access_key=require_env("R2_SECRET_ACCESS_KEY"),
                region_name="auto",
            )
        self.lock = threading.Lock()
        self.manifests: dict[str, dict[int, dict[str, Any]]] = {}
        self.legacy_manifests: dict[str, dict[int, dict[str, Any]]] = {}
        self.manifest_sizes: dict[str, int] = {}
        self.dirty_cases: set[str] = set()
        self.storage_bytes = (
            shared_connection.storage_bytes
            if shared_connection
            else self._storage_bytes()
        )
        self.state = self._load_json(self.state_key)
        if not self.state:
            legacy_state = self._load_json(self.legacy_state_key) or {}
            self.state = migrated_ingest_state(
                legacy_state,
                shard_index,
                shard_count,
            )
        current_month = datetime.now(timezone.utc).strftime("%Y-%m")
        if self.state.get("writeMonth") != current_month:
            self.state["writeMonth"] = current_month
            self.state["r2WritesThisMonth"] = 0
        self.monthly_writes = int(self.state.get("r2WritesThisMonth") or 0)
        print(
            "Fast R2 guard: "
            f"shard {shard_index + 1}/{shard_count}; "
            f"{self.storage_bytes / 1024 / 1024:.1f} MiB / 8192 MiB; "
            f"{self.monthly_writes:,} / {self.monthly_write_limit:,} tracked monthly writes; "
            f"cursor {int(self.state.get('nextOffset') or 0):,}."
        )

    @property
    def monthly_write_limit(self) -> int:
        return MAX_R2_WRITES_PER_MONTH // self.shard_count

    def _storage_bytes(self) -> int:
        total = 0
        paginator = self.r2.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=self.bucket):
            total += sum(int(item.get("Size") or 0) for item in page.get("Contents") or [])
        return total

    def _load_json(self, key: str) -> dict[str, Any] | None:
        try:
            response = self.r2.get_object(Bucket=self.bucket, Key=key)
            return json.loads(response["Body"].read())
        except self.r2.exceptions.NoSuchKey:
            return None
        except Exception as error:
            if "NoSuchKey" in str(error) or "404" in str(error):
                return None
            raise

    def _reserve_write(self, added_bytes: int) -> None:
        if self.monthly_writes + 1 > self.monthly_write_limit:
            raise RuntimeError(
                f"Monthly R2 write safety ceiling reached for shard "
                f"{self.shard_index + 1}/{self.shard_count}"
            )
        if self.storage_bytes + max(0, added_bytes) > MAX_R2_BYTES:
            raise RuntimeError("R2 storage safety ceiling reached (8 GiB)")
        self.monthly_writes += 1
        self.storage_bytes += added_bytes

    def _object_size(self, key: str) -> int:
        try:
            response = self.r2.head_object(Bucket=self.bucket, Key=key)
            return int(response.get("ContentLength") or 0)
        except Exception as error:
            if "NoSuchKey" in str(error) or "404" in str(error) or "Not Found" in str(error):
                return 0
            raise

    def _manifest_key(self, case_number: str) -> str:
        return (
            f"manifests-v{MANIFEST_VERSION}/{safe_case_number(case_number)}/"
            f"part-{self.shard_index}-of-{self.shard_count}.json.gz"
        )

    def _legacy_manifest_key(self, case_number: str) -> str:
        return f"manifests/{safe_case_number(case_number)}.json.gz"

    def load_legacy_manifest(self, case_number: str) -> dict[int, dict[str, Any]]:
        case_number = safe_case_number(case_number)
        if case_number in self.legacy_manifests:
            return self.legacy_manifests[case_number]
        try:
            response = self.r2.get_object(
                Bucket=self.bucket,
                Key=self._legacy_manifest_key(case_number),
            )
            payload = json.loads(gzip.decompress(response["Body"].read()))
            documents = {
                int(document["filing_id"]): document
                for document in payload.get("documents", [])
                if document.get("filing_id") is not None
            }
        except self.r2.exceptions.NoSuchKey:
            documents = {}
        except Exception as error:
            if "NoSuchKey" in str(error) or "404" in str(error):
                documents = {}
            else:
                raise
        self.legacy_manifests[case_number] = documents
        return documents

    def load_manifest(self, case_number: str) -> dict[int, dict[str, Any]]:
        case_number = safe_case_number(case_number)
        if case_number in self.manifests:
            return self.manifests[case_number]
        key = self._manifest_key(case_number)
        try:
            response = self.r2.get_object(Bucket=self.bucket, Key=key)
            compressed = response["Body"].read()
            payload = json.loads(gzip.decompress(compressed))
            documents = {
                int(document["filing_id"]): document
                for document in payload.get("documents", [])
                if document.get("filing_id") is not None
            }
            self.manifest_sizes[case_number] = int(response.get("ContentLength") or len(compressed))
        except self.r2.exceptions.NoSuchKey:
            documents = {}
            self.manifest_sizes[case_number] = 0
        except Exception as error:
            if "NoSuchKey" in str(error) or "404" in str(error):
                documents = {}
                self.manifest_sizes[case_number] = 0
            else:
                raise
        self.manifests[case_number] = documents
        return documents

    def existing_document_status(self, case_numbers: list[str], filing_id: int) -> str:
        """Return missing, legacy, or compact while repairing case associations."""
        existing: dict[str, Any] | None = None
        loaded: list[tuple[str, dict[int, dict[str, Any]]]] = []
        for case_number in case_numbers:
            manifest = self.load_manifest(case_number)
            loaded.append((case_number, manifest))
            candidate = manifest.get(filing_id) or self.load_legacy_manifest(case_number).get(filing_id)
            if candidate and candidate.get("r2_key") and candidate.get("term_filter_b64"):
                existing = candidate
        if not existing or not existing.get("r2_key"):
            return "missing"
        for case_number, manifest in loaded:
            if filing_id not in manifest:
                manifest[filing_id] = existing
                self.dirty_cases.add(case_number)
        return "compact" if existing.get("content_format") == CONTENT_FORMAT else "legacy"

    def add_document(self, case_numbers: list[str], document: dict[str, Any]) -> None:
        filing_id = int(document["filing_id"])
        for case_number in case_numbers:
            manifest = self.load_manifest(case_number)
            manifest[filing_id] = document
            self.dirty_cases.add(safe_case_number(case_number))

    def add_metadata(self, case_numbers: list[str], document: dict[str, Any]) -> None:
        filing_id = int(document["filing_id"])
        for case_number in case_numbers:
            manifest = self.load_manifest(case_number)
            existing = manifest.get(filing_id) or self.load_legacy_manifest(case_number).get(filing_id)
            if existing:
                merged = {**document, **existing}
                manifest[filing_id] = merged
            else:
                manifest[filing_id] = document
            self.dirty_cases.add(safe_case_number(case_number))

    def upload_html(self, key: str, compressed: bytes) -> int:
        previous_size = self._object_size(key)
        with self.lock:
            self._reserve_write(len(compressed) - previous_size)
            self.r2.put_object(
                Bucket=self.bucket,
                Key=key,
                Body=compressed,
                ContentType="text/html; charset=utf-8",
                ContentEncoding="gzip",
                CacheControl="private, max-age=31536000, immutable",
            )
        return previous_size

    def flush_manifests(self) -> None:
        for case_number in sorted(self.dirty_cases):
            documents = self.manifests[case_number]
            body = gzip.compress(json.dumps({
                "version": MANIFEST_VERSION,
                "caseNumber": case_number,
                "shardIndex": self.shard_index,
                "shardCount": self.shard_count,
                "updatedAt": datetime.now(timezone.utc).isoformat(),
                "documents": sorted(documents.values(), key=lambda item: int(item["filing_id"])),
            }, separators=(",", ":")).encode("utf-8"), compresslevel=9)
            previous_size = self.manifest_sizes.get(case_number, 0)
            with self.lock:
                self._reserve_write(len(body) - previous_size)
                self.r2.put_object(
                    Bucket=self.bucket,
                    Key=self._manifest_key(case_number),
                    Body=body,
                    ContentType="application/json",
                    ContentEncoding="gzip",
                    CacheControl="private, max-age=300",
                )
            self.manifest_sizes[case_number] = len(body)
        self.dirty_cases.clear()

    def save_state(
        self,
        next_offset: int | None = None,
        failures: list[int] | None = None,
        resolved: list[int] | None = None,
        unavailable: list[int] | None = None,
    ) -> None:
        if next_offset is not None:
            self.state["nextOffset"] = next_offset
        pending = {int(value) for value in self.state.get("failedFilingIds", [])}
        pending.update(int(value) for value in failures or [])
        pending.difference_update(int(value) for value in resolved or [])
        pending.difference_update(int(value) for value in unavailable or [])
        self.state["failedFilingIds"] = sorted(pending)[-5000:]
        unavailable_ids = {
            int(value) for value in self.state.get("unavailableFilingIds", [])
        }
        unavailable_ids.update(int(value) for value in unavailable or [])
        self.state["unavailableFilingIds"] = sorted(unavailable_ids)[-5000:]
        self.state["updatedAt"] = datetime.now(timezone.utc).isoformat()
        self.state["version"] = INGEST_STATE_VERSION
        self.state["shardIndex"] = self.shard_index
        self.state["shardCount"] = self.shard_count
        self.state["r2WritesThisMonth"] = self.monthly_writes + 1
        self.state["writeMonth"] = datetime.now(timezone.utc).strftime("%Y-%m")
        body = json.dumps(self.state, indent=2).encode("utf-8")
        previous_size = self._object_size(self.state_key)
        with self.lock:
            self._reserve_write(len(body) - previous_size)
            self.r2.put_object(
                Bucket=self.bucket,
                Key=self.state_key,
                Body=body,
                ContentType="application/json",
                CacheControl="no-store",
            )


def extract_and_upload(
    store: FastR2Store,
    case_number: str,
    filing: dict[str, Any],
) -> tuple[list[str], dict[str, Any]]:
    filing_id = int(filing["filingId"])
    with tempfile.TemporaryDirectory(prefix=f"psc-fast-{filing_id}-") as temp_dir:
        pdf_path = Path(temp_dir) / "source.pdf"
        source_url = download_pdf(filing, pdf_path)
        pages = extract_pages(pdf_path)
        document_html = compact_document_html(filing_id, case_number, pages)
        compressed = gzip.compress(document_html, compresslevel=9)
        year = str(filing.get("receivedDate") or "unknown")[:4]
        r2_key = f"filings/{year}/{filing_id}.html.gz"
        store.upload_html(r2_key, compressed)
        text = "\n".join(page["text"] for page in pages)
        cases = related_case_numbers(case_number, filing.get("docketNumber"))
        title = clean_text(filing.get("description")) or str(
            filing.get("attachmentFileName") or filing.get("attachment") or "PSC filing"
        )
        document = {
            "filing_id": filing_id,
            "case_number": case_number,
            "docket_number": filing.get("docketNumber"),
            "title": title,
            "received_date": filing.get("receivedDate"),
            "official_pdf_url": source_url,
            "r2_key": r2_key,
            "page_count": len(pages),
            "content_sha256": hashlib.sha256(document_html).hexdigest(),
            "content_format": CONTENT_FORMAT,
            "compressed_bytes": len(compressed),
            "term_filter_b64": base64.b64encode(create_term_filter(text)).decode("ascii"),
        }
        return cases, document


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--all", action="store_true", help="Resume the oldest-first all-case crawl")
    parser.add_argument("--since-days", type=int, default=0, help="Ingest recent filings instead")
    parser.add_argument("--limit", type=int, default=0, help="Maximum eligible filings considered")
    parser.add_argument("--concurrency", type=int, default=8, help="Parallel PDF workers")
    parser.add_argument("--max-hours", type=float, default=5.0, help="Stop cleanly before job timeout")
    parser.add_argument("--shard-index", type=int, default=0, help="Zero-based record-range shard")
    parser.add_argument("--shard-count", type=int, default=1, help="Number of record-range shards")
    args = parser.parse_args()
    if args.all == bool(args.since_days):
        raise RuntimeError("Choose exactly one of --all or --since-days")
    if not 1 <= args.concurrency <= 24:
        raise RuntimeError("--concurrency must be between 1 and 24")
    if args.shard_count < 1 or not 0 <= args.shard_index < args.shard_count:
        raise RuntimeError("--shard-index must be within --shard-count")
    if not args.all and args.shard_count != 1:
        raise RuntimeError("Recent ingestion is not sharded; use --shard-count 1")

    store = FastR2Store(args.shard_index, args.shard_count)
    shard_width = SHARD_RECORD_CAPACITY // args.shard_count
    shard_start = shard_width * args.shard_index if args.all else 0
    shard_end = (
        None
        if args.all and args.shard_index == args.shard_count - 1
        else shard_width * (args.shard_index + 1) if args.all else None
    )
    resume_offset = (
        max(int(store.state.get("nextOffset") or 0), shard_start)
        if args.all
        else 0
    )
    pending_retry_ids = {
        int(value) for value in store.state.get("failedFilingIds", [])
    }
    start_offset = shard_start if args.all and pending_retry_ids else resume_offset
    if pending_retry_ids:
        print(
            f"Retry recovery: rescanning shard for {len(pending_retry_ids):,} "
            "previously failed filing(s); compact documents will be skipped."
        )
    total_records = official_filing_total()
    if args.all and start_offset >= total_records:
        print(
            f"Shard {args.shard_index + 1}/{args.shard_count} is caught up at "
            f"offset {start_offset:,} of {total_records:,}."
        )
        return
    print(
        f"Processing shard {args.shard_index + 1}/{args.shard_count}: "
        f"offset {start_offset:,} to "
        f"{min(shard_end, total_records) if shard_end is not None else total_records:,} "
        f"of {total_records:,} official filing records."
    )
    started = time.monotonic()
    batch: list[tuple[str, dict[str, Any], int]] = []
    processed = 0
    compacted = 0
    skipped = 0
    failed_total = 0
    unavailable_total = 0
    scanned_offset = start_offset
    eligible_seen = False
    earliest_retry_offset: int | None = None

    def record_scanned_page(next_offset: int) -> None:
        nonlocal scanned_offset
        scanned_offset = max(scanned_offset, next_offset)

    def run_batch(items: list[tuple[str, dict[str, Any], int]]) -> bool:
        nonlocal processed, compacted, skipped, failed_total, unavailable_total
        nonlocal earliest_retry_offset
        failures: list[int] = []
        failure_offsets: list[int] = []
        resolved: list[int] = []
        unavailable: list[int] = []
        futures = {}
        completed_offset = max(item[2] for item in items)
        with ThreadPoolExecutor(max_workers=args.concurrency) as executor:
            for case_number, filing, next_offset in items:
                filing_id = int(filing["filingId"])
                cases = related_case_numbers(case_number, filing.get("docketNumber"))
                status = store.existing_document_status(cases, filing_id)
                if status == "compact":
                    skipped += 1
                    continue
                future = executor.submit(extract_and_upload, store, case_number, filing)
                futures[future] = (filing_id, next_offset, status == "legacy")
            for future in as_completed(futures):
                filing_id, next_offset, was_legacy = futures[future]
                try:
                    cases, document = future.result()
                    store.add_document(cases, document)
                    processed += 1
                    if was_legacy:
                        compacted += 1
                        store.state["documentsCompacted"] = int(
                            store.state.get("documentsCompacted") or 0
                        ) + 1
                    else:
                        store.state["documentsIndexed"] = int(
                            store.state.get("documentsIndexed") or 0
                        ) + 1
                    resolved.append(filing_id)
                    print(f"Indexed {document['case_number']} filing {filing_id} ({document['page_count']} pages)")
                except PermanentFilingError as error:
                    unavailable.append(filing_id)
                    unavailable_total += 1
                    print(f"UNAVAILABLE filing {filing_id}: {error}")
                except Exception as error:
                    failures.append(filing_id)
                    failure_offsets.append(next_offset)
                    failed_total += 1
                    print(f"FAILED filing {filing_id}: {error}")
        store.flush_manifests()
        if failure_offsets:
            batch_retry_offset = min(failure_offsets) - 1
            earliest_retry_offset = (
                batch_retry_offset
                if earliest_retry_offset is None
                else min(earliest_retry_offset, batch_retry_offset)
            )
        if earliest_retry_offset is not None:
            completed_offset = min(completed_offset, earliest_retry_offset)
        store.save_state(
            completed_offset if args.all else None,
            failures,
            resolved,
            unavailable,
        )
        elapsed_hours = (time.monotonic() - started) / 3600
        print(
            f"Checkpoint: processed {processed:,}, compacted {compacted:,}, "
            f"skipped {skipped:,}, retryable failed {failed_total:,}, "
            f"unavailable {unavailable_total:,}; "
            f"offset {completed_offset:,}; elapsed {elapsed_hours:.2f}h."
        )
        return elapsed_hours < args.max_hours

    for item in iter_filings(
        [],
        0 if args.all else args.since_days,
        args.limit,
        start_offset=start_offset,
        oldest_first=args.all,
        end_offset=shard_end,
        on_page_scanned=record_scanned_page,
    ):
        eligible_seen = True
        batch.append(item)
        if len(batch) >= MANIFEST_FLUSH_BATCH:
            if not run_batch(batch):
                batch = []
                break
            batch = []
    if batch:
        run_batch(batch)
    saved_offset = int(store.state.get("nextOffset") or start_offset)
    if args.all and not failed_total and scanned_offset > saved_offset:
        store.save_state(scanned_offset)
    target_offset = min(shard_end, total_records) if shard_end is not None else total_records
    if args.all and not eligible_seen and scanned_offset == start_offset < target_offset:
        raise RuntimeError(
            f"DC PSC returned no pages for incomplete shard at offset {start_offset:,}"
        )
    print(
        f"Fast R2 ingestion complete: {processed:,} written, {compacted:,} compacted, "
        f"{skipped:,} existing, {failed_total:,} queued for retry, "
        f"{unavailable_total:,} unavailable."
    )
    if failed_total:
        print(
            "Retryable filing failures were checkpointed; the next scheduled run "
            "will retry them without failing this shard."
        )


if __name__ == "__main__":
    main()
