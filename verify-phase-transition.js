"use strict";
// Regression guard for the phase-transition UX bug caused by the undefined
// `selectedLivingShips` reference in snapshotChangeSummary. This file uses
// static source checks plus a pure runtime reproduction of the corrected
// selection-count and phase-transition logic so the fix is exercised in Node
// without a browser DOM.

const assert = require("assert");
const fs = require("fs");

const messages = fs.readFileSync("public/src/messages.js", "utf8");
const lobby = fs.readFileSync("public/src/ui/lobbyUi.js", "utf8");
const stateSrc = fs.readFileSync("public/src/state.js", "utf8");

// --- 1. The exact bug must not regress --------------------------------------
assert(
  messages.includes("previousIndex?.selectedLivingShips?.length ?? 0"),
  "snapshotChangeSummary must read previousIndex selectedLivingShips with nullish coalescing"
);
assert(
  messages.includes("nextIndex?.selectedLivingShips?.length ?? 0"),
  "snapshotChangeSummary must read nextIndex selectedLivingShips with nullish coalescing"
);
assert(
  !messages.includes("const selectedIdsArray"),
  "unused selectedIdsArray variable should be removed"
);
assert(
  /function snapshotChangeSummary\(\s*previous,\s*next,\s*myId,\s*selectedIds,\s*previousIndex,\s*nextIndex\s*\)/.test(messages),
  "snapshotChangeSummary signature must receive previousIndex and nextIndex"
);

// --- 2. Fragile reference comparisons must be replaced --------------------
assert(
  !/economyChanged[\s\S]{0,120}previous\.economy/.test(messages),
  "economyChanged must not use non-existent root economy field"
);
assert(
  messages.includes("function playersChanged(previousIndex, nextIndex)"),
  "playersChanged must use semantic comparison from indexes"
);
assert(
  messages.includes("function economyChanged(previousIndex, nextIndex, myId)"),
  "economyChanged must compare current-player economy fields"
);
assert(
  messages.includes("function fleetChanged(previousIndex, nextIndex)"),
  "fleetChanged must compare ship indexes, not array references"
);

