// Regression coverage for team-size-independent objective scoring.
//
// Objective score (relay captures + periodic relay-control income) is awarded to
// a SIDE exactly once, never once per player, so a larger team cannot earn it
// faster. The scoreboard snapshot value and the victory check read the same
// authoritative side score. Solo scoring stays per-player.

const assert = require("assert");
const { SCORE_PER_CONTROLLED_POINT } = require("./src/server/config");
const { BALANCE } = require("./src/server/balanceConfig");
const {
  updateScoring,
  updateCapturePoints,
  sideScore,
  scoreSides,
  snapshotSideScores,
  resetTeamScores,
  topScoringSide
} = require("./src/server/objectives");

const CAPTURE_SCORE = BALANCE.capture.captureScore;

function player(id, team) {
  return { id, name: id, team, captures: 0, score: 0, money: 0, earned: 0, maxMoney: 9999, ready: true, ships: [] };
}

function makeRoom(mode, playerSpecs, pointCount = 1) {
  const players = new Map(playerSpecs.map((p) => [p.id, player(p.id, mode === "solo" ? p.id : p.team)]));
  const points = [];
  for (let i = 0; i < pointCount; i++) points.push({ id: `P${i}`, x: 0, y: 0, radius: 80, ownerId: null, ownerTeam: null, progress: 0, contested: false });
  return {
    code: "T", clients: new Set(), phase: "active", rules: { gameMode: mode },
    players, points, winner: null, winnerAt: 0,
    controlVictory: { team: null, playerId: null, startedAt: null, remaining: null, requiredSeconds: 20 },
    lastScoreAt: 0, maxScore: 900, teamScores: {}
  };
}

// Give `count` relays to `side` (team key or player id) at full control.
function ownRelays(room, side, count, ownerId) {
  for (let i = 0; i < count; i++) {
    room.points[i].ownerTeam = side;
    room.points[i].ownerId = ownerId || side;
    room.points[i].progress = 1;
    room.points[i].contested = false;
  }
}

// Tick relay-control income `seconds` times (once per second).
function tickControl(room, seconds) {
  for (let s = 1; s <= seconds; s++) {
    room.lastScoreAt = 0; // force a score tick each call
    updateScoring(room, s * 1000);
  }
}

// 1. 1v1 and 2v2 teams controlling the same relays gain score at the same rate.
(function equalRateRegardlessOfTeamSize() {
  const oneVone = makeRoom("teams", [{ id: "a", team: "blue" }, { id: "z", team: "red" }]);
  ownRelays(oneVone, "blue", 1, "a");
  tickControl(oneVone, 5);

  const twoVtwo = makeRoom("teams", [
    { id: "a", team: "blue" }, { id: "b", team: "blue" },
    { id: "y", team: "red" }, { id: "z", team: "red" }
  ]);
  ownRelays(twoVtwo, "blue", 1, "a");
  tickControl(twoVtwo, 5);

  assert.strictEqual(sideScore(oneVone, "blue"), 5 * SCORE_PER_CONTROLLED_POINT, "1v1 blue earns exactly one increment per relay per tick");
  assert.strictEqual(sideScore(twoVtwo, "blue"), sideScore(oneVone, "blue"), "2v2 earns at the same rate as 1v1 for the same relays");
  console.log("PASS: 1v1 and 2v2 controlling the same relays gain score at the same rate");
})();

// 2. 2v1 does not give the two-player team doubled objective income.
(function noDoubledIncomeForBiggerTeam() {
  const room = makeRoom("teams", [
    { id: "a", team: "blue" }, { id: "b", team: "blue" }, // 2 players
    { id: "z", team: "red" }                               // 1 player
  ]);
  ownRelays(room, "blue", 1, "a");
  tickControl(room, 4);
  assert.strictEqual(sideScore(room, "blue"), 4 * SCORE_PER_CONTROLLED_POINT, "two-player team earns single (not doubled) objective income");
  console.log("PASS: a two-player team does not receive doubled objective income");
})();

