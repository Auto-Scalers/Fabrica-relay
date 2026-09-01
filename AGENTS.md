# Fabrica-relay — Worker Instructions (AGENTS.md)

## What This Folder Is

This is the **Fabrica relay server** — a standalone WebSocket bridge that enables phone↔desktop communication. You are a worker dispatched by the top-level orchestrator to complete a task in this repo.

## What You Should Know

- This is a **standalone server** — no Electron, no Vercel, no Next.js
- Two components: **Director** (HTTP API) and **Cell** (WebSocket server)
- The relay bridges the mobile app to the desktop app when direct LAN connection isn't available
- Security-critical: E2EE challenge-response authentication, device credential lifecycle
- Deployed to Cloudflare Workers + Durable Objects via `wrangler deploy`

## Tech Stack

- Cloudflare Workers runtime (V8 isolates, not Node)
- TypeScript
- Hono (HTTP API, upgradeWebSocket)
- Durable Objects + WebSocket Hibernation API
- tweetnacl (NaCl box, pure-JS)
- HMAC-SHA256 via Web Crypto (`crypto.subtle`) — Workers has no `node:crypto`
- SQLite via Durable Object storage (per-host persistence)
- Vitest (testing)

## Commands

Run these before claiming DONE (from `Fabrica-relay/`):

```bash
pnpm install       # dependencies
pnpm test          # vitest unit + miniflare integration tests
npx tsc --noEmit   # TypeScript check
npx wrangler dev   # local dev with Durable Objects
```

## Architecture

```
Director (HTTP Worker)              Cell (Durable Object)
├── POST /v1/assign                 ├── /v1/host/control   (desktop app, control channel — stays awake)
├── POST /v1/resolve                ├── /v1/host/data/<connId>  (per-connection data, may hibernate)
└── WS /v1/connect/<relayHostId>    └── /v1/connect/<relayHostId>  (phone invite recovery)
```

### Director
- `POST /v1/assign` — host requests cell assignment → `{ cellUrl, assignmentEpoch, lease }`. Requires `Authorization: Bearer <relayToken>` (relay JWT minted by auth backend, not the relay).
- `POST /v1/resolve` — phone resume recovery; phone authenticates via `resumeToken` in the POST body `{ v:1, relayHostId, resumeToken }` → `{ v:1, cellUrl, assignmentEpoch, leaseExpiresAt }`. No Bearer JWT on this route.

### Cell
- Director WS `/v1/connect/<relayHostId>` — phone invites the Director for resume recovery; server replies `relay-moved { v:1, cellUrl, assignmentEpoch }` (strictly-newer epoch, 5s client timeout), NOT `relay-hello`.
- Cell WS `/v1/connect/<relayHostId>` — first phone message `relay-auth`; server sends `relay-hello` only after host data socket attaches.
- Host control channel (`/v1/host/control`) — challenge-response auth (tweetnacl NaCl box + HMAC via Web Crypto), server-driven pings (JSON `{type:'ping', t}` with `t` = epoch ms every 15s), conn-open, drain. Control socket stays awake (no hibernation). Client replies `{type:'pong', t}`; a bare `{type:'ping'}` fails the client schema → close 4401.
- Per-connection data channels (`/v1/host/data/<connId>`) — raw frame forwarding, binary/text preserved. May hibernate when idle.

## Conventions

- **Concise comments only** — no verbose explanations
- **No secrets in code** — use environment variables
- **All IDs are opaque strings**, 1-128 chars
- **All base64url tokens are 32 bytes** (43 chars)
- **All timestamps are epoch milliseconds**
- **All WebSocket messages are JSON** (no binary on control channel); data channels forward raw frames (binary or text)
- **Max payload: 64KB** per WebSocket message (control channel); data channel cap = 1 MiB (Workers max)

## Definition of Done

A task is DONE only when ALL of these hold:

1. **Commands pass:** `pnpm test` and `npx tsc --noEmit` clean — paste real output as evidence.
2. **Wire compatibility:** any protocol change matches the client schemas in `Fabrica-app/src/main/runtime/relay/relay-control-protocol.ts` (`.strict()` schemas — the client is the spec).
3. **Security intact:** challenge-response, close codes, and E2EE behavior unchanged unless the task explicitly says so.
4. **Tracking files updated in the same edit:** task status + Rollup recount in `.Fabrica-relay-board/Fabrica-relay-tasks.md`, Checkpoint table, Session Ledger row.

## What You Do NOT Do

- **Do NOT edit** `.backup/` or `_sources/` — frozen reference copies
- **Do NOT commit or push** — make changes only, orchestrator handles git
- **Do NOT deploy** — orchestrator handles deployment after review

## Key Files

```
src/director/          — HTTP API (assign, resolve)
src/cell/              — Durable Object (WebSocket server, host + phone)
src/shared/            — Types, crypto (tweetnacl + Web Crypto), protocol
src/index.ts           — Worker entry
wrangler.toml          — Cloudflare config
package.json           — Dependencies
.Fabrica-relay-board/  — Task file and planning docs
```

## Wire Compatibility

The server MUST be wire-compatible with the existing client code. Source of truth:
`Fabrica-app/src/main/runtime/relay/relay-control-protocol.ts` (all message schemas).

