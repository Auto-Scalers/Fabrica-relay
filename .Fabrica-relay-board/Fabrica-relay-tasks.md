# Fabrica-relay — Tasks

> Single source of truth for relay server work. The Roadmap (`.Fabrica-Board/Fabrica-Roadmap.md`) tracks cross-cutting status only — this file owns execution details.

---

## Deployment Decision & Research Summary (Aug 2026)

> Full research was reviewed, then consolidated here so the standalone research doc could be archived. Research date: Aug 2026.

### Decision

- **Stack: Cloudflare Workers + Durable Objects (WebSocket Hibernation API) + Hono** — **$0/month at Fabrica scale**.
- **Crypto:** tweetnacl (NaCl box) + Web Crypto HMAC (see wire-compat below).
- **Auth:** Supabase validates the Fabrica access token; relay director validates the relay JWT on `/v1/assign`.
- **DB:** D1/SQLite per object (local SQLite for dev).
- **Client reconnects are mandatory** — Cloudflare deploys restart objects and drop sockets; the protocol's ping/pong + drain design already requires reconnect logic.
- All tasks below target Cloudflare Workers + Durable Objects.

### Why Cloudflare wins for THIS relay

The relay's control connections sit idle most of the time (a phone–desktop pair only sends traffic during an active tunnel/transfer). Durable Objects + WebSocket Hibernation is purpose-built for that pattern:

1. **Idle sockets are free.** Hibernation lets the object sleep while clients stay connected — no duration charges accrue while idle. Every always-on VM platform bills 24/7 for sockets sitting in RAM; Cloudflare bills $0.
2. **Genuinely $0 at launch scale.** Free tier covers 100K requests/day and ~390K GB-s/month of duration — even a never-sleeping 128 MB object (~324K GB-s/month) fits. No card required.
3. **Best latency + zero cold start.** ~5 ms cold start; 330+ PoPs (~12 ms global P50). Phones/desktops connect to the nearest edge.
4. **No egress fees.** Tunnel traffic moves free.
5. **First-class tooling.** Hono + Durable Objects + Hibernation is a documented, well-trodden pattern.

### Platform Comparison Matrix

