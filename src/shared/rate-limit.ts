export class RateLimiter {
  private hits = new Map<string, number[]>();
  private maxHits: number;
  private windowMs: number;

  constructor(opts: { maxHits?: number; windowMs?: number } = {}) {
    this.maxHits = opts.maxHits ?? 10;
    this.windowMs = opts.windowMs ?? 60_000;
  }

  allow(key: string): { allowed: boolean; retryAfterMs?: number } {
    const now = Date.now();
    const timestamps = this.hits.get(key) ?? [];
    const recent = timestamps.filter((t) => now - t < this.windowMs);
    if (recent.length >= this.maxHits) {
      const oldest = recent[0];
      const retryAfterMs = this.windowMs - (now - oldest);
      this.hits.set(key, recent);
      return { allowed: false, retryAfterMs };
    }
    recent.push(now);
    this.hits.set(key, recent);
    return { allowed: true };
  }

  cleanup(): void {
    const now = Date.now();
    for (const [key, timestamps] of this.hits) {
      const recent = timestamps.filter((t) => now - t < this.windowMs);
      if (recent.length === 0) this.hits.delete(key);
      else this.hits.set(key, recent);
    }
  }
}
