# Server routing and lifecycle

## Original dependency graph

Before Section 11A, `server.js` owned the HTTP listener, WebSocket upgrade, simulation interval, snapshot interval and room cleanup interval. `src/server/websocketServer.js` owned client creation, frame parsing, heartbeats and close handling. `src/server/messages.js` mixed outbound delivery, queues, snapshot delivery and inbound dispatch. Domain mutation lived in `players`, `rooms`, `ships`, `movement`, `combat`, `economy` and `objectives`.

Late/circular requires found:

- `messages.js` lazily loaded `websocketServer` to call `writeFrame` and `closeClient`.
- `websocketServer.js` lazily loaded `messages` for hello, decoded-message dispatch, bad-message errors and outbound reset during finalization.
- `messages.js` lazily loaded `snapshots` during snapshot delivery.
- `messages.js` lazily loaded domain modules inside dispatch.
- `server.js` lazily loaded debug diagnostics only for `/debug/turrets`.

## Intended dependency direction

The intended acyclic direction is: composition root -> transport/router/outbound/snapshot/simulation -> domain modules -> pure helpers/config. Transport does not import route handlers, handlers do not own socket framing, snapshot delivery does not own domain mutation and domain modules do not import WebSocket framing.

## Current ownership after Section 11A

- HTTP server and graceful process shutdown: `server.js` composition root.
- WebSocket upgrade and raw frame parsing: `src/server/websocketServer.js`.
- Client creation and heartbeat timers: `src/server/websocketServer.js`.
- Inbound frame decoding: `src/server/websocketServer.js`.
- Schema validation, protocol negotiation and message dispatch: `src/server/messageRouter.js`.
- Route permissions, phase metadata and rate-limit policy inventory: `src/server/routeRegistry.js`.
- Outbound control messages, queues, backpressure and reset: `src/server/outbound.js`.
- Full and compact snapshot delivery: `src/server/snapshotDelivery.js`.
- Room/player/gameplay mutation: existing domain modules.
- Simulation tick ordering: `src/server/simulation.js`.
- Snapshot, simulation and room cleanup intervals: per `createGameServer()` instance.

## Deferred work

Low-level RFC 6455 fragmentation and frame-parser hardening remains deferred to Section 11B. Reconnect identity hardening remains deferred to a later identity/persistence section.

## Section 11B WebSocket transport notes

WebSocket transport hardening is documented in `docs/websocket-transport.md`. The server now validates the RFC 6455 version-13 upgrade before sending `101`, supports exact allowlisted origins for split frontend/backend deployments, rejects production text frames, reconstructs fragmented binary messages before MessagePack decode, accepts interleaved control frames, validates close payloads and UTF-8 close reasons, and bounds unread and aggregate message buffers. New transport checks cover handshake, fragmentation, lifecycle, fuzz, and soak behaviour through the `test:websocket-*` scripts.
