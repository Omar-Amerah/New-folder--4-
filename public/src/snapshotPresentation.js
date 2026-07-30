// Semantic presentation ownership and invalidation.
//
// Presentation ownership matrix:
// | Authoritative/local field                 | Presentation owner |
// | ----------------------------------------- | ------------------ |
// | player.money                              | Economy HUD; purchase affordability |
// | player.income                             | Economy HUD |
// | player.activeFleetCost / ship cap         | Economy/Fleet HUD; purchase affordability |
// | player.ready                              | Lobby player status; deployment controls |
// | player.connected                          | Lobby player status; scoreboard |
// | player identity/team                      | Lobby player rows; Team HUD; scoreboard |
// | player kills/losses/captures/fleet count  | Scoreboard |
// | room phase                                | Critical phase presentation |
// | room rules                                | Lobby rules; Fleet HUD; purchase availability |
// | ship membership/owner/alive/group         | Fleet HUD; ship groups |
// | selected ship hull/shield/alive           | Selected vitals |
// | selected component HP/alive revisions     | Selected Damage presentation; world hull renderer |
// | ship/component Heat revisions             | Heat HUD; selected Heat presentation |
// | selected Power/runtime/protection revisions| Selected Power presentation |
// | selected design revision           | Selected static component geometry |
// | player rally point / placement mode       | Rally controls |
// | points/relay owner/progress                | Relay HUD; relay status |
// | objectiveControl/controlVictory           | Control/victory status |
// | winner                                    | Winner presentation |
// | local selection/active group              | Selection HUD; side-panel owners |
// | local Blueprint/loadout revisions  | Purchase catalogue; deployment controls |
// | local purchase quantity/pending/errors    | Purchase availability/pending/errors |
// | local telemetry hover/panel mode           | Active selected-ship dynamic layer |
// | latency pong                              | Latency HUD |
//
// The comparator is intentionally DOM-free. It uses authoritative revisions
// where the protocol has them, and compact field comparisons only for domains
// that do not yet have a room/player revision.

const PLAYER_IDENTITY_FIELDS = ["name", "teamName", "isAdmin", "isBot", "color", "colour"];
const PLAYER_SCORE_FIELDS = ["kills", "losses", "captures", "destroyedEnemyCost", "lostFleetCost"];
const PLAYER_ECONOMY_FIELDS = ["money", "income", "earned", "spent", "activeFleetCost", "deployedFleetCost", "lastReward", "shipsBuilt"];
const RULE_FIELDS = ["gameMode", "startingMoney", "maxPlayers", "mapSize", "asteroidDensity", "infrastructureMode", "visibilityMode", "shipCap"];
const VITAL_FIELDS = ["hp", "maxHp", "shield", "maxShield", "alive"];
const COMMAND_FIELDS = ["combatStyle", "commandState", "focusTargetId", "combatTargetId"];

function fieldsChanged(previous, next, fields) {
  if (!previous || !next) return previous !== next;
  for (const field of fields) if (previous[field] !== next[field]) return true;
  return false;
}

function primitiveArrayChanged(previous, next) {
  if (!Array.isArray(previous) || !Array.isArray(next)) return previous !== next;
  if (previous.length !== next.length) return true;
  for (let index = 0; index < previous.length; index += 1) {
    const left = previous[index];
    const right = next[index];
    if (Array.isArray(left) || Array.isArray(right)) {
      if (primitiveArrayChanged(left, right)) return true;
    } else if (left !== right) return true;
  }
  return false;
}

function mapCategoryChanged(previous, next, fields) {
  if (!previous || !next || previous.size !== next.size) return true;
  for (const [id, value] of previous) {
    const current = next.get(id);
    if (!current || fieldsChanged(value, current, fields)) return true;
  }
  return false;
}

function mapMembershipChanged(previous, next) {
  if (!previous || !next || previous.size !== next.size) return true;
  for (const id of previous.keys()) if (!next.has(id)) return true;
  return false;
}

function setChanged(previous, next) {
  if (!previous || !next || previous.size !== next.size) return true;
  for (const value of previous) if (!next.has(value)) return true;
  return false;
}

function recordRevisionChanged(previous, next, revisions, fallback) {
  const hasRevision = revisions.some((field) => previous?.[field] !== undefined || next?.[field] !== undefined);
  if (hasRevision) return revisions.some((field) => previous?.[field] !== next?.[field]);
  return fallback ? fallback(previous, next) : false;
}

