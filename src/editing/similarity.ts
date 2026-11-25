import { normalizeTypography } from "./text.ts";

export const MIN_SIMILARITY = 0.35;

/** Normalization, bigram counts, and rounding can give a failed match a perfect score. */
export function failedMatchPercentage(score: number): number {
  return Math.min(99, Math.round(score * 100));
}

export function normalizeForSimilarity(value: string): string {
  return normalizeTypography(value).replace(/\s+/g, " ").trim();
}

export function diceSimilarityTo(left: string): (right: string) => number {
  const available = new Map<string, number>();
  for (let index = 0; index < left.length - 1; index++) {
    const pair = left.slice(index, index + 2);
    available.set(pair, (available.get(pair) ?? 0) + 1);
  }
  return (right) => {
    if (left === right) {
      return 1;
    }
    if (left.length < 2 || right.length < 2) {
      return 0;
    }
    const matched = new Map<string, number>();
    let overlap = 0;
    for (let index = 0; index < right.length - 1; index++) {
      const pair = right.slice(index, index + 2);
      const count = matched.get(pair) ?? 0;
      if (count < (available.get(pair) ?? 0)) {
        overlap++;
        matched.set(pair, count + 1);
      }
    }
    return (2 * overlap) / (left.length + right.length - 2);
  };
}
