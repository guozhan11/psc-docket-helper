#!/usr/bin/env python3
"""Build a reviewable GitHub Issue body from the pending feedback API payload."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


REASON_LABELS = {
    "incorrect": "Incorrect or misleading",
    "missing": "Missed important information",
    "citation": "Citation or source problem",
    "unclear": "Unclear or hard to use",
    "other": "Other",
}


def _safe_text(value: Any, limit: int) -> str:
    if not isinstance(value, str):
        return "Not provided"
    cleaned = "".join(character for character in value if character in "\n\t" or ord(character) >= 32)
    cleaned = cleaned.strip()
    if not cleaned:
        return "Not provided"
    return cleaned[:limit] + ("…" if len(cleaned) > limit else "")


def _indented(value: Any, limit: int) -> str:
    return "\n".join(f"    {line}" for line in _safe_text(value, limit).splitlines())


def build_digest(payload: Any) -> str:
    if not isinstance(payload, dict) or not isinstance(payload.get("feedback"), list):
        raise ValueError("Feedback report must contain a feedback list")
    rows = [row for row in payload["feedback"] if isinstance(row, dict)]
    up = sum(row.get("rating") == "up" for row in rows)
    down_rows = [row for row in rows if row.get("rating") == "down"]
    lines = [
        "## Answer feedback summary",
        "",
        f"- 👍 Useful: **{up}**",
        f"- 👎 Needs improvement: **{len(down_rows)}**",
        f"- Total responses in this digest: **{len(rows)}**",
        "",
        "Review the negative responses below and decide which should become product or retrieval fixes.",
    ]
    for index, row in enumerate(down_rows, start=1):
        reason = REASON_LABELS.get(row.get("reason"), "Unspecified")
        lines.extend([
            "",
            f"### {index}. {reason}",
            "",
            f"- Submitted: `{_safe_text(row.get('updated_at'), 40)}`",
            f"- Request ID: `{_safe_text(row.get('request_id'), 40)}`",
            "",
            "**Question**",
            "",
            _indented(row.get("question"), 1_500),
            "",
            "**Answer excerpt**",
            "",
            _indented(row.get("answer_excerpt"), 2_500),
            "",
            "**User comment**",
            "",
            _indented(row.get("comment"), 1_000),
        ])
    lines.extend([
        "",
        "---",
        "This digest was generated automatically from the site's answer feedback controls.",
    ])
    return "\n".join(lines) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("report", type=Path)
    args = parser.parse_args()
    payload = json.loads(args.report.read_text(encoding="utf-8"))
    print(build_digest(payload), end="")


if __name__ == "__main__":
    main()
