# Architecture and RAG Design

## Application Stack

The application uses React, TypeScript, Vite, Tailwind CSS, Cloudflare Workers, D1, R2, and the OpenAI Responses API. The Worker is the only implementation of the assistant, and it serves both local development and production.

## Filing Search Pipeline

1. GitHub Actions scans public PDF filing metadata and official links from the e-Docket API before full-text extraction.
2. Metadata is divided into four stable record-range shards. A filing can be discovered by case, title, date, and official link while its full text is pending.
3. Four independent jobs download PDFs to temporary runner storage and extract text page by page without OCR on the historical first pass.
4. Gzipped page-level HTML is stored privately in R2.
5. Each case gets four compressed R2 manifest parts. Each extraction job owns one part, preventing concurrent manifest overwrites.
6. After ingestion, a GitHub Actions job folds the document filters into compact case-level filters and atomically publishes a 16-part global case router to R2. A separate weekly workflow rebuilds the inverted term index described below.
7. For questions with no case number, the Worker ranks cases through the inverted term index, opens filings in the strongest candidates (the top-ranked case gets a deeper read than the rest), and verifies them against their stored filing text. If the index is unpublished or a shard the question needs cannot be read, the Worker falls back to the case router, which ranks eight candidate cases from one partition. Case-specific questions skip this routing step, and a follow-up that names no subject of its own leads with the cases the conversation has already cited.
8. The Worker sends only verified excerpts to OpenAI. Metadata-only answers are explicitly labelled; document-content claims require extracted text. Answers link to the official PDF.

PDFs are temporary during extraction and are not permanently duplicated in project storage. When `CLOUDFLARE_ACCOUNT_ID` is configured, OpenAI requests use Cloudflare AI Gateway for monitoring and spend controls.

## Document Ranking

Bloom-filter hit counts alone favour long historical filings, because a saturated filter matches more query terms than a short current one. Candidate documents are therefore ranked on a blended score: filter hits stay the dominant term, a filing dated in a year named by the question gains a fixed bonus, and remaining filings decay gently over a twelve-year span. The weights are deliberately smaller than one extra term match, so a recent weak match never outranks a strong older one. Filings with no usable date keep their unmodified hit count.

Evidence slots are then filled round-robin across filings rather than depth-first, and the Worker keeps reading until several distinct filings have matched. Depth-first selection let one long filing consume the entire evidence budget, which could hide a more current filing that answered the question directly. Reads run a batch at a time, so a batch may overshoot the target; the surplus lowest-ranked filings are dropped, which reserves the remaining slots for the best-ranked filings to contribute a second excerpt. Filings beyond the evidence budget can never win a slot, so the group target must stay at or below it — a test enforces the bound.

## Page Excerpts

Stored page text keeps the PDF's layout, and `findPageExcerpts` relies on it. Each page is split at blank lines into blocks, and a block is treated as a table when at least half its lines are table rows (two numeric cells, or three or more cells separated by runs of spaces) and at least one row has two numeric cells. A lone column-header line separated from its rows by a blank line joins the table, and bare page numbers are dropped. The excerpt is centred on the block where the most query terms occur together (a paragraph wins a tie with a table, whose header words match many questions) and grows by whole blocks within a 2,000-character budget. Paragraphs are sent to the model as flowing text; tables keep one row per line, with cells separated by ` | ` and wrapped in `[Table]` and `[End of table]` markers.

A table at the top of a page usually continues one whose title is on the previous page. It is marked as untitled, and it is never pulled in as context for a paragraph below it. Before this, excerpts were a character window around the first matching term with all whitespace collapsed: in Pepco's CY2025 Annual Informational Filing, a 69 kV capital-variance table continued onto the page that opens the O&M summary, and answers reported its category variances as O&M drivers. The system prompt now tells the model to describe table figures only as the table's own labels define them.

## Retrieval Evaluation

`npm run eval:validate` checks that the evaluation set is well formed. `npm run eval:retrieval` scores it: it runs the questions against the local `.rag-data` corpus and imports the Worker's own ranking, excerpt, and selection functions, so measured behaviour cannot drift from production. Only the R2 fetch loop is modelled locally. `--sweep` compares breadth against depth, and `--weights` compares ranking weightings.

Ground truth comes from the corpus rather than from labels: the Bloom filter reports that a term may be present, while the stored text says whether it is. Two cautions apply. Metrics built on term counts are confounded by length, because longer filings genuinely contain more distinct terms, so they cannot validate a change intended to remove a length bias. Year coverage does not carry that confound. Term evidence is also not topical relevance — a filing can contain every query term without answering the question — so deciding between rankings that score alike still needs relevance judgements the evaluation set does not yet carry.

