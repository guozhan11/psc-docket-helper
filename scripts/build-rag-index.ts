import fs from "node:fs/promises";
import path from "node:path";
import { createSearchIndex, type RagChunk } from "../rag/localRag.ts";

const EDOCKET_API_URL = "https://edocket.dcpsc.org/apis/api/";
const USER_AGENT = "Mozilla/5.0 (compatible; PSC-Docket-Helper-RAG/1.0; +https://dcpsc.org/)";
const PAGE_SIZE = 100;

type Filing = {
  filingId: number;
  docketNumber?: string;
  isConfidential?: boolean;
  isArchived?: boolean;
  receivedDate?: string;
  companyOrIndividual?: string;
  filingType?: string;
  description?: string;
  attachment?: string;
  attachmentFileName?: string;
  attachmentId?: number;
};

type ExtractedDocument = {
  version: 1;
  caseNumber: string;
  filing: Filing;
  detailUrl: string;
  pdfUrl: string;
  pages: Array<{ page: number; text: string }>;
  emptyPages: number[];
};

function readFlag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  work: (value: T, index: number) => Promise<R | undefined>
): Promise<R[]> {
  const results: Array<R | undefined> = new Array(values.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await work(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return results.filter((value): value is R => value !== undefined);
}

function sanitizeFilename(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, "_").replace(/^_+|_+$/g, "").slice(0, 160) || "filing.pdf";
}

function stripHtml(value = ""): string {
  return value.replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ").replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}

function getDetailUrl(filing: Filing): string {
  const primaryDocket = String(filing.docketNumber || "").split(", ")[0];
  const parts = primaryDocket.split(" - ").map(part => part.trim()).filter(Boolean);
  if (parts.length < 2) return "https://edocket.dcpsc.org/public/search";
  return `https://edocket.dcpsc.org/public/search/details/${encodeURIComponent(parts[0])}/${encodeURIComponent(parts.at(-1)!)}`;
}

function getPdfUrl(filing: Filing): string {
  const params = new URLSearchParams({ attachId: String(filing.attachmentId), guidFileName: String(filing.attachment) });
  return `${EDOCKET_API_URL}Filing/download?${params.toString()}`;
}

async function fetchJson(url: string) {
  const response = await fetch(url, { headers: { Accept: "application/json", "User-Agent": USER_AGENT } });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}`);
  return response.json();
}

async function getPublicPdfFilings(caseNumber: string): Promise<Filing[]> {
  const filings: Filing[] = [];
  let totalRecords = Number.POSITIVE_INFINITY;
  for (let offset = 0; offset < totalRecords; offset += PAGE_SIZE) {
    const url = new URL("Filing/GetFilings", EDOCKET_API_URL);
    url.search = new URLSearchParams({
      caseNumber, isAdmin: "false", orderByColumn: "receivedDate", sortBy: "desc",
      recordsToSkip: String(offset), recordsToShow: String(PAGE_SIZE)
    }).toString();
    const data = await fetchJson(url.href);
    totalRecords = Number(data?.totalRecords || 0);
    const page = Array.isArray(data?.resultsSet) ? data.resultsSet as Filing[] : [];
    const relatedDocket = new RegExp(`(?:^|,\\s*)(?:FC|DR)${caseNumber}\\s*-`, "i");
    filings.push(...page.filter(filing => relatedDocket.test(filing.docketNumber || "")
      && !filing.isConfidential && !filing.isArchived && filing.attachmentId
      && filing.attachment && String(filing.attachment).toLowerCase().endsWith(".pdf")));
    console.log(`[${caseNumber}] Read ${Math.min(offset + PAGE_SIZE, totalRecords)} / ${totalRecords} filing records.`);
    if (page.length === 0) break;
  }
  return filings;
}

async function extractPdfPages(pdfPath: string): Promise<Array<{ page: number; text: string }>> {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(await fs.readFile(pdfPath));
  const document = await getDocument({ data, useSystemFonts: true, isEvalSupported: false } as any).promise;
  const pages: Array<{ page: number; text: string }> = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = (content.items as any[]).map(item => `${item.str || ""}${item.hasEOL ? "\n" : " "}`).join("")
      .replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    pages.push({ page: pageNumber, text });
    page.cleanup();
  }
  return pages;
}

function splitPageText(text: string, targetLength = 1800, overlap = 250): string[] {
  if (text.length <= targetLength) return text ? [text] : [];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + targetLength, text.length);
    if (end < text.length) {
      const boundary = Math.max(text.lastIndexOf("\n", end), text.lastIndexOf(". ", end));
      if (boundary > start + Math.floor(targetLength * 0.6)) end = boundary + 1;
    }
    chunks.push(text.slice(start, end).trim());
    if (end >= text.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks.filter(Boolean);
}

async function downloadAndExtract(
  caseNumber: string,
  filing: Filing,
  dataDir: string,
  keepPdfs: boolean
): Promise<ExtractedDocument> {
  const caseDir = path.join(dataDir, "documents", caseNumber);
  const pdfDir = path.join(dataDir, "pdfs", caseNumber);
  await Promise.all([fs.mkdir(caseDir, { recursive: true }), fs.mkdir(pdfDir, { recursive: true })]);
  const documentPath = path.join(caseDir, `${filing.filingId}.json`);
  try {
    const cached = JSON.parse(await fs.readFile(documentPath, "utf8")) as ExtractedDocument;
    if (!keepPdfs) {
      const prefix = `${filing.filingId}-`;
      for (const filename of await fs.readdir(pdfDir).catch(() => [])) {
        if (filename.startsWith(prefix)) await fs.unlink(path.join(pdfDir, filename)).catch(() => undefined);
      }
    }
    return cached;
  } catch {
    // Cache miss.
  }

  const originalName = filing.attachmentFileName || filing.attachment || `${filing.filingId}.pdf`;
  const pdfPath = path.join(pdfDir, `${filing.filingId}-${sanitizeFilename(originalName)}`);
  try {
    await fs.access(pdfPath);
  } catch {
    const response = await fetch(getPdfUrl(filing), { headers: { "User-Agent": USER_AGENT } });
    if (!response.ok) throw new Error(`PDF download returned ${response.status}`);
    await fs.writeFile(pdfPath, new Uint8Array(await response.arrayBuffer()));
  }

  try {
    const header = new Uint8Array(await fs.readFile(pdfPath).then(data => data.subarray(0, 5)));
    if (new TextDecoder().decode(header) !== "%PDF-") throw new Error("Downloaded attachment is not a PDF");
    const pages = await extractPdfPages(pdfPath);
    const document: ExtractedDocument = {
      version: 1,
      caseNumber: caseNumber.toUpperCase().startsWith("FC") ? caseNumber.toUpperCase() : `FC${caseNumber}`,
      filing,
      detailUrl: getDetailUrl(filing),
      pdfUrl: getPdfUrl(filing),
      pages,
      emptyPages: pages.filter(page => page.text.length < 40).map(page => page.page)
    };
    const temporaryPath = `${documentPath}.tmp`;
    await fs.writeFile(temporaryPath, JSON.stringify(document));
    await fs.rename(temporaryPath, documentPath);
    return document;
  } finally {
    if (!keepPdfs) await fs.unlink(pdfPath).catch(() => undefined);
  }
}

function documentToChunks(document: ExtractedDocument): RagChunk[] {
  return document.pages.flatMap(page => splitPageText(page.text).map((text, chunkIndex) => ({
    id: `${document.filing.filingId}:${page.page}:${chunkIndex}`,
    caseNumber: document.caseNumber,
    docketNumber: document.filing.docketNumber || document.caseNumber,
    filingId: document.filing.filingId,
    filename: document.filing.attachmentFileName || document.filing.attachment || "Filing PDF",
    filingType: stripHtml(document.filing.filingType || ""),
    filer: stripHtml(document.filing.companyOrIndividual || ""),
    receivedDate: document.filing.receivedDate || "",
    detailUrl: document.detailUrl,
    pdfUrl: document.pdfUrl,
    page: page.page,
    text
  })));
}

async function main() {
  const caseNumbers = (readFlag("--cases") || process.env.RAG_CASE_NUMBERS || "1176").split(",")
    .map(value => value.trim().replace(/^FC/i, "")).filter(Boolean);
  const limit = parsePositiveInteger(readFlag("--limit"), 0);
  const concurrency = Math.max(1, Math.min(8, parsePositiveInteger(readFlag("--concurrency"), 4)));
  const keepPdfs = process.argv.includes("--keep-pdfs");
  const dataDir = path.resolve(readFlag("--data-dir") || process.env.RAG_DATA_DIR || ".rag-data");
  await fs.mkdir(dataDir, { recursive: true });

  const documents: ExtractedDocument[] = [];
  for (const caseNumber of caseNumbers) {
    const allFilings = await getPublicPdfFilings(caseNumber);
    const filings = limit > 0 ? allFilings.slice(0, limit) : allFilings;
    console.log(`[${caseNumber}] Processing ${filings.length} public PDF filings.`);
    const caseDocuments = await mapWithConcurrency(filings, concurrency, async (filing, index) => {
      try {
        const document = await downloadAndExtract(caseNumber, filing, dataDir, keepPdfs);
        console.log(`[${caseNumber}] ${index + 1}/${filings.length}: ${filing.attachmentFileName || filing.attachment}`);
        return document;
      } catch (error: any) {
        console.warn(`[${caseNumber}] Skipped filing ${filing.filingId}: ${error?.message || error}`);
        return undefined;
      }
    });
    documents.push(...caseDocuments);
  }

  const chunks = documents.flatMap(documentToChunks);
  const searchIndex = createSearchIndex(chunks);
  const emptyPageCount = documents.reduce((sum, document) => sum + document.emptyPages.length, 0);
  const output = {
    version: 1, builtAt: new Date().toISOString(), caseNumbers: caseNumbers.map(value => `FC${value}`),
    documentCount: documents.length, chunkCount: chunks.length, searchIndex: searchIndex.toJSON()
  };
  const indexPath = path.join(dataDir, "index.json");
  const temporaryIndexPath = `${indexPath}.tmp`;
  await fs.writeFile(temporaryIndexPath, JSON.stringify(output));
  await fs.rename(temporaryIndexPath, indexPath);
  console.log(`Local RAG index written to ${indexPath}`);
  console.log(`${documents.length} filings, ${chunks.length} chunks, ${emptyPageCount} pages flagged for optional OCR.`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
