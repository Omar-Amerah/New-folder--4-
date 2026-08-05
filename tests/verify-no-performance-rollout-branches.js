"use strict";

// Phase 7 guard: the proven performance paths are now the only production
// implementations. Keep the retired identifiers encoded here so this verifier
// cannot become a false positive merely by mentioning the names it checks.
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = __dirname;
const retired = [
  "UFJPSkVDVElMRV9GTEFLX1NJTkdMRV9QQVNT",
  "UFJPSkVDVElMRV9HUklEX0NPTExJU0lPTg==",
  "UFJPSkVDVElMRV9HVUlEQU5DRV9DQURFTkNF",
  "SU5DUkVNRU5UQUxfU1BBVElBTF9JTkRFWA==",
  "V0VBUE9OX1RBUkdFVF9BQ1FVSVNJVElPTl9DQURFTkNF",
  "RklYRURfQVVUSE9SSVRBVElWRV9USU1FU1RFUA==",
  "T1BUSU1JWkVEX0hFQVRfUlVOVElNRQ==",
  "T1BUSU1JWkVEX0RST05FX1JVTlRJTUU=",
  "T1BUSU1JWkVEX1ZJU0lCSUxJVFlfUlVOVElNRQ==",
  "T1BUSU1JWkVEX0NPTU1BTkRfQVVSQV9SVU5USU1F",
  "T1BUSU1JWkVEX1NUQVRJT05fV0VBUE9OX1JVTlRJTUU=",
  "RU5USVRZX0RFTFRBX1NOQVBTSE9UUw==",
  "U0hBUkVEX01PVkVNRU5UX0NPTlRBQ1RfUEFJUlM=",
  "UEFDS0VEX0ZMRUVUX1NPTFZFUg==",
  "ZmluZE9sZENvbXBvbmVudEhpdA==",
  "dXBkYXRlU2hpcEhlYXRMZWdhY3k=",
  "dXBkYXRlRHJvbmVFbnRpdHlMZWdhY3k=",
  "dXBkYXRlRHJvbmVCYXlzTGVnYWN5",
  "Y29tcHV0ZVRlYW1WaXNpYmlsaXR5TGVnYWN5",
  "ZW5zdXJlVGVhbVZpc2liaWxpdHlMZWdhY3k=",
  "cmVjYWxjdWxhdGVBdXJhcw==",
  "TU9ERVJOX01PVkVNRU5U"
].map((value) => Buffer.from(value, "base64").toString("utf8"));

function filesUnder(directory) {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (["node_modules", ".git", "dist", "build"].includes(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...filesUnder(absolute));
    else if (/\.(?:js|cjs|mjs|json)$/.test(entry.name)) result.push(absolute);
  }
  return result;
}

const offenders = [];
for (const file of filesUnder(ROOT)) {
  if (path.basename(file) === path.basename(__filename)) continue;
  const source = fs.readFileSync(file, "utf8");
  for (const name of retired) if (source.includes(name)) offenders.push(`${path.relative(ROOT, file)}: ${name}`);
}
assert.deepStrictEqual(offenders, [], `Retired performance rollout references remain:\n${offenders.join("\n")}`);

const protocol = require("./src/server/protocol");
assert.strictEqual(protocol.MIN_CLIENT_PROTOCOL, 6);
assert.strictEqual(protocol.MAX_CLIENT_PROTOCOL, 6);
assert.ok(protocol.REQUIRED_CAPABILITIES.includes("entityDeltaSnapshotsV1"));
assert.ok(!protocol.OPTIONAL_CAPABILITIES.includes("entityDeltaSnapshotsV1"));
assert.strictEqual(protocol.negotiate({ protocolVersion: 6, minProtocolVersion: 6, maxProtocolVersion: 6, capabilities: ["messagepack"] }).ok, false);
assert.strictEqual(protocol.negotiate({ protocolVersion: 6, minProtocolVersion: 6, maxProtocolVersion: 6, capabilities: ["messagepack", "entityDeltaSnapshotsV1"] }).ok, true);

console.log("Phase 7 rollout-branch verifier passed.");
