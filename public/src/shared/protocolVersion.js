(function initProtocolVersion(root, factory) {
  const protocol = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = protocol;
  root.MFAProtocol = protocol;
}(typeof globalThis !== "undefined" ? globalThis : this, function makeProtocolVersion() {
  "use strict";

  // WebSocket protocol version shared by the server (hello message + state
  // snapshots) and the client compatibility check. The frontend may be served
  // by Netlify while the WebSocket backend is deployed separately, so version
  // skew is a real failure mode: a stale backend silently missing fields must
  // be detectable instead of being masked by client fallbacks.
  //
  // History:
  //   1 = original MessagePack snapshot protocol (no version field on the wire).
  //   2 = authoritative per-design-index ship.weaponAngles in every snapshot,
  //       plus protocolVersion/serverBuildSha identification fields.
  const PROTOCOL_VERSION = 2;

  // Highest protocol this client build understands. A server reporting a newer
  // protocol is actually incompatible and is rejected with a clear message
  // (differing build SHAs alone never block play).
  const MAX_SUPPORTED_PROTOCOL = 2;

  // Minimum protocol that guarantees authoritative weapon angles. Backends
  // below (or not reporting) this need redeploying; turret verification cannot
  // be claimed against them.
  const WEAPON_ANGLES_PROTOCOL = 2;

  return Object.freeze({ PROTOCOL_VERSION, MAX_SUPPORTED_PROTOCOL, WEAPON_ANGLES_PROTOCOL });
}));
