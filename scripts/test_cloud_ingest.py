from __future__ import annotations

import sys
import tempfile
import unittest
from contextlib import nullcontext
from pathlib import Path
from unittest.mock import Mock, patch

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))

import cloud_ingest


class FakeResponse:
    def __init__(self, status_code: int, retry_after: str | None = None) -> None:
        self.status_code = status_code
        self.headers = {"Retry-After": retry_after} if retry_after else {}
        self.closed = False

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise requests.HTTPError(f"HTTP {self.status_code}", response=self)

    def close(self) -> None:
        self.closed = True


class DcpscRequestTests(unittest.TestCase):
    @patch.object(cloud_ingest.time, "sleep")
    @patch.object(cloud_ingest.random, "uniform", return_value=0.25)
    def test_retries_502_with_exponential_backoff(
        self,
        _uniform: Mock,
        sleep: Mock,
    ) -> None:
        first = FakeResponse(502)
        success = FakeResponse(200)
        session = Mock()
        session.request.side_effect = [first, success]

        response = cloud_ingest.dcpsc_request(
            "GET",
            "https://example.test",
            session=session,
            attempts=2,
            timeout=1,
        )

        self.assertIs(response, success)
        self.assertTrue(first.closed)
        self.assertEqual(session.request.call_count, 2)
        sleep.assert_called_once_with(1.25)

    @patch.object(cloud_ingest.time, "sleep")
    def test_honors_numeric_retry_after(self, sleep: Mock) -> None:
        limited = FakeResponse(429, retry_after="7")
        success = FakeResponse(200)
        session = Mock()
        session.request.side_effect = [limited, success]

        cloud_ingest.dcpsc_request(
            "GET",
            "https://example.test",
            session=session,
            attempts=2,
        )

        sleep.assert_called_once_with(7.0)

    @patch.object(cloud_ingest.time, "sleep")
    def test_retries_connection_errors(self, sleep: Mock) -> None:
        success = FakeResponse(200)
        session = Mock()
        session.request.side_effect = [requests.ConnectionError("offline"), success]

        with patch.object(cloud_ingest, "dcpsc_retry_delay", return_value=2.5):
            response = cloud_ingest.dcpsc_request(
                "GET",
                "https://example.test",
                session=session,
                attempts=2,
            )

        self.assertIs(response, success)
        sleep.assert_called_once_with(2.5)

    @patch.object(cloud_ingest.time, "sleep")
    def test_exhausted_transient_retries_report_an_outage(self, _sleep: Mock) -> None:
        session = Mock()
        session.request.return_value = FakeResponse(502)

        with self.assertRaises(cloud_ingest.DCPSCUnavailableError) as caught:
            cloud_ingest.dcpsc_request(
                "GET",
                "https://example.test",
                session=session,
                attempts=3,
            )

        # Callers holding a resumable cursor tell an outage apart from a bug by
        # type, while per-request retry loops still see a RequestException.
        self.assertIsInstance(caught.exception, requests.RequestException)
        self.assertIn("502", str(caught.exception))
        self.assertEqual(session.request.call_count, 3)

    @patch.object(cloud_ingest.time, "sleep")
    def test_exhausted_connection_errors_report_an_outage(self, _sleep: Mock) -> None:
        session = Mock()
        session.request.side_effect = requests.ConnectionError("offline")

        with self.assertRaises(cloud_ingest.DCPSCUnavailableError):
            cloud_ingest.dcpsc_request(
                "GET",
                "https://example.test",
                session=session,
                attempts=2,
            )

        self.assertEqual(session.request.call_count, 2)

    @patch.object(cloud_ingest.time, "sleep")
    def test_does_not_retry_non_transient_400(self, sleep: Mock) -> None:
        session = Mock()
        session.request.return_value = FakeResponse(400)

        with self.assertRaises(requests.HTTPError):
            cloud_ingest.dcpsc_request(
                "GET",
                "https://example.test",
                session=session,
                attempts=6,
            )

        self.assertEqual(session.request.call_count, 1)
        sleep.assert_not_called()


