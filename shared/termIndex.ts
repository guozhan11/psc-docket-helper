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

/**
 * How posting lists encode their cases.
 *
 * "case" lists case numbers only. It cannot rank within a match set: IDF is a
 * per-term constant, so every case holding the same terms scores identically
 * and the order falls back to whatever the tie-break is.
 *
 * "case-tf" interleaves each case with the number of its documents containing
 * the term, which separates a case that discusses a topic throughout from one
 * that mentions it once — but it rewards size on its own, so the largest docket
 * in the corpus led most questions regardless of what was asked.
 *
 * "case-bm25" stores a weight that already divides the term count by how large
 * the case is, so a mid-sized case discussing a topic throughout outranks a
 * two-thousand-filing docket that mentions it in passing.
 */
export type TermPostingFormat = "case" | "case-tf" | "case-bm25";

/**
 * Scale used to store a BM25 term weight as an integer, keeping the wire format
 * to plain interleaved numbers.
 */
export const BM25_WEIGHT_SCALE = 100;

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
  /** Absent on the first published generation, which was "case". */
  postingFormat?: TermPostingFormat;
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
  terms: Record<string, [number, ...(string | number)[]]>;
  postingFormat?: TermPostingFormat;
}

/**
 * Reduces a word to a stem that is also a prefix of its inflections.
 *
 * The prefix property is what makes this safe here: excerpts are verified by
 * plain substring match against page text, so a stem like "disconnect" matches
 * "disconnection", "disconnections" and "disconnected" without the verifier
 * needing to know anything about morphology. A stemmer that rewrote letters
 * ("companies" to "compani") would break that and leave routed cases failing
 * verification with nothing to show.
 *
 * Deliberately conservative: only suffixes that strip cleanly, and never below
 * a stem length where the remainder stops being a word.
 */
export const MIN_STEM_LENGTH = 5;
/**
 * Derivational endings remove more letters than plural or tense endings, so
 * they need more left over to stay meaningful. Stripping "-ation" at the
 * inflectional threshold turned "generation" into "gener", which substring-
 * matches "general" — a word on nearly every page of a legal filing, and a
 * ruinous match for a corpus about electricity generation.
 */
export const MIN_DERIVED_STEM_LENGTH = 7;

const INFLECTIONAL_SUFFIXES = ["ing", "ed", "es", "s"] as const;
const DERIVATIONAL_SUFFIXES = ["ations", "ation", "ions", "ion"] as const;

export function stemTerm(term: string): string {
  const word = term.toLowerCase();
  if (word.length <= MIN_STEM_LENGTH) return word;
  // A possessive is not a plural: stripping its "s" leaves a dangling
  // apostrophe rather than a word.
  if (word.endsWith("'s")) return word;
  for (const suffix of DERIVATIONAL_SUFFIXES) {
    if (!word.endsWith(suffix)) continue;
    const stem = word.slice(0, word.length - suffix.length);
    if (stem.length >= MIN_DERIVED_STEM_LENGTH) return stem;
  }
  for (const suffix of INFLECTIONAL_SUFFIXES) {
    if (!word.endsWith(suffix)) continue;
    const stem = word.slice(0, word.length - suffix.length);
    if (stem.length >= MIN_STEM_LENGTH) return stem;
  }
  return word;
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

/**
 * Sublinear term frequency. A case with twenty filings on a topic outranks one
 * with two, but not ten times over — filing counts vary for reasons unrelated
 * to how central the topic is.
 */
export function termFrequencyWeight(documentsWithTerm: number): number {
  if (documentsWithTerm <= 0) return 0;
  return 1 + Math.log(documentsWithTerm);
}

/**
 * Walks a posting list in any published format, yielding each case with the
 * weight its stored number represents. Older generations stay readable so a
 * rebuild is never a prerequisite for deploying.
 */
export function* postingEntries(
  entry: readonly (string | number)[],
  format: TermPostingFormat
): Generator<{ caseNumber: string; weight: number }> {
  const body = entry.slice(1);
  if (format === "case-tf" || format === "case-bm25") {
    for (let index = 0; index + 1 < body.length; index += 2) {
      const caseNumber = body[index];
      const value = Number(body[index + 1]);
      if (typeof caseNumber !== "string" || !Number.isFinite(value)) continue;
      yield {
        caseNumber,
        weight: format === "case-bm25"
          ? value / BM25_WEIGHT_SCALE
          : termFrequencyWeight(value)
      };
    }
    return;
  }
  for (const caseNumber of body) {
    if (typeof caseNumber === "string") yield { caseNumber, weight: 1 };
  }
}
