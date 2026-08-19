# Fabrica-relay

WebSocket relay server for Fabrica — bridges phone↔desktop communication when direct LAN isn't available.

## Architecture

```
┌─────────────┐                    ┌─────────────┐
│  Desktop    │◄──── WebSocket ───►│             │
│  (Fabrica)  │    /v1/host/control│   Cell      │
└─────────────┘                    │  (WS Server)│
                                   │             │
┌─────────────┐                    │             │
│  Mobile     │◄──── WebSocket ───►│             │
│  (Fabrica)  │    /v1/phone/*     │             │
└─────────────┘                    └─────────────┘
                                         ▲
                                         │
                                   ┌─────┴─────┐
                                   │ Director  │
                                   │ (HTTP API)│
                                   └───────────┘
```

### Director

HTTP API for authentication and cell assignment.

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/v1/token-exchange` | POST | Exchange Fabrica access token for relay JWT |
| `/v1/assign` | POST | Assign host to a cell, return cell URL + epoch + lease |

### Cell

WebSocket server that bridges host and phone connections.

| Path | Purpose |
|------|---------|
| `/v1/host/control` | Desktop app control channel (challenge-response, ping/pong, conn-open) |
| `/v1/phone/*` | Mobile app connections (relay-hello, relay-moved, data tunneling) |

## Security

- **E2EE**: NaCl box (X25519+XSalsa20+Poly1305) for challenge-response
- **Challenge-response**: Server proves identity to host via encrypted transcript + HMAC proof
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

## Deployment

Deployed to Fly.io via Dockerfile.

```bash
# Deploy
fly deploy

# Check status
fly status
```

## Environment Variables

| Variable | Purpose | Required |
|----------|---------|----------|
| `FABRICA_ACCESS_TOKEN_SECRET` | Secret for validating Fabrica access tokens | Yes |
| `RELAY_JWT_SECRET` | Secret for signing relay JWTs | Yes |
| `DATABASE_URL` | SQLite or Postgres connection string | Yes |
| `CELL_PORT` | WebSocket server port | No (default: 443) |
| `DIRECTOR_PORT` | HTTP API port | No (default: 443) |

## License

Part of the Fabrica project. See main repository for license details.
