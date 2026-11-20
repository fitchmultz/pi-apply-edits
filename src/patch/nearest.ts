import { diceSimilarityTo, normalizeForSimilarity } from "../editing/similarity.ts";

const MAX_SCOPE_LINES = 50_000;
const MAX_SCOPED_CHARS = 2_000_000;
const MAX_PATTERN_LINES = 64;
const MAX_PATTERN_BYTES = 8 * 1024;
const MAX_LINE_CHARS = 512;
const MIN_SIMILARITY = 0.4;
const TOP_CANDIDATES = 12;
const EXCERPT_LINES = 8;

const MAX_FEATURES = 64;
const MAX_LINE_FEATURES = 32;
const MAX_OFFSETS_PER_FEATURE = 4;
const MIN_TOKENS_FOR_TRIGRAMS = 4;
const WHOLE_LINE_WEIGHT = 4;
const TOKEN_WEIGHT = 1;
const TRIGRAM_WEIGHT = 0.5;
const WORD_TOKEN_PATTERN = /[\p{L}\p{N}_]{2,}/gu;
const ALNUM_PATTERN = /[\p{L}\p{N}]/u;

export interface NearestScope {
  readonly start: number;
  readonly eof: boolean;
  readonly scopedChars: number;
}

export interface NearestMatchWindow {
  readonly start: number;
  readonly end: number;
  readonly matchStart: number;
  readonly matchEnd: number;
  readonly score: number;
}

interface FeatureEntry {
  readonly key: string;
  readonly offsets: number[];
  count: number;
}

interface FeatureIndex {
  readonly lines: ReadonlyMap<string, readonly number[]>;
  readonly tokens: ReadonlyMap<string, readonly number[]>;
  readonly trigrams: ReadonlyMap<string, readonly number[]>;
}

interface PeakCandidate {
  readonly index: number;
  readonly score: number;
}

interface ScoredWindow {
  readonly absStart: number;
  readonly score: number;
  readonly normWindow: readonly string[];
}

function normalizeClippedLine(line: string): string {
  return normalizeForSimilarity(line.slice(0, MAX_LINE_CHARS));
}

function trimTrailingEmpty(pattern: readonly string[]): readonly string[] {
  let end = pattern.length;
  while (end > 0 && pattern[end - 1] === "") {
    end--;
  }
  return end === pattern.length ? pattern : pattern.slice(0, end);
}

function recordFeature(target: Map<string, FeatureEntry>, key: string, offset: number): void {
  const existing = target.get(key);
  if (existing !== undefined) {
    existing.count++;
    if (existing.offsets.length < MAX_OFFSETS_PER_FEATURE) {
      existing.offsets.push(offset);
    }
    return;
  }
  target.set(key, { key, offsets: [offset], count: 1 });
}

function compareFeatureEntries(left: FeatureEntry, right: FeatureEntry): number {
  if (left.count !== right.count) {
    return left.count - right.count;
  }
  if (left.key.length !== right.key.length) {
    return right.key.length - left.key.length;
  }
  return (left.offsets[0] ?? 0) - (right.offsets[0] ?? 0);
}

function selectFeatures(
  raw: ReadonlyMap<string, FeatureEntry>,
  limit: number,
): Map<string, readonly number[]> {
  const selected = new Map<string, readonly number[]>();
  if (limit <= 0) {
    return selected;
  }
  const sorted = [...raw.values()].sort(compareFeatureEntries);
  for (const entry of sorted.slice(0, limit)) {
    selected.set(entry.key, entry.offsets);
  }
  return selected;
}

function recordTrigrams(
  text: string,
  offset: number,
  seen: Set<string>,
  target: Map<string, FeatureEntry>,
): boolean {
  let added = false;
  for (let index = 0; index <= text.length - 3; index++) {
    const tri = text.slice(index, index + 3);
    if (!seen.has(tri)) {
      seen.add(tri);
      recordFeature(target, tri, offset);
      added = true;
    }
  }
  return added;
}

function collectLineTrigrams(
  lower: string,
  offset: number,
  target: Map<string, FeatureEntry>,
): void {
  const seen = new Set<string>();
  let addedFromTokens = false;
  for (const match of lower.matchAll(WORD_TOKEN_PATTERN)) {
    if (recordTrigrams(match[0], offset, seen, target)) {
      addedFromTokens = true;
    }
  }
  if (!addedFromTokens) {
    recordTrigrams(lower, offset, seen, target);
  }
}

function collectLineTokens(lower: string, offset: number, target: Map<string, FeatureEntry>): void {
  const seen = new Set<string>();
  for (const match of lower.matchAll(WORD_TOKEN_PATTERN)) {
    const token = match[0];
    if (!seen.has(token)) {
      seen.add(token);
      recordFeature(target, token, offset);
    }
  }
}

