export const TERM_FILTER_BYTES = 2048;
export const TERM_FILTER_HASHES = 5;

export function tokenizeForFilter(value: string): string[] {
  return value.toLowerCase().match(/[a-z0-9][a-z0-9'-]{1,39}/g) ?? [];
}

function hashPair(term: string): [number, number] {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < term.length; index += 1) {
    const code = term.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second ^= code + 0x9e3779b9 + (second << 6) + (second >>> 2);
    second >>>= 0;
  }
  return [first, second | 1];
}

function bitIndexes(term: string, byteLength: number): number[] {
  const bitLength = byteLength * 8;
  const [first, second] = hashPair(term);
  return Array.from({ length: TERM_FILTER_HASHES }, (_, index) =>
    (first + Math.imul(index, second) + Math.imul(index, index)) >>> 0
  ).map(hash => hash % bitLength);
}

export function createTermFilter(value: string, byteLength = TERM_FILTER_BYTES): Uint8Array {
  const filter = new Uint8Array(byteLength);
  for (const term of new Set(tokenizeForFilter(value))) {
    for (const bit of bitIndexes(term, byteLength)) filter[bit >>> 3] |= 1 << (bit & 7);
  }
  return filter;
}

export function termMayExist(filter: Uint8Array, term: string): boolean {
  if (!filter.byteLength) return false;
  return bitIndexes(term.toLowerCase(), filter.byteLength)
    .every(bit => (filter[bit >>> 3] & (1 << (bit & 7))) !== 0);
}

export function filterToSqlBlob(filter: Uint8Array): string {
  return `X'${Array.from(filter, byte => byte.toString(16).padStart(2, "0")).join("")}'`;
}
