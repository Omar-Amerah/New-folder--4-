// Builds state snapshot objects representing game rooms and serializes them for network transmission.

const { round } = require("./utils");
const { teamLabel } = require("./players");
const { SERVER_BUILD_SHA, PROTOCOL_VERSION } = require("./buildInfo");
const { getActiveFleetCost } = require("./economy");
const { summarizeStats, computeStats } = require("./shipStats");
const { getPlayerRallyPoint } = require("./ships");

// Component heat network format:
//   componentHeat: array of [heat value, state, ratio, capacity] tuples.
//   componentHeatD: flat compact deltas [component index, heat value, state, ratio, capacity, ...].
// Keep these positions explicit so compact deltas do not rely on hidden stride assumptions.
const COMPONENT_HEAT_VALUE = 0;
const COMPONENT_HEAT_STATE = 1;
const COMPONENT_HEAT_RATIO = 2;
const COMPONENT_HEAT_CAPACITY = 3;
const COMPONENT_HEAT_DELTA_STRIDE = 5;

function buildComponentHeatTuple(ship, index) {
  const capacity = Math.round((ship.componentThermals?.[index]?.capacity || 0) * 10) / 10;
  const value = ship.componentHeat[index];
  const heat = Number.isFinite(value) ? Math.round(value) : 0;
  const ratio = capacity > 0 ? Math.round((heat / capacity) * 1000) / 1000 : 0;
  return [heat, ship.componentHeatState[index] || 0, ratio, capacity];
}

// Builds the parts of a snapshot that are identical for every viewer so they can
// be computed once per broadcast instead of once per client.
function buildSharedSnapshot(room, now, sendStatic, suppressCompactDeltas = false) {
  const ships = [];
  for (const ship of room.ships.values()) {
    if (ship.removed) continue;
    const entry = {
      id: ship.id,
      ownerId: ship.ownerId,
      designRevision: ship.designRevision || 1,
      x: round(ship.x),
      y: round(ship.y),
      vx: round(ship.vx),
      vy: round(ship.vy),
      angle: round(ship.angle),
      turnActivity: Math.max(-1, Math.min(1, Number.isFinite(ship.turnActivity) ? ship.turnActivity : 0)),
      combatStyle: ship.combatStyle || "sentry",
      targetX: round(ship.targetX),
      targetY: round(ship.targetY),
      hp: round(ship.hp),
      maxHp: round(ship.maxHp),
      shield: round(ship.shield),
      maxShield: round(ship.maxShield),
      radius: round(ship.radius),
      cost: ship.cost || ship.stats?.unitCost || 0,
      focusTargetId: ship.focusTargetId,
      combatTargetId: ship.combatTargetId || null,
      weaponAngles: (ship.weaponAngles || []).map(round),
      alive: ship.alive,
      blasterRange: ship.stats?.blasterRange || 0,
      missileRange: ship.stats?.missileRange || 0,
      railgunRange: ship.stats?.railgunRange || 0,
      beamRange: ship.stats?.beamRange || 0,
      beamRadius: ship.stats?.beamRadius || 0,
      respawnIn: 0,
      removeIn: ship.alive ? 0 : Math.max(0, Math.ceil(((ship.removeAt || now) - now) / 1000))
    };
    if (ship.blockedEngineIndices?.size) entry.engBlocked = [...ship.blockedEngineIndices];
    // One decimal place so ships below 0.5% pressure don't flatten to 0%.
    const heatPercent = Math.max(0, (ship.heatPressure || 0) * 100);
    entry.heat = Math.round(heatPercent * 10) / 10;
    entry.heatNow = Math.round((ship.currentHeat || 0) * 10) / 10;
    entry.heatMax = Math.round((ship.maxHeat || 0) * 10) / 10;
    entry.hot = ship.hotComponentCount || 0;
    entry.overheated = ship.overheatedComponentCount || 0;
    if (ship.selfDestructAt && ship.alive) {
      const span = ship.selfDestructAt - ship.selfDestructStart;
      entry.destructProgress = span > 0 ? round(Math.max(0, Math.min(1, (now - ship.selfDestructStart) / span))) : 1;
    }
    if (sendStatic) {
      appendFullShipBaseline(entry, ship);
    } else if (!suppressCompactDeltas) {
      appendShipDeltas(entry, ship);
    }
    ships.push(entry);
  }

  const objectiveControl = {
    total: room.points.length,
    neutral: 0,
    contested: 0,
    teams: {},
    players: {}
  };
  for (const point of room.points) {
    if (point.contested) {
      objectiveControl.contested++;
    } else if (room.rules?.gameMode === "solo") {
      if (!point.ownerId || point.progress < 0.98) {
        objectiveControl.neutral++;
      } else {
        objectiveControl.players[point.ownerId] = (objectiveControl.players[point.ownerId] || 0) + 1;
      }
    } else {
      if (!point.ownerTeam || point.progress < 0.98) {
        objectiveControl.neutral++;
      } else {
        objectiveControl.teams[point.ownerTeam] = (objectiveControl.teams[point.ownerTeam] || 0) + 1;
      }
    }
  }

  return {
    ships,
    bullets: room.bullets.map((bullet) => ({
      id: bullet.id,
      type: bullet.type,
      subtype: bullet.subtype,
      ownerId: bullet.ownerId,
      x: round(bullet.x),
      y: round(bullet.y),
      vx: round(bullet.vx),
      vy: round(bullet.vy),
      // Seconds since spawn, so the client can backdate a freshly fired bullet
      // to its muzzle origin instead of extrapolating it ahead of the barrel.
      age: Math.max(0, Math.round(now - (bullet.bornAt || now))) / 1000
    })),
    points: room.points.map((point) => ({
      id: point.id,
      x: point.x,
      y: point.y,
      radius: point.radius,
      ownerId: point.ownerId,
      ownerTeam: point.ownerTeam,
      contested: Boolean(point.contested),
      progress: round(point.progress)
    })),
    effects: room.effects.map((effect) => ({ ...effect, age: Math.max(0, round(now - effect.at)), subtype: effect.subtype })),
    objectiveControl
  };
}