function droneBaysChanged(left, right) {
  const leftBays = left?.droneBays;
  const rightBays = right?.droneBays;
  if (!Array.isArray(leftBays) || !Array.isArray(rightBays)) return leftBays !== rightBays;
  if (leftBays.length !== rightBays.length) return true;
  for (let i = 0; i < leftBays.length; i += 1) {
    const a = leftBays[i];
    const b = rightBays[i];
    if (a === b) continue;
    if (!a || !b) return true;
    if (
      a.mode !== b.mode ||
      a.operational !== b.operational ||
      a.powerFraction !== b.powerFraction ||
      a.overheated !== b.overheated ||
      a.launchBlockedBySpawn !== b.launchBlockedBySpawn ||
      a.productionProgress !== b.productionProgress ||
      a.productionPausedReason !== b.productionPausedReason ||
      a.activeCount !== b.activeCount ||
      a.storedCount !== b.storedCount ||
      a.refuelingCount !== b.refuelingCount
    ) return true;
    const leftSlots = a.slots || [];
    const rightSlots = b.slots || [];
    if (leftSlots.length !== rightSlots.length) return true;
    for (let j = 0; j < leftSlots.length; j += 1) {
      const sA = leftSlots[j];
      const sB = rightSlots[j];
      if (!sA || !sB) return true;
      if (
        sA.state !== sB.state ||
        sA.droneId !== sB.droneId ||
        sA.progress !== sB.progress ||
        sA.pauseReason !== sB.pauseReason
      ) return true;
    }
  }
  return false;
}

function pointIdentity(point) {
  return point?.id ?? `${point?.x ?? ""}:${point?.y ?? ""}`;
}

function pointMap(snapshot) {
  return new Map((snapshot?.points || []).map((point) => [pointIdentity(point), point]));
}

function comparePoints(previous, next) {
  const left = pointMap(previous);
  const right = pointMap(next);
  const result = { pointsChanged: false, ownershipChanged: false, progressChanged: false };
  if (left.size !== right.size) result.pointsChanged = result.ownershipChanged = result.progressChanged = true;
  for (const [id, previousPoint] of left) {
    const nextPoint = right.get(id);
    if (!nextPoint) {
      result.pointsChanged = result.ownershipChanged = result.progressChanged = true;
      continue;
    }
    if (fieldsChanged(previousPoint, nextPoint, ["ownerId", "ownerTeam"])) result.ownershipChanged = true;
    if (fieldsChanged(previousPoint, nextPoint, ["progress", "contested"])) result.progressChanged = true;
    if (fieldsChanged(previousPoint, nextPoint, ["x", "y", "radius"])) result.pointsChanged = true;
  }
  result.pointsChanged ||= result.ownershipChanged || result.progressChanged;
  return result;
}

function stationMap(snapshot) {
  return new Map((snapshot?.stations || []).map((station) => [station.id, station]));
}

// Station production advances every tick while a hangar is busy, so the queue is
// compared by its own summary rather than by identity: an idle station produces
// no panel repaints at all.
function productionSignature(station) {
  const queue = station?.productionQueue;
  if (!Array.isArray(queue) || queue.length === 0) return "";
  return queue.map((item) => `${item.id}:${item.state}:${item.quantityRemaining}:${Math.round((Number(item.progress) || 0) * 100)}`).join(",");
}

function compareStations(previous, next) {
  const left = stationMap(previous);
  const right = stationMap(next);
  const result = { membershipChanged: false, stateChanged: false, vitalsChanged: false, productionChanged: false };
  if (left.size !== right.size) {
    result.membershipChanged = result.stateChanged = result.vitalsChanged = result.productionChanged = true;
    return result;
  }
  for (const [id, previousStation] of left) {
    const nextStation = right.get(id);
    if (!nextStation) {
      result.membershipChanged = result.stateChanged = result.vitalsChanged = result.productionChanged = true;
      continue;
    }
    if (fieldsChanged(previousStation, nextStation, ["state", "team", "ownerId"])) result.stateChanged = true;
    if (fieldsChanged(previousStation, nextStation, ["hp", "maxHp", "shield", "maxShield"])) result.vitalsChanged = true;
    if (productionSignature(previousStation) !== productionSignature(nextStation)) result.productionChanged = true;
  }
  return result;
}