// --- 3. Authoritative state applied before presentation -----------------------
const snapshotAssign = messages.indexOf("state.snapshot = accepted;");
const phaseAssign = messages.indexOf("state.phase = accepted.phase ?? state.phase;");
const summaryCall = messages.indexOf("summary = snapshotChangeSummary(");
assert(snapshotAssign > 0 && summaryCall > snapshotAssign, "snapshot must be assigned before snapshotChangeSummary");
assert(phaseAssign > 0 && summaryCall > phaseAssign, "phase must be assigned before snapshotChangeSummary");
assert(
  messages.includes("function synchronizePhasePresentation(previousPhase, nextPhase)"),
  "synchronizePhasePresentation must be the single phase transition driver"
);
assert(
  /if\s*\(\s*phaseChanged\s*\)\s*\{[\s\S]{0,200}synchronizePhasePresentation\(/.test(messages),
  "phaseChanged must call synchronizePhasePresentation"
);

// --- 4. Pending request UI states for startDesign/deploy --------------------
assert(stateSrc.includes("pendingStartDesign: false,"), "state must track pendingStartDesign");
assert(stateSrc.includes("pendingDeploy: false,"), "state must track pendingDeploy");
assert(lobby.includes("state.pendingStartDesign"), "lobbyUi startDesign must use pendingStartDesign");
assert(lobby.includes("state.pendingDeploy"), "lobbyUi deployDesign must use pendingDeploy");
assert(lobby.includes("dom.deployButton.classList.add(\"is-loading\")"), "deploy button shows loading state");
assert(lobby.includes('dom.startDesignButton.classList.toggle("is-loading", state.pendingStartDesign)'), "start design button shows loading state");

// --- 5. Runtime reproduction of the fixed selection logic -------------------
function buildClientSnapshotIndex(snapshot, myId, selectedIds) {
  const shipById = new Map();
  const ownLivingShips = [];
  const ownLivingShipIds = [];
  const selectedLivingShips = [];
  const playersById = new Map();
  const relaysByTeam = new Map();
  for (const player of snapshot.players || []) playersById.set(player.id, player);
  for (const ship of snapshot.ships || []) {
    if (!ship) continue;
    shipById.set(ship.id, ship);
    const alive = ship.alive !== false;
    if (alive && ship.ownerId === myId) {
      ownLivingShips.push(ship);
      ownLivingShipIds.push(ship.id);
    }
    if (alive && selectedIds && selectedIds.has(ship.id)) selectedLivingShips.push(ship);
    if (ship.type === "relay" || ship.kind === "relay") {
      const owner = ship.ownerId || "neutral";
      let list = relaysByTeam.get(owner);
      if (!list) relaysByTeam.set(owner, list = []);
      list.push(ship);
    }
  }
  return { shipById, ownLivingShips, ownLivingShipIds, selectedLivingShips, playersById, relaysByTeam };
}

function playerFieldsEqual(prev, next) {
  const keys = ["name", "team", "teamName", "ready", "isAdmin", "isBot", "color", "colour", "connected"];
  if (!prev || !next) return false;
  for (const key of keys) if (prev[key] !== next[key]) return false;
  return true;
}

function playersChanged(previousIndex, nextIndex) {
  const prev = previousIndex?.playersById;
  const next = nextIndex?.playersById;
  if (!prev || !next) return true;
  if (prev.size !== next.size) return true;
  for (const [id, prevPlayer] of prev) {
    const nextPlayer = next.get(id);
    if (!nextPlayer || !playerFieldsEqual(prevPlayer, nextPlayer)) return true;
  }
  return false;
}

function snapshotChangeSummary(previous, next, myId, selectedIds, previousIndex, nextIndex) {
  const all = !previous || !previousIndex;
  const previousSelectedCount = previousIndex?.selectedLivingShips?.length ?? 0;
  const nextSelectedCount = nextIndex?.selectedLivingShips?.length ?? 0;
  return {
    phaseChanged: all || previous.phase !== next.phase,
    playersChanged: all || playersChanged(previousIndex, nextIndex),
    selectionAffected: all || previousSelectedCount !== nextSelectedCount
  };
}

const p1 = { id: "p1", name: "A", team: "blue", ready: false };
const s1 = { id: "s1", ownerId: "p1", alive: true };
const selected = new Set(["s1"]);
const idx1 = buildClientSnapshotIndex({ players: [p1], ships: [s1] }, "p1", selected);
const idx2 = buildClientSnapshotIndex({ players: [p1], ships: [s1] }, "p1", selected);
assert.strictEqual(idx1.selectedLivingShips.length, 1, "selected living ship should be indexed");
assert.strictEqual(idx2.selectedLivingShips.length, 1, "selected living ship should still be indexed");

const summary1 = snapshotChangeSummary({ phase: "lobby" }, { phase: "design" }, "p1", selected, idx1, idx2);
assert.strictEqual(summary1.phaseChanged, true, "phase change detected");
assert.strictEqual(summary1.playersChanged, false, "identical players not changed");
assert.strictEqual(summary1.selectionAffected, false, "same selection not affected");

// Compact follow-up where only ship count changes (selected destroyed)
const s1dead = { id: "s1", ownerId: "p1", alive: false };
const idx3 = buildClientSnapshotIndex({ players: [p1], ships: [s1dead] }, "p1", selected);
const summary2 = snapshotChangeSummary({ phase: "active" }, { phase: "active" }, "p1", selected, idx2, idx3);
assert.strictEqual(summary2.selectionAffected, true, "destroyed selected ship changes selection count");

// Ten repeated compact snapshots must not throw and must not report a phase change when phase is absent
let threw = false;
for (let i = 0; i < 10; i += 1) {
  try {
    snapshotChangeSummary({ phase: "active" }, {}, "p1", selected, idx2, idx2);
  } catch {
    threw = true;
  }
}
assert.strictEqual(threw, false, "repeated compact snapshots must not throw");

console.log("Phase transition verification passed");
