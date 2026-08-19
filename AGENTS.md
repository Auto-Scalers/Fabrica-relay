# Fabrica-relay — Worker Instructions (AGENTS.md)

## What This Folder Is

This is the **Fabrica relay server** — a standalone WebSocket bridge that enables phone↔desktop communication. You are a worker dispatched by the top-level orchestrator to complete a task in this repo.

## What You Should Know

- This is a **standalone server** — no Electron, no Vercel, no Next.js
- Two components: **Director** (HTTP API) and **Cell** (WebSocket server)
- The relay bridges the mobile app to the desktop app when direct LAN connection isn't available
- Security-critical: E2EE challenge-response authentication, device credential lifecycle
- Deployed to Fly.io via Dockerfile

## Tech Stack

- Node.js 20+
- TypeScript
- Fastify (HTTP API)
- `ws` (WebSocket server)
- `@noble/ciphers` (NaCl box for E2EE)
- SQLite (leases, state) or Postgres for production
- Vitest (testing)

## Architecture

```
Director (HTTP)                    Cell (WebSocket)
├── POST /v1/token-exchange        ├── /v1/host/control   (desktop app)
└── POST /v1/assign                └── /v1/phone/*        (mobile app)
```

### Director
- `POST /v1/token-exchange` — validates Fabrica access token, returns relay JWT
- `POST /v1/assign` — assigns host to a cell, returns cell URL + epoch + lease

### Cell
- Host control channel (`/v1/host/control`) — challenge-response auth, ping/pong, conn-open, drain
- Phone channel (`/v1/phone/*`) — relay-hello, relay-moved, data tunneling
- Per-connection data channels for E2EE tunneling

## Conventions

- **Concise comments only** — no verbose explanations
- **No secrets in code** — use environment variables
- **All IDs are opaque strings**, 1-128 chars
- **All base64url tokens are 32 bytes** (43 chars)
- **All timestamps are epoch milliseconds**
- **All WebSocket messages are JSON** (no binary on control channel)
- **Max payload: 64KB** per WebSocket message

## What You Do NOT Do

- **Do NOT edit** `.backup/` or `_sources/` — frozen reference copies
- **Do NOT commit or push** — make changes only, orchestrator handles git
- **Do NOT deploy** — orchestrator handles deployment after review

## Key Files

```
src/director/          — HTTP API (token-exchange, assign)
src/cell/              — WebSocket server (host + phone)
src/shared/            — Types, crypto, protocol
Dockerfile             — Fly.io deployment
package.json           — Dependencies
.Fabrica-relay-board/  — Task file and planning docs
```

## Task File

Your task file is `.Fabrica-relay-board/Fabrica-relay-tasks.md` — the single source of truth for all relay work.

## How to Send Results

When your task is complete, send `worker_done`:

```bash
orca orchestration send --type worker_done --subject "Task complete" --body "Summary of what was done" --task-id <task_id> --dispatch-id <dispatch_id> --outcome succeeded --files-modified "path/a,path/b" --json
```

If blocked:
```bash
orca orchestration send --type escalation --subject "Blocked" --body "What happened and what's needed" --task-id <task_id> --dispatch-id <dispatch_id> --json
```
