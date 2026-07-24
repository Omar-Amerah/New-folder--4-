// Regression coverage for authoritative-balance revision + compatibility.
//
// The server advertises a balance revision; the client compares it against the
// revision it was built with. A mismatch must be detectable (to block combat),
// a valid matching load must be accepted, and malformed balance must be rejected
// without partial application or zero-filling.

const assert = require("assert");
const B = require("./public/src/shared/balanceRevision");
const { BALANCE, BALANCE_REVISION } = require("./src/server/balanceConfig");

// 1. Successful matching load: server revision equals a recomputation of the
//    same balance, and equal content yields equal revisions across "sides".
(function matchingLoad() {
  assert.strictEqual(typeof BALANCE_REVISION, "string");
  assert.strictEqual(BALANCE_REVISION, B.computeBalanceRevision(BALANCE), "server revision matches a recomputation");
  const clientCopy = JSON.parse(JSON.stringify(BALANCE));
  assert.strictEqual(B.computeBalanceRevision(clientCopy), BALANCE_REVISION, "identical balance content matches across sides");
  assert.strictEqual(B.evaluateBalanceCompatibility(BALANCE_REVISION, BALANCE_REVISION), "ok");
  console.log("PASS: matching balance revisions are compatible");
})();

// 2. Revision is deterministic and key-order independent.
(function deterministicKeyOrder() {
  const a = { components: [{ id: "x", cost: 1, weapon: { family: "beam", damage: 2 } }], shipPricing: {}, economy: {}, match: {} };
  const b = { match: {}, economy: {}, shipPricing: {}, components: [{ weapon: { damage: 2, family: "beam" }, cost: 1, id: "x" }] };
  assert.strictEqual(B.computeBalanceRevision(a), B.computeBalanceRevision(b), "key ordering does not change the revision");
  console.log("PASS: revision is deterministic and key-order independent");
})();

// 3. Any meaningful value change changes the revision (older/newer sides differ).
(function valueChangeChangesRevision() {
  const base = JSON.parse(JSON.stringify(BALANCE));
  const older = JSON.parse(JSON.stringify(BALANCE));
  older.components[0] = { ...older.components[0], cost: (Number(older.components[0].cost) || 0) + 1 };
  const clientRev = B.computeBalanceRevision(base);
  const serverRev = B.computeBalanceRevision(older);
  assert.notStrictEqual(clientRev, serverRev, "a value change produces a different revision");
  assert.strictEqual(B.evaluateBalanceCompatibility(clientRev, serverRev), "mismatch", "differing revisions are a mismatch");
  console.log("PASS: older/newer balance revisions are detected as a mismatch");
})();

// 4. Missing revision on either side is 'unknown' (never a confirmed match).
(function unknownWhenMissing() {
  assert.strictEqual(B.evaluateBalanceCompatibility(null, "abc"), "unknown");
  assert.strictEqual(B.evaluateBalanceCompatibility("abc", null), "unknown");
  assert.strictEqual(B.evaluateBalanceCompatibility(null, null), "unknown");
  console.log("PASS: a missing revision is treated as unknown, not a match");
})();

// 5. Invalid balance payloads are rejected (no partial apply / zero-fill).
(function rejectsInvalid() {
  assert.strictEqual(B.validateBalancePayload(null).ok, false, "null payload rejected");
  assert.strictEqual(B.validateBalancePayload([]).ok, false, "array payload rejected");
  assert.strictEqual(B.validateBalancePayload({}).ok, false, "empty object rejected (missing components)");
  assert.strictEqual(B.validateBalancePayload({ components: [] , shipPricing:{}, economy:{}, match:{} }).ok, false, "empty components rejected");
  assert.strictEqual(B.validateBalancePayload({ components: [{}], shipPricing:{}, economy:{}, match:{} }).ok, false, "component without id rejected");
  const missingSections = B.validateBalancePayload({ components: [{ id: "x" }] });
  assert.strictEqual(missingSections.ok, false, "missing required sections rejected");
  assert.ok(missingSections.errors.some((e) => /shipPricing/.test(e)), "diagnostic names the missing section");
  console.log("PASS: malformed balance payloads are rejected with diagnostics, never zero-filled");
})();

// 6. A valid payload passes validation.
(function acceptsValid() {
  const valid = { components: [{ id: "beamEmitter" }], shipPricing: {}, economy: {}, match: {} };
  assert.deepStrictEqual(B.validateBalancePayload(valid), { ok: true, errors: [] });
  console.log("PASS: a structurally valid balance payload is accepted");
})();

// 7. The server exposes its revision on the hello handshake and state snapshots.
(function serverAdvertisesRevision() {
  const snapshots = require("./src/server/snapshots");
  const room = {
    code: "R", phase: "active", adminId: null, stateEpoch: 1, snapshotSeq: 0, staticRevision: 1,
    componentCatalogueRevision: 1, mapSizeLabel: "tiny", world: { width: 10, height: 10 },
    map: { seed: 1, asteroids: [] }, rules: { gameMode: "solo" }, winner: null, matchStartedAt: 0,
    maxScore: 100, bullets: [], effects: [], points: [], controlVictory: null, teamScores: {},
    players: new Map(), ships: new Map(), clients: new Set()
  };
  const snap = snapshots.snapshotRoom(room, 0, null, true, null, null);
  assert.strictEqual(snap.balanceRevision, BALANCE_REVISION, "state snapshot carries the server balance revision");
  console.log("PASS: the server advertises its balance revision in snapshots");
})();

console.log("\nBALANCE REVISION REGRESSION TESTS PASSED");
