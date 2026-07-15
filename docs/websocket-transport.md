# WebSocket transport

The game server accepts WebSocket connections only on `/socket` and keeps protocol version 4 and MessagePack application messages unchanged.

## Handshake

Upgrade validation happens before any `101 Switching Protocols` response. The server requires `GET`, the configured socket path, `Upgrade` containing the `websocket` token, `Connection` containing `Upgrade`, exactly one `Sec-WebSocket-Key`, exactly one `Sec-WebSocket-Version: 13`, and a key that base64-decodes to 16 bytes. Wrong paths return 404, methods return 405, malformed requests return 400, unsupported versions return 426 with `Sec-WebSocket-Version: 13`, and origin rejection returns 403.

Origins are exact scheme/host/port matches with default ports normalized. Development defaults to `*`; production should set `WS_ALLOWED_ORIGINS` to a comma-separated allowlist for split deployments such as Netlify frontend plus separate backend. Missing `Origin` is allowed for non-browser clients unless `WS_ALLOW_MISSING_ORIGIN=0` is set. Substring and wildcard suffix matching are not used.

## Frames, chunks, and messages

TCP chunks are arbitrary byte deliveries. WebSocket frames are parsed incrementally from those chunks. Fragmented WebSocket messages start with a binary frame with `FIN=false`, continue with continuation frames, and are delivered as one complete MessagePack application message only after the final continuation. The MessagePack decoder is outside the frame parser and runs once per complete binary message.

Client frames must be masked; server frames are unmasked. RSV bits and permessage-deflate are unsupported. Control frames must be final and at most 125 bytes. Ping, pong, and close frames may be interleaved with fragmented messages. Text frames are rejected in production with 1003 so JSON cannot reach the router.

## Limits and lifecycle

Individual frames, aggregate fragmented messages, and unread TCP buffers are bounded by server configuration derived from `MAX_MESSAGE_BYTES`. Oversized application messages close with 1009. Protocol errors close with 1002; invalid UTF-8 close reasons close with 1007. Heartbeat uses WebSocket ping/pong separately from application messages, counts inbound traffic as liveness, and stops on finalization. Close sends one close frame, finalizes once, resets outbound state, and removes the client from rooms.

Backpressure remains owned by the outbound module. The transport writes protocol safety frames directly but does not introduce unbounded queues. Diagnostics are bounded to counts, categories, close codes, and buffer sizes; raw payloads, decoded messages, names, room secrets, resume credentials, and IP addresses are not recorded.

## Deployment assumptions

TLS termination and proxying are outside this server. Do not trust `X-Forwarded-For` for per-IP limits unless a future explicit trusted-proxy setting is added. Reverse proxies must pass HTTP/1.1 upgrade headers unchanged and route only `/socket` to the WebSocket endpoint.
