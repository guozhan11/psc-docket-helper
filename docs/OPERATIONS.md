# Deployment, Ingestion, and Operations

## Validate the Project

```bash
npm run lint
npm run build
npx wrangler deploy --dry-run
npm test
npm run eval:validate
npm run security:audit
```

## First Cloudflare Deployment

```bash
npm install
npm run build:client
npx wrangler login
npm run cloudflare:deploy
npm run cloudflare:db:remote
npx wrangler secret put OPENAI_API_KEY
```

Do not share a production URL until every gate in [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md) passes.

## Turnstile and Chat Protection

Production chat requests use two Workers Rate Limiting bindings: 30 requests per anonymous browser per minute and an additional 300-request-per-minute regional safety ceiling. The frontend stores a random anonymous client identifier in browser local storage; no account or user profile is created.

Create a managed Turnstile widget for `localhost`, `127.0.0.1`, and the canonical production hostname. Put the non-secret site key in `wrangler.jsonc`:

```jsonc
"vars": {
  "TURNSTILE_SITE_KEY": "<site-key>",
  "TURNSTILE_EXPECTED_HOSTNAME": "<canonical-hostname>"
}
```

Store the secret only through Wrangler:

```bash
npx wrangler secret put TURNSTILE_SECRET
```

The browser sends a single-use token with each chat request. The Worker calls Cloudflare Siteverify, requires `success: true`, verifies the `turnstile-spin-v2` action, and optionally verifies the expected hostname. `/api/health` reports `degraded` until both the site key and secret are configured.

AI Gateway spend limits and alerts are account-level controls and must be confirmed in the Cloudflare dashboard before release; they cannot be guaranteed by repository configuration alone.

## Answer Feedback and Daily Digest

Generated answers expose thumbs-up and thumbs-down controls. A negative response asks for a reason and an optional comment, and tells the user that the question and an answer excerpt will be sent to the maintainer. Positive feedback stores only the vote. Feedback is written to the `answer_feedback` table in the primary D1 database; no IP address or user profile is stored.

The Worker signs a seven-day feedback token for each completed chat response. Configure one random value in both secret stores without committing it:

```bash
npx wrangler secret put FEEDBACK_SECRET
gh secret set FEEDBACK_REPORT_TOKEN
```

The `Report answer feedback` GitHub Actions workflow runs daily at 13:15 UTC. It retrieves unreported feedback through the authenticated report endpoint, creates a GitHub Issue containing vote totals and negative-response context, then acknowledges only the rows included in the successfully created issue. It can also be run manually from the Actions tab.

Apply migration `0005_answer_feedback.sql` to all D1 bindings before deploying the UI and API:

```bash
npm run cloudflare:db:remote
```

The committed `wrangler.jsonc` binds the production R2 bucket and three D1 shards. Apply migrations to every shard before the first ingestion run. For authenticated AI Gateway requests, configure `CLOUDFLARE_ACCOUNT_ID`, `AI_GATEWAY_ID`, and `CF_AIG_TOKEN` as needed.

For local Worker testing, copy `.dev.vars.example` to `.dev.vars`, then run:

```bash
npm run cloudflare:db:local
npm run cloudflare:dev
```

## Automated Ingestion

Add these GitHub Actions secrets:

