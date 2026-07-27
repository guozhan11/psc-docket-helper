# PSC Docket Helper

An experimental AI assistant for exploring District of Columbia Public Service Commission dockets, regulatory filings, and public records.

## Try the Website

### [Open the PSC Docket Helper](https://psc-docket-assistant.psc-docket-helper.workers.dev/)

No installation is required.

> **Full-text RAG coverage is still in progress.** Public filing metadata and official PDF links have been indexed, while four non-overlapping ingestion shards gradually add page-level full text. To stay within free-tier limits, the shards are currently processed one at a time. A filing may therefore be discoverable before its contents are searchable. A missing content answer may reflect incomplete full-text coverage rather than the absence of an official record. Current ingestion status is available from the [health endpoint](https://psc-docket-assistant.psc-docket-helper.workers.dev/api/health).

## What It Does

- Searches inside indexed public filing PDFs, not just filing titles.
- Answers filing-content questions with document names, PDF page numbers, and official links.
- Retrieves current notices and regulatory news from the official DCPSC website.
- Keeps separate chat sessions in the user's browser.

## Questions That Work Well

- `In FC1176, what drove Pepco's 2025 O&M expense variance?`
- `Which FC1176 filings discuss bad debt or uncollectible accounts?`

Questions that identify a formal case and a specific issue generally produce the strongest results while the corpus is still expanding.

## How It Works

Public filing metadata and official links are published first. Four non-overlapping ingestion shards then download PDFs temporarily, convert them into searchable page-level text, and store gzip-compressed, text-only HTML in Cloudflare R2. PDF images, embedded fonts, and layout data are not retained. Sharded per-case manifests hold metadata and search filters without concurrent-write conflicts. The Worker verifies exact matches against stored text before OpenAI prepares an answer, and every citation links back to the official PDF.

The original PDFs are not permanently duplicated in project storage. Scheduled ingestion processes one shard at a time, resumes from its previous checkpoint, and stops cleanly at conservative Cloudflare free-plan safety limits.

## Run Locally

Requirements: Node.js, npm, and an OpenAI API key for synthesized answers.

```bash
npm install
export OPENAI_API_KEY="your_api_key_here"
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Technical Documentation

- [Architecture and RAG design](docs/ARCHITECTURE.md)
- [Deployment, ingestion, and operations](docs/OPERATIONS.md)

The main stack is React, TypeScript, Vite, Cloudflare Workers, D1, R2, and the OpenAI Responses API. An Express server remains available for local development and as a Render-compatible fallback.

## Sources and Disclaimer

News is retrieved from [DCPSC Current PSC News](https://dcpsc.org/Newsroom/Current-PSC-News.aspx). Filing metadata and documents come from the public [DC PSC e-Docket](https://edocket.dcpsc.org/public/search).

This project is not affiliated with or endorsed by the Public Service Commission of the District of Columbia. It is an experimental research tool, not legal advice or an official agency record. Verify important information against the original filing or the [official DCPSC website](https://dcpsc.org/).
