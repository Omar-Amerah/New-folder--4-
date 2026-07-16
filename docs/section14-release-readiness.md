# Section 14 release-readiness audit

This project is still in active development. These checks harden confirmed deployment and abuse edges without freezing gameplay features or changing wire message names.

## Security audit table

| Finding | Severity | Evidence | Affected file | Existing protection | Action taken / reason |
|---|---:|---|---|---|---|
| WebSocket origin/path handling | High | Upgrade validation requires `/socket`, GET, WebSocket headers and exact production origins. | `server.js` | Strict allowlist and safe 403/404/405 responses. | Added Section 14 regression coverage for allowed origins, rejected origins, wrong paths and harmless query strings. |
| Oversized or malformed WebSocket frames | High | Parser enforces MessagePack binary frames and max message bytes. | `src/server/wsFrameParser.js` | Protocol errors close only the offending client. | Added regression coverage for oversize frames and malformed pre-join messages. |
| Unbounded per-client management messages | Medium | Rare actions such as bot/rule/purchase requests had authoritative checks but no generic per-connection throttle. | `src/server/messageRouter.js` | Schema, permission and phase checks. | Added small per-connection token buckets with generous real-time allowance for commands and separate management allowance. |
| HTTP static traversal and methods | Medium | Static paths are normalized under `public/`; only GET/HEAD are supported. | `server.js` | Path-relative containment check and 405. | Added regression coverage and broader compatible security headers. |
| Resume credentials in URLs/logs | High | Resume credentials are stored in room-scoped client storage and are not part of invitation URLs. | `public/src/reconnectStorage.js`, `public/src/ui/lobbyUi.js` | Opaque credential storage; invitation copies room/server only. | No protocol change. Confirmed by audit; no credentials added to logs, health or invite flows. |
| Health disclosure | Low | `/health` returns lightweight build/protocol counts only. | `server.js` | `no-store`, no credentials, no player or room codes. | Preserved public endpoint and added security headers. Aggregate counts remain for operations. |
| Complete CSP | Low | The frontend supports user-configured split-origin backend URLs. | `netlify.toml`, `public/index.html` | Other headers restrict sniffing/referrers/framing/permissions. | Documented gap. A strict `connect-src` would either break configured Render backends or allow broad WebSocket destinations; defer until deployments provide an explicit CSP backend origin. |
| Dependency vulnerabilities | Unknown until audit | Production dependencies are `@msgpack/msgpack` and `pixi.js`. | `package.json` | Lockfile present. | Run `npm audit --omit=dev`; do not force major upgrades in this hardening pass. |

## Deployment variables

Required production variables:

- `NODE_ENV=production` for backend production behavior.
- `WS_ALLOWED_ORIGINS` as a comma-separated list of exact frontend origins allowed to open `/socket` (for example a Netlify origin). Do not use `*` in production.
- `PORT` is supplied by Render when present; local development falls back to the configured default.

Optional variables:

- `WS_ALLOW_MISSING_ORIGIN=0` to reject missing-origin WebSocket upgrades.
- `ROOM_IDLE_MS` to tune in-memory empty-room cleanup timing.

In-memory rooms do **not** survive a backend deployment restart. Players should use normal Create/Join after a deploy if reconnect state is gone.

## Manual production smoke procedure

1. Open the Netlify frontend.
2. Verify the configured Render backend `/health` endpoint returns 200 and no-store.
3. Click Create and confirm a generated non-empty room code.
4. Copy an invitation and confirm it contains no resume credential.
5. Join from a second browser context.
6. Change team/wing.
7. Start design.
8. Ready with a valid ship.
9. Start the match.
10. Issue a movement/attack command.
11. Purchase a ship.
12. Disconnect and reconnect.
13. Finish or close the lobby.

## Release checklist

- [ ] CI is green for all four jobs: Static checks + unit tests; Integration + protocol + server soak; Browser tests; Renderer soak.
- [ ] `npm run release:check` is green.
- [ ] Authoritative balance validates.
- [ ] Frontend generated files are current.
- [ ] Netlify build succeeds.
- [ ] Render service is healthy.
- [ ] `WS_ALLOWED_ORIGINS` contains the production frontend origin.
- [ ] Create Game is verified, including generated room code.
- [ ] Join Game is verified.
- [ ] Two-client multiplayer is verified.
- [ ] Reconnect is verified.
- [ ] No credentials appear in URLs or logs.
- [ ] Production console has no unexpected errors.
- [ ] Known limitations are recorded.
- [ ] Rollback approach is recorded (redeploy the last known-good Netlify and Render releases).

## `release:check` contents

`npm run release:check` is a fast local gate that composes existing checks: production build, balance validation, generated-file parity, protocol schema checks, deployment-health checks, static production-path checks, Section 14 security regressions, and quick lifecycle coverage. It does not install browsers, contact live deployments, run long soaks, or require internet access.
