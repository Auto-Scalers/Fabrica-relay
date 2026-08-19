# Fabrica-relay — Tasks

> Single source of truth for relay server work. The Roadmap (`.Fabrica-Board/Fabrica-Roadmap.md`) tracks cross-cutting status only — this file owns execution details.

---

## Status Legend

- **DONE** — implemented and verified
- **VERIFY** — implemented, needs verification
- **PARTIAL** — partially implemented
- **TODO** — planned, not started
- **BLOCKED** — waiting on dependency

---

## Phase 1 — Scaffold & Core

> Get the server running locally with basic functionality.

| # | Task | Status | Notes |
|---|------|--------|-------|
| R1 | Initialize repo (package.json, tsconfig, vitest) | **TODO** | |
| R2 | Create shared types (protocol messages, IDs, timestamps) | **TODO** | From relay-control-protocol.ts schemas |
| R3 | Implement Director: `POST /v1/token-exchange` | **TODO** | Validate Fabrica access token, return relay JWT |
| R4 | Implement Director: `POST /v1/assign` | **TODO** | Assign host to cell, return cellUrl + epoch + lease |
| R5 | Implement Cell: WebSocket server setup | **TODO** | `ws` library, JWT auth on connect |
| R6 | Implement Cell: Host challenge-response | **TODO** | NaCl box encryption, HMAC proof verification |
| R7 | Implement Cell: Host activation flow | **TODO** | host-hello → host-challenge → host-challenge-ack → host-hello-ack |
| R8 | Implement Cell: Ping/pong keepalive | **TODO** | 15s ping interval, 75s silence timeout |
| R9 | Implement Cell: Phone relay-hello | **TODO** | Invite + resume credential handling |
| R10 | Unit tests for Director | **TODO** | Token exchange, assign, error cases |
| R11 | Unit tests for Cell | **TODO** | Challenge-response, ping/pong, connection lifecycle |

---

## Phase 2 — Connection Tunneling

> Enable actual data flow between host and phone.

| # | Task | Status | Notes |
|---|------|--------|-------|
| R12 | Implement Cell: conn-open notification | **TODO** | Notify host of new phone connection |
| R13 | Implement Cell: Data channel per connId | **TODO** | Separate WebSocket per connection |
| R14 | Implement Cell: Data tunneling | **TODO** | Forward frames between host↔phone data channels |
| R15 | Implement Cell: Connection cleanup | **TODO** | Close data channels on disconnect |
| R16 | Integration tests for data tunneling | **TODO** | End-to-end host↔phone data flow |

---

## Phase 3 — Device Management

> Handle invite tokens, device credentials, and revocation.

| # | Task | Status | Notes |
|---|------|--------|-------|
| R17 | Implement invite-create request | **TODO** | Generate invite token, track attempts |
| R18 | Implement device-credential-install | **TODO** | Store device credential, manage versioning |
| R19 | Implement device-credential-status | **TODO** | Query device credential state |
| R20 | Implement device-revoke | **TODO** | Revoke device credential |
| R21 | Implement device-resume-confirm | **TODO** | Validate resume token |
| R22 | Device management tests | **TODO** | |

---

## Phase 4 — Production Readiness

> Deploy to Fly.io and make it production-ready.

| # | Task | Status | Notes |
|---|------|--------|-------|
| R23 | Create Dockerfile | **TODO** | Multi-stage build for Fly.io |
| R24 | Add database (SQLite for dev, Postgres for prod) | **TODO** | Leases, device credentials, state |
| R25 | Add graceful shutdown | **TODO** | Drain existing connections on SIGTERM |
| R26 | Add structured logging | **TODO** | JSON logs for Fly.io |
| R27 | Add health check endpoint | **TODO** | `GET /health` |
| R28 | Add rate limiting | **TODO** | Per-IP connection limits |
| R29 | Deploy to Fly.io | **TODO** | `fly deploy`, configure secrets |
| R30 | Update Fabrica-app task file | **TODO** | Mark relay deploy as DONE |

---

## Dependencies & Coordination Rules

1. **Phase 1 must complete before Phase 2** — tunneling requires working Director + Cell
2. **Phase 2 must complete before Phase 3** — device management requires working data channels
3. **Phase 3 must complete before Phase 4** — production deploy requires full feature set
4. **Shared types must be defined first** — all phases depend on protocol schemas
5. **Challenge-response is security-critical** — thorough testing required before deploy

---

## What Needs Verification

- [ ] Director token exchange validates Fabrica access tokens correctly
- [ ] Cell challenge-response prevents replay attacks
- [ ] Data tunneling preserves E2EE (server cannot decrypt)
- [ ] Lease expiry triggers graceful drain
- [ ] Phone connection works with both invite and resume credentials

---

## Session Ledger

> Tracks orchestration sessions and workers for this task file. Updated when sessions are created, released, or worktrees merged.

| Session Handle | Type | Task/Group | Status | Created | Worktree Branch | Merged |
|---------------|------|-----------|--------|---------|----------------|--------|

**Rules:**
- Only the main orchestrator creates sessions in this ledger
- Workers are released after review
- Worktrees are merged immediately after approval
- Never leave orphaned sessions

---

_Created: Aug 2026_
