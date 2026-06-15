import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";

// Initialize Gemini on the server side using the secure env variable with recommended telemetry headers
const ai = new GoogleGenAI({ 
  apiKey: process.env.GEMINI_API_KEY || "",
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build',
    }
  }
});

const DC_PSC_NEWSROOM_URL = "https://dcpsc.org/Newsroom.aspx";
const EDOCKET_CASE_SEARCH_URL = "https://edocket.dcpsc.org/Search/CaseSearch";
const DC_PSC_CURRENT_NEWS_URL = "https://dcpsc.org/Newsroom/Current-PSC-News.aspx";
const EDOCKET_API_URL = "https://edocket.dcpsc.org/apis/api/";

// Helper utility to normalize and correct any DC PSC & eDocket URLs (e.g. converting lowercase paths to case-sensitive equivalents used by IIS)
function normalizeUrl(url: string | undefined): string {
  if (!url) return '';
  let normalized = url.trim();
  
  // 1. Force HTTPS on dcpsc.org / edocket.dcpsc.org domains
  if (normalized.includes('dcpsc.org') && normalized.startsWith('http:')) {
    normalized = normalized.replace(/^http:/i, 'https:');
  }

  // 2. Fix Case-Sensitivity for e-Docket Search and CaseDetail URLs
  // This is critical because Microsoft IIS servers and ASP.NET backends return a 404 for lowercase routes/parameters
  if (normalized.includes('edocket.dcpsc.org')) {
    // Correct general search routing
    normalized = normalized.replace(/\/search\//i, '/Search/');
    
    // Correct CaseDetail and CaseSearch paths case-insensitively
    normalized = normalized.replace(/casedetail/i, 'CaseDetail');
    normalized = normalized.replace(/casesearch/i, 'CaseSearch');
    
    // Correct casenumber= query parameter case-insensitively to caseNumber=
    normalized = normalized.replace(/casenumber=/i, 'caseNumber=');
  }

  return normalized;
}

function isOfficialPscUrl(urlStr: string): boolean {
  try {
    const hostname = new URL(urlStr).hostname.toLowerCase();
    return hostname === "dcpsc.org" || hostname.endsWith(".dcpsc.org");
  } catch {
    return false;
  }
}

function isKnownStablePscUrl(urlStr: string): boolean {
  const normalized = normalizeUrl(urlStr);
  return normalized === DC_PSC_NEWSROOM_URL
    || normalized === DC_PSC_CURRENT_NEWS_URL
    || normalized === EDOCKET_CASE_SEARCH_URL;
}

function decodeHtmlEntities(value: string): string {
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
  return decodeHtmlEntities(value.replace(/<[^>]*>/g, " "));
}

function toPscAbsoluteUrl(href: string): string {
  return new URL(decodeHtmlEntities(href), "https://dcpsc.org").href;
}

function parseOfficialNews(html: string) {
  const items: any[] = [];
  const blocks = html.split('<div class="blog-list style-1">').slice(1);

  for (const block of blocks) {
    const anchorMatch = block.match(/<h2>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h2>/i);
    if (!anchorMatch) {
      continue;
    }

    const url = toPscAbsoluteUrl(anchorMatch[1]);
    if (!isOfficialPscUrl(url)) {
      continue;
    }

    const title = stripHtml(anchorMatch[2]);
    const summaryMatch = block.match(/<p>([\s\S]*?)<\/p>/i);
    const dateMatch = block.match(/fa-calendar-o[\s\S]*?<\/i>\s*([^<\n]+)/i);
    const summary = summaryMatch ? stripHtml(summaryMatch[1]) : title;
    const date = dateMatch ? decodeHtmlEntities(dateMatch[1]) : "Latest update";

    if (title && url) {
      items.push({
        title,
        date,
        summary,
        url,
        source: "DCPSC Current PSC News"
      });
    }
  }

  return items;
}

function extractCaseNumbers(text: string): string[] {
  const candidates = new Set<string>();
  const patterns = [
    /\bFC\s*[-#:]?\s*(\d{3,5})\b/gi,
    /\bFormal\s+Case\s+(?:No\.?|Number)?\s*[-#:]?\s*(\d{3,5})\b/gi,
    /\bcaseNumber=(\d{3,5})\b/gi,
    /\bcase\s+(?:no\.?|number)?\s*[-#:]?\s*(\d{3,5})\b/gi,
    /\bdocket\s+(?:no\.?|number)?\s*[-#:]?\s*(\d{3,5})\b/gi
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      candidates.add(match[1]);
    }
  }

  return Array.from(candidates);
}

async function fetchEdocketJson(endpoint: string, params: Record<string, string | number | boolean>) {
  const url = new URL(endpoint, EDOCKET_API_URL);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }

  const response = await fetch(url.href, {
    headers: {
      "Accept": "application/json",
      "User-Agent": "Mozilla/5.0 (compatible; PSC-Docket-Helper/1.0; +https://dcpsc.org/)"
    }
  });

  if (!response.ok) {
    throw new Error(`e-Docket API returned ${response.status} for ${endpoint}`);
  }

  return response.json();
}

async function getOfficialCasesByNumber(caseNumber: string): Promise<any[]> {
  const data = await fetchEdocketJson("Case/GetCaseTable", {
    caseNumber,
    recordsToSkip: 0,
    recordsToShow: 25,
    orderByColumn: "DateOpen",
    sortBy: "DESC",
    isPublicComments: "N",
    isUser: false
  });

  return Array.isArray(data?.resultsSet) ? data.resultsSet : [];
}

async function isRealEdocketCaseNumber(caseNumber: string): Promise<boolean> {
  const cases = await getOfficialCasesByNumber(caseNumber);
  return cases.length > 0;
}

function getEdocketCaseSearchUrl(caseNumber: string): string {
  return `https://edocket.dcpsc.org/public/search/casenumber/${encodeURIComponent(caseNumber)}`;
}

function getEdocketFilingDetailUrl(filing: any): string | null {
  if (!filing?.docketNumber || filing.isConfidential || filing.isArchived) {
    return null;
  }

  const primaryDocket = String(filing.docketNumber).split(", ")[0];
  const parts = primaryDocket.split(" - ").map(part => part.trim()).filter(Boolean);
  if (parts.length < 2) {
    return null;
  }

  return `https://edocket.dcpsc.org/public/search/details/${encodeURIComponent(parts[0])}/${encodeURIComponent(parts[parts.length - 1])}`;
}

function getEdocketAttachmentUrl(filing: any): string | null {
  if (!filing?.attachmentId || !filing?.attachment || filing.isConfidential || filing.isArchived) {
    return null;
  }

  const attachment = String(filing.attachment);
  if (!attachment.toLowerCase().endsWith(".pdf")) {
    return null;
  }

  const params = new URLSearchParams({
    attachId: String(filing.attachmentId),
    guidFileName: attachment
  });
  return `${EDOCKET_API_URL}Filing/download?${params.toString()}`;
}

async function getOfficialFilingsByCaseNumber(caseNumber: string): Promise<any[]> {
  const data = await fetchEdocketJson("Filing/GetFilings", {
    caseNumber,
    isAdmin: false,
    orderByColumn: "receivedDate",
    sortBy: "desc",
    recordsToSkip: 0,
    recordsToShow: 25
  });

  return Array.isArray(data?.resultsSet) ? data.resultsSet : [];
}

async function buildVerifiedDocketLinks(text: string) {
  const caseNumbers = extractCaseNumbers(text);
  const verified: { label: string; url: string }[] = [];

  for (const caseNumber of caseNumbers) {
    try {
      const cases = await getOfficialCasesByNumber(caseNumber);
      if (cases.length === 0) {
        continue;
      }

      const formalCase = cases.find(item => String(item.caseNumber || "").toUpperCase() === `FC${caseNumber}`);
      const caseRecord = formalCase || cases[0];
      const caseLabel = `${caseRecord.caseNumber || `Case ${caseNumber}`} - ${stripHtml(caseRecord.caseCaption || caseRecord.companyIndividual || "e-Docket case records")}`;
      verified.push({
        label: caseLabel,
        url: getEdocketCaseSearchUrl(caseNumber)
      });

      const filings = await getOfficialFilingsByCaseNumber(caseNumber);
      for (const filing of filings) {
        const detailUrl = getEdocketFilingDetailUrl(filing);
        if (detailUrl) {
          verified.push({
            label: `${filing.docketNumber} - ${stripHtml(filing.filingType || filing.description || "Filing detail")}`,
            url: detailUrl
          });
        }

        const attachmentUrl = getEdocketAttachmentUrl(filing);
        if (attachmentUrl) {
          verified.push({
            label: `${filing.docketNumber} - ${filing.attachmentFileName || "Filing PDF"}`,
            url: attachmentUrl
          });
        }
      }
    } catch (error: any) {
      console.warn(`[e-Docket] Could not verify case ${caseNumber}:`, error?.message || error);
    }
  }

  const seen = new Set<string>();
  return verified.filter(item => {
    if (seen.has(item.url)) {
      return false;
    }
    seen.add(item.url);
    return true;
  }).slice(0, 8);
}

async function verifyEdocketUrl(urlStr: string): Promise<{ isValid: boolean; normalized: string; repairUrl?: string }> {
  const normalized = normalizeUrl(urlStr);

  try {
    const url = new URL(normalized);
    const caseDetailNumber = url.pathname.toLowerCase() === "/search/casedetail"
      ? url.searchParams.get("caseNumber")
      : null;
    const publicCaseSearchMatch = url.pathname.match(/^\/public\/search\/casenumber\/(\d{3,5})\/?$/i);

    const caseNumber = caseDetailNumber || publicCaseSearchMatch?.[1];
    if (caseNumber) {
      const isReal = await isRealEdocketCaseNumber(caseNumber);
      return {
        isValid: isReal,
        normalized: isReal ? getEdocketCaseSearchUrl(caseNumber) : normalized,
        repairUrl: EDOCKET_CASE_SEARCH_URL
      };
    }

    const detailMatch = url.pathname.match(/^\/public\/search\/details\/([^/]+)\/([^/]+)\/?$/i);
    if (detailMatch) {
      const docketPrefix = decodeURIComponent(detailMatch[1]);
      const itemNumber = decodeURIComponent(detailMatch[2]);
      const numberMatch = docketPrefix.match(/(\d{3,5})$/);
      if (!numberMatch) {
        return { isValid: false, normalized, repairUrl: EDOCKET_CASE_SEARCH_URL };
      }

      const filings = await getOfficialFilingsByCaseNumber(numberMatch[1]);
      const isReal = filings.some(filing => {
        const detailUrl = getEdocketFilingDetailUrl(filing);
        return detailUrl === `https://edocket.dcpsc.org/public/search/details/${encodeURIComponent(docketPrefix)}/${encodeURIComponent(itemNumber)}`;
      });

      return {
        isValid: isReal,
        normalized,
        repairUrl: isReal ? undefined : getEdocketCaseSearchUrl(numberMatch[1])
      };
    }

    if (url.pathname.toLowerCase() === "/apis/api/filing/download") {
      const attachId = url.searchParams.get("attachId");
      const guidFileName = url.searchParams.get("guidFileName");
      const isReal = !!attachId && !!guidFileName && /^[\w.-]+\.pdf$/i.test(guidFileName);
      return {
        isValid: isReal,
        normalized,
        repairUrl: EDOCKET_CASE_SEARCH_URL
      };
    }

    if (normalized === EDOCKET_CASE_SEARCH_URL) {
      return { isValid: true, normalized };
    }
  } catch {
    return { isValid: false, normalized, repairUrl: EDOCKET_CASE_SEARCH_URL };
  }

  return { isValid: false, normalized, repairUrl: EDOCKET_CASE_SEARCH_URL };
}

// Check if a URL is active on the internet using quick HEAD/GET fetch
async function checkUrlLive(urlStr: string): Promise<boolean> {
  try {
    const parsed = new URL(urlStr);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return false;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);

    let response;
    try {
      response = await fetch(parsed.href, {
        method: "HEAD",
        signal: controller.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
        }
      });
    } catch {
      // Ignored: fallback to GET
    }

    if (!response || !response.ok) {
      const getController = new AbortController();
      const getTimeout = setTimeout(() => getController.abort(), 2000);
      response = await fetch(parsed.href, {
        method: "GET",
        signal: getController.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
        }
      });
      clearTimeout(getTimeout);
    } else {
      clearTimeout(timeout);
    }

    if (response.status === 404) {
      return false;
    }

    return response.ok || response.status !== 404;
  } catch (err) {
    return false;
  }
}

