#!/usr/bin/env python3
"""Publish resumable, sharded public-PDF filing metadata to R2."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

import requests

from cloud_ingest import (
    EDOCKET_API,
    PAGE_SIZE,
    USER_AGENT,
    clean_text,
    dcpsc_request,
    docket_case_numbers,
    iter_filings,
    normalize_case_number,
    official_filing_total,
    pdf_url,
    related_case_numbers,
)
from fast_r2_ingest import FastR2Store, SHARD_RECORD_CAPACITY

METADATA_STATE_VERSION = 3
METADATA_PAGE_CONCURRENCY = 1
DEFAULT_CHECKPOINT_RECORDS = 5_000


def metadata_state_key(shard_index: int, shard_count: int) -> str:
    return (
        f"ingestion/metadata-coverage-v{METADATA_STATE_VERSION}-"
        f"{shard_index}-of-{shard_count}.json"
    )


def shard_bounds(
    total_records: int,
    shard_index: int,
    shard_count: int,
) -> tuple[int, int]:
    """Return the oldest-first official-record range owned by one shard."""
    shard_width = SHARD_RECORD_CAPACITY // shard_count
    raw_start = shard_width * shard_index
    raw_end = (
        total_records
        if shard_index == shard_count - 1
        else shard_width * (shard_index + 1)
    )
    return min(raw_start, total_records), min(raw_end, total_records)


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


def save_status(store: FastR2Store, key: str, status: dict[str, Any]) -> None:
    body = json.dumps(status, indent=2).encode("utf-8")
    store.r2.put_object(
        Bucket=store.bucket,
        Key=key,
        Body=body,
        ContentType="application/json",
        CacheControl="no-store",
    )


def fetch_metadata_page(offset: int) -> tuple[int, list[dict[str, Any]]]:
    with dcpsc_request(
        "GET",
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
    ) as response:
        return offset, response.json().get("resultsSet") or []


def public_pdf_metadata_pages(
    start_offset: int,
    end_offset: int,
    page_concurrency: int = METADATA_PAGE_CONCURRENCY,
) -> Iterable[tuple[int, list[tuple[str, dict[str, Any]]]]]:
    """Yield pages in offset order so a persisted cursor is always contiguous."""
    offsets = range(start_offset, end_offset, PAGE_SIZE)

    def fetched_pages() -> Iterable[tuple[int, list[dict[str, Any]]]]:
        if page_concurrency <= 1:
            for offset in offsets:
                yield fetch_metadata_page(offset)
            return
        with ThreadPoolExecutor(max_workers=page_concurrency) as executor:
            yield from executor.map(fetch_metadata_page, offsets)

    for offset, records in fetched_pages():
        rows: list[tuple[str, dict[str, Any]]] = []
        for filing in records:
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
            rows.append((case_number, filing))
        yield min(offset + PAGE_SIZE, end_offset), rows


def checkpoint_full_scan(
    store: FastR2Store,
    state_key: str,
    prior: dict[str, Any],
    *,
    total_records: int,
    shard_start: int,
    shard_end: int,
    next_offset: int,
    public_pdf_records: int,
    complete: bool,
) -> dict[str, Any]:
    """Flush manifests first, then atomically publish the resumable cursor."""
    store.flush_manifests()
    # Preserve the full-text crawler's independent cursor while persisting the
    # R2 write accounting accumulated by metadata manifest updates.
    store.save_state()
    status = {
        **prior,
        "version": METADATA_STATE_VERSION,
        "shardIndex": store.shard_index,
        "shardCount": store.shard_count,
        "officialRecords": total_records,
        "shardStart": shard_start,
        "shardEnd": shard_end,
        "nextOffset": next_offset,
        "officialRecordsScanned": max(0, next_offset - shard_start),
        "publicPdfRecords": public_pdf_records,
        "fullScanComplete": complete,
        "lastMode": "full",
        "updatedAt": datetime.now(timezone.utc).isoformat(),
    }
    if complete:
        status["fullScanCompletedAt"] = status["updatedAt"]
    save_status(store, state_key, status)
    return status


def run_full_scan(
    store: FastR2Store,
    prior: dict[str, Any],
    *,
    total_records: int,
    checkpoint_records: int,
    max_hours: float,
) -> None:
    state_key = metadata_state_key(store.shard_index, store.shard_count)
    shard_start, shard_end = shard_bounds(
        total_records,
        store.shard_index,
        store.shard_count,
    )
    start_offset = min(
        max(int(prior.get("nextOffset") or shard_start), shard_start),
        shard_end,
    )
    public_pdf_records = int(prior.get("publicPdfRecords") or 0)
    started = time.monotonic()
    last_checkpoint_offset = start_offset
    next_offset = start_offset
    complete = start_offset >= shard_end

    print(
        f"Metadata shard {store.shard_index + 1}/{store.shard_count}: "
        f"offset {start_offset:,} to {shard_end:,} of "
        f"{total_records:,} official records.",
        flush=True,
    )

    try:
        for next_offset, rows in public_pdf_metadata_pages(start_offset, shard_end):
            for case_number, filing in rows:
                cases = related_case_numbers(case_number, filing.get("docketNumber"))
                store.add_metadata(cases, metadata_document(case_number, filing))
                public_pdf_records += 1

            elapsed_hours = (time.monotonic() - started) / 3600
            checkpoint_due = next_offset - last_checkpoint_offset >= checkpoint_records
            time_limit_reached = elapsed_hours >= max_hours
            if checkpoint_due or time_limit_reached:
                checkpoint_full_scan(
                    store,
                    state_key,
                    prior,
                    total_records=total_records,
                    shard_start=shard_start,
                    shard_end=shard_end,
                    next_offset=next_offset,
                    public_pdf_records=public_pdf_records,
                    complete=False,
                )
                last_checkpoint_offset = next_offset
                print(
                    f"Metadata checkpoint shard {store.shard_index + 1}/"
                    f"{store.shard_count}: {next_offset - shard_start:,}/"
                    f"{shard_end - shard_start:,} official records; "
                    f"{public_pdf_records:,} public PDFs; {elapsed_hours:.2f}h.",
                    flush=True,
                )
            if time_limit_reached:
                print(
                    "Metadata time budget reached; exiting cleanly for the next run.",
                    flush=True,
                )
                return
    except requests.RequestException:
        checkpoint_full_scan(
            store,
            state_key,
            prior,
            total_records=total_records,
            shard_start=shard_start,
            shard_end=shard_end,
            next_offset=next_offset,
            public_pdf_records=public_pdf_records,
            complete=False,
        )
        print(
            f"Metadata request failed; saved contiguous progress through "
            f"offset {next_offset:,} before exiting.",
            flush=True,
        )
        raise

    complete = next_offset >= shard_end
    checkpoint_full_scan(
        store,
        state_key,
        prior,
        total_records=total_records,
        shard_start=shard_start,
        shard_end=shard_end,
        next_offset=shard_end if complete else next_offset,
        public_pdf_records=public_pdf_records,
        complete=complete,
    )
    print(
        f"Metadata full scan shard {store.shard_index + 1}/{store.shard_count} "
        f"complete: {public_pdf_records:,} public PDF records.",
        flush=True,
    )


def run_recent_scan(
    store: FastR2Store,
    prior: dict[str, Any],
    *,
    total_records: int,
    since_days: int,
    checkpoint_records: int,
    max_hours: float,
) -> None:
    if store.shard_index != store.shard_count - 1:
        print(
            f"Metadata shard {store.shard_index + 1}/{store.shard_count} is complete; "
            "recent records belong to the final shard.",
            flush=True,
        )
        return

    state_key = metadata_state_key(store.shard_index, store.shard_count)
    started = time.monotonic()
    scanned = 0
    pending = 0
    for case_number, filing, _ in iter_filings(
        [],
        since_days,
        0,
        start_offset=0,
        oldest_first=False,
    ):
        cases = related_case_numbers(case_number, filing.get("docketNumber"))
        store.add_metadata(cases, metadata_document(case_number, filing))
        scanned += 1
        pending += 1
        elapsed_hours = (time.monotonic() - started) / 3600
        if pending >= checkpoint_records or elapsed_hours >= max_hours:
            store.flush_manifests()
            store.save_state()
            pending = 0
            if elapsed_hours >= max_hours:
                break

    store.flush_manifests()
    store.save_state()
    status = {
        **prior,
        "version": METADATA_STATE_VERSION,
        "officialRecords": total_records,
        "lastMode": "recent",
        "lastRecentPublicPdfRecords": scanned,
        "lastRecentCompletedAt": datetime.now(timezone.utc).isoformat(),
        "updatedAt": datetime.now(timezone.utc).isoformat(),
    }
    save_status(store, state_key, status)
    print(
        f"Metadata recent scan complete: {scanned:,} public PDF records refreshed.",
        flush=True,
    )


def run_all_shards(args: argparse.Namespace) -> None:
    """Run the same independent shard processes used by GitHub Actions."""
    script_path = str(Path(__file__).resolve())
    processes = []
    for shard_index in range(args.shard_count):
        command = [
            sys.executable,
            "-u",
            script_path,
            "--mode",
            args.mode,
            "--since-days",
            str(args.since_days),
            "--shard-index",
            str(shard_index),
            "--shard-count",
            str(args.shard_count),
            "--max-hours",
            str(args.max_hours),
            "--checkpoint-records",
            str(args.checkpoint_records),
        ]
        processes.append((shard_index, subprocess.Popen(command)))
    failures = [
        shard_index
        for shard_index, process in processes
        if process.wait() != 0
    ]
    if failures:
        joined = ", ".join(str(index + 1) for index in failures)
        raise RuntimeError(f"Metadata shard process(es) failed: {joined}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--mode",
        choices=("auto", "full", "recent"),
        default="auto",
        help="Auto resumes the full shard once, then refreshes recent metadata",
    )
    parser.add_argument("--since-days", type=int, default=3)
    parser.add_argument(
        "--all-shards",
        action="store_true",
        help="Launch every shard locally in parallel",
    )
    parser.add_argument("--shard-index", type=int, default=0)
    parser.add_argument("--shard-count", type=int, default=4)
    parser.add_argument("--max-hours", type=float, default=1.0)
    parser.add_argument("--checkpoint-records", type=int, default=DEFAULT_CHECKPOINT_RECORDS)
    args = parser.parse_args()
    if not 1 <= args.shard_count <= 8:
        raise RuntimeError("--shard-count must be between 1 and 8")
    if not 0 <= args.shard_index < args.shard_count:
        raise RuntimeError("--shard-index must be within --shard-count")
    if args.max_hours <= 0:
        raise RuntimeError("--max-hours must be positive")
    if args.checkpoint_records < PAGE_SIZE:
        raise RuntimeError(f"--checkpoint-records must be at least {PAGE_SIZE}")
    if args.all_shards:
        run_all_shards(args)
        return

    store = FastR2Store(args.shard_index, args.shard_count)
    state_key = metadata_state_key(args.shard_index, args.shard_count)
    prior = store._load_json(state_key) or {}
    mode = args.mode
    if mode == "auto":
        mode = "recent" if prior.get("fullScanComplete") else "full"

    total_records = official_filing_total()
    if mode == "full":
        run_full_scan(
            store,
            prior,
            total_records=total_records,
            checkpoint_records=args.checkpoint_records,
            max_hours=args.max_hours,
        )
    else:
        run_recent_scan(
            store,
            prior,
            total_records=total_records,
            since_days=args.since_days,
            checkpoint_records=args.checkpoint_records,
            max_hours=args.max_hours,
        )


if __name__ == "__main__":
    main()
