// Shared WebSocket test helpers for the miniflare integration suites.
import { expect } from "vitest";
import { nacl, hmacSha256Bytes } from "../shared/crypto";
import {
  HOST_PROOF_TRANSCRIPT_DOMAIN,
  HOST_CHALLENGE_PLAINTEXT_DOMAIN,
} from "../shared/protocol";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class TestSocket {
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

export async function connectWs(fetchFn: FetchLike, path: string): Promise<TestSocket> {
  const ORIGIN = "https://fabrica-relay.test";
  const res = await fetchFn(`${ORIGIN}${path}`, {
    headers: { Upgrade: "websocket" },
  });
  if (res.status !== 101 || !res.webSocket) {
    throw new Error(`expected 101 upgrade, got ${res.status}`);
  }
  return new TestSocket(res.webSocket);
}

export function toB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function base64UrlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return b64ToBytes(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
}

export function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export interface HostSession {
  ctrl: TestSocket;
  ack: Record<string, unknown>;
  secretKey: Uint8Array;
}

// Full host control-channel openInitial flow:
// host-hello -> host-challenge -> decrypt NaCl box -> HMAC proof -> host-hello-ack
export async function hostHandshake(
  fetchFn: FetchLike,
  relayHostId: string,
): Promise<HostSession> {
  const ctrl = await connectWs(fetchFn, "/v1/host/control");
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

  // Decrypt: plaintext = domain\0 + uint32BE(transcriptLength) + transcript + secret(32)
  const plaintext = nacl.box.open(
    b64ToBytes(challenge.ciphertextB64 as string),
    base64UrlToBytes(challenge.nonceB64 as string),
    b64ToBytes(challenge.relayEphemeralPublicKeyB64 as string),
    kp.secretKey,
  );
  expect(plaintext).not.toBeNull();

  const domainLen = new TextEncoder().encode(HOST_CHALLENGE_PLAINTEXT_DOMAIN).length + 1;
  const transcriptLen = new DataView(
    plaintext!.buffer,
    plaintext!.byteOffset + domainLen,
    4,
  ).getUint32(0, false);
  const transcriptStart = domainLen + 4;
  const secret = plaintext!.slice(transcriptStart + transcriptLen);
  const transcript = plaintext!.slice(transcriptStart, transcriptStart + transcriptLen);

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