function capturedRelayCount(snapshot, mine) {
  if (!mine) return 0;
  return (snapshot?.points || []).reduce((count, point) => {
    const owned = snapshot?.rules?.gameMode === "solo"
      ? point.ownerId === mine.id
      : point.ownerTeam === mine.team;
    return count + (owned && point.progress > 0.98 ? 1 : 0);
  }, 0);
}

function objectCountsChanged(previous, next) {
  const left = previous || {};
  const right = next || {};
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return true;
  for (const key of leftKeys) if (left[key] !== right[key]) return true;
  return false;
}

function objectiveControlChanged(previous, next) {
  const left = previous?.objectiveControl;
  const right = next?.objectiveControl;
  if (!left || !right) return left !== right;
  return fieldsChanged(left, right, ["total", "neutral", "contested"])
    || objectCountsChanged(left.teams, right.teams)
    || objectCountsChanged(left.players, right.players);
}

function controlVictoryChanged(previous, next) {
  return fieldsChanged(previous?.controlVictory, next?.controlVictory, [
    "active", "team", "playerId", "remaining", "requiredSeconds", "fullControl"
  ]);
}

function winnerChanged(previous, next) {
  return fieldsChanged(previous?.winner, next?.winner, ["id", "playerId", "team", "name", "reason"]);
}

function rallyChanged(previous, next) {
  if (!previous || !next) return previous !== next;
  return previous.rallyPointCustom !== next.rallyPointCustom
    || fieldsChanged(previous.rallyPoint, next.rallyPoint, ["x", "y"]);
}

function localGroupChanged(previous, next) {
  if (previous?.activeShipGroup !== next?.activeShipGroup) return true;
  const left = previous?.shipGroups || {};
  const right = next?.shipGroups || {};
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) if (setChanged(left[key] || new Set(), right[key] || new Set())) return true;
  return false;
}

function selectedTelemetryChanges(previousIndex, nextIndex, selectedIds) {
  const result = {
    vitals: false,
    componentHp: false,
    componentAlive: false,
    heat: false,
    componentHeat: false,
    powerAllocation: false,
    powerRuntime: false,
    powerProtection: false,
    wiringLayout: false,
    staticGeometry: false,
    command: false,
    drones: false
  };
  for (const id of selectedIds || []) {
    const previous = previousIndex?.shipById?.get(id);
    const next = nextIndex?.shipById?.get(id);
    if (!previous || !next) continue;
    result.vitals ||= fieldsChanged(previous, next, VITAL_FIELDS);
    result.componentHp ||= recordRevisionChanged(
      previous,
      next,
      ["componentDamageRevision"],
      (left, right) => primitiveArrayChanged(left?.chp, right?.chp)
    );
    result.componentAlive ||= recordRevisionChanged(
      previous,
      next,
      ["componentAliveRevision"],
      (left, right) => primitiveArrayChanged(left?.chp?.map((hp) => Number(hp) > 0), right?.chp?.map((hp) => Number(hp) > 0))
    );
    result.heat ||= fieldsChanged(previous, next, ["heat", "heatNow", "heatMax", "hot", "overheated", "heatRevision"]);
    result.componentHeat ||= recordRevisionChanged(
      previous,
      next,
      ["componentHeatRevision", "heatStateRevision", "heatTelemetryRevision"],
      (left, right) => primitiveArrayChanged(left?.componentHeat, right?.componentHeat)
    );
    result.powerAllocation ||= recordRevisionChanged(
      previous,
      next,
      ["powerRevision"],
      (left, right) => primitiveArrayChanged(left?.componentPower, right?.componentPower)
    );
    result.powerRuntime ||= recordRevisionChanged(
      previous,
      next,
      ["powerRuntimeRevision", "heatTelemetryRevision"],
      (left, right) => left?.powerWiringRuntime !== right?.powerWiringRuntime || left?.powerThermal !== right?.powerThermal
    );
    result.powerProtection ||= recordRevisionChanged(
      previous,
      next,
      ["powerProtectionRevision"],
      (left, right) => left?.powerProtection !== right?.powerProtection
    );
    result.wiringLayout ||= recordRevisionChanged(
      previous,
      next,
      ["powerWiringRevision", "wiringRevision"],
      (left, right) => left?.powerWiring !== right?.powerWiring
    );
    result.staticGeometry ||= previous.designRevision !== next.designRevision;
    result.drones ||= droneBaysChanged(previous, next);
    result.command ||= fieldsChanged(previous, next, COMMAND_FIELDS);
  }
  return result;
}

