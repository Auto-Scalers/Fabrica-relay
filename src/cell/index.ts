import { Hono } from "hono";
import { upgradeWebSocket } from "hono/cloudflare-workers";
import { DurableObject } from "cloudflare:workers";
import { nacl, hmacSha256Bytes, timingSafeEqual } from "../shared/crypto.js";
import { createLogger } from "../shared/logger.js";
import { CellStore, type StoredHostState } from "./store.js";
import {
  HOST_PROOF_TRANSCRIPT_DOMAIN,
  HOST_CHALLENGE_PLAINTEXT_DOMAIN,
  MAX_HOST_PROOF_CHALLENGE_WINDOW_MS,
  PING_INTERVAL_MS,
} from "../shared/protocol.js";
import {
  CloseCode,
  type HostHelloMessage,
  type HostChallengeMessage,
  type HostChallengeAckMessage,
  type HostHelloAckMessage,
  type RelayHelloInvite,
  type HostDataAuthMessage,
  type ControlErrorMessage,
  type OpaqueId,
  type Base6432Byte,
  type Base64Url32Byte,
  type Base64Raw24Byte,
  type EpochMs,
  type PendingConn,
  type RelayAuthMessage,
} from "../shared/types.js";

// ------------------------------------------------------------------ helpers

function generateId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function generateBase64Url32(): Base64Url32Byte {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "") as Base64Url32Byte;
}

function toBase64Raw24(nonce: Uint8Array): Base64Raw24Byte {
  let s = "";
  for (let i = 0; i < nonce.length; i++) s += String.fromCharCode(nonce[i]);
  return btoa(s) as Base64Raw24Byte;
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function fromBase64Url(b64: string): Uint8Array {
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const std = b64.replace(/-/g, "+").replace(/_/g, "/") + pad;
  return fromBase64(std);
}

function encodeString(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

// ------------------------------------------------------------------ types

interface CellEnv {
  CELL: DurableObjectNamespace;
  FABRICA_RELAY_LEASE_MS?: string;
}

// Host lease duration (also used as drain graceMs). Configurable via
// FABRICA_RELAY_LEASE_MS; clamped to sane bounds, default unchanged.
const DEFAULT_LEASE_MS = 3_600_000;
const MIN_LEASE_MS = 5_000;
const MAX_LEASE_MS = 3_600_000;

function resolveLeaseMs(raw: string | undefined): number {
  const n = raw === undefined ? NaN : Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_LEASE_MS;
  return Math.min(MAX_LEASE_MS, Math.max(MIN_LEASE_MS, Math.floor(n)));
}

interface RuntimeState {
  stored: StoredHostState;
  hostPublicKey: Uint8Array;
  relayJwt?: string;
  pendingInvites: Map<string, { token: string; attempts: number; createdAt: number }>;
  deviceCredentials: Map<string, { pubKey: string; createdAt: number; version: number }>;
  pendingConns: PendingConn[];
  activeConnIds: string[];
}

interface PendingChallenge {
  challengeId: OpaqueId;
  secret: Uint8Array;
  transcript: Uint8Array;
  expiresAt: EpochMs;
  hostPublicKey: Uint8Array;
  ephemeralSecretKey: Uint8Array;
}

interface PhoneConn {
  relayDeviceId: string;
  relayHostId: string;
}

interface DataConn {
  connId: string;
  authed: boolean;
  phoneDeviceId?: string;
  relayHostId: string;
}

// Sockets are registered via the hibernation API (ctx.acceptWebSocket) so
// close/error events are always delivered and idle data sockets may
// hibernate. Socket stubs are rehydrated per event, so routing uses tags
// (set at accept time) and per-socket attachments — never object identity.
const TYPE_TAGS = new Set(["control", "phone"]);

function tagForConn(connId: string): string {
  return `conn:${connId}`;
}

function connIdFromTags(tags: string[]): string | undefined {
  for (const t of tags) {
    if (t.startsWith("conn:")) return t.slice("conn:".length);
  }
  return undefined;
}

// ------------------------------------------------------------ transcript builder

// The transcript is a binary-encoded struct with these fields (length-prefixed UTF-8 strings, 8-byte big-endian numbers):
// protocol, version, relayOrigin, relayEphemeralPublicKey, challengeNonce, challengeId,
// userId, profileId, organizationId, relayHostId, hostPublicKey, assignmentEpoch,
// previousGeneration, resumeRequested, issuedAt, expiresAt

function buildTranscript(fields: {
  protocol: string;
  version: number;
  relayOrigin: string;
  relayEphemeralPublicKey: Uint8Array;
  challengeNonce: Uint8Array;
  challengeId: string;
  userId: string;
  profileId: string;
  organizationId: string;
  relayHostId: string;
  hostPublicKey: Uint8Array;
  assignmentEpoch: number;
  previousGeneration: number;
  resumeRequested: boolean;
  issuedAt: number;
  expiresAt: number;
}): Uint8Array {
  const parts: Uint8Array[] = [];
  const encoder = new TextEncoder();

  // String fields: 4-byte LE length + UTF-8 bytes
  const stringFields = [
    fields.protocol,
    String(fields.version),
    fields.relayOrigin,
    fields.challengeId,
    fields.userId,
    fields.profileId,
    fields.organizationId,
    fields.relayHostId,
  ];
  for (const s of stringFields) {
    const encoded = encoder.encode(s);
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, encoded.length, true);
    parts.push(len);
    parts.push(encoded);
  }

  // Binary fields: 4-byte LE length + raw bytes
  const binaryFields = [
    fields.relayEphemeralPublicKey,
    fields.challengeNonce,
    fields.hostPublicKey,
  ];
  for (const b of binaryFields) {
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, b.length, true);
    parts.push(len);
    parts.push(b);
  }

  // Numeric fields: 8-byte LE
  const numFields = [
    BigInt(fields.assignmentEpoch),
    BigInt(fields.previousGeneration),
    BigInt(fields.resumeRequested ? 1 : 0),
    BigInt(fields.issuedAt),
    BigInt(fields.expiresAt),
  ];
  for (const n of numFields) {
    const buf = new Uint8Array(8);
    new DataView(buf.buffer).setBigUint64(0, n, true);
    parts.push(buf);
  }

  const totalLen = parts.reduce((sum, p) => sum + p.length, 0);
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const p of parts) {
    result.set(p, offset);
    offset += p.length;
  }
  return result;
}

