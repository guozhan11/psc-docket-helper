from __future__ import annotations

import sys
import unittest
import unittest.mock
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import usage_report


def at(minute: str) -> datetime:
    return datetime.fromisoformat(f"2026-08-22T{minute}:00+00:00")


class ScheduledTrafficTests(unittest.TestCase):
    def test_a_workflow_run_claims_only_its_own_request(self) -> None:
        minutes = [(at("07:52"), 10)]
        explained, residual = usage_report.subtract_scheduled_traffic(
            minutes,
            [(at("07:52"), 1)],
        )

        # The health monitor sends one request, so the other nine are a visitor.
        self.assertEqual(explained, 1)
        self.assertEqual(residual, {at("07:52"): 9})

    def test_a_queued_runner_still_matches(self) -> None:
        explained, residual = usage_report.subtract_scheduled_traffic(
            [(at("08:04"), 1)],
            [(at("08:00"), 1)],
        )

        self.assertEqual(explained, 1)
        self.assertEqual(residual, {})

    def test_a_request_long_after_a_run_is_not_credited_to_it(self) -> None:
        explained, residual = usage_report.subtract_scheduled_traffic(
            [(at("08:30"), 1)],
            [(at("08:00"), 1)],
        )

        self.assertEqual(explained, 0)
        self.assertEqual(residual, {at("08:30"): 1})

    def test_overlapping_runs_pool_their_allowances(self) -> None:
        explained, residual = usage_report.subtract_scheduled_traffic(
            [(at("13:15"), 3)],
            [(at("13:15"), 1), (at("13:14"), 2)],
        )

        self.assertEqual(explained, 3)
        self.assertEqual(residual, {})

    def test_unused_allowance_never_offsets_another_minute(self) -> None:
        explained, residual = usage_report.subtract_scheduled_traffic(
            [(at("09:00"), 1), (at("11:00"), 5)],
            [(at("09:00"), 2), (at("11:00"), 1)],
        )

        # The 09:00 run leaves an unused request; it must not silently absorb
        # the visitor traffic at 11:00.
        self.assertEqual(explained, 2)
        self.assertEqual(residual, {at("11:00"): 4})


class VisitGroupingTests(unittest.TestCase):
    def test_nearby_minutes_form_one_visit(self) -> None:
        residual = {at("07:52"): 8, at("07:54"): 3}

        visits = usage_report.group_visits(residual)

        self.assertEqual(len(visits), 1)
        started, requests, span = visits[0]
        self.assertEqual(started, at("07:52"))
        self.assertEqual(requests, 11)
        self.assertEqual(span, 2.0)

    def test_a_long_gap_starts_a_new_visit(self) -> None:
        gap = usage_report.SESSION_GAP_MINUTES + 1
        later = at("07:52") + timedelta(minutes=gap)
        residual = {at("07:52"): 8, later: 8}

        visits = usage_report.group_visits(residual)

        self.assertEqual([requests for _start, requests, _span in visits], [8, 8])

    def test_no_residual_traffic_yields_no_visits(self) -> None:
        self.assertEqual(usage_report.group_visits({}), [])


class CredentialTests(unittest.TestCase):
    def test_an_explicit_api_token_wins(self) -> None:
        with unittest.mock.patch.dict(
            usage_report.os.environ,
            {"CLOUDFLARE_API_TOKEN": "explicit-token"},
        ):
            self.assertEqual(usage_report.cloudflare_token(), "explicit-token")

    def test_an_expired_wrangler_login_is_reported(self) -> None:
        stale = datetime.now(timezone.utc) - timedelta(days=1)
        config = (
            'oauth_token = "stale"\n'
            f'expiration_time = "{stale.isoformat()}"\n'
        )

        with unittest.mock.patch.dict(
            usage_report.os.environ,
            {"CLOUDFLARE_API_TOKEN": ""},
        ):
            with unittest.mock.patch.object(
                usage_report.Path, "exists", return_value=True
            ), unittest.mock.patch.object(
                usage_report.Path, "read_text", return_value=config
            ):
                with self.assertRaisesRegex(usage_report.UsageReportError, "expired"):
                    usage_report.cloudflare_token()


if __name__ == "__main__":
    unittest.main()