function getKnownShipDesigns(client) {
  if (!client) return new Map();
  if (!client.knownShipDesignRevisions) client.knownShipDesignRevisions = new Map();
  return client.knownShipDesignRevisions;
}

function appendFullShipBaseline(entry, ship) {
  delete entry.chpD;
  delete entry.componentHeatD;
  entry.design = ship.design || [];
  if (ship.componentPower?.byComponentIndex) {
    entry.componentPower = ship.componentPower.byComponentIndex.map((power) => [power.state, power.networkId, Math.round(power.operationalMultiplier * 1000) / 1000]);
    entry.powerStatus = ship.powerStatus;
    entry.powerRevision = ship.powerRevision || 0;
    entry.wiringRevision = ship.wiringRevision || 0;
    entry.wiringStatus = wiringStatus(ship);
  }
  if (ship.componentHp) entry.chp = ship.componentHp.map((hp) => Math.round(hp * 10) / 10);
  if (ship.componentHeat) entry.componentHeat = ship.componentHeat.map((_, i) => buildComponentHeatTuple(ship, i));
}

function appendShipDeltas(entry, ship, client = null) {
  const knownPower = client?.knownShipPowerRevisions instanceof Map ? client.knownShipPowerRevisions : null;
  const known = knownPower ? knownPower.get(ship.id) : undefined;
  const currentPowerRevision = ship.powerRevision || 0;
  if (ship.componentPower?.byComponentIndex && (knownPower ? known !== currentPowerRevision : ship.dirtyPower)) {
    entry.componentPower = ship.componentPower.byComponentIndex.map((power) => [power.state, power.networkId, Math.round(power.operationalMultiplier * 1000) / 1000]);
    entry.powerStatus = ship.powerStatus;
    entry.powerRevision = ship.powerRevision || 0;
    entry.wiringRevision = ship.wiringRevision || 0;
    entry.wiringStatus = wiringStatus(ship);
  }
  if (ship.dirtyComponents && ship.dirtyComponents.size) {
    const delta = [];
    for (const index of [...ship.dirtyComponents].sort((a, b) => a - b)) {
      delta.push(index, Math.round(ship.componentHp[index] * 10) / 10);
    }
    entry.chpD = delta;
  }
  if (ship.dirtyHeat?.size) {
    entry.componentHeatD = [];
    for (const index of [...ship.dirtyHeat].sort((a, b) => a - b)) {
      const tuple = buildComponentHeatTuple(ship, index);
      entry.componentHeatD.push(
        index,
        tuple[COMPONENT_HEAT_VALUE],
        tuple[COMPONENT_HEAT_STATE],
        tuple[COMPONENT_HEAT_RATIO],
        tuple[COMPONENT_HEAT_CAPACITY]
      );
    }
  }
}

