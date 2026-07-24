from __future__ import annotations

import sys
import unittest
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


if __name__ == "__main__":
    unittest.main()
