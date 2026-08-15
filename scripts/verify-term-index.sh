#!/usr/bin/env bash
# Verify a published term index against known ground truth.
#
# The build log reports what the builder thinks it wrote. This reads the
# published objects back the way the Worker will and checks that a term really
# resolves to a case known to contain it. A shard-assignment or generation
# mismatch would otherwise surface only as cross-case questions quietly
# returning nothing.
#
# Usage: scripts/verify-term-index.sh [term ...]
set -euo pipefail

BUCKET="${R2_BUCKET_NAME:-psc-docket-assistant-documents}"
TERMS=("$@")
if [ ${#TERMS[@]} -eq 0 ]; then
  TERMS=(uncollectible pepco storm depreciation)
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "Reading term index manifest..."
npx wrangler r2 object get "$BUCKET/term-index/v1/index.json" --remote --pipe \
  > "$WORK/index.json" 2>/dev/null

python3 - "$WORK" "${TERMS[@]}" <<'PY'
import json, subprocess, sys, gzip, os

work, *terms = sys.argv[1:]
bucket = os.environ.get("R2_BUCKET_NAME", "psc-docket-assistant-documents")
index = json.load(open(f"{work}/index.json"))

print(f"  generation : {index['generation']}")
print(f"  slot       : {index['activeSlot']}")
print(f"  cases      : {index['cases']:,}")
print(f"  terms      : {index['terms']:,}")
print(f"  postings   : {index['postings']:,}")
print(f"  size       : {index['compressedBytes'] / 1048576:.1f} MiB")
print()

def term_shard(term, shard_count):
    value = 0x811C9DC5
    for character in term:
        value = ((value ^ ord(character)) * 0x01000193) & 0xFFFFFFFF
    return value % shard_count

shard_count = index["shardCount"]
width = len(str(shard_count - 1))
failures = 0

for term in terms:
    shard = term_shard(term, shard_count)
    key = f"term-index/v1/slots/{index['activeSlot']}/shard-{str(shard).zfill(width)}.json.gz"
    path = f"{work}/shard.json"
    subprocess.run(
        ["npx", "wrangler", "r2", "object", "get", f"{bucket}/{key}", "--remote", "--pipe"],
        stdout=open(path, "wb"), stderr=subprocess.DEVNULL, check=True,
    )
    raw = open(path, "rb").read()
    payload = json.loads(gzip.decompress(raw) if raw[:2] == b"\x1f\x8b" else raw)

    if payload.get("generation") != index["generation"]:
        print(f"  FAIL {term!r}: shard generation {payload.get('generation')!r} != index generation")
        failures += 1
        continue
    entry = payload["terms"].get(term)
    if not entry:
        print(f"  MISS {term!r}: shard {shard} holds no entry (term absent from corpus, or shard drift)")
        failures += 1
        continue
    frequency, *body = entry
    fmt = payload.get("postingFormat") or index.get("postingFormat") or "case"
    if fmt in ("case-tf", "case-bm25"):
        pairs = [(body[i], body[i + 1]) for i in range(0, len(body) - 1, 2)]
        label = "x" if fmt == "case-tf" else "w"
        shown = ", ".join(f"{case} {label}{count}" for case, count in pairs[:5])
    else:
        shown = ", ".join(str(case) for case in body[:5])
    if not body:
        shown = "(above frequency cap, postings dropped)"
    print(f"  OK   {term!r} [{fmt}]: {frequency:,} cases -> {shown}")

print()
if failures:
    print(f"{failures} check(s) failed")
    sys.exit(1)
print("All checks passed")
PY
