#!/usr/bin/env python3
"""Translate the Worker health response into safe GitHub Actions outputs."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


def _issue_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [
        str(item).replace("\r", " ").replace("\n", " ").strip()
        for item in value
        if str(item).strip()
    ]


def health_outputs(http_code: str, payload: Any) -> tuple[str, str]:
    """Return a status and compact issue summary without trusting cached OKs."""
    record = payload if isinstance(payload, dict) else {}
    status_value = record.get("status")
    status = status_value if isinstance(status_value, str) and status_value else "unknown"
    live_issues = _issue_list(record.get("liveIssues"))
    issues = live_issues or _issue_list(record.get("issues"))

    # A last-known-good payload intentionally retains its old status=ok. The
    # live fields are authoritative for monitoring and must not close an alert.
    if record.get("healthSource") == "last-known-good" or live_issues:
        status = "degraded"
        if not issues:
            issues = ["last-known-good-health"]

    if http_code != "200" and status == "unknown":
        status = "unreachable"
    elif http_code != "200" and status == "ok":
        status = "unreachable"

    if status != "ok" and not issues:
        issues = [f"HTTP {http_code}"]
    return status, ", ".join(issues) or "none"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--http-code", required=True)
    parser.add_argument("--response", type=Path, required=True)
    args = parser.parse_args()
    try:
        payload = json.loads(args.response.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        payload = None
    status, issues = health_outputs(args.http_code, payload)
    print(f"status={status}")
    print(f"issues={issues}")


if __name__ == "__main__":
    main()
