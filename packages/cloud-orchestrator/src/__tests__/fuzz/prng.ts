/** mulberry32: small, fast and fully determined by its seed. */
export class Prng {
  private state: number;

  constructor(seed: number) {
    this.state = (seed ^ 0x9e3779b9) >>> 0;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('pick from an empty list');
    return items[this.int(items.length)] as T;
  }

  /** Picks a key with probability proportional to its weight; zero weights never win. */
  weighted<T>(entries: ReadonlyArray<readonly [T, number]>): T {
    const total = entries.reduce((sum, [, weight]) => sum + Math.max(weight, 0), 0);
    if (total <= 0) throw new Error('no positive weight');
    let roll = this.next() * total;
    for (const [value, weight] of entries) {
      if (weight <= 0) continue;
      roll -= weight;
      if (roll < 0) return value;
    }
    return entries.filter(([, weight]) => weight > 0).at(-1)![0];
  }
}
