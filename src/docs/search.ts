import type { DocSection, RouterOsVersion } from "./corpus.ts";

export interface SearchHit {
  section: DocSection;
  score: number;
}

/**
 * Split text into search terms.
 *
 * RouterOS commands are full of '/' and '-', so a plain word split loses the
 * structure. Paths are broken into their segments and hyphenated words are
 * indexed whole and in parts, which lets "address list" find "address-list"
 * and "ip firewall" find "/ip/firewall/filter".
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9/_-]+/)) {
    if (!raw) continue;
    for (const part of raw.split("/")) {
      if (!part) continue;
      tokens.push(part);
      if (part.includes("-")) tokens.push(...part.split("-").filter(Boolean));
    }
  }
  return tokens;
}

// BM25 constants: standard defaults, adequate for a corpus of this size.
const K1 = 1.5;
const B = 0.75;

/** A heading match is worth several body mentions. */
const HEADING_WEIGHT = 3;

/**
 * Per-document metadata — title and tags — is identical for every section of
 * that document, so it cannot tell those sections apart. It is added as a flat
 * bonus rather than mixed into the scored text: folding it in would inflate
 * every section of a matching document equally, and BM25 length
 * normalisation would then simply pick the shortest one.
 */
const METADATA_BONUS = 0.75;

function scoredTokens(section: DocSection): string[] {
  const heading = tokenize(section.heading);
  const tokens = tokenize(section.body);
  for (let i = 0; i < HEADING_WEIGHT; i++) tokens.push(...heading);
  return tokens;
}

function metadataTerms(section: DocSection): Set<string> {
  return new Set([...tokenize(section.docTitle), ...tokenize(section.tags.join(" "))]);
}

/**
 * Rank sections against a query with BM25.
 *
 * Deliberately dependency-free and rebuilt per call — the corpus is a handful
 * of files, so there is nothing to gain from an embedding model or a cached
 * index, and plenty to lose in statelessness.
 */
export function searchDocs(
  sections: DocSection[],
  query: string,
  options: { version?: RouterOsVersion; limit?: number } = {},
): SearchHit[] {
  const candidates = options.version
    ? sections.filter((s) => s.versions.includes(options.version as RouterOsVersion))
    : sections;
  if (candidates.length === 0) return [];

  const docs = candidates.map(scoredTokens);
  const lengths = docs.map((d) => d.length);
  const averageLength = lengths.reduce((a, b) => a + b, 0) / docs.length;

  const frequencies = docs.map((tokens) => {
    const counts = new Map<string, number>();
    for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
    return counts;
  });

  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0) return [];

  const scores = new Array<number>(candidates.length).fill(0);

  // Doc-level metadata: a flat, length-independent nudge toward the right document.
  const metadata = candidates.map(metadataTerms);
  for (let i = 0; i < candidates.length; i++) {
    const matched = terms.filter((t) => metadata[i]?.has(t)).length;
    if (matched > 0) scores[i] = (scores[i] ?? 0) + (METADATA_BONUS * matched) / terms.length;
  }

  for (const term of terms) {
    const containing = frequencies.reduce((n, counts) => n + (counts.has(term) ? 1 : 0), 0);
    if (containing === 0) continue;

    // BM25 idf, floored so a term present everywhere still contributes nothing
    // negative rather than pushing scores down.
    const idf = Math.max(
      0,
      Math.log((candidates.length - containing + 0.5) / (containing + 0.5) + 1),
    );

    for (let i = 0; i < candidates.length; i++) {
      const frequency = frequencies[i]?.get(term) ?? 0;
      if (frequency === 0) continue;
      const norm = 1 - B + (B * (lengths[i] ?? 0)) / (averageLength || 1);
      scores[i] = (scores[i] ?? 0) + idf * ((frequency * (K1 + 1)) / (frequency + K1 * norm));
    }
  }

  return candidates
    .map((section, i) => ({ section, score: scores[i] ?? 0 }))
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score || a.section.heading.localeCompare(b.section.heading))
    .slice(0, options.limit ?? 5);
}
