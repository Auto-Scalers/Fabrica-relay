// Lease/drain integration test — boots an isolated Miniflare instance with a
// short FABRICA_RELAY_LEASE_MS (6s, vs the 1h production default) so the
// server-driven lease-expiry drain path is reachable in-process.
//
// Drain wire shape must satisfy the strict client schema:
// Fabrica-app/src/main/runtime/relay/relay-control-protocol.ts
// RelayDrainMessageSchema = { type:'drain', graceMs int ≤ 3_600_000,
// recovery:'resolve-director' } .strict()

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Miniflare } from "miniflare";
import { startRelay, stopRelay } from "./harness";
import { hostHandshake, type FetchLike } from "./ws-helpers";

const LEASE_MS = 6000;
const MAX_GRACE_MS = 3_600_000;

let fetchFn: FetchLike;

beforeAll(async () => {
  const mf: Miniflare = await startRelay({ FABRICA_RELAY_LEASE_MS: String(LEASE_MS) });
  const worker = await mf.getWorker();
  fetchFn = (input, init) => worker.fetch(input, init as never) as unknown as Promise<Response>;
});

afterAll(async () => {
  await stopRelay();
});

// Strict client-style parse mirroring RelayDrainMessageSchema (.strict()):
// exact key set, literal type/recovery, integer graceMs within client bounds
function parseDrainStrict(raw: unknown): { type: "drain"; graceMs: number; recovery: "resolve-director" } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("drain: not an object");
  }
  const keys = Object.keys(raw).sort();
  expect(keys).toEqual(["graceMs", "recovery", "type"]);
  const m = raw as Record<string, unknown>;
  if (m.type !== "drain") throw new Error(`drain: bad type ${String(m.type)}`);
  if (m.recovery !== "resolve-director") {
    throw new Error(`drain: bad recovery ${String(m.recovery)}`);
  }
  const graceMs = m.graceMs;
  if (typeof graceMs !== "number" || !Number.isInteger(graceMs) || graceMs < 0 || graceMs > MAX_GRACE_MS) {
    throw new Error(`drain: bad graceMs ${String(graceMs)}`);
  }
  return { type: "drain", graceMs, recovery: m.recovery };
}

describe("Configurable lease + drain path (integration)", () => {
  it(
    "sends a client-valid drain before short-lease expiry; control socket then closes cleanly",
    async () => {
      const startedAt = Date.now();
      const session = await hostHandshake(fetchFn, "lease-drain-host");
      const ack = session.ack;
      expect(ack.type).toBe("host-hello-ack");

      // Lease comes from the env config (6s), not the 1h default
      const leaseExpiresAt = Number(ack.leaseExpiresAt);
      expect(leaseExpiresAt - startedAt).toBeGreaterThan(0);
      expect(leaseExpiresAt - startedAt).toBeLessThanOrEqual(LEASE_MS + 1500);

      // Server-driven drain arrives before the configured lease expires
      const raw = await session.ctrl.nextRaw(15000);
      expect(typeof raw).toBe("string");
      const receivedAt = Date.now();
      const drain = parseDrainStrict(JSON.parse(raw as string));

      // graceMs is driven by the same config and stays within client bounds
      expect(drain.graceMs).toBe(LEASE_MS);
      expect(drain.graceMs).toBeLessThanOrEqual(MAX_GRACE_MS);
      expect(drain.recovery).toBe("resolve-director");
      // Shortly BEFORE lease expiry — leaves the client time to rebind
      expect(receivedAt).toBeLessThan(leaseExpiresAt);

      // Control socket closes cleanly afterwards (current behavior: the
      // server extends the lease post-drain; close is client-initiated)
      await session.ctrl.close();
      expect(session.ctrl.closed).toBe(true);

      // Let workerd release the sqlite handle before dispose (Windows EBUSY)
      await new Promise((resolve) => setTimeout(resolve, 2000));
    },
    30000,
  );
});
