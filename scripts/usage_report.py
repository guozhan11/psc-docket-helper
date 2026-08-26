#!/usr/bin/env python3
"""Report how much real traffic the deployed assistant received.

Cloudflare counts every Worker invocation, and this project's own scheduled
GitHub Actions workflows account for nearly all of them: `Monitor health` polls
`/api/health` roughly every forty minutes, and `Report answer feedback` reads
the feedback endpoint once a day. Reading the raw invocation count therefore
overstates human traffic by an order of magnitude.

This script subtracts that machine traffic by matching invocation minutes
against the workflow runs that caused them, then reports what is left. It also
reads AI Gateway, where every answered question appears exactly once, because
that is the only unambiguous record of somebody actually asking something.

Path-level Workers Logs would make the subtraction unnecessary, but querying
them needs an API token with the Workers Observability scope, which the wrangler
OAuth login does not carry.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable

GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql"
SCRIPT_NAME = "psc-docket-assistant"
ACCOUNT_TAG = "ec47eefb8bdd84301fd0dba3c74578b8"

# Cloudflare rejects analytics queries spanning more than this.
MAX_QUERY_DAYS = 28

SITE_URL = "https://psc-docket-assistant.psc-docket-helper.workers.dev"

# One page view fires /api/news, /api/config, /api/health, and one
# /api/verify-link per news item, so the feed length sets the total. It is
# probed rather than hardcoded because the feed changes; this fallback only
# applies when the probe fails.
FIXED_PAGE_REQUESTS = 3
FALLBACK_REQUESTS_PER_VIEW = 8

# Requests each scheduled workflow run sends to the Worker. The health monitor
# curls the endpoint once; its retry loop wraps `gh` calls, not the Worker. The
# feedback reporter reads the report and, only when feedback is pending, posts
# an acknowledgement.
WORKFLOW_REQUESTS = {
    "monitor-health.yml": 1,
    "report-answer-feedback.yml": 2,
}

# A queued runner starts late, so credit a run for requests landing shortly
# after it was created rather than exactly on the minute.
MATCH_WINDOW_MINUTES = (-1, 5)

# Residual requests further apart than this are counted as separate visits.
SESSION_GAP_MINUTES = 20


class UsageReportError(RuntimeError):
    """Raised for a failure the operator has to act on."""


def cloudflare_token() -> str:
    """Prefer an explicit API token, else reuse the wrangler OAuth login."""
    token = os.environ.get("CLOUDFLARE_API_TOKEN", "").strip()
    if token:
        return token

    config = (
        Path.home()
        / "Library/Preferences/.wrangler/config/default.toml"
    )
    if not config.exists():
        config = Path.home() / ".wrangler/config/default.toml"
    if not config.exists():
        raise UsageReportError(
            "No Cloudflare credentials. Set CLOUDFLARE_API_TOKEN, or run "
            "`npx wrangler login`."
        )

    text = config.read_text()
    match = re.search(r'oauth_token\s*=\s*"([^"]+)"', text)
    if not match:
        raise UsageReportError(f"No oauth_token in {config}; run `npx wrangler login`.")

    expiry = re.search(r'expiration_time\s*=\s*"([^"]+)"', text)
    if expiry:
        try:
            expires_at = datetime.fromisoformat(expiry.group(1).replace("Z", "+00:00"))
        except ValueError:
            expires_at = None
        if expires_at and expires_at < datetime.now(timezone.utc):
            raise UsageReportError(
                "The wrangler OAuth token has expired. Run `npx wrangler whoami` "
                "to refresh it, then retry."
            )
    return match.group(1)


def probe_requests_per_view() -> tuple[int, str]:
    """Measure a page view against the live news feed, which sets its size."""
    # The Worker answers 403 without a declared client, so identify this probe.
    request = urllib.request.Request(
        f"{SITE_URL}/api/news",
        headers={
            "Accept": "application/json",
            "User-Agent": "PSC-Docket-Assistant-UsageReport/1.0",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            items = json.load(response)
        if not isinstance(items, list):
            raise ValueError("news did not return a list")
    except (urllib.error.URLError, ValueError, json.JSONDecodeError, TimeoutError):
        return FALLBACK_REQUESTS_PER_VIEW, "assumed; the news feed did not answer"
    count = FIXED_PAGE_REQUESTS + len(items)
    return count, f"measured: 3 fixed calls plus {len(items)} news link check(s)"


def graphql(token: str, query: str) -> dict[str, Any]:
    request = urllib.request.Request(
        GRAPHQL_URL,
        data=json.dumps({"query": query}).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            payload = json.load(response)
    except urllib.error.HTTPError as error:
        raise UsageReportError(
            f"Cloudflare analytics returned HTTP {error.code}. An expired or "
            "under-scoped token is the usual cause."
        ) from error
    except urllib.error.URLError as error:
        raise UsageReportError(f"Cloudflare analytics unreachable: {error}") from error

    if payload.get("errors"):
        message = "; ".join(item.get("message", "") for item in payload["errors"])
        raise UsageReportError(f"Cloudflare analytics rejected the query: {message}")
    return payload["data"]["viewer"]["accounts"][0]


def invocation_minutes(token: str, start: str, end: str) -> list[tuple[datetime, int]]:
    data = graphql(
        token,
        f"""query {{ viewer {{ accounts(filter: {{accountTag: "{ACCOUNT_TAG}"}}) {{
            workersInvocationsAdaptive(
                limit: 5000,
                orderBy: [datetimeMinute_ASC],
                filter: {{
                    scriptName: "{SCRIPT_NAME}",
                    date_geq: "{start}",
                    date_leq: "{end}"
                }}
            ) {{ dimensions {{ datetimeMinute }} sum {{ requests }} }}
        }} }} }}""",
    )
    return [
        (parse_time(row["dimensions"]["datetimeMinute"]), row["sum"]["requests"])
        for row in data["workersInvocationsAdaptive"]
    ]


def llm_calls_by_day(token: str, start: str, end: str) -> list[tuple[str, int, float]]:
    data = graphql(
        token,
        f"""query {{ viewer {{ accounts(filter: {{accountTag: "{ACCOUNT_TAG}"}}) {{
            aiGatewayRequestsAdaptiveGroups(
                limit: 500,
                orderBy: [date_ASC],
                filter: {{date_geq: "{start}", date_leq: "{end}"}}
            ) {{ dimensions {{ date }} count sum {{ cost }} }}
        }} }} }}""",
    )
    return [
        (row["dimensions"]["date"], row["count"], row["sum"]["cost"])
        for row in data["aiGatewayRequestsAdaptiveGroups"]
    ]


def workflow_runs(workflow: str, since: datetime) -> list[datetime]:
    """Read run start times through `gh`, which is already a project dependency."""
    try:
        completed = subprocess.run(
            [
                "gh", "run", "list",
                "--workflow", workflow,
                "--limit", "1000",
                "--created", f">={since:%Y-%m-%d}",
                "--json", "createdAt",
                "-q", ".[].createdAt",
            ],
            capture_output=True,
            text=True,
            timeout=120,
        )
    except FileNotFoundError as error:
        raise UsageReportError(
            "The GitHub CLI (`gh`) is required to identify scheduled traffic."
        ) from error
    if completed.returncode != 0:
        raise UsageReportError(
            f"`gh run list` failed for {workflow}: {completed.stderr.strip()}"
        )
    return sorted(parse_time(line) for line in completed.stdout.split() if line.strip())


def parse_time(value: str) -> datetime:
    return datetime.fromisoformat(value.strip().replace("Z", "+00:00"))


def subtract_scheduled_traffic(
    minutes: Iterable[tuple[datetime, int]],
    scheduled: Iterable[tuple[datetime, int]],
) -> tuple[int, dict[datetime, int]]:
    """Split invocations into scheduled traffic and everything else.

    `scheduled` pairs each workflow run with how many requests it may claim. A
    run only ever accounts for its own requests, so a minute carrying more than
    the runs near it explain keeps the surplus as residual traffic.
    """
    runs = sorted(scheduled)
    explained = 0
    residual: dict[datetime, int] = {}
    for minute, requests in minutes:
        budget = sum(
            allowance
            for started, allowance in runs
            if MATCH_WINDOW_MINUTES[0]
            <= (minute - started).total_seconds() / 60
            <= MATCH_WINDOW_MINUTES[1]
        )
        claimed = min(requests, budget)
        explained += claimed
        if requests > claimed:
            residual[minute] = requests - claimed
    return explained, residual


def group_visits(residual: dict[datetime, int]) -> list[tuple[datetime, int, float]]:
    """Collapse residual minutes into visits, one entry per burst."""
    visits: list[tuple[datetime, int, float]] = []
    current: list[datetime] = []

    def close(bucket: list[datetime]) -> None:
        if bucket:
            span = (bucket[-1] - bucket[0]).total_seconds() / 60
            visits.append((bucket[0], sum(residual[t] for t in bucket), span))

    for minute in sorted(residual):
        if current and (minute - current[-1]).total_seconds() / 60 > SESSION_GAP_MINUTES:
            close(current)
            current = []
        current.append(minute)
    close(current)
    return visits


def render(
    *,
    days: int,
    start: datetime,
    end: datetime,
    total_requests: int,
    explained: int,
    residual: dict[datetime, int],
    visits: list[tuple[datetime, int, float]],
    llm: list[tuple[str, int, float]],
    requests_per_view: int,
    divisor_source: str,
) -> None:
    print(f"Usage for the last {days} day(s): {start:%Y-%m-%d} to {end:%Y-%m-%d} UTC")
    print()

    answered = sum(count for _date, count, _cost in llm)
    print(f"Questions answered: {answered}")
    if llm:
        for date, count, cost in llm:
            print(f"  {date}  {count:4d} LLM call(s)  ${cost:.3f}")
        print(f"  total cost: ${sum(cost for _d, _c, cost in llm):.3f}")
    else:
        print("  No LLM call reached AI Gateway, so nobody asked anything.")
    print()

    leftover = sum(residual.values())
    print(f"Worker invocations: {total_requests}")
    print(f"  scheduled GitHub Actions traffic: {explained}")
    print(f"  everything else:                  {leftover}")
    print()

    if leftover:
        print(
            f"Visits, at {requests_per_view} requests per page view "
            f"({divisor_source}):"
        )
        for started, requests, span in visits:
            window = f" over {span:.0f} min" if span else ""
            print(
                f"  {started:%Y-%m-%d %H:%M} UTC  {requests:3d} request(s)"
                f"{window}  ~{requests / requests_per_view:.1f} view(s)"
            )
    else:
        print("No traffic beyond the scheduled workflows.")
    print()

    print(
        "The answered-question count is exact; every answer calls the model once "
        "through AI Gateway. The visit count is an estimate: Workers Logs would "
        "give per-path truth but needs an API token with the Observability scope, "
        "which the wrangler login does not carry. Static assets bypass the Worker, "
        "so a visitor whose browser never ran the app leaves no trace here."
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--days",
        type=int,
        default=7,
        help=f"Days to report, at most {MAX_QUERY_DAYS}",
    )
    parser.add_argument(
        "--requests-per-view",
        type=int,
        default=0,
        help="Override the probed number of API requests one page view sends",
    )
    args = parser.parse_args()
    if not 1 <= args.days <= MAX_QUERY_DAYS:
        raise UsageReportError(f"--days must be between 1 and {MAX_QUERY_DAYS}")
    if args.requests_per_view < 0:
        raise UsageReportError("--requests-per-view must be positive")
    if args.requests_per_view:
        requests_per_view, divisor_source = args.requests_per_view, "given on the command line"
    else:
        requests_per_view, divisor_source = probe_requests_per_view()

    end = datetime.now(timezone.utc)
    start = (end - timedelta(days=args.days - 1)).replace(
        hour=0, minute=0, second=0, microsecond=0
    )

    token = cloudflare_token()
    minutes = invocation_minutes(token, f"{start:%Y-%m-%d}", f"{end:%Y-%m-%d}")
    minutes = [(minute, count) for minute, count in minutes if minute >= start]

    scheduled: list[tuple[datetime, int]] = []
    for workflow, requests_per_run in WORKFLOW_REQUESTS.items():
        for started in workflow_runs(workflow, start - timedelta(days=1)):
            scheduled.append((started, requests_per_run))

    explained, residual = subtract_scheduled_traffic(minutes, scheduled)
    render(
        days=args.days,
        start=start,
        end=end,
        total_requests=sum(count for _minute, count in minutes),
        explained=explained,
        residual=residual,
        visits=group_visits(residual),
        llm=llm_calls_by_day(token, f"{start:%Y-%m-%d}", f"{end:%Y-%m-%d}"),
        requests_per_view=requests_per_view,
        divisor_source=divisor_source,
    )


if __name__ == "__main__":
    try:
        main()
    except UsageReportError as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(1)
