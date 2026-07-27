#!/usr/bin/env python3
"""Incrementally extract public DC PSC PDFs into R2 HTML and compact D1 indexes."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import html
import json
import os
import random
import re
import subprocess
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Iterable

import boto3
import fitz
import requests

from compact_search import TERM_FILTER_BYTES, create_term_filter

EDOCKET_API = "https://edocket.dcpsc.org/apis/api/"
USER_AGENT = "PSC-Docket-Assistant-Indexer/1.0 (+https://dcpsc.org/)"
PAGE_SIZE = 100
MAX_R2_BYTES = 8 * 1024 * 1024 * 1024
MAX_D1_ESTIMATED_BYTES = 400 * 1024 * 1024
MAX_DOCUMENTS_PER_RUN = 5_000
MAX_D1_ROWS_WRITTEN_PER_DAY = 80_000
MAX_R2_OBJECTS_WRITTEN_PER_DAY = 5_000
DCPSC_REQUEST_ATTEMPTS = 6
DCPSC_RETRYABLE_STATUS_CODES = frozenset({429, 500, 502, 503, 504})


class FreeTierLimitReached(RuntimeError):
    """Raised before a write that would cross this project's safety budget."""


class PermanentFilingError(RuntimeError):
    """Raised when an official attachment cannot become searchable PDF text."""


def require_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


def clean_text(value: str | None) -> str:
    if not value:
        return ""
    value = re.sub(r"<[^>]*>", " ", value)
    return " ".join(html.unescape(value).split())


def normalize_case_number(value: str) -> str:
    value = value.strip().upper().replace(" ", "")
    if not value:
        return "UNKNOWN"
    return value if re.match(r"^[A-Z]", value) else f"FC{value}"


def docket_case_numbers(docket_number: str | None) -> list[str]:
    values = []
    for docket in (docket_number or "").split(","):
        case_label = docket.strip().rsplit(" - ", 1)[0].strip().upper().replace(" ", "")
        if re.match(r"^[A-Z][A-Z0-9-]{2,30}$", case_label):
            values.append(case_label)
    return list(dict.fromkeys(values))


def pdf_url(filing: dict[str, Any]) -> str:
    params = {
        "attachId": filing["attachmentId"],
        "guidFileName": filing["attachment"],
    }
    return requests.Request("GET", f"{EDOCKET_API}Filing/download", params=params).prepare().url


def dcpsc_retry_delay(attempt: int, retry_after: str | None = None) -> float:
    if retry_after:
        try:
            return min(60.0, max(0.0, float(retry_after)))
        except ValueError:
            pass
    return min(30.0, 2.0 ** attempt) + random.uniform(0.0, 1.0)


def dcpsc_request(
    method: str,
    url: str,
    *,
    session: requests.Session | None = None,
    attempts: int = DCPSC_REQUEST_ATTEMPTS,
    **kwargs: Any,
) -> requests.Response:
    """Call DC PSC with bounded exponential backoff for transient failures."""
    if attempts < 1:
        raise ValueError("attempts must be positive")
    client = session or requests
    for attempt in range(attempts):
        try:
            response = client.request(method, url, **kwargs)
        except requests.RequestException as error:
            if attempt == attempts - 1:
                raise
            delay = dcpsc_retry_delay(attempt)
            print(
                f"DC PSC request failed ({type(error).__name__}); "
                f"retrying in {delay:.1f}s ({attempt + 2}/{attempts}).",
                flush=True,
            )
            time.sleep(delay)
            continue

        if response.status_code not in DCPSC_RETRYABLE_STATUS_CODES:
            response.raise_for_status()
            return response
        if attempt == attempts - 1:
            response.raise_for_status()
        delay = dcpsc_retry_delay(attempt, response.headers.get("Retry-After"))
        status = response.status_code
        response.close()
        print(
            f"DC PSC returned HTTP {status}; retrying in {delay:.1f}s "
            f"({attempt + 2}/{attempts}).",
            flush=True,
        )
        time.sleep(delay)
    raise RuntimeError("unreachable")