// 3. Relay capture awards the configured amount exactly once.
(function captureAwardsOnce() {
  const room = makeRoom("teams", [
    { id: "a", team: "blue" }, { id: "b", team: "blue" }, { id: "z", team: "red" }
  ]);
  // Two blue ships sit on the relay; capture score must still be awarded once.
  updateCapturePoints(room, [
    { id: "a", ownerId: "a", x: 0, y: 0, alive: true, stats: {}, design: [] },
    { id: "b", ownerId: "b", x: 0, y: 0, alive: true, stats: {}, design: [] }
  ], 10);
  assert.strictEqual(room.points[0].ownerTeam, "blue", "blue captured the relay");
  assert.strictEqual(sideScore(room, "blue"), CAPTURE_SCORE, "capture awards the configured amount exactly once to the team");
  assert.strictEqual(room.players.get("a").score, 0, "objective score does not land on individual players");
  assert.strictEqual(room.players.get("b").score, 0, "objective score does not land on individual players");
  console.log("PASS: relay capture awards the configured amount exactly once");
})();

// 4. Scoreboard snapshot value equals the server victory-check value.
(function scoreboardEqualsVictoryValue() {
  const room = makeRoom("teams", [{ id: "a", team: "blue" }, { id: "z", team: "red" }]);
  ownRelays(room, "blue", 1, "a");
  tickControl(room, 3);
  const snap = snapshotSideScores(room);
  const [victorySide, victoryScore] = topScoringSide(room);
  assert.strictEqual(snap[victorySide], victoryScore, "scoreboard snapshot value equals the victory-check value");
  assert.strictEqual(snap.blue, sideScore(room, "blue"), "snapshot exposes the authoritative team score");
  console.log("PASS: scoreboard value equals the server victory-check value");
})();

// 5. Match ends at the displayed score threshold (via the authoritative value).
(function matchEndsAtThreshold() {
  const room = makeRoom("teams", [{ id: "a", team: "blue" }, { id: "z", team: "red" }]);
  room.maxScore = 3 * SCORE_PER_CONTROLLED_POINT;
  ownRelays(room, "blue", 1, "a");
  // finalizeMatchWinner needs economy + messages; stub broadcasts through room.
  room.clients = new Set();
  tickControl(room, 3);
  // Score victory is evaluated inside updateScoring; after reaching threshold the
  // room should have a winner on the blue side.
  assert.ok(sideScore(room, "blue") >= room.maxScore, "blue reached the score threshold");
  assert.ok(room.winner && (room.winner.team === "blue"), "match ends for the side that reached the displayed threshold");
  console.log("PASS: match ends at the displayed score threshold");
})();

// 6. Restart / return-to-lobby resets scores.
(function resetClearsScores() {
  const room = makeRoom("teams", [{ id: "a", team: "blue" }, { id: "z", team: "red" }]);
  ownRelays(room, "blue", 1, "a");
  tickControl(room, 5);
  assert.ok(sideScore(room, "blue") > 0, "blue has accrued score");
  resetTeamScores(room);
  assert.strictEqual(sideScore(room, "blue"), 0, "team scores reset to zero");
  assert.deepStrictEqual(snapshotSideScores(room), { blue: 0, red: 0 }, "snapshot reflects reset scores");
  console.log("PASS: restart and return-to-lobby reset scores");
})();

// 7. Joining / leaving does not duplicate or erase existing team score.
(function membershipDoesNotDisturbTeamScore() {
  const room = makeRoom("teams", [{ id: "a", team: "blue" }, { id: "z", team: "red" }]);
  ownRelays(room, "blue", 1, "a");
  tickControl(room, 3);
  const before = sideScore(room, "blue");
  // A new blue teammate joins mid-match.
  room.players.set("b", player("b", "blue"));
  assert.strictEqual(sideScore(room, "blue"), before, "joining does not change existing team score");
  // The original blue player disconnects/leaves.
  room.players.delete("a");
  assert.strictEqual(sideScore(room, "blue"), before, "leaving does not erase existing team score");
  console.log("PASS: joining/leaving does not duplicate or erase existing team score");
})();

// 8. Solo scoring remains per-player (unchanged).
(function soloScoringUnchanged() {
  // Two relays; player "a" controls only one, so no instant full-control win.
  const room = makeRoom("solo", [{ id: "a" }, { id: "b" }], 2);
  ownRelays(room, "a", 1, "a"); // in solo, side key === player id
  tickControl(room, 4);
  assert.strictEqual(room.players.get("a").score, 4 * SCORE_PER_CONTROLLED_POINT, "solo relay income accrues to the player");
  assert.strictEqual(room.players.get("b").score, 0, "other solo player earns nothing");
  assert.strictEqual(sideScore(room, "a"), room.players.get("a").score, "solo side score is the player's own score");
  console.log("PASS: solo scoring remains per-player and unchanged");
})();

console.log("\nTEAM OBJECTIVE SCORING REGRESSION TESTS PASSED");
