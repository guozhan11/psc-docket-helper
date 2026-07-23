#!/usr/bin/env python3
"""Publish complete public-PDF filing metadata before full-text extraction."""

from __future__ import annotations

import argparse
import json
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from typing import Any

import requests

from cloud_ingest import (
    EDOCKET_API,
    PAGE_SIZE,
    USER_AGENT,
    clean_text,
    docket_case_numbers,
    iter_filings,
    normalize_case_number,
    official_filing_total,
    pdf_url,
    related_case_numbers,
)
from fast_r2_ingest import FastR2Store, SHARD_RECORD_CAPACITY

METADATA_STATE_KEY = "ingestion/metadata-coverage-v2.json"
METADATA_PAGE_CONCURRENCY = 12


def metadata_document(case_number: str, filing: dict[str, Any]) -> dict[str, Any]:
    return {
        "filing_id": int(filing["filingId"]),
        "case_number": case_number,
        "docket_number": filing.get("docketNumber"),
        "title": clean_text(filing.get("description")) or str(
            filing.get("attachmentFileName") or filing.get("attachment") or "PSC filing"
        ),
        "received_date": filing.get("receivedDate"),
        "official_pdf_url": pdf_url(filing),
        "metadata_only": True,
    }


def save_status(store: FastR2Store, status: dict[str, Any]) -> None:
    body = json.dumps(status, indent=2).encode("utf-8")
    store.r2.put_object(
        Bucket=store.bucket,
        Key=METADATA_STATE_KEY,
        Body=body,
        ContentType="application/json",
        CacheControl="no-store",
    )


def fetch_metadata_page(offset: int) -> tuple[int, list[dict[str, Any]]]:
    for attempt in range(3):
        try:
            response = requests.get(
                f"{EDOCKET_API}Filing/GetFilings",
                params={
                    "caseNumber": "",
                    "isAdmin": "false",
                    "orderByColumn": "receivedDate",
                    "sortBy": "asc",
                    "recordsToSkip": offset,
                    "recordsToShow": PAGE_SIZE,
                },
                headers={"Accept": "application/json", "User-Agent": USER_AGENT},
                timeout=60,
            )
            response.raise_for_status()
            return offset, response.json().get("resultsSet") or []
        except Exception:
            if attempt == 2:
                raise
            time.sleep(2 ** attempt)
    raise RuntimeError("unreachable")


def public_pdf_metadata_rows(total_records: int):
    offsets = range(0, total_records, PAGE_SIZE)
    with ThreadPoolExecutor(max_workers=METADATA_PAGE_CONCURRENCY) as executor:
        futures = {
            executor.submit(fetch_metadata_page, offset): offset
            for offset in offsets
        }
        for future in as_completed(futures):
            offset, records = future.result()
            for record_index, filing in enumerate(records):
                attachment = str(filing.get("attachment") or "")
                if (
                    filing.get("isConfidential")
                    or filing.get("isArchived")
                    or not filing.get("attachmentId")
                    or not attachment.lower().endswith(".pdf")
                ):
                    continue
                docket = str(filing.get("docketNumber") or "")
                docket_cases = docket_case_numbers(docket)
                case_number = docket_cases[0] if docket_cases else normalize_case_number("")
                yield case_number, filing, offset + record_index + 1


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--mode",
        choices=("auto", "full", "recent"),
        default="auto",
        help="Auto performs the full scan once, then refreshes recent metadata",
    )
    parser.add_argument("--since-days", type=int, default=3)
    parser.add_argument("--shard-count", type=int, default=4)
    args = parser.parse_args()
    if not 1 <= args.shard_count <= 8:
        raise RuntimeError("--shard-count must be between 1 and 8")

    stores = [FastR2Store(0, args.shard_count)]
    stores.extend(
        FastR2Store(index, args.shard_count, stores[0])
        for index in range(1, args.shard_count)
    )
    prior = stores[0]._load_json(METADATA_STATE_KEY) or {}
    mode = args.mode
    if mode == "auto":
        mode = "recent" if prior.get("fullScanComplete") else "full"

    total_records = official_filing_total()
    shard_width = SHARD_RECORD_CAPACITY // args.shard_count
    scanned = 0
    newest_offset = 0
    iterator = (
        public_pdf_metadata_rows(total_records)
        if mode == "full"
        else iter_filings(
            [],
            args.since_days,
            0,
            start_offset=0,
            oldest_first=False,
        )
    )
    for case_number, filing, next_offset in iterator:
        shard_index = (
            args.shard_count - 1
            if mode == "recent"
            else min((max(1, next_offset) - 1) // shard_width, args.shard_count - 1)
        )
        cases = related_case_numbers(case_number, filing.get("docketNumber"))
        stores[shard_index].add_metadata(
            cases,
            metadata_document(case_number, filing),
        )
        scanned += 1
        newest_offset = max(newest_offset, next_offset)
        if scanned % 5_000 == 0:
            print(
                f"Prepared {scanned:,} public PDF metadata records "
                f"({newest_offset:,}/{total_records:,} official records scanned)."
            )

    for store in stores:
        store.flush_manifests()
        store.save_state()

    status = {
        **prior,
        "version": 2,
        "shardCount": args.shard_count,
        "officialRecords": total_records,
        "lastMode": mode,
        "lastPublicPdfRecords": scanned,
        "lastCompletedAt": datetime.now(timezone.utc).isoformat(),
    }
    if mode == "full":
        status["fullScanComplete"] = True
        status["fullScanPublicPdfRecords"] = scanned
        status["fullScanOfficialRecords"] = total_records
    save_status(stores[0], status)
    print(
        f"Metadata {mode} scan complete: {scanned:,} public PDF records across "
        f"{args.shard_count} manifest shards."
    )


if __name__ == "__main__":
    main()
