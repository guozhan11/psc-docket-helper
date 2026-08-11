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
- Turnstile is enabled and a real browser submission succeeds.
- Reusing a Turnstile token fails.
- More than 30 chat submissions from one test browser within a minute receives HTTP 429.
- AI Gateway budget limits and spend alerts are enabled in the Cloudflare dashboard.
- Worker error, latency, and ingestion failure alerts are enabled.
- The previous public URLs redirect to the canonical URL.
- Privacy and beta disclosures are visible on desktop and mobile.

## Rollback

Keep the last known-good Worker version available. If any launch gate regresses, roll back the Worker and leave the canonical URL unchanged.
