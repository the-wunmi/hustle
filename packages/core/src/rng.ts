/**
 * A small seeded random generator (sfc32). The market, the scripted clients and the economy
 * simulation all draw from one, so a seed replays the same world.
 */
export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Integer in [min, max]. */
  int(min: number, max: number): number;
  chance(probability: number): boolean;
  pick<T>(items: readonly T[]): T;
  /** Weighted pick; weights need not sum to one. */
  weighted<T>(items: readonly (readonly [T, number])[]): T;
}

function hashSeed(seed: string | number): [number, number, number, number] {
  let h = 1779033703 ^ String(seed).length;
  const text = String(seed);
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  const mix = () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
  return [mix(), mix(), mix(), mix()];
}

export function createRng(seed: string | number): Rng {
  let [a, b, c, d] = hashSeed(seed);
  const next = () => {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
  const rng: Rng = {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    chance: (p) => next() < p,
    pick: (items) => {
      const item = items[Math.floor(next() * items.length)];
      if (item === undefined) throw new Error('pick from an empty list');
      return item;
    },
    weighted: (items) => {
      const total = items.reduce((s, [, w]) => s + w, 0);
      let roll = next() * total;
      for (const [item, w] of items) {
        roll -= w;
        if (roll < 0) return item;
      }
      const last = items.at(-1);
      if (!last) throw new Error('weighted pick from an empty list');
      return last[0];
    },
  };
  return rng;
}