// ------------------------------------------------------------ Cell DO

export class Cell extends DurableObject<CellEnv> {
  private store: CellStore;
  private hosts: Map<string, RuntimeState> = new Map();
  private controlWss: Map<string, WebSocket> = new Map();
  private pendingChallenges: Map<string, PendingChallenge> = new Map();
  private phoneConns: Map<string, PhoneConn> = new Map();
  private dataConns: Map<string, DataConn> = new Map();
  private connHost: Map<string, string> = new Map();
  private connPhone: Map<string, string> = new Map();
  private pingTimers: Map<string, ReturnType<typeof setInterval>> = new Map();
  private leaseTimers: Map<string, ReturnType<typeof setInterval>> = new Map();
  private readonly leaseMs: number;
  private logger = createLogger("cell");

  private static readonly MAX_ACTIVE_CONNS = 8;
  private static readonly MAX_PENDING_CONNS = 8;

  constructor(ctx: DurableObjectState, env: CellEnv) {
    super(ctx, env);
    this.leaseMs = resolveLeaseMs(env.FABRICA_RELAY_LEASE_MS);
    this.store = new CellStore(ctx);
    const rows = this.store.getAllHostStates();
    for (const s of rows) {
      this.hosts.set(s.relayHostId, {
        stored: s,
        hostPublicKey: new Uint8Array(0),
        pendingInvites: this.store.getInvites(s.relayHostId),
        deviceCredentials: this.store.getCredentials(s.relayHostId),
        pendingConns: this.store.getPendingConns(s.relayHostId),
        activeConnIds: [],
      });
    }
  }