| Criteria | Cloudflare DO | Railway | Render | Vercel | Deno Deploy |
|---|---|---|---|---|---|
| Free tier usable for relay? | **Yes ($0)** | No ($1 credit can't sustain 24/7) | No (15-min spin-down) | No (5-min sockets + non-commercial ToS) | Marginal (hard pauses) |
| Cheapest always-on | **$0** | ~$10–15/mo | $7/mo | ~$20/mo (Pro) | ~$0 (256 MB) risky |
| Persistent WS (no forced timeout) | ✅ (hibernation) | ✅ (verify 15-min claim) | ✅ paid / ❌ free | ❌ (300 s cap) | ✅ |
| Idle-connection cost | **$0 (hibernates)** | Full compute | Full compute (paid) | Cheap (active-CPU) but capped | Memory-time metered |
| Cold start | ~5 ms | none | 30–60 s (free) | ~35 ms | ~10 ms |
| Global latency (P50) | ~12 ms (330 PoPs) | 6 regions | regions (paid) | 30 regions | ~18 ms (35 PoPs) |
| Egress fees | **None** | $0.05/GB | $0.15/GB over 5 GB | within 100 GB | $0.50/GB over 20 GB |
| Ease of deploy | `wrangler deploy` | git deploy | git deploy | git deploy | git deploy |
| 10M req/mo cost | ~$5.50 | ~$15–30 | ~$25+ | ~$20+ | ~$200 |

### Per-Platform Notes (why each was accepted/rejected)

- **Cloudflare Workers + Durable Objects — ⭐ chosen.** Free: 100K req/day (WS messages billed at 20:1; outgoing WS free), 13K GB-s/day (~390K/mo), 5 GB SQLite storage, no egress fees. Hibernation API = idle sockets cost nothing. Limits: 128 MB/object, 30 s CPU/request (configurable to 5 min), deploys restart all objects (drops sockets), no outbound socket in hibernation. Paid: $5/mo min, then $0.15/M requests, $12.50/M GB-s, $0.20/GB-mo storage.
- **Railway — rejected for the relay.** Free plan is $0/mo with **only $1/month credit** (1 vCPU/0.5 GB, 1 replica); when the credit runs out **all deployments auto-shutdown** until next month. A 24/7 relay costs ~$15/mo of usage — the $1 credit cannot sustain it. Hobby is $5/mo (+$5 credit). 10K concurrent-connection cap per domain (raiseable); a 15-min WS request limit is claimed by third parties but contradicted by Railway's own docs — unverified.
- **Render — rejected.** Free tier: 750 hrs/mo, 512 MB/0.1 CPU, **spins down after 15 min idle (drops all sockets), 30–60 s cold start**, single instance, free Postgres expires at day 90. Cheapest always-on is Starter **$7/mo**. WS supported on paid only.
- **Vercel — rejected.** WS is public beta (June 2026, Fluid Compute). Connection cap: **300 s on Hobby, 800 s on Pro, 1,800 s beta max** — forced reconnects every 5 min, no hibernation, no built-in fan-out (needs external Redis), Hobby is non-commercial per ToS. Great DX, wrong model for long-lived tunnels.
- **Deno Deploy — rejected.** Free: 1M req/mo, **20 GB egress**, 15 CPU-hr, 350 GB-h memory-time, 20 apps. **Hard pause** when any quota is exceeded (apps paused until next billing cycle — no overage). A 512 MB always-on app barely exceeds the memory quota. Overage on Pro: $2/M req, $0.50/GB egress → ~$200/mo at 10M req (5–10× Cloudflare).
- **Hono (framework) — adopted.** Runs the same code on Cloudflare Workers, Deno, Bun, Vercel, Node, Netlify, Lambda. Native `upgradeWebSocket` + DO Hibernation pattern. Sub-12 KB, ~840K req/s routing. Portable if we ever move platforms.
- **Managed WebSocket/pub-sub services (Pusher-compatible: Vask, PushFlo, Relay Cloud, Apinator, LatteStream, PartyKit/Ably) — rejected.** The relay runs a **custom E2EE tunneling protocol** (challenge-response, per-connection data channels). Managed channel services don't support the protocol and would break E2EE guarantees.

### Cost Scenarios (always-on relay, active tunnels during transfers)

| Scenario | Cloudflare DO | Railway | Render | Vercel | Deno Deploy |
|---|---|---|---|---|---|
| Launch, 0–100 users | **$0** | ~$15/mo | $7/mo | $0 (but 5-min drops) | ~$0 (paused if quota hit) |
| 1K users, steady tunnels | ~$0–5 | ~$15–25 | $7–25 | $20 (Pro) | ~$20+ |
| 10K users, heavy | ~$5–30 | ~$30+ | $25+ | $20+ (Redis needed) | ~$200 |

### Implementation Path

- **Hono + Durable Objects** (`upgradeWebSocket` + Hibernation API) on Cloudflare Workers
- Director (HTTP) as a plain Worker; **Cell as a Durable Object class**
- Keep E2EE protocol unchanged (challenge-response, 64 KB payloads, JSON control channel)
- SQLite per-object (Durable Object storage) for leases/credentials; no Postgres, no central D1
- Client reconnect logic (already required by ping/pong + drain design) covers deploy-triggered disconnects

### Decisions Locked In (Aug 19 2026)

- **Stack confirmed: Hono + Durable Objects on Cloudflare. Auth: Supabase.**
- Supabase validates the Fabrica access token. The **relay director validates the relay JWT** on `/v1/assign` — default HS256 shared secret in env `FABRICA_RELAY_JWT_SECRET` (the auth backend signs the relay token; align the exact alg/secret with the Fabrica-web/auth backend owner before R29). `/v1/resolve` authenticates via `resumeToken` in the POST body (no Bearer).
- **DB confirmed: SQLite-backed Durable Objects per host** (no Postgres, no central D1) — see decisions #2.
- **Deploy-reconnect: accept client reconnects** (Cloudflare model) — see decisions #3.
- **Concurrency assumption: ~1,000 users / <100 simultaneous tunnels** — see decisions #4.
- **Control-channel caveat:** the cell's control socket must stay awake (see wire-compat #1). Cost still fits the free tier — one 128 MB object awake 24/7 ≈ 324K GB-s/month < 390K free. Data sockets hibernate.

### Wire Compatibility (client protocol) — REQUIRED

The server MUST be wire-compatible with the existing client code. These files in `Fabrica-app/src/main/runtime/relay/` define the contract (they ARE the spec — read before implementing):

- `relay-control-protocol.ts` — all message schemas (source of truth)
- `relay-control-url.ts` — URL shapes (no query params allowed)
- `relay-control-client.ts` — host control flow (64 KB max, text-only control)
- `relay-control-requests.ts` — reqId request/response over control (10 s client timeout)
- `relay-control-silence-watchdog.ts` — client kills socket after 75 s of message silence
- `relay-auth-coordinator.ts` + `relay-host-proof.ts` — challenge-response (NaCl box via **tweetnacl**, NOT @noble/ciphers; HMAC via `node:crypto` → swap to Web Crypto on Workers)
- `relay-http-client.ts` — the Director endpoints the client actually calls
- `relay-origin-pool.ts` + `relay-control-origin.ts` — drain/rebind/resume expectations
- `mobile/src/transport/mobile-relay-physical-client.ts`, `src/shared/mobile-relay-phone-protocol.ts`, `src/shared/mobile-relay-close-codes.ts` — phone side
- `mobile-relay-e2ee.integration.test.ts` — end-to-end behavior reference (no cloud relay server exists yet anywhere in the repo — this is greenfield)

Key constraints discovered (drive the architecture):

1. **Server sends app-level JSON `{type:'ping', t}` (epoch ms) every 15 s; client dies after 75 s of message silence and replies `{type:'pong', t}`.** Protocol-level WS pings do NOT satisfy the watchdog. A bare `{type:'ping'}` fails the client schema → close 4401. → The **control-channel DO must NOT hibernate** (no setTimeout/setInterval while hibernated; alarm-driven pings risk the client's 10 s reqId timeout and 15 s connect deadline). Control sockets stay awake; data sockets may hibernate.
2. **One cell origin must serve control + all data sockets for one host for the whole lease** (same-origin enforced). → Pin all sockets for a host to ONE DO instance (name by relayHostId/assignmentEpoch) and persist `generation`, `controlResumeSecret`, `leaseExpiresAt`, invites, pendingConns in `ctx.storage` so drain/lease-rotation rebind and phone `/v1/resolve` survive restarts.
3. **Data splicing:** relay forwards raw frames verbatim, preserving binary/text flag; first messages are JSON — host data socket sends `{type:'host-data-auth', v:1, connTicket, generation}` within the `attachDeadlineMs` window (≤60 s), phone sends `relay-auth`; `relay-hello` is sent only after both sockets attach. Preserve frame order.
4. **Size ceiling:** client data-socket cap = 1 MiB = Workers' max incoming WS message; E2EE text plaintext cap is 4 MiB (base64 overhead can exceed 1 MiB on the wire). Either reduce effective payload or add server-side chunking (a protocol extension — the client does none today).
5. **Crypto portability:** swap `node:crypto` HMAC/timingSafeEqual → Web Crypto `crypto.subtle`; `tweetnacl` (NaCl box) is pure-JS and bundles cleanly into Workers.
6. **Director endpoints (from client code):** `POST /v1/assign` (host — `Authorization: Bearer <relayToken>`, body `{v:1, relayHostId, reconnect?}` → `{v:1, cellUrl, assignmentEpoch, lease}`); `POST /v1/resolve` (phone resume — NO Bearer; auth via `resumeToken` in body `{v:1, relayHostId, resumeToken}` → `{v:1, cellUrl, assignmentEpoch, leaseExpiresAt}`); `WS /v1/connect/<relayHostId>` (phone invite recovery — the **Director** replies `relay-moved {v:1, cellUrl, assignmentEpoch}` with strictly-newer epoch, 5 s client timeout; the **Cell** replies `relay-hello`). The relay token is minted by the AUTH backend (`login.onFABRICA.dev`), NOT by the relay — the director only validates the relay JWT on `/v1/assign`.
7. **Close codes (client-defined, server MUST send exactly):** 4401 BAD_OUTER_CREDENTIAL, 4404 HOST_OFFLINE, 4408 PEER_DROPPED, 4409 WRONG_CELL, 4429 LIMIT_EXCEEDED, 4503 DRAINING.
8. **`drain` requires `recovery:'resolve-director'`:** `{type:'drain', graceMs (≤3,600,000), recovery:'resolve-director'}` — `recovery` is a required literal. Client synthesizes this exact shape on unexpected control close.
9. **`conn-open`:** `{type:'conn-open', connId, connTicket, kind:'invite'|'resume', relayDeviceId, attachDeadlineMs (≤60,000)}` — host must attach the data socket within the deadline. `host-hello-ack` requires `v:1`, `generation (>0)`, `controlResumeSecret`, `leaseExpiresAt`, `activeConnIds` (≤8), `pendingConns` (≤8).
10. **Other client-required control messages:** client sends `{type:'auth-refresh', relayJwt}` over control when the relay token refreshes; server replies to failed reqId RPCs with `{type:'control-error', reqId?, code}` (matched before kind-specific schemas); `relay-hello` can be `{type:'relay-hello', ok:false, code}` (4000–4999) on rejection.

### Decisions & Open Questions

1. ~~Swap to Hono + Durable Objects?~~ **DECIDED — yes.** (Aug 19 2026)
2. ~~Postgres, or per-object SQLite/D1?~~ **DECIDED — SQLite-backed Durable Objects (per host), no Postgres, no central D1.** (Aug 20 2026) Each host's cell object carries its own embedded SQLite DB — $0, self-contained, matches "one host = one DO". Escape hatch: D1 export or Hyperdrive→Postgres later if cross-host admin/analytics queries are needed. Applies to R24.
3. ~~OK with client reconnection on every deploy?~~ **DECIDED — yes, accept client reconnects (Cloudflare model).** (Aug 20 2026) The client protocol already has resume tokens, `reconnect:true` fast-lane, `drain` with `recovery:'resolve-director'`, and resume-confirm — it was designed for this. In-progress transfers re-establish in a few seconds. Applies to R25.
4. ~~Expected concurrent-tunnel ceiling?~~ **Assumed: ~1,000 users / <100 simultaneous tunnels at launch.** (Aug 20 2026) Cloudflare scales horizontally for free (one independent DO per host). Just implement per-host limits (8 active + 8 pending, client-enforced) + per-IP rate limit on `/v1/assign` (R28). No special architecture.
5. ~~What's needed from the Cloudflare account?~~ **CLARIFIED (Aug 20 2026):** Free tier is enough ($0, no card). Only three things needed, all at deploy time (R29): (1) **Account ID** — short string from the Cloudflare dashboard home page → `wrangler.toml`; (2) a **`wrangler login`** browser-auth on the PM's machine (orchestrator cannot do it) to authorize `wrangler deploy`; (3) a **Workers subdomain** chosen during account setup (any name — becomes the free deploy URL). Nothing needed for local dev — `wrangler dev` runs fully on-machine with no account.
6. ~~Relay JWT secret/alg alignment — what is it?~~ **CLARIFIED (Aug 20 2026):** The relay doesn't authenticate users directly. The auth backend (`login.onFABRICA.dev`) mints the relay token (a JWT, HS256 = signed with a **shared secret**). "Alignment" = the auth backend and the relay director must use **the same secret value + the same algorithm**, otherwise every connection is rejected. It's a coordination conversation with the auth-backend owner (Fabrica-web/auth), not a code task. **Not blocking Phase 1–3** — dev/test uses a locally-generated secret; only needed before the live deploy (R29).
7. ~~Relay domain?~~ **CLARIFIED (Aug 20 2026):** No relay domain needed — we don't own one and don't need to buy one. `wrangler deploy` gives a **free production HTTPS URL** automatically: `fabrica-relay.<workers-subdomain>.workers.dev`. Client addresses the relay via **configurable URLs** (`directorUrl`/`cellUrl` come from the auth backend's assignment — no hostname is hardcoded in client code), so the hostname can change later with zero client impact. A branded `relay.onfabrica.dev` is a Phase 4 nice-to-have only if we later own that domain. The landing-page domain (`fabrica-ai.vercel.app`) is untouched — the relay runs on Cloudflare, fully separate.

### Sources (key)

- Cloudflare Durable Objects pricing / limits / WebSockets / hibernation docs (free tier limits, 20:1 WS billing, no egress, SQLite-backed DOs on Free) — updated Aug 2026
- Railway pricing + plans docs + Help Station (free-plan auto-shutdown, 10K WS cap per domain, no WS timeouts); Railway blog "Bring Back the Free Plan" (Aug 2025)
- Render "Deploy for Free" + pricing + FAQ (750 free hrs, 15-min spin-down, 30–60 s cold start, WS on paid only)
- Vercel WebSocket support (public beta June 2026), Functions limits (300 s / 800 s / 1,800 s caps), Hobby limits + non-commercial ToS
- Deno Deploy pricing + changelog + GA announcement (free quotas, hard pauses, Pro overages)
- Hono docs (multi-runtime, upgradeWebSocket, Cloudflare Workers first-class)
- Third-party 2026 teardowns: Jake's Insights (Fly vs Railway), BytePane (Vercel Fluid vs Cloudflare Workers benchmarks), kuberns WebSocket hosting guide, SourceFeed + Ably (Vercel WebSockets analysis)

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
| R1 | Initialize repo (package.json, tsconfig, vitest) | **PARTIAL** | Repo created (commit `be9ef33`): AGENTS.md, README.md, tasks file. `package.json`/`tsconfig`/vitest scaffold still pending |
| R2 | Create shared types (protocol messages, IDs, timestamps) | **TODO** | From `Fabrica-app/src/main/runtime/relay/relay-control-protocol.ts` schemas (source of truth) |
| R3 | Implement Director: relay JWT validation | **TODO** | Validate `Bearer <relayToken>` (HS256, `FABRICA_RELAY_JWT_SECRET`) on `/v1/assign` ONLY. `/v1/resolve` authenticates via `resumeToken` in POST body (no Bearer). Relay token is minted by the auth backend (login.onFABRICA.dev), not the relay |
| R4 | Implement Director: `POST /v1/assign` + `POST /v1/resolve` | **TODO** | `/v1/assign` body `{v:1, relayHostId, reconnect?}` → `{v:1, cellUrl, assignmentEpoch, lease}`; `/v1/resolve` body `{v:1, relayHostId, resumeToken}` (no auth header) → `{v:1, cellUrl, assignmentEpoch, leaseExpiresAt}` |
| R5 | Implement Cell: WebSocket server setup | **TODO** | Hono `upgradeWebSocket` + Durable Object. Control socket stays awake (no hibernation); data sockets may hibernate. JWT auth on connect (Bearer on upgrade) |
| R6 | Implement Cell: Host challenge-response | **TODO** | NaCl box (tweetnacl) + HMAC-SHA256 via Web Crypto; transcript layout + proof per `relay-host-proof.ts` |
| R7 | Implement Cell: Host activation flow | **TODO** | host-hello → host-challenge → host-challenge-ack → host-hello-ack (exact order + fields per client) |
| R8 | Implement Cell: Ping/pong keepalive | **TODO** | SERVER sends app-level JSON `{type:'ping', t}` (epoch ms) every 15s; client replies `{type:'pong', t}`; close after 75s silence. Bare `{type:'ping'}` fails client schema → close 4401. WS protocol pings do NOT satisfy the client watchdog |
| R9 | Implement Cell: Phone relay-auth/relay-hello | **TODO** | Phone first message `relay-auth`; server sends `relay-hello` only after host data socket attaches; invite + resume credential handling |
| R10 | Unit tests for Director | **TODO** | JWT validation, assign, resolve, error cases |
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
| R17 | Implement invite-create RPC | **TODO** | Over control channel (plaintext JSON, authenticated via host-proof — E2EE framing is data-channel only), reqId request/response, not HTTP: `invite-create` → `invite-created`; generate invite token, track attempts |
| R18 | Implement device-credential-install RPC | **TODO** | Over control channel (plaintext JSON, authenticated via host-proof): `device-credential-install` → `device-credential-installed`; store credential, manage versioning |
| R19 | Implement device-credential-status RPC | **TODO** | Over control channel (plaintext JSON, authenticated via host-proof): `device-credential-install-status` → `device-credential-install-status-result` |
| R20 | Implement device-revoke RPC | **TODO** | Over control channel (plaintext JSON, authenticated via host-proof): `device-revoke` → `device-revoked` |
| R21 | Implement device-resume-confirm RPC | **TODO** | Over control channel (plaintext JSON, authenticated via host-proof): `device-resume-confirm` → `device-resume-confirmed` |
| R22 | Device management tests | **TODO** | |

---

## Phase 4 — Production Readiness

> Deploy to Cloudflare Workers + Durable Objects and make it production-ready.

| # | Task | Status | Notes |
|---|------|--------|-------|
| R23 | Create wrangler config + build setup | **TODO** | `wrangler.toml`, Hono/DO adapters, env/secrets |
| R24 | Add database (SQLite-backed Durable Objects per host) | **TODO** | Leases, device credentials, state stored in each host's object storage (embedded SQLite). No Postgres, no central D1. Escape hatch: D1 export or Hyperdrive→Postgres later if cross-host analytics needed |
| R25 | Add graceful reconnect/drain handling | **TODO** | Client reconnect on deploy restarts (accepted — Cloudflare model); drain existing connections on shutdown. Client already has resume tokens + `reconnect:true` fast-lane + `recovery:'resolve-director'` |
| R26 | Add structured logging | **TODO** | JSON logs, Cloudflare Logpush / wrangler tail |
| R27 | Add health check endpoint | **TODO** | `GET /health` |
| R28 | Add rate limiting | **TODO** | Per-IP connection limits |
| R29 | Deploy to Cloudflare | **TODO** | `wrangler deploy`; configure secrets (`FABRICA_RELAY_JWT_SECRET` aligned with auth backend); requires PM: Account ID → `wrangler.toml`, `wrangler login`, Workers subdomain. Deploy URL = free `fabrica-relay.<workers-subdomain>.workers.dev` (no custom domain needed) |
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

- [ ] Director relay JWT validation rejects invalid/expired tokens on `/v1/assign` and `/v1/resolve`
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
