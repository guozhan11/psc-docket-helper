import { termMayExist, tokenizeForFilter } from "../shared/compactSearch.ts";

type WorkerEnv = Env & {
  OPENAI_API_KEY?: string;
  CF_AIG_TOKEN?: string;
};

interface ChatMessage {
  role: "user" | "model";
  content: string;
}

interface SearchRow {
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
}

interface CompactDocumentRow {
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
const OPENAI_TIMEOUT_MS = 15_000;
const CASE_ROUTER_VERSION = 2;
const CASE_ROUTER_INDEX_KEY = `case-router/v${CASE_ROUTER_VERSION}/index.json`;
const CASE_ROUTER_CANDIDATES = 8;
const CASE_ROUTER_VERIFIED_CASES = 4;
const CORS_HEADERS = {
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
};

function searchDatabases(env: WorkerEnv): D1Database[] {
  return [env.DB, env.DB_1, env.DB_2];
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: CORS_HEADERS });
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

function fullTextCoverageSummary(
  ingestionShards: Array<Record<string, unknown> | null>,
  publicPdfRecords: number
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
  const searchablePercent = publicPdfRecords > 0
    ? Math.min(100, Number((indexedDocuments * 100 / publicPdfRecords).toFixed(2)))
    : 0;
  const accountedPercent = publicPdfRecords > 0
    ? Math.min(100, Number(((indexedDocuments + unavailableDocuments) * 100 / publicPdfRecords).toFixed(2)))
    : 0;
  return {
    source: "r2-ingestion-state",
    indexedDocuments,
    publicPdfRecords,
    retryPendingDocuments,
    unavailableDocuments,
    searchablePercent,
    accountedPercent,
    complete: publicPdfRecords > 0
      && retryPendingDocuments === 0
      && indexedDocuments + unavailableDocuments >= publicPdfRecords
  };
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
  "docket", "dockets", "filing", "filings", "find", "for", "from", "have", "into", "mention",
  "mentions", "please", "psc", "that", "the",
  "their", "this", "was", "were", "what", "when", "where", "which", "with", "would",
  "in", "is", "it", "of", "or", "to"
]);