function ownedHeatChanged(previousIndex, nextIndex, myId) {
  const previous = previousIndex?.shipById;
  const next = nextIndex?.shipById;
  if (!previous || !next) return true;
  for (const [id, ship] of next) {
    if (ship?.ownerId !== myId || ship.alive === false) continue;
    const old = previous.get(id);
    if (!old || fieldsChanged(old, ship, ["heat", "heatNow", "heatMax", "hot", "overheated", "heatRevision"])) return true;
  }
  for (const [id, ship] of previous) {
    if (ship?.ownerId === myId && ship.alive !== false && !next.has(id)) return true;
  }
  return false;
}

export function buildSnapshotIndex(snapshot, myId, selectedIds = new Set()) {
  const playerById = new Map();
  const shipById = new Map();
  const ownLivingShips = [];
  const ownLivingShipIds = [];
  const selectedLivingShips = [];
  const selectedShipById = new Map();
  const relaysByTeam = new Map();

  for (const player of snapshot?.players || []) playerById.set(player.id, player);
  for (const ship of snapshot?.ships || []) {
    if (!ship) continue;
    shipById.set(ship.id, ship);
    if (ship.alive !== false && ship.ownerId === myId) {
      ownLivingShips.push(ship);
      ownLivingShipIds.push(ship.id);
    }
    if (ship.alive !== false && selectedIds.has(ship.id)) {
      selectedLivingShips.push(ship);
      selectedShipById.set(ship.id, ship);
    }
  }
  for (const relay of snapshot?.points || []) {
    const owner = relay.ownerTeam || relay.ownerId || "neutral";
    const list = relaysByTeam.get(owner) || [];
    list.push(relay);
    relaysByTeam.set(owner, list);
  }
  return {
    playerById,
    playersById: playerById,
    shipById,
    ownLivingShips,
    ownLivingShipIds,
    selectedLivingShips,
    selectedShipById,
    relaysByTeam
  };
}

export function refreshSnapshotSelectionIndex(index, selectedIds = new Set()) {
  if (!index?.shipById) return index;
  const selectedLivingShips = [];
  const selectedShipById = new Map();
  for (const id of selectedIds) {
    const ship = index.shipById.get(id);
    if (!ship || ship.alive === false) continue;
    selectedLivingShips.push(ship);
    selectedShipById.set(id, ship);
  }
  index.selectedLivingShips = selectedLivingShips;
  index.selectedShipById = selectedShipById;
  return index;
}

export function captureLocalPresentationState(source) {
  const cloneGroups = {};
  for (const [key, ids] of Object.entries(source?.shipGroups || {})) cloneGroups[key] = new Set(ids || []);
  return {
    selectedShipIds: new Set(source?.selectedShipIds || []),
    selectedStationId: source?.selectedStationId || null,
    activeShipGroup: source?.activeShipGroup || null,
    shipGroups: cloneGroups,
    settingRallyPoint: Boolean(source?.settingRallyPoint),
    shipStatusView: source?.shipStatusView || "damage",
    pendingPurchaseCount: source?.pendingPurchases?.size || 0,
    purchaseErrorCount: source?.purchaseErrors?.size || 0,
    purchaseQuantity: source?.purchaseQuantity || 1,
    pendingDeploy: Boolean(source?.pendingDeploy),
    pendingStartDesign: Boolean(source?.pendingStartDesign)
  };
}

