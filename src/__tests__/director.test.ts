import { describe, it, expect } from "vitest";
import { createDirectorApp, type DirectorEnv } from "../director";

function makeEnv(overrides: Partial<DirectorEnv> = {}): DirectorEnv {
  return {
    CELL: {
      idFromName: () => ({ toString: () => "test-id" }),
      get: () => ({
        fetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      }),
    } as unknown as DurableObjectNamespace,
    FABRICA_RELAY_JWT_SECRET: "test-secret",
    DIRECTOR_URL: "https://relay.test.workers.dev",
    ...overrides,
  };
}

// Helper: create a valid JWT with HMAC-SHA256
async function createTestJwt(secret: string): Promise<string> {
  const header = { alg: "HS256", typ: "JWT" };
  const payload = { sub: "user-1", iat: Date.now() };
  const encoder = new TextEncoder();

  const headerB64 = btoa(JSON.stringify(header))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const payloadB64 = btoa(JSON.stringify(payload))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const signingInput = encoder.encode(`${headerB64}.${payloadB64}`);
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, signingInput));
  const sigB64 = btoa(String.fromCharCode(...sig))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  return `${headerB64}.${payloadB64}.${sigB64}`;
}

describe("Director", () => {
  describe("POST /v1/assign", () => {
    it("rejects missing Authorization header", async () => {
      const app = createDirectorApp();
      const res = await app.request("/v1/assign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ v: 1, relayHostId: "host-1" }),
      }, makeEnv());
      expect(res.status).toBe(401);
    });

    it("rejects invalid JWT", async () => {
      const app = createDirectorApp();
      const res = await app.request("/v1/assign", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer invalid.token.here",
        },
        body: JSON.stringify({ v: 1, relayHostId: "host-1" }),
      }, makeEnv());
      expect(res.status).toBe(401);
    });

    it("accepts valid JWT and returns assignment", async () => {
      const app = createDirectorApp();
      const jwt = await createTestJwt("test-secret");
      const res = await app.request("/v1/assign", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${jwt}`,
        },
        body: JSON.stringify({ v: 1, relayHostId: "host-1" }),
      }, makeEnv());
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.v).toBe(1);
      expect(body.cellUrl).toBe("https://relay.test.workers.dev");
      expect(body.assignmentEpoch).toBeGreaterThan(0);
      expect(body.lease).toBeTruthy();
    });

    it("rejects invalid request body", async () => {
      const app = createDirectorApp();
      const jwt = await createTestJwt("test-secret");
      const res = await app.request("/v1/assign", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${jwt}`,
        },
        body: JSON.stringify({ v: 1 }),
      }, makeEnv());
      expect(res.status).toBe(400);
    });
  });

  describe("POST /v1/resolve", () => {
    it("rejects invalid request body", async () => {
      const app = createDirectorApp();
      const res = await app.request("/v1/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ v: 1 }),
      }, makeEnv());
      expect(res.status).toBe(400);
    });

    it("accepts valid resolve request", async () => {
      const app = createDirectorApp();
      const env = makeEnv({
        CELL: {
          idFromName: () => ({ toString: () => "test-id" }),
          get: () => ({
            fetch: async () => new Response(JSON.stringify({
              ok: true,
              cellUrl: "https://relay.test.workers.dev/v1/host/control",
              assignmentEpoch: Date.now(),
              leaseExpiresAt: Date.now() + 3600000,
            }), { status: 200 }),
          }),
        } as unknown as DurableObjectNamespace,
      });
      const res = await app.request("/v1/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ v: 1, relayHostId: "host-1", resumeToken: "tok-123" }),
      }, env);
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.v).toBe(1);
    });
  });

  describe("GET /health", () => {
    it("returns ok", async () => {
      const app = createDirectorApp();
      const res = await app.request("/health", {}, makeEnv());
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.ok).toBe(true);
    });
  });
});
