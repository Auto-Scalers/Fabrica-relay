import { Hono } from "hono";
import { verifyHmacSha256 } from "../shared/crypto.js";
import { createLogger } from "../shared/logger.js";
import { RateLimiter } from "../shared/rate-limit.js";
import type {
  AssignRequest,
  AssignResponse,
  EpochMs,
  ResolveRequest,
  ResolveResponse,
} from "../shared/types.js";

export interface DirectorEnv {
  CELL: DurableObjectNamespace;
  FABRICA_RELAY_JWT_SECRET: string;
  DIRECTOR_URL: string;
}

const logger = createLogger("director");
const assignRateLimiter = new RateLimiter({ maxHits: 10, windowMs: 60_000 });

// Must match the hub DO name used by the WS router in src/index.ts — all
// sockets for every host live in this single multi-tenant Durable Object
const HUB_ID = "relay-hub";

// --------------- helpers

function base64UrlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function encoder(): TextEncoder {
  return new TextEncoder();
}

function generateLease(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function validateJwt(
  token: string,
  secret: string,
): Promise<boolean> {
  const parts = token.split(".");
  if (parts.length !== 3) return false;

  const [headerB64, payloadB64, sigB64] = parts;
  const data = encoder().encode(`${headerB64}.${payloadB64}`);
  const sigBytes = base64UrlDecode(sigB64);
  const secretBytes = encoder().encode(secret);

  return verifyHmacSha256(secretBytes, data, sigBytes);
}

// --------------- app

export function createDirectorApp(): Hono<{ Bindings: DirectorEnv }> {
  const app = new Hono<{ Bindings: DirectorEnv }>();

  // POST /v1/assign — host requests cell assignment
  app.post("/v1/assign", async (c) => {
    const clientIp = c.req.header("CF-Connecting-IP") ?? "unknown";
    const rateCheck = assignRateLimiter.allow(clientIp);
    if (!rateCheck.allowed) {
      logger.warn("rate limited", { clientIp });
      return c.json({ error: "rate limited" }, 429, {
        "Retry-After": String(Math.ceil((rateCheck.retryAfterMs ?? 60000) / 1000)),
      });
    }

    const authHeader = c.req.header("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return c.json({ error: "missing or invalid Authorization header" }, 401);
    }

    const token = authHeader.slice(7);
    const valid = await validateJwt(token, c.env.FABRICA_RELAY_JWT_SECRET);
    if (!valid) {
      logger.warn("invalid JWT", { clientIp });
      return c.json({ error: "invalid JWT" }, 401);
    }

    let body: AssignRequest;
    try {
      body = await c.req.json<AssignRequest>();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }

    if (body.v !== 1 || !body.relayHostId) {
      return c.json({ error: "invalid request fields" }, 400);
    }

    const cellUrl = c.env.DIRECTOR_URL;
    const assignmentEpoch = Date.now();
    const lease = generateLease();

    const id = c.env.CELL.idFromName(body.relayHostId);
    const _stub = c.env.CELL.get(id);

    logger.info("assign", { relayHostId: body.relayHostId, assignmentEpoch });

    const response: AssignResponse = {
      v: 1,
      cellUrl,
      assignmentEpoch,
      lease,
    };

    return c.json(response);
  });

  // POST /v1/resolve — phone resume recovery (no Bearer auth)
  app.post("/v1/resolve", async (c) => {
    let body: ResolveRequest;
    try {
      body = await c.req.json<ResolveRequest>();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }

    if (body.v !== 1 || !body.relayHostId || !body.resumeToken) {
      return c.json({ error: "invalid request fields" }, 400);
    }

    // Resolve against the hub DO — the same instance that holds the host's
    // live WS state (see HUB_ID note above)
    const id = c.env.CELL.idFromName(HUB_ID);
    const stub = c.env.CELL.get(id);

    // Ask the DO to validate the resume token and get assignment info
    let result: { ok: boolean; cellUrl?: string; assignmentEpoch?: number; leaseExpiresAt?: number };
    try {
      const resp = await stub.fetch("http://do/resolve-resume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resumeToken: body.resumeToken, relayHostId: body.relayHostId }),
      });
      result = await resp.json<{
        ok: boolean;
        cellUrl?: string;
        assignmentEpoch?: number;
        leaseExpiresAt?: number;
      }>();
    } catch {
      return c.json({ error: "host offline" }, 404);
    }

    if (!result.ok || !result.cellUrl || !result.assignmentEpoch || !result.leaseExpiresAt) {
      logger.warn("resolve failed", { relayHostId: body.relayHostId });
      return c.json({ error: "invalid resume token" }, 401);
    }

    logger.info("resolve", { relayHostId: body.relayHostId });
    const response: ResolveResponse = {
      v: 1,
      cellUrl: result.cellUrl,
      assignmentEpoch: result.assignmentEpoch,
      leaseExpiresAt: result.leaseExpiresAt as EpochMs,
    };

    return c.json(response);
  });

  // Health check
  app.get("/health", (c) => c.json({ ok: true }));

  return app;
}
