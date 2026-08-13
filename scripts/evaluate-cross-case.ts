/**
 * Scores the cross-case evaluation questions against the published term index.
 *
 * The local-corpus harness in evaluate-retrieval.ts cannot measure this path:
 * `.rag-data` holds one case, and cross-case routing is about choosing among
 * forty thousand. This reads the real index out of R2 through wrangler and runs
 * the Worker's own IDF ranking over it.
 *
 * The cross-case questions carry no expected case numbers, so precision against
 * ground truth is not available. Three things are measurable and worth having:
 *
 *   coverage     how many cases the question actually reaches. The Bloom router
 *                read one partition of sixteen, so this is the direct evidence
 *                that the sampling is gone.
 *   separation   the IDF gap between the top candidate and the last one kept.
 *                This replaces the old tie count: the router left large blocks
 *                of cases tied on hit count, leaving filing dates to arbitrate.
 *   stability    the same question, reworded, must reach the same cases. Under
 *                the router four phrasings of one question routed to four
 *                disjoint partitions, purely from word order.
 *
 * Usage:
 *   npm run eval:cross-case
 *   npm run eval:cross-case -- --json
 */
import { execFileSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { buildSearchTerms } from '../worker/index.ts';
import {
  TERM_INDEX_KEY,
  inverseDocumentFrequency,
  termIndexShardKey,
  termShard,
  type TermIndexManifest,
  type TermIndexShard
} from '../shared/termIndex.ts';

const BUCKET = process.env.R2_BUCKET_NAME || 'psc-docket-assistant-documents';
const CANDIDATES = 8;
const MAX_QUERY_TERMS = 8;
// Shard fetches go through the wrangler CLI, which costs seconds per call.
const CACHE_DIR = path.join(tmpdir(), 'psc-term-index-cache');

interface EvaluationQuestion {
  id: string;
  category: string;
  question: string;
}

function r2Get(key: string): Buffer {
  const cached = path.join(CACHE_DIR, key.replace(/[^a-zA-Z0-9]/g, '_'));
  if (existsSync(cached)) return readFileSync(cached);
  mkdirSync(CACHE_DIR, { recursive: true });
  const body = execFileSync(
    'npx',
    ['wrangler', 'r2', 'object', 'get', `${BUCKET}/${key}`, '--remote', '--pipe'],
    { maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }
  );
  writeFileSync(cached, body);
  return body;
}

/** wrangler may hand back the object already decompressed. */
function readJson(body: Buffer): unknown {
  const text = body[0] === 0x1f && body[1] === 0x8b ? gunzipSync(body) : body;
  return JSON.parse(text.toString('utf8'));
}

interface Routed {
  matchedCases: number;
  candidates: { caseNumber: string; score: number; hits: number }[];
  discriminatingTerms: string[];
  cappedTerms: string[];
  missingTerms: string[];
}

function route(manifest: TermIndexManifest, terms: string[]): Routed {
  const wanted = terms.slice(0, MAX_QUERY_TERMS);
  const scores = new Map<string, { score: number; hits: number }>();
  const discriminating: string[] = [];
  const capped: string[] = [];
  const missing: string[] = [];

  for (const term of wanted) {
    const shardIndex = termShard(term, manifest.shardCount);
    const shard = readJson(
      r2Get(termIndexShardKey(manifest.activeSlot, shardIndex, manifest.shardCount))
    ) as TermIndexShard;
    const entry = shard.terms?.[term];
    if (!Array.isArray(entry) || !entry.length) {
      missing.push(term);
      continue;
    }
    const documentFrequency = Number(entry[0]) || 0;
    const cases = entry.slice(1) as string[];
    if (!cases.length) {
      capped.push(term);
      continue;
    }
    discriminating.push(term);
    const weight = inverseDocumentFrequency(documentFrequency, manifest.cases);
    for (const caseNumber of cases) {
      const current = scores.get(caseNumber) ?? { score: 0, hits: 0 };
      current.score += weight;
      current.hits += 1;
      scores.set(caseNumber, current);
    }
  }

  const candidates = Array.from(scores.entries())
    .map(([caseNumber, value]) => ({ caseNumber, ...value }))
    .sort((left, right) => right.score - left.score
      || right.hits - left.hits
      || left.caseNumber.localeCompare(right.caseNumber))
    .slice(0, CANDIDATES);

  return {
    matchedCases: scores.size,
    candidates,
    discriminatingTerms: discriminating,
    cappedTerms: capped,
    missingTerms: missing
  };
}

/** Reorderings of one question; routing must not depend on word order. */
function rewordings(terms: string[]): string[][] {
  if (terms.length < 2) return [];
  const reversed = [...terms].reverse();
  const rotated = [...terms.slice(1), terms[0]];
  return [reversed, rotated];
}

const json = process.argv.includes('--json');

const questions = (JSON.parse(
  await readFile(new URL('../evaluation/questions.json', import.meta.url), 'utf8')
) as EvaluationQuestion[]).filter(question =>
  question.category === 'cross-case' || question.category === 'insufficient-evidence'
);

const manifest = readJson(r2Get(TERM_INDEX_KEY)) as TermIndexManifest;

const results = questions.map(question => {
  const terms = buildSearchTerms(question.question);
  const routed = route(manifest, terms);
  const top = routed.candidates[0]?.score ?? 0;
  const last = routed.candidates.at(-1)?.score ?? 0;

  // Reword and require the same case set: word order must not move the search.
  const baseline = routed.candidates.map(row => row.caseNumber).join('|');
  const stable = rewordings(terms).every(variant =>
    route(manifest, variant).candidates.map(row => row.caseNumber).join('|') === baseline
  );

  return {
    id: question.id,
    category: question.category,
    question: question.question,
    terms,
    discriminating: routed.discriminatingTerms.length,
    capped: routed.cappedTerms,
    missing: routed.missingTerms,
    matchedCases: routed.matchedCases,
    corpusShare: Number((routed.matchedCases / manifest.cases * 100).toFixed(2)),
    topScore: Number(top.toFixed(2)),
    // How far the best candidate stands above the last one kept. Near zero
    // means the ranking is not separating them.
    separation: Number((top - last).toFixed(2)),
    stable,
    candidates: routed.candidates.slice(0, 3).map(row => ({
      caseNumber: row.caseNumber,
      score: Number(row.score.toFixed(2)),
      hits: row.hits
    }))
  };
});

if (json) {
  console.log(JSON.stringify({ manifest: { cases: manifest.cases, generation: manifest.generation }, results }, null, 2));
} else {
  console.log(`Term index: ${manifest.cases.toLocaleString()} cases, generation ${manifest.generation}\n`);
  for (const result of results) {
    console.log(`${result.id} [${result.category}] ${result.question}`);
    console.log(`  terms: ${result.terms.join(', ') || '(none)'}`);
    console.log(`  discriminating: ${result.discriminating}`
      + (result.capped.length ? ` | above cap: ${result.capped.join(', ')}` : '')
      + (result.missing.length ? ` | absent: ${result.missing.join(', ')}` : ''));
    console.log(`  matched ${result.matchedCases.toLocaleString()} cases (${result.corpusShare}% of corpus)`
      + ` | separation ${result.separation} | word-order stable: ${result.stable}`);
    for (const candidate of result.candidates) {
      console.log(`    - ${candidate.caseNumber}  score ${candidate.score}  (${candidate.hits} term hits)`);
    }
    console.log('');
  }
  const answered = results.filter(result => result.matchedCases > 0);
  const unstable = results.filter(result => result.matchedCases > 0 && !result.stable);
  console.log('Summary:');
  console.table([{
    questions: results.length,
    reachedCases: answered.length,
    meanMatchedCases: Math.round(answered.reduce((sum, r) => sum + r.matchedCases, 0) / (answered.length || 1)),
    meanSeparation: Number((answered.reduce((sum, r) => sum + r.separation, 0) / (answered.length || 1)).toFixed(2)),
    wordOrderUnstable: unstable.length
  }]);
  if (unstable.length) {
    console.log(`\nWord-order instability in: ${unstable.map(r => r.id).join(', ')}`);
    process.exitCode = 1;
  }
}
