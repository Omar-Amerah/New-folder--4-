"use strict";

const assert = require("assert");
const path = require("path");
const { pathToFileURL } = require("url");

function clone(value) {
  return structuredClone(value);
}

function baseline(componentCount = 1) {
  const design = Array.from({ length: componentCount }, (_, index) => ({
    type: index === 0 ? "core" : "frame",
    x: index % 15,
    y: Math.floor(index / 15)
  }));
  return {
    type: "state",
    protocolVersion: 2,
    balanceRevision: "balance-a",
    stateEpoch: 1,
    snapshotSeq: 1,
    snapshotKind: "full",
    baseSnapshotSeq: null,
    staticRevision: 1,
    staticRevisions: { componentCatalogue: 1 },
    phase: "active",
    room: "TEST",
    rules: { gameMode: "teams", shipCap: 12 },
    players: [{
      id: "p1", name: "One", team: "blue", teamName: "Blue wing",
      ready: true, connected: true, money: 1000, income: 10,
      activeShips: 1, shipCap: 12, activeFleetCost: 100,
      kills: 0, losses: 0, captures: 0,
      rallyPoint: { x: 100, y: 100 }, rallyPointCustom: false
    }],
    ships: [{
      id: "s1", ownerId: "p1", team: "blue", alive: true,
      x: 100, y: 100, hp: 100, maxHp: 100, shield: 20, maxShield: 20,
      heat: 0, heatNow: 0, heatMax: 100, hot: 0, overheated: 0,
      design, designRevision: 1,
      componentAliveRevision: 1, componentDamageRevision: 1,
      heatRevision: 1, componentHeatRevision: 1, heatStateRevision: 1,
      heatTelemetryRevision: 1,
      chp: Array(componentCount).fill(100),
      componentHeat: Array.from({ length: componentCount }, () => [0, 0, 0, 100]),
      componentPower: Array.from({ length: componentCount }, () => ["powered", 1, 1]),
      powerRevision: 1, powerProtectionRevision: 1, powerRuntimeRevision: 3,
      powerWiringRevision: 1, wiringRevision: 1,
      powerWiring: { sections: [] }, powerWiringRuntime: { sections: [] },
      powerProtection: {}, powerThermal: {}, combatStyle: "hold"
    }],
    points: [{
      id: "A", x: 400, y: 400, radius: 100,
      ownerId: "p1", ownerTeam: "blue", contested: false, progress: 1
    }],
    objectiveControl: { total: 1, neutral: 0, contested: 0, teams: { blue: 1 }, players: {} },
    controlVictory: null,
    winner: null,
    bullets: [],
    effects: []
  };
}

function local(selected = ["s1"]) {
  return {
    selectedShipIds: new Set(selected),
    activeShipGroup: null,
    shipGroups: {
      group1: new Set(),
      group2: new Set(),
      group3: new Set(),
      group4: new Set(),
      group5: new Set()
    },
    settingRallyPoint: false,
    shipStatusView: "damage",
    pendingPurchaseCount: 0,
    purchaseErrorCount: 0,
    purchaseQuantity: 1,
    pendingDeploy: false,
    pendingStartDesign: false
  };
}

