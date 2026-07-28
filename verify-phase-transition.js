"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

async function main() {
  const {
    buildSnapshotIndex,
    derivePresentationChanges,
    buildPresentationUpdatePlan
  } = await import(pathToFileURL(path.resolve("public/src/snapshotPresentation.js")).href);

  const previous = {
    phase: "lobby",
    rules: { gameMode: "teams", shipCap: 12 },
    players: [{ id: "p1", name: "A", team: "blue", ready: false, connected: true }],
    ships: [{ id: "s1", ownerId: "p1", team: "blue", alive: true }],
    points: [],
    objectiveControl: null,
    controlVictory: null,
    winner: null
  };
  const next = {
    ...previous,
    phase: "design",
    players: previous.players.map((player) => ({ ...player })),
    ships: previous.ships.map((ship) => ({ ...ship }))
  };
  const selected = new Set(["s1"]);
  const local = {
    selectedShipIds: selected,
    activeShipGroup: null,
    shipGroups: {},
    settingRallyPoint: false,
    shipStatusView: "damage",
    pendingPurchaseCount: 0,
    purchaseErrorCount: 0,
    purchaseQuantity: 1,
    pendingDeploy: false,
    pendingStartDesign: false
  };
  const changes = derivePresentationChanges({
    previousSnapshot: previous,
    nextSnapshot: next,
    previousIndex: buildSnapshotIndex(previous, "p1", selected),
    nextIndex: buildSnapshotIndex(next, "p1", selected),
    previousLocalState: local,
    nextLocalState: local,
    myId: "p1"
  });
  assert.equal(changes.phase.changed, true);
  assert.equal(changes.phase.previous, "lobby");
  assert.equal(changes.phase.next, "design");
  assert.equal(changes.selection.changed, false);
  assert(!buildPresentationUpdatePlan(changes).includes("updateLobbyPlayerRows"),
    "critical phase synchronization owns transition visibility/list work");

  const messages = fs.readFileSync("public/src/messages.js", "utf8");
  const stateSource = fs.readFileSync("public/src/state.js", "utf8");
  const snapshotAssign = messages.indexOf("state.snapshot = accepted;");
  const deriveCall = messages.indexOf("changes = derivePresentationChanges({");
  const dispatchCall = messages.indexOf("dispatchPresentationChanges(changes);");
  const phaseSyncCall = messages.indexOf("synchronizePhasePresentation(previousPhase, state.phase);");
  assert(snapshotAssign > 0 && snapshotAssign < deriveCall, "authoritative snapshot is stored before comparison");
  assert(deriveCall < dispatchCall, "semantic changes are derived before dispatch");
  assert(dispatchCall < phaseSyncCall, "critical phase synchronization runs after optional dispatch");
  assert(messages.includes("export function synchronizePhasePresentation(previousPhase, nextPhase)"));
  assert(stateSource.includes("pendingStartDesign: false,"));
  assert(stateSource.includes("pendingDeploy: false,"));

  console.log("Phase transition architecture verification passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
