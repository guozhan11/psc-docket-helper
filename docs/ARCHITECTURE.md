# Architecture and RAG Design

## Application Stack

The application uses React, TypeScript, Vite, Tailwind CSS, Cloudflare Workers, D1, R2, and the OpenAI Responses API. The Express server supports local development and a Render-compatible fallback.

## Filing Search Pipeline

1. GitHub Actions reads public filing metadata from the official e-Docket API.
2. Each PDF is downloaded to temporary runner storage and text is extracted page by page.
3. OCRmyPDF and Tesseract can process pages that do not contain a usable text layer.
4. Gzipped page-level HTML is stored privately in R2.
5. Each case gets a compressed R2 manifest containing filing metadata, official links, and a 2 KB probabilistic term filter per filing.
6. The Worker loads the requested case manifest, shortlists documents, verifies exact page-level matches in R2, and sends only the best excerpts to OpenAI.
7. Answers cite the filing title and page and link directly to the official PDF.

PDFs are temporary during extraction and are not permanently duplicated in project storage. When `CLOUDFLARE_ACCOUNT_ID` is configured, OpenAI requests use Cloudflare AI Gateway for monitoring and spend controls.

## Compact Index Design

The initial design duplicated full filing text in D1 and used FTS5. The next compact design moved text to R2 and retained per-filing filters in D1. The current fast-backfill design also moves those filters into one compressed R2 manifest per case, removing D1's daily write quota from the historical ingestion path. Existing FC1176 D1 data remains available as a compatibility fallback.

For the FC1176 validation corpus, 831 public FC1176/DR1176 PDFs use approximately 20.5 MB in R2 and 3.6 MB in the existing D1 fallback; the earlier duplicated design used approximately 165 MB in D1.

The official API reports a much larger corpus, so the parallel ingestion job stores its resumable cursor in R2 and checkpoints case manifests every 100 eligible filings. The historical first pass skips OCR so text-bearing filings can be indexed quickly without OCR API charges. Image-only pages can be revisited in a targeted second pass.

## Local RAG Alternative

Build a local index for FC1176:

```bash
npm run rag:build -- --cases 1176 --concurrency 4
```

Multiple cases can be supplied as a comma-separated list. The command reuses extracted content in `.rag-data` and deletes temporary PDFs unless `--keep-pdfs` is supplied. Set `RAG_DATA_DIR` to store local RAG data elsewhere.

Ollama is a local model runner, not an OCR engine. This project uses OCRmyPDF and Tesseract for deterministic, open-source OCR without per-page API charges.
