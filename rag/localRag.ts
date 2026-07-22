import fs from "node:fs";
import path from "node:path";
import MiniSearch from "minisearch";

export type RagChunk = {
  id: string;
  caseNumber: string;
  docketNumber: string;
  filingId: number;
  filename: string;
  filingType: string;
  filer: string;
  receivedDate: string;
  detailUrl: string;
  pdfUrl: string;
  page: number;
  text: string;
};

type StoredIndex = {
  version: 1;
  builtAt: string;
  caseNumbers: string[];
  documentCount: number;
  chunkCount: number;
  searchIndex: unknown;
};

export type RagSearchResult = RagChunk & {
  score: number;
  matchedTerms: string[];
  exactPhraseMatch: boolean;
};

const SEARCH_OPTIONS = {
  fields: ["text", "filename", "filingType", "filer", "docketNumber", "caseNumber"],
  storeFields: [
    "caseNumber", "docketNumber", "filingId", "filename", "filingType", "filer",
    "receivedDate", "detailUrl", "pdfUrl", "page", "text"
  ],
  searchOptions: {
    boost: { docketNumber: 4, caseNumber: 4, filename: 2.5, filingType: 1.7, filer: 1.4, text: 1 },
    prefix: true,
    fuzzy: 0.12
  }
} as const;

let loadedPath = "";
let loadedMtimeMs = 0;
let loadedIndex: MiniSearch | null = null;
let loadedMetadata: Omit<StoredIndex, "searchIndex"> | null = null;

export function getRagIndexPath(): string {
  if (process.env.RAG_INDEX_PATH) return path.resolve(process.env.RAG_INDEX_PATH);
  const dataDirectory = process.env.RAG_DATA_DIR
    ? path.resolve(process.env.RAG_DATA_DIR)
    : path.join(process.cwd(), ".rag-data");
  return path.join(dataDirectory, "index.json");
}

function loadIndex(): MiniSearch | null {
  const indexPath = getRagIndexPath();
  if (!fs.existsSync(indexPath)) return null;
  const mtimeMs = fs.statSync(indexPath).mtimeMs;
  if (loadedIndex && loadedPath === indexPath && loadedMtimeMs === mtimeMs) return loadedIndex;

  try {
    const stored = JSON.parse(fs.readFileSync(indexPath, "utf8")) as StoredIndex;
    if (stored.version !== 1 || !stored.searchIndex) throw new Error("Unsupported local RAG index format");
    loadedIndex = MiniSearch.loadJSON(JSON.stringify(stored.searchIndex), SEARCH_OPTIONS as any);
    loadedPath = indexPath;
    loadedMtimeMs = mtimeMs;
    loadedMetadata = {
      version: stored.version,
      builtAt: stored.builtAt,
      caseNumbers: stored.caseNumbers,
      documentCount: stored.documentCount,
      chunkCount: stored.chunkCount
    };
    console.log(`[Local RAG] Loaded ${stored.chunkCount} chunks from ${stored.documentCount} filings.`);
    return loadedIndex;
  } catch (error: any) {
    console.error(`[Local RAG] Unable to load ${indexPath}:`, error?.message || error);
    return loadedPath === indexPath ? loadedIndex : null;
  }
}

export function getLocalRagStatus() {
  return { available: Boolean(loadIndex()), indexPath: getRagIndexPath(), ...(loadedMetadata || {}) };
}

