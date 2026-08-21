// Shared protocol constants — mirror Fabrica-app relay-control-protocol.ts

// HMAC transcript domain for host challenge-proof computation
export const HOST_PROOF_TRANSCRIPT_DOMAIN = "FABRICA-relay-host-proof/v1";

// Domain separation prefix for host challenge plaintext
export const HOST_CHALLENGE_PLAINTEXT_DOMAIN = "FABRICA-relay-host-challenge/v1";

// Max clock skew tolerated when validating host proof timestamps
export const RELAY_HOST_PROOF_CLOCK_SKEW_MS = 30000;

// Max age of a host proof challenge window
export const MAX_HOST_PROOF_CHALLENGE_WINDOW_MS = 10000;

// Client connect deadline for the control socket
export const RELAY_CONTROL_CONNECT_DEADLINE_MS = 15000;

// Client dies after this much control-channel silence
export const RELAY_CONTROL_SILENCE_LIMIT_MS = 75000;

// Server-driven ping interval on the control channel
export const PING_INTERVAL_MS = 15000;