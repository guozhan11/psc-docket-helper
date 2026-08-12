/**
 * Offline retrieval scoring for the release evaluation set.
 *
 * `validate-evaluation.ts` only checks that the question file is well formed.
 * This harness answers the questions that structural validation cannot: which
 * filings a question actually retrieves, how old they are, and how many
 * distinct filings contribute evidence. Those are the measurements needed to
 * set the ranking and coverage constants by evidence instead of by guess.
 *
 * It runs against the local `.rag-data` corpus and imports the Worker's own
 * ranking, excerpt, and selection functions, so what is measured here is what
 * production does. Only the R2/D1 fetch loop is modelled locally.
 *
 * Usage:
 *   npm run eval:retrieval
 *   npm run eval:retrieval -- --sweep 4,6,8
 *   npm run eval:retrieval -- --json
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import {
  COMPACT_DOCUMENT_GROUP_TARGET,
  EVIDENCE_ROW_BUDGET,
  buildSearchTerms,
  extractQueryYears,
  findPageExcerpts,
  rankCompactCandidates,
  selectDiverseDocumentResults,
  type CompactDocumentRow,
  type SearchRow
} from '../worker/index.ts';
import { createTermFilter, termMayExist } from '../shared/compactSearch.ts';

interface EvaluationQuestion {
  id: string;
  category: string;
  question: string;
  expectedCaseNumbers?: string[];
}

interface LocalDocument extends CompactDocumentRow {
  filterBytes: Uint8Array;
  html: string;
}

interface QuestionResult {
  id: string;
  category: string;
  question: string;
  caseNumber: string;
  queryYears: number[];
  candidates: number;
  maxFilterHits: number;
  tiedAtTop: number;
  documentsRead: number;
  matchedDocuments: number;
  evidenceRows: number;
  distinctFilings: number;
  evidenceYears: number[];
  topFilingYear: number | null;
  yearsCovered: boolean | null;
  topFilings: { filing_id: number; year: string; title: string }[];
}

const RAG_DATA_DIR = process.env.RAG_DATA_DIR || '.rag-data';
// Mirrors the Worker's batching: candidates are read four at a time and the
// stop condition is only evaluated once a whole batch has come back.
const READ_BATCH_SIZE = 4;
const MAX_DOCUMENT_READS = 20;

function parseArgs(argv: string[]) {
  const sweepArg = argv.find(value => value.startsWith('--sweep'));
  const sweepRaw = sweepArg?.includes('=')
    ? sweepArg.split('=')[1]
    : sweepArg
      ? argv[argv.indexOf(sweepArg) + 1]
      : undefined;
  return {
    json: argv.includes('--json'),
    sweep: sweepRaw
      ? sweepRaw.split(',').map(value => Number(value.trim())).filter(Number.isInteger)
      : null
  };
}

function documentYear(receivedDate: string | null): number | null {
  if (!receivedDate) return null;
  const year = Number(String(receivedDate).slice(0, 4));
  return Number.isInteger(year) && year >= 1900 ? year : null;
}

/** Rebuilds the exact page HTML that ingestion stores in R2. */
function toStoredHtml(filingId: number, caseNumber: string, pages: { page?: number; number?: number; text?: string }[]): string {
  const escape = (value: string) => value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
  const sections = pages.map(page =>
    `<section data-page="${Number(page.page ?? page.number ?? 1)}"><pre>${escape(String(page.text ?? ''))}</pre></section>`
  ).join('\n');
  return '<!doctype html><html><head><meta charset="utf-8"></head><body>'
    + `<main data-filing-id="${filingId}" data-case="${escape(caseNumber)}">`
    + `${sections}</main></body></html>`;
}