- `CLOUDFLARE_ACCOUNT_ID`
- `R2_BUCKET_NAME`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`

The `Ingest DC PSC dockets` workflow starts at 00:17, 06:17, 12:17, and 18:17 UTC. A metadata job first publishes all public PDF filing records and official links; later runs refresh the newest three days. Four extraction shards process non-overlapping record ranges with controlled parallelism. After metadata and any enabled extraction finish, one router job rebuilds the 16-part global case index. Compressed HTML, sharded case manifests, independent cursors, failed-filing lists, and the case router are stored in R2, so interrupted runs continue from their checkpoints without consuming D1's per-row daily write allowance.

When eDocket itself is down, ingestion does not fail. Every DC PSC call retries a transient response (429, 500, 502, 503, 504) eight times with backoff, honouring `Retry-After`; if the outage outlasts that, the shard keeps its last checkpoint, prints a `::warning::` annotation on the run, and exits successfully so the next scheduled run resumes from the same cursor. Nothing is lost, because the cursor never advances past records that run did not write. A failed run therefore still means something this repository can act on, and the `alert` job opens or updates the `Ingestion run failed` issue only for those. To find suppressed outages, look for the warning annotations on green runs.


To build or refresh metadata locally:

```bash
npm run rag:metadata-cloud
```

## Usage

`npm run usage:report` answers how much real traffic the deployed assistant is
getting. Pass `-- --days N` for a longer window, up to 28.

Two numbers matter, and only one of them is exact. **Questions answered** comes
from AI Gateway, where every answer appears once, so a zero there means nobody
asked anything. **Visits** is an estimate, because the scheduled workflows
dominate raw Worker invocations: `Monitor health` polls the health endpoint
every forty minutes or so, which alone accounts for roughly thirty invocations
a day. The report matches invocation minutes against the workflow runs that
caused them and reports the remainder, converting it to page views at the rate
one view costs — three fixed API calls plus one link check per news item, probed
live rather than assumed.

Reading raw invocation counts from the Cloudflare dashboard instead will
overstate human traffic by an order of magnitude.

The report reuses the `wrangler login` credentials, or `CLOUDFLARE_API_TOKEN`
when set, and needs the GitHub CLI to identify scheduled traffic. Per-path
Workers Logs would remove the guesswork, but that query needs a token carrying
the Workers Observability scope, which the OAuth login does not include.

## Term Index

The `Build term index` workflow rebuilds the inverted index that serves cross-case questions. It runs weekly, on its own schedule rather than inside ingestion: a full pass reads every stored document, and the ingestion jobs are already sized against GitHub's six-hour job limit. Weekly rather than daily because each run rewrites every shard and R2 bills Class A operations past one million per month, while the corpus barely moves between runs. It uses the same four secrets as ingestion.

Run it by hand from the Actions tab. `limit` caps how many cases are indexed — use a small number for a canary before a full pass — and `concurrency` sets how many documents are fetched in parallel; a full pass is roughly 200,000 R2 round trips, so a serial run does not finish inside the job limit.

```bash
npm run rag:term-index-cloud
```

Until an index has been published for the whole corpus, the Worker falls back to the case router and says so in the scope note attached to cross-case answers. `/api/health` reports `termIndex.status` as `not-published`, `ready`, or `stale`. A partial index — for example one left by a canary run — is still served in preference to the router, so follow a canary with a full pass before deploying a Worker that reads it.

To rebuild the global router locally after manifests change:

```bash
npm run rag:router-cloud
```

This command reads the existing R2 manifests and does not download PDFs or call an AI model. GitHub Actions normally runs it automatically.

GitHub Actions is the supported way to run all four extraction shards. For a diagnostic run of shard zero:

```bash
npm run rag:ingest-shard-0-cloud
```

The four shard states collectively stop before 8 GiB of tracked R2 storage or 700,000 tracked R2 writes in one calendar month. These are project safeguards rather than billing guarantees. Monitor the Cloudflare dashboard as the corpus grows.

The public health endpoint returns HTTP 503 with `status: "degraded"` when a metadata or ingestion shard is unavailable, when metadata or the case router is more than 36 hours old, when the router is unavailable, or when Turnstile is disabled/misconfigured. It does not calculate a coverage percentage from partial shard state.

GitHub Actions runs application validation on every pull request and push to `main`. Ingestion remains a separate scheduled workflow so a DC PSC upstream outage cannot block ordinary code validation.

When `OPENAI_API_KEY` is absent, the Worker returns verified excerpts, page numbers, and official PDF links without model synthesis. When OpenAI is enabled, pair it with an AI Gateway spend limit.

## One-Time Local-to-Cloud Publication

After building a local text cache, prepare and publish a selected case:

```bash
npm run rag:prepare-cloud -- --case 1176
npm run rag:publish-cloud -- --case 1176 --concurrency 4
```

The publisher uploads compressed HTML to R2, imports the compact index into D1, removes stale objects for the selected docket, and records resumable progress in `.rag-data`.

## Render Fallback

Create a Render Web Service with:

```text
Build Command: npm install && npm run build
Start Command: npm start
```

Add `OPENAI_API_KEY` to the Render environment. Render's normal filesystem is ephemeral; a persistent local RAG deployment needs a persistent disk and `RAG_DATA_DIR` pointed at its mount path. Do not rebuild large PDF collections during an incoming chat request.
