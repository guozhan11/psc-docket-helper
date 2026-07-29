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
- `R2_BUCKET_NAME`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`

The `Ingest DC PSC dockets` workflow starts at 00:17, 06:17, 12:17, and 18:17 UTC. A metadata job first publishes all public PDF filing records and official links; later runs refresh the newest three days. Four extraction shards process non-overlapping record ranges with controlled parallelism. After metadata and any enabled extraction finish, one router job rebuilds the 16-part global case index. Compressed HTML, sharded case manifests, independent cursors, failed-filing lists, and the case router are stored in R2, so interrupted runs continue from their checkpoints without consuming D1's per-row daily write allowance.

To build or refresh metadata locally:

```bash
npm run rag:metadata-cloud
```

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
