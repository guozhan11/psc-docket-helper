import assert from "node:assert/strict";
import test from "node:test";

import { redirectTarget } from "./render-redirect.mjs";

const CANONICAL = "https://psc-docket-assistant.psc-docket-helper.workers.dev";

test("redirects ordinary paths and query strings to the canonical site", () => {
  assert.equal(
    redirectTarget("/docket-chat?q=FC1176", CANONICAL),
    `${CANONICAL}/docket-chat?q=FC1176`,
  );
});

test("a normalised double-slash path cannot replace the canonical origin", () => {
  const target = new URL(redirectTarget("/a/..//example.com/phish", CANONICAL));
  assert.equal(target.origin, CANONICAL);
  assert.equal(target.pathname, "//example.com/phish");
});
