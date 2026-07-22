import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { createTermFilter, filterToSqlBlob, TERM_FILTER_BYTES } from "../shared/compactSearch.ts";

type Filing = {
  filingId: number;
  docketNumber?: string;
  receivedDate?: string;
  companyOrIndividual?: string;
  filingType?: string;
  description?: string;
  attachment?: string;
  attachmentFileName?: string;
};

type ExtractedDocument = {
  version: 1;
  caseNumber: string;
  filing: Filing;
  pdfUrl: string;
  pages: Array<{ page: number; text: string }>;
  emptyPages: number[];
};

function isRelatedDocket(docketNumber: string | undefined, caseNumber: string): boolean {
  return new RegExp(`(?:^|,\\s*)(?:FC|DR)${caseNumber}\\s*-`, "i").test(docketNumber || "");
}

const MAX_D1_ESTIMATE = 400 * 1024 * 1024;
const MAX_SQL_FILE_BYTES = 4 * 1024 * 1024;

function readFlag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function cleanText(value = ""): string {
  return value.replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ").replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function sql(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "NULL";
  if (typeof value === "number") return String(value);
  const safeValue = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  return `'${safeValue.replace(/'/g, "''")}'`;
}

function relatedCaseNumbers(docketNumber: string | undefined, fallback: string): string[] {
  const matches = String(docketNumber || "").split(",").map(docket =>
    docket.trim().split(/\s+-\s+(?=[^-]*$)/)[0].toUpperCase().replaceAll(" ", "")
  ).filter(caseNumber => /^[A-Z][A-Z0-9-]{2,30}$/.test(caseNumber));
  return Array.from(new Set([fallback.toUpperCase(), ...matches]));
}