def official_filing_total() -> int:
    with dcpsc_request(
        "GET",
        f"{EDOCKET_API}Filing/GetFilings",
        params={
            "caseNumber": "",
            "isAdmin": "false",
            "orderByColumn": "receivedDate",
            "sortBy": "asc",
            "recordsToSkip": 0,
            "recordsToShow": 1,
        },
        headers={"Accept": "application/json", "User-Agent": USER_AGENT},
        timeout=60,
    ) as response:
        return int(response.json().get("totalRecords") or 0)


def iter_filings(
    case_numbers: list[str],
    since_days: int,
    limit: int,
    start_offset: int = 0,
    oldest_first: bool = False,
    end_offset: int | None = None,
    on_page_scanned: Callable[[int], None] | None = None,
) -> Iterable[tuple[str, dict[str, Any], int]]:
    session = requests.Session()
    session.headers.update({"Accept": "application/json", "User-Agent": USER_AGENT})
    cutoff = datetime.now(timezone.utc) - timedelta(days=since_days) if since_days else None
    emitted = 0
    scopes = case_numbers or [""]

    for case_number in scopes:
        offset = start_offset if not case_numbers else 0
        total: int | None = None
        while (total is None or offset < total) and (
            end_offset is None or offset < end_offset
        ):
            with dcpsc_request(
                "GET",
                f"{EDOCKET_API}Filing/GetFilings",
                session=session,
                params={
                    "caseNumber": case_number.replace("FC", ""),
                    "isAdmin": "false",
                    "orderByColumn": "receivedDate",
                    "sortBy": "asc" if oldest_first else "desc",
                    "recordsToSkip": offset,
                    "recordsToShow": PAGE_SIZE,
                },
                timeout=60,
            ) as response:
                payload = response.json()
            total = int(payload.get("totalRecords") or 0)
            records = payload.get("resultsSet") or []
            if not records:
                break
            page_end = min(
                offset + len(records),
                total,
                end_offset if end_offset is not None else total,
            )
            reached_cutoff = False
            for record_index, filing in enumerate(records):
                absolute_offset = offset + record_index
                if end_offset is not None and absolute_offset >= end_offset:
                    break
                received = filing.get("receivedDate") or ""
                if cutoff and received:
                    try:
                        filed_at = datetime.fromisoformat(received.replace("Z", "+00:00"))
                        if filed_at.tzinfo is None:
                            filed_at = filed_at.replace(tzinfo=timezone.utc)
                        if filed_at < cutoff:
                            reached_cutoff = True
                            continue
                    except ValueError:
                        pass
                attachment = str(filing.get("attachment") or "")
                if (
                    filing.get("isConfidential")
                    or filing.get("isArchived")
                    or not filing.get("attachmentId")
                    or not attachment.lower().endswith(".pdf")
                ):
                    continue
                docket = str(filing.get("docketNumber") or case_number or "")
                docket_cases = docket_case_numbers(docket)
                normalized = docket_cases[0] if docket_cases else normalize_case_number(case_number)
                yield normalized, filing, absolute_offset + 1
                emitted += 1
                if limit and emitted >= limit:
                    return
            if on_page_scanned:
                on_page_scanned(page_end)
            if end_offset is not None and page_end >= end_offset:
                return
            if reached_cutoff and not case_numbers:
                break
            offset += PAGE_SIZE


def download_pdf(
    filing: dict[str, Any],
    destination: Path,
    attempts: int = DCPSC_REQUEST_ATTEMPTS,
) -> str:
    """Download a complete PDF, retrying both HTTP and streamed-body failures."""
    if attempts < 1:
        raise ValueError("attempts must be positive")
    url = pdf_url(filing)
    for attempt in range(attempts):
        try:
            with dcpsc_request(
                "GET",
                url,
                headers={"User-Agent": USER_AGENT},
                timeout=120,
                stream=True,
                attempts=1,
            ) as response:
                with destination.open("wb") as output:
                    for block in response.iter_content(1024 * 1024):
                        output.write(block)
            with destination.open("rb") as downloaded:
                signature = downloaded.read(5)
            if not signature.startswith(b"%PDF-"):
                raise PermanentFilingError("Downloaded attachment is not a PDF")
            return url
        except PermanentFilingError:
            destination.unlink(missing_ok=True)
            raise
        except (requests.RequestException, OSError) as error:
            destination.unlink(missing_ok=True)
            if attempt == attempts - 1:
                raise
            delay = dcpsc_retry_delay(attempt)
            print(
                f"PDF download failed ({type(error).__name__}); "
                f"retrying in {delay:.1f}s ({attempt + 2}/{attempts}).",
                flush=True,
            )
            time.sleep(delay)
    raise RuntimeError("unreachable")


