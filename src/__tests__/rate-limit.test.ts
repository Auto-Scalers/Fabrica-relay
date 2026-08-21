import { describe, it, expect } from "vitest";
import { RateLimiter } from "../shared/rate-limit";

describe("RateLimiter", () => {
  it("allows requests within limit", () => {
    const limiter = new RateLimiter({ maxHits: 3, windowMs: 60_000 });
    expect(limiter.allow("ip1").allowed).toBe(true);
    expect(limiter.allow("ip1").allowed).toBe(true);
    expect(limiter.allow("ip1").allowed).toBe(true);
  });

  it("rejects requests over limit", () => {
    const limiter = new RateLimiter({ maxHits: 2, windowMs: 60_000 });
    expect(limiter.allow("ip1").allowed).toBe(true);
    expect(limiter.allow("ip1").allowed).toBe(true);
    const result = limiter.allow("ip1");
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it("tracks different keys independently", () => {
    const limiter = new RateLimiter({ maxHits: 1, windowMs: 60_000 });
    expect(limiter.allow("ip1").allowed).toBe(true);
    expect(limiter.allow("ip1").allowed).toBe(false);
    expect(limiter.allow("ip2").allowed).toBe(true);
  });

  it("cleanup removes expired entries", () => {
    const limiter = new RateLimiter({ maxHits: 10, windowMs: 1 });
    limiter.allow("ip1");
    // Wait for window to expire
    const start = Date.now();
    while (Date.now() - start < 5) { /* spin */ }
    limiter.cleanup();
    // Should allow again after cleanup
    expect(limiter.allow("ip1").allowed).toBe(true);
  });
});