function buildSearchTerms(message: string): string[] {
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
  for (const key of index.partKeys) {
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
    outcome: partsRead === index.shardCount ? "success" : "partial",
    partsRead,
    expectedParts: index.shardCount,
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

function findPageExcerpts(
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
  minimumTermMatches = 1
): Promise<SearchRow[]> {
  const candidateMap = new Map<number, CompactDocumentRow & { filterHits: number }>();
  const addCandidate = (document: CompactDocumentRow) => {
    if (!document.r2_key || !document.term_filter) return;
    const filter = toFilterBytes(document.term_filter);
    const filterHits = terms.filter(term => termMayExist(filter, term)).length;
    if (filterHits < minimumTermMatches) return;
    const existing = candidateMap.get(document.filing_id);
    if (!existing || filterHits > existing.filterHits) {
      candidateMap.set(document.filing_id, { ...document, filterHits });
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
  const candidates = Array.from(candidateMap.values());
  candidates.sort((left, right) => right.filterHits - left.filterHits
    || String(right.received_date || "").localeCompare(String(left.received_date || "")));

  const selected = candidates.slice(0, maxDocumentReads);
  const rows: SearchRow[] = [];
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
    rows.push(...batchRows.flat());
    if (rows.length >= 8) break;
  }
  logChatStage(requestId, "r2-documents", documentStartedAt, {
    caseNumber,
    candidates: candidates.length,
    selected: selected.length,
    documentsRead,
    excerpts: rows.length
  });
  const contentRows = rows.sort((left, right) => left.rank - right.rank).slice(0, 8);
  if (contentRows.length) return contentRows;

  const metadataRows = manifestDocuments
    .map(document => {
      const haystack = `${document.title} ${document.docket_number ?? ""}`.toLowerCase();
      const matchingTerms = terms.filter(term => haystack.includes(term));
      return { document, score: matchingTerms.length };
    })
    .filter(item => terms.length === 0 || item.score > 0)
    .sort((left, right) => right.score - left.score
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
  if (caseNumber) {
    try {
      const compactRows = await searchCompactDocuments(env, caseNumber, terms, requestId);
      if (compactRows.length) return compactRows;
    } catch (error) {
      console.error(JSON.stringify({ message: "compact search unavailable", error: String(error), caseNumber }));
    }
  } else if (terms.length) {
    try {
      const routedCases = await routeCases(env, terms, requestId);
      const routedRows: SearchRow[] = [];
      for (const candidate of routedCases.slice(0, CASE_ROUTER_VERIFIED_CASES)) {
        const rows = await searchCompactDocuments(
          env,
          candidate.caseNumber,
          terms,
          requestId,
          4,
          Math.min(2, terms.length)
        );
        routedRows.push(...rows.filter(row => row.evidence_kind !== "metadata"));
        if (routedRows.length >= 8) break;
      }
      if (routedRows.length) {
        const unique = new Map<string, SearchRow>();
        for (const row of routedRows.sort((left, right) => left.rank - right.rank)) {
          unique.set(`${row.filing_id}:${row.page_number}`, row);
        }
        return Array.from(unique.values()).slice(0, 8);
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
  const prior = history.slice(-8).map(item => {
    const role = item.role === "model" ? "Assistant" : "User";
    return `${role}: ${String(item.content).slice(0, 3000)}`;
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
      signal: AbortSignal.timeout(OPENAI_TIMEOUT_MS),
      body: JSON.stringify({
      model: env.OPENAI_MODEL || "gpt-4.1",
      instructions: `You are the DC PSC Docket Assistant for people researching District of Columbia utility regulation.
Only answer questions related to the DC Public Service Commission, its proceedings, dockets, utilities, or public filings.
Ground document-content claims in the supplied indexed excerpts. Cite evidence inline using each record's exact Required citation Markdown.
Metadata-only records may establish that a filing exists, its title, date, case, and official URL, but never what its document body says.
Never show labels such as Source 1, Source 2, or Evidence 1 to the user. Content citations must identify the filing by title and PDF page; metadata citations must identify it as a filing record.
Never invent a filing, quotation, page, date, or URL. If evidence is insufficient, say so and suggest a narrower search.
Keep exact keyword matches distinct from interpretation. Always include the official e-Docket search link when useful.`,
      input: `INDEXED E-DOCKET EXCERPTS:\n${sourceContext(rows)}\n\nCONVERSATION:\n${buildTranscript(history, message)}`,
      text: { format: { type: "text" } }
      })
    });
    if (!response.ok) throw new Error(`OpenAI Responses API returned ${response.status}`);
    const rawReply = extractOpenAiText(await response.json());
    if (!rawReply) throw new Error("OpenAI returned no text");
    logChatStage(requestId, "ai-summary", modelStartedAt, { outcome: "success" });
    const reply = replaceOpaqueSourceLabels(rawReply, rows);
    const sources = Array.from(new Map(rows.map(row => [row.filing_id, row])).values()).slice(0, 5);
    if (!sources.length) return reply;
    return `${reply}\n\n---\n**Official filing sources**\n${sources.map(row =>
      row.evidence_kind === "metadata"
        ? `- [${row.case_number}: ${row.title}](${row.official_pdf_url}) — metadata indexed; full text pending`
        : `- [${row.case_number}: ${row.title} — page ${row.page_number}](${officialPdfPageUrl(row)})`
    ).join("\n")}`;
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

async function handleApi(request: Request, env: WorkerEnv): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

  if (url.pathname === "/api/health" && request.method === "GET") {
    const [
      shardCounts,
      legacyMetadataObject,
      metadataObjects,
      ingestionV3Objects,
      ingestionV2Objects,
      caseRouterObject
    ] = await Promise.all([
      Promise.all(searchDatabases(env).map(database => database.prepare(
      `SELECT COUNT(*) AS documents,
              COUNT(term_filter) AS compactDocuments,
              (SELECT COUNT(DISTINCT case_number) FROM document_cases) AS cases
         FROM documents`
      ).first<{ documents: number; compactDocuments: number; cases: number }>().catch(() => null))),
      env.DOCUMENTS.get("ingestion/metadata-coverage-v2.json"),
      Promise.all(Array.from({ length: 4 }, (_, shardIndex) =>
        env.DOCUMENTS.get(`ingestion/metadata-coverage-v3-${shardIndex}-of-4.json`)
      )),
      Promise.all(Array.from({ length: 4 }, (_, shardIndex) =>
        env.DOCUMENTS.get(`ingestion/fast-r2-state-v3-${shardIndex}-of-4.json`)
      )),
      Promise.all(Array.from({ length: 4 }, (_, shardIndex) =>
        env.DOCUMENTS.get(`ingestion/fast-r2-state-v2-${shardIndex}-of-4.json`)
      )),
      env.DOCUMENTS.get(CASE_ROUTER_INDEX_KEY)
    ]);
    const counts = shardCounts.reduce((total, shard) => ({
      documents: total.documents + (shard?.documents ?? 0),
      compactDocuments: total.compactDocuments + (shard?.compactDocuments ?? 0),
      cases: total.cases + (shard?.cases ?? 0)
    }), { documents: 0, compactDocuments: 0, cases: 0 });
    const metadataCoveragePayloads = await Promise.all(metadataObjects.map((object, shardIndex) =>
      readR2Json(object, `ingestion/metadata-coverage-v3-${shardIndex}-of-4.json`)
    ));
    const metadataCoverageShards = metadataCoveragePayloads.map(payload =>
      isRecord(payload) ? payload : null
    );
    const legacyMetadataPayload = await readR2Json(
      legacyMetadataObject,
      "ingestion/metadata-coverage-v2.json"
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
    const ingestionShards = await Promise.all(ingestionV3Objects.map(
      async (object, shardIndex) => {
        const selected = object ?? ingestionV2Objects[shardIndex];
        const version = object ? 3 : 2;
        const payload = await readR2Json(
          selected,
          `ingestion/fast-r2-state-v${version}-${shardIndex}-of-4.json`
        );
        return isRecord(payload) ? payload : null;
      }
    ));
    const publicPdfRecords = metadataCoverage && "publicPdfRecords" in metadataCoverage
      ? numericStateValue(metadataCoverage.publicPdfRecords)
      : 0;
    const caseRouterPayload = await readR2Json(caseRouterObject, CASE_ROUTER_INDEX_KEY);
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
    return json({
      status: "ok",
      cloudRag: { ...counts, source: "legacy-d1" },
      fullTextCoverage: fullTextCoverageSummary(ingestionShards, publicPdfRecords),
      shards: shardCounts,
      metadataCoverage,
      ingestionShards,
      caseRouter
    });
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
    const body = await request.json<{ history?: ChatMessage[]; message?: string }>().catch(() => null);
    const message = body?.message?.trim();
    if (!message) return json({ error: "Missing message body" }, 400);
    try {
      const directCaseReply = await buildDetailedCaseNumberReply(message);
      if (directCaseReply) {
        logChatStage(requestId, "chat-request", requestStartedAt, { outcome: "direct-case" });
        return json({ reply: directCaseReply, requestId });
      }
      const rows = await searchDockets(env, message, requestId);
      const reply = await answerWithOpenAi(env, body?.history ?? [], message, rows, requestId);
      logChatStage(requestId, "chat-request", requestStartedAt, { outcome: "success", rows: rows.length });
      return json({ reply, requestId });
    } catch (error) {
      console.error(JSON.stringify({
        message: "chat failed",
        requestId,
        durationMs: elapsedMs(requestStartedAt),
        error: error instanceof Error ? error.message : String(error)
      }));
      return json({
        reply: `⚠️ The assistant could not complete this search right now. Please try again, or use the [official e-Docket search](${EDOCKET_SEARCH_URL}).`,
        requestId
      });
    }
  }

  return json({ error: "Not found" }, 404);
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return handleApi(request, env);
    return env.ASSETS.fetch(request);
  }
} satisfies ExportedHandler<WorkerEnv>;