  // ------------------------------------------------------------- DO fetch (internal RPCs)

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/resolve-resume") {
      return this.handleResolveResume(request);
    }

    const upgrade = request.headers.get("Upgrade");
    if (upgrade && upgrade.toLowerCase() === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair) as unknown as [WebSocket, WebSocket];
      const path = url.pathname;
      // Hibernation API: events route to the class-level webSocketMessage/
      // webSocketClose handlers; tags identify the socket across events.
      // Control sockets stay awake via the 15s ping timer; data sockets may
      // hibernate when idle. The peer's close handshake is completed in
      // webSocketClose via an explicit ws.close().
      if (path === "/v1/host/control") {
        this.ctx.acceptWebSocket(server, ["control"]);
      } else if (path.startsWith("/v1/host/data/")) {
        const connId = path.slice("/v1/host/data/".length);
        this.registerDataConn(connId);
        this.ctx.acceptWebSocket(server, ["data", tagForConn(connId)]);
      } else if (path.startsWith("/v1/connect/")) {
        const relayHostId = decodeURIComponent(path.slice("/v1/connect/".length));
        this.ctx.acceptWebSocket(server, ["phone", `host:${relayHostId}`]);
        // Remember the public origin so a relay-moved reply can name it
        try {
          server.serializeAttachment({ relayHostId, origin: url.origin });
        } catch {
          /* attachment optional — relay-moved just skipped if unset */
        }
      } else {
        return new Response("Not Found", { status: 404 });
      }
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response("Not Found", { status: 404 });
  }

  // ------------------------------------------------------------- WebSocket lifecycle

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void | Promise<void> {
    const tags = this.ctx.getTags(ws);
    if (tags.includes("control")) {
      this.handleControlMessage(ws, message);
    } else if (tags.includes("phone")) {
      this.handlePhoneMessage(ws, message);
    } else if (tags.includes("data")) {
      this.handleDataMessage(ws, message);
    }
  }

  webSocketClose(
    ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): void | Promise<void> {
    const tags = this.ctx.getTags(ws);
    if (tags.includes("control")) {
      this.handleControlClose(ws);
    } else if (tags.includes("phone")) {
      this.handlePhoneClose(ws);
    } else if (tags.includes("data")) {
      this.handleDataClose(ws);
    }
    // Complete the closing handshake — without an explicit ws.close() the
    // peer's close event stalls until the runtime gives up
    try {
      ws.close(1000, "");
    } catch {
      /* already closed */
    }
  }

  webSocketError(ws: WebSocket, _error: unknown): void | Promise<void> {
    const tags = this.ctx.getTags(ws);
    if (tags.includes("control")) {
      this.handleControlClose(ws);
    } else if (tags.includes("phone")) {
      this.handlePhoneClose(ws);
    } else if (tags.includes("data")) {
      this.handleDataClose(ws);
    }
  }

  private async handleResolveResume(request: Request): Promise<Response> {
    const body = (await request.json()) as { resumeToken?: string; relayHostId?: string };
    const runtime = body.relayHostId ? this.hosts.get(body.relayHostId) : undefined;
    if (!body.resumeToken || !runtime) {
      return Response.json({ ok: false });
    }
    // cellUrl must be the public worker origin — the internal RPC URL
    // (http://do) is not dialable by clients
    const publicOrigin =
      request.headers.get("X-Fabrica-Public-Origin") ?? new URL(request.url).origin;
    return Response.json({
      ok: true,
      cellUrl: publicOrigin,
      assignmentEpoch: runtime.stored.assignmentEpoch,
      leaseExpiresAt: runtime.stored.leaseExpiresAt,
    });
  }

  // ------------------------------------------------------------- host resolution

  private resolveHostId(ws: WebSocket): string | undefined {
    // Control sockets learn their host id at host-hello (stored as a
    // per-socket attachment); phone/data sockets carry it in their tags
    try {
      const att = ws.deserializeAttachment() as { relayHostId?: string } | undefined;
      if (att?.relayHostId) return att.relayHostId;
    } catch {
      /* no attachment set yet */
    }
    const tags = this.ctx.getTags(ws);
    for (const t of tags) {
      if (t.startsWith("host:")) return t.slice("host:".length);
    }
    return undefined;
  }

  // ------------------------------------------------------------- WebSocket lifecycle

  // ------------------------------------------------------------- Host control channel

  private handleControlMessage(ws: WebSocket, raw: string | ArrayBuffer): void {
    if (typeof raw !== "string") {
      ws.close(CloseCode.BAD_OUTER_CREDENTIAL, "expected JSON");
      return;
    }

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      ws.close(CloseCode.BAD_OUTER_CREDENTIAL, "invalid JSON");
      return;
    }

    const relayHostId = this.resolveHostId(ws);
    const runtime = relayHostId ? this.hosts.get(relayHostId) : undefined;
    const pendingChallenge = relayHostId ? this.pendingChallenges.get(relayHostId) : undefined;

    // Phase 1: waiting for host-hello
    if (!relayHostId || (!runtime && !pendingChallenge)) {
      if (msg.type !== "host-hello") {
        ws.close(CloseCode.BAD_OUTER_CREDENTIAL, "expected host-hello");
        return;
      }
      this.handleHostHello(ws, msg as unknown as HostHelloMessage);
      return;
    }

    // Phase 2: waiting for host-challenge-ack
    if (pendingChallenge) {
      if (msg.type !== "host-challenge-ack") {
        ws.close(CloseCode.BAD_OUTER_CREDENTIAL, "expected host-challenge-ack");
        return;
      }
      this.handleHostChallengeAck(ws, msg as unknown as HostChallengeAckMessage, relayHostId);
      return;
    }

    // Phase 3: authenticated control channel
    switch (msg.type) {
      case "pong":
        break; // just acknowledge
      case "auth-refresh":
        this.handleAuthRefresh(relayHostId, msg as { relayJwt: string });
        break;
      case "invite-create":
        this.handleInviteCreate(ws, relayHostId, msg as Record<string, unknown>);
        break;
      case "device-credential-install":
        this.handleDeviceCredentialInstall(ws, relayHostId, msg as Record<string, unknown>);
        break;
      case "device-credential-install-status":
        this.handleDeviceCredentialInstallStatus(ws, relayHostId, msg as Record<string, unknown>);
        break;
      case "device-revoke":
        this.handleDeviceRevoke(ws, relayHostId, msg as Record<string, unknown>);
        break;
      case "device-resume-confirm":
        this.handleDeviceResumeConfirm(ws, relayHostId, msg as Record<string, unknown>);
        break;
      default:
        this.sendControlError(ws, (msg as { reqId?: string }).reqId, "unknown-message");
    }
  }

  private handleHostHello(ws: WebSocket, msg: HostHelloMessage): void {
    if (msg.v !== 1 || !msg.relayHostId || !msg.hostPublicKeyB64 || !msg.assignmentEpoch) {
      ws.close(CloseCode.BAD_OUTER_CREDENTIAL, "invalid host-hello");
      return;
    }

    const relayHostId = msg.relayHostId;
    const previousGeneration = msg.previousGeneration ?? 0;
    const existing = this.hosts.get(relayHostId);
    const currentGen = existing?.stored.generation ?? 1;

    if (previousGeneration > 0) {
      // Rebind path — must match current generation and resume secret
      if (
        previousGeneration !== currentGen ||
        !existing ||
        msg.controlResumeSecret !== existing.stored.controlResumeSecret
      ) {
        ws.close(CloseCode.WRONG_CELL, "generation mismatch");
        return;
      }
      // Valid rebind — increment generation and rotate the resume secret
      existing.stored.generation = currentGen + 1;
      existing.stored.controlResumeSecret = generateBase64Url32();
      this.store.putHostState(relayHostId, existing.stored);
      this.logger.info("rebind accepted", { relayHostId, generation: existing.stored.generation });
    }

    // Store host public key
    const hostPublicKey = fromBase64(msg.hostPublicKeyB64);

    // Generate ephemeral X25519 keypair
    const ephemeralKp = nacl.box.keyPair();
    const nonce = nacl.randomBytes(nacl.box.nonceLength);

    // Build challenge
    const challengeId = generateId() as OpaqueId;
    const secret = nacl.randomBytes(32);
    const issuedAt = Date.now();
    const expiresAt = issuedAt + MAX_HOST_PROOF_CHALLENGE_WINDOW_MS;

    const transcript = buildTranscript({
      protocol: HOST_CHALLENGE_PLAINTEXT_DOMAIN,
      version: 1,
      relayOrigin: "fabrica-relay",
      relayEphemeralPublicKey: ephemeralKp.publicKey,
      challengeNonce: nonce,
      challengeId,
      userId: "",
      profileId: "",
      organizationId: "",
      relayHostId,
      hostPublicKey,
      assignmentEpoch: msg.assignmentEpoch,
      previousGeneration,
      resumeRequested: !!msg.controlResumeSecret,
      issuedAt,
      expiresAt,
    });

    // Plaintext = domain\0 + transcript + secret
    const domainBytes = encodeString(HOST_CHALLENGE_PLAINTEXT_DOMAIN);
    const domainZero = new Uint8Array(domainBytes.length + 1);
    domainZero.set(domainBytes);
    // domainZero[domainBytes.length] = 0; // already 0

    const plaintext = new Uint8Array(domainZero.length + transcript.length + secret.length);
    plaintext.set(domainZero, 0);
    plaintext.set(transcript, domainZero.length);
    plaintext.set(secret, domainZero.length + transcript.length);

    // Encrypt with NaCl box
    const ciphertext = nacl.box(
      plaintext,
      nonce,
      hostPublicKey,
      ephemeralKp.secretKey,
    );

    // Send host-challenge
    const challengeMsg: HostChallengeMessage = {
      type: "host-challenge",
      challengeId,
      relayEphemeralPublicKeyB64: toBase64(ephemeralKp.publicKey) as Base6432Byte,
      nonceB64: toBase64Raw24(nonce) as Base64Raw24Byte,
      ciphertextB64: toBase64(ciphertext),
      expiresAt: expiresAt as EpochMs,
    };
    ws.send(JSON.stringify(challengeMsg));

    // Store pending challenge (per host)
    this.pendingChallenges.set(relayHostId, {
      challengeId,
      secret,
      transcript,
      expiresAt: expiresAt as EpochMs,
      hostPublicKey,
      ephemeralSecretKey: ephemeralKp.secretKey,
    });

    // Persist host state so it survives DO restarts
    const finalGen = existing ? existing.stored.generation : 1;
    const stored: StoredHostState = {
      relayHostId,
      assignmentEpoch: msg.assignmentEpoch,
      generation: finalGen,
      controlResumeSecret: existing?.stored.controlResumeSecret ?? generateBase64Url32(),
      leaseExpiresAt: Date.now() + this.leaseMs,
      appVersion: msg.appVersion ?? "",
    };
    this.store.putHostState(relayHostId, stored);

    this.hosts.set(relayHostId, {
      stored,
      hostPublicKey,
      relayJwt: undefined,
      pendingInvites: this.store.getInvites(relayHostId),
      deviceCredentials: this.store.getCredentials(relayHostId),
      pendingConns: this.store.getPendingConns(relayHostId),
      activeConnIds: existing?.activeConnIds ?? [],
    });

    // Remember the host id on this socket so lifecycle handlers can resolve it.
    ws.serializeAttachment({ relayHostId });
  }

  private async handleHostChallengeAck(
    ws: WebSocket,
    msg: HostChallengeAckMessage,
    relayHostId: string,
  ): Promise<void> {
    const runtime = this.hosts.get(relayHostId);
    const challenge = this.pendingChallenges.get(relayHostId);
    if (!challenge || !runtime) {
      ws.close(CloseCode.BAD_OUTER_CREDENTIAL, "no pending challenge");
      return;
    }

    // Check expiry
    if (Date.now() > challenge.expiresAt) {
      ws.close(CloseCode.BAD_OUTER_CREDENTIAL, "challenge expired");
      this.pendingChallenges.delete(relayHostId);
      return;
    }

    // Verify challenge ID matches
    if (msg.challengeId !== challenge.challengeId) {
      ws.close(CloseCode.BAD_OUTER_CREDENTIAL, "challenge ID mismatch");
      this.pendingChallenges.delete(relayHostId);
      return;
    }

    // Verify proof: HMAC-SHA256(secret, "FABRICA-relay-host-proof/v1\0ack\0" + transcript)
    const prefix = encodeString(`${HOST_PROOF_TRANSCRIPT_DOMAIN}\x00ack\x00`);
    const proofData = new Uint8Array(prefix.length + challenge.transcript.length);
    proofData.set(prefix, 0);
    proofData.set(challenge.transcript, prefix.length);

    const expectedProof = await hmacSha256Bytes(challenge.secret, proofData);
    const providedProof = fromBase64(msg.proofB64);

    if (!timingSafeEqual(expectedProof, providedProof)) {
      ws.close(CloseCode.BAD_OUTER_CREDENTIAL, "invalid proof");
      this.pendingChallenges.delete(relayHostId);
      return;
    }

    // Auth success — clear pending challenge and bind the control socket
    this.pendingChallenges.delete(relayHostId);
    this.controlWss.set(relayHostId, ws);

    // Send host-hello-ack
    const ackMsg: HostHelloAckMessage = {
      type: "host-hello-ack",
      v: 1,
      generation: runtime.stored.generation,
      controlResumeSecret: runtime.stored.controlResumeSecret as Base64Url32Byte,
      leaseExpiresAt: runtime.stored.leaseExpiresAt as EpochMs,
      activeConnIds: runtime.activeConnIds.slice(0, 8) as OpaqueId[],
      pendingConns: runtime.pendingConns.slice(0, 8),
    };
    ws.send(JSON.stringify(ackMsg));

    // Start per-host ping/lease timers
    this.startPingInterval(relayHostId, ws);
    this.startLeaseTimer(relayHostId);
  }

  private handleControlClose(ws: WebSocket): void {
    const relayHostId = this.resolveHostId(ws);
    if (!relayHostId) return;
    // Only tear down if this is the active control socket for the host
    if (this.controlWss.get(relayHostId) !== ws) return;
    this.controlWss.delete(relayHostId);
    this.stopPingInterval(relayHostId);
    this.stopLeaseTimer(relayHostId);
    this.pendingChallenges.delete(relayHostId);
    // Don't clear hostState — host may reconnect
  }

  private handleAuthRefresh(relayHostId: string, msg: { relayJwt: string }): void {
    const runtime = this.hosts.get(relayHostId);
    if (runtime) {
      runtime.relayJwt = msg.relayJwt;
    }
  }

  private sendControlError(ws: WebSocket, reqId: string | undefined, code: string): void {
    const errMsg: ControlErrorMessage = {
      type: "control-error",
      reqId: reqId as OpaqueId | undefined,
      code,
    };
    ws.send(JSON.stringify(errMsg));
  }

  // ------------------------------------------------------------- Device management RPCs

  private handleInviteCreate(ws: WebSocket, relayHostId: string, msg: Record<string, unknown>): void {
    const reqId = msg.reqId as string | undefined;
    const runtime = this.hosts.get(relayHostId);
    if (!runtime) {
      this.sendControlError(ws, reqId, "not-authenticated");
      return;
    }
    const inviteToken = generateBase64Url32();
    const maxAttempts = 16;
    runtime.pendingInvites.set(inviteToken, {
      token: inviteToken,
      attempts: 0,
      createdAt: Date.now(),
    });
    this.store.putInvite(relayHostId, { token: inviteToken, attempts: 0, createdAt: Date.now() });
    ws.send(JSON.stringify({
      type: "invite-created",
      reqId,
      inviteToken,
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      maxAttempts,
    }));
  }

  private handleDeviceCredentialInstall(
    ws: WebSocket,
    relayHostId: string,
    msg: Record<string, unknown>,
  ): void {
    const reqId = msg.reqId as string | undefined;
    const runtime = this.hosts.get(relayHostId);
    if (!runtime) {
      this.sendControlError(ws, reqId, "not-authenticated");
      return;
    }
    // Client wire shape: { type:'device-credential-install', v:1, reqId,
    // relayDeviceId, newResumeTokenHash, authorization } (see
    // Fabrica-app relay-control-requests.ts installCredential)
    const relayDeviceId = msg.relayDeviceId as string | undefined;
    if (!relayDeviceId) {
      this.sendControlError(ws, reqId, "missing-relay-device-id");
      return;
    }
    const newResumeTokenHash = msg.newResumeTokenHash as string | undefined;
    if (!newResumeTokenHash) {
      this.sendControlError(ws, reqId, "missing-new-resume-token-hash");
      return;
    }
    runtime.deviceCredentials.set(relayDeviceId, {
      pubKey: newResumeTokenHash,
      createdAt: Date.now(),
      version: 1,
    });
    this.store.putCredential(relayHostId, {
      deviceId: relayDeviceId,
      pubKey: newResumeTokenHash,
      createdAt: Date.now(),
      version: 1,
    });
    ws.send(JSON.stringify({
      type: "device-credential-installed",
      v: 1,
      reqId,
      authorizationMode: "relay-basis",
      currentVersion: 1,
      resumeExpiresAt: Date.now() + this.leaseMs,
    }));
  }

  private handleDeviceCredentialInstallStatus(
    ws: WebSocket,
    relayHostId: string,
    msg: Record<string, unknown>,
  ): void {
    const reqId = msg.reqId as string | undefined;
    const deviceId = (msg.relayDeviceId ?? msg.basisConnId) as string;
    if (!deviceId) {
      this.sendControlError(ws, reqId, "missing-device-id");
      return;
    }
    const runtime = this.hosts.get(relayHostId);
    const cred = runtime?.deviceCredentials.get(deviceId);
    if (cred) {
      ws.send(JSON.stringify({
        type: "device-credential-install-status-result",
        v: 1,
        reqId,
        state: "committed",
        result: {
          v: 1,
          reqId,
          authorizationMode: "relay-basis",
          currentVersion: cred.version,
          resumeExpiresAt: Date.now() + this.leaseMs,
        },
      }));
    } else {
      ws.send(JSON.stringify({
        type: "device-credential-install-status-result",
        v: 1,
        reqId,
        state: "not-found",
      }));
    }
  }

  private handleDeviceRevoke(
    ws: WebSocket,
    relayHostId: string,
    msg: Record<string, unknown>,
  ): void {
    const reqId = msg.reqId as string | undefined;
    const deviceId = (msg.relayDeviceId ?? msg.basisConnId) as string;
    if (!deviceId) {
      this.sendControlError(ws, reqId, "missing-device-id");
      return;
    }
    const runtime = this.hosts.get(relayHostId);
    if (runtime) {
      runtime.deviceCredentials.delete(deviceId);
    }
    this.store.deleteCredential(relayHostId, deviceId);
    ws.send(JSON.stringify({
      type: "device-revoked",
      reqId,
    }));
  }

  private handleDeviceResumeConfirm(
    ws: WebSocket,
    _relayHostId: string,
    msg: Record<string, unknown>,
  ): void {
    const reqId = msg.reqId as string | undefined;
    const deviceId = (msg.relayDeviceId ?? msg.basisConnId) as string;
    if (!deviceId) {
      this.sendControlError(ws, reqId, "missing-device-id");
      return;
    }
    ws.send(JSON.stringify({
      type: "device-resume-confirmed",
      v: 1,
      reqId,
      currentVersion: 1,
      acceptedAs: "current",
      renewed: false,
      resumeExpiresAt: Date.now() + this.leaseMs,
    }));
  }

  // ------------------------------------------------------------- Ping/Pong

  private startPingInterval(relayHostId: string, ws: WebSocket): void {
    this.stopPingInterval(relayHostId);
    const timer = setInterval(() => {
      try {
        const ping = { type: "ping" as const, t: Date.now() as EpochMs };
        ws.send(JSON.stringify(ping));
      } catch {
        this.stopPingInterval(relayHostId);
      }
    }, PING_INTERVAL_MS);
    this.pingTimers.set(relayHostId, timer);
  }

  private stopPingInterval(relayHostId: string): void {
    const timer = this.pingTimers.get(relayHostId);
    if (timer !== undefined) {
      clearInterval(timer);
      this.pingTimers.delete(relayHostId);
    }
  }

  // ------------------------------------------------------------- lease expiry / drain

  private checkLeaseExpiry(relayHostId: string): void {
    const runtime = this.hosts.get(relayHostId);
    const controlWs = this.controlWss.get(relayHostId);
    if (!runtime || !controlWs) return;
    // Warn shortly before expiry — with short leases the window scales down
    const drainWindowMs = Math.min(60_000, Math.floor(this.leaseMs / 2));
    if (Date.now() >= runtime.stored.leaseExpiresAt - drainWindowMs) {
      try {
        controlWs.send(JSON.stringify({
          type: "drain",
          graceMs: this.leaseMs,
          recovery: "resolve-director",
        }));
      } catch {
        this.stopLeaseTimer(relayHostId);
        return;
      }
      runtime.stored.leaseExpiresAt = Date.now() + this.leaseMs;
      this.store.putHostState(relayHostId, runtime.stored);
    }
  }

  private startLeaseTimer(relayHostId: string): void {
    this.stopLeaseTimer(relayHostId);
    // Poll at least 4x per lease so the drain fires before expiry even for
    // short test leases; production (1h) keeps the 30s cadence
    const pollMs = Math.min(30_000, Math.max(1_000, Math.floor(this.leaseMs / 4)));
    const timer = setInterval(() => this.checkLeaseExpiry(relayHostId), pollMs);
    this.leaseTimers.set(relayHostId, timer);
  }

  private stopLeaseTimer(relayHostId: string): void {
    const timer = this.leaseTimers.get(relayHostId);
    if (timer !== undefined) {
      clearInterval(timer);
      this.leaseTimers.delete(relayHostId);
    }
  }

  // ------------------------------------------------------------- Phone cell connection

  private handlePhoneMessage(ws: WebSocket, raw: string | ArrayBuffer): void {
    if (typeof raw !== "string") {
      // Binary data from phone — forward to host data socket
      this.forwardPhoneToHost(ws, raw);
      return;
    }

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      ws.close(CloseCode.BAD_OUTER_CREDENTIAL, "invalid JSON");
      return;
    }

    // First message decides the leg: relay-auth => cell invite flow;
    // anything else is an invite-recovery probe (director leg) and gets
    // relay-moved with the current assignment
    const phoneConn = this.phoneConnForSocket(ws);
    if (!phoneConn) {
      if (msg.type !== "relay-auth") {
        this.sendRelayMoved(ws);
        return;
      }
      this.handlePhoneAuth(ws, msg);
      return;
    }

    // Subsequent messages — forward to host data socket (JSON or text)
    this.forwardPhoneToHost(ws, raw);
  }

  // Invite-recovery (director leg): reply {type:'relay-moved', v:1, cellUrl,
  // assignmentEpoch} per the client contract (RelayMovedSchema — cellUrl must
  // be a canonical https origin; the client requires a strictly-newer epoch)
  private sendRelayMoved(ws: WebSocket): void {
    const relayHostId = this.resolveHostId(ws);
    const runtime = relayHostId ? this.hosts.get(relayHostId) : undefined;
    let origin = "";
    try {
      const att = ws.deserializeAttachment() as { origin?: string } | undefined;
      origin = att?.origin ?? "";
    } catch {
      /* no attachment set */
    }
    if (!origin) {
      ws.close(CloseCode.BAD_OUTER_CREDENTIAL, "unknown origin");
      return;
    }
    try {
      ws.send(
        JSON.stringify({
          type: "relay-moved",
          v: 1 as const,
          cellUrl: origin,
          assignmentEpoch: runtime?.stored.assignmentEpoch ?? Date.now(),
        }),
      );
      ws.close(1000, "");
    } catch {
      /* already closed */
    }
  }

  private phoneConnForSocket(ws: WebSocket): PhoneConn | undefined {
    try {
      const att = ws.deserializeAttachment() as { relayDeviceId?: string } | undefined;
      if (att?.relayDeviceId) return this.phoneConns.get(att.relayDeviceId);
    } catch {
      /* no attachment yet */
    }
    return undefined;
  }

  // Live server-side stub for a registered phone socket (fresh lookups are
  // required because hibernated sockets are rehydrated per event)
  private findPhoneSocket(deviceId: string | undefined): WebSocket | undefined {
    for (const ws of this.ctx.getWebSockets("phone")) {
      try {
        const att = ws.deserializeAttachment() as { relayDeviceId?: string } | undefined;
        if (!deviceId) return ws;
        if (att?.relayDeviceId === deviceId) return ws;
      } catch {
        continue;
      }
    }
    return undefined;
  }

  private forwardPhoneToHost(phoneWs: WebSocket, data: string | ArrayBuffer): void {
    const phoneConn = this.phoneConnForSocket(phoneWs);
    if (!phoneConn) return;
    // Find the authed data channel belonging to this phone's connection
    for (const dataConn of this.dataConns.values()) {
      if (dataConn.authed && dataConn.relayHostId === phoneConn.relayHostId
          && dataConn.phoneDeviceId === phoneConn.relayDeviceId) {
        const target = this.ctx.getWebSockets(tagForConn(dataConn.connId))[0];
        if (target) {
          try {
            target.send(data);
          } catch {
            phoneWs.close(CloseCode.PEER_DROPPED, "host disconnected");
          }
        }
        return;
      }
    }
  }

  private handlePhoneAuth(ws: WebSocket, msg: Record<string, unknown>): void {
    const relayHostId = this.resolveHostId(ws);
    if (!relayHostId) {
      ws.close(CloseCode.BAD_OUTER_CREDENTIAL, "unknown host");
      return;
    }
    const runtime = this.hosts.get(relayHostId);
    const authMsg = msg as unknown as RelayAuthMessage;

    // Extract credential from auth message (client sends {type:'relay-auth', v:1, mode:'connect', credential})
    const credential = (authMsg as Record<string, unknown>).credential as string | undefined;
    if (!credential) {
      ws.close(CloseCode.BAD_OUTER_CREDENTIAL, "missing credential");
      return;
    }

    // Use credential as the phone connection key
    const relayDeviceId = credential;

    // Store phone connection (per host)
    this.phoneConns.set(relayDeviceId, { relayDeviceId, relayHostId });
    // Remember this socket's device/host so later events can resolve it
    ws.serializeAttachment({ relayDeviceId, relayHostId });

    // Check connection limits before notifying host
    const pendingCount = runtime?.pendingConns.length ?? 0;
    const activeCount = runtime?.activeConnIds.length ?? 0;
    if (pendingCount >= Cell.MAX_PENDING_CONNS || activeCount >= Cell.MAX_ACTIVE_CONNS) {
      const helloMsg = {
        type: "relay-hello" as const,
        ok: false as const,
        code: 4429,
      };
      ws.send(JSON.stringify(helloMsg));
      ws.close(CloseCode.LIMIT_EXCEEDED, "connection limit");
      this.phoneConns.delete(relayDeviceId);
      return;
    }

    // Send relay-hello
    const helloMsg: RelayHelloInvite = {
      type: "relay-hello",
      ok: true,
      credentialKind: "invite",
      leaseExpiresAt: (Date.now() + this.leaseMs) as EpochMs,
    };
    ws.send(JSON.stringify(helloMsg));

    // Notify host of new phone connection
    const controlWs = this.controlWss.get(relayHostId);
    if (controlWs && runtime) {
      const connId = generateId() as OpaqueId;
      const connTicket = generateBase64Url32();
      runtime.pendingConns.push({ connId, connTicket });
      this.store.putPendingConn(relayHostId, { connId, connTicket });
      this.connHost.set(connId, relayHostId);
      this.connPhone.set(connId, relayDeviceId);
      controlWs.send(JSON.stringify({
        type: "conn-open",
        connId,
        connTicket,
        kind: "invite",
        relayDeviceId: relayDeviceId as OpaqueId,
        attachDeadlineMs: 30000,
      }));
    }
  }

  private handlePhoneClose(ws: WebSocket): void {
    const phoneConn = this.phoneConnForSocket(ws);
    if (phoneConn) {
      this.phoneConns.delete(phoneConn.relayDeviceId);
    }
  }

  // ------------------------------------------------------------- Data channel

  private connIdForSocket(ws: WebSocket): string | undefined {
    return connIdFromTags(this.ctx.getTags(ws));
  }

  private handleDataMessage(ws: WebSocket, raw: string | ArrayBuffer): void {
    const connId = this.connIdForSocket(ws);
    const dataConn = connId ? this.dataConns.get(connId) : undefined;
    if (!dataConn) {
      ws.close(CloseCode.BAD_OUTER_CREDENTIAL, "unknown data connection");
      return;
    }

    if (!dataConn.authed) {
      // Expect host-data-auth
      if (typeof raw !== "string") {
        ws.close(CloseCode.BAD_OUTER_CREDENTIAL, "expected host-data-auth JSON");
        return;
      }

      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw);
      } catch {
        ws.close(CloseCode.BAD_OUTER_CREDENTIAL, "invalid JSON");
        return;
      }

      if (msg.type !== "host-data-auth") {
        ws.close(CloseCode.BAD_OUTER_CREDENTIAL, "expected host-data-auth");
        return;
      }

      const authMsg = msg as unknown as HostDataAuthMessage;
      if (authMsg.v !== 1 || !authMsg.connTicket) {
        ws.close(CloseCode.BAD_OUTER_CREDENTIAL, "invalid host-data-auth");
        return;
      }

      const relayHostId = this.connHost.get(dataConn.connId);
      if (!relayHostId) {
        ws.close(CloseCode.HOST_OFFLINE, "host not found");
        return;
      }
      const runtime = this.hosts.get(relayHostId);
      if (!runtime) {
        ws.close(CloseCode.HOST_OFFLINE, "host not found");
        return;
      }

      // Validate generation matches current host generation
      if (authMsg.generation !== runtime.stored.generation) {
        ws.close(CloseCode.WRONG_CELL, "generation mismatch");
        return;
      }

      // Validate connTicket matches pending connection
      const pendingIdx = runtime.pendingConns.findIndex(
        (pc) => pc.connId === dataConn.connId && pc.connTicket === authMsg.connTicket,
      );
      if (pendingIdx < 0) {
        ws.close(CloseCode.BAD_OUTER_CREDENTIAL, "invalid connTicket");
        return;
      }

      // Remove from pending, add to active
      runtime.pendingConns.splice(pendingIdx, 1);
      this.store.deletePendingConn(relayHostId, dataConn.connId);
      runtime.activeConnIds.push(dataConn.connId);

      // Bind the channel to its phone connection
      const phoneDeviceId = this.connPhone.get(dataConn.connId);
      if (!phoneDeviceId || !this.phoneConns.has(phoneDeviceId)) {
        ws.close(CloseCode.HOST_OFFLINE, "no phone connected");
        return;
      }
      dataConn.authed = true;
      dataConn.relayHostId = relayHostId;
      dataConn.phoneDeviceId = phoneDeviceId;

      return;
    }

    // Forward frames verbatim between host data socket and phone socket
    const target = this.findPhoneSocket(dataConn.phoneDeviceId);
    if (target) {
      try {
        target.send(raw);
      } catch {
        ws.close(CloseCode.PEER_DROPPED, "phone disconnected");
      }
    }
  }

  private handleDataClose(ws: WebSocket): void {
    const id = this.connIdForSocket(ws);
    if (!id) return;
    const conn = this.dataConns.get(id);
    if (!conn) return;
    // Notify phone if connected
    if (conn.authed) {
      const phoneWs = this.findPhoneSocket(conn.phoneDeviceId);
      try {
        phoneWs?.close(CloseCode.PEER_DROPPED, "host data disconnected");
      } catch { /* already closed */ }
    }
    this.dataConns.delete(id);
    // Remove from active connections for the owning host
    if (conn.relayHostId) {
      const runtime = this.hosts.get(conn.relayHostId);
      if (runtime) {
        runtime.activeConnIds = runtime.activeConnIds.filter((cid) => cid !== id);
      }
    }
    this.connHost.delete(id);
    this.connPhone.delete(id);
  }

  private findPhoneForConn(connId: string): PhoneConn | undefined {
    const relayDeviceId = this.connPhone.get(connId);
    if (relayDeviceId) {
      return this.phoneConns.get(relayDeviceId);
    }
    // Fallback: first phone connection (legacy single-phone behavior)
    for (const conn of this.phoneConns.values()) {
      return conn;
    }
    return undefined;
  }

  // ------------------------------------------------------------- Public: register data conn

  registerDataConn(connId: string): void {
    this.dataConns.set(connId, { connId, authed: false, relayHostId: "" });
  }
}