function wiringStatus(ship) {
  const runtime = ship.runtimeWiring;
  return runtime ? {
    powerNetworks: runtime.powerNetworks.length,
    brokenPowerConnections: runtime.power.brokenConnectionIds.size,
    disabledPowerSections: runtime.power.disabledSectionIds.size,
    dataNetworks: runtime.dataNetworks.length,
    brokenDataConnections: runtime.data.brokenConnectionIds.size,
    disabledDataSections: runtime.data.disabledSectionIds.size
  } : undefined;
}

function buildClientShips(room, sharedShips, client, sendStatic) {
  const known = getKnownShipDesigns(client);
  return sharedShips.map((base) => {
    const entry = { ...base };
    const ship = room.ships.get(entry.id);
    if (!ship || ship.removed) return entry;
    const revision = ship.designRevision || 1;
    if (sendStatic || known.get(ship.id) !== revision) appendFullShipBaseline(entry, ship);
    else appendShipDeltas(entry, ship, client);
    return entry;
  });
}

function collectSnapshotDesignRevisions(snapshot) {
  const revisions = [];
  for (const ship of snapshot?.ships || []) {
    if (ship.design) revisions.push([ship.id, ship.designRevision || 1]);
  }
  return revisions;
}
function collectSnapshotPowerRevisions(snapshot) {
  const revisions = [];
  for (const ship of snapshot?.ships || []) {
    if (ship.componentPower) revisions.push([ship.id, ship.powerRevision || 0]);
  }
  return revisions;
}
function markSnapshotPowerWritten(client, powerRevisions = []) {
  if (!client) return;
  if (!client.knownShipPowerRevisions) client.knownShipPowerRevisions = new Map();
  for (const [shipId, revision] of powerRevisions) client.knownShipPowerRevisions.set(shipId, revision);
}

function markSnapshotDesignsWritten(client, designRevisions = []) {
  const known = getKnownShipDesigns(client);
  for (const [shipId, revision] of designRevisions) known.set(shipId, revision);
}

