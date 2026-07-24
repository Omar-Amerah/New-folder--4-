// Builds state snapshot objects representing game rooms and serializes them for network transmission.

const { round } = require("./utils");
const { teamLabel } = require("./players");
const { SERVER_BUILD_SHA, PROTOCOL_VERSION } = require("./buildInfo");
const { getActiveFleetCost } = require("./economy");
const { summarizeStats, computeStats } = require("./shipStats");
const { getPlayerRallyPoint } = require("./ships");
const { ensureEffectiveWeaponProfileCache, getEffectiveWeaponRanges } = require("./componentData");
const { buildDroneSnapshots, buildBaySnapshots } = require("./drones");

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
    const effectiveWeapons = ensureEffectiveWeaponProfileCache(ship);
    const effectiveRanges = getEffectiveWeaponRanges(ship);
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
      combatStyle: ship.combatStyle || "hold",
      targetX: round(ship.targetX),
      targetY: round(ship.targetY),
      hp: round(ship.hp),
      maxHp: round(ship.maxHp),
      shield: round(ship.shield),
      maxShield: round(ship.maxShield),
      radius: round(ship.radius),
      cost: ship.cost || ship.stats?.unitCost || 0,
      focusTargetId: ship.focusTargetId || ship.repairTargetId || null,
      combatTargetId: ship.combatTargetId || null,
      weaponAngles: (ship.weaponAngles || []).map(round),
      alive: ship.alive,
      blasterRange: effectiveRanges.blaster,
      missileRange: effectiveRanges.missile,
      railgunRange: effectiveRanges.railgun,
      beamRange: effectiveRanges.beam,
      weaponRanges: (effectiveWeapons?.profiles || []).map((profile, index) => (
        profile && (ship.componentHp?.[index] ?? 1) > 0 ? Number(profile.range) || 0 : null
      )),
      beamRadius: ship.stats?.beamRadius || 0,
      respawnIn: 0,
      removeIn: ship.alive ? 0 : Math.max(0, Math.ceil(((ship.removeAt || now) - now) / 1000))
    };
    if (ship.droneBays?.length) entry.droneBays = buildBaySnapshots(ship);
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
    drones: buildDroneSnapshots(room, now),
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


function presentNetworkId(value) { return value === null || value === undefined ? null : value; }
function finiteOrNull(value) { const number = Number(value); return Number.isFinite(number) ? number : null; }
function switchgearPresentationState(record, ship) {
  const hp = Number(ship?.componentHp?.[record.componentIndex]);
  if (Number.isFinite(hp) && hp <= 0) return "destroyed";
  if (record.state === "tripped") return Number(record.cooldownRemaining) > 0 ? "tripped-cooling" : "tripped-retry-pending";
  const aConnected = record.sideANetworkId !== null && record.sideANetworkId !== undefined;
  const bConnected = record.sideBNetworkId !== null && record.sideBNetworkId !== undefined;
  if (!aConnected && !bConnected) return "disconnected";
  if (!aConnected || !bConnected) return "disconnected";
  if (record.mode === "open") return "open";
  if (record.mode === "automatic") return record.conducts ? "automatic-conducting" : "automatic-idle";
  if (record.mode === "closed") return record.conducts ? "closed-conducting" : "unpowered";
  return "unknown";
}
function buildSwitchgearSnapshot(ship) {
  const { switchgearProtectionFields } = require("./powerProtection");
  return (Array.isArray(ship.runtimeSwitchgear) ? ship.runtimeSwitchgear : []).map((record) => ({
    componentIndex: record.componentIndex,
    classification: record.classification || "isolator",
    mode: record.mode || "closed",
    state: record.state || record.mode || "closed",
    presentationState: switchgearPresentationState(record, ship),
    runtimeState: record.state || null,
    conducts: Boolean(record.conducts),
    reasonNotConducting: record.conducts ? null : (record.trippedReason || record.decisionReason || (record.mode === "open" ? "saved-mode-open" : "not-conducting")),
    automaticClosed: Boolean(record.automaticClosed),
    sideANetworkId: presentNetworkId(record.sideANetworkId),
    sideBNetworkId: presentNetworkId(record.sideBNetworkId),
    ratingTier: record.ratingTier || "standard",
    sustainedCapacityMw: Number(record.sustainedCapacityMw) || 0,
    peakCapacityMw: Number(record.peakCapacityMw) || 0,
    signedTransferMw: Number(record.signedTransferMw) || 0,
    utilisation: Number(record.utilisation) || 0,
    decisionReason: record.decisionReason || "Unknown",
    trippedReason: record.trippedReason || null,
    // Section 7G runtime overload trip/cooldown/retry inspection fields.
    ...switchgearProtectionFields(ship, record.componentIndex)
  }));
}