// Walk through response markdown and verify or repair every link
async function postProcessChatReply(
  replyText: string, 
  verifiedUrls: { uri: string; title: string }[]
): Promise<string> {
  const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
  let match;
  let processedText = replyText;

  const matches: { full: string; label: string; url: string }[] = [];
  while ((match = linkRegex.exec(replyText)) !== null) {
    matches.push({
      full: match[0],
      label: match[1],
      url: match[2]
    });
  }

  if (matches.length === 0) {
    return processedText;
  }

  // Verify unique URLs
  const uniqueUrls = Array.from(new Set(matches.map(m => m.url)));
  const urlStatusMap = new Map<string, { isValid: boolean; normalized: string; repairUrl?: string }>();

  await Promise.all(uniqueUrls.map(async (rawUrl) => {
    if (!rawUrl || rawUrl.startsWith('#') || (rawUrl.startsWith('/') && !rawUrl.startsWith('//'))) {
      urlStatusMap.set(rawUrl, { isValid: true, normalized: rawUrl });
      return;
    }

    let urlToVerify = rawUrl;
    if (urlToVerify.startsWith('//')) {
      urlToVerify = 'https:' + urlToVerify;
    }

    const normalized = normalizeUrl(urlToVerify);

    if (normalized.includes('edocket.dcpsc.org')) {
      urlStatusMap.set(rawUrl, await verifyEdocketUrl(normalized));
      return;
    }

    // 1. Check if the link matches Google Search grounding chunks exactly
    const isGroundingUrl = verifiedUrls.some(v => normalizeUrl(v.uri) === normalized);
    if (isGroundingUrl) {
      urlStatusMap.set(rawUrl, { isValid: true, normalized });
      return;
    }

    // 2. Active Probe
    const isLive = await checkUrlLive(normalized);
    if (isLive) {
      urlStatusMap.set(rawUrl, { isValid: true, normalized });
    } else {
      // Look for any case number matches in grounding
      let repairUrl = "";
      const numbersInRawUrl = rawUrl.match(/\b\d{4}\b/);
      const caseNumberKeyword = numbersInRawUrl ? numbersInRawUrl[0] : "";

      const matchedVerified = verifiedUrls.find(v => {
        const vNormalized = normalizeUrl(v.uri);
        try {
          if (new URL(vNormalized).hostname === new URL(normalized).hostname) {
            if (caseNumberKeyword && vNormalized.includes(caseNumberKeyword)) {
              return true;
            }
          }
        } catch {
          // ignore invalid URIs
        }
        return false;
      });

      if (matchedVerified) {
        repairUrl = normalizeUrl(matchedVerified.uri);
      } else {
        if (normalized.includes('edocket.dcpsc.org')) {
          repairUrl = EDOCKET_CASE_SEARCH_URL;
        } else {
          repairUrl = DC_PSC_NEWSROOM_URL;
        }
      }

      urlStatusMap.set(rawUrl, { isValid: false, normalized, repairUrl });
    }
  }));

  // Perform replacements in text
  for (const m of matches) {
    const status = urlStatusMap.get(m.url);
    if (status) {
      if (status.isValid) {
        processedText = processedText.replace(m.full, `[${m.label}](${status.normalized})`);
      } else {
        processedText = processedText.replace(m.full, `[${m.label}](${status.repairUrl})`);
      }
    }
  }

  return processedText;
}