async function main() {
  const presentation = await import(pathToFileURL(path.resolve("public/src/snapshotPresentation.js")).href);
  const merge = await import(pathToFileURL(path.resolve("public/src/snapshotMerge.js")).href);
  const {
    buildSnapshotIndex,
    derivePresentationChanges,
    buildPresentationUpdatePlan,
    dispatchPresentationChanges,
    changesForLocalInvalidation
  } = presentation;

  function transition(mutate, { view = "damage", componentCount = 1 } = {}) {
    const fullMessage = baseline(componentCount);
    const full = merge.mergeSnapshotTransaction(null, {
      stateEpoch: 0, snapshotSeq: 0, staticRevision: 0, hasFullBaseline: false
    }, fullMessage);
    assert(full.ok);
    const previous = full.snapshot;
    const compact = clone(previous);
    compact.snapshotKind = "compact";
    compact.snapshotSeq = 2;
    compact.baseSnapshotSeq = 1;
    compact.design = undefined;
    mutate(compact);
    const result = merge.mergeSnapshotTransaction(previous, full.networkState, compact);
    assert(result.ok);
    const next = result.snapshot;
    const previousLocalState = local();
    const nextLocalState = local();
    nextLocalState.shipStatusView = view;
    const previousIndex = buildSnapshotIndex(previous, "p1", previousLocalState.selectedShipIds);
    const nextIndex = buildSnapshotIndex(next, "p1", nextLocalState.selectedShipIds);
    const changes = derivePresentationChanges({
      previousSnapshot: previous,
      nextSnapshot: next,
      previousIndex,
      nextIndex,
      previousLocalState,
      nextLocalState,
      myId: "p1"
    });
    return { previous, next, changes, plan: buildPresentationUpdatePlan(changes, view) };
  }

  let result = transition((next) => { next.ships[0].x += 20; });
  assert.equal(result.next.ships[0].x, 120, "real merge must accept position state");
  assert.deepStrictEqual(result.plan, [], "position-only snapshot must be renderer-only");

  result = transition((next) => { next.players[0].money += 50; });
  assert(result.changes.economy.moneyChanged);
  assert.deepStrictEqual(result.plan, ["updateEconomyHud", "updatePurchaseAffordability"]);

  result = transition((next) => { next.players[0].income += 2; });
  assert(result.changes.economy.incomeChanged);
  assert.deepStrictEqual(result.plan, ["updateEconomyHud"]);

  result = transition((next) => {
    next.ships[0].heat = 42;
    next.ships[0].heatNow = 42;
    next.ships[0].heatRevision += 1;
    next.ships[0].componentHeatRevision += 1;
    next.ships[0].componentHeat[0] = [42, 2, 0.42, 100];
  }, { view: "heat" });
  assert(result.changes.heat.ownedFleetSummaryChanged);
  assert(result.changes.heat.selectedComponentsChanged);
  assert.deepStrictEqual(result.plan, ["updateHeatHud", "updateSelectedShipHeatUi"]);

  result = transition((next) => {
    next.ships[0].componentDamageRevision += 1;
    next.ships[0].chp[0] = 80;
  });
  assert(result.changes.damage.selectedComponentHpChanged);
  assert.deepStrictEqual(result.plan, ["updateSelectedShipDamageUi"]);

  result = transition((next) => {
    next.ships[0].shield = 10;
  });
  assert(result.changes.damage.selectedShipVitalsChanged);
  assert.deepStrictEqual(result.plan, ["updateSelectedShipVitals"]);

  result = transition((next) => {
    next.ships[0].powerRevision += 1;
    next.ships[0].powerRuntimeRevision += 1;
    next.ships[0].componentPower[0] = ["starved", 1, 0.5];
  }, { view: "power" });
  assert(result.changes.power.selectedAllocationChanged);
  assert(!result.changes.power.selectedWiringLayoutChanged);
  assert.deepStrictEqual(result.plan, ["updateSelectedShipPowerUi"]);

  result = transition((next) => {
    next.ships[0].wiringRevision += 1;
    next.ships[0].powerWiringRevision += 1;
    next.ships[0].powerWiring.sections.push({ id: "power:1", x1: 0, y1: 0, x2: 1, y2: 0 });
  }, { view: "power" });
  assert(result.changes.power.selectedWiringLayoutChanged);
  assert.deepStrictEqual(result.plan, ["updateSelectedShipPowerUi"]);

  result = transition((next) => {
    next.players[0].rallyPoint = { x: 300, y: 400 };
    next.players[0].rallyPointCustom = true;
  });
  assert(result.changes.rally.changed);
  assert.deepStrictEqual(result.plan, ["updateRallyUi"]);

  result = transition((next) => {
    next.points[0].progress = 0.55;
    next.points[0].contested = true;
    next.objectiveControl = { total: 1, neutral: 0, contested: 1, teams: {}, players: {} };
  });
  assert(result.changes.objectives.relayProgressChanged);
  assert.deepStrictEqual(result.plan, [
    "updateEconomyHud",
    "updateRelayHud",
    "updateRelayStatus",
    "updateControlVictoryStatus"
  ]);

  result = transition((next) => {
    next.winner = { id: "p1", name: "One", team: "blue", reason: "control" };
  });
  assert(result.changes.objectives.winnerChanged);
  assert.deepStrictEqual(result.plan, ["updateWinnerStatus"]);

  result = transition((next) => { next.players[0].kills += 1; });
  assert(result.changes.players.scoreChanged);
  assert.deepStrictEqual(result.plan, ["updateScoreboardStatus"]);

  const latency = changesForLocalInvalidation("latency");
  assert.deepStrictEqual(buildPresentationUpdatePlan(latency), ["updateLatencyHud"]);

  const selection = changesForLocalInvalidation("selection");
  assert.deepStrictEqual(buildPresentationUpdatePlan(selection, "damage"), [
    "updateSelectionHud",
    // An arena click resolves ship AND station selection together, so the
    // station inspection panel repaints on the same invalidation.
    "updateStationPanel",
    "updateHeatHud",
    "updateShipGroupUi",
    "updateSelectionCommandUi",
    "updateSelectedShipDamageUi"
  ]);

  const pending = changesForLocalInvalidation("purchase-pending");
  assert.deepStrictEqual(buildPresentationUpdatePlan(pending), ["updatePurchasePendingState"]);

  const lobbyConnection = changesForLocalInvalidation("lobby-connection");
  assert.deepStrictEqual(buildPresentationUpdatePlan(lobbyConnection), [
    "updateLobbyVisibility",
    "updateLobbyRules",
    "updateDeploymentControls"
  ]);

  const calls = [];
  const isolated = dispatchPresentationChanges(changesForLocalInvalidation("selection"), {
    shipStatusView: "damage",
    handlers: {
      updateSelectionHud() { calls.push("selection"); },
      updateHeatHud() { throw new Error("forced"); },
      updateShipGroupUi() { calls.push("groups"); },
      updateSelectionCommandUi() { calls.push("commands"); },
      updateSelectedShipDamageUi() { calls.push("damage"); }
    }
  });
  assert.equal(isolated.errors.length, 1);
  assert.deepStrictEqual(calls, ["selection", "groups", "commands", "damage"], "one updater failure must not stop later owners");

  // Stable 150-component selected ship: real compact merges create new ship
  // objects, but semantic revisions remain stable and schedule no presentation.
  let stableMessage = baseline(150);
  let stableMerge = merge.mergeSnapshotTransaction(null, {
    stateEpoch: 0, snapshotSeq: 0, staticRevision: 0, hasFullBaseline: false
  }, stableMessage);
  let stableSnapshot = stableMerge.snapshot;
  let stableNetwork = stableMerge.networkState;
  const stableLocal = local();
  let scheduled = 0;
  for (let iteration = 0; iteration < 100; iteration += 1) {
    const compact = clone(stableSnapshot);
    compact.snapshotKind = "compact";
    compact.baseSnapshotSeq = stableNetwork.snapshotSeq;
    compact.snapshotSeq = stableNetwork.snapshotSeq + 1;
    const nextMerge = merge.mergeSnapshotTransaction(stableSnapshot, stableNetwork, compact);
    assert(nextMerge.ok);
    const changes = derivePresentationChanges({
      previousSnapshot: stableSnapshot,
      nextSnapshot: nextMerge.snapshot,
      previousIndex: buildSnapshotIndex(stableSnapshot, "p1", stableLocal.selectedShipIds),
      nextIndex: buildSnapshotIndex(nextMerge.snapshot, "p1", stableLocal.selectedShipIds),
      previousLocalState: stableLocal,
      nextLocalState: stableLocal,
      myId: "p1"
    });
    scheduled += buildPresentationUpdatePlan(changes, "power").length;
    stableSnapshot = nextMerge.snapshot;
    stableNetwork = nextMerge.networkState;
  }
  assert.equal(scheduled, 0, "100 stable large-ship snapshots must schedule zero UI owners");

  console.log("Semantic presentation ownership, merge, dispatch, isolation, and 150-component stability verification passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