export function emptyPresentationChanges() {
  return {
    phase: { changed: false, previous: null, next: null },
    lobby: {
      visibilityChanged: false,
      connectionStateChanged: false,
      adminChanged: false,
      playersChanged: false,
      playerIdentityChanged: false,
      playerConnectionChanged: false,
      playerTeamChanged: false,
      playerReadyChanged: false,
      playerStatusChanged: false,
      rulesChanged: false
    },
    economy: {
      moneyChanged: false,
      incomeChanged: false,
      fleetCostChanged: false,
      affordabilityChanged: false,
      shipCapChanged: false,
      earningStateChanged: false
    },
    fleet: {
      membershipChanged: false,
      ownershipChanged: false,
      aliveStateChanged: false,
      groupStateChanged: false
    },
    players: {
      identityChanged: false,
      connectionChanged: false,
      teamChanged: false,
      readyChanged: false,
      scoreChanged: false,
      economyChanged: false,
      fleetChanged: false
    },
    selection: {
      changed: false,
      pruned: false,
      selectedShipIdsChanged: false,
      panelModeChanged: false,
      telemetryComponentChanged: false,
      commandChanged: false
    },
    rally: { changed: false },
    stations: {
      membershipChanged: false,
      stateChanged: false,
      vitalsChanged: false,
      productionChanged: false,
      selectionChanged: false
    },
    objectives: {
      pointsChanged: false,
      controlChanged: false,
      controlVictoryChanged: false,
      relayStateChanged: false,
      relayOwnershipChanged: false,
      relayProgressChanged: false,
      capturedRelayCountChanged: false,
      winnerChanged: false,
      scoreboardChanged: false
    },
    heat: {
      ownedFleetSummaryChanged: false,
      selectedShipChanged: false,
      selectedComponentsChanged: false
    },
    damage: {
      selectedShipVitalsChanged: false,
      selectedComponentHpChanged: false,
      selectedComponentAliveChanged: false,
      selectedStaticGeometryChanged: false,
      dronesChanged: false
    },
    power: {
      selectedAllocationChanged: false,
      selectedRuntimeChanged: false,
      selectedProtectionChanged: false,
      selectedWiringLayoutChanged: false
    },
    latency: { changed: false },
    purchase: {
      availabilityChanged: false,
      pendingChanged: false,
      errorsChanged: false,
      catalogueChanged: false,
      deploymentChanged: false
    }
  };
}

export function allPresentationChanges(previousPhase = null, nextPhase = null) {
  const changes = emptyPresentationChanges();
  for (const domain of Object.values(changes)) {
    for (const key of Object.keys(domain)) {
      if (typeof domain[key] === "boolean") domain[key] = true;
    }
  }
  changes.phase.previous = previousPhase;
  changes.phase.next = nextPhase;
  changes.phase.changed = previousPhase !== nextPhase;
  return changes;
}

