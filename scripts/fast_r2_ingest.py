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
    clean_text,
    download_pdf,
    extract_pages,
    iter_filings,
    related_case_numbers,
)
from compact_search import create_term_filter

STATE_KEY = "ingestion/fast-r2-state-v1.json"
MAX_R2_BYTES = 8 * 1024 * 1024 * 1024
MAX_R2_WRITES_PER_MONTH = 700_000
MANIFEST_FLUSH_BATCH = 100


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
    def __init__(self) -> None:
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
        self.manifest_sizes: dict[str, int] = {}
        self.dirty_cases: set[str] = set()
        self.storage_bytes = self._storage_bytes()
        self.state = self._load_json(STATE_KEY) or {
            "version": 1,
            "nextOffset": 0,
            "documentsIndexed": 0,
            "failedFilingIds": [],
        }
        current_month = datetime.now(timezone.utc).strftime("%Y-%m")
        if self.state.get("writeMonth") != current_month:
            self.state["writeMonth"] = current_month
            self.state["r2WritesThisMonth"] = 0
        self.monthly_writes = int(self.state.get("r2WritesThisMonth") or 0)
        print(
            "Fast R2 guard: "
            f"{self.storage_bytes / 1024 / 1024:.1f} MiB / 8192 MiB; "
            f"{self.monthly_writes:,} / {MAX_R2_WRITES_PER_MONTH:,} tracked monthly writes; "
            f"cursor {int(self.state.get('nextOffset') or 0):,}."
        )

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
        if self.monthly_writes + 1 > MAX_R2_WRITES_PER_MONTH:
            raise RuntimeError("Monthly R2 write safety ceiling reached")
        if self.storage_bytes + max(0, added_bytes) > MAX_R2_BYTES:
            raise RuntimeError("R2 storage safety ceiling reached (8 GiB)")
        self.monthly_writes += 1
        self.storage_bytes += added_bytes

    def _manifest_key(self, case_number: str) -> str:
        return f"manifests/{safe_case_number(case_number)}.json.gz"

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

    def reuse_existing(self, case_numbers: list[str], filing_id: int) -> bool:
        existing: dict[str, Any] | None = None
        loaded: list[tuple[str, dict[int, dict[str, Any]]]] = []
        for case_number in case_numbers:
            manifest = self.load_manifest(case_number)
            loaded.append((case_number, manifest))
            existing = existing or manifest.get(filing_id)
        if not existing:
            return False
        for case_number, manifest in loaded:
            if filing_id not in manifest:
                manifest[filing_id] = existing
                self.dirty_cases.add(case_number)
        return True

    def add_document(self, case_numbers: list[str], document: dict[str, Any]) -> None:
        filing_id = int(document["filing_id"])
        for case_number in case_numbers:
            manifest = self.load_manifest(case_number)
            manifest[filing_id] = document
            self.dirty_cases.add(safe_case_number(case_number))

    def upload_html(self, key: str, compressed: bytes) -> None:
        with self.lock:
            self._reserve_write(len(compressed))
            self.r2.put_object(
                Bucket=self.bucket,
                Key=key,
                Body=compressed,
                ContentType="text/html; charset=utf-8",
                ContentEncoding="gzip",
                CacheControl="private, max-age=31536000, immutable",
            )

    def flush_manifests(self) -> None:
        for case_number in sorted(self.dirty_cases):
            documents = self.manifests[case_number]
            body = gzip.compress(json.dumps({
                "version": 1,
                "caseNumber": case_number,
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

    def save_state(self, next_offset: int | None = None, failures: list[int] | None = None) -> None:
        if next_offset is not None:
            self.state["nextOffset"] = next_offset
        if failures:
            prior = [int(value) for value in self.state.get("failedFilingIds", [])]
            self.state["failedFilingIds"] = list(dict.fromkeys([*prior, *failures]))[-5000:]
        self.state["updatedAt"] = datetime.now(timezone.utc).isoformat()
        self.state["r2WritesThisMonth"] = self.monthly_writes + 1
        self.state["writeMonth"] = datetime.now(timezone.utc).strftime("%Y-%m")
        body = json.dumps(self.state, indent=2).encode("utf-8")
        with self.lock:
            self._reserve_write(len(body))
            self.r2.put_object(
                Bucket=self.bucket,
                Key=STATE_KEY,
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
        page_html = "\n".join(
            f'<section data-page="{page["number"]}">{page["html"]}</section>' for page in pages
        )
        document_html = (
            '<!doctype html><html><head><meta charset="utf-8"></head><body>'
            f'<main data-filing-id="{filing_id}" data-case="{case_number}">'
            f"{page_html}</main></body></html>"
        ).encode("utf-8")
        compressed = gzip.compress(document_html, compresslevel=6)
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
    args = parser.parse_args()
    if args.all == bool(args.since_days):
        raise RuntimeError("Choose exactly one of --all or --since-days")
    if not 1 <= args.concurrency <= 24:
        raise RuntimeError("--concurrency must be between 1 and 24")

    store = FastR2Store()
    start_offset = int(store.state.get("nextOffset") or 0) if args.all else 0
    started = time.monotonic()
    batch: list[tuple[str, dict[str, Any], int]] = []
    processed = 0
    skipped = 0
    failed_total = 0

    def run_batch(items: list[tuple[str, dict[str, Any], int]]) -> bool:
        nonlocal processed, skipped, failed_total
        failures: list[int] = []
        futures = {}
        completed_offset = max(item[2] for item in items)
        with ThreadPoolExecutor(max_workers=args.concurrency) as executor:
            for case_number, filing, next_offset in items:
                filing_id = int(filing["filingId"])
                cases = related_case_numbers(case_number, filing.get("docketNumber"))
                if store.reuse_existing(cases, filing_id):
                    skipped += 1
                    continue
                future = executor.submit(extract_and_upload, store, case_number, filing)
                futures[future] = (filing_id, next_offset)
            for future in as_completed(futures):
                filing_id, _ = futures[future]
                try:
                    cases, document = future.result()
                    store.add_document(cases, document)
                    processed += 1
                    store.state["documentsIndexed"] = int(store.state.get("documentsIndexed") or 0) + 1
                    print(f"Indexed {document['case_number']} filing {filing_id} ({document['page_count']} pages)")
                except Exception as error:
                    failures.append(filing_id)
                    failed_total += 1
                    print(f"FAILED filing {filing_id}: {error}")
        store.flush_manifests()
        store.save_state(completed_offset if args.all else None, failures)
        elapsed_hours = (time.monotonic() - started) / 3600
        print(
            f"Checkpoint: processed {processed:,}, skipped {skipped:,}, failed {failed_total:,}; "
            f"offset {completed_offset:,}; elapsed {elapsed_hours:.2f}h."
        )
        return elapsed_hours < args.max_hours

    for item in iter_filings(
        [],
        0 if args.all else args.since_days,
        args.limit,
        start_offset=start_offset,
        oldest_first=args.all,
    ):
        batch.append(item)
        if len(batch) >= MANIFEST_FLUSH_BATCH:
            if not run_batch(batch):
                batch = []
                break
            batch = []
    if batch:
        run_batch(batch)
    print(f"Fast R2 ingestion complete: {processed:,} new, {skipped:,} existing, {failed_total:,} failed.")


if __name__ == "__main__":
    main()