function buildFeatureIndex(normPattern: readonly string[]): FeatureIndex {
  const rawLines = new Map<string, FeatureEntry>();
  const rawTokens = new Map<string, FeatureEntry>();
  const lowered: string[] = [];
  for (let offset = 0; offset < normPattern.length; offset++) {
    const lower = (normPattern[offset] ?? "").toLowerCase();
    lowered.push(lower);
    if (lower.length === 0) {
      continue;
    }
    recordFeature(rawLines, lower, offset);
    collectLineTokens(lower, offset, rawTokens);
  }
  const reservedForTokens = Math.min(rawTokens.size, MAX_FEATURES - MAX_LINE_FEATURES);
  const lines = selectFeatures(rawLines, MAX_FEATURES - reservedForTokens);
  const tokens = selectFeatures(rawTokens, MAX_FEATURES - lines.size);
  const rawTrigrams = new Map<string, FeatureEntry>();
  if (rawTokens.size < MIN_TOKENS_FOR_TRIGRAMS) {
    for (let offset = 0; offset < lowered.length; offset++) {
      const lower = lowered[offset] ?? "";
      if (lower.length > 0) {
        collectLineTrigrams(lower, offset, rawTrigrams);
      }
    }
  }
  const trigrams = selectFeatures(rawTrigrams, MAX_FEATURES - lines.size - tokens.size);
  return { lines, tokens, trigrams };
}

function accumulateVotes(
  source: readonly string[],
  scopeStart: number,
  scopeLen: number,
  index: FeatureIndex,
): Float32Array {
  const votes = new Float32Array(scopeLen);
  const seenTokens = new Set<string>();
  const seenTrigrams = new Set<string>();
  const add = (lineIndex: number, offsets: readonly number[] | undefined, weight: number): void => {
    if (offsets === undefined) {
      return;
    }
    for (const offset of offsets) {
      const target = lineIndex - offset;
      if (target >= 0) {
        votes[target] = (votes[target] ?? 0) + weight;
      }
    }
  };
  const voteTokens = (lineIndex: number, lower: string): void => {
    if (seenTokens.size > 0) {
      seenTokens.clear();
    }
    for (const match of lower.matchAll(WORD_TOKEN_PATTERN)) {
      const token = match[0];
      const offsets = index.tokens.get(token);
      if (offsets !== undefined && !seenTokens.has(token)) {
        seenTokens.add(token);
        add(lineIndex, offsets, TOKEN_WEIGHT);
      }
    }
  };
  const voteTrigrams = (lineIndex: number, lower: string): void => {
    if (seenTrigrams.size > 0) {
      seenTrigrams.clear();
    }
    for (let pos = 0; pos <= lower.length - 3; pos++) {
      const tri = lower.slice(pos, pos + 3);
      const offsets = index.trigrams.get(tri);
      if (offsets !== undefined && !seenTrigrams.has(tri)) {
        seenTrigrams.add(tri);
        add(lineIndex, offsets, TRIGRAM_WEIGHT);
      }
    }
  };
  const scanTokens = index.tokens.size > 0;
  const scanTrigrams = index.trigrams.size > 0;
  for (let lineIndex = 0; lineIndex < scopeLen; lineIndex++) {
    const lower = normalizeClippedLine(source[scopeStart + lineIndex] ?? "").toLowerCase();
    if (lower.length === 0) {
      continue;
    }
    add(lineIndex, index.lines.get(lower), WHOLE_LINE_WEIGHT);
    if (scanTokens) {
      voteTokens(lineIndex, lower);
    }
    if (scanTrigrams) {
      voteTrigrams(lineIndex, lower);
    }
  }
  return votes;
}

function insertPeak(peaks: PeakCandidate[], candidate: PeakCandidate): number {
  let pos = peaks.length;
  while (pos > 0 && candidate.score > (peaks[pos - 1]?.score ?? 0)) {
    pos--;
  }
  peaks.splice(pos, 0, candidate);
  if (peaks.length > TOP_CANDIDATES) {
    peaks.pop();
  }
  return peaks.length === TOP_CANDIDATES ? (peaks[TOP_CANDIDATES - 1]?.score ?? 0) : 0;
}

function selectTopCandidates(votes: Float32Array): readonly PeakCandidate[] {
  const peaks: PeakCandidate[] = [];
  let threshold = 0;
  for (let index = 0; index < votes.length; index++) {
    const score = votes[index] ?? 0;
    if (score > threshold) {
      threshold = insertPeak(peaks, { index, score });
    }
  }
  return peaks;
}

function expandCandidates(peaks: readonly PeakCandidate[], maxStart: number): readonly number[] {
  const unique = new Set<number>();
  for (const peak of peaks) {
    for (const delta of [-1, 0, 1]) {
      unique.add(Math.max(0, Math.min(maxStart, peak.index + delta)));
    }
  }
  return [...unique].sort((left, right) => left - right);
}