Key constraints:
- Server sends app-level JSON `{type:'ping', t}` (`t` = epoch ms) every 15s; client replies `{type:'pong', t}` and dies after 75s silence. A bare `{type:'ping'}` fails the client schema → close 4401.
- Control socket stays awake (no hibernation); data sockets may hibernate
- NaCl box via tweetnacl (NOT @noble/ciphers). HMAC-SHA256 either way: the CLIENT uses `node:crypto` (`createHmac` + `timingSafeEqual`); the SERVER must swap to Web Crypto `crypto.subtle` because Workers has no `node:crypto`.
- Relay JWT validated ONLY on /v1/assign (HS256, FABRICA_RELAY_JWT_SECRET); /v1/resolve authenticates via `resumeToken` in the POST body
- One host = one Durable Object instance (all sockets pinned to one DO)
- Device management (invite-create, revoke, etc.) rides the **control channel** as reqId RPCs. The control channel is plaintext JSON authenticated via challenge-response (host-proof) — NOT E2EE-encrypted. E2EE v2 framing exists ONLY on data channels.

### Client-required behaviors (confirmed from client code)

- Close codes: 4401 BAD_OUTER_CREDENTIAL, 4404 HOST_OFFLINE, 4408 PEER_DROPPED, 4409 WRONG_CELL, 4429 LIMIT_EXCEEDED, 4503 DRAINING
- `drain` fields: `{ type:'drain', graceMs (≤3,600,000), recovery:'resolve-director' }` — `recovery` is a required literal
- `conn-open` fields: `{ type:'conn-open', connId, connTicket, kind:'invite'|'resume', relayDeviceId, attachDeadlineMs (≤60,000) }`; host must attach the data socket within the deadline
- `host-hello-ack` requires `v:1`, `generation (>0)`, `controlResumeSecret`, `leaseExpiresAt`, `activeConnIds` (≤8), `pendingConns` (≤8)
- Client sends `{ type:'auth-refresh', relayJwt }` over control on token refresh
- Server replies to failed reqId RPCs with `{ type:'control-error', reqId?, code }`
- `relay-hello` can be `{ type:'relay-hello', ok:false, code }` (code 4000–4999) on rejection
- `host-data-auth` shape: `{ type:'host-data-auth', v:1, connTicket, generation }`
- Client proactively rebinds control ~60s + jitter (0–60s) before `leaseExpiresAt`; rebind requires the same cellUrl + controlResumeSecret + generation > 0
- On the Director WS `/v1/connect/<relayHostId>`, reply `relay-moved { v:1, cellUrl, assignmentEpoch }` (strictly-newer epoch, 5s client timeout)

## Parallelism & Anti-Overlap Policy

> This project runs REAL 24/7 multi-terminal orchestration. Parallelism is the
> default: unlimited tokens, multi-terminal app, massive project, close deadline.

- **Minimum fleet:** the orchestrator keeps AT LEAST 3 active worker terminals at
  all times. Fewer than 3 on resume or cycle end => launching more comes FIRST,
  chosen from the highest-priority TODO/VERIFY tasks in this file, focused on
  high-level goals and principles, not micro-edits.
- **One task = one worker:** claim a task by setting its status IN_PROGRESS and
  recording your terminal handle in the Session Ledger BEFORE starting. Claimed
  tasks are forbidden to everyone else.
- **One folder = one orchestrator:** never work another slot's folder.
- **One file = one writer:** two live workers never edit the same file; such tasks
  run sequentially.
- **Claim-before-work:** confirm your Task ID is still unclaimed before executing;
  if done or claimed, stop and report instead of duplicating.
- **Cross-project dependencies:** record them as notes in the OTHER project's task
  file; never edit another project directly.
- **Quality bar unchanged under deadline pressure:** no DONE without verified
  evidence; status change and Rollup update happen in the same edit.

## Task File

Your task file is `.Fabrica-relay-board/Fabrica-relay-tasks.md` — the single source of truth for all relay work. Schema for all tracking edits: `.Fabrica-board/Fabrica-Schema.md` (Tracking Schema v1 — status enum, Rollup, Checkpoint, Session Ledger).

## Resume Protocol

On heartbeat kick or session resume:

1. Read your task file's **Checkpoint (Current State)** table FIRST.
2. Continue from the **Next Action** cell — never restart completed work; check Status + Notes before dispatching.
3. Any status change updates the Rollup in the same edit.

## How to Send Results

When your task is complete, send `worker_done`:

```bash
orca orchestration send --type worker_done --subject "Task complete" --body "Summary of what was done" --task-id <task_id> --dispatch-id <dispatch_id> --outcome succeeded --files-modified "path/a,path/b" --json
```

If blocked:
```bash
orca orchestration send --type escalation --subject "Blocked" --body "What happened and what's needed" --task-id <task_id> --dispatch-id <dispatch_id> --json
```

## Orchestration IDs

Your task file's Session Ledger tracks these IDs for every worker session:

| ID | Format | When You Get It | How to Use It |
|----|--------|-----------------|---------------|
| `task_xxx` | `task_` + hex | `task-create --json` → `result.task.id` | Resume a stuck worker: `worker-start --task <task_id> --retry-of <dispatch_id>` |
| `ctx_xxx` | `ctx_` + hex | `worker-start --json` → `result.dispatchId` | Read worker output: `worker-read --dispatch <ctx_xxx>`. Resume: `--retry-of <ctx_xxx>` |
| `term_xxx` | `term_` + uuid | `worker-start --json` → `effects[terminal].id` | Send message to worker: `terminal send --terminal <term_xxx>`. Read output: `terminal read --terminal <term_xxx>` |
