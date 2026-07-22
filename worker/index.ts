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
}

interface CompactDocumentRow {
  filing_id: number;
  case_number: string;
  docket_number: string | null;
  title: string;
  received_date: string | null;
  official_pdf_url: string;
  r2_key: string;
  term_filter: ArrayBuffer | number[];
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
  "find", "for", "from", "have", "into", "mention", "mentions", "please", "that", "the",
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

function toFilterBytes(value: ArrayBuffer | number[]): Uint8Array {
  return new Uint8Array(value);
}

function findPageExcerpts(html: string, terms: string[], document: CompactDocumentRow): SearchRow[] {
  const rows: SearchRow[] = [];
  const sections = html.matchAll(/<section\s+data-page=["'](\d+)["'][^>]*>([\s\S]*?)<\/section>/gi);
  for (const section of sections) {
    const text = stripHtml(section[2]);
    const normalized = text.toLowerCase();
    const matchingTerms = terms.filter(term => normalized.includes(term));
    if (!matchingTerms.length) continue;
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
  terms: string[]
): Promise<SearchRow[]> {
  const candidates: Array<CompactDocumentRow & { filterHits: number }> = [];
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
      for (const document of result.results ?? []) {
        const filter = toFilterBytes(document.term_filter);
        const filterHits = terms.filter(term => termMayExist(filter, term)).length;
        if (filterHits > 0) candidates.push({ ...document, filterHits });
      }
      if ((result.results?.length ?? 0) < pageSize) break;
    }
  }
  candidates.sort((left, right) => right.filterHits - left.filterHits
    || String(right.received_date || "").localeCompare(String(left.received_date || "")));

  const selected = candidates.slice(0, 20);
  const rows: SearchRow[] = [];
  for (let start = 0; start < selected.length; start += 4) {
    const batch = selected.slice(start, start + 4);
    const batchRows = await Promise.all(batch.map(async document => {
      const object = await env.DOCUMENTS.get(document.r2_key);
      if (!object || object.size > 3 * 1024 * 1024) return [];
      const stream = object.body.pipeThrough(new DecompressionStream("gzip"));
      const html = await new Response(stream).text();
      return findPageExcerpts(html, terms, document);
    }));
    rows.push(...batchRows.flat());
  }
  return rows.sort((left, right) => left.rank - right.rank).slice(0, 8);
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

async function searchDockets(env: WorkerEnv, message: string): Promise<SearchRow[]> {
  const terms = buildSearchTerms(message);
  const caseNumber = extractCaseIdentifier(message);
  if (caseNumber && terms.length) {
    try {
      const compactRows = await searchCompactDocuments(env, caseNumber, terms);
      if (compactRows.length) return compactRows;
    } catch (error) {
      console.error(JSON.stringify({ message: "compact search unavailable", error: String(error), caseNumber }));
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
  return rows.map((row, index) => [
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

function extractOpenAiText(response: any): string {
  if (typeof response?.output_text === "string") return response.output_text.trim();
  if (!Array.isArray(response?.output)) return "";
  return response.output.flatMap((item: any) =>
    Array.isArray(item?.content)
      ? item.content.filter((part: any) => part?.type === "output_text").map((part: any) => part.text)
      : []
  ).join("\n").trim();
}

async function answerWithOpenAi(env: WorkerEnv, history: ChatMessage[], message: string, rows: SearchRow[]): Promise<string> {
  if (!env.OPENAI_API_KEY) {
    if (!rows.length) {
      return `No matching excerpt was found in the indexed filings. Try a more specific keyword or case number, or use the [official e-Docket search](${EDOCKET_SEARCH_URL}).`;
    }
    return [
      `I found ${rows.length} matching excerpt(s) in the indexed filings. AI synthesis is disabled, so these results are shown directly without any model/API charge.`,
      ...rows.map((row, index) => [
        `**${index + 1}. ${row.case_number}: ${row.title} — page ${row.page_number}**`,
        row.text.slice(0, 700),
        `[Open the official PDF at page ${row.page_number}](${officialPdfPageUrl(row)})`
      ].join("\n\n")),
      `[Search the complete official e-Docket](${EDOCKET_SEARCH_URL})`
    ].join("\n\n---\n\n");
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${env.OPENAI_API_KEY}`,
    "Content-Type": "application/json"
  };
  if (env.CF_AIG_TOKEN) headers["cf-aig-authorization"] = `Bearer ${env.CF_AIG_TOKEN}`;
  const response = await fetch(openAiEndpoint(env), {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: env.OPENAI_MODEL || "gpt-4.1",
      instructions: `You are the DC PSC Docket Assistant for people researching District of Columbia utility regulation.
Only answer questions related to the DC Public Service Commission, its proceedings, dockets, utilities, or public filings.
Ground document-content claims in the supplied indexed excerpts. Cite evidence inline using each record's exact Required citation Markdown.
Never show labels such as Source 1, Source 2, or Evidence 1 to the user. A citation must identify the filing by title and PDF page, for example [Pepco Updated Remand Testimony — p. 374](official PDF page URL).
Never invent a filing, quotation, page, date, or URL. If evidence is insufficient, say so and suggest a narrower search.
Keep exact keyword matches distinct from interpretation. Always include the official e-Docket search link when useful.`,
      input: `INDEXED E-DOCKET EXCERPTS:\n${sourceContext(rows)}\n\nCONVERSATION:\n${buildTranscript(history, message)}`,
      text: { format: { type: "text" } }
    })
  });
  if (!response.ok) {
    throw new Error(`OpenAI Responses API returned ${response.status}: ${await response.text()}`);
  }
  const rawReply = extractOpenAiText(await response.json());
  if (!rawReply) throw new Error("OpenAI returned no text");
  const reply = replaceOpaqueSourceLabels(rawReply, rows);
  const sources = Array.from(new Map(rows.map(row => [row.filing_id, row])).values()).slice(0, 5);
  if (!sources.length) return reply;
  return `${reply}\n\n---\n**Official filing sources**\n${sources.map(row =>
    `- [${row.case_number}: ${row.title} — page ${row.page_number}](${officialPdfPageUrl(row)})`
  ).join("\n")}`;
}

async function handleApi(request: Request, env: WorkerEnv): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

  if (url.pathname === "/api/health" && request.method === "GET") {
    const shardCounts = await Promise.all(searchDatabases(env).map(database => database.prepare(
      `SELECT COUNT(*) AS documents,
              COUNT(term_filter) AS compactDocuments,
              (SELECT COUNT(DISTINCT case_number) FROM document_cases) AS cases
         FROM documents`
    ).first<{ documents: number; compactDocuments: number; cases: number }>().catch(() => null)));
    const counts = shardCounts.reduce((total, shard) => ({
      documents: total.documents + (shard?.documents ?? 0),
      compactDocuments: total.compactDocuments + (shard?.compactDocuments ?? 0),
      cases: total.cases + (shard?.cases ?? 0)
    }), { documents: 0, compactDocuments: 0, cases: 0 });
    return json({ status: "ok", cloudRag: counts, shards: shardCounts });
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
    const body = await request.json<{ history?: ChatMessage[]; message?: string }>().catch(() => null);
    const message = body?.message?.trim();
    if (!message) return json({ error: "Missing message body" }, 400);
    try {
      const directCaseReply = await buildDetailedCaseNumberReply(message);
      if (directCaseReply) return json({ reply: directCaseReply });
      const rows = await searchDockets(env, message);
      const reply = await answerWithOpenAi(env, body?.history ?? [], message, rows);
      return json({ reply });
    } catch (error: any) {
      console.error("chat failed", error);
      return json({
        reply: `⚠️ The assistant could not complete this search right now. Please try again, or use the [official e-Docket search](${EDOCKET_SEARCH_URL}).`
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