async function main() {
  const caseNumber = (readFlag("--case") || "1176").replace(/^FC/i, "");
  const dataDir = path.resolve(readFlag("--data-dir") || ".rag-data");
  const sourceDir = path.join(dataDir, "documents", caseNumber);
  const outputDir = path.join(dataDir, "cloud", `FC${caseNumber}`);
  const objectDir = path.join(outputDir, "objects");
  const sqlDir = path.join(outputDir, "sql");
  let previousR2Keys: string[] = [];
  try {
    const previousState = JSON.parse(await fs.readFile(path.join(outputDir, "publish-state.json"), "utf8")) as { r2Keys?: string[] };
    previousR2Keys = previousState.r2Keys || [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await fs.rm(outputDir, { recursive: true, force: true });
  await Promise.all([fs.mkdir(objectDir, { recursive: true }), fs.mkdir(sqlDir, { recursive: true })]);

  const filenames = (await fs.readdir(sourceDir)).filter(name => name.endsWith(".json")).sort();
  const manifest: Array<{ filingId: number; key: string; file: string; bytes: number }> = [];
  const statements: string[] = [];
  const includedFilingIds: number[] = [];
  let textBytes = 0;
  let emptyPageCount = 0;
  let termFilterBytes = 0;

  for (const filename of filenames) {
    const document = JSON.parse(await fs.readFile(path.join(sourceDir, filename), "utf8")) as ExtractedDocument;
    const filing = document.filing;
    if (!isRelatedDocket(filing.docketNumber, caseNumber)) continue;
    includedFilingIds.push(filing.filingId);
    const year = String(filing.receivedDate || "unknown").slice(0, 4);
    const key = `filings/${year}/${filing.filingId}.html.gz`;
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(
      filing.attachmentFileName || filing.attachment || "PSC filing"
    )}</title></head><body><main data-filing-id="${filing.filingId}" data-case="${document.caseNumber}">${
      document.pages.map(page => `<section data-page="${page.page}"><pre>${escapeHtml(page.text)}</pre></section>`).join("\n")
    }</main></body></html>`;
    const compressed = gzipSync(Buffer.from(html), { level: 9 });
    const objectFile = path.join(objectDir, `${filing.filingId}.html.gz`);
    await fs.writeFile(objectFile, compressed);
    manifest.push({ filingId: filing.filingId, key, file: objectFile, bytes: compressed.byteLength });

    const title = cleanText(filing.description || "") || filing.attachmentFileName || filing.attachment || "PSC filing";
    const digest = createHash("sha256").update(html).digest("hex");
    const termFilter = createTermFilter(document.pages.map(page => page.text).join("\n"));
    termFilterBytes += termFilter.byteLength;
    statements.push(
      `INSERT INTO documents (filing_id,case_number,docket_number,title,filer,filing_type,received_date,official_pdf_url,r2_key,page_count,ocr_page_count,content_sha256,indexed_at,term_filter) VALUES (` +
      [filing.filingId, document.caseNumber, filing.docketNumber, title, cleanText(filing.companyOrIndividual),
        cleanText(filing.filingType), filing.receivedDate, document.pdfUrl, key, document.pages.length,
        0, digest, new Date().toISOString()].map(sql).join(",") + `,${filterToSqlBlob(termFilter)}` +
      `) ON CONFLICT(filing_id) DO UPDATE SET case_number=excluded.case_number,docket_number=excluded.docket_number,title=excluded.title,filer=excluded.filer,filing_type=excluded.filing_type,received_date=excluded.received_date,official_pdf_url=excluded.official_pdf_url,r2_key=excluded.r2_key,page_count=excluded.page_count,ocr_page_count=excluded.ocr_page_count,content_sha256=excluded.content_sha256,indexed_at=excluded.indexed_at,term_filter=excluded.term_filter;`
    );
    for (const relatedCase of relatedCaseNumbers(filing.docketNumber, document.caseNumber)) {
      statements.push(`INSERT OR IGNORE INTO document_cases (filing_id,case_number) VALUES (${filing.filingId},${sql(relatedCase)});`);
    }
    textBytes += document.pages.reduce((sum, page) => sum + Buffer.byteLength(page.text), 0);
    emptyPageCount += document.emptyPages.length;
  }

  const estimatedD1Bytes = Math.ceil(termFilterBytes * 1.35 + includedFilingIds.length * 1024);
  if (estimatedD1Bytes > MAX_D1_ESTIMATE) {
    throw new Error(`Estimated D1 growth ${estimatedD1Bytes} exceeds the 400 MiB safety ceiling.`);
  }

  if (includedFilingIds.length) {
    statements.unshift(
      `DELETE FROM document_cases WHERE case_number IN (${sql(`FC${caseNumber}`)},${sql(`DR${caseNumber}`)}) AND filing_id NOT IN (${includedFilingIds.join(",")});`
    );
  }

  const batchHeader = "PRAGMA foreign_keys=ON;\n";
  let batch = batchHeader;
  let batchNumber = 1;
  for (const statement of statements) {
    const startsDocument = statement.startsWith("INSERT INTO documents ");
    // Keep a document and all of its chunks in the same D1 import transaction.
    // A few unusually long filings may make a batch larger than the target.
    if (startsDocument && batch !== batchHeader && Buffer.byteLength(batch) + Buffer.byteLength(statement) + 1 > MAX_SQL_FILE_BYTES) {
      await fs.writeFile(path.join(sqlDir, `${String(batchNumber).padStart(4, "0")}.sql`), batch);
      batchNumber += 1;
      batch = batchHeader;
    }
    batch += `${statement}\n`;
  }
  if (batch.trim()) await fs.writeFile(path.join(sqlDir, `${String(batchNumber).padStart(4, "0")}.sql`), batch);

  const summary = {
    caseNumber: `FC${caseNumber}`,
    preparedAt: new Date().toISOString(),
    documentCount: includedFilingIds.length,
    searchMode: "document-term-filter",
    termFilterBytesPerDocument: TERM_FILTER_BYTES,
    emptyPageCount,
    textBytes,
    estimatedD1Bytes,
    compressedHtmlBytes: manifest.reduce((sum, item) => sum + item.bytes, 0),
    sqlBatchCount: batchNumber,
    objects: manifest,
    staleR2Keys: previousR2Keys.filter(key => !manifest.some(item => item.key === key))
  };
  await fs.writeFile(path.join(outputDir, "manifest.json"), JSON.stringify(summary, null, 2));
  if (previousR2Keys.length) {
    await fs.writeFile(path.join(outputDir, "publish-state.json"), JSON.stringify({
      r2Keys: previousR2Keys.filter(key => manifest.some(item => item.key === key)),
      d1Batches: []
    }, null, 2));
  }
  console.log(JSON.stringify({ ...summary, objects: undefined }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