function snapshotRoom(room, now, viewer = null, sendStatic = true, shared = null, client = null) {
  if (!shared) shared = buildSharedSnapshot(room, now, sendStatic, Boolean(client));

  const phaseEnded = room.phase === "ended";
  const players = [];
  for (const player of room.players.values()) {
    const canViewEconomy = canViewPlayerEconomy(viewer, player);
    const canViewFinalEconomy = phaseEnded || canViewEconomy;
    let activeShips = 0;
    for (const ship of player.ships) {
      if (ship.alive) activeShips += 1;
    }

    const packet = {
      id: player.id,
      name: player.name,
      color: player.color,
      team: player.team,
      teamName: teamLabel(room, player.team, player.name),
      isBot: player.isBot,
      isAdmin: room.adminId === player.id,
      connected: player.connected !== false,
      ready: player.ready,
      money: canViewFinalEconomy ? Math.floor(player.money) : null,
      income: canViewEconomy ? round(player.income) : null,
      earned: canViewFinalEconomy ? Math.floor(player.earned) : null,
      spent: canViewFinalEconomy ? Math.floor(player.spent) : null,
      shipCap: player.shipCap,
      activeFleetCost: canViewEconomy ? getActiveFleetCost(player) : null,
      deployedFleetCost: canViewFinalEconomy ? Math.floor(player.deployedFleetCost) : null,
      destroyedEnemyCost: Math.floor(player.destroyedEnemyCost),
      lastReward: player.lastReward,
      activeShips,
      score: Math.floor(player.score),
      kills: player.kills,
      losses: player.losses,
      captures: player.captures,
      rallyPoint: getPlayerRallyPoint(room, player),
      rallyPointCustom: Boolean(player.rallyPoint),
      shipsBuilt: player.shipsBuilt || 0,
      lostFleetCost: Math.floor(player.lostFleetCost || 0)
    };
    if (sendStatic) {
      packet.design = player.design;
      packet.stats = summarizeStats(player.stats || computeStats(player.design));
    }
    players.push(packet);
  }

  const snapshot = {
    type: "state",
    room: room.code,
    // Frontend/backend build identification: the client compares these against
    // its own protocol support to detect a stale separately-deployed backend.
    protocolVersion: PROTOCOL_VERSION,
    serverBuildSha: SERVER_BUILD_SHA,
    stateEpoch: room.stateEpoch || 1,
    snapshotSeq: room._buildingSnapshotSeq || room.snapshotSeq || 0,
    snapshotKind: sendStatic ? "full" : "compact",
    baseSnapshotSeq: sendStatic ? null : (room._buildingBaseSnapshotSeq ?? Math.max(0, (room._buildingSnapshotSeq || room.snapshotSeq || 1) - 1)),
    staticRevision: room.staticRevision || 1,
    staticRevisions: { world: room.staticRevision || 1, map: room.staticRevision || 1, rules: room.staticRevision || 1, playerDesign: room.staticRevision || 1, shipDesign: room.staticRevision || 1, componentCatalogue: room.componentCatalogueRevision || 1 },
    simulationTimeMs: Math.floor(now),
    serverTimeMs: Date.now(),
    createdAtMs: Date.now(),
    phase: room.phase,
    adminId: room.adminId,
    players,
    ships: buildClientShips(room, shared.ships, client, sendStatic),
    bullets: shared.bullets,
    points: shared.points,
    effects: shared.effects,
    winner: room.winner,
    matchStartedAt: room.matchStartedAt,
    maxScore: room.maxScore,
    controlVictory: room.controlVictory ? {
      active: Boolean(room.controlVictory.team || room.controlVictory.playerId),
      team: room.controlVictory.team,
      playerId: room.controlVictory.playerId,
      remaining: room.controlVictory.remaining,
      requiredSeconds: room.controlVictory.requiredSeconds,
      fullControl: Boolean(room.controlVictory.team || room.controlVictory.playerId)
    } : null,
    objectiveControl: shared.objectiveControl,
    time: Math.floor(now)
  };
  if (sendStatic) {
    snapshot.mapSizeLabel = room.mapSizeLabel;
    snapshot.world = room.world;
    snapshot.map = room.map;
    snapshot.rules = room.rules;
  }
  return snapshot;
}

function canViewPlayerEconomy(viewer, player) {
  if (!viewer || !player) return false;
  if (viewer.id === player.id) return true;
  return viewer.team === player.team;
}

module.exports = {
  snapshotRoom,
  buildSharedSnapshot,
  collectSnapshotDesignRevisions,
  collectSnapshotPowerRevisions,
  markSnapshotDesignsWritten,
  markSnapshotPowerWritten,
  canViewPlayerEconomy
};