// ---------------------------------------------------------------- Hono app (routes to the DO)

export function createCellApp(): Hono {
  const app = new Hono();

  // WS /v1/host/control — host control channel
  app.get(
    "/v1/host/control",
    upgradeWebSocket((_c) => {
      return {
        onMessage(_evt: MessageEvent, _ws: { send: (data: string | ArrayBuffer) => void }) {
          // Handled by DO webSocketMessage
        },
        onClose(_evt: CloseEvent, _ws: { close: (code?: number, reason?: string) => void }) {
          // Handled by DO webSocketClose
        },
        onError(_evt: Event) {
          // Handled by DO webSocketError
        },
      };
    }),
  );

  // WS /v1/connect/:relayHostId — phone cell connection
  app.get(
    "/v1/connect/:relayHostId",
    upgradeWebSocket((_c) => {
      return {
        onMessage(_evt: MessageEvent, _ws: { send: (data: string | ArrayBuffer) => void }) {
          // Handled by DO
        },
        onClose(_evt: CloseEvent, _ws: { close: (code?: number, reason?: string) => void }) {
          // Handled by DO
        },
        onError(_evt: Event) {
          // Handled by DO
        },
      };
    }),
  );

  // WS /v1/host/data/:connId — data channel
  app.get(
    "/v1/host/data/:connId",
    upgradeWebSocket((_c) => {
      return {
        onMessage(_evt: MessageEvent, _ws: { send: (data: string | ArrayBuffer) => void }) {
          // Handled by DO
        },
        onClose(_evt: CloseEvent, _ws: { close: (code?: number, reason?: string) => void }) {
          // Handled by DO
        },
        onError(_evt: Event) {
          // Handled by DO
        },
      };
    }),
  );

  return app;
}