class FilingIteratorTests(unittest.TestCase):
    def test_resumes_from_nonzero_offset(self) -> None:
        response = Mock()
        response.json.return_value = {
            "totalRecords": 62_501,
            "resultsSet": [{
                "filingId": 9001,
                "docketNumber": "FC1176",
                "attachment": "filing.pdf",
                "attachmentId": 77,
                "isConfidential": False,
                "isArchived": False,
            }],
        }

        with patch.object(
            cloud_ingest,
            "dcpsc_request",
            return_value=nullcontext(response),
        ) as request:
            rows = list(cloud_ingest.iter_filings(
                [],
                0,
                0,
                start_offset=62_500,
                oldest_first=True,
                end_offset=62_501,
            ))

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0][2], 62_501)
        self.assertEqual(request.call_args.kwargs["params"]["recordsToSkip"], 62_500)

    def test_reports_scanned_page_without_eligible_filings(self) -> None:
        response = Mock()
        response.json.return_value = {
            "totalRecords": 62_600,
            "resultsSet": [
                {
                    "filingId": index,
                    "attachment": "filing.pdf",
                    "attachmentId": index,
                    "isConfidential": False,
                    "isArchived": True,
                }
                for index in range(100)
            ],
        }
        scanned: list[int] = []

        with patch.object(
            cloud_ingest,
            "dcpsc_request",
            return_value=nullcontext(response),
        ):
            rows = list(cloud_ingest.iter_filings(
                [],
                0,
                0,
                start_offset=62_500,
                oldest_first=True,
                end_offset=62_600,
                on_page_scanned=scanned.append,
            ))

        self.assertEqual(rows, [])
        self.assertEqual(scanned, [62_600])

    def test_compact_html_keeps_text_and_omits_pdf_layout_data(self) -> None:
        body = cloud_ingest.compact_document_html(
            42,
            "FC1176",
            [{"number": 1, "text": "Rate < increase & review"}],
        ).decode("utf-8")

        self.assertIn('<section data-page="1"><pre>', body)
        self.assertIn("Rate &lt; increase &amp; review", body)
        self.assertNotIn("data:image", body)
        self.assertNotIn("position:absolute", body)


class PdfDownloadTests(unittest.TestCase):
    @patch.object(cloud_ingest.time, "sleep")
    @patch.object(cloud_ingest, "dcpsc_retry_delay", return_value=1.5)
    def test_retries_an_incomplete_stream(
        self,
        _retry_delay: Mock,
        sleep: Mock,
    ) -> None:
        broken = Mock()
        broken.__enter__ = Mock(return_value=broken)
        broken.__exit__ = Mock(return_value=False)
        broken.iter_content.return_value = iter([
            b"%PDF-partial",
        ])
        good = Mock()
        good.__enter__ = Mock(return_value=good)
        good.__exit__ = Mock(return_value=False)
        good.iter_content.return_value = iter([b"%PDF-complete"])

        def first_stream(_size: int):
            yield b"%PDF-partial"
            raise requests.exceptions.ChunkedEncodingError("incomplete")

        broken.iter_content.side_effect = first_stream
        filing = {"attachmentId": 1, "attachment": "document.pdf"}
        with tempfile.TemporaryDirectory() as temp_dir:
            destination = Path(temp_dir) / "document.pdf"
            with patch.object(
                cloud_ingest,
                "dcpsc_request",
                side_effect=[broken, good],
            ) as request:
                cloud_ingest.download_pdf(filing, destination, attempts=2)

            self.assertEqual(destination.read_bytes(), b"%PDF-complete")
        self.assertEqual(request.call_count, 2)
        sleep.assert_called_once_with(1.5)

    @patch.object(cloud_ingest.time, "sleep")
    @patch.object(cloud_ingest, "dcpsc_retry_delay", return_value=1.5)
    def test_retries_a_transient_status_from_the_attachment_endpoint(
        self,
        _retry_delay: Mock,
        _sleep: Mock,
    ) -> None:
        # download_pdf owns its own retry loop, so an outage raised by the inner
        # single-attempt request must stay catchable as a RequestException.
        good = Mock()
        good.__enter__ = Mock(return_value=good)
        good.__exit__ = Mock(return_value=False)
        good.iter_content.return_value = iter([b"%PDF-complete"])
        filing = {"attachmentId": 1, "attachment": "document.pdf"}

        with tempfile.TemporaryDirectory() as temp_dir:
            destination = Path(temp_dir) / "document.pdf"
            with patch.object(
                cloud_ingest,
                "dcpsc_request",
                side_effect=[
                    cloud_ingest.DCPSCUnavailableError("HTTP 503"),
                    good,
                ],
            ) as request:
                cloud_ingest.download_pdf(filing, destination, attempts=2)

            self.assertEqual(destination.read_bytes(), b"%PDF-complete")
        self.assertEqual(request.call_count, 2)

    def test_non_pdf_is_permanently_unavailable_without_retry(self) -> None:
        response = Mock()
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        response.iter_content.return_value = iter([b"<html>missing</html>"])
        filing = {"attachmentId": 1, "attachment": "document.pdf"}

        with tempfile.TemporaryDirectory() as temp_dir:
            destination = Path(temp_dir) / "document.pdf"
            with patch.object(
                cloud_ingest,
                "dcpsc_request",
                return_value=response,
            ) as request:
                with self.assertRaises(cloud_ingest.PermanentFilingError):
                    cloud_ingest.download_pdf(filing, destination, attempts=3)

        request.assert_called_once()


if __name__ == "__main__":
    unittest.main()