function normalizeForPhraseMatch(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

const QUERY_STOP_WORDS = new Set([
  "a", "about", "all", "an", "and", "are", "can", "case", "could", "document", "documents",
  "find", "for", "formal", "from", "in", "inside", "is", "it", "mention", "mentions", "of", "on",
  "or", "please", "search", "show", "specific", "that", "the", "this", "to", "what", "which", "with",
  "within", "would", "you"
]);

function buildSearchQuery(query: string): string {
  const withoutCaseReferences = query.replace(/\b(?:FC\s*|formal\s+case\s*)\d{3,5}\b/gi, " ");
  const usefulTerms = normalizeForPhraseMatch(withoutCaseReferences).split(" ")
    .filter(term => term.length >= 2 && !QUERY_STOP_WORDS.has(term));
  return usefulTerms.join(" ") || query;
}

export function searchLocalRag(query: string, limit = 6): RagSearchResult[] {
  const index = loadIndex();
  const trimmedQuery = query.trim();
  if (!index || !trimmedQuery) return [];

  const searchQuery = buildSearchQuery(trimmedQuery);
  const normalizedQuery = normalizeForPhraseMatch(searchQuery);
  const caseNumbers = Array.from(trimmedQuery.matchAll(/\b(?:FC\s*)?(\d{3,5})\b/gi)).map(match => match[1]);
  const rawResults = index.search(searchQuery, {
    ...(SEARCH_OPTIONS.searchOptions as any),
    combineWith: "OR",
    filter: caseNumbers.length > 0
      ? (result: any) => caseNumbers.some(caseNumber => String(result.caseNumber).includes(caseNumber))
      : undefined
  }).slice(0, Math.max(limit * 5, 25));

  return rawResults.map((result: any) => {
    const haystack = normalizeForPhraseMatch(`${result.filename} ${result.text}`);
    const exactPhraseMatch = normalizedQuery.length >= 5 && haystack.includes(normalizedQuery);
    const exactPhraseBoost = exactPhraseMatch ? 8 : 0;
    const caseBoost = caseNumbers.some(caseNumber => String(result.caseNumber).includes(caseNumber)) ? 5 : 0;
    return {
      ...result,
      score: Number(result.score || 0) + exactPhraseBoost + caseBoost,
      matchedTerms: Object.keys(result.match || {}),
      exactPhraseMatch
    } as RagSearchResult;
  }).sort((a, b) => b.score - a.score).slice(0, limit);
}

export function buildLocalRagContext(results: RagSearchResult[]): string {
  if (results.length === 0) return "";
  return [
    "LOCAL E-DOCKET RETRIEVAL RESULTS:",
    "Use these excerpts as the primary evidence for claims about filing contents. Do not claim that an excerpt says something it does not say. Refer to evidence as [Local Source N].",
    ...results.map((result, index) => [
      `[Local Source ${index + 1}]`,
      `Case: ${result.caseNumber}`,
      `Docket: ${result.docketNumber}`,
      `Document: ${result.filename}`,
      `Filing type: ${result.filingType || "Unknown"}`,
      `Filer: ${result.filer || "Unknown"}`,
      `Received: ${result.receivedDate || "Unknown"}`,
      `Page: ${result.page}`,
      `Matched terms: ${result.matchedTerms.join(", ") || "metadata match"}`,
      `Full cleaned query appears as an exact phrase: ${result.exactPhraseMatch ? "yes" : "no"}`,
      `Official PDF: ${result.pdfUrl}`,
      `Excerpt: ${result.text}`
    ].join("\n"))
  ].join("\n\n");
}

export function formatLocalRagSources(results: RagSearchResult[]): string {
  if (results.length === 0) return "";
  const seen = new Set<string>();
  const sourceLines = results.flatMap(result => {
    const key = `${result.filingId}:${result.page}`;
    if (seen.has(key)) return [];
    seen.add(key);
    const label = `${result.docketNumber || result.caseNumber} — ${result.filename}, p. ${result.page}`;
    return [`- [${label}](${result.pdfUrl})`];
  });
  return sourceLines.length > 0
    ? `\n\n---\n**Retrieved from the local e-Docket index:**\n${sourceLines.join("\n")}`
    : "";
}

export function createSearchIndex(chunks: RagChunk[]) {
  const index = new MiniSearch(SEARCH_OPTIONS as any);
  index.addAll(chunks);
  return index;
}