def extract_pages(pdf_path: Path) -> list[dict[str, Any]]:
    try:
        document = fitz.open(pdf_path)
    except Exception as error:
        raise PermanentFilingError(f"Downloaded PDF cannot be opened: {error}") from error
    pages = []
    try:
        for number, page in enumerate(document, start=1):
            text_value = page.get_text("text", sort=True).strip()
            pages.append({"number": number, "text": text_value})
    except Exception as error:
        raise PermanentFilingError(f"Downloaded PDF cannot be read: {error}") from error
    finally:
        document.close()
    return pages


def compact_document_html(
    filing_id: int,
    case_number: str,
    pages: list[dict[str, Any]],
) -> bytes:
    """Build searchable page HTML without PDF images, fonts, or positioned spans."""
    page_html = "\n".join(
        f'<section data-page="{int(page["number"])}"><pre>'
        f'{html.escape(str(page.get("text") or ""))}</pre></section>'
        for page in pages
    )
    return (
        '<!doctype html><html><head><meta charset="utf-8"></head><body>'
        f'<main data-filing-id="{filing_id}" data-case="{html.escape(case_number)}">'
        f"{page_html}</main></body></html>"
    ).encode("utf-8")


def maybe_ocr(pdf_path: Path, pages: list[dict[str, Any]], enabled: bool) -> tuple[Path, int]:
    candidates = sum(1 for page in pages if len(page["text"]) < 40)
    if not enabled or candidates == 0:
        return pdf_path, 0
    output = pdf_path.with_name("ocr.pdf")
    command = [
        "ocrmypdf", "--skip-text", "--deskew", "--optimize", "1",
        "--output-type", "pdf", str(pdf_path), str(output),
    ]
    try:
        subprocess.run(command, check=True, timeout=1800)
        return output, candidates
    except (FileNotFoundError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        print(f"OCR skipped after failure: {error}")
        return pdf_path, 0


def related_case_numbers(case_number: str, docket_number: str | None) -> list[str]:
    # Bound D1 writes for unusually broad consolidated filings. The primary case
    # is always first, and twelve associations cover normal PSC filings while
    # keeping the daily write-budget estimate conservative.
    return list(dict.fromkeys([case_number.upper(), *docket_case_numbers(docket_number)]))[:12]


class CloudflareStore:
    def __init__(self) -> None:
        self.daily_rows_written = 0
        self.daily_r2_objects_written = 0
        self._budget_ready = False
        self.account_id = require_env("CLOUDFLARE_ACCOUNT_ID")
        database_ids = os.environ.get("CLOUDFLARE_D1_DATABASE_IDS", "").strip()
        self.database_ids = [value.strip() for value in database_ids.split(",") if value.strip()]
        if not self.database_ids:
            self.database_ids = [require_env("CLOUDFLARE_D1_DATABASE_ID")]
        self.api_token = require_env("CLOUDFLARE_API_TOKEN")
        self.bucket = require_env("R2_BUCKET_NAME")
        endpoint = os.environ.get("R2_ENDPOINT") or f"https://{self.account_id}.r2.cloudflarestorage.com"
        self.r2 = boto3.client(
            "s3",
            endpoint_url=endpoint,
            aws_access_key_id=require_env("R2_ACCESS_KEY_ID"),
            aws_secret_access_key=require_env("R2_SECRET_ACCESS_KEY"),
            region_name="auto",
        )
        self.d1_urls = [
            f"https://api.cloudflare.com/client/v4/accounts/{self.account_id}/d1/database/{database_id}/query"
            for database_id in self.database_ids
        ]
        self.r2_bytes = self._r2_storage_bytes()
        self.d1_bytes = [self._d1_storage_bytes(index) for index in range(len(self.d1_urls))]
        self.documents_written_this_run = 0
        self.budget_day = datetime.now(timezone.utc).date().isoformat()
        self._load_daily_budget()
        self._budget_ready = True
        print(
            "Free-tier guard: "
            f"R2 {self.r2_bytes / 1024 / 1024:.1f} MiB / 8192 MiB; "
            f"D1 shards {[round(value / 1024 / 1024, 1) for value in self.d1_bytes]} MiB / 400 MiB each; "
            f"daily D1 rows {self.daily_rows_written:,} / {MAX_D1_ROWS_WRITTEN_PER_DAY:,}; "
            f"daily R2 objects {self.daily_r2_objects_written:,} / {MAX_R2_OBJECTS_WRITTEN_PER_DAY:,}; "
            f"run documents 0 / {MAX_DOCUMENTS_PER_RUN}."
        )

    def query(
        self,
        sql: str,
        params: list[Any] | None = None,
        shard: int = 0,
        count_budget: bool = True,
    ) -> Any:
        response = requests.post(
            self.d1_urls[shard],
            headers={"Authorization": f"Bearer {self.api_token}", "Content-Type": "application/json"},
            json={"sql": sql, "params": params or []},
            timeout=120,
        )
        response.raise_for_status()
        payload = response.json()
        if not payload.get("success"):
            raise RuntimeError(json.dumps(payload.get("errors"), ensure_ascii=False))
        result = payload.get("result")
        if count_budget and self._budget_ready:
            self.daily_rows_written += sum(
                int(item.get("meta", {}).get("rows_written") or 0) for item in (result or [])
            )
        return result

    def _load_daily_budget(self) -> None:
        result = self.query(
            "SELECT rows_written, r2_objects_written FROM ingestion_daily_budget WHERE budget_day = ?",
            [self.budget_day],
            count_budget=False,
        )
        rows = result[0].get("results") if result else []
        if rows:
            self.daily_rows_written = int(rows[0].get("rows_written") or 0)
            self.daily_r2_objects_written = int(rows[0].get("r2_objects_written") or 0)

    def save_daily_budget(self) -> None:
        self.query(
            """INSERT INTO ingestion_daily_budget (
                 budget_day, rows_written, r2_objects_written, updated_at
               ) VALUES (?, ?, ?, ?)
               ON CONFLICT(budget_day) DO UPDATE SET
                 rows_written=excluded.rows_written,
                 r2_objects_written=excluded.r2_objects_written,
                 updated_at=excluded.updated_at""",
            [
                self.budget_day,
                self.daily_rows_written,
                self.daily_r2_objects_written,
                datetime.now(timezone.utc).isoformat(),
            ],
            count_budget=False,
        )

    def _r2_storage_bytes(self) -> int:
        total = 0
        paginator = self.r2.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=self.bucket):
            total += sum(int(item.get("Size") or 0) for item in page.get("Contents") or [])
        return total

    def _d1_pragma_value(self, name: str, shard: int) -> int:
        result = self.query(f"PRAGMA {name}", shard=shard)
        if not result or not result[0].get("results"):
            return 0
        row = result[0]["results"][0]
        return int(row.get(name) or next(iter(row.values()), 0))

    def _d1_storage_bytes(self, shard: int) -> int:
        return self._d1_pragma_value("page_count", shard) * self._d1_pragma_value("page_size", shard)

    def shard_for_filing(self, filing_id: int) -> int:
        return filing_id % len(self.d1_urls)

    def assert_within_free_tier(self, compressed_bytes: int, filing_id: int) -> None:
        if self.r2_bytes + compressed_bytes > MAX_R2_BYTES:
            raise FreeTierLimitReached(
                "R2 safety ceiling reached (8 GiB). No additional object was uploaded."
            )
        if self.documents_written_this_run + 1 > MAX_DOCUMENTS_PER_RUN:
            raise FreeTierLimitReached(
                f"Per-run safety ceiling reached ({MAX_DOCUMENTS_PER_RUN:,} documents)."
            )
        if self.daily_rows_written + 50 > MAX_D1_ROWS_WRITTEN_PER_DAY:
            raise FreeTierLimitReached(
                f"Daily D1 write budget reached ({MAX_D1_ROWS_WRITTEN_PER_DAY:,} rows)."
            )
        if self.daily_r2_objects_written + 1 > MAX_R2_OBJECTS_WRITTEN_PER_DAY:
            raise FreeTierLimitReached(
                f"Daily R2 object budget reached ({MAX_R2_OBJECTS_WRITTEN_PER_DAY:,} objects)."
            )
        estimated_growth = int(TERM_FILTER_BYTES * 1.35 + 1024)
        shard = self.shard_for_filing(filing_id)
        if self.d1_bytes[shard] + estimated_growth > MAX_D1_ESTIMATED_BYTES:
            raise FreeTierLimitReached(
                "D1 safety ceiling reached (estimated 400 MiB). No additional filing was indexed."
            )

    def record_write(self, compressed_bytes: int, filing_id: int) -> None:
        self.r2_bytes += compressed_bytes
        shard = self.shard_for_filing(filing_id)
        # Avoid two remote PRAGMA reads for every document. Use the same
        # conservative growth estimate as the pre-write guard and periodically
        # reconcile it with the database's actual allocated size.
        self.d1_bytes[shard] += int(TERM_FILTER_BYTES * 1.35 + 1024)
        self.documents_written_this_run += 1
        self.daily_r2_objects_written += 1
        if self.documents_written_this_run % 50 == 0:
            self.save_daily_budget()
        if self.documents_written_this_run % 250 == 0:
            self.d1_bytes = [
                self._d1_storage_bytes(index) for index in range(len(self.d1_urls))
            ]

    def upload_html(self, key: str, content: bytes) -> None:
        self.r2.put_object(
            Bucket=self.bucket,
            Key=key,
            Body=content,
            ContentType="text/html; charset=utf-8",
            ContentEncoding="gzip",
            CacheControl="private, max-age=31536000, immutable",
        )

    def has_document(self, filing_id: int) -> bool:
        shard = self.shard_for_filing(filing_id)
        result = self.query(
            "SELECT filing_id FROM documents WHERE filing_id = ? AND term_filter IS NOT NULL LIMIT 1",
            [filing_id],
            shard=shard,
        )
        return bool(result and result[0].get("results"))

    def ingestion_offset(self, scope: str) -> int:
        result = self.query("SELECT next_offset FROM ingestion_state WHERE scope = ?", [scope])
        rows = result[0].get("results") if result else []
        return int(rows[0].get("next_offset") or 0) if rows else 0

    def save_ingestion_offset(self, scope: str, next_offset: int) -> None:
        self.query(
            """INSERT INTO ingestion_state (scope, next_offset, updated_at) VALUES (?, ?, ?)
               ON CONFLICT(scope) DO UPDATE SET
                 next_offset=excluded.next_offset, updated_at=excluded.updated_at""",
            [scope, next_offset, datetime.now(timezone.utc).isoformat()],
        )

    def replace_document(
        self,
        case_number: str,
        filing: dict[str, Any],
        source_url: str,
        r2_key: str,
        pages: list[dict[str, Any]],
        ocr_count: int,
        digest: str,
        term_filter: bytes,
    ) -> None:
        filing_id = int(filing["filingId"])
        shard = self.shard_for_filing(filing_id)
        title = clean_text(filing.get("description")) or str(
            filing.get("attachmentFileName") or filing.get("attachment") or "PSC filing"
        )
        self.query(
            f"""INSERT INTO documents (
                 filing_id, case_number, docket_number, title, filer, filing_type,
                 received_date, official_pdf_url, r2_key, page_count, ocr_page_count,
                 content_sha256, indexed_at, term_filter
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, X'{term_filter.hex()}')
               ON CONFLICT(filing_id) DO UPDATE SET
                 case_number=excluded.case_number, docket_number=excluded.docket_number,
                 title=excluded.title, filer=excluded.filer, filing_type=excluded.filing_type,
                 received_date=excluded.received_date, official_pdf_url=excluded.official_pdf_url,
                 r2_key=excluded.r2_key, page_count=excluded.page_count,
                 ocr_page_count=excluded.ocr_page_count, content_sha256=excluded.content_sha256,
                 indexed_at=excluded.indexed_at, term_filter=excluded.term_filter""",
            [
                filing_id, case_number, filing.get("docketNumber"), title,
                clean_text(filing.get("companyOrIndividual")), clean_text(filing.get("filingType")),
                filing.get("receivedDate"), source_url, r2_key, len(pages), ocr_count, digest,
                datetime.now(timezone.utc).isoformat(),
            ],
            shard=shard,
        )
        for related_case in related_case_numbers(case_number, filing.get("docketNumber")):
            self.query(
                "INSERT OR IGNORE INTO document_cases (filing_id, case_number) VALUES (?, ?)",
                [filing_id, related_case],
                shard=shard,
            )