async function loadCorpus(): Promise<Map<string, LocalDocument[]>> {
  const root = path.resolve(RAG_DATA_DIR, 'documents');
  const byCase = new Map<string, LocalDocument[]>();
  let caseDirs: string[];
  try {
    caseDirs = await readdir(root);
  } catch {
    throw new Error(`No local corpus at ${root}. Build one with: npm run rag:build -- --cases 1176`);
  }
  for (const caseDir of caseDirs) {
    const dir = path.join(root, caseDir);
    let files: string[];
    try {
      files = (await readdir(dir)).filter(name => name.endsWith('.json'));
    } catch {
      continue;
    }
    for (const file of files) {
      let payload: any;
      try {
        payload = JSON.parse(await readFile(path.join(dir, file), 'utf8'));
      } catch {
        continue;
      }
      const pages = Array.isArray(payload?.pages) ? payload.pages : [];
      const text = pages.map((page: any) => String(page?.text ?? '')).join('\n');
      if (!text.trim()) continue;
      const filing = payload.filing ?? {};
      const caseNumber = String(payload.caseNumber ?? '').toUpperCase();
      const filingId = Number(filing.filingId ?? path.basename(file, '.json'));
      if (!caseNumber || !Number.isInteger(filingId)) continue;
      // Matches clean_text() in scripts/cloud_ingest.py: descriptions arrive as
      // HTML fragments and ingestion stores the stripped, unescaped text.
      const title = String(filing.description ?? filing.attachmentFileName ?? 'PSC filing')
        .replace(/<[^>]*>/g, ' ')
        .replaceAll('&nbsp;', ' ')
        .replaceAll('&amp;', '&')
        .replaceAll('&#39;', "'")
        .replaceAll('&quot;', '"')
        .replace(/\s+/g, ' ')
        .trim() || 'PSC filing';
      const document: LocalDocument = {
        filing_id: filingId,
        case_number: caseNumber,
        docket_number: filing.docketNumber ?? null,
        title,
        received_date: filing.receivedDate ?? null,
        official_pdf_url: String(payload.pdfUrl ?? ''),
        r2_key: `local/${filingId}`,
        // The real Bloom filter, so measured hit counts include the same false
        // positives production sees. Built from full document text, exactly as
        // scripts/fast_r2_ingest.py does.
        term_filter: null,
        filterBytes: createTermFilter(text),
        html: toStoredHtml(filingId, caseNumber, pages)
      };
      const bucket = byCase.get(caseNumber) ?? [];
      bucket.push(document);
      byCase.set(caseNumber, bucket);
    }
  }
  return byCase;
}