export function derivePresentationChanges({
  previousSnapshot,
  nextSnapshot,
  previousIndex,
  nextIndex,
  previousLocalState,
  nextLocalState,
  myId
}) {
  if (!previousSnapshot || !previousIndex) {
    return allPresentationChanges(previousSnapshot?.phase ?? null, nextSnapshot?.phase ?? null);
  }

  const changes = emptyPresentationChanges();
  const previousMine = previousIndex.playerById.get(myId);
  const nextMine = nextIndex.playerById.get(myId);
  const previousPlayers = previousIndex.playerById;
  const nextPlayers = nextIndex.playerById;

  changes.phase.previous = previousSnapshot.phase;
  changes.phase.next = nextSnapshot.phase;
  changes.phase.changed = previousSnapshot.phase !== nextSnapshot.phase;

  const playerMembershipChanged = mapMembershipChanged(previousPlayers, nextPlayers);
  const adminChanged = previousSnapshot.adminId !== nextSnapshot.adminId;
  const gameModeChanged = fieldsChanged(previousSnapshot.rules, nextSnapshot.rules, ["gameMode"]);
  const identityChanged = mapCategoryChanged(previousPlayers, nextPlayers, PLAYER_IDENTITY_FIELDS);
  const connectionChanged = mapCategoryChanged(previousPlayers, nextPlayers, ["connected"]);
  const teamChanged = mapCategoryChanged(previousPlayers, nextPlayers, ["team"]);
  const readyChanged = mapCategoryChanged(previousPlayers, nextPlayers, ["ready"]);
  const scoreChanged = mapCategoryChanged(previousPlayers, nextPlayers, PLAYER_SCORE_FIELDS);
  const playerEconomyChanged = mapCategoryChanged(previousPlayers, nextPlayers, PLAYER_ECONOMY_FIELDS);
  const playerFleetChanged = mapCategoryChanged(previousPlayers, nextPlayers, ["activeShips", "shipCap"]);

  Object.assign(changes.players, {
    identityChanged,
    connectionChanged,
    teamChanged,
    readyChanged,
    scoreChanged,
    economyChanged: playerEconomyChanged,
    fleetChanged: playerFleetChanged
  });
  Object.assign(changes.lobby, {
    visibilityChanged: changes.phase.changed,
    adminChanged,
    playersChanged: playerMembershipChanged || identityChanged || teamChanged,
    playerIdentityChanged: identityChanged,
    playerConnectionChanged: connectionChanged,
    playerTeamChanged: teamChanged,
    playerReadyChanged: readyChanged,
    playerStatusChanged: connectionChanged || readyChanged,
    rulesChanged: fieldsChanged(previousSnapshot.rules, nextSnapshot.rules, RULE_FIELDS)
  });

  changes.economy.moneyChanged = previousMine?.money !== nextMine?.money;
  changes.economy.incomeChanged = previousMine?.income !== nextMine?.income;
  changes.economy.fleetCostChanged = fieldsChanged(previousMine, nextMine, ["activeFleetCost", "deployedFleetCost", "spent"]);
  changes.economy.shipCapChanged = previousMine?.shipCap !== nextMine?.shipCap
    || previousSnapshot.rules?.shipCap !== nextSnapshot.rules?.shipCap;
  changes.economy.earningStateChanged = previousMine?.ready !== nextMine?.ready;
  changes.economy.affordabilityChanged = changes.economy.moneyChanged
    || changes.economy.fleetCostChanged
    || changes.economy.shipCapChanged
    || previousMine?.activeShips !== nextMine?.activeShips;

  changes.fleet.membershipChanged = mapMembershipChanged(previousIndex.shipById, nextIndex.shipById);
  changes.fleet.ownershipChanged = mapCategoryChanged(previousIndex.shipById, nextIndex.shipById, ["ownerId", "team"]);
  changes.fleet.aliveStateChanged = mapCategoryChanged(previousIndex.shipById, nextIndex.shipById, ["alive"]);
  changes.fleet.groupStateChanged = localGroupChanged(previousLocalState, nextLocalState);

  changes.selection.selectedShipIdsChanged = setChanged(previousLocalState?.selectedShipIds, nextLocalState?.selectedShipIds);
  changes.selection.pruned = Boolean(
    changes.selection.selectedShipIdsChanged
    && (nextLocalState?.selectedShipIds?.size || 0) < (previousLocalState?.selectedShipIds?.size || 0)
  );
  changes.selection.panelModeChanged = previousLocalState?.shipStatusView !== nextLocalState?.shipStatusView;
  changes.selection.changed = changes.selection.selectedShipIdsChanged;

  changes.rally.changed = rallyChanged(previousMine, nextMine)
    || previousLocalState?.settingRallyPoint !== nextLocalState?.settingRallyPoint;

  Object.assign(changes.stations, compareStations(previousSnapshot, nextSnapshot));
  changes.stations.selectionChanged = previousLocalState?.selectedStationId !== nextLocalState?.selectedStationId;

  const pointChanges = comparePoints(previousSnapshot, nextSnapshot);
  changes.objectives.pointsChanged = pointChanges.pointsChanged;
  changes.objectives.relayOwnershipChanged = pointChanges.ownershipChanged;
  changes.objectives.relayProgressChanged = pointChanges.progressChanged;
  changes.objectives.capturedRelayCountChanged = capturedRelayCount(previousSnapshot, previousMine)
    !== capturedRelayCount(nextSnapshot, nextMine);
  changes.objectives.relayStateChanged = pointChanges.ownershipChanged || pointChanges.progressChanged;
  changes.objectives.controlChanged = objectiveControlChanged(previousSnapshot, nextSnapshot);
  changes.objectives.controlVictoryChanged = controlVictoryChanged(previousSnapshot, nextSnapshot);
  changes.objectives.winnerChanged = winnerChanged(previousSnapshot, nextSnapshot);
  changes.objectives.scoreboardChanged = scoreChanged || playerFleetChanged || identityChanged || teamChanged || connectionChanged || readyChanged || gameModeChanged;

  changes.heat.ownedFleetSummaryChanged = ownedHeatChanged(previousIndex, nextIndex, myId);
  const selectedIds = nextLocalState?.selectedShipIds || new Set();
  const telemetry = selectedTelemetryChanges(previousIndex, nextIndex, selectedIds);
  changes.damage.selectedShipVitalsChanged = telemetry.vitals;
  changes.damage.selectedComponentHpChanged = telemetry.componentHp;
  changes.damage.selectedComponentAliveChanged = telemetry.componentAlive;
  changes.damage.selectedStaticGeometryChanged = telemetry.staticGeometry;
  changes.damage.dronesChanged = telemetry.drones;
  changes.heat.selectedShipChanged = telemetry.heat;
  changes.heat.selectedComponentsChanged = telemetry.componentHeat;
  changes.power.selectedAllocationChanged = telemetry.powerAllocation;
  changes.power.selectedRuntimeChanged = telemetry.powerRuntime;
  changes.power.selectedProtectionChanged = telemetry.powerProtection;
  changes.power.selectedWiringLayoutChanged = telemetry.wiringLayout;
  changes.selection.commandChanged = telemetry.command;

  changes.purchase.availabilityChanged = changes.economy.affordabilityChanged || changes.phase.changed;
  changes.purchase.pendingChanged = previousLocalState?.pendingPurchaseCount !== nextLocalState?.pendingPurchaseCount;
  changes.purchase.errorsChanged = previousLocalState?.purchaseErrorCount !== nextLocalState?.purchaseErrorCount;
  changes.purchase.catalogueChanged = previousSnapshot.balanceRevision !== nextSnapshot.balanceRevision
    || previousSnapshot.staticRevisions?.componentCatalogue !== nextSnapshot.staticRevisions?.componentCatalogue;
  changes.purchase.deploymentChanged = changes.phase.changed
    || previousMine?.ready !== nextMine?.ready
    || previousLocalState?.pendingDeploy !== nextLocalState?.pendingDeploy
    || previousLocalState?.pendingStartDesign !== nextLocalState?.pendingStartDesign;

  return changes;
}