function buildProtectionSnapshot(ship) {
  return require("./powerProtection").buildPowerProtectionSnapshot(ship);
}

function buildPowerWiringLayoutSnapshot(ship) {
  return require("./powerWiringSnapshot").buildPowerWiringLayout(ship);
}
function buildPowerWiringRuntimeSnapshot(ship) {
  return require("./powerWiringSnapshot").buildPowerWiringRuntime(ship);
}

function appendFullShipBaseline(entry, ship) {
  delete entry.chpD;
  delete entry.componentHeatD;
  entry.design = ship.design || [];
  if (ship.componentPower?.byComponentIndex) {
    entry.componentPower = ship.componentPower.byComponentIndex.map((power) => [power.state, power.networkId, Math.round(power.operationalMultiplier * 1000) / 1000]);
    entry.powerStatus = ship.powerStatus;
    entry.powerThermal = buildRuntimePowerThermalSnapshot(ship);
    entry.powerRevision = ship.powerRevision || 0;
    entry.wiringRevision = ship.wiringRevision || 0;
    entry.wiringStatus = wiringStatus(ship);
    entry.switchgear = buildSwitchgearSnapshot(ship);
    entry.powerProtection = buildProtectionSnapshot(ship);
    entry.powerProtectionRevision = ship.powerProtectionRevision || 0;
    // Combat Power tab: full installed Power-wiring layout (keyed by wiring
    // revision) plus the live per-section runtime block.
    entry.powerWiring = buildPowerWiringLayoutSnapshot(ship);
    entry.powerWiringRevision = ship.wiringRevision || 0;
    entry.powerWiringRuntime = buildPowerWiringRuntimeSnapshot(ship);
  }
  if (ship.componentHp) entry.chp = ship.componentHp.map((hp) => Math.round(hp * 10) / 10);
  if (ship.componentHeat) entry.componentHeat = ship.componentHeat.map((_, i) => buildComponentHeatTuple(ship, i));
}

