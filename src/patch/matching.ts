import type { MatchStrategy, PatchMatch } from "./source.ts";

// Corrected-match ceilings mirror targeted edits; exact matching has no size ceiling.
const FUZZY_PATTERN_BYTES = 64 * 1024;
const FUZZY_PATTERN_LINES = 200;
const FUZZY_CONTENT_CHARS = 1_000_000;
const FUZZY_CONTENT_LINES = 50_000;
const FUZZY_WORK = 2_000_000;

const trimEnd = (text: string): string => text.replace(/\p{White_Space}+$/u, "");
const trim = (text: string): string => text.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
function typography(text: string): string {
  return trim(text)
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[\u2018-\u201b]/g, "'")
    .replace(/[\u201c-\u201f]/g, '"')
    .replace(/[\u00a0\u2002-\u200a\u202f\u205f\u3000]/g, " ");
}

function prefixTable(pattern: readonly string[]): Uint32Array {
  const prefix = new Uint32Array(pattern.length);
  for (let i = 1, j = 0; i < pattern.length; i++) {
    while (j > 0 && pattern[i] !== pattern[j]) {
      j = prefix[j - 1];
    }
    if (pattern[i] === pattern[j]) {
      j++;
    }
    prefix[i] = j;
  }
  return prefix;
}

/** KMP keeps repeated, long exact context linear; two hits suffice to prove ambiguity. */
function occurrences(
  source: readonly string[],
  pattern: readonly string[],
  start: number,
  eof: boolean,
): number[] {
  const prefix = prefixTable(pattern);
  const found: number[] = [];
  const first = eof ? Math.max(start, source.length - pattern.length) : start;
  for (let i = first, j = 0; i < source.length; i++) {
    while (j > 0 && source[i] !== pattern[j]) {
      j = prefix[j - 1];
    }
    if (source[i] === pattern[j]) {
      j++;
    }
    if (j === pattern.length) {
      found.push(i - pattern.length + 1);
      if (found.length === 2) {
        break;
      }
      j = prefix[j - 1];
    }
  }
  return found;
}

interface MatchScope {
  readonly start: number;
  readonly eof: boolean;
  readonly scopedChars: number;
  readonly label: string;
}
interface NormalizationPass {
  readonly normalize: (text: string) => string;
  readonly strategy: MatchStrategy;
}
export interface ContextMatch extends PatchMatch {
  readonly includesBom: boolean;
}
const passes: readonly NormalizationPass[] = [
  { normalize: (text) => text, strategy: "exact" },
  { normalize: trimEnd, strategy: "whitespace" },
  { normalize: trim, strategy: "whitespace" },
  { normalize: typography, strategy: "typography" },
];

/** Immutable source and explicit suffix scope keep anchors and chunk context consistent. */
export class PatchMatcher {
  readonly #source: readonly string[];
  readonly #hasBom: boolean;

  constructor(source: readonly string[], hasBom: boolean) {
    this.#source = source;
    this.#hasBom = hasBom;
  }

  find(pattern: readonly string[], scope: MatchScope): ContextMatch {
    const fuzzyAllowed = this.fuzzyAllowed(pattern, scope);
    for (const pass of passes) {
      if (pass.strategy !== "exact" && !fuzzyAllowed) {
        break;
      }
      const candidates = this.candidates(pattern, scope, pass);
      const includesBom = this.matchesBom(pattern, scope, pass) && !candidates.includes(0);
      if (includesBom) {
        candidates.unshift(0);
      }
      if (candidates.length > 1) {
        throw new Error(
          `Ambiguous ${scope.label}: matches at lines ${candidates.map((line) => line + 1).join(", ")}. Add unique anchors or surrounding context.`,
        );
      }
      if (candidates.length === 1) {
        return { line: candidates[0] + 1, strategy: pass.strategy, includesBom };
      }
    }
    const location = scope.eof ? " at end of file" : " after the preceding chunk/anchor";
    const budget = fuzzyAllowed
      ? ""
      : " Corrected matching exceeded its work budget; use exact context.";
    throw new Error(`Could not find ${scope.label}${location}.${budget}`);
  }

  private fuzzyAllowed(pattern: readonly string[], scope: MatchScope): boolean {
    return (
      pattern.length <= FUZZY_PATTERN_LINES &&
      Buffer.byteLength(pattern.join("\n")) <= FUZZY_PATTERN_BYTES &&
      this.#source.length - scope.start <= FUZZY_CONTENT_LINES &&
      scope.scopedChars <= FUZZY_CONTENT_CHARS &&
      scope.scopedChars * pattern.length <= FUZZY_WORK
    );
  }

  private candidates(
    pattern: readonly string[],
    scope: MatchScope,
    pass: NormalizationPass,
  ): number[] {
    if (pass.strategy === "exact") {
      return occurrences(this.#source, pattern, scope.start, scope.eof);
    }
    return occurrences(
      this.#source.slice(scope.start).map(pass.normalize),
      pattern.map(pass.normalize),
      0,
      scope.eof,
    ).map((line) => line + scope.start);
  }

  private matchesBom(
    pattern: readonly string[],
    scope: MatchScope,
    pass: NormalizationPass,
  ): boolean {
    // Count a verbatim first-line BOM boundary match alongside literal interior matches.
    return (
      this.#hasBom &&
      scope.start === 0 &&
      pattern[0].startsWith("\uFEFF") &&
      pattern.length <= this.#source.length &&
      (!scope.eof || pattern.length === this.#source.length) &&
      pattern.every(
        (line, index) =>
          pass.normalize(index === 0 ? line.slice(1) : line) ===
          pass.normalize(this.#source[index]),
      )
    );
  }
}
