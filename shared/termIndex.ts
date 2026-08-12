/**
 * Term-partitioned inverted index shared by the builder and the Worker.
 *
 * The case router answers "which cases contain these terms?" by testing every
 * case, which costs O(cases) per question and forced a one-partition sample.
 * This index stores the answer directly: term -> the cases containing it. A
 * question then costs O(terms), so it can scan the whole corpus.
 *
 * Terms are assigned to shards by hash, so a question reads only the shards for
 * its own terms. scripts/build_term_index.py mirrors these functions; the
 * cross-language agreement is covered by scripts/test_term_index.py.
 */
export const TERM_INDEX_VERSION = 1;
export const TERM_INDEX_SHARDS = 4096;
export const TERM_INDEX_KEY = `term-index/v${TERM_INDEX_VERSION}/index.json`;

/**
 * Terms in more than this share of cases are kept only as a document-frequency
 * entry, with no posting list. "commission" appears in ~97% of DC PSC filings:
 * its postings would be a large fraction of the index while its IDF is near
 * zero, so it can never discriminate between cases.
 */
export const TERM_INDEX_MAX_DOCUMENT_FREQUENCY = 0.15;

export interface TermIndexManifest {
  version: number;
  generation: string;
  updatedAt: string;
  complete: boolean;
  activeSlot: "a" | "b";
  shardCount: number;
  cases: number;
  terms: number;
  postings: number;
  compressedBytes: number;
  shardKeyPrefix: string;
}

/** One shard: term -> document frequency and the cases holding it. */
export interface TermIndexShard {
  version: number;
  generation: string;
  shardIndex: number;
  shardCount: number;
  /**
   * term -> [documentFrequency, ...caseNumbers]. A term above the frequency
   * cap stores its frequency with no case list, so IDF still works while the
   * postings stay out of the index.
   */
  terms: Record<string, [number, ...string[]]>;
}

/** FNV-1a. Matches term_shard() in scripts/build_term_index.py. */
export function termShard(term: string, shardCount = TERM_INDEX_SHARDS): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < term.length; index += 1) {
    hash = Math.imul(hash ^ term.charCodeAt(index), 0x01000193) >>> 0;
  }
  return hash % shardCount;
}

export function termIndexShardKey(slot: string, shardIndex: number, shardCount = TERM_INDEX_SHARDS): string {
  const width = String(shardCount - 1).length;
  return `term-index/v${TERM_INDEX_VERSION}/slots/${slot}/shard-${String(shardIndex).padStart(width, "0")}.json.gz`;
}

/**
 * Inverse document frequency, smoothed. A term in nearly every case scores
 * near zero; a rare term dominates. This is what the Bloom router could not
 * do — it counted every term hit as one point, so a question whose terms were
 * mostly common words left a large block of cases tied at the top.
 */
export function inverseDocumentFrequency(documentFrequency: number, totalCases: number): number {
  if (documentFrequency <= 0 || totalCases <= 0) return 0;
  return Math.max(0, Math.log((totalCases + 1) / (documentFrequency + 1)));
}