export function changesForLocalInvalidation(reason) {
  const changes = emptyPresentationChanges();
  switch (String(reason || "")) {
    case "selection":
      changes.selection.changed = true;
      changes.selection.selectedShipIdsChanged = true;
      changes.heat.ownedFleetSummaryChanged = true;
      changes.fleet.groupStateChanged = true;
      changes.stations.selectionChanged = true;
      break;
    case "active-group":
      changes.fleet.groupStateChanged = true;
      changes.selection.changed = true;
      break;
    case "blueprint-edit":
    case "wiring-edit":
    case "purchase-catalogue":
      changes.purchase.catalogueChanged = true;
      changes.purchase.deploymentChanged = true;
      break;
    case "purchase-quantity":
      changes.purchase.availabilityChanged = true;
      break;
    case "purchase-pending":
      changes.purchase.pendingChanged = true;
      break;
    case "purchase-errors":
      changes.purchase.errorsChanged = true;
      break;
    case "telemetry-component":
      changes.selection.telemetryComponentChanged = true;
      break;
    case "panel-mode":
      changes.selection.panelModeChanged = true;
      break;
    case "rally":
    case "rally-mode":
      changes.rally.changed = true;
      break;
    case "latency":
      changes.latency.changed = true;
      break;
    case "lobby-connection":
      changes.lobby.connectionStateChanged = true;
      changes.purchase.deploymentChanged = true;
      break;
    case "command":
      changes.selection.commandChanged = true;
      break;
    case "deployment":
      changes.purchase.deploymentChanged = true;
      break;
    default:
      break;
  }
  return changes;
}

function activeSelectedOperation(view) {
  if (view === "heat") return "updateSelectedShipHeatUi";
  if (view === "power") return "updateSelectedShipPowerUi";
  return "updateSelectedShipDamageUi";
}

