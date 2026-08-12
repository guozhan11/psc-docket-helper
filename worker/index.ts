import { TERM_FILTER_HASHES, termMayExist, tokenizeForFilter } from "../shared/compactSearch.ts";
import {
  TERM_INDEX_KEY,
  TERM_INDEX_VERSION,
  inverseDocumentFrequency,
  termIndexShardKey,
  termShard,
  type TermIndexManifest,
  type TermIndexShard
} from "../shared/termIndex.ts";

type WorkerEnv = Env & {
  OPENAI_API_KEY?: string;
  CF_AIG_TOKEN?: string;
  TURNSTILE_SECRET?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_EXPECTED_HOSTNAME?: string;
};

interface ChatMessage {
  role: "user" | "model";
  content: string;
}

interface ChatRequestBody {
  history: ChatMessage[];
  message: string;
  clientId: string | null;
  turnstileToken: string | null;
}

interface TurnstileSiteverifyResponse {
  success?: boolean;
  hostname?: string;
  action?: string;
  "error-codes"?: string[];
}

export interface SearchRow {
  filing_id: number;
  case_number: string;
  docket_number: string | null;
  title: string;
  received_date: string | null;
  official_pdf_url: string;
  page_number: number;
  text: string;
  rank: number;
  evidence_kind?: "content" | "metadata";
  /**
   * How the case was reached. Cross-case answers carry a scope note, and the
   * note has to describe what actually happened: the inverted index covers
   * every case, the Bloom router samples one partition of sixteen.
   */
  routing?: "exhaustive" | "sampled";
}

type GlobalResultIdentity = Pick<SearchRow, "case_number" | "filing_id" | "page_number">;

type RankableCandidate = {
  filing_id: number;
  received_date: string | null;
  filterHits: number;
  /** Fraction of filter bits set; drives the saturation discount. */
  filterFill?: number;
};

export interface CompactDocumentRow {
  filing_id: number;
  case_number: string;
  docket_number: string | null;
  title: string;
  received_date: string | null;
  official_pdf_url: string;
  r2_key: string | null;
  term_filter: ArrayBuffer | number[] | string | null;
}

interface ManifestDocumentRow {
  filing_id: number;
  case_number: string;
  docket_number: string | null;
  title: string;
  received_date: string | null;
  official_pdf_url: string;
  r2_key?: string | null;
  term_filter_b64?: string | null;
  metadata_only?: boolean;
}

interface CaseManifest {
  version: number;
  caseNumber: string;
  documents: ManifestDocumentRow[];
}

interface CaseManifestResult {
  documents: CompactDocumentRow[];
  complete: boolean;
}

interface CaseRouterIndex {
  version: number;
  generation: string;
  updatedAt: string;
  complete: boolean;
  shardCount: number;
  filterBytes: number;
  filterBands: number;
  manifestObjects: number;
  cases: number;
  contentCases: number;
  documentAssociations: number;
  contentDocumentAssociations: number;
  partKeys: string[];
  compressedBytes: number;
}

interface CaseRouterPart {
  version: number;
  generation: string;
  shardIndex: number;
  shardCount: number;
  filterBytes: number;
  filterBands: number;
  cases: Array<[string, number, number, string | null, number]>;
  filtersB64: string;
}

interface RoutedCase {
  caseNumber: string;
  filterHits: number;
  filterScore: number;
  documentCount: number;
  contentDocuments: number;
  latestReceivedDate: string | null;
  filterBits: number;
}

interface OfficialCase {
  caseNumber: string;
  caseCaption?: string | null;
  companyIndividual?: string | null;
  caseTypeTitle?: string | null;
  industryTypeTitle?: string | null;
  dateOpen?: string | null;
  isOpen?: boolean;
}

interface OfficialFiling {
  docketNumber?: string | null;
  receivedDate?: string | null;
  filingType?: string | null;
  description?: string | null;
  companyOrIndividual?: string | null;
  attachmentId?: number | null;
  attachment?: string | null;
  isConfidential?: boolean;
  isArchived?: boolean;
}

const NEWS_URL = "https://dcpsc.org/Newsroom/Current-PSC-News.aspx";
const NEWSROOM_URL = "https://dcpsc.org/Newsroom.aspx";
const EDOCKET_SEARCH_URL = "https://edocket.dcpsc.org/public/search";
const EDOCKET_API_URL = "https://edocket.dcpsc.org/apis/api/";
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const OPENAI_RESPONSE_START_TIMEOUT_MS = 60_000;
const OPENAI_NON_STREAM_TIMEOUT_MS = 120_000;
const TURNSTILE_SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TURNSTILE_TIMEOUT_MS = 5_000;
const TURNSTILE_ACTION = "turnstile-spin-v2";
const MAX_CHAT_BODY_BYTES = 64 * 1024;
const MAX_MESSAGE_LENGTH = 5_000;
const MAX_HISTORY_MESSAGES = 10;
const MAX_HISTORY_MESSAGE_LENGTH = 5_000;
const MAX_TURNSTILE_TOKEN_LENGTH = 2_048;
const HEALTH_FRESHNESS_MS = 36 * 60 * 60 * 1_000;
const CASE_ROUTER_VERSION = 2;
const CASE_ROUTER_INDEX_KEY = `case-router/v${CASE_ROUTER_VERSION}/index.json`;
const CASE_ROUTER_CANDIDATES = 8;
const CASE_ROUTER_VERIFIED_CASES = 2;
// Each query term costs one shard read, so bound the reads per question. The
// inverted index covers every case regardless; this caps I/O, not coverage.
const TERM_INDEX_MAX_QUERY_TERMS = 8;
// Cross-case questions must stay within the Worker CPU budget. The complete
// router is intentionally split into 16 independent hash partitions; sample a
// deterministic window instead of inflating and scanning all 12 MB per chat.
const CASE_ROUTER_PART_READ_LIMIT = 1;
// Bloom-filter hit counts alone favour long historical filings, because a
// saturated filter matches more terms than a short current one. These weights
// stay below a single extra term match so recency nudges comparable documents
// without letting a recent weak match outrank a strong older one.
export interface RankingWeights {
  queryYearMatch: number;
  recency: number;
  recencySpanYears: number;
  // Discount a document's hit count by the false hits its filter fill predicts.
  // Long filings set more bits, so they match more terms by chance; without
  // this the date weights end up arbitrating a large tie at the top instead of
  // acting on documents that genuinely differ in term evidence.
  saturationAdjusted: boolean;
}

// Date weighting is on because it is measured: across the year-bearing
// evaluation questions it lifts year coverage from 5/9 to 9/9 while leaving the
// genuine term evidence of retrieved filings unchanged (4.00 vs 4.00 distinct
// terms, against an oracle ceiling of 4.19).
//
// Saturation adjustment is off. It reorders results substantially yet showed no
// measurable benefit: term evidence stayed flat (4.01 vs 4.00) and year coverage
// stayed at 9/9. Its only visible effect was shifting median evidence age from 0
// to 1 year. The available quality metrics are confounded by length — longer
// filings genuinely contain more distinct terms — so they cannot validate a
// correction whose whole purpose is to remove a length bias. Deciding this needs
// relevance judgements the evaluation set does not yet carry. Re-measure with
// `npm run eval:retrieval -- --weights` before turning it on.
export const DEFAULT_RANKING_WEIGHTS: RankingWeights = {
  queryYearMatch: 0.9,
  recency: 0.6,
  recencySpanYears: 12,
  saturationAdjusted: false
};
// Evidence budget sent to the model. Excerpt slots are filled round-robin, one
// per filing, before any filing receives a second excerpt.
export const EVIDENCE_ROW_BUDGET = 8;
export const EVIDENCE_MAX_PER_DOCUMENT = 2;
// Read enough distinct filings that a well-ranked but lower-placed document
// still reaches the evidence set instead of being cut off by earlier hits.
//
// This MUST stay at or below EVIDENCE_ROW_BUDGET: round-robin gives the first
// EVIDENCE_ROW_BUDGET filings a slot each, so any filing read beyond that can
// never win one, and reading it only costs an R2 GET plus a full gzip decode.
// Staying below the ceiling is also deliberate — it reserves slots for the
// best-ranked filings to contribute a second excerpt, which keeps a table and
// its surrounding discussion together instead of splitting them.
// `retrieval budget invariant` in worker/index.test.ts enforces the bound.
export const COMPACT_DOCUMENT_GROUP_TARGET = 6;
const API_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff"
};

function searchDatabases(env: WorkerEnv): D1Database[] {
  return [env.DB, env.DB_1, env.DB_2];
}

function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return Response.json(data, { status, headers: { ...API_HEADERS, ...headers } });
}

function elapsedMs(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}

function logChatStage(
  requestId: string,
  stage: string,
  startedAt: number,
  details: Record<string, unknown> = {}
): void {
  console.log(JSON.stringify({
    message: "chat stage complete",
    requestId,
    stage,
    durationMs: elapsedMs(startedAt),
    ...details
  }));
}

function numericStateValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function stateArrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isChatMessage(value: unknown): value is ChatMessage {
  return isRecord(value)
    && (value.role === "user" || value.role === "model")
    && typeof value.content === "string"
    && value.content.length <= MAX_HISTORY_MESSAGE_LENGTH;
}

export function parseChatRequestBody(value: unknown): ChatRequestBody | null {
  if (!isRecord(value) || typeof value.message !== "string") return null;
  const message = value.message.trim();
  if (!message || message.length > MAX_MESSAGE_LENGTH) return null;
  const rawHistory = value.history ?? [];
  if (!Array.isArray(rawHistory) || rawHistory.length > MAX_HISTORY_MESSAGES
    || !rawHistory.every(isChatMessage)) return null;
  const clientId = typeof value.clientId === "string" && /^[a-f0-9-]{20,64}$/i.test(value.clientId)
    ? value.clientId
    : null;
  const turnstileToken = typeof value.turnstileToken === "string"
    && value.turnstileToken.length > 0
    && value.turnstileToken.length <= MAX_TURNSTILE_TOKEN_LENGTH
    ? value.turnstileToken
    : null;
  return { history: rawHistory, message, clientId, turnstileToken };
}

