// Shared protocol types — wire-compatible with Fabrica-app relay-control-protocol.ts

// ---------------------------------------------------------------- close codes

export const CloseCode = {
  BAD_OUTER_CREDENTIAL: 4401,
  HOST_OFFLINE: 4404,
  PEER_DROPPED: 4408,
  WRONG_CELL: 4409,
  LIMIT_EXCEEDED: 4429,
  DRAINING: 4503,
} as const;

export type CloseCode = (typeof CloseCode)[keyof typeof CloseCode];

// ------------------------------------------------------------ core validators

// OpaqueId — string, 1-128 chars
export const OPAQUE_ID_RE = /^[\s\S]{1,128}$/;
export type OpaqueId = string & { readonly __brand: "OpaqueId" };

// Base64Url32Byte — 32 raw bytes, base64url, no padding
export const BASE64URL_32_BYTE_RE = /^[A-Za-z0-9_-]{43}$/;
export type Base64Url32Byte = string & { readonly __brand: "Base64Url32Byte" };

// Base6432Byte — 32 raw bytes, standard base64, padded
export const BASE64_32_BYTE_RE = /^[A-Za-z0-9+/]{43}=$/;
export type Base6432Byte = string & { readonly __brand: "Base6432Byte" };

// Base64Raw24Byte — 24 raw bytes, standard base64, no padding
export const BASE64_RAW_24_BYTE_RE = /^[A-Za-z0-9+/]{32}$/;
export type Base64Raw24Byte = string & { readonly __brand: "Base64Raw24Byte" };

// EpochMs — integer, nonnegative epoch milliseconds
export type EpochMs = number & { readonly __brand: "EpochMs" };

export function isOpaqueId(v: unknown): v is OpaqueId {
  return typeof v === "string" && OPAQUE_ID_RE.test(v);
}

export function isBase64Url32Byte(v: unknown): v is Base64Url32Byte {
  return typeof v === "string" && BASE64URL_32_BYTE_RE.test(v);
}

export function isBase6432Byte(v: unknown): v is Base6432Byte {
  return typeof v === "string" && BASE64_32_BYTE_RE.test(v);
}

export function isBase64Raw24Byte(v: unknown): v is Base64Raw24Byte {
  return typeof v === "string" && BASE64_RAW_24_BYTE_RE.test(v);
}

