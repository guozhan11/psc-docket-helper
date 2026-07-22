# PSC Docket Helper

An AI-assisted way to explore District of Columbia Public Service Commission news, utility dockets, regulatory filings, and public records.

## Try the Live Website

### [Open the PSC Docket Helper](https://psc-docket-assistant.psc-docket-helper.workers.dev/)

Explore recent regulatory updates or ask the PSC Assistant about a DC utility case. No installation is required.

> The PSC Docket Helper is a non-official experimental tool. The current public deployment runs on Cloudflare Workers.

## What You Can Do

- **Follow recent PSC updates.** Browse current notices, meetings, hearings, and other regulatory news collected from the official DCPSC website.
- **Ask about a docket.** Enter a formal case number or ask a plain-language question about a utility proceeding.
- **Find official records.** Follow links back to DCPSC and e-Docket sources to review the underlying public information.
- **Keep inquiries organized.** Create separate conversations and return to recent chat sessions saved in your browser.

## Questions to Try

- `What is FC 1167 about?`
- `Show me recent utility rate cases.`
- `What are DC's renewable energy goals?`
- `Where can I find the official filings for a formal case?`

## Why This Project Exists

Public utility proceedings can involve long dockets, formal case numbers, technical filings, and information spread across multiple public systems. PSC Docket Helper provides a simpler starting point: users can ask a question in everyday language, review a concise explanation, and continue to the official source when they need the complete record.

## Information and Sources

