# Networking protocol and snapshot transport

## Implemented in Section 9A

### 1. HTTP upgrade
`server.js` continues to own static HTTP serving and the `/socket` upgrade. The endpoint remains a plain RFC 6455 WebSocket; no Socket.IO subprotocol is introduced.

### 2. WebSocket frame handling
`src/server/websocketServer.js` owns frame parsing/writing and connection close behavior. Client frames must be masked, unfragmented, use no RSV bits, and use binary opcode `0x2` for MessagePack application messages. Ping frames are answered with pong frames; malformed control frames, reserved opcodes, unmasked frames, unsupported fragmentation and oversized frames are closed with stable RFC close codes.

### 3. MessagePack encoding
`src/server/wsCodec.js` and `public/src/network.js` define MessagePack as the production wire format. Server outbound messages and snapshots are binary MessagePack frames. The production browser client fails explicitly when the MessagePack bundle is absent; it does not silently downgrade to JSON. JSON text frames are legacy-incompatible and are rejected by the server transport.

Supported values are MessagePack primitives used by the game schema: nil/null, booleans, finite integers/floats, strings, arrays and plain objects. Extension values and application binary blobs are not accepted as client message fields.

### 4. Connection identity
A WebSocket transport receives a temporary `connectionId` such as `c1` in `hello`. It exists only for diagnostics, stale-socket protection and attachment tracking. Reconnect creates a new `connectionId`.

### 5. Stable player identity
A joined room slot receives a stable `playerId` such as `pl1` in `joined`. Ownership, economy, ships, admin state and snapshots continue to key on `playerId`, never `connectionId`.

### 6. Protocol negotiation
Protocol version 4 is current. The server accepts client protocol range 4..4 and requires the `messagepack` capability. Build-SHA differences are diagnostic-only and do not block compatible protocol versions.

| Field | Meaning |
| --- | --- |
| `protocolVersion` | Peer preferred protocol. |
| `minProtocolVersion` / `maxProtocolVersion` | Peer compatible range. |
| `frontendBuildSha` / `backendBuildSha` | Diagnostic build IDs; mismatch is allowed. |
| `capabilities` | Required/optional behavior flags such as `messagepack`, `resume-v1`, `heartbeat-v1`. |

Rejected clients receive `type:"error"` with stable codes (`incompatible-protocol`, `missing-capability`) before gameplay snapshots are authorized.

### 7. Join and resume attachment
`join` carries protocol fields, display name, room code, team and optional private `resumeToken`. A valid resume token reattaches the same `playerId`, increments `attachmentId`, replaces the old transport and returns the new `connectionId`.

### 8. Validated client intents
`src/server/clientSchemas.js` is the central accepted-message registry. It bounds top-level type, strings, numbers, arrays, nesting, design entries, ship-id arrays, room codes and request IDs before domain handlers run. Domain handlers still enforce room phase, admin permission, ownership and current attachment.

### 9. Control responses and errors
Error packets use `type:"error"`, `code`, human-readable `message`, optional `requestId`, and `retryable` only when meaningful. Clients should branch on `code`; English text is for UI only.

### 10. Heartbeat and reconnect transport
Application ping/pong remains the browser-compatible liveness mechanism. `serverTimeMs` is a wall-clock diagnostic timestamp. Client latency is round-trip browser monotonic time and must not be compared directly with server wall time.

## Module ownership
- `server.js`: HTTP serving and upgrade routing only.
- `websocketServer.js`: RFC 6455 framing, buffers, close behavior, connection identity.
- `wsCodec.js`: MessagePack encode/decode only.
- `protocol.js`: compatibility matrix, capabilities and stable envelope helpers.
- `clientSchemas.js`: client-message schema registry and logical limits.
- `messages.js`: validated message dispatch and outbound helpers.
- `players.js`/`rooms.js`: player attachment, room lifecycle and authorization.
- `public/src/network.js`: browser WebSocket, MessagePack, connection generation and sends.

No module should both parse frames and mutate gameplay state; no gameplay module should inspect resume credentials except through player lifecycle helpers.

## Reserved for Section 9B snapshot delivery
Section 9B will define snapshot epochs, sequence numbers, baselines, resync requests, snapshot backpressure, sequence-gap browser scenarios and network-performance metrics. Those are intentionally not implemented here.
