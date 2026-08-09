# Server routing and lifecycle

## Intended dependency direction

The intended acyclic direction is: composition root -> transport/router/outbound/snapshot/simulation -> domain modules -> pure helpers/config. Transport does not import route handlers, handlers do not own socket framing, snapshot delivery does not own domain mutation and domain modules do not import WebSocket framing.

## Current ownership

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

## Current boundary

RFC 6455 fragmentation and frame-parser hardening are implemented in the transport modules and covered by the `test:websocket-*` checks. Reconnect identity is based on stable room player IDs and private room-scoped resume credentials; account identity and persistence are outside the current in-memory room model.

## WebSocket transport

WebSocket transport hardening is documented in `docs/websocket-transport.md`. The server now validates the RFC 6455 version-13 upgrade before sending `101`, supports exact allowlisted origins for split frontend/backend deployments, rejects production text frames, reconstructs fragmented binary messages before MessagePack decode, accepts interleaved control frames, validates close payloads and UTF-8 close reasons, and bounds unread and aggregate message buffers. New transport checks cover handshake, fragmentation, lifecycle, fuzz, and soak behaviour through the `test:websocket-*` scripts.