export function isEpochMs(v: unknown): v is EpochMs {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

// ---------------------------------------------------- control: server -> host

export interface PingMessage {
  type: "ping";
  t: EpochMs;
}

// Client replies to ping; a bare {type:'ping'} fails the client schema
export interface PongMessage {
  type: "pong";
  t: EpochMs;
}

export type ConnOpenKind = "invite" | "resume";

export interface ConnOpenMessage {
  type: "conn-open";
  connId: OpaqueId;
  connTicket: Base64Url32Byte;
  kind: ConnOpenKind;
  relayDeviceId: OpaqueId;
  attachDeadlineMs: number; // <= 60,000
}

export interface DrainMessage {
  type: "drain";
  graceMs: number; // <= 3,600,000
  recovery: "resolve-director";
}

export interface PendingConn {
  connId: OpaqueId;
  connTicket: Base64Url32Byte;
}

export interface HostHelloAckMessage {
  type: "host-hello-ack";
  v: 1;
  generation: number; // > 0
  controlResumeSecret: Base64Url32Byte;
  leaseExpiresAt: EpochMs;
  activeConnIds: OpaqueId[]; // <= 8
  pendingConns: PendingConn[]; // <= 8
}

// ---------------------------------------------------- control: host -> server

export interface HostHelloMessage {
  type: "host-hello";
  v: 1;
  relayHostId: OpaqueId;
  assignmentEpoch: number;
  hostPublicKeyB64: Base6432Byte;
  appVersion: string;
  previousGeneration?: number;
  controlResumeSecret?: Base64Url32Byte;
}

export interface HostChallengeAckMessage {
  type: "host-challenge-ack";
  challengeId: OpaqueId;
  proofB64: string;
}

export interface AuthRefreshMessage {
  type: "auth-refresh";
  relayJwt: string;
}

// ---------------------------------------------------- control: server -> phone

export interface RelayHelloInvite {
  type: "relay-hello";
  ok: true;
  credentialKind: "invite";
  leaseExpiresAt: EpochMs;
}

export interface RelayHelloResume {
  type: "relay-hello";
  ok: true;
  credentialKind: "resume";
  leaseExpiresAt: EpochMs;
  acceptedCredentialVersion: number;
  acceptedAs: "current" | "grace";
  resumeExpiresAt: EpochMs;
  graceExpiresAt?: EpochMs;
}

export interface RelayHelloRejected {
  type: "relay-hello";
  ok: false;
  code: number; // 4000-4999
}

export type RelayHelloMessage = RelayHelloInvite | RelayHelloResume | RelayHelloRejected;

// ------------------------------------------------------ control: host challenge

export interface HostChallengeMessage {
  type: "host-challenge";
  challengeId: OpaqueId;
  relayEphemeralPublicKeyB64: Base6432Byte;
  nonceB64: Base64Raw24Byte;
  ciphertextB64: string; // max 16 KB
  expiresAt: EpochMs;
}

// ------------------------------------------------------ device management RPCs

export type CredentialInstallAuthorization =
  | { mode: "relay-basis"; basisConnId: OpaqueId }
  | { mode: "authenticated-direct"; directAuthId: OpaqueId };

export type CredentialInstallAuthorizationMode = CredentialInstallAuthorization["mode"];

export interface InviteCreateMessage {
  type: "invite-create";
  reqId: OpaqueId;
  relayDeviceId: OpaqueId;
}

export interface InviteCreatedMessage {
  type: "invite-created";
  reqId: OpaqueId;
  inviteToken: Base64Url32Byte;
  expiresAt: EpochMs;
  maxAttempts: number; // <= 16
}

export interface DeviceCredentialInstallMessage {
  type: "device-credential-install";
  v: 1;
  reqId: OpaqueId;
  relayDeviceId: OpaqueId;
  newResumeTokenHash: Base64Url32Byte;
  expectedCurrentHash?: Base64Url32Byte;
  authorization: CredentialInstallAuthorization;
}

export interface DeviceCredentialInstalledPayload {
  v: 1;
  reqId: OpaqueId;
  authorizationMode: CredentialInstallAuthorizationMode;
  currentVersion: number;
  resumeExpiresAt: EpochMs;
  graceExpiresAt?: EpochMs;
}

export interface DeviceCredentialInstalledMessage extends DeviceCredentialInstalledPayload {
  type: "device-credential-installed";
}

export interface DeviceCredentialInstallStatusMessage {
  type: "device-credential-install-status";
  v: 1;
  reqId: OpaqueId;
  relayDeviceId: OpaqueId;
}

export interface DeviceCredentialInstallStatusResultNotFound {
  type: "device-credential-install-status-result";
  v: 1;
  reqId: OpaqueId;
  state: "not-found";
}

export interface DeviceCredentialInstallStatusResultCommitted {
  type: "device-credential-install-status-result";
  v: 1;
  reqId: OpaqueId;
  state: "committed";
  result: DeviceCredentialInstalledPayload;
}

export type DeviceCredentialInstallStatusResultMessage =
  | DeviceCredentialInstallStatusResultNotFound
  | DeviceCredentialInstallStatusResultCommitted;

export interface DeviceRevokeMessage {
  type: "device-revoke";
  reqId: OpaqueId;
  relayDeviceId: OpaqueId;
}

export interface DeviceRevokedMessage {
  type: "device-revoked";
  reqId: OpaqueId;
}

export interface DeviceResumeConfirmMessage {
  type: "device-resume-confirm";
  v: 1;
  reqId: OpaqueId;
  basisConnId: OpaqueId;
}

export interface DeviceResumeConfirmedMessage {
  type: "device-resume-confirmed";
  v: 1;
  reqId: OpaqueId;
  currentVersion: number;
  acceptedAs: "current" | "grace";
  renewed: boolean;
  resumeExpiresAt: EpochMs;
  graceExpiresAt?: EpochMs;
}

export interface ControlErrorMessage {
  type: "control-error";
  reqId?: OpaqueId;
  code: string;
}

// ----------------------------------------------------------- message aggregates

export type ServerToHostControlMessage =
  | PingMessage
  | ConnOpenMessage
  | DrainMessage
  | HostHelloAckMessage
  | HostChallengeMessage
  | InviteCreatedMessage
  | DeviceCredentialInstalledMessage
  | DeviceCredentialInstallStatusResultMessage
  | DeviceRevokedMessage
  | DeviceResumeConfirmedMessage
  | ControlErrorMessage;

export type HostToServerControlMessage =
  | PongMessage
  | HostHelloMessage
  | HostChallengeAckMessage
  | AuthRefreshMessage
  | InviteCreateMessage
  | DeviceCredentialInstallMessage
  | DeviceCredentialInstallStatusMessage
  | DeviceRevokeMessage
  | DeviceResumeConfirmMessage
  | ControlErrorMessage;

// --------------------------------------------------------------- phone auth

// Phone -> server, first message on cell WS
export interface RelayAuthMessage {
  type: "relay-auth";
  [key: string]: unknown;
}

// Host -> server, first message on data socket
export interface HostDataAuthMessage {
  type: "host-data-auth";
  v: 1;
  connTicket: Base64Url32Byte;
  generation: number;
}

// Director WS reply on /v1/connect/<relayHostId> (phone resume recovery)
export interface RelayMovedMessage {
  type: "relay-moved";
  v: 1;
  cellUrl: string;
  assignmentEpoch: number;
}

export type PhoneToServerMessage = RelayAuthMessage;
export type ServerToPhoneMessage = RelayHelloMessage | RelayMovedMessage;

// ------------------------------------------------------------ director HTTP

export interface AssignRequest {
  v: 1;
  relayHostId: OpaqueId;
  reconnect?: boolean;
}

export interface AssignResponse {
  v: 1;
  cellUrl: string;
  assignmentEpoch: number;
  lease: string; // opaque lease token, max 8KB
}

export interface ResolveRequest {
  v: 1;
  relayHostId: OpaqueId;
  resumeToken: Base64Url32Byte;
}

export interface ResolveResponse {
  v: 1;
  cellUrl: string;
  assignmentEpoch: number;
  leaseExpiresAt: EpochMs;
}