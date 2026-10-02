// Deterministic randomness: every random choice in the trainer goes through a seeded generator so
// tests (and a session started with the same seed) are reproducible.

/** FNV-1a: a small deterministic 32-bit hash. */
export function hash32(text: string): number {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 0x01000193);
  }
  return value >>> 0;
}

export type Rng = () => number;

/** mulberry32: a seeded generator of floats in [0, 1). */
export function seededRng(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Picks an index with probability proportional to its weight; -1 when no weight is positive. */
export function pickWeighted(weights: readonly number[], rng: Rng): number {
  const total = weights.reduce((sum, weight) => sum + (weight > 0 ? weight : 0), 0);
  if (total <= 0) {
    return -1;
  }
  let target = rng() * total;
  for (let index = 0; index < weights.length; index += 1) {
    const weight = weights[index] > 0 ? weights[index] : 0;
    if (target < weight) {
      return index;
    }
    target -= weight;
  }
  for (let index = weights.length - 1; index >= 0; index -= 1) {
    if (weights[index] > 0) {
      return index;
    }
  }
  return -1;
}

/** A shuffled copy (Fisher-Yates with the given generator). */
export function shuffled<T>(items: readonly T[], rng: Rng): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(rng() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap], copy[index]];
  }
  return copy;
}