function runRetrieval(
  documents: LocalDocument[],
  question: string,
  groupTarget: number
): Omit<QuestionResult, 'id' | 'category' | 'question' | 'caseNumber'> {
  const terms = buildSearchTerms(question);
  const queryYears = extractQueryYears(question);

  const candidates = documents
    .map(document => ({
      ...document,
      filterHits: terms.filter(term => termMayExist(document.filterBytes, term)).length
    }))
    .filter(document => document.filterHits >= 1);

  // How many candidates tie on term evidence at the top? Filter hits are the
  // dominant ranking term only while they discriminate. If a large share of the
  // corpus ties at the maximum, the date weights stop being a nudge and become
  // the effective sort key, which would trade an old-filing bias for a new one.
  const maxFilterHits = candidates.reduce((best, item) => Math.max(best, item.filterHits), 0);
  const tiedAtTop = candidates.filter(item => item.filterHits === maxFilterHits).length;

  const ranked = rankCompactCandidates(candidates, queryYears).slice(0, MAX_DOCUMENT_READS);

  const excerptGroups: SearchRow[][] = [];
  let documentsRead = 0;
  for (let start = 0; start < ranked.length; start += READ_BATCH_SIZE) {
    const batch = ranked.slice(start, start + READ_BATCH_SIZE);
    for (const document of batch) {
      documentsRead += 1;
      const rows = findPageExcerpts(document.html, terms, document, 1);
      if (rows.length) excerptGroups.push(rows);
    }
    // Mirrors the Worker's overshoot trim.
    if (excerptGroups.length >= groupTarget) {
      excerptGroups.length = groupTarget;
      break;
    }
  }
  const evidence = selectDiverseDocumentResults(excerptGroups);

  const evidenceYears = evidence
    .map(row => documentYear(row.received_date))
    .filter((year): year is number => year !== null);
  const topFilingYear = evidence.length ? documentYear(evidence[0].received_date) : null;

  return {
    queryYears,
    candidates: candidates.length,
    maxFilterHits,
    tiedAtTop,
    documentsRead,
    matchedDocuments: excerptGroups.length,
    evidenceRows: evidence.length,
    distinctFilings: new Set(evidence.map(row => row.filing_id)).size,
    evidenceYears,
    topFilingYear,
    // Did any evidence come from a year the question named? Null when the
    // question named none, so the rate is not diluted by undated questions.
    yearsCovered: queryYears.length
      ? evidenceYears.some(year => queryYears.some(q => year === q || year === q + 1))
      : null,
    topFilings: evidence.slice(0, 3).map(row => ({
      filing_id: row.filing_id,
      year: String(row.received_date ?? 'unknown').slice(0, 10),
      title: row.title.slice(0, 70)
    }))
  };
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function summarize(results: QuestionResult[]) {
  const withYears = results.filter(result => result.yearsCovered !== null);
  const currentYear = new Date().getUTCFullYear();
  return {
    questions: results.length,
    answered: results.filter(result => result.evidenceRows > 0).length,
    meanEvidenceRows: Number((results.reduce((sum, r) => sum + r.evidenceRows, 0) / (results.length || 1)).toFixed(2)),
    meanDistinctFilings: Number((results.reduce((sum, r) => sum + r.distinctFilings, 0) / (results.length || 1)).toFixed(2)),
    meanDocumentsRead: Number((results.reduce((sum, r) => sum + r.documentsRead, 0) / (results.length || 1)).toFixed(2)),
    meanTiedAtTop: Number((results.reduce((sum, r) => sum + r.tiedAtTop, 0) / (results.length || 1)).toFixed(1)),
    yearCoverage: withYears.length
      ? `${withYears.filter(r => r.yearsCovered).length}/${withYears.length}`
      : 'n/a',
    medianEvidenceAgeYears: median(
      results.flatMap(result => result.evidenceYears.map(year => currentYear - year))
    )
  };
}

const argv = process.argv.slice(2);
const options = parseArgs(argv);

const questions = JSON.parse(
  await readFile(new URL('../evaluation/questions.json', import.meta.url), 'utf8')
) as EvaluationQuestion[];

const corpus = await loadCorpus();
const availableCases = new Set(corpus.keys());

const scorable = questions.filter(question =>
  question.expectedCaseNumbers?.some(caseNumber => availableCases.has(caseNumber.toUpperCase()))
);
const skipped = questions.length - scorable.length;

if (!scorable.length) {
  console.error(`No evaluation question maps to a locally indexed case. Available: ${[...availableCases].join(', ') || 'none'}`);
  process.exit(1);
}

function scoreAll(groupTarget: number): QuestionResult[] {
  return scorable.map(question => {
    const caseNumber = question.expectedCaseNumbers!
      .map(value => value.toUpperCase())
      .find(value => availableCases.has(value))!;
    return {
      id: question.id,
      category: question.category,
      question: question.question,
      caseNumber,
      ...runRetrieval(corpus.get(caseNumber)!, question.question, groupTarget)
    };
  });
}

if (options.sweep) {
  const rows = options.sweep.map(groupTarget => ({ groupTarget, ...summarize(scoreAll(groupTarget)) }));
  if (options.json) {
    console.log(JSON.stringify({ mode: 'sweep', evidenceRowBudget: EVIDENCE_ROW_BUDGET, rows }, null, 2));
  } else {
    console.log(`Corpus: ${[...availableCases].join(', ')} — ${scorable.length} scorable question(s), ${skipped} skipped (case not indexed locally)`);
    console.log(`Evidence row budget: ${EVIDENCE_ROW_BUDGET} (filings beyond this can never win a slot)\n`);
    console.table(rows);
  }
} else {
  const results = scoreAll(COMPACT_DOCUMENT_GROUP_TARGET);
  if (options.json) {
    console.log(JSON.stringify({ mode: 'score', groupTarget: COMPACT_DOCUMENT_GROUP_TARGET, results, summary: summarize(results) }, null, 2));
  } else {
    console.log(`Corpus: ${[...availableCases].join(', ')} — ${scorable.length} scorable question(s), ${skipped} skipped (case not indexed locally)`);
    console.log(`Group target: ${COMPACT_DOCUMENT_GROUP_TARGET}, evidence row budget: ${EVIDENCE_ROW_BUDGET}\n`);
    for (const result of results) {
      console.log(`${result.id} [${result.category}] ${result.question}`);
      console.log(`  years asked: ${result.queryYears.join(', ') || 'none'}`
        + ` | candidates: ${result.candidates} (${result.tiedAtTop} tied at ${result.maxFilterHits} hits)`
        + ` | read: ${result.documentsRead}`
        + ` | matched: ${result.matchedDocuments}`);
      console.log(`  evidence: ${result.evidenceRows} rows from ${result.distinctFilings} filing(s)`
        + ` | year covered: ${result.yearsCovered === null ? 'n/a' : result.yearsCovered}`);
      for (const filing of result.topFilings) {
        console.log(`    - ${filing.year}  #${filing.filing_id}  ${filing.title}`);
      }
      console.log('');
    }
    console.log('Summary:');
    console.table([summarize(results)]);
  }
}