function appendShipDeltas(entry, ship, client = null) {
  const knownPower = client?.knownShipPowerRevisions instanceof Map ? client.knownShipPowerRevisions : null;
  const known = knownPower ? knownPower.get(ship.id) : undefined;
  const currentPowerRevision = ship.powerRevision || 0;
  const powerChanged = ship.componentPower?.byComponentIndex && (knownPower ? known !== currentPowerRevision : ship.dirtyPower);
  if (powerChanged) {
    entry.componentPower = ship.componentPower.byComponentIndex.map((power) => [power.state, power.networkId, Math.round(power.operationalMultiplier * 1000) / 1000]);
    entry.powerStatus = ship.powerStatus;
    entry.powerThermal = buildRuntimePowerThermalSnapshot(ship);
    entry.powerRevision = ship.powerRevision || 0;
    entry.wiringRevision = ship.wiringRevision || 0;
    entry.wiringStatus = wiringStatus(ship);
    entry.switchgear = buildSwitchgearSnapshot(ship);
  }
  // Section 7G: the compact runtime protection block has its own revision so
  // stress/trip/retry changes reach the player even when component allocations
  // are unchanged, while unchanged protection state resends nothing (the
  // client merge preserves the previous block when omitted).
  const knownProtection = client?.knownShipPowerProtectionRevisions instanceof Map ? client.knownShipPowerProtectionRevisions : null;
  const currentProtectionRevision = ship.powerProtectionRevision || 0;
  const protectionChanged = ship.componentPower?.byComponentIndex
    && (knownProtection ? knownProtection.get(ship.id) !== currentProtectionRevision : ship.dirtyPowerProtection);
  if (protectionChanged) {
    entry.powerProtection = buildProtectionSnapshot(ship);
    entry.powerProtectionRevision = currentProtectionRevision;
    if (!powerChanged) entry.switchgear = buildSwitchgearSnapshot(ship);
  }
  // Combat Power tab layout: resent only when the wiring revision changes
  // (topology rebuild, damage/repair, design change). Unchanged layout arrays
  // are never resent — the client merge preserves the previous layout.
  const knownWiring = client?.knownShipWiringLayoutRevisions instanceof Map ? client.knownShipWiringLayoutRevisions : null;
  const currentWiringRevision = ship.wiringRevision || 0;
  const wiringLayoutChanged = ship.componentPower?.byComponentIndex
    && (knownWiring ? knownWiring.get(ship.id) !== currentWiringRevision : (powerChanged || protectionChanged));
  if (wiringLayoutChanged) {
    entry.powerWiring = buildPowerWiringLayoutSnapshot(ship);
    entry.powerWiringRevision = currentWiringRevision;
  }
  // Live per-section runtime block: whenever flow (power) or stress/protection
  // changed. Layout stays cached; only the runtime values refresh.
  if ((powerChanged || protectionChanged) && ship.componentPower?.byComponentIndex) {
    entry.powerWiringRuntime = buildPowerWiringRuntimeSnapshot(ship);
  }
  // `powerThermal` contains Heat-derived values (component Heat generated,
  // cable Heat generated, cooling, net rate, hottest component) that change
  // during ordinary thermal ticks even when the Power allocator does not run.
  // Send a fresh compact diagnostics block with Heat deltas, without forcing a
  // Power solve or resending static design data.
  if (!powerChanged && ship.componentPower?.byComponentIndex && ship.dirtyHeat?.size) {
    entry.powerThermal = buildRuntimePowerThermalSnapshot(ship);
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

function namespacedPowerSectionId(id) { return String(id).startsWith("power:") || String(id).startsWith("switchgear:") ? String(id) : `power:${id}`; }
function buildRuntimePowerThermalSnapshot(ship) {
  const powerSummary = ship.powerFlow?.summary || {};
  const cable = ship.powerCableThermalAnalysis || {};
  const cableSummary = cable.summary || {};
  const elapsed = Math.max(Number(ship.lastHeatTickDelta) || 0, Number.EPSILON);
  const componentHeatRate = (ship.componentHeatGenerated || []).reduce((sum, value) => sum + (Number(value) || 0), 0) / elapsed;
  const cooling = (ship.componentHeatCooled || []).reduce((sum, value) => sum + (Number(value) || 0), 0) / elapsed;
  const powerCableHeatRate = Number(ship.powerCableHeatRate) || 0;
  const components = (ship.design || []).map((part, i) => {
    const cp = ship.componentPower?.byComponentIndex?.[i] || {};
    const rated = Number(require("./components").PARTS[part?.type]?.powerGeneration) || 0;
    const available = finiteOrNull(cp.generationAvailableMw);
    const used = finiteOrNull(cp.generationUsedMw);
    const reasons = Array.isArray(cp.generationReductionReasons) ? cp.generationReductionReasons.slice() : [];
    return ({
    componentIndex: i,
    networkId: presentNetworkId(cp.networkId),
    requestedMw: finiteOrNull(cp.requestedMw),
    allocatedMw: finiteOrNull(cp.allocatedMw),
    operationalMultiplier: finiteOrNull(cp.operationalMultiplier),
    powerRole: cp.role || "passive",
    ratedGenerationMw: rated,
    availableGenerationMw: available,
    currentGenerationMw: used,
    deliveredGenerationMw: used,
    unusedGenerationMw: available === null || used === null ? null : Math.max(0, available - used),
    reductionReasons: reasons,
    powerCableHeatRate: Number(ship.componentPowerCableHeatRate?.[i]) || 0,
    powerCableHeatGenerated: Number(ship.componentPowerCableHeatGenerated?.[i]) || 0,
    hostedActiveSectionIds: cable.components?.find?.((entry) => entry.componentIndex === i)?.hostedActiveSectionIds || []
  });
  });
  const powerCableHeatBySectionId = {};
  let powerCableOverloadHeatRate = 0;
  for (const section of cable.sections || []) {
    const id = namespacedPowerSectionId(section.sectionId);
    const baseHeatPerSecond = finiteOrNull(section.baseHeatPerSecond) ?? 0;
    const overloadHeatPerSecond = finiteOrNull(section.overloadHeatPerSecond) ?? 0;
    const totalHeatPerSecond = finiteOrNull(section.totalHeatPerSecond) ?? 0;
    powerCableOverloadHeatRate += overloadHeatPerSecond;
    powerCableHeatBySectionId[id] = {
      baseHeatPerSecond,
      overloadHeatPerSecond,
      totalHeatPerSecond,
      // Deprecated v2 compatibility aliases: these are Heat-rate values, not MW.
      baseHeatMw: baseHeatPerSecond,
      overloadHeatMw: overloadHeatPerSecond,
      totalHeatMw: totalHeatPerSecond
    };
  }
  return {
    componentHeatRate,
    powerCableHeatRate,
    powerCableHeatBySectionId,
    snapshotVersion: 2,
    totalRatedGenerationMw: components.reduce((sum, c) => sum + c.ratedGenerationMw, 0),
    totalAvailableGenerationMw: finiteOrNull(powerSummary.availableGenerationMw),
    totalDeliveredGenerationMw: finiteOrNull(powerSummary.usedGenerationMw),
    totalHeatRate: componentHeatRate + powerCableHeatRate,
    cooling,
    netHeatRate: componentHeatRate + powerCableHeatRate - cooling,
    hottestComponentIndex: (ship.componentHeat || []).reduce((best, value, i) => (Number(value) || 0) > (Number(ship.componentHeat?.[best]) || 0) ? i : best, 0),
    aboveSustainedSectionCount: Number(powerSummary.aboveSustainedSections) || 0,
    atPeakSectionCount: Number(powerSummary.atPeakSections) || 0,
    throttledComponentCount: components.filter(c => c.operationalMultiplier > 0 && c.operationalMultiplier < 1).length,
    disabledComponentCount: components.filter(c => c.operationalMultiplier <= 0).length,
    powerCableOverloadHeatRate,
    powerGenerationMw: finiteOrNull(powerSummary.availableGenerationMw),
    requestedDemandMw: finiteOrNull(powerSummary.demandMw),
    deliveredDemandMw: finiteOrNull(powerSummary.allocatedMw),
    sparePowerMw: finiteOrNull(powerSummary.spareGenerationMw),
    unmetDemandMw: finiteOrNull(powerSummary.unmetMw),
    activePriorityPreset: powerSummary.preset || null,
    hottestSectionId: cableSummary.hottestSectionId || null,
    components
  };
}

function wiringStatus(ship) {
  const runtime = ship.runtimeWiring;
  return runtime ? {
    powerNetworks: runtime.powerNetworks.length,
    brokenPowerConnections: runtime.power.brokenConnectionIds.size,
    disabledPowerSections: runtime.power.disabledSectionIds.size,
    disabledPowerCells: runtime.power.disabledCells?.length || 0,
    dataNetworks: runtime.dataNetworks.length,
    brokenDataConnections: runtime.data.brokenConnectionIds.size,
    disabledDataSections: runtime.data.disabledSectionIds.size,
    disabledDataCells: runtime.data.disabledCells?.length || 0
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
function collectSnapshotPowerProtectionRevisions(snapshot) {
  const revisions = [];
  for (const ship of snapshot?.ships || []) {
    if (ship.powerProtection) revisions.push([ship.id, ship.powerProtectionRevision || 0]);
  }
  return revisions;
}
function markSnapshotPowerProtectionWritten(client, protectionRevisions = []) {
  if (!client) return;
  if (!client.knownShipPowerProtectionRevisions) client.knownShipPowerProtectionRevisions = new Map();
  for (const [shipId, revision] of protectionRevisions) client.knownShipPowerProtectionRevisions.set(shipId, revision);
}
function collectSnapshotWiringLayoutRevisions(snapshot) {
  const revisions = [];
  for (const ship of snapshot?.ships || []) {
    if (ship.powerWiring) revisions.push([ship.id, ship.powerWiringRevision || 0]);
  }
  return revisions;
}
function markSnapshotWiringLayoutWritten(client, layoutRevisions = []) {
  if (!client) return;
  if (!client.knownShipWiringLayoutRevisions) client.knownShipWiringLayoutRevisions = new Map();
  for (const [shipId, revision] of layoutRevisions) client.knownShipWiringLayoutRevisions.set(shipId, revision);
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
      packet.stats = summarizeStats(player.stats || computeStats(player.design, player.wiring));
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
    drones: shared.drones || [],
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
  collectSnapshotPowerProtectionRevisions,
  collectSnapshotWiringLayoutRevisions,
  markSnapshotDesignsWritten,
  markSnapshotPowerWritten,
  markSnapshotPowerProtectionWritten,
  markSnapshotWiringLayoutWritten,
  canViewPlayerEconomy,
  _test: { buildSwitchgearSnapshot, buildRuntimePowerThermalSnapshot, switchgearPresentationState, finiteOrNull }
};
