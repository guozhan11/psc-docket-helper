// The Render service predates the move to Cloudflare Workers, when it ran the
// Express implementation in server.ts. That file is gone, and reviving it would
// restore a second copy of the assistant that has no retrieval index, no
// Turnstile, and no rate limiting — one that answers from the model alone.
//
// The URL is still linked from older material, so it stays up and sends every
// visitor to the Worker instead. Permanent, because the move is not provisional:
// crawlers should attribute the old address to the canonical one.
import { createServer } from "node:http";

const CANONICAL = (
  process.env.CANONICAL_URL ??
  "https://psc-docket-assistant.psc-docket-helper.workers.dev"
).replace(/\/+$/, "");

// Render's health check wants a 200, which a redirect never gives it.
const HEALTH_PATH = "/healthz";

const server = createServer((request, response) => {
  let target;
  try {
    const incoming = new URL(request.url ?? "/", "http://placeholder");
    if (incoming.pathname === HEALTH_PATH) {
      response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("ok\n");
      return;
    }
    // Re-serialised through URL, so nothing from the request reaches the
    // Location header unencoded.
    target = new URL(incoming.pathname + incoming.search, CANONICAL).toString();
  } catch {
    target = CANONICAL + "/";
  }

  response.writeHead(301, {
    Location: target,
    "Cache-Control": "public, max-age=3600",
    "Content-Type": "text/html; charset=utf-8",
  });
  response.end(
    request.method === "HEAD"
      ? undefined
      : `<!doctype html><meta charset="utf-8"><title>Moved</title>` +
          `<p>The DC PSC Docket Assistant has moved to ` +
          `<a href="${target}">${target}</a>.</p>`,
  );
});

const port = Number(process.env.PORT ?? 3000);
server.listen(port, "0.0.0.0", () => {
  console.log(`Redirecting every request to ${CANONICAL} (port ${port})`);
});