async function readLimitedJson(request: Request): Promise<unknown> {
  const contentLength = Number(request.headers.get("Content-Length") ?? 0);
  if (contentLength > MAX_CHAT_BODY_BYTES) throw new Error("request-too-large");
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_CHAT_BODY_BYTES) {
      await reader.cancel();
      throw new Error("request-too-large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return null;
  }
}

function rateLimitActor(request: Request, clientId: string | null): string {
  if (clientId) return `client:${clientId}`;
  const clientIp = request.headers.get("CF-Connecting-IP") ?? "unknown";
  return `ip:${clientIp}`;
}

async function verifyTurnstile(
  request: Request,
  env: WorkerEnv,
  token: string | null,
  requestId: string
): Promise<boolean> {
  if (!env.TURNSTILE_SECRET) return true;
  if (!token) return false;
  const remoteIp = request.headers.get("CF-Connecting-IP") ?? "";
  const form = new URLSearchParams({
    secret: env.TURNSTILE_SECRET,
    response: token,
    idempotency_key: requestId
  });
  if (remoteIp) form.set("remoteip", remoteIp);
  try {
    const response = await fetch(TURNSTILE_SITEVERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
      signal: AbortSignal.timeout(TURNSTILE_TIMEOUT_MS)
    });
    if (!response.ok) return false;
    const result = await response.json<TurnstileSiteverifyResponse>();
    if (result.success !== true || result.action !== TURNSTILE_ACTION) return false;
    return !env.TURNSTILE_EXPECTED_HOSTNAME
      || result.hostname === env.TURNSTILE_EXPECTED_HOSTNAME;
  } catch (error) {
    console.error(JSON.stringify({
      message: "Turnstile validation unavailable",
      requestId,
      error: error instanceof Error ? error.message : String(error)
    }));
    return false;
  }
}

async function readR2Json(object: R2ObjectBody | null, key: string): Promise<unknown> {
  if (!object) return null;
  try {
    return JSON.parse(await object.text()) as unknown;
  } catch (error) {
    console.error(JSON.stringify({
      message: "R2 JSON unavailable",
      key,
      size: object.size,
      error: error instanceof Error ? error.message : String(error)
    }));
    return null;
  }
}

const R2_HEALTH_READ_ATTEMPTS = 3;
const R2_HEALTH_RETRY_DELAY_MS = 25;
const HEALTH_LAST_KNOWN_GOOD_TTL_SECONDS = 300;

export async function readR2JsonWithRetry(
  bucket: Pick<R2Bucket, "get">,
  key: string,
  attempts = R2_HEALTH_READ_ATTEMPTS
): Promise<unknown> {
  const boundedAttempts = Math.max(1, attempts);
  for (let attempt = 1; attempt <= boundedAttempts; attempt += 1) {
    try {
      const payload = await readR2Json(await bucket.get(key), key);
      if (payload !== null) return payload;
    } catch (error) {
      console.error(JSON.stringify({
        message: "R2 health read failed",
        key,
        attempt,
        error: error instanceof Error ? error.message : String(error)
      }));
    }
    if (attempt < boundedAttempts) {
      await new Promise(resolve => setTimeout(resolve, R2_HEALTH_RETRY_DELAY_MS * attempt));
    }
  }
  return null;
}

function healthCacheRequest(request: Request): Request {
  const cacheUrl = new URL(request.url);
  cacheUrl.search = "?snapshot=last-known-good";
  return new Request(cacheUrl.toString(), { method: "GET" });
}

async function cacheHealthySnapshot(request: Request, payload: Record<string, unknown>): Promise<void> {
  try {
    await caches.default.put(healthCacheRequest(request), new Response(JSON.stringify({
      ...payload,
      cachedAt: new Date().toISOString()
    }), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": `public, max-age=${HEALTH_LAST_KNOWN_GOOD_TTL_SECONDS}`
      }
    }));
  } catch (error) {
    console.error(JSON.stringify({
      message: "Unable to cache healthy snapshot",
      error: error instanceof Error ? error.message : String(error)
    }));
  }
}

async function lastKnownGoodHealth(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const response = await caches.default.match(healthCacheRequest(request));
    if (!response) return null;
    const payload: unknown = await response.json();
    return isRecord(payload) ? payload : null;
  } catch (error) {
    console.error(JSON.stringify({
      message: "Unable to read cached healthy snapshot",
      error: error instanceof Error ? error.message : String(error)
    }));
    return null;
  }
}

export function fullTextCoverageSummary(
  ingestionShards: Array<Record<string, unknown> | null>,
  publicPdfRecords: number,
  stateAvailable = true
) {
  const indexedDocuments = ingestionShards.reduce(
    (total, shard) => total + numericStateValue(shard?.documentsIndexed),
    0
  );
  const retryPendingDocuments = ingestionShards.reduce(
    (total, shard) => total + stateArrayLength(shard?.failedFilingIds),
    0
  );
  const unavailableDocuments = ingestionShards.reduce(
    (total, shard) => total + stateArrayLength(shard?.unavailableFilingIds),
    0
  );
  const searchablePercent = stateAvailable && publicPdfRecords > 0
    ? Math.min(100, Number((indexedDocuments * 100 / publicPdfRecords).toFixed(2)))
    : null;
  const accountedPercent = stateAvailable && publicPdfRecords > 0
    ? Math.min(100, Number(((indexedDocuments + unavailableDocuments) * 100 / publicPdfRecords).toFixed(2)))
    : null;
  return {
    source: "r2-ingestion-state",
    stateAvailable,
    indexedDocuments,
    publicPdfRecords,
    retryPendingDocuments,
    unavailableDocuments,
    unaccountedDocuments: stateAvailable
      ? Math.max(0, publicPdfRecords - indexedDocuments - unavailableDocuments)
      : null,
    searchablePercent,
    accountedPercent,
    complete: stateAvailable
      && publicPdfRecords > 0
      && retryPendingDocuments === 0
      && indexedDocuments + unavailableDocuments >= publicPdfRecords
  };
}

function isFreshTimestamp(value: unknown, now = Date.now()): boolean {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && now - timestamp <= HEALTH_FRESHNESS_MS;
}

export function selectDiverseGlobalResults<T extends GlobalResultIdentity>(
  groups: T[][],
  maxPerCase = 3,
  totalLimit = 8
): T[] {
  const selected = new Map<string, T>();
  for (const group of groups) {
    for (const row of group.slice(0, maxPerCase)) {
      selected.set(`${row.filing_id}:${row.page_number}`, row);
    }
  }
  return Array.from(selected.values()).slice(0, totalLimit);
}

// Round-robin across filings so breadth wins the first slots. Taking every
// excerpt from the top document first lets one long filing consume the whole
// evidence budget even when other filings answer the question better.
export function selectDiverseDocumentResults<T extends GlobalResultIdentity>(
  groups: T[][],
  maxPerDocument = EVIDENCE_MAX_PER_DOCUMENT,
  totalLimit = EVIDENCE_ROW_BUDGET
): T[] {
  const selected = new Map<string, T>();
  for (let depth = 0; depth < maxPerDocument; depth += 1) {
    for (const group of groups) {
      const row = group[depth];
      if (!row) continue;
      selected.set(`${row.filing_id}:${row.page_number}`, row);
      if (selected.size >= totalLimit) return Array.from(selected.values());
    }
  }
  return Array.from(selected.values());
}

export function extractQueryYears(message: string): number[] {
  const currentYear = new Date().getUTCFullYear();
  const years = Array.from(message.matchAll(/\b(19|20)\d{2}\b/g), match => Number(match[0]));
  // A filing cannot document a year that has not happened yet, and stray
  // four-digit numbers outside the docket era are not dates.
  return Array.from(new Set(years.filter(year => year >= 1990 && year <= currentYear + 1)));
}

function documentYear(receivedDate: string | null): number | null {
  if (!receivedDate) return null;
  const year = Number(String(receivedDate).slice(0, 4));
  return Number.isInteger(year) && year >= 1900 ? year : null;
}

// Blends term evidence with filing date. `filterHits` stays the dominant term
// so a document matching more query terms still outranks a merely newer one.
export function documentRankingScore(
  filterHits: number,
  receivedDate: string | null,
  queryYears: number[],
  now = Date.now(),
  weights: RankingWeights = DEFAULT_RANKING_WEIGHTS
): number {
  const year = documentYear(receivedDate);
  if (year === null) return filterHits;
  let score = filterHits;
  if (queryYears.length) {
    // A filing reporting on a year is normally submitted during it or shortly
    // after, so accept the named year and the one following it.
    const matchesQueryYear = queryYears.some(queryYear => year === queryYear || year === queryYear + 1);
    if (matchesQueryYear) score += weights.queryYearMatch;
  }
  const ageYears = new Date(now).getUTCFullYear() - year;
  const freshness = Math.min(1, Math.max(0, 1 - ageYears / weights.recencySpanYears));
  return score + weights.recency * freshness;
}

/** Fraction of bits set in a term filter. Rises with document length. */
export function filterFillRatio(filter: Uint8Array): number {
  if (!filter.byteLength) return 0;
  let bits = 0;
  for (const byte of filter) {
    let value = byte;
    while (value) {
      value &= value - 1;
      bits += 1;
    }
  }
  return bits / (filter.byteLength * 8);
}

/**
 * Removes the hits a filter of this fill would produce by chance. A Bloom
 * filter reports a false positive with probability fill^hashes, so a long
 * saturated filing gets its inflated hit count corrected back toward the
 * evidence it actually carries.
 */
export function saturationAdjustedHits(
  filterHits: number,
  termCount: number,
  fillRatio: number,
  hashes = TERM_FILTER_HASHES
): number {
  const falsePositiveRate = Math.pow(Math.min(1, Math.max(0, fillRatio)), hashes);
  return Math.max(0, filterHits - termCount * falsePositiveRate);
}

// Shared by the Worker and the offline retrieval evaluation so that measured
// ranking behaviour cannot drift from what production actually does.
export function rankCompactCandidates<T extends RankableCandidate>(
  candidates: T[],
  queryYears: number[],
  now = Date.now(),
  weights: RankingWeights = DEFAULT_RANKING_WEIGHTS,
  termCount = 0
): T[] {
  const scoreOf = new Map(candidates.map(document => [
    document.filing_id,
    documentRankingScore(
      weights.saturationAdjusted
        ? saturationAdjustedHits(document.filterHits, termCount || document.filterHits, document.filterFill ?? 0)
        : document.filterHits,
      document.received_date,
      queryYears,
      now,
      weights
    )
  ]));
  return [...candidates].sort((left, right) =>
    (scoreOf.get(right.filing_id) ?? 0) - (scoreOf.get(left.filing_id) ?? 0)
    || String(right.received_date || "").localeCompare(String(left.received_date || "")));
}

function isOfficialPscUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === "dcpsc.org" || hostname.endsWith(".dcpsc.org");
  } catch {
    return false;
  }
}

function isOfficialEdocketAttachmentUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const guidFileName = (url.searchParams.get("guidFileName") ?? "")
      .replace(/(?:#|%23).*$/i, "");
    return url.protocol === "https:"
      && url.hostname.toLowerCase() === "edocket.dcpsc.org"
      && url.pathname.toLowerCase() === "/apis/api/filing/download"
      && /^\d+$/.test(url.searchParams.get("attachId") ?? "")
      && /^[\w.-]+\.pdf$/i.test(guidFileName);
  } catch {
    return false;
  }
}

function officialPdfPageUrl(row: Pick<SearchRow, "official_pdf_url" | "page_number">): string {
  try {
    const url = new URL(row.official_pdf_url);
    url.hash = `page=${Math.max(1, Math.trunc(row.page_number))}`;
    return url.href;
  } catch {
    return row.official_pdf_url;
  }
}

function citationTitle(title: string): string {
  const clean = title.replace(/[\[\]\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  return clean.length > 120 ? `${clean.slice(0, 117).trimEnd()}...` : clean;
}

function filingCitation(row: SearchRow): string {
  if (row.evidence_kind === "metadata") {
    return `[${citationTitle(row.title)} — filing record](${row.official_pdf_url})`;
  }
  return `[${citationTitle(row.title)} — p. ${row.page_number}](${officialPdfPageUrl(row)})`;
}

function replaceOpaqueSourceLabels(reply: string, rows: SearchRow[]): string {
  return rows.reduce((updated, row, index) => {
    const sourceNumber = index + 1;
    const pageSuffix = "(?:\\s*,?\\s*p(?:age)?\\.?\\s*\\d+)?";
    const linkedOrBracketed = new RegExp(
      `\\[\\s*Source\\s+${sourceNumber}${pageSuffix}\\s*\\](?:\\([^\\n)]+\\))?`,
      "gi"
    );
    const plain = new RegExp(`\\bSource\\s+${sourceNumber}${pageSuffix}\\b`, "gi");
    return updated
      .replace(linkedOrBracketed, filingCitation(row))
      .replace(plain, filingCitation(row));
  }, reply);
}

function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function stripHtml(value: string): string {
  return decodeHtml(value.replace(/<[^>]*>/g, " "));
}

function parseNews(html: string) {
  const items: Array<Record<string, string>> = [];
  const blocks = html.split('<div class="blog-list style-1">').slice(1);
  for (const block of blocks) {
    const anchor = block.match(/<h2>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h2>/i);
    if (!anchor) continue;
    const url = new URL(decodeHtml(anchor[1]), "https://dcpsc.org").href;
    if (!isOfficialPscUrl(url)) continue;
    const title = stripHtml(anchor[2]);
    const summary = block.match(/<p>([\s\S]*?)<\/p>/i);
    const date = block.match(/fa-calendar-o[\s\S]*?<\/i>\s*([^<\n]+)/i);
    items.push({
      title,
      date: date ? decodeHtml(date[1]) : "Latest update",
      summary: summary ? stripHtml(summary[1]) : title,
      url,
      source: "DCPSC Current PSC News"
    });
  }
  return items.slice(0, 5);
}

function extractCaseIdentifier(text: string): string | null {
  const match = text.match(/\b(?:FC|formal\s+case|case|docket)\s*(?:no\.?|number)?\s*[-#:]?\s*(\d{3,5})\b/i);
  if (match?.[1]) return `FC${match[1]}`;
  const identifier = text.match(/\b([a-z]{1,12}-?\d{3,5}(?:-[a-z0-9]{1,8}){0,3})\b/i)?.[1];
  return identifier?.toUpperCase() ?? null;
}

function isSimpleCaseNumberQuery(text: string): boolean {
  return /^(?:(?:fc|formal\s+case|case|docket)\s*(?:no\.?|number)?\s*[-#:]*\s*)?\d{3,5}$/i.test(text.trim())
    || /^[a-z]{1,12}-?\d{3,5}(?:-[a-z0-9]{1,8}){0,3}$/i.test(text.trim());
}

export function isCredentialOrPromptExtractionRequest(text: string): boolean {
  const normalized = text.toLowerCase();
  return /(system|developer)\s+(prompt|instructions?)/.test(normalized)
    || /(api|secret|access)\s*keys?/.test(normalized)
    || /reveal.{0,40}(prompt|instructions?|keys?|secrets?)/.test(normalized)
    || /ignore.{0,40}(previous|prior|system|developer).{0,40}(instructions?|prompt)/.test(normalized);
}

function formatEdocketDate(value: string | null | undefined): string {
  if (!value) return "Unknown";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

function getResultsSet<T>(data: unknown): T[] {
  if (!data || typeof data !== "object" || !("resultsSet" in data)) return [];
  const results = (data as { resultsSet?: unknown }).resultsSet;
  return Array.isArray(results) ? results as T[] : [];
}

async function fetchEdocketJson(endpoint: string, params: Record<string, string | number | boolean>): Promise<unknown> {
  const url = new URL(endpoint, EDOCKET_API_URL);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  const response = await fetch(url.href, {
    headers: { Accept: "application/json", "User-Agent": "PSC-Docket-Assistant/1.0 (+https://dcpsc.org/)" }
  });
  if (!response.ok) throw new Error(`e-Docket API returned ${response.status} for ${endpoint}`);
  return response.json();
}

async function getOfficialCasesByNumber(caseNumber: string): Promise<OfficialCase[]> {
  const data = await fetchEdocketJson("Case/GetCaseTable", {
    caseNumber, recordsToSkip: 0, recordsToShow: 25, orderByColumn: "DateOpen",
    sortBy: "DESC", isPublicComments: "N", isUser: false
  });
  return getResultsSet<OfficialCase>(data).filter(item => typeof item?.caseNumber === "string");
}

async function getOfficialFilingsByCaseNumber(caseNumber: string): Promise<OfficialFiling[]> {
  const data = await fetchEdocketJson("Filing/GetFilings", {
    caseNumber, isAdmin: false, orderByColumn: "receivedDate", sortBy: "desc",
    recordsToSkip: 0, recordsToShow: 25
  });
  return getResultsSet<OfficialFiling>(data);
}

function getEdocketCaseSearchUrl(caseNumber: string): string {
  return `${EDOCKET_SEARCH_URL}/casenumber/${encodeURIComponent(caseNumber)}`;
}

function getEdocketFilingDetailUrl(filing: OfficialFiling, preferredCaseNumber?: string): string | null {
  if (!filing.docketNumber || filing.isConfidential || filing.isArchived) return null;
  const dockets = filing.docketNumber.split(", ");
  const preferredIdentifier = preferredCaseNumber
    ? (/^[a-z]/i.test(preferredCaseNumber) ? preferredCaseNumber : `FC${preferredCaseNumber}`)
    : null;
  const preferredDocket = preferredIdentifier
    ? dockets.find(docket => new RegExp(`^${preferredIdentifier}\\s*-`, "i").test(docket.trim()))
    : null;
  const primaryDocket = preferredDocket ?? dockets[0];
  const parts = primaryDocket.split(" - ").map(part => part.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  return `${EDOCKET_SEARCH_URL}/details/${encodeURIComponent(parts[0])}/${encodeURIComponent(parts.at(-1)!)}`;
}

function getEdocketAttachmentUrl(filing: OfficialFiling): string | null {
  if (!filing.attachmentId || !filing.attachment || filing.isConfidential || filing.isArchived
    || !filing.attachment.toLowerCase().endsWith(".pdf")) return null;
  const params = new URLSearchParams({ attachId: String(filing.attachmentId), guidFileName: filing.attachment });
  return `${EDOCKET_API_URL}Filing/download?${params.toString()}`;
}

async function buildDetailedCaseNumberReply(message: string): Promise<string | null> {
  if (!isSimpleCaseNumberQuery(message)) return null;
  const caseIdentifier = extractCaseIdentifier(message) ?? (message.match(/(\d{3,5})/)?.[1]
    ? `FC${message.match(/(\d{3,5})/)![1]}` : null);
  if (!caseIdentifier) return null;
  const apiCaseNumber = caseIdentifier.replace(/^FC/i, "");
  const cases = await getOfficialCasesByNumber(apiCaseNumber);
  const primaryCase = cases.find(item => item.caseNumber.toUpperCase() === caseIdentifier);
  if (!primaryCase) {
    return `I couldn't find an exact official record for **${caseIdentifier}**. You can verify alternate prefixes in the [official e-Docket search](${getEdocketCaseSearchUrl(apiCaseNumber)}).`;
  }

  const relatedCases = cases.filter(item => item !== primaryCase).slice(0, 4);
  const escapedIdentifier = caseIdentifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const docketPattern = new RegExp(`(?:^|,\\s*)${escapedIdentifier}\\s*-`, "i");
  const filings = (await getOfficialFilingsByCaseNumber(apiCaseNumber))
    .filter(filing => !filing.isArchived && !filing.isConfidential && docketPattern.test(filing.docketNumber || ""))
    .slice(0, 5);

  const lines = [
    `**${primaryCase.caseNumber}**`,
    "",
    stripHtml(primaryCase.caseCaption || primaryCase.companyIndividual || "Official e-Docket case record."),
    "",
    `- Status: ${primaryCase.isOpen ? "Open" : "Closed"}`,
    `- Case type: ${primaryCase.caseTypeTitle || "Unknown"}`,
    `- Industry: ${primaryCase.industryTypeTitle || "Unknown"}`,
    `- Opened: ${formatEdocketDate(primaryCase.dateOpen)}`,
    `- Official search: [View this case in e-Docket](${getEdocketCaseSearchUrl(apiCaseNumber)})`
  ];

  if (relatedCases.length) {
    lines.push("", `**Associated records:**`, ...relatedCases.map(item =>
      `- ${item.caseNumber}: ${stripHtml(item.caseCaption || item.companyIndividual || item.caseTypeTitle || "Related e-Docket record")}`
    ));
  }

  if (filings.length) {
    lines.push("", "**Recent public filings:**", ...filings.map(filing => {
      const detailUrl = getEdocketFilingDetailUrl(filing, apiCaseNumber);
      const attachmentUrl = getEdocketAttachmentUrl(filing);
      const links = [
        detailUrl ? `[Detail](${detailUrl})` : null,
        attachmentUrl ? `[PDF](${attachmentUrl})` : null
      ].filter(Boolean).join(" | ");
      const description = stripHtml(filing.filingType || filing.description || "Filing");
      return `- ${filing.docketNumber} (${formatEdocketDate(filing.receivedDate)}): ${description} by ${filing.companyOrIndividual || "Unknown filer"}${links ? ` — ${links}` : ""}`;
    }));
  }

  lines.push("", "All information and links above come from the official e-Docket public API.");
  return lines.join("\n");
}

const STOP_WORDS = new Set([
  "about", "after", "also", "an", "and", "are", "can", "could", "document", "documents",
  "case", "cases", "commission", "dc", "discuss", "discussed", "discusses", "discussion",
  "across", "docket", "dockets", "filing", "filings", "find", "for", "from", "give", "have", "into", "link", "links", "mention",
  "mentions", "please", "psc", "that", "the",
  "number", "numbers", "official", "recent", "their", "this", "was", "were", "what", "when", "where", "which", "with", "would",
  "in", "is", "it", "of", "or", "to"
]);

export function buildSearchTerms(message: string): string[] {
  const quoted = Array.from(message.matchAll(/[“\"]([^”\"]{2,80})[”\"]/g), match => match[1]);
  const words = (quoted.join(" ") + " " + message)
    .toLowerCase()
    .match(/[a-z0-9][a-z0-9'-]{1,39}/g) ?? [];
  return Array.from(new Set(words))
    .filter(term => !STOP_WORDS.has(term) && !/^fc?\d+$/.test(term))
    .slice(0, 12);
}

function toFilterBytes(value: ArrayBuffer | number[] | string): Uint8Array {
  if (typeof value === "string") {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }
  return new Uint8Array(value);
}

function isCaseRouterIndex(value: unknown): value is CaseRouterIndex {
  if (!value || typeof value !== "object") return false;
  const index = value as Partial<CaseRouterIndex>;
  return index.version === CASE_ROUTER_VERSION
    && typeof index.generation === "string"
    && typeof index.updatedAt === "string"
    && index.complete === true
    && Number.isInteger(index.shardCount)
    && Number.isInteger(index.filterBytes)
    && Number.isInteger(index.filterBands)
    && index.filterBands > 0
    && Array.isArray(index.partKeys)
    && index.partKeys.length === index.shardCount
    && index.partKeys.every(key => typeof key === "string" && key.startsWith("case-router/"));
}

async function loadCaseRouterIndex(env: WorkerEnv): Promise<CaseRouterIndex | null> {
  const object = await env.DOCUMENTS.get(CASE_ROUTER_INDEX_KEY);
  if (!object || object.size > 256 * 1024) return null;
  const payload = await readR2Json(object, CASE_ROUTER_INDEX_KEY);
  return isCaseRouterIndex(payload) ? payload : null;
}

function compareRoutedCases(left: RoutedCase, right: RoutedCase): number {
  return right.filterHits - left.filterHits
    || right.filterScore - left.filterScore
    // Smaller cases are less likely to have a saturated aggregate filter.
    || left.filterBits - right.filterBits
    || left.contentDocuments - right.contentDocuments
    || String(right.latestReceivedDate || "").localeCompare(String(left.latestReceivedDate || ""));
}

function isTermIndexManifest(value: unknown): value is TermIndexManifest {
  if (!isRecord(value)) return false;
  return value.version === TERM_INDEX_VERSION
    && typeof value.generation === "string"
    && typeof value.updatedAt === "string"
    && value.complete === true
    && Number.isInteger(value.shardCount)
    && Number(value.shardCount) > 0
    && Number.isInteger(value.cases)
    && Number(value.cases) > 0
    && typeof value.shardKeyPrefix === "string"
    && value.shardKeyPrefix.startsWith("term-index/");
}

async function loadTermIndexManifest(env: WorkerEnv): Promise<TermIndexManifest | null> {
  const object = await env.DOCUMENTS.get(TERM_INDEX_KEY);
  if (!object || object.size > 64 * 1024) return null;
  const payload = await readR2Json(object, TERM_INDEX_KEY);
  return isTermIndexManifest(payload) ? payload : null;
}

/**
 * Cross-case routing over the inverted index.
 *
 * The Bloom router tests every case, so it costs O(cases) and had to sample one
 * partition. Here a question reads only the shards holding its own terms, which
 * costs O(terms) and covers every case. Scoring is IDF-weighted, so a hit on a
 * term present in most filings cannot outweigh a hit on a rare one.
 *
 * Returns null — not an empty list — when the index is unavailable, so the
 * caller can fall back to the Bloom router rather than treat it as "no match".
 */
export async function routeCasesByTermIndex(
  env: WorkerEnv,
  terms: string[],
  requestId: string
): Promise<RoutedCase[] | null> {
  if (!terms.length) return null;
  const startedAt = performance.now();
  const manifest = await loadTermIndexManifest(env);
  if (!manifest) {
    logChatStage(requestId, "term-index", startedAt, { outcome: "unavailable" });
    return null;
  }

  const wanted = terms.slice(0, TERM_INDEX_MAX_QUERY_TERMS);
  // Several terms can land in one shard; read each shard once.
  const shardTerms = new Map<number, string[]>();
  for (const term of wanted) {
    const shard = termShard(term, manifest.shardCount);
    shardTerms.set(shard, [...(shardTerms.get(shard) ?? []), term]);
  }

  const scores = new Map<string, { score: number; hits: number }>();
  let shardsRead = 0;
  let cappedTerms = 0;
  const shardEntries = Array.from(shardTerms.entries());
  const results = await Promise.all(shardEntries.map(async ([shardIndex, shardTermList]) => {
    const key = termIndexShardKey(
      manifest.activeSlot,
      shardIndex,
      manifest.shardCount
    );
    try {
      const object = await env.DOCUMENTS.get(key);
      if (!object || object.size > 8 * 1024 * 1024) return null;
      const stream = object.body.pipeThrough(new DecompressionStream("gzip"));
      const payload = JSON.parse(await new Response(stream).text()) as TermIndexShard;
      if (payload.version !== TERM_INDEX_VERSION
        || payload.generation !== manifest.generation
        || payload.shardCount !== manifest.shardCount
        || !isRecord(payload.terms)) return null;
      return { shardTermList, payload };
    } catch (error) {
      console.error(JSON.stringify({
        message: "term index shard unavailable",
        error: error instanceof Error ? error.message : String(error),
        key
      }));
      return null;
    }
  }));

  for (const result of results) {
    if (!result) continue;
    shardsRead += 1;
    for (const term of result.shardTermList) {
      const entry = result.payload.terms[term];
      if (!Array.isArray(entry) || !entry.length) continue;
      const documentFrequency = Number(entry[0]) || 0;
      const cases = entry.slice(1) as string[];
      if (!cases.length) {
        // Above the frequency cap: kept for its frequency, no postings. Such a
        // term appears nearly everywhere and cannot separate cases.
        cappedTerms += 1;
        continue;
      }
      const weight = inverseDocumentFrequency(documentFrequency, manifest.cases);
      if (weight <= 0) continue;
      for (const caseNumber of cases) {
        if (typeof caseNumber !== "string") continue;
        const current = scores.get(caseNumber) ?? { score: 0, hits: 0 };
        current.score += weight;
        current.hits += 1;
        scores.set(caseNumber, current);
      }
    }
  }

  // The Bloom router required two term matches because a single hit was often a
  // filter false positive. Postings are exact, and IDF already discounts terms
  // that cannot discriminate, so a hit count would now do harm: it would admit
  // a case matching two ubiquitous terms while rejecting one matching only the
  // rare term the question turns on. Rank by accumulated IDF instead.
  const candidates: RoutedCase[] = Array.from(scores.entries())
    .map(([caseNumber, value]) => ({
      caseNumber,
      filterHits: value.hits,
      filterScore: value.score,
      documentCount: 0,
      contentDocuments: 0,
      latestReceivedDate: null,
      filterBits: 0
    }))
    // IDF score leads: matching more rare terms beats matching more terms.
    .sort((left, right) => right.filterScore - left.filterScore
      || right.filterHits - left.filterHits
      || left.caseNumber.localeCompare(right.caseNumber))
    .slice(0, CASE_ROUTER_CANDIDATES);

  logChatStage(requestId, "term-index", startedAt, {
    outcome: "complete",
    shardsRead,
    expectedShards: shardEntries.length,
    totalShards: manifest.shardCount,
    terms: wanted.length,
    cappedTerms,
    matchedCases: scores.size,
    candidates: candidates.length
  });
  return candidates;
}

async function routeCases(
  env: WorkerEnv,
  terms: string[],
  requestId: string
): Promise<RoutedCase[]> {
  if (!terms.length) return [];
  const startedAt = performance.now();
  const index = await loadCaseRouterIndex(env);
  if (!index) {
    logChatStage(requestId, "case-router", startedAt, { outcome: "unavailable" });
    return [];
  }

  let candidates: RoutedCase[] = [];
  const requiredTermMatches = Math.min(2, terms.length);
  let partsRead = 0;
  const routeSeed = terms.join("|").split("").reduce(
    (hash, character) => ((hash * 31) + character.charCodeAt(0)) >>> 0,
    0
  );
  const orderedKeys = Array.from(
    { length: Math.min(CASE_ROUTER_PART_READ_LIMIT, index.partKeys.length) },
    (_, offset) => index.partKeys[(routeSeed + offset) % index.partKeys.length]
  );
  for (const key of orderedKeys) {
    const object = await env.DOCUMENTS.get(key);
    if (!object || object.size > 8 * 1024 * 1024) continue;
    const stream = object.body.pipeThrough(new DecompressionStream("gzip"));
    const payload = JSON.parse(await new Response(stream).text()) as CaseRouterPart;
    if (payload.version !== index.version
      || payload.generation !== index.generation
      || payload.shardCount !== index.shardCount
      || payload.filterBytes !== index.filterBytes
      || payload.filterBands !== index.filterBands
      || !Array.isArray(payload.cases)
      || typeof payload.filtersB64 !== "string") continue;
    const filters = toFilterBytes(payload.filtersB64);
    const caseFilterBytes = payload.filterBytes * payload.filterBands;
    if (filters.byteLength !== payload.cases.length * caseFilterBytes) continue;
    partsRead += 1;
    for (let caseIndex = 0; caseIndex < payload.cases.length; caseIndex += 1) {
      const [caseNumber, documentCount, contentDocuments, latestReceivedDate, filterBits] = payload.cases[caseIndex];
      if (typeof caseNumber !== "string" || !Number.isFinite(contentDocuments)) continue;
      const start = caseIndex * caseFilterBytes;
      const bandHits = terms.map(term => {
        let hits = 0;
        for (let bandIndex = 0; bandIndex < payload.filterBands; bandIndex += 1) {
          const bandStart = start + bandIndex * payload.filterBytes;
          const filter = filters.subarray(bandStart, bandStart + payload.filterBytes);
          if (termMayExist(filter, term)) hits += 1;
        }
        return hits;
      });
      const filterHits = bandHits.filter(hits => hits > 0).length;
      if (filterHits < requiredTermMatches) continue;
      candidates.push({
        caseNumber,
        filterHits,
        filterScore: bandHits.reduce((total, hits) => total + hits, 0),
        documentCount: Number(documentCount) || 0,
        contentDocuments: Number(contentDocuments) || 0,
        latestReceivedDate: typeof latestReceivedDate === "string" ? latestReceivedDate : null,
        filterBits: Number(filterBits) || payload.filterBytes * payload.filterBands * 8
      });
    }
    candidates.sort(compareRoutedCases);
    candidates = candidates.slice(0, CASE_ROUTER_CANDIDATES);
  }
  logChatStage(requestId, "case-router", startedAt, {
    outcome: partsRead === orderedKeys.length ? "bounded-success" : "partial",
    partsRead,
    expectedParts: orderedKeys.length,
    totalParts: index.shardCount,
    candidates: candidates.length
  });
  return candidates;
}

async function loadManifestObject(
  env: WorkerEnv,
  caseNumber: string,
  key: string
): Promise<CompactDocumentRow[] | null> {
  const object = await env.DOCUMENTS.get(key);
  if (!object) return null;
  if (object.size > 32 * 1024 * 1024) {
    throw new Error(`Case manifest is too large: ${key} (${object.size} bytes)`);
  }
  const stream = object.body.pipeThrough(new DecompressionStream("gzip"));
  const payload = JSON.parse(await new Response(stream).text()) as CaseManifest;
  if (![1, 2].includes(payload.version) || payload.caseNumber !== caseNumber || !Array.isArray(payload.documents)) {
    throw new Error(`Invalid case manifest: ${key}`);
  }
  return payload.documents.map(document => ({
    filing_id: Number(document.filing_id),
    case_number: document.case_number,
    docket_number: document.docket_number,
    title: document.title,
    received_date: document.received_date,
    official_pdf_url: document.official_pdf_url,
    r2_key: document.r2_key ?? null,
    term_filter: document.term_filter_b64 ?? null
  }));
}

async function loadCaseManifest(env: WorkerEnv, caseNumber: string): Promise<CaseManifestResult> {
  if (!/^[A-Z][A-Z0-9-]{2,30}$/.test(caseNumber)) return { documents: [], complete: false };
  const legacyKey = `manifests/${caseNumber}.json.gz`;
  const currentKeys = Array.from(
    { length: 4 },
    (_, shardIndex) => `manifests-v2/${caseNumber}/part-${shardIndex}-of-4.json.gz`
  );
  const keys = [legacyKey, ...currentKeys];
  const groups = await Promise.all(keys.map(async key => {
    try {
      return { documents: await loadManifestObject(env, caseNumber, key), failed: false };
    } catch (error) {
      console.error(JSON.stringify({
        message: "R2 manifest shard unavailable",
        error: String(error),
        caseNumber,
        key
      }));
      return { documents: null, failed: true };
    }
  }));
  const documents = new Map<number, CompactDocumentRow>();
  for (const document of groups.flatMap(group => group.documents ?? [])) {
    const existing = documents.get(document.filing_id);
    if (!existing || (!existing.r2_key && document.r2_key)) {
      documents.set(document.filing_id, document);
    }
  }
  return {
    documents: Array.from(documents.values()),
    // A missing per-shard object normally means that case has no filings in
    // that chronological shard. Existing v2 data is authoritative as long as
    // none of the four reads failed.
    complete: groups.slice(1).some(group => group.documents !== null)
      && groups.slice(1).every(group => !group.failed)
  };
}

export function findPageExcerpts(
  html: string,
  terms: string[],
  document: CompactDocumentRow,
  minimumTermMatches = 1
): SearchRow[] {
  const rows: SearchRow[] = [];
  const sections = html.matchAll(/<section\s+data-page=["'](\d+)["'][^>]*>([\s\S]*?)<\/section>/gi);
  for (const section of sections) {
    const text = stripHtml(section[2]);
    const normalized = text.toLowerCase();
    const matchingTerms = terms.filter(term => normalized.includes(term));
    if (matchingTerms.length < minimumTermMatches) continue;
    const firstMatch = Math.min(...matchingTerms.map(term => normalized.indexOf(term)).filter(index => index >= 0));
    const start = Math.max(0, firstMatch - 500);
    const end = Math.min(text.length, firstMatch + 1700);
    rows.push({
      filing_id: document.filing_id,
      case_number: document.case_number,
      docket_number: document.docket_number,
      title: document.title,
      received_date: document.received_date,
      official_pdf_url: document.official_pdf_url,
      page_number: Number(section[1]),
      text: `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`,
      rank: -matchingTerms.length
    });
  }
  return rows.sort((left, right) => left.rank - right.rank).slice(0, 2);
}

async function searchCompactDocuments(
  env: WorkerEnv,
  caseNumber: string,
  terms: string[],
  requestId: string,
  maxDocumentReads = 20,
  minimumTermMatches = 1,
  queryYears: number[] = []
): Promise<SearchRow[]> {
  const candidateMap = new Map<number, CompactDocumentRow & { filterHits: number; filterFill: number }>();
  const addCandidate = (document: CompactDocumentRow) => {
    if (!document.r2_key || !document.term_filter) return;
    const filter = toFilterBytes(document.term_filter);
    const filterHits = terms.filter(term => termMayExist(filter, term)).length;
    if (filterHits < minimumTermMatches) return;
    const existing = candidateMap.get(document.filing_id);
    if (!existing || filterHits > existing.filterHits) {
      candidateMap.set(document.filing_id, { ...document, filterHits, filterFill: filterFillRatio(filter) });
    }
  };

  const manifestStartedAt = performance.now();
  const manifest = await loadCaseManifest(env, caseNumber);
  const manifestDocuments = manifest.documents;
  for (const document of manifestDocuments) addCandidate(document);
  logChatStage(requestId, "manifest", manifestStartedAt, {
    caseNumber,
    documents: manifestDocuments.length,
    complete: manifest.complete
  });

  if (!manifest.complete) {
    const d1StartedAt = performance.now();
    let d1Queries = 0;
    const pageSize = 750;
    for (const database of searchDatabases(env)) {
      for (let offset = 0; offset < 7500; offset += pageSize) {
        const result = await database.prepare(`
        SELECT d.filing_id, d.case_number, d.docket_number, d.title,
               d.received_date, d.official_pdf_url, d.r2_key, d.term_filter
          FROM document_cases dc
          JOIN documents d ON d.filing_id = dc.filing_id
         WHERE dc.case_number = ? AND d.term_filter IS NOT NULL
         ORDER BY d.received_date DESC
         LIMIT ? OFFSET ?`).bind(caseNumber, pageSize, offset).all<CompactDocumentRow>();
        d1Queries += 1;
        for (const document of result.results ?? []) addCandidate(document);
        if ((result.results?.length ?? 0) < pageSize) break;
      }
    }
    logChatStage(requestId, "d1-fallback", d1StartedAt, { caseNumber, queries: d1Queries });
  }
  const candidates = rankCompactCandidates(
    Array.from(candidateMap.values()),
    queryYears,
    Date.now(),
    DEFAULT_RANKING_WEIGHTS,
    terms.length
  );
  const selected = candidates.slice(0, maxDocumentReads);
  // Keep each filing's excerpts together so the evidence budget can be shared
  // across filings rather than filled by whichever document is read first.
  const excerptGroups: SearchRow[][] = [];
  const documentStartedAt = performance.now();
  let documentsRead = 0;
  for (let start = 0; start < selected.length; start += 4) {
    const batch = selected.slice(start, start + 4);
    const batchRows = await Promise.all(batch.map(async document => {
      if (!document.r2_key) return [];
      const object = await env.DOCUMENTS.get(document.r2_key);
      if (!object || object.size > 3 * 1024 * 1024) return [];
      documentsRead += 1;
      const stream = object.body.pipeThrough(new DecompressionStream("gzip"));
      const html = await new Response(stream).text();
      return findPageExcerpts(html, terms, document, minimumTermMatches);
    }));
    excerptGroups.push(...batchRows.filter(group => group.length));
    if (excerptGroups.length >= COMPACT_DOCUMENT_GROUP_TARGET) {
      // Reads run a batch at a time, so a batch can overshoot the target. Drop
      // the surplus lowest-ranked filings: keeping them would fill every slot
      // with a first excerpt and leave no room for the best-ranked filings to
      // contribute a second one.
      excerptGroups.length = COMPACT_DOCUMENT_GROUP_TARGET;
      break;
    }
  }
  const contentRows = selectDiverseDocumentResults(excerptGroups);
  logChatStage(requestId, "r2-documents", documentStartedAt, {
    caseNumber,
    candidates: candidates.length,
    selected: selected.length,
    documentsRead,
    matchedDocuments: excerptGroups.length,
    excerpts: contentRows.length
  });
  if (contentRows.length) return contentRows;

  const metadataRows = manifestDocuments
    .map(document => {
      const haystack = `${document.title} ${document.docket_number ?? ""}`.toLowerCase();
      const matchingTerms = terms.filter(term => haystack.includes(term));
      return { document, score: matchingTerms.length };
    })
    .filter(item => terms.length === 0 || item.score > 0)
    .sort((left, right) =>
      documentRankingScore(right.score, right.document.received_date, queryYears)
        - documentRankingScore(left.score, left.document.received_date, queryYears)
      || String(right.document.received_date || "").localeCompare(String(left.document.received_date || "")))
    .slice(0, 8);
  return metadataRows.map(({ document, score }) => ({
    filing_id: document.filing_id,
    case_number: document.case_number,
    docket_number: document.docket_number,
    title: document.title,
    received_date: document.received_date,
    official_pdf_url: document.official_pdf_url,
    page_number: 1,
    text: `Metadata-only public filing record. Filing title/description: ${document.title}. `
      + "The document body has not been extracted yet; do not claim that this record proves its contents.",
    rank: -score,
    evidence_kind: "metadata"
  }));
}

async function searchLegacyFts(env: WorkerEnv, caseNumber: string | null, terms: string[]): Promise<SearchRow[]> {
  const ftsQuery = terms.length ? terms.map(term => `"${term.replaceAll('"', '""')}"`).join(" OR ") : null;
  if (!ftsQuery && caseNumber) {
    const result = await env.DB.prepare(`
      SELECT c.filing_id, d.case_number, d.docket_number, d.title,
             d.received_date, d.official_pdf_url, c.page_number, c.text, 0 AS rank
        FROM documents d
        JOIN chunks c ON c.filing_id = d.filing_id
       WHERE d.case_number = ?
       GROUP BY c.filing_id
       ORDER BY d.received_date DESC
       LIMIT 8`).bind(caseNumber).all<SearchRow>();
    return result.results ?? [];
  }
  if (!ftsQuery) return [];
  const sql = `
    SELECT c.filing_id, d.case_number, d.docket_number, d.title,
           d.received_date, d.official_pdf_url, c.page_number, c.text,
           bm25(chunks_fts) AS rank
      FROM chunks_fts
      JOIN chunks c ON c.id = chunks_fts.rowid
      JOIN documents d ON d.filing_id = c.filing_id
     WHERE chunks_fts MATCH ?
       AND (? IS NULL OR d.case_number = ?)
     ORDER BY rank
     LIMIT 8`;
  const result = await env.DB.prepare(sql).bind(ftsQuery, caseNumber, caseNumber).all<SearchRow>();
  return result.results ?? [];
}

async function searchDockets(env: WorkerEnv, message: string, requestId: string): Promise<SearchRow[]> {
  const terms = buildSearchTerms(message);
  const caseNumber = extractCaseIdentifier(message);
  const queryYears = extractQueryYears(message);
  if (caseNumber) {
    try {
      const compactRows = await searchCompactDocuments(env, caseNumber, terms, requestId, 20, 1, queryYears);
      if (compactRows.length) return compactRows;
    } catch (error) {
      console.error(JSON.stringify({ message: "compact search unavailable", error: String(error), caseNumber }));
    }
  } else if (terms.length) {
    try {
      // The inverted index covers every case; the Bloom router samples one of
      // sixteen partitions. Prefer the index and keep the router as a fallback
      // until the index has been published for the whole corpus.
      const termIndexRouted = await routeCasesByTermIndex(env, terms, requestId);
      const routedCases = termIndexRouted ?? await routeCases(env, terms, requestId);
      const routing = termIndexRouted ? "exhaustive" as const : "sampled" as const;
      const routedGroups: SearchRow[][] = [];
      for (const candidate of routedCases.slice(0, CASE_ROUTER_VERIFIED_CASES)) {
        const rows = await searchCompactDocuments(
          env,
          candidate.caseNumber,
          terms,
          requestId,
          2,
          Math.min(2, terms.length),
          queryYears
        );
        // Preserve cross-case diversity for global questions instead of letting
        // the first high-volume case consume every evidence slot.
        routedGroups.push(rows.filter(row => row.evidence_kind !== "metadata"));
      }
      const routedRows = selectDiverseGlobalResults(routedGroups);
      if (routedRows.length) {
        return routedRows.map(row => ({ ...row, routing }));
      }
    } catch (error) {
      console.error(JSON.stringify({
        message: "global case routing unavailable",
        error: error instanceof Error ? error.message : String(error),
        requestId
      }));
    }
  }
  return searchLegacyFts(env, caseNumber, terms);
}

function buildTranscript(history: ChatMessage[], message: string): string {
  const prior = history.slice(-10).map(item => {
    const role = item.role === "model" ? "Assistant" : "User";
    return `${role}: ${String(item.content).slice(0, MAX_HISTORY_MESSAGE_LENGTH)}`;
  });
  return [...prior, `User: ${message}`].join("\n\n");
}

function sourceContext(rows: SearchRow[]): string {
  if (!rows.length) {
    return "No matching indexed filing excerpts were found. Do not claim that the corpus proves an answer.";
  }
  return rows.map((row, index) => row.evidence_kind === "metadata" ? [
    `Internal metadata record ${index + 1} (do not expose this number to the user)`,
    `Required citation: ${filingCitation(row)}`,
    `Case: ${row.case_number}`,
    `Filing title/description: ${row.title}`,
    `Date: ${row.received_date ?? "unknown"}`,
    `Official PDF URL: ${row.official_pdf_url}`,
    "Important: only filing metadata is indexed. Do not claim that the document body contains a fact or keyword."
  ].join("\n") : [
    `Internal evidence record ${index + 1} (do not expose this number to the user)`,
    `Required citation: ${filingCitation(row)}`,
    `Case: ${row.case_number}`,
    `Filing: ${row.title}`,
    `Date: ${row.received_date ?? "unknown"}`,
    `Page: ${row.page_number}`,
    `Official PDF page URL: ${officialPdfPageUrl(row)}`,
    `Excerpt: ${row.text.slice(0, 2200)}`
  ].join("\n")).join("\n\n");
}

function openAiEndpoint(env: WorkerEnv): string {
  if (env.CLOUDFLARE_ACCOUNT_ID) {
    const gateway = env.AI_GATEWAY_ID || "default";
    return `https://gateway.ai.cloudflare.com/v1/${env.CLOUDFLARE_ACCOUNT_ID}/${gateway}/openai/responses`;
  }
  return OPENAI_RESPONSES_URL;
}

function extractOpenAiText(response: unknown): string {
  if (!response || typeof response !== "object") return "";
  const payload = response as { output_text?: unknown; output?: unknown };
  if (typeof payload.output_text === "string") return payload.output_text.trim();
  if (!Array.isArray(payload.output)) return "";
  return payload.output.flatMap(item => {
    if (!item || typeof item !== "object" || !("content" in item) || !Array.isArray(item.content)) return [];
    return item.content.flatMap(part =>
      part && typeof part === "object" && "type" in part && part.type === "output_text"
        && "text" in part && typeof part.text === "string" ? [part.text] : []
    );
  }).join("\n").trim();
}

export function openAiRequestPayload(
  env: WorkerEnv,
  history: ChatMessage[],
  message: string,
  rows: SearchRow[],
  stream = false
): Record<string, unknown> {
  return {
    model: env.OPENAI_MODEL || "gpt-4.1",
    instructions: `You are the DC PSC Docket Assistant for people researching District of Columbia utility regulation.
Only answer questions related to the DC Public Service Commission, its proceedings, dockets, utilities, or public filings.
Ground document-content claims in the supplied indexed excerpts. Cite evidence inline using each record's exact Required citation Markdown.
Metadata-only records may establish that a filing exists, its title, date, case, and official URL, but never what its document body says.
Never show labels such as Source 1, Source 2, or Evidence 1 to the user. Content citations must identify the filing by title and PDF page; metadata citations must identify it as a filing record.
Never invent a filing, quotation, page, date, or URL. If evidence is insufficient, say so and suggest a narrower search.
Keep exact keyword matches distinct from interpretation. Always include the official e-Docket search link when useful.`,
    input: `INDEXED E-DOCKET EXCERPTS:\n${sourceContext(rows)}\n\nCONVERSATION:\n${buildTranscript(history, message)}`,
    text: { format: { type: "text" } },
    stream
  };
}

export function answerSuffix(message: string, reply: string, rows: SearchRow[]): string {
  const sources = Array.from(new Map(rows.map(row => [row.filing_id, row])).values()).slice(0, 5);
  // Cross-case routing reads one of the router's sixteen partitions, so it
  // examines a fraction of indexed cases rather than all of them. Say so
  // plainly: "relevance-ranked matches from the indexed corpus" reads as a
  // full-corpus ranking, and a reader deciding which proceedings matter would
  // be misled by it.
  // Default to the narrower claim: with no rows there is nothing to prove the
  // exhaustive path ran, and overstating coverage is the worse error.
  const exhaustive = rows.some(row => row.routing === "exhaustive");
  const scopeNote = extractCaseIdentifier(message)
    ? ""
    : exhaustive
      ? "\n\n> **Search scope:** Every indexed case was searched for your terms. Ranking favours rarer, more distinctive terms. Filings still being indexed, and filings whose text could not be extracted, are not covered."
      : "\n\n> **Search scope:** Cross-case search scans a sample of the indexed cases, not the whole corpus, and the sample shifts with how the question is worded. Relevant proceedings may be missing entirely. Treat these as leads, then confirm by asking about a specific case number or by searching the official e-Docket directly.";
  const replyReportsInsufficientEvidence = /\b(?:no|insufficient|not enough)\s+(?:matching\s+)?evidence\b|\bcould(?:n['’]t| not)\s+find\b/i.test(reply);
  if (replyReportsInsufficientEvidence || !sources.length) return scopeNote;
  return `${scopeNote}\n\n---\n**Official filing sources**\n${sources.map(row =>
    row.evidence_kind === "metadata"
      ? `- [${row.case_number}: ${row.title}](${row.official_pdf_url}) — metadata indexed; full text pending`
      : `- [${row.case_number}: ${row.title} — page ${row.page_number}](${officialPdfPageUrl(row)})`
  ).join("\n")}`;
}

function formatOpenAiReply(message: string, rawReply: string, rows: SearchRow[]): string {
  const reply = replaceOpaqueSourceLabels(rawReply, rows);
  return `${reply}${answerSuffix(message, reply, rows)}`;
}

function encodeAssistantEvent(event: "delta" | "done" | "error", data: unknown): Uint8Array {
  return new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function staticAssistantStream(reply: string, requestId: string): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encodeAssistantEvent("delta", { delta: reply }));
      controller.enqueue(encodeAssistantEvent("done", { requestId }));
      controller.close();
    }
  });
  return new Response(stream, {
    headers: {
      ...API_HEADERS,
      "Content-Type": "text/event-stream; charset=utf-8"
    }
  });
}

export function openAiStreamDelta(frame: string): string | null {
  const dataText = frame.split(/\r?\n/)
    .filter(line => line.startsWith("data:"))
    .map(line => line.slice(5).trimStart())
    .join("\n");
  if (!dataText || dataText === "[DONE]") return null;
  const payload: unknown = JSON.parse(dataText);
  if (!isRecord(payload)) return null;
  if (payload.type === "error") {
    const message = isRecord(payload.error) && typeof payload.error.message === "string"
      ? payload.error.message
      : "OpenAI streaming error";
    throw new Error(message);
  }
  return payload.type === "response.output_text.delta" && typeof payload.delta === "string"
    ? payload.delta
    : null;
}

async function streamAnswerWithOpenAi(
  env: WorkerEnv,
  history: ChatMessage[],
  message: string,
  rows: SearchRow[],
  requestId: string,
  requestSignal: AbortSignal
): Promise<Response> {
  if (!env.OPENAI_API_KEY) {
    return staticAssistantStream(buildDirectExcerptReply(rows, "disabled"), requestId);
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${env.OPENAI_API_KEY}`,
    "Content-Type": "application/json"
  };
  if (env.CF_AIG_TOKEN) headers["cf-aig-authorization"] = `Bearer ${env.CF_AIG_TOKEN}`;
  const modelStartedAt = performance.now();

  try {
    const responseStartController = new AbortController();
    const responseStartTimeout = setTimeout(
      () => responseStartController.abort("OpenAI response start timed out"),
      OPENAI_RESPONSE_START_TIMEOUT_MS
    );
    let response: Response;
    try {
      response = await fetch(openAiEndpoint(env), {
        method: "POST",
        headers,
        signal: AbortSignal.any([requestSignal, responseStartController.signal]),
        body: JSON.stringify(openAiRequestPayload(env, history, message, rows, true))
      });
    } finally {
      // Once response headers arrive, let the model finish streaming. The
      // inbound request signal still cancels generation when the user stops.
      clearTimeout(responseStartTimeout);
    }
    if (!response.ok || !response.body) {
      throw new Error(`OpenAI Responses API returned ${response.status}`);
    }

    const reader = response.body.getReader();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const decoder = new TextDecoder();
        let buffer = "";
        let rawReply = "";
        try {
          while (true) {
            const { done, value } = await reader.read();
            buffer += decoder.decode(value, { stream: !done });
            const frames = buffer.split(/\r?\n\r?\n/);
            buffer = frames.pop() ?? "";
            for (const frame of frames) {
              const delta = openAiStreamDelta(frame);
              if (!delta) continue;
              rawReply += delta;
              controller.enqueue(encodeAssistantEvent("delta", { delta }));
            }
            if (done) break;
          }
          if (buffer.trim()) {
            const delta = openAiStreamDelta(buffer);
            if (delta) {
              rawReply += delta;
              controller.enqueue(encodeAssistantEvent("delta", { delta }));
            }
          }
          if (!rawReply.trim()) throw new Error("OpenAI returned no text");
          const suffix = answerSuffix(message, rawReply, rows);
          if (suffix) controller.enqueue(encodeAssistantEvent("delta", { delta: suffix }));
          controller.enqueue(encodeAssistantEvent("done", { requestId }));
          logChatStage(requestId, "ai-summary", modelStartedAt, { outcome: "streamed" });
        } catch (error) {
          if (!requestSignal.aborted) {
            console.error(JSON.stringify({
              message: "AI response stream interrupted",
              requestId,
              durationMs: elapsedMs(modelStartedAt),
              error: error instanceof Error ? error.message : String(error)
            }));
            controller.enqueue(encodeAssistantEvent("error", {
              userMessage: "The assistant response was interrupted. Please retry the request."
            }));
          }
        } finally {
          reader.releaseLock();
          try {
            controller.close();
          } catch {
            // The client may have already cancelled the response stream.
          }
        }
      }
    });
    return new Response(stream, {
      headers: {
        ...API_HEADERS,
        "Content-Type": "text/event-stream; charset=utf-8"
      }
    });
  } catch (error) {
    console.error(JSON.stringify({
      message: "AI stream unavailable; returning direct excerpts",
      requestId,
      durationMs: elapsedMs(modelStartedAt),
      error: error instanceof Error ? error.message : String(error)
    }));
    return staticAssistantStream(buildDirectExcerptReply(rows, "unavailable"), requestId);
  }
}

function buildDirectExcerptReply(rows: SearchRow[], reason: "disabled" | "unavailable"): string {
  if (!rows.length) {
    return `No matching excerpt was found in the indexed filings. Try a more specific keyword or case number, or use the [official e-Docket search](${EDOCKET_SEARCH_URL}).`;
  }
  const introduction = reason === "disabled"
    ? `I found ${rows.length} matching excerpt(s) in the indexed filings. AI synthesis is disabled, so these results are shown directly without any model/API charge.`
    : `I found ${rows.length} matching excerpt(s). The AI summary service took too long or was temporarily unavailable, so verified filing excerpts are shown directly instead.`;
  return [
      introduction,
      ...rows.map((row, index) => row.evidence_kind === "metadata" ? [
        `**${index + 1}. ${row.case_number}: ${row.title}**`,
        "This filing is covered by metadata; full-text extraction is still pending.",
        `[Open the official PDF](${row.official_pdf_url})`
      ].join("\n\n") : [
          `**${index + 1}. ${row.case_number}: ${row.title} — page ${row.page_number}**`,
          row.text.slice(0, 700),
          `[Open the official PDF at page ${row.page_number}](${officialPdfPageUrl(row)})`
        ].join("\n\n")),
      `[Search the complete official e-Docket](${EDOCKET_SEARCH_URL})`
    ].join("\n\n---\n\n");
}

async function answerWithOpenAi(
  env: WorkerEnv,
  history: ChatMessage[],
  message: string,
  rows: SearchRow[],
  requestId: string
): Promise<string> {
  if (!env.OPENAI_API_KEY) {
    return buildDirectExcerptReply(rows, "disabled");
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${env.OPENAI_API_KEY}`,
    "Content-Type": "application/json"
  };
  if (env.CF_AIG_TOKEN) headers["cf-aig-authorization"] = `Bearer ${env.CF_AIG_TOKEN}`;
  const modelStartedAt = performance.now();
  try {
    const response = await fetch(openAiEndpoint(env), {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(OPENAI_NON_STREAM_TIMEOUT_MS),
      body: JSON.stringify(openAiRequestPayload(env, history, message, rows))
    });
    if (!response.ok) throw new Error(`OpenAI Responses API returned ${response.status}`);
    const rawReply = extractOpenAiText(await response.json());
    if (!rawReply) throw new Error("OpenAI returned no text");
    logChatStage(requestId, "ai-summary", modelStartedAt, { outcome: "success" });
    return formatOpenAiReply(message, rawReply, rows);
  } catch (error) {
    console.error(JSON.stringify({
      message: "AI summary unavailable; returning direct excerpts",
      requestId,
      durationMs: elapsedMs(modelStartedAt),
      error: error instanceof Error ? error.message : String(error)
    }));
    return buildDirectExcerptReply(rows, "unavailable");
  }
}

async function handleApi(request: Request, env: WorkerEnv, context: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/api/config" && request.method === "GET") {
    return json({
      turnstileRequired: Boolean(env.TURNSTILE_SECRET),
      turnstileSiteKey: env.TURNSTILE_SECRET ? env.TURNSTILE_SITE_KEY ?? null : null,
      maxMessageLength: MAX_MESSAGE_LENGTH
    });
  }

  if (url.pathname === "/api/health" && request.method === "GET") {
    const [
      shardCounts,
      legacyMetadataPayload,
      metadataCoveragePayloads,
      ingestionShards,
      caseRouterPayload,
      termIndexPayload
    ] = await Promise.all([
      Promise.all(searchDatabases(env).map(database => database.prepare(
      `SELECT COUNT(*) AS documents,
              COUNT(term_filter) AS compactDocuments,
              (SELECT COUNT(DISTINCT case_number) FROM document_cases) AS cases
         FROM documents`
      ).first<{ documents: number; compactDocuments: number; cases: number }>().catch(() => null))),
      readR2JsonWithRetry(env.DOCUMENTS, "ingestion/metadata-coverage-v2.json"),
      Promise.all(Array.from({ length: 4 }, (_, shardIndex) =>
        readR2JsonWithRetry(
          env.DOCUMENTS,
          `ingestion/metadata-coverage-v3-${shardIndex}-of-4.json`
        )
      )),
      Promise.all(Array.from({ length: 4 }, (_, shardIndex) =>
        readR2JsonWithRetry(
          env.DOCUMENTS,
          `ingestion/fast-r2-state-v3-${shardIndex}-of-4.json`
        ).then(async payload => {
          if (isRecord(payload)) return payload;
          const fallback = await readR2JsonWithRetry(
            env.DOCUMENTS,
            `ingestion/fast-r2-state-v2-${shardIndex}-of-4.json`
          );
          return isRecord(fallback) ? fallback : null;
        })
      )),
      readR2JsonWithRetry(env.DOCUMENTS, CASE_ROUTER_INDEX_KEY),
      readR2JsonWithRetry(env.DOCUMENTS, TERM_INDEX_KEY)
    ]);
    const counts = shardCounts.reduce((total, shard) => ({
      documents: total.documents + (shard?.documents ?? 0),
      compactDocuments: total.compactDocuments + (shard?.compactDocuments ?? 0),
      cases: total.cases + (shard?.cases ?? 0)
    }), { documents: 0, compactDocuments: 0, cases: 0 });
    const metadataCoverageShards = metadataCoveragePayloads.map(payload =>
      isRecord(payload) ? payload : null
    );
    const legacyMetadataCoverage = isRecord(legacyMetadataPayload)
      ? legacyMetadataPayload
      : null;
    const availableMetadataShards = metadataCoverageShards.filter(
      (item): item is Record<string, unknown> => item !== null
    );
    const updatedAt = availableMetadataShards
      .map(item => typeof item.updatedAt === "string" ? item.updatedAt : "")
      .filter(Boolean)
      .sort()
      .at(-1) ?? null;
    const metadataCoverage = availableMetadataShards.length
      ? {
          version: 3,
          shardCount: 4,
          officialRecords: Math.max(
            0,
            ...availableMetadataShards.map(item => numericStateValue(item.officialRecords))
          ),
          officialRecordsScanned: availableMetadataShards.reduce(
            (total, item) => total + numericStateValue(item.officialRecordsScanned),
            0
          ),
          publicPdfRecords: availableMetadataShards.reduce(
            (total, item) => total + numericStateValue(item.publicPdfRecords),
            0
          ),
          fullScanComplete: metadataCoverageShards.every(
            item => item?.fullScanComplete === true
          ),
          updatedAt,
          shards: metadataCoverageShards
        }
      : legacyMetadataCoverage;
    const publicPdfRecords = metadataCoverage && "publicPdfRecords" in metadataCoverage
      ? numericStateValue(metadataCoverage.publicPdfRecords)
      : 0;
    const caseRouter = isCaseRouterIndex(caseRouterPayload)
      ? {
          status: "ready",
          version: caseRouterPayload.version,
          updatedAt: caseRouterPayload.updatedAt,
          complete: caseRouterPayload.complete,
          shardCount: caseRouterPayload.shardCount,
          filterBands: caseRouterPayload.filterBands,
          manifestObjects: caseRouterPayload.manifestObjects,
          cases: caseRouterPayload.cases,
          contentCases: caseRouterPayload.contentCases,
          documentAssociations: caseRouterPayload.documentAssociations,
          contentDocumentAssociations: caseRouterPayload.contentDocumentAssociations,
          compressedBytes: caseRouterPayload.compressedBytes
        }
      : { status: "missing" };
    // The inverted index is being rolled out. While it is absent the Worker
    // falls back to the Bloom router, so report its state without degrading
    // health; once published, staleness is worth flagging.
    const termIndexReady = isTermIndexManifest(termIndexPayload);
    const termIndex = termIndexReady
      ? {
          status: isFreshTimestamp(termIndexPayload.updatedAt) ? "ready" : "stale",
          version: termIndexPayload.version,
          updatedAt: termIndexPayload.updatedAt,
          shardCount: termIndexPayload.shardCount,
          cases: termIndexPayload.cases,
          terms: termIndexPayload.terms,
          postings: termIndexPayload.postings,
          compressedBytes: termIndexPayload.compressedBytes,
          coverage: "all-cases"
        }
      : { status: "not-published", coverage: "case-router-sample" };
    const metadataStateAvailable = metadataCoverageShards.every(item => item !== null);
    const ingestionStateAvailable = ingestionShards.every(item => item !== null);
    const routerReady = isCaseRouterIndex(caseRouterPayload);
    const metadataFresh = isFreshTimestamp(metadataCoverage && "updatedAt" in metadataCoverage
      ? metadataCoverage.updatedAt
      : null);
    const routerFresh = routerReady && isFreshTimestamp(caseRouterPayload.updatedAt);
    const turnstileConfigurationValid = Boolean(env.TURNSTILE_SECRET) === Boolean(env.TURNSTILE_SITE_KEY);
    const issues = [
      !metadataStateAvailable ? "metadata-shard-unavailable" : null,
      !ingestionStateAvailable ? "ingestion-shard-unavailable" : null,
      !routerReady ? "case-router-unavailable" : null,
      !metadataFresh ? "metadata-stale" : null,
      !routerFresh ? "case-router-stale" : null,
      termIndexReady && termIndex.status === "stale" ? "term-index-stale" : null,
      !turnstileConfigurationValid ? "turnstile-misconfigured" : null,
      !env.TURNSTILE_SECRET ? "turnstile-disabled" : null
    ].filter((issue): issue is string => issue !== null);
    const status = issues.length ? "degraded" : "ok";
    const healthPayload = {
      status,
      issues,
      cloudRag: { ...counts, source: "legacy-d1" },
      fullTextCoverage: fullTextCoverageSummary(
        ingestionShards,
        publicPdfRecords,
        metadataStateAvailable && ingestionStateAvailable
      ),
      shards: shardCounts,
      metadataCoverage,
      ingestionShards,
      caseRouter,
      termIndex,
      security: {
        rateLimiting: "enabled",
        turnstile: env.TURNSTILE_SECRET ? "enabled" : "disabled"
      }
    };
    if (status === "ok") {
      context.waitUntil(cacheHealthySnapshot(request, healthPayload));
      return json(healthPayload);
    }
    const cachedHealth = await lastKnownGoodHealth(request);
    if (cachedHealth) {
      return json({
        ...cachedHealth,
        healthSource: "last-known-good",
        liveIssues: issues
      }, 200, {
        "X-Health-Source": "last-known-good",
        "X-Health-Live-Issues": issues.join(",")
      });
    }
    return json(healthPayload, 503);
  }

  if (url.pathname === "/api/news" && request.method === "GET") {
    try {
      const response = await fetch(NEWS_URL, { headers: { "User-Agent": "PSC-Docket-Assistant/1.0" } });
      if (!response.ok) throw new Error(`DCPSC returned ${response.status}`);
      const items = parseNews(await response.text());
      if (!items.length) throw new Error("No news items parsed");
      return json(items);
    } catch {
      return json([{ title: "Current PSC News", date: "Latest updates", summary: "Visit the official DC PSC newsroom for current notices and meetings.", url: NEWS_URL, source: "DCPSC" }]);
    }
  }

  if (url.pathname === "/api/verify-link" && request.method === "GET") {
    const candidate = url.searchParams.get("url") ?? "";
    if (!isOfficialPscUrl(candidate)) return json({ valid: false, reason: "Only official DC PSC links are accepted" });
    // The official attachment endpoint only implements GET and returns 405 for
    // HEAD, even when the PDF exists. These URLs originate from the official
    // filing API and are validated structurally to avoid downloading a large
    // PDF merely to verify its link.
    if (isOfficialEdocketAttachmentUrl(candidate)) return json({ valid: true, status: 200 });
    try {
      const response = await fetch(candidate, { method: "HEAD", redirect: "follow" });
      const fallbackUrl = new URL(candidate).hostname.toLowerCase() === "edocket.dcpsc.org"
        ? EDOCKET_SEARCH_URL
        : NEWSROOM_URL;
      return json({ valid: response.ok, status: response.status, fallbackUrl: response.ok ? undefined : fallbackUrl });
    } catch {
      return json({ valid: false, fallbackUrl: NEWSROOM_URL });
    }
  }

  if (url.pathname === "/api/chat" && request.method === "POST") {
    const requestId = crypto.randomUUID();
    const requestStartedAt = performance.now();
    const wantsEventStream = (request.headers.get("Accept") ?? "").includes("text/event-stream");
    if (!(request.headers.get("Content-Type") ?? "").toLowerCase().startsWith("application/json")) {
      return json({ error: "Content-Type must be application/json" }, 415);
    }
    let rawBody: unknown;
    try {
      rawBody = await readLimitedJson(request);
    } catch (error) {
      if (error instanceof Error && error.message === "request-too-large") {
        return json({ error: "Request body is too large" }, 413);
      }
      throw error;
    }
    const body = parseChatRequestBody(rawBody);
    if (!body) {
      return json({
        error: `Message is required and must be at most ${MAX_MESSAGE_LENGTH} characters; history must contain at most ${MAX_HISTORY_MESSAGES} valid messages.`
      }, 400);
    }
    const [actorLimit, globalLimit] = await Promise.all([
      env.CHAT_RATE_LIMITER.limit({ key: rateLimitActor(request, body.clientId) }),
      env.CHAT_GLOBAL_RATE_LIMITER.limit({ key: "chat" })
    ]);
    if (!actorLimit.success || !globalLimit.success) {
      return json({
        error: "Rate limit exceeded",
        userMessage: "The assistant is receiving too many requests. Please wait one minute and try again."
      }, 429, { "Retry-After": "60" });
    }
    if (!(await verifyTurnstile(request, env, body.turnstileToken, requestId))) {
      return json({
        error: "Turnstile verification failed",
        userMessage: "Security verification expired or failed. Please retry the challenge and submit again."
      }, 403);
    }
    const message = body.message;
    try {
      if (isCredentialOrPromptExtractionRequest(message)) {
        const reply = "I can’t reveal private instructions, credentials, or secrets. I can help research DC PSC dockets and public filings instead.";
        return wantsEventStream ? staticAssistantStream(reply, requestId) : json({ reply });
      }
      const directCaseReply = await buildDetailedCaseNumberReply(message);
      if (directCaseReply) {
        logChatStage(requestId, "chat-request", requestStartedAt, { outcome: "direct-case" });
        return wantsEventStream
          ? staticAssistantStream(directCaseReply, requestId)
          : json({ reply: directCaseReply, requestId });
      }
      const rows = await searchDockets(env, message, requestId);
      if (wantsEventStream) {
        logChatStage(requestId, "chat-request", requestStartedAt, { outcome: "stream-start", rows: rows.length });
        return streamAnswerWithOpenAi(env, body.history, message, rows, requestId, request.signal);
      }
      const reply = await answerWithOpenAi(env, body.history, message, rows, requestId);
      logChatStage(requestId, "chat-request", requestStartedAt, { outcome: "success", rows: rows.length });
      return json({ reply, requestId });
    } catch (error) {
      console.error(JSON.stringify({
        message: "chat failed",
        requestId,
        durationMs: elapsedMs(requestStartedAt),
        error: error instanceof Error ? error.message : String(error)
      }));
      const reply = `⚠️ The assistant could not complete this search right now. Please try again, or use the [official e-Docket search](${EDOCKET_SEARCH_URL}).`;
      return wantsEventStream
        ? staticAssistantStream(reply, requestId)
        : json({ reply, requestId });
    }
  }

  return json({ error: "Not found" }, 404);
}

export default {
  async fetch(request: Request, env: WorkerEnv, context: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return handleApi(request, env, context);
    return env.ASSETS.fetch(request);
  }
} satisfies ExportedHandler<WorkerEnv>;