The regulatory update cards are not AI-generated. The server retrieves news from the [DCPSC Current PSC News](https://dcpsc.org/Newsroom/Current-PSC-News.aspx) page and links users to official `dcpsc.org` records. Results are cached briefly for performance, with a bundled set of verified official links available if the source page is temporarily unavailable.

The PSC Assistant uses OpenAI for explanation and synthesis. Case facts and docket links are gathered from public DCPSC and [e-Docket](https://edocket.dcpsc.org/public/search) sources whenever available.

For filing-content questions, the cloud deployment can search the text inside public filing PDFs. A scheduled ingestion job extracts the text page by page and stores compressed HTML in Cloudflare R2. D1 keeps only document metadata, case mappings, and a 2 KB probabilistic term filter per filing. At query time, the Worker uses those filters to shortlist documents, then verifies every match against the R2 text before sending page-level excerpts to OpenAI. PDFs are temporary during extraction and are not permanently duplicated in cloud storage.

This project is not affiliated with or endorsed by the Public Service Commission of the District of Columbia. AI-generated explanations may be incomplete or inaccurate and should not be treated as legal advice or an official agency record. Verify important information against the original filing or the [official DCPSC website](https://dcpsc.org/).

## For Developers

The application uses React, TypeScript, Vite, Tailwind CSS, Cloudflare Workers, D1, R2, and the OpenAI Responses API. The existing Express server remains available for local development and as a Render-compatible fallback.

### Run Locally

Requirements:

- Node.js
- npm
- An OpenAI API key for AI-generated answers

```bash
npm install
export OPENAI_API_KEY="your_api_key_here"
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Without an OpenAI API key, the public news experience remains available and the assistant displays links to official search tools.

### Build the Local Filing Index

Build an index for FC1176:

```bash
npm run rag:build -- --cases 1176 --concurrency 4
```

Multiple cases can be indexed with a comma-separated list, such as `--cases 1176,1167`. The command is incremental: extracted page text is reused from `.rag-data`. PDFs are deleted immediately after extraction unless `--keep-pdfs` is supplied. Pages with little or no extractable text are reported as OCR candidates rather than silently treated as searchable text. For formal cases, the crawler includes the matching `FC` docket and its associated `DR` discovery docket while excluding unrelated docket types that happen to share the same number.

Set `RAG_DATA_DIR` to place the PDFs, extracted text, and `index.json` somewhere else. The assistant starts normally when no index is present and exposes index status through `/api/health`.

### Cloud Filing Search

The production-oriented search path is:

1. GitHub Actions reads public filing metadata from the official e-Docket API.
2. Each PDF is downloaded to temporary runner storage and its text and page-level HTML are extracted.
3. Only pages with fewer than 40 extracted characters are sent through OCRmyPDF/Tesseract.
4. Gzipped HTML is stored privately in R2; document metadata, case mappings, and compact term filters are stored across three D1 shards.
5. The Worker shortlists documents in D1, verifies page-level matches in R2, and sends only the best excerpts to OpenAI. AI Gateway is used when `CLOUDFLARE_ACCOUNT_ID` is configured.

#### One-time cloud backfill

After building the local text cache, prepare compressed HTML and resumable D1 import files, then publish them with Wrangler:

```bash
npm run rag:prepare-cloud -- --case 1176
npm run rag:publish-cloud -- --case 1176 --concurrency 4
```

The publisher uploads gzipped HTML to R2, imports the compact document index into D1, removes stale objects that no longer belong to the selected docket, and records progress in `.rag-data` so an interrupted run can resume. Re-running the commands is safe: document writes are idempotent.

The FC1176 validation corpus contains 831 public FC1176/DR1176 PDFs. It uses about 20.5 MB in R2 and 3.6 MB in D1; the earlier duplicated full-text/FTS design used about 165 MB in D1. The 997 pages with too little extractable text are retained as OCR candidates for a targeted second pass; the remaining corpus is searchable immediately without OCR or embedding API charges.

The complete official API currently reports roughly 40,000 cases and 204,000 filings. Based on the measured FC1176 averages, the upper-bound estimate is approximately 5 GB in R2 and 0.9 GB in D1. The D1 data is distributed across three databases by filing ID, leaving headroom below the free plan's 500 MB per-database limit.

To resume the oldest-first all-case backfill without OCR:

```bash
npm run rag:ingest-all-cloud
```

The command stores its official filing offset in D1, so stopping and running it again continues from the last checkpoint. The first pass intentionally skips OCR to finish the searchable text-layer corpus quickly and without OCR API charges. Image-only pages can be revisited in a targeted second pass.

Ollama is a free local model runner, but it is not itself an OCR engine. Some vision models available through Ollama can read images, but they are a poor fit for a large unattended document crawl: they need a machine with the model running and are slower and less deterministic for page transcription. This project instead uses the open-source OCRmyPDF and Tesseract tools, so OCR has no per-page API or token charge. Model licenses downloaded through Ollama can vary.

#### First Cloudflare Deployment

```bash
npm install
npm run build:client
npx wrangler login
npm run cloudflare:deploy
npm run cloudflare:db:remote
npx wrangler secret put OPENAI_API_KEY
```

The committed `wrangler.jsonc` binds the production R2 bucket and three D1 shards. Apply the migrations to each shard before the first ingestion run, then deploy again after adding secrets or changing configuration. To enable OpenAI monitoring and limits through AI Gateway, also add `CLOUDFLARE_ACCOUNT_ID`; `AI_GATEWAY_ID` defaults to `default`. Add `CF_AIG_TOKEN` only if that gateway is authenticated.

For local Worker testing, copy `.dev.vars.example` to `.dev.vars`, then run:

```bash
npm run cloudflare:db:local
npm run cloudflare:dev
```

#### Configure Automated Ingestion

Create an R2 S3 API token and a Cloudflare API token that can write to the provisioned D1 database. Add these repository Actions secrets:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`
- `R2_BUCKET_NAME`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`

The `Ingest DC PSC dockets` workflow runs daily for recent filings. It can also be started manually with case numbers such as `1176,1183`, or with `all_cases` enabled to resume the oldest-first full backfill. The default 100-filing cap prevents an accidental unbounded job. Re-running a filing replaces its compact index rather than duplicating it.

The ingestion script also stops before crossing project-level safety ceilings: 8 GiB in R2, an estimated 400 MiB in any D1 shard, 5,000 new documents per run, 80,000 D1 rows written per UTC day, or 5,000 R2 objects written per UTC day. The daily scheduled run disables OCR during the historical backfill so it can index as many text-bearing filings as possible at no OCR API cost. These ceilings intentionally leave headroom below Cloudflare's free-plan limits, and the crawl saves a resumable cursor rather than forcing the corpus through in one day. These are safeguards rather than billing guarantees; monitor the Cloudflare usage dashboard and configure an AI Gateway spend limit for OpenAI separately.

When `OPENAI_API_KEY` is not configured, the public Worker operates in zero-AI-cost mode: it returns the verified R2 excerpts, page numbers, and official PDF links directly instead of calling a model. Adding an OpenAI key enables synthesized answers and should be paired with an AI Gateway spend limit.

### Validate and Build

```bash
npm run lint
npm run build
npx wrangler deploy --dry-run
npm start
```

### Deploy on Render

Create a Render Web Service connected to this repository and use:

```text
Build Command: npm install && npm run build
Start Command: npm start
```

Add `OPENAI_API_KEY` in the Render environment settings. Pushes to the connected branch will then trigger automatic deployments.

Render's normal service filesystem is ephemeral. For a production local RAG index, attach a persistent disk to the web service, mount it at a path such as `/var/data/psc-rag`, set `RAG_DATA_DIR` to that path, and run the index builder from that service's Render Shell. The server notices an atomically replaced index without requiring a redeploy. Do not rebuild hundreds of PDFs during an incoming chat request.
