# Fabrica-relay — Tasks

> Single source of truth for relay server work. Schema: `.Fabrica-board/Fabrica-Schema.md`.

## What This Project Is

WebSocket relay server that bridges phone↔desktop communication for the Fabrica desktop app when direct LAN isn't available.

- **Wire-compatible** with client protocol: `Fabrica-app/src/main/runtime/relay/relay-control-protocol.ts`
- **Stack**: Cloudflare Workers + Durable Objects (WebSocket Hibernation API) + Hono
- **Auth**: Supabase JWT validated on `/v1/assign`
- **Cost**: $0/month (free tier)

## Rollup

| Metric | Value |
|---|---|
| Total tasks | 32 |
| ✅ DONE | 32 |
| Completion | 100% |

## What's Built

### Director (HTTP API — `src/director/`)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/v1/assign` | POST | Host requests cell assignment. Requires `Authorization: Bearer <jwt>`. Returns `{ v:1, cellUrl, assignmentEpoch, lease }` |
| `/v1/resolve` | POST | Phone resume recovery. Auth via `resumeToken` in body. Returns `{ v:1, cellUrl, assignmentEpoch, leaseExpiresAt }` |
| `/health` | GET | Returns `{ ok: true }` |

Rate limit: 10 req/min per IP on `/v1/assign`.

### Cell (Durable Object — `src/cell/`)

**Host control channel** (`/v1/host/control`):
- Challenge-response auth (NaCl box + HMAC-SHA256 via Web Crypto)
- 15s JSON ping/pong keepalive (`{type:'ping', t}` / `{type:'pong', t}`)
- Lease expiry with drain message (`{type:'drain', graceMs, recovery:'resolve-director'}`)
- Generation-based rebind with resume secret rotation

**Device management RPCs** (over control channel):
- `invite-create`, `device-credential-install`, `device-credential-install-status`
- `device-revoke`, `device-resume-confirm`
- `auth-refresh`, `control-error`

**Phone connection** (`/v1/connect/<relayHostId>`):
- `relay-auth` (invite flow) / `relay-moved` (resume recovery)
- `relay-hello` after host data socket attaches
- `conn-open` notification to host

**Data channels** (`/v1/host/data/<connId>`):
- `host-data-auth` validation (connTicket + generation)
- Raw frame forwarding (binary/text preserved, order preserved)
- Close codes: 4401, 4404, 4408, 4409, 4429

**Persistence** (SQLite via Durable Object storage):
- Tables: `host_state`, `invites`, `device_credentials`, `pending_conns`
- Multi-tenant isolation by `relayHostId`

### Shared (`src/shared/`)
- `types.ts` — Protocol type definitions (wire-compatible with client)
- `protocol.ts` — Protocol constants (domains, timing, intervals)
- `crypto.ts` — tweetnacl (NaCl box) + HMAC-SHA256 via Web Crypto
- `rate-limit.ts` — Sliding window rate limiter
- `logger.ts` — Structured JSON logger

## Tests

45 tests across 8 files (24 unit + 21 integration).

```bash
pnpm test          # vitest unit + miniflare integration tests
npx tsc --noEmit   # TypeScript check
```

## Live Deployment

- **URL**: `https://fabrica.autoscalers.workers.dev`
- **Stack**: Cloudflare Workers + Durable Objects (free tier, $0/month)
- **Account**: `29426cba5c56f3a08df28fb89e48bb23`
- **Auth**: `FABRICA_RELAY_JWT_SECRET` set to Supabase JWT secret

## Environment Variables

| Variable | Purpose | Required |
|----------|---------|----------|
| `FABRICA_RELAY_JWT_SECRET` | HS256 secret for validating relay JWTs | Yes |
| `DIRECTOR_URL` | Public director origin | Yes |
| `FABRICA_RELAY_LEASE_MS` | Lease duration in ms (default 3600000, clamped [5000, 3600000]) | No |

## Key Files

```
src/index.ts           — Worker entry point
src/director/index.ts  — HTTP API (assign, resolve, health)
src/cell/index.ts      — Durable Object (WebSocket server, host + phone)
src/cell/store.ts      — SQLite-backed persistent store
src/shared/            — Types, crypto, protocol, logger, rate limiter
src/__tests__/         — Unit + integration tests (45 tests)
wrangler.toml          — Cloudflare config
```

## Session Ledger

| Handle | Type | Task IDs | Status | Created |
|---|---|---|---|---|
| `term_59b66903-...` | worker | REL-R16, REL-R22 | released | 2026-08-21 |
| R16R22-closeout | worker | REL-R16, REL-R22 | done + released | 2026-08-24 |
| Wire-compat-audit | worker | audit + 3 fixes | done + released | 2026-08-24 |
| Live-deploy-verify | worker | live deploy check | done + released | 2026-08-24 |
| Wrangler-v4-upgrade | worker | wrangler v3→v4 | done + released | 2026-08-24 |
| E2E-pairing-proof | worker | E2E pairing test | cancelled | 2026-08-24 |
| Lease-drain-test | worker | configurable lease + drain | done + released | 2026-08-24 |

---

_Last updated: 2026-08-31 (cleaned up — archived v1, snapshot of current state)._
