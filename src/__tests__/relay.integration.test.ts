// Integration tests — boots the real Worker + Cell Durable Object under a
// local Miniflare/workerd instance. Exercises the full wire protocol:
// Director JWT auth, host control-channel challenge-response, device management
// RPCs, and end-to-end data tunneling between simulated peers.
//
// Wire shapes follow the client source of truth:
// Fabrica-app/src/main/runtime/relay/relay-control-protocol.ts

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getWorker, stopRelay } from "./harness";
import { nacl, hmacSha256Bytes } from "../shared/crypto";
import {
  HOST_PROOF_TRANSCRIPT_DOMAIN,
  HOST_CHALLENGE_PLAINTEXT_DOMAIN,
} from "../shared/protocol";

const TEST_SECRET = "integration-test-secret";
const ORIGIN = "https://fabrica-relay.test";

let worker: { fetch: (input: string, init?: RequestInit) => Promise<Response> };

beforeAll(async () => {
  worker = await getWorker();
});

afterAll(async () => {
  await stopRelay();
});

// ---------------------------------------------------------------- helpers

class TestSocket {
  readonly ws: WebSocket;
  closed = false;
  closeCode?: number;
  private queue: (string | ArrayBuffer)[] = [];
  private waiters: { resolve: (m: string | ArrayBuffer) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }[] = [];
  private closeWaiters: ((code: number) => void)[] = [];

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.accept();
    ws.addEventListener("message", (evt: MessageEvent) => {
      const data = evt.data as string | ArrayBuffer;
      const w = this.waiters.shift();
      if (w) {
        clearTimeout(w.timer);
        w.resolve(data);
      } else {
        this.queue.push(data);
      }
    });
    ws.addEventListener("close", (evt: CloseEvent) => {
      this.closed = true;
      this.closeCode = evt.code;
      for (const cw of this.closeWaiters.splice(0)) cw(evt.code);
      for (const w of this.waiters.splice(0)) {
        clearTimeout(w.timer);
        w.reject(new Error(`socket closed (${evt.code}) while waiting for message`));
      }
    });
  }

  send(data: string | Uint8Array): void {
    this.ws.send(data as unknown as ArrayBuffer);
  }

  async nextRaw(timeoutMs = 8000): Promise<string | ArrayBuffer> {
    const queued = this.queue.shift();
    if (queued !== undefined) return queued;
    return new Promise<string | ArrayBuffer>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.timer === timer);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new Error(`timeout waiting for WS message (closed=${this.closed})`));
      }, timeoutMs);
      this.waiters.push({ resolve, reject, timer });
    });
  }

  async nextJson(): Promise<Record<string, unknown>> {
    for (;;) {
      const raw = await this.nextRaw();
      if (typeof raw !== "string") throw new Error("expected text message");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      // Server keepalive pings are not what callers are matching on
      if (parsed.type === "ping") continue;
      return parsed;
    }
  }

  async nextClose(timeoutMs = 8000): Promise<number> {
    if (this.closed) return this.closeCode ?? -1;
    return new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout waiting for WS close")), timeoutMs);
      this.closeWaiters.push((code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
  }

  // Wait for the close to round-trip so the DO processes it (stops its
  // timers) before the test ends and vitest-pool-workers flushes storage
  async close(): Promise<void> {
    try {
      this.ws.close();
      if (!this.closed) await this.nextClose();
    } catch {
      /* already closed */
    }
  }
}

async function connectWs(path: string): Promise<TestSocket> {
  const res = await worker.fetch(`${ORIGIN}${path}`, {
    headers: { Upgrade: "websocket" },
  });
  if (res.status !== 101 || !res.webSocket) {
    throw new Error(`expected 101 upgrade, got ${res.status}`);
  }
  return new TestSocket(res.webSocket);
}

function toB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function base64UrlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return b64ToBytes(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

interface HostSession {
  ctrl: TestSocket;
  ack: Record<string, unknown>;
  secretKey: Uint8Array;
}

// Full host control-channel openInitial flow:
// host-hello -> host-challenge -> decrypt NaCl box -> HMAC proof -> host-hello-ack
async function hostHandshake(relayHostId: string): Promise<HostSession> {
  const ctrl = await connectWs("/v1/host/control");
  const kp = nacl.box.keyPair();

  ctrl.send(
    JSON.stringify({
      type: "host-hello",
      v: 1,
      relayHostId,
      hostPublicKeyB64: toB64(kp.publicKey),
      assignmentEpoch: Date.now(),
    }),
  );

  const challenge = await ctrl.nextJson();
  expect(challenge.type).toBe("host-challenge");

  // Decrypt: plaintext = domain\0 + transcript + secret(32)
  const plaintext = nacl.box.open(
    b64ToBytes(challenge.ciphertextB64 as string),
    base64UrlToBytes(challenge.nonceB64 as string),
    b64ToBytes(challenge.relayEphemeralPublicKeyB64 as string),
    kp.secretKey,
  );
  expect(plaintext).not.toBeNull();

  const domainLen = new TextEncoder().encode(HOST_CHALLENGE_PLAINTEXT_DOMAIN).length + 1;
  const secret = plaintext!.slice(plaintext!.length - 32);
  const transcript = plaintext!.slice(domainLen, plaintext!.length - 32);

  const prefix = new TextEncoder().encode(`${HOST_PROOF_TRANSCRIPT_DOMAIN}\0ack\0`);
  const proof = await hmacSha256Bytes(secret, concat(prefix, transcript));

  ctrl.send(
    JSON.stringify({
      type: "host-challenge-ack",
      challengeId: challenge.challengeId,
      proofB64: toB64(proof),
    }),
  );

  const ack = await ctrl.nextJson();
  return { ctrl, ack, secretKey: kp.secretKey };
}

// Phone cell connection: relay-auth -> relay-hello(ok:true)
async function connectPhone(relayHostId: string, credential: string): Promise<TestSocket> {
  const phone = await connectWs(`/v1/connect/${encodeURIComponent(relayHostId)}`);
  phone.send(JSON.stringify({ type: "relay-auth", v: 1, mode: "connect", credential }));
  const hello = await phone.nextJson();
  expect(hello.type).toBe("relay-hello");
  expect(hello.ok).toBe(true);
  expect(hello.credentialKind).toBe("invite");
  return phone;
}

async function createJwt(secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const b64u = (s: string) =>
    btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const header = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64u(JSON.stringify({ sub: "user-itest", iat: Date.now() }));
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(`${header}.${payload}`));
  const sigB64u = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `${header}.${payload}.${sigB64u}`;
}

// ---------------------------------------------------------------- Director auth

describe("Director POST /v1/assign (integration)", () => {
  it("rejects missing Authorization header", async () => {
    const res = await worker.fetch(`${ORIGIN}/v1/assign`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ v: 1, relayHostId: "assign-host-missing-auth" }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects an invalid JWT", async () => {
    const res = await worker.fetch(`${ORIGIN}/v1/assign`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer not.a.jwt",
      },
      body: JSON.stringify({ v: 1, relayHostId: "assign-host-bad-jwt" }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects a JWT signed with the wrong secret", async () => {
    const jwt = await createJwt("wrong-secret-value");
    const res = await worker.fetch(`${ORIGIN}/v1/assign`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify({ v: 1, relayHostId: "assign-host-wrong-secret" }),
    });
    expect(res.status).toBe(401);
  });

  it("accepts a valid JWT and returns the assignment", async () => {
    const jwt = await createJwt(TEST_SECRET);
    const res = await worker.fetch(`${ORIGIN}/v1/assign`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify({ v: 1, relayHostId: "assign-host-ok" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.v).toBe(1);
    expect(typeof body.cellUrl).toBe("string");
    expect(body.assignmentEpoch).toBeGreaterThan(0);
    expect(typeof body.lease).toBe("string");
    expect((body.lease as string).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------- Control channel

describe("Cell control channel (integration)", () => {
  it("completes the challenge-response handshake and returns host-hello-ack", async () => {
    const session = await hostHandshake("ctrl-ok-host");
    const ack = session.ack;

    expect(ack.type).toBe("host-hello-ack");
    expect(ack.v).toBe(1);
    expect(Number(ack.generation)).toBeGreaterThanOrEqual(1);
    expect(String(ack.controlResumeSecret)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Number(ack.leaseExpiresAt)).toBeGreaterThan(Date.now());
    expect(Array.isArray(ack.activeConnIds)).toBe(true);
    expect(Array.isArray(ack.pendingConns)).toBe(true);
    await session.ctrl.close();
    // First test to write DO storage in this file: give workerd time to
    // release the sqlite handle before the storage frame pop (Windows EBUSY)
    await new Promise((resolve) => setTimeout(resolve, 3000));
  });

  it("closes with 4401 BAD_OUTER_CREDENTIAL on a bad proof", async () => {
    const ctrl = await connectWs("/v1/host/control");
    const kp = nacl.box.keyPair();
    ctrl.send(
      JSON.stringify({
        type: "host-hello",
        v: 1,
        relayHostId: "ctrl-bad-proof-host",
        hostPublicKeyB64: toB64(kp.publicKey),
        assignmentEpoch: Date.now(),
      }),
    );
    const challenge = await ctrl.nextJson();
    expect(challenge.type).toBe("host-challenge");

    ctrl.send(
      JSON.stringify({
        type: "host-challenge-ack",
        challengeId: challenge.challengeId,
        proofB64: toB64(new Uint8Array(32)), // wrong proof
      }),
    );
    const code = await ctrl.nextClose();
    expect(code).toBe(4401);
  });
});

describe("Ping/pong keepalive (integration)", () => {
  it("sends {type:'ping', t} every 15s and keeps the control channel alive after pong", async () => {
    const session = await hostHandshake("keepalive-host");

    // Server-driven app-level JSON ping (protocol pings do NOT satisfy the client watchdog)
    const raw = await session.ctrl.nextRaw(20000);
    expect(typeof raw).toBe("string");
    const ping = JSON.parse(raw as string) as Record<string, unknown>;
    expect(Object.keys(ping).sort()).toEqual(["t", "type"]); // strict schema: no extra fields
    expect(ping.type).toBe("ping");
    expect(typeof ping.t).toBe("number");
    expect(Number(ping.t)).toBeLessThanOrEqual(Date.now());

    // Client reply {type:'pong', t} must be accepted without a 4401 close
    session.ctrl.send(JSON.stringify({ type: "pong", t: ping.t }));

    // Channel still functional after pong: run a reqId RPC roundtrip
    session.ctrl.send(
      JSON.stringify({ type: "invite-create", reqId: "req-keepalive-1", relayDeviceId: "dev-ka" }),
    );
    const resp = await session.ctrl.nextJson();
    expect(resp.type).toBe("invite-created");
    expect(resp.reqId).toBe("req-keepalive-1");

    await session.ctrl.close();
  }, 30000);
});

// ---------------------------------------------------------------- Device management

describe("Device management RPCs over control channel (integration)", () => {
  it("runs invite-create -> credential-install -> status -> resume-confirm -> revoke", async () => {
    const session = await hostHandshake("device-rpc-host");
    const ctrl = session.ctrl;

    // invite-create (client wire shape)
    ctrl.send(
      JSON.stringify({
        type: "invite-create",
        reqId: "req-invite-1",
        relayDeviceId: "phone-device-1",
      }),
    );
    const invite = await ctrl.nextJson();
    expect(invite.type).toBe("invite-created");
    expect(invite.reqId).toBe("req-invite-1");
    expect(String(invite.inviteToken)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Number(invite.expiresAt)).toBeGreaterThan(Date.now());
    expect(Number(invite.maxAttempts)).toBeGreaterThan(0);

    // device-credential-install (client wire shape)
    ctrl.send(
      JSON.stringify({
        type: "device-credential-install",
        v: 1,
        reqId: "req-install-1",
        relayDeviceId: "phone-device-1",
        newResumeTokenHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        authorization: { mode: "relay-basis", basisConnId: "conn-x" },
      }),
    );
    const installed = await ctrl.nextJson();
    expect(installed.type).toBe("device-credential-installed");
    expect(installed.v).toBe(1);
    expect(installed.reqId).toBe("req-install-1");
    expect(installed.authorizationMode).toBe("relay-basis");
    expect(Number(installed.currentVersion)).toBeGreaterThan(0);
    expect(Number(installed.resumeExpiresAt)).toBeGreaterThan(Date.now());

    // device-credential-install-status (committed)
    ctrl.send(
      JSON.stringify({
        type: "device-credential-install-status",
        v: 1,
        reqId: "req-status-1",
        relayDeviceId: "phone-device-1",
      }),
    );
    const status = await ctrl.nextJson();
    expect(status.type).toBe("device-credential-install-status-result");
    expect(status.state).toBe("committed");
    const result = status.result as Record<string, unknown>;
    expect(typeof result.reqId).toBe("string");
    expect(result.authorizationMode).toBe("relay-basis");

    // device-credential-install-status for an unknown device (not-found)
    ctrl.send(
      JSON.stringify({
        type: "device-credential-install-status",
        v: 1,
        reqId: "req-status-2",
        relayDeviceId: "unknown-device",
      }),
    );
    const missing = await ctrl.nextJson();
    expect(missing.type).toBe("device-credential-install-status-result");
    expect(missing.state).toBe("not-found");

    // device-resume-confirm (client wire shape: basisConnId, not deviceId)
    ctrl.send(
      JSON.stringify({
        type: "device-resume-confirm",
        v: 1,
        reqId: "req-confirm-1",
        basisConnId: "conn-x",
      }),
    );
    const confirmed = await ctrl.nextJson();
    expect(confirmed.type).toBe("device-resume-confirmed");
    expect(confirmed.v).toBe(1);
    expect(confirmed.reqId).toBe("req-confirm-1");
    expect(confirmed.acceptedAs).toBe("current");
    expect(confirmed.renewed).toBe(false);
    expect(Number(confirmed.currentVersion)).toBeGreaterThan(0);

    // device-revoke (client wire shape: relayDeviceId)
    ctrl.send(
      JSON.stringify({
        type: "device-revoke",
        reqId: "req-revoke-1",
        relayDeviceId: "phone-device-1",
      }),
    );
    const revoked = await ctrl.nextJson();
    expect(revoked.type).toBe("device-revoked");
    expect(revoked.reqId).toBe("req-revoke-1");

    // status after revoke -> not-found
    ctrl.send(
      JSON.stringify({
        type: "device-credential-install-status",
        v: 1,
        reqId: "req-status-3",
        relayDeviceId: "phone-device-1",
      }),
    );
    const goneStatus = await ctrl.nextJson();
    expect(goneStatus.type).toBe("device-credential-install-status-result");
    expect(goneStatus.state).toBe("not-found");

    await session.ctrl.close();
  });

  it("replies control-error for an unknown message type", async () => {
    const session = await hostHandshake("device-error-host");
    session.ctrl.send(JSON.stringify({ type: "no-such-message", reqId: "req-e1" }));
    const err = await session.ctrl.nextJson();
    expect(err.type).toBe("control-error");
    expect(err.reqId).toBe("req-e1");
    expect(typeof err.code).toBe("string");
    await session.ctrl.close();
  });

  it("rejects device-credential-install without relayDeviceId", async () => {
    const session = await hostHandshake("device-nofield-host");
    session.ctrl.send(
      JSON.stringify({
        type: "device-credential-install",
        v: 1,
        reqId: "req-i2",
        newResumeTokenHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        authorization: { mode: "relay-basis", basisConnId: "conn-y" },
      }),
    );
    const err = await session.ctrl.nextJson();
    expect(err.type).toBe("control-error");
    expect(err.reqId).toBe("req-i2");
    await session.ctrl.close();
  });
});

// ---------------------------------------------------------------- Data tunneling

describe("Data tunneling (integration)", () => {
  it("tunnels binary and text frames end-to-end between host and phone", async () => {
    const relayHostId = "tunnel-host-1";
    const session = await hostHandshake(relayHostId);
    const generation = Number(session.ack.generation);

    // Phone connects and authenticates with an invite credential
    const phone = await connectPhone(relayHostId, "invite-token-tunnel-1");

    // Host receives conn-open on the control channel
    const connOpen = await session.ctrl.nextJson();
    expect(connOpen.type).toBe("conn-open");
    expect(typeof connOpen.connId).toBe("string");
    expect(String(connOpen.connTicket)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(connOpen.kind).toBe("invite");
    expect(connOpen.relayDeviceId).toBe("invite-token-tunnel-1");
    expect(Number(connOpen.attachDeadlineMs)).toBeLessThanOrEqual(60000);

    // Host attaches the data socket within the deadline
    const data = await connectWs(`/v1/host/data/${connOpen.connId}`);
    data.send(
      JSON.stringify({
        type: "host-data-auth",
        v: 1,
        connTicket: connOpen.connTicket,
        generation,
      }),
    );

    // Host -> phone: binary frame forwarded verbatim
    const payload = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00, 0xff]);
    data.send(payload);
    const phoneGot = await phone.nextRaw();
    expect(phoneGot).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(phoneGot as ArrayBuffer)).toEqual(payload);

    // Phone -> host: text frame forwarded verbatim
    phone.send(JSON.stringify({ e2ee: "frame-from-phone" }));
    const hostGotText = await data.nextRaw();
    expect(hostGotText).toBe(JSON.stringify({ e2ee: "frame-from-phone" }));

    // Host -> phone: second frame preserves order
    const payload2 = new Uint8Array([1, 2, 3]);
    data.send(payload2);
    const phoneGot2 = await phone.nextRaw();
    expect(new Uint8Array(phoneGot2 as ArrayBuffer)).toEqual(payload2);

    // Phone -> host: binary frame back
    const back = new Uint8Array([9, 8, 7]);
    phone.send(back);
    const hostGotBin = await data.nextRaw();
    expect(new Uint8Array(hostGotBin as ArrayBuffer)).toEqual(back);

    await data.close();
    await phone.close();
    await session.ctrl.close();
  });

  it("closes the data socket with 4409 WRONG_CELL on a stale generation", async () => {
    const relayHostId = "tunnel-stale-gen-host";
    const session = await hostHandshake(relayHostId);
    const phone = await connectPhone(relayHostId, "invite-token-stale-gen");

    const connOpen = await session.ctrl.nextJson();
    expect(connOpen.type).toBe("conn-open");

    const data = await connectWs(`/v1/host/data/${connOpen.connId}`);
    data.send(
      JSON.stringify({
        type: "host-data-auth",
        v: 1,
        connTicket: connOpen.connTicket,
        generation: Number(session.ack.generation) + 999, // stale/wrong
      }),
    );
    const code = await data.nextClose();
    expect(code).toBe(4409);

    await phone.close();
    await session.ctrl.close();
  });

  it("closes the data socket with 4404 HOST_OFFLINE for a connection with no host", async () => {
    // Data sockets may be opened for any connId; one the server never issued
    // has no host mapping → 4404 HOST_OFFLINE on attach
    const data = await connectWs("/v1/host/data/never-issued-conn-id");
    data.send(
      JSON.stringify({
        type: "host-data-auth",
        v: 1,
        connTicket: "t".repeat(43),
        generation: 1,
      }),
    );
    expect(await data.nextClose()).toBe(4404);
  });

  it("closes the phone socket with 4408 PEER_DROPPED when the host data channel drops", async () => {
    const relayHostId = "tunnel-peer-drop-host";
    const session = await hostHandshake(relayHostId);
    const phone = await connectPhone(relayHostId, "invite-token-peer-drop");

    const connOpen = await session.ctrl.nextJson();
    expect(connOpen.type).toBe("conn-open");

    const data = await connectWs(`/v1/host/data/${connOpen.connId}`);
    data.send(
      JSON.stringify({
        type: "host-data-auth",
        v: 1,
        connTicket: connOpen.connTicket,
        generation: Number(session.ack.generation),
      }),
    );

    // Host drops the data channel — messages and close are delivered in
    // order, so auth is processed before the close event reaches the DO
    await data.close();

    expect(await phone.nextClose()).toBe(4408);

    await session.ctrl.close();
  });

  it("rejects the 9th pending connection with relay-hello ok:false + 4429 LIMIT_EXCEEDED", async () => {
    const relayHostId = "limit-exceeded-host";
    const session = await hostHandshake(relayHostId);

    // Fill all 8 pending slots (sockets stay open, never attach data)
    const phones: TestSocket[] = [];
    for (let i = 0; i < 8; i++) {
      phones.push(await connectPhone(relayHostId, `invite-limit-${i}`));
      const connOpen = await session.ctrl.nextJson();
      expect(connOpen.type).toBe("conn-open");
    }

    // The 9th is over the limit: relay-hello {ok:false, code:4429} then close 4429
    const ninth = await connectWs(`/v1/connect/${encodeURIComponent(relayHostId)}`);
    ninth.send(
      JSON.stringify({ type: "relay-auth", v: 1, mode: "connect", credential: "invite-limit-overflow" }),
    );
    const hello = await ninth.nextJson();
    expect(hello.type).toBe("relay-hello");
    expect(hello.ok).toBe(false);
    expect(Number(hello.code)).toBe(4429);
    expect(await ninth.nextClose()).toBe(4429);

    for (const p of phones) await p.close();
    await session.ctrl.close();
  });
});

// ---------------------------------------------------------------- Resolve

describe("Phone invite-recovery relay-moved (integration)", () => {
  it("replies relay-moved to a /v1/connect dial whose first frame is not relay-auth", async () => {
    const relayHostId = "relay-moved-host";
    const session = await hostHandshake(relayHostId);

    const probe = await connectWs(`/v1/connect/${encodeURIComponent(relayHostId)}`);
    probe.send(JSON.stringify({ type: "status.probe" }));
    const moved = await probe.nextJson();
    expect(moved.type).toBe("relay-moved");
    expect(moved.v).toBe(1);
    // Strict client schema (RelayMovedSchema): exactly these fields, canonical
    // https origin, positive epoch
    expect(Object.keys(moved).sort()).toEqual(["assignmentEpoch", "cellUrl", "type", "v"]);
    expect(moved.cellUrl).toBe(ORIGIN);
    expect(Number(moved.assignmentEpoch)).toBeGreaterThan(0);

    await probe.close();
    await session.ctrl.close();
  });

  it("still serves the cell invite flow (relay-hello) for a relay-auth first frame", async () => {
    const relayHostId = "relay-moved-vs-hello-host";
    const session = await hostHandshake(relayHostId);
    const phone = await connectPhone(relayHostId, "invite-token-moved-probe");
    const connOpen = await session.ctrl.nextJson();
    expect(connOpen.type).toBe("conn-open");
    await phone.close();
    await session.ctrl.close();
  });
});

describe("host-hello-ack pendingConns wire shape (integration)", () => {
  it("serves persisted pendingConns with exact {connId, connTicket} keys (no column leakage)", async () => {
    const relayHostId = "pending-conn-leak-host";
    const s1 = await hostHandshake(relayHostId);

    // Create a pending connection that is persisted but never attached
    const phone = await connectPhone(relayHostId, "invite-token-leak-probe");
    const connOpen = await s1.ctrl.nextJson();
    expect(connOpen.type).toBe("conn-open");

    // Re-handshake: the DO re-reads pendingConns from SQLite for the ack
    await s1.ctrl.close();
    await phone.close();
    const s2 = await hostHandshake(relayHostId);
    const ack = s2.ack;
    expect(Array.isArray(ack.pendingConns)).toBe(true);
    expect((ack.pendingConns as unknown[]).length).toBeGreaterThanOrEqual(1);
    for (const pc of ack.pendingConns as Record<string, unknown>[]) {
      // Client PendingConnectionSchema is .strict() — extra storage columns
      // (e.g. host_id) would make the whole host-hello-ack fail to parse
      expect(Object.keys(pc).sort()).toEqual(["connId", "connTicket"]);
    }

    await s2.ctrl.close();
  });
});

describe("Director POST /v1/resolve (integration)", () => {
  it("resolves a host with live state through the real Durable Object", async () => {
    const relayHostId = "resolve-live-host";
    const session = await hostHandshake(relayHostId);

    const res = await worker.fetch(`${ORIGIN}/v1/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ v: 1, relayHostId, resumeToken: "some-resume-token" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.v).toBe(1);
    // cellUrl must be the PUBLIC worker origin (canonical https), never the
    // DO-internal RPC URL
    expect(body.cellUrl).toBe(ORIGIN);
    expect(body.assignmentEpoch).toBeGreaterThan(0);
    expect(body.leaseExpiresAt).toBeGreaterThan(Date.now());

    await session.ctrl.close();
  });

  it("returns 401 for an unknown host", async () => {
    const res = await worker.fetch(`${ORIGIN}/v1/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ v: 1, relayHostId: "never-connected-host", resumeToken: "tok" }),
    });
    expect(res.status).toBe(401);
  });
});