// Memory Cache and API limiters to avoid resource/quota exhaustion under heavy simulation
let cachedNews: any[] | null = null;
let lastNewsFetchTime = 0;
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes cache duration

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  // Middleware to support json parsing
  app.use(express.json());

  // API Route: Server status checking
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  // API Route: Retrieve latest news/announcements securely
  app.get("/api/news", async (req, res) => {
    // Real official DCPSC links captured from Current PSC News, used only if the source page is temporarily unavailable.
    const fallbackNews = [
      {
        title: "Open Commission Meeting - Friday, June 12, 2026, at 12:00 P.M.",
        date: "June 10, 2026",
        summary: "Open Commission Meeting - Friday, June 12, 2026, at 12:00 P.M.",
        url: "https://dcpsc.org/CMSPages/GetFile.aspx?guid=3d831595-442e-4df0-9989-aafdf4d24c01",
        source: "DCPSC Current PSC News"
      },
      {
        title: "GDCS-2026-01-M-2 - Supplemental Public Notice of Cybersecurity Briefing",
        date: "June 03, 2026",
        summary: "GDCS-2026-01-M-2 - Supplemental Public Notice of Cybersecurity Briefing",
        url: "https://dcpsc.org/CMSPages/GetFile.aspx?guid=5f38bc22-2f81-4e7b-b455-58f7435ac5fe",
        source: "DCPSC Current PSC News"
      },
      {
        title: "Open Commission Meeting - Wednesday, June 3, 2026, at 11:00 A.M.",
        date: "June 01, 2026",
        summary: "Open Commission Meeting - Wednesday, June 3, 2026, at 11:00 A.M.",
        url: "https://dcpsc.org/CMSPages/GetFile.aspx?guid=30902a58-0f69-466d-a91b-0bbd71896529",
        source: "DCPSC Current PSC News"
      },
      {
        title: "FC1017, FC1183 and FC1186 - Supplemental Notice of Legislative-Style (Informational) Hearing for Wednesday, June 3, 2026, at 11:00 A.M.",
        date: "May 27, 2026",
        summary: "FC1017, FC1183 and FC1186 - Supplemental Notice of Legislative-Style (Informational) Hearing for Wednesday, June 3, 2026, at 11:00 A.M.",
        url: "https://dcpsc.org/CMSPages/GetFile.aspx?guid=9f79863e-aed8-4ab8-a2ce-7dfed1314cf7",
        source: "DCPSC Current PSC News"
      },
      {
        title: "FC1125-2026-T-729 - Public Notice of Department of Energy and Environment FY2026 Second Quarter UDP Invoices",
        date: "May 26, 2026",
        summary: "FC1125-2026-T-729 - Public Notice of Department of Energy and Environment FY2026 Second Quarter UDP Invoices",
        url: "https://dcpsc.org/CMSPages/GetFile.aspx?guid=53fa619c-7d92-4cf6-9bfc-cd82c0581862",
        source: "DCPSC Current PSC News"
      }
    ];

    const now = Date.now();
    if (cachedNews && (now - lastNewsFetchTime < CACHE_TTL)) {
      console.log("[News Route] Serving cached official DCPSC news.");
      return res.json(cachedNews);
    }

    try {
      const response = await fetch(DC_PSC_CURRENT_NEWS_URL, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; PSC-Docket-Helper/1.0; +https://dcpsc.org/)"
        }
      });

      if (!response.ok) {
        throw new Error(`DCPSC Current News returned ${response.status}`);
      }

      const html = await response.text();
      const officialNews = parseOfficialNews(html).slice(0, 5);
      if (officialNews.length === 0) {
        throw new Error("No official DCPSC news items found");
      }

      cachedNews = officialNews;
      lastNewsFetchTime = Date.now();
      res.json(officialNews);
    } catch (error: any) {
      console.warn("Failing over to bundled official DCPSC news links:", error?.message || error);
      if (cachedNews && cachedNews.length > 0) {
        res.json(cachedNews);
      } else {
        res.json(fallbackNews);
      }
    }
  });

  // API Route: Securely chat with the DC PSC docket assistant
  app.post("/api/chat", async (req, res) => {
    try {
      const { history = [], message } = req.body;
      if (!message) {
        return res.status(400).json({ error: "Missing message body" });
      }

      if (!process.env.GEMINI_API_KEY) {
        return res.status(200).json({ 
          reply: `⚠️ **System Integration Notice:** Gemini API Key is missing. However, you can still access the case resources directly via the [e-Docket Case Search](https://edocket.dcpsc.org/Search/CaseSearch).` 
        });
      }

      try {
        const chat = ai.chats.create({
          model: "gemini-3.5-flash",
          history: history.map((m: any) => ({ 
            role: m.role === 'user' ? 'user' : 'model', 
            parts: [{ text: m.content }] 
          })),
          config: {
            systemInstruction: `You are the DC PSC Docket Assistant. Your goal is to help users find information about old and current dockets, cases, and regulatory filings from the Public Service Commission of the District of Columbia (DC PSC). 
            STRICT RULE: Only answer questions related to the DC Public Service Commission (PSC), its dockets, utility regulations, and energy/telecom/water oversight in DC. 
            If a user asks a question that is irrelevant to the DC PSC, politely decline.
            
            STRICT LINKING & ACCURACY RULES:
            1. ZERO HALLUCINATION: You are strictly FORBIDDEN from guessing, making up, or constructing URLs. Links must be 100% correct, verified, and functional.
            2. PREFER DIRECT LINKING TO FILINGS: Instead of just summarizing or quoting case numbers/dates, you MUST locate and provide direct links to the physical filings, commission orders, applications, or PDF records. Search Google specifically for e-Docket filings, using queries with "site:dcpsc.org" or "site:edocket.dcpsc.org" and filetype:pdf. Always present direct hyperlinks so the user doesn't have to search manually.
            3. E-DOCKET CASE SEARCH FALLBACK: Always provide the official, case-sensitive link [e-Docket Search](https://edocket.dcpsc.org/Search/CaseSearch) (note correct capitalization 'Search' and 'CaseSearch'). Advise the user to enter the case/docket number (e.g., "1156" or "1167") in the "Case Number" field to find more filings.
            4. DO NOT manually construct e-Docket detail URLs. If you know a case number, mention it plainly (for example, FC 1167). The server will append verified e-Docket case and filing links from the official e-Docket API.
            5. FORMAT ONLY VERIFIED LINKS IN MARKDOWN: Any PDF or document link you include must come directly from search grounding or an official source result. If you are not certain, provide the case number instead of a URL.`,
            tools: [{ googleSearch: {} }]
          }
        });

        const response = await chat.sendMessage({ message });
        
        // Parse verified live search URLs from Google Search grounding context
        const verifiedUrls: { uri: string; title: string }[] = [];
        const groundingMetadata = (response as any).candidates?.[0]?.groundingMetadata;
        if (groundingMetadata?.groundingChunks) {
          for (const chunk of groundingMetadata.groundingChunks) {
            if (chunk?.web?.uri) {
              verifiedUrls.push({
                uri: chunk.web.uri,
                title: chunk.web.title || ""
              });
            }
          }
        }

        // Intercept and resolve all links in markdown output
        let replyText = response.text || "";
        replyText = await postProcessChatReply(replyText, verifiedUrls);
        const verifiedDocketLinks = await buildVerifiedDocketLinks(`${message}\n${replyText}`);

        // Append clean, official verifiably source links as footnotes for supreme trust
        if (verifiedUrls.length > 0) {
          const uniqueVerified = Array.from(new Set(verifiedUrls.map(v => normalizeUrl(v.uri))))
            .map(uri => verifiedUrls.find(v => normalizeUrl(v.uri) === uri)!)
            .filter(v => isOfficialPscUrl(v.uri) && !normalizeUrl(v.uri).includes("edocket.dcpsc.org"))
            .slice(0, 3);

          if (uniqueVerified.length > 0) {
            replyText += `\n\n---\n🌐 **Official Verifiable Sources Found:**\n` + 
              uniqueVerified.map(uv => `- [${uv.title || "Public Service Commission Live Record"}](${normalizeUrl(uv.uri)})`).join("\n");
          }
        }

        if (verifiedDocketLinks.length > 0) {
          replyText += `\n\n---\n**Verified e-Docket Records:**\n` +
            verifiedDocketLinks.map(link => `- [${link.label}](${link.url})`).join("\n");
        }

        res.json({ reply: replyText });
      } catch (geminiError: any) {
        console.error("Gemini model execution error in chat route:", geminiError);
        
        // Formulate a beautiful, highly informative response based directly on the error context
        const isQuotaExceeded = geminiError?.message?.includes("quota") || geminiError?.status === "RESOURCE_EXHAUSTED" || geminiError?.code === 429;
        
        if (isQuotaExceeded) {
          console.warn("[Chat Route] Gemini API quota exceeded.");
          res.json({
            reply: `⚠️ **API Rate Limit Notice:** The Public Service Commission search engine is currently experiencing heavy load. 
  
To ensure you aren’t blocked from critical public records, please access the official databases directly:
- **Case or Docket Search:** Use [e-Docket Case Search](https://edocket.dcpsc.org/Search/CaseSearch) and type your Formal Case number (such as \`1156\`, \`1167\` or \`1182\`) directly into the Search bar.
- **Consumer Assistance & Filings:** For complaints or public comments, visit [DC PSC Consumer Connection](https://dcpsc.org/Consumers.aspx).
- **Press Releases & Daily Updates:** Read daily statements in the [DC PSC Newsroom](https://dcpsc.org/Newsroom.aspx).

Please try your chat query again in a moment once the quota resets!`
          });
        } else {
          res.json({
            reply: `⚠️ **Service Access Intermission:** Under pressure, our direct connection with the DC PSC servers momentarily reset. 

For instant dockets, enter your formal case or docket number manually in the main [e-Docket Case Search](${EDOCKET_CASE_SEARCH_URL}) database, or read updates at the [DC PSC Newsroom](${DC_PSC_NEWSROOM_URL}).`
          });
        }
      }
    } catch (error: any) {
      console.error("Chat error on server:", error);
      res.status(500).json({ error: error?.message || "Failed to process chat" });
    }
  });

  // API Route: Verify direct link accessibility to resolve the user request
  app.get("/api/verify-link", async (req, res) => {
    const urlParam = req.query.url;
    if (!urlParam || typeof urlParam !== "string") {
      return res.status(400).json({ error: "Missing url parameter" });
    }

    try {
      const url = new URL(urlParam);
      if (!["http:", "https:"].includes(url.protocol)) {
        return res.json({ valid: false, reason: "Invalid protocol" });
      }

      const normalizedUrl = normalizeUrl(url.href);

      if (isKnownStablePscUrl(normalizedUrl)) {
        return res.json({ valid: true, status: 200 });
      }

      if (normalizedUrl.includes("edocket.dcpsc.org")) {
        const result = await verifyEdocketUrl(normalizedUrl);
        return res.json({
          valid: result.isValid,
          status: result.isValid ? 200 : 404,
          fallbackUrl: result.repairUrl || EDOCKET_CASE_SEARCH_URL
        });
      }

      if (isOfficialPscUrl(normalizedUrl)) {
        const isLive = await checkUrlLive(normalizedUrl);
        return res.json({
          valid: isLive,
          status: isLive ? 200 : 404,
          fallbackUrl: DC_PSC_NEWSROOM_URL
        });
      }

      // 1. Establish short AbortController for first quick HEAD request attempt
      const headController = new AbortController();
      const headTimeout = setTimeout(() => headController.abort(), 3500);

      try {
        const headResponse = await fetch(url.href, {
          method: "HEAD",
          signal: headController.signal,
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
          }
        });
        clearTimeout(headTimeout);

        // Standard 2xx or 3xx responses are valid
        if (headResponse.ok) {
          return res.json({ valid: true, status: headResponse.status });
        }
      } catch (headErr) {
        // Fall back to complete GET request on failure
      }

      // 2. GET request fallback with standard user agent and a 4-second timeout limit
      const getController = new AbortController();
      const getTimeout = setTimeout(() => getController.abort(), 4000);

      const getResponse = await fetch(url.href, {
        method: "GET",
        signal: getController.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
        }
      });
      clearTimeout(getTimeout);

      return res.json({
        valid: getResponse.ok,
        status: getResponse.status
      });

    } catch (error: any) {
      console.log(`Link validation error for ${urlParam}:`, error?.message || "unreachable");
      return res.json({
        valid: false,
        error: error?.message || "Verification failed"
      });
    }
  });

  // Serve static assets based on environment mode
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server launched successfully on port ${PORT}`);
  });
}

startServer();
