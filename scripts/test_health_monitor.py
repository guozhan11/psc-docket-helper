import unittest

from parse_health_response import health_outputs


class HealthMonitorTests(unittest.TestCase):
    def test_live_degraded_response_preserves_named_issues(self) -> None:
        self.assertEqual(
            health_outputs("503", {"status": "degraded", "issues": ["term-index-stale"]}),
            ("degraded", "term-index-stale"),
        )

    def test_last_known_good_never_closes_a_live_alert(self) -> None:
        self.assertEqual(
            health_outputs(
                "200",
                {
                    "status": "ok",
                    "issues": [],
                    "healthSource": "last-known-good",
                    "liveIssues": ["case-router-unavailable"],
                },
            ),
            ("degraded", "case-router-unavailable"),
        )

    def test_unparseable_failure_is_unreachable(self) -> None:
        self.assertEqual(health_outputs("000", None), ("unreachable", "HTTP 000"))


if __name__ == "__main__":
    unittest.main()
