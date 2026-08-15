# Industry Beta Release Checklist

Use this checklist before sharing the canonical public URL or promoting a material update.

## Automated gates

- `npm ci`
- `npm run lint`
- `npm test`
- `npm run eval:validate`
- `npm run build`
- `npx wrangler deploy --dry-run`
- `npm run security:audit`

All commands must pass on the exact commit being released.

## Search-quality review

Review every prompt in `evaluation/questions.json` against the deployed candidate. Record pass/fail for:

1. The answer addresses the question without inventing facts.
2. Document-content claims have a relevant official filing and page citation.
3. Official links open successfully.
4. Metadata-only evidence is not presented as proof of document contents.
5. Cross-case answers display the non-exhaustive scope note and include diverse cases when supported.
6. Insufficient-evidence prompts produce an explicit limitation rather than a guess.

Release threshold: no fabricated filing, page, quotation, date, or URL; 100% working citations in the reviewed sample; at least 90% overall reviewer pass rate.

## Production checks

- `/api/health` returns HTTP 200 with `status: "ok"` and no issues.
- Metadata and case-router timestamps are less than 36 hours old.
- `termIndex.status` is `ready`, and `termIndex.cases` is close to `caseRouter.contentCases`. A much smaller number means a partial index — a canary run, or a build that stopped early — and the Worker prefers it over the router, so cross-case answers would cover less than the router did while claiming to cover everything.
- A cross-case answer carries the exhaustive scope note; a case-specific answer carries none.
- Chat request CPU time stays inside the Workers plan limit. Workers Free allows 10 ms per request and tolerates infrequent overruns, so a Worker that exceeds it under real traffic starts returning Error 1102. Check with `npx wrangler tail psc-docket-assistant --format json` while submitting a cross-case question.
- Turnstile is enabled and a real browser submission succeeds.
- Reusing a Turnstile token fails.
- More than 30 chat submissions from one test browser within a minute receives HTTP 429.
- AI Gateway budget limits and spend alerts are enabled in the Cloudflare dashboard.
- Worker error, latency, and ingestion failure alerts are enabled.
- The previous public URLs redirect to the canonical URL.
- Privacy and beta disclosures are visible on desktop and mobile.
- A newly generated answer displays feedback controls; thumbs up records without sending answer text.
- Thumbs down records the selected reason, question, answer excerpt, and optional comment after showing the disclosure.
- The `Report answer feedback` workflow can retrieve a test response, create a digest issue, and acknowledge it without duplicating it on the next run.

## Rollback

Keep the last known-good Worker version available. If any launch gate regresses, roll back the Worker and leave the canonical URL unchanged.
