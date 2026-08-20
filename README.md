# Fabrica-relay

WebSocket relay server for Fabrica — bridges phone↔desktop communication when direct LAN isn't available.

> **Wire compatibility:** the server MUST match the existing client protocol. Source of truth: `Fabrica-app/src/main/runtime/relay/relay-control-protocol.ts`. See `.Fabrica-relay-board/Fabrica-relay-tasks.md` for the full constraint list.

## Architecture

```
┌─────────────┐                    ┌─────────────┐
│  Desktop    │◄──── WebSocket ───►│             │
│  (Fabrica)  │  /v1/host/control  │   Cell      │
│             │  /v1/host/data/<id>│  (Durable   │
└─────────────┘                    │   Object)   │
                                   │             │
┌─────────────┐                    │             │
│  Mobile     │◄──── WebSocket ───►│             │
│  (Fabrica)  │ /v1/connect/<host> │             │
└─────────────┘                    └─────────────┘
                                         ▲
                                         │
                                   ┌─────┴─────┐
                                   │ Director  │
                                   │ (HTTP+WS) │
                                   └───────────┘
```

### Director

HTTP API for authentication and cell assignment.

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/v1/assign` | POST | Host requests cell assignment → `{ v:1, cellUrl, assignmentEpoch, lease }`. Requires `Authorization: Bearer <relayToken>` (relay JWT minted by auth backend). Body `{ v:1, relayHostId, reconnect? }` |
| `/v1/resolve` | POST | Phone resume recovery. No Bearer; auth via `resumeToken` in body `{ v:1, relayHostId, resumeToken }` → `{ v:1, cellUrl, assignmentEpoch, leaseExpiresAt }` |
| `/v1/connect/<relayHostId>` | WS | Phone invite recovery. Director replies `relay-moved { v:1, cellUrl, assignmentEpoch }` (strictly-newer epoch, 5s client timeout) |

### Cell

WebSocket server that bridges host and phone connections.

| Path | Purpose |
|------|---------|
| `/v1/host/control` | Host control channel (challenge-response, server pings `{type:'ping', t}`, conn-open, drain). Control socket stays awake |
| `/v1/host/data/<connId>` | Per-connection data channels (raw frame forwarding, binary/text preserved). May hibernate |
| `/v1/connect/<relayHostId>` | Phone connects to Cell; first message `relay-auth`; server sends `relay-hello` after host data socket attaches |

## Security

- **E2EE**: NaCl box via **tweetnacl** (X25519+XSalsa20+Poly1305)
- **HMAC-SHA256** via Web Crypto (`crypto.subtle`) — client uses `node:crypto`, server must use `crypto.subtle` on Workers
- **Control channel** is plaintext JSON authenticated via host-proof challenge-response; E2EE framing only on data channels
- **Close codes**: 4401/4404/4408/4409/4429/4503
- **Device credentials**: Invite tokens, resume tokens, device revocation
- **Lease management**: Time-bound leases with epoch tracking

## Development

```bash
# Install dependencies
pnpm install

# Run locally
pnpm dev

# Run tests
pnpm test

# Build
pnpm build
```

Cloudflare runtime: `npx wrangler dev` for local development with Durable Objects.

## Deployment

Deployed to Cloudflare Workers + Durable Objects (WebSocket Hibernation API).

```bash
# Deploy
wrangler deploy
```

## Environment Variables

| Variable | Purpose | Required |
|----------|---------|----------|
| `FABRICA_RELAY_JWT_SECRET` | Secret for validating relay JWTs (HS256) | Yes |
| `DIRECTOR_URL` | Public director origin | Yes |
| `CELL_DURABLE_OBJECT` binding | Configured in wrangler.toml | Yes (via binding) |
| D1 database binding `DB` | Configured in wrangler.toml | Yes (via binding) |

## License

Part of the Fabrica project. See main repository for license details.
