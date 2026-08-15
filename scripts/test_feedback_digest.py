import unittest

from build_feedback_digest import build_digest


class FeedbackDigestTests(unittest.TestCase):
    def test_digest_summarizes_votes_and_includes_negative_context(self):
        digest = build_digest({
            "feedback": [
                {"rating": "up"},
                {
                    "rating": "down",
                    "reason": "citation",
                    "updated_at": "2026-08-15T12:00:00Z",
                    "request_id": "123e4567-e89b-42d3-a456-426614174000",
                    "question": "Which order decided this?",
                    "answer_excerpt": "The Commission decided it in Order 1.",
                    "comment": "The link points to a different order.",
                },
            ]
        })
        self.assertIn("Useful: **1**", digest)
        self.assertIn("Needs improvement: **1**", digest)
        self.assertIn("Citation or source problem", digest)
        self.assertIn("    Which order decided this?", digest)
        self.assertIn("    The link points to a different order.", digest)

    def test_digest_rejects_an_invalid_report(self):
        with self.assertRaises(ValueError):
            build_digest({"feedback": "not-a-list"})


if __name__ == "__main__":
    unittest.main()