## Inverted Term Index

The case router stores case to terms, so answering "which cases contain these terms?" means testing every case. That costs time proportional to the corpus, which is why the Worker read one of sixteen router partitions and covered roughly a sixteenth of indexed cases — with the partition chosen by a hash of the query terms, so rewording a question moved the search to a different slice.

The inverted index stores the opposite direction: term to the cases containing it. A question reads only the shards holding its own terms, so the cost follows the question rather than the corpus, and every case is covered. Terms are assigned to 4,096 shards by hash. `scripts/build_term_index.py` writes them; `shared/termIndex.ts` holds the format both sides depend on, with shard assignment pinned to golden vectors in both test suites because a disagreement would fail silently rather than loudly.

Each posting list carries its document frequency, which gives inverse document frequency ranking. This is what the Bloom filters could not express: they counted a hit on a term appearing in nearly every filing the same as a hit on a rare one, so questions built mostly from common words left a large block of cases tied at the top, with filing dates left to break the tie. Terms above 15 percent document frequency keep their frequency for ranking but drop their posting lists, since they cannot separate one case from another.

A case's score for a term is that inverse document frequency multiplied by a per-case weight stored in the posting list. The `case-tf` format stored how many of the case's filings contained the term. That separated a case discussing a topic throughout from one mentioning it once, but it also rewarded size on its own, and the largest docket in the corpus led most questions regardless of what was asked. The current `case-bm25` format stores a BM25 term weight, which divides the count by the size of the case, scaled by 100 so the wire format stays integers. The Worker still reads every earlier format, so deploying never depends on a rebuild, and `/api/health` reports which format is live.

Terms are indexed by stem. `stemTerm` in `shared/termIndex.ts` strips only suffixes that leave a prefix of the original word, because excerpt verification is a plain substring match against page text: the stem `disconnect` still matches `disconnection` and `disconnected`. Derivational endings such as `-ation` need a longer remaining stem than plural or tense endings, since stripping `generation` to `gener` would match `general` on nearly every page. Bloom-filter candidate selection still uses the exact tokens the filters were built from.

Cross-case answers carry a scope note describing the path actually taken, so the note narrows automatically when the Worker falls back to the router. Generations publish into alternating slots and the index object is written last, so readers only ever see a complete generation.

## Compact Index Design

The initial design duplicated full filing text in D1 and used FTS5. The next compact design moved text to R2 and retained per-filing filters in D1. The current fast-backfill design also moves those filters into four compressed R2 manifest parts per case, removing D1's daily write quota from the historical ingestion path while allowing safe parallel writers. Existing FC1176 D1 data and version-1 R2 manifests remain available as compatibility fallbacks.

The global router uses no embeddings or paid vector database. It folds each 2 KiB document Bloom filter into one of four 256-byte case-filter bands, groups the filters into 16 compressed R2 objects, and publishes them through alternating A/B slots. Recurring terms that appear across several filing bands outrank one-off Bloom-filter matches. Updating the small index object switches generations atomically. Bloom-filter candidates are never treated as evidence; the Worker requires multiple topic-term matches for multi-term global questions, opens the shortlisted filing objects, and verifies the actual page text before answering.

For the FC1176 validation corpus, 831 public FC1176/DR1176 PDFs use approximately 20.5 MB in R2 and 3.6 MB in the existing D1 fallback; the earlier duplicated design used approximately 165 MB in D1.

The official API reports a much larger corpus, so each of four record-range jobs stores an independent resumable cursor in R2 and checkpoints its manifest parts every 100 eligible filings. Four workflow windows run each day. The historical first pass skips OCR so text-bearing filings can be indexed quickly without OCR API charges. Image-only pages can be revisited in a targeted second pass.

## Local RAG Alternative

Build a local index for FC1176:

```bash
npm run rag:build -- --cases 1176 --concurrency 4
```

Multiple cases can be supplied as a comma-separated list. The command reuses extracted content in `.rag-data` and deletes temporary PDFs unless `--keep-pdfs` is supplied. Set `RAG_DATA_DIR` to store local RAG data elsewhere.

The local build does not run OCR; it reports how many pages had no extractable text. The legacy D1 ingestion script, `scripts/cloud_ingest.py`, can OCR such pages with OCRmyPDF, which uses Tesseract, unless `--no-ocr` is passed. The current R2 ingestion does not OCR on its first pass.