export function buildPresentationUpdatePlan(changes, shipStatusView = "damage") {
  const operations = [];
  const add = (name) => { if (!operations.includes(name)) operations.push(name); };

  if (changes.players.teamChanged || changes.players.identityChanged) add("updateTeamHud");
  if (
    changes.fleet.membershipChanged || changes.fleet.ownershipChanged
    || changes.fleet.aliveStateChanged || changes.economy.shipCapChanged
  ) add("updateFleetHud");
  if (
    changes.economy.moneyChanged || changes.economy.incomeChanged
    || changes.economy.fleetCostChanged || changes.economy.earningStateChanged
    || changes.objectives.capturedRelayCountChanged
  ) add("updateEconomyHud");
  if (changes.objectives.relayStateChanged || changes.players.teamChanged) add("updateRelayHud");
  if (changes.selection.changed) add("updateSelectionHud");
  if (
    changes.stations.selectionChanged || changes.stations.membershipChanged
    || changes.stations.stateChanged || changes.stations.vitalsChanged
    || changes.stations.productionChanged || changes.lobby.rulesChanged
  ) add("updateStationPanel");
  if (changes.selection.commandChanged) add("updateObjectiveHud");
  if (changes.heat.ownedFleetSummaryChanged || changes.selection.changed) add("updateHeatHud");
  if (changes.latency.changed) add("updateLatencyHud");

  if (
    changes.fleet.membershipChanged || changes.fleet.ownershipChanged
    || changes.fleet.aliveStateChanged || changes.fleet.groupStateChanged
  ) add("updateShipGroupUi");
  if (changes.rally.changed) add("updateRallyUi");
  if (
    changes.selection.changed || changes.selection.commandChanged
    || changes.fleet.groupStateChanged || changes.fleet.membershipChanged
  ) add("updateSelectionCommandUi");
  if (changes.damage.selectedShipVitalsChanged) add("updateSelectedShipVitals");

  const selectedDomainChanged = changes.selection.changed
    || changes.selection.panelModeChanged
    || changes.selection.telemetryComponentChanged
    || changes.damage.dronesChanged;
  if (selectedDomainChanged) add(activeSelectedOperation(shipStatusView));
  if (
    shipStatusView === "damage"
    && (changes.damage.selectedComponentHpChanged || changes.damage.selectedComponentAliveChanged || changes.damage.selectedStaticGeometryChanged)
  ) add("updateSelectedShipDamageUi");
  if (
    shipStatusView === "heat"
    && (changes.heat.selectedShipChanged || changes.heat.selectedComponentsChanged || changes.damage.selectedComponentAliveChanged || changes.damage.selectedStaticGeometryChanged)
  ) add("updateSelectedShipHeatUi");
  if (
    shipStatusView === "power"
    && (
      changes.power.selectedAllocationChanged || changes.power.selectedRuntimeChanged
      || changes.power.selectedProtectionChanged || changes.power.selectedWiringLayoutChanged
      || changes.damage.selectedComponentAliveChanged || changes.damage.selectedStaticGeometryChanged
    )
  ) add("updateSelectedShipPowerUi");

  if (!changes.phase.changed) {
    if (
      changes.lobby.visibilityChanged || changes.lobby.connectionStateChanged
      || changes.lobby.adminChanged || changes.lobby.playersChanged
    ) add("updateLobbyVisibility");
    if (
      changes.lobby.rulesChanged || changes.lobby.connectionStateChanged
      || changes.lobby.adminChanged || changes.lobby.playersChanged
    ) add("updateLobbyRules");
    if (changes.lobby.playersChanged) add("updateLobbyPlayerRows");
    if (changes.lobby.playerStatusChanged) add("updateLobbyPlayerStatus");

    if (changes.objectives.relayStateChanged) add("updateRelayStatus");
    if (
      changes.objectives.controlChanged || changes.objectives.controlVictoryChanged
      || changes.objectives.relayStateChanged
    ) add("updateControlVictoryStatus");
    if (changes.objectives.scoreboardChanged) add("updateScoreboardStatus");
    if (changes.objectives.winnerChanged) add("updateWinnerStatus");
  }

  if (changes.purchase.catalogueChanged) add("updatePurchaseCatalogue");
  if (changes.purchase.availabilityChanged) add("updatePurchaseAffordability");
  if (changes.purchase.pendingChanged) add("updatePurchasePendingState");
  if (changes.purchase.errorsChanged) add("updatePurchaseErrors");
  if (changes.purchase.deploymentChanged && !changes.phase.changed) add("updateDeploymentControls");
  return operations;
}

export function dispatchPresentationChanges(changes, {
  handlers,
  shipStatusView = "damage",
  onError = null,
  onDispatch = null
} = {}) {
  const operations = buildPresentationUpdatePlan(changes, shipStatusView);
  if (onDispatch) onDispatch(operations);
  const errors = [];
  for (const operation of operations) {
    const handler = handlers?.[operation];
    if (typeof handler !== "function") continue;
    try {
      handler();
    } catch (error) {
      errors.push({ operation, error });
      if (onError) onError(operation, error);
    }
  }
  return { operations, errors };
}
