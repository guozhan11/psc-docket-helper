# Deployment, Ingestion, and Operations

## Validate the Project

```bash
npm run lint
npm run build
npx wrangler deploy --dry-run
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

The committed `wrangler.jsonc` binds the production R2 bucket and three D1 shards. Apply migrations to every shard before the first ingestion run. For authenticated AI Gateway requests, configure `CLOUDFLARE_ACCOUNT_ID`, `AI_GATEWAY_ID`, and `CF_AIG_TOKEN` as needed.

For local Worker testing, copy `.dev.vars.example` to `.dev.vars`, then run:

```bash
npm run cloudflare:db:local
npm run cloudflare:dev
```

## Automated Ingestion

Add these GitHub Actions secrets:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`
- `R2_BUCKET_NAME`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`

The `Ingest DC PSC dockets` workflow runs daily after the Cloudflare UTC quota reset. It ingests recent filings and then resumes the oldest-first all-case backfill. Progress is stored in D1 so an interrupted run can continue from its last checkpoint.

To resume the backfill manually without OCR:

```bash
npm run rag:ingest-all-cloud
```

The ingestion script stops before crossing project safety ceilings: 8 GiB in R2, an estimated 400 MiB in any D1 shard, 5,000 new documents per run, 80,000 D1 rows written per UTC day, or 5,000 R2 objects written per UTC day. These safeguards leave headroom but are not billing guarantees; monitor the Cloudflare dashboard as the corpus grows.

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