def process_filing(
    store: CloudflareStore,
    case_number: str,
    filing: dict[str, Any],
    use_ocr: bool,
    force: bool,
) -> None:
    filing_id = int(filing["filingId"])
    if not force and store.has_document(filing_id):
        print(f"Skipped already indexed {case_number} filing {filing_id}")
        return
    with tempfile.TemporaryDirectory(prefix=f"psc-{filing_id}-") as temp_dir:
        original = Path(temp_dir) / "source.pdf"
        source_url = download_pdf(filing, original)
        initial_pages = extract_pages(original)
        searchable_pdf, ocr_count = maybe_ocr(original, initial_pages, use_ocr)
        pages = extract_pages(searchable_pdf) if searchable_pdf != original else initial_pages
        document_html = compact_document_html(filing_id, case_number, pages)
        compressed = gzip.compress(document_html, compresslevel=9)
        digest = hashlib.sha256(document_html).hexdigest()
        year = str(filing.get("receivedDate") or "unknown")[:4]
        key = f"filings/{year}/{filing_id}.html.gz"
        term_filter = create_term_filter("\n".join(page["text"] for page in pages))
        store.assert_within_free_tier(len(compressed), filing_id)
        store.upload_html(key, compressed)
        store.replace_document(case_number, filing, source_url, key, pages, ocr_count, digest, term_filter)
        store.record_write(len(compressed), filing_id)
        print(f"Indexed {case_number} filing {filing_id}: {len(pages)} pages, compact filter, {ocr_count} OCR pages")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cases", default="", help="Comma-separated formal cases, e.g. 1176,1183")
    parser.add_argument("--since-days", type=int, default=0, help="Only recent filings; intended for scheduled runs")
    parser.add_argument("--limit", type=int, default=0, help="Maximum filings for this run")
    parser.add_argument("--no-ocr", action="store_true", help="Do not OCR image-only pages")
    parser.add_argument("--force", action="store_true", help="Replace filings that are already indexed")
    parser.add_argument("--all", action="store_true", help="Resume the oldest-first backfill of every public filing")
    args = parser.parse_args()
    cases = [normalize_case_number(value) for value in args.cases.split(",") if value.strip()]
    if args.all and cases:
        raise RuntimeError("Use either --all or --cases, not both.")
    if not args.all and not cases and not args.since_days and not args.limit:
        raise RuntimeError("A full unbounded crawl requires --all.")
    store = CloudflareStore()
    scope = "all-public-filings-v1"
    start_offset = store.ingestion_offset(scope) if args.all else 0
    if args.all:
        print(f"Resuming all-case backfill at official filing offset {start_offset:,}.")
    failures = 0
    completed_offset = start_offset
    processed_since_checkpoint = 0
    for case_number, filing, next_offset in iter_filings(
        cases,
        0 if args.all else args.since_days,
        args.limit,
        start_offset=start_offset,
        oldest_first=args.all,
    ):
        try:
            process_filing(store, case_number, filing, not args.no_ocr, args.force)
            if args.all:
                completed_offset = next_offset
                processed_since_checkpoint += 1
                if processed_since_checkpoint >= 100:
                    store.save_ingestion_offset(scope, completed_offset)
                    processed_since_checkpoint = 0
        except FreeTierLimitReached as error:
            print(f"STOPPED BY FREE-TIER GUARD: {error}")
            break
        except Exception as error:  # Continue the crawl; report failed filing IDs in the job log.
            failures += 1
            print(f"FAILED filing {filing.get('filingId')}: {error}")
    if args.all and completed_offset != start_offset:
        store.save_ingestion_offset(scope, completed_offset)
        print(f"Saved all-case cursor at official filing offset {completed_offset:,}.")
    store.save_daily_budget()
    if failures:
        raise RuntimeError(f"Indexing completed with {failures} failed filing(s)")


if __name__ == "__main__":
    main()