function bigramOverlap(left: string, right: string, score: number): number {
  if (left === right) {
    return Math.max(0, left.length - 1);
  }
  if (left.length < 2 || right.length < 2) {
    return 0;
  }
  return Math.round((score * (left.length + right.length - 2)) / 2);
}

function hasExactNormalizedLine(
  normPattern: readonly string[],
  normWindow: readonly string[],
): boolean {
  for (let index = 0; index < normWindow.length; index++) {
    const line = normPattern[index] ?? "";
    if (line.length > 0 && line === normWindow[index] && ALNUM_PATTERN.test(line)) {
      return true;
    }
  }
  return false;
}

function findBestWindow(
  source: readonly string[],
  normPattern: readonly string[],
  candidates: readonly number[],
  scopeStart: number,
): ScoredWindow | undefined {
  const wantedText = normPattern.filter((line) => line.length > 0).join(" ");
  const similarity = diceSimilarityTo(wantedText);
  const windowLen = Math.min(normPattern.length, source.length - scopeStart);
  let best: ScoredWindow | undefined;
  for (const relStart of candidates) {
    const absStart = scopeStart + relStart;
    const normWindow: string[] = [];
    for (let offset = 0; offset < windowLen; offset++) {
      normWindow.push(normalizeClippedLine(source[absStart + offset] ?? ""));
    }
    const windowText = normWindow.filter((line) => line.length > 0).join(" ");
    const score = similarity(windowText);
    if (score < MIN_SIMILARITY) {
      continue;
    }
    if (
      bigramOverlap(wantedText, windowText, score) < 2 &&
      !hasExactNormalizedLine(normPattern, normWindow)
    ) {
      continue;
    }
    if (best === undefined || score > best.score) {
      best = { absStart, score, normWindow };
    }
  }
  return best;
}

function firstDifferingOffset(
  source: readonly string[],
  pattern: readonly string[],
  normPattern: readonly string[],
  best: ScoredWindow,
): number {
  for (let offset = 0; offset < best.normWindow.length; offset++) {
    if (best.normWindow[offset] !== normPattern[offset]) {
      return offset;
    }
  }
  for (let offset = 0; offset < best.normWindow.length; offset++) {
    if (source[best.absStart + offset] !== pattern[offset]) {
      return offset;
    }
  }
  return 0;
}

function buildWindowResult(
  source: readonly string[],
  pattern: readonly string[],
  normPattern: readonly string[],
  best: ScoredWindow,
): NearestMatchWindow {
  const windowLen = best.normWindow.length;
  const matchStart = best.absStart;
  const matchEnd = matchStart + windowLen;
  if (windowLen <= EXCERPT_LINES) {
    return { start: matchStart, end: matchEnd, matchStart, matchEnd, score: best.score };
  }
  const diff = firstDifferingOffset(source, pattern, normPattern, best);
  const start = matchStart + Math.max(0, Math.min(diff - 2, windowLen - EXCERPT_LINES));
  const end = Math.min(source.length, start + EXCERPT_LINES);
  return { start, end, matchStart, matchEnd, score: best.score };
}

function isWithinScopeBounds(scopeLen: number, scope: NearestScope): boolean {
  return (
    !scope.eof &&
    scope.start >= 0 &&
    scopeLen > EXCERPT_LINES &&
    scopeLen <= MAX_SCOPE_LINES &&
    scope.scopedChars <= MAX_SCOPED_CHARS
  );
}

function preparePattern(
  pattern: readonly string[],
): { readonly effective: readonly string[]; readonly normalized: readonly string[] } | undefined {
  const effective = trimTrailingEmpty(pattern);
  if (
    effective.length === 0 ||
    effective.length > MAX_PATTERN_LINES ||
    Buffer.byteLength(effective.join("\n")) > MAX_PATTERN_BYTES
  ) {
    return undefined;
  }
  const normalized = effective.map(normalizeClippedLine);
  if (!normalized.some((line) => line.length > 0)) {
    return undefined;
  }
  return { effective, normalized };
}

export function findNearestScopeWindow(
  source: readonly string[],
  pattern: readonly string[],
  scope: NearestScope,
): NearestMatchWindow | undefined {
  const scopeLen = source.length - scope.start;
  if (!isWithinScopeBounds(scopeLen, scope)) {
    return undefined;
  }
  const prepared = preparePattern(pattern);
  if (prepared === undefined) {
    return undefined;
  }
  const index = buildFeatureIndex(prepared.normalized);
  const votes = accumulateVotes(source, scope.start, scopeLen, index);
  const peaks = selectTopCandidates(votes);
  if (peaks.length === 0) {
    return undefined;
  }
  const windowLen = Math.min(prepared.effective.length, scopeLen);
  const candidates = expandCandidates(peaks, scopeLen - windowLen);
  const best = findBestWindow(source, prepared.normalized, candidates, scope.start);
  if (best === undefined) {
    return undefined;
  }
  return buildWindowResult(source, prepared.effective, prepared.normalized, best);
}
