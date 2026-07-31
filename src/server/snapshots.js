// Builds state snapshot objects representing game rooms and serializes them for network transmission.

const { round, roundAngle, clampNumber, performanceNow } = require("./utils");
const { bump, recordDuration } = require("./roomTelemetry");
const { applyClientProjectiles } = require("./projectileReplication");
const { teamLabel } = require("./players");
const { SERVER_BUILD_SHA, PROTOCOL_VERSION } = require("./buildInfo");
const { getActiveFleetCost } = require("./economy");
const { summarizeStats, computeStats } = require("./shipStats");
const { getPlayerRallyPoint } = require("./ships");
const { ensureEffectiveWeaponProfileCache } = require("./componentData");
const { buildDroneSnapshots, buildBaySnapshots } = require("./drones");
const { buildDecoySnapshots, buildLauncherSnapshots } = require("./decoys");
const { buildPowerProtectionSnapshot } = require("./powerProtection");
const { buildPowerWiringLayout, buildPowerWiringRuntime } = require("./powerWiringSnapshot");
const { WIRING_ENABLED } = require("../../public/src/shared/featureFlags");
const { PARTS } = require("./components");
const { getShipComponentIndexes } = require("./componentIndexes");
const { BALANCE_REVISION } = require("./balanceConfig");
const { reportInvalidShieldState } = require("./runtimeShield");
const { sanitizeCombatStyle, sanitizeMovementToggles } = require("./validation");
const { usesStationInfrastructure } = require("./rooms");
const { filterSnapshotForPlayer } = require("./visibilitySnapshots");
const { effectiveSensorProfile, effectiveSensorRange } = require("./sensorCapability");
const { ensureTeamVisibility, invalidateVisibility, usesSensorVisibility } = require("./visibility");
const { INFRASTRUCTURE } = require("./config");

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

function finiteShieldSnapshotValue(ship, key) {
  const value = ship?.[key];
  if (Number.isFinite(value)) return round(value);
  reportInvalidShieldState(ship, value);
  return 0;
}

// Public, deliberately low-precision component condition used only to draw
// persistent damage. Exact component HP remains private to owners/allies.
function buildComponentDamageVisual(ship) {
  if (!Array.isArray(ship.componentHp)) return undefined;
  return ship.componentHp.map((hp, index) => {
    if (ship.design?.[index]?.type === "core") return 10;
    const max = Number(ship.componentMaxHp?.[index]) || 0;
    if (!(max > 0)) return 10;
    return Math.max(0, Math.min(10, Math.round((Number(hp) || 0) / max * 10)));
  });
}

// The furthest any battery still standing on this station can shoot.
function stationWeaponRange(station) {
  const componentRevision = station.componentDamageRevision || 0;
  const cached = station._snapshotWeaponRangeCache;
  if (cached?.componentRevision === componentRevision) return cached.value;
  const design = station.design || [];
  let range = 0;
  for (const i of getShipComponentIndexes(station).weaponIndices) {
    const weapon = PARTS[design[i]?.type]?.weapon;
    if (!weapon) continue;
    if (station.componentHp && !(station.componentHp[i] > 0)) continue;
    range = Math.max(range, Number(weapon.range) || 0);
  }
  station._snapshotWeaponRangeCache = { componentRevision, value: range };
  return range;
}

function stationComponentHpSnapshot(station) {
  const componentRevision = station.componentDamageRevision || 0;
  const cached = station._snapshotComponentHpCache;
  if (cached?.componentRevision === componentRevision) return cached.value;
  const value = station.componentHp?.map((hp) => round(hp * 10) / 10);
  station._snapshotComponentHpCache = { componentRevision, value };
  return value;
}

// Compact snapshots only need the bearings of actual station batteries. The
// authoritative runtime stores one angle slot per design component, but sending
// hundreds of default angles for non-weapons dominated otherwise-small station
// updates. Full baselines retain the original dense array for compatibility.
function buildStationWeaponAnglePairs(station) {
  const pairs = [];
  const angles = station.weaponAngles || [];
  for (const index of getShipComponentIndexes(station).weaponIndices) {
    pairs.push(index, round(angles[index]));
  }
  return pairs;
}

// Builds the parts of a snapshot that are identical for every viewer so they can
// be computed once per broadcast instead of once per client.
function buildStationSnapshot(room, station, now, sendStatic) {
  const entry = {
    id: station.id,
    hp: round(station.hp),
    shield: round(station.shield),
    team: station.team || null,
    ownerId: station.ownerId || null,
    state: station.state,
    sensorRange: round(effectiveSensorRange(station, room)),
    // Furthest a live battery can reach, so the client can draw the station's
    // engagement envelope the same way it draws a ship's. Destroyed weapons
    // drop out of it, so the ring shrinks as the station is stripped.
    weaponRange: round(stationWeaponRange(station)),
    revision: station.revision || 0,
    healthRevision: station.healthRevision || 0,
    componentDamageRevision: station.componentDamageRevision || 0,
    stateRevision: station.stateRevision || 0,
    productionRevision: station.productionRevision || 1,
    captureProgress: station.stationType === "relay" ? round(station.captureProgress || 0) : undefined,
    captureContested: station.stationType === "relay" ? Boolean(station.captureContested) : undefined,
    // Who the capture bar currently belongs to, so it draws in their colour.
    captureTeam: station.stationType === "relay" ? (station.captureTeam || null) : undefined
  };
  if (sendStatic) {
    entry.stationType = station.stationType;
    entry.x = round(station.x);
    entry.y = round(station.y);
    entry.angle = round(station.angle);
    // The station's real broad-phase radius from its compound collision pieces,
    // not the capped gameplay stat a ship reports.
    entry.radius = round(station.radius || station.stats?.radius || 0);
    entry.shieldRadius = station.shieldRadius || 0;
    entry.moduleScale = station.moduleScale;
    entry.design = station.design || [];
    if (station.hangar) entry.hangar = station.hangar;
    if (station.hangars) entry.hangars = station.hangars;
    if (station.hardpoints) entry.hardpoints = station.hardpoints;
    entry.weaponAngles = (station.weaponAngles || []).map(round);
    entry.maxHp = round(station.maxHp);
    entry.maxShield = round(station.maxShield);
    if (station.componentHp) entry.componentHp = stationComponentHpSnapshot(station);
  } else {
    entry.weaponAnglePairs = buildStationWeaponAnglePairs(station);
  }
  // The production queue is small but changes continuously, so it is part of
  // every snapshot. Progress is resolved server-side: the client has no
  // authoritative clock to compare buildStartedAt against.
  if (station.stationType === "home") {
    entry.productionQueue = station.productionQueue.map((item) => ({
      id: item.id,
      playerId: item.playerId,
      quantityRemaining: item.quantityRemaining,
      state: item.state,
      buildDurationSeconds: round(item.buildDurationSeconds),
      progress: item.state === "queued"
        ? 0
        : round(clampNumber((now - item.buildStartedAt) / Math.max(1, item.buildDurationSeconds * 1000), 0, 1))
    }));
  }
  return entry;
}

function buildStationSnapshots(room, now, sendStatic) {
  if (!usesStationInfrastructure(room) || !room.stations) return undefined;
  return room.stations.map((station) => buildStationSnapshot(room, station, now, sendStatic));
}

function buildSharedSnapshot(room, now, sendStatic, suppressCompactDeltas = false, buildBullets = true) {
  // Snapshot construction is also used by immediate purchase/reconnect sends
  // outside the regular simulation cadence. Advance visibility once here so
  // those snapshots cannot reuse coverage from before an entity/state change.
  if (room._visibilityFinalizedAt !== now) invalidateVisibility(room, "snapshot-build");
  const ships = [];
  for (const ship of room.ships.values()) {
    if (ship.removed) continue;
    const effectiveWeapons = ensureEffectiveWeaponProfileCache(ship);
    const effectiveRanges = effectiveWeapons?.familyRanges || {};
    const sensorProfile = effectiveSensorProfile(ship, room);
    const entry = {
      id: ship.id,
      ownerId: ship.ownerId,
      team: room.players?.get?.(ship.ownerId)?.team ?? ship.team ?? null,
      designRevision: ship.designRevision || 1,
      componentAliveRevision: ship.componentAliveRevision || 0,
      componentDamageRevision: ship.componentDamageRevision || 0,
      proximityChargeRevision: ship.proximityChargeRevision || 0,
      x: round(ship.x),
      y: round(ship.y),
      vx: round(ship.vx),
      vy: round(ship.vy),
      angle: roundAngle(ship.angle),
      turnActivity: Math.max(-1, Math.min(1, Number.isFinite(ship.turnActivity) ? ship.turnActivity : 0)),
      combatStyle: sanitizeCombatStyle(ship.combatStyle),
      movementToggles: sanitizeMovementToggles(ship.movementToggles),
      targetX: round(ship.targetX),
      targetY: round(ship.targetY),
      hp: round(ship.hp),
      maxHp: round(ship.maxHp),
      shield: finiteShieldSnapshotValue(ship, "shield"),
      maxShield: finiteShieldSnapshotValue(ship, "maxShield"),
      radius: round(ship.radius),
      cost: ship.cost || ship.stats?.unitCost || 0,
      focusTargetId: ship.focusTargetId || ship.repairTargetId || null,
      combatTargetId: ship.combatTargetId || null,
      weaponAngles: (ship.weaponAngles || []).map(round),
      commandState: ship.commandState || "mainCore",
      emergencyReserveUntil: ship.emergencyReserveUntil || null,
      alive: ship.alive,
      commandAuraActive: Boolean(ship.commandAuraActive),
      commandAuraReceived: Boolean(ship.commandAuraReceived),
      proximityChargeDetonated: ship.proximityChargeDetonated || [],
      blasterRange: Number(effectiveRanges.blaster) || 0,
      missileRange: Number(effectiveRanges.missile) || 0,
      railgunRange: Number(effectiveRanges.railgun) || 0,
      beamRange: Number(effectiveRanges.beam) || 0,
      weaponRanges: (effectiveWeapons?.profiles || []).map((profile, index) => (
        profile && (ship.componentHp?.[index] ?? 1) > 0 ? Number(profile.range) || 0 : null
      )),
      beamRadius: ship.stats?.beamRadius || 0,
      sensorRange: round(sensorProfile.omniRange),
      sensorCones: (sensorProfile.directed || []).map((cone) => ({
        componentIndex: cone.componentIndex,
        relativeAngle: roundAngle(cone.relativeAngle),
        arc: roundAngle(cone.arcRadians),
        range: round(cone.range)
      })),
      respawnIn: 0,
      removeIn: ship.alive ? 0 : Math.max(0, Math.ceil(((ship.removeAt || now) - now) / 1000))
    };
    if (ship.droneBays?.length) entry.droneBays = buildBaySnapshots(ship);
    if (ship.decoyLaunchers?.length) entry.decoyLaunchers = buildLauncherSnapshots(ship);
    if (ship.blockedEngineIndices?.size) entry.engBlocked = [...ship.blockedEngineIndices];
    // Refresh on the full baseline and whenever component condition changes.
    // Compact snapshots omit it otherwise; the client carries the last value.
    if (sendStatic || ship.dirtyComponents?.size) entry.chpVisual = buildComponentDamageVisual(ship);
    // One decimal place so ships below 0.5% pressure don't flatten to 0%.
    const heatPercent = Math.max(0, (ship.heatPressure || 0) * 100);
    entry.heat = Math.round(heatPercent * 10) / 10;
    entry.heatNow = Math.round((ship.currentHeat || 0) * 10) / 10;
    entry.heatMax = Math.round((ship.maxHeat || 0) * 10) / 10;
    entry.hot = ship.hotComponentCount || 0;
    entry.overheated = ship.overheatedComponentCount || 0;
    entry.heatRevision = ship.heatRevision || 0;
    entry.componentHeatRevision = ship.componentHeatRevision || 0;
    entry.heatStateRevision = ship.heatStateRevision || 0;
    entry.heatTelemetryRevision = ship.heatTelemetryRevision || 0;
    entry.powerRuntimeRevision = (ship.powerRevision || 0)
      + (ship.powerProtectionRevision || 0)
      + (ship.heatTelemetryRevision || 0);
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

  // Objective points, in one shape for both modes.
  //
  // Classic capture points ramp `progress` to 1 and HOLD it there while owned,
  // so every consumer — the relay chips, the team relay list, objectiveControl,
  // the victory meter — treats `progress >= 0.98` as "controlled". A station
  // relay's `captureProgress` is the opposite: a transient capture timer that
  // resets to 0 the moment the relay changes hands, and `room.points` is never
  // updated in station mode at all. The HUD therefore read every relay as
  // neutral at 0% for the whole match. Relays are projected onto the classic
  // contract here (held == 1) so there is one meaning of `progress` downstream.
  const stationMode = usesStationInfrastructure(room);
  const objectivePoints = stationMode
    ? (room.stations || [])
      .filter((station) => station.stationType === "relay")
      .map((station) => {
        const held = Boolean(station.team) && station.state !== "neutral";
        return {
          id: station.relayId || station.id,
          stationId: station.id,
          x: station.x,
          y: station.y,
          radius: INFRASTRUCTURE.relayStation?.captureRadius || station.radius || 0,
          ownerId: station.ownerId || null,
          ownerTeam: station.team || null,
          contested: Boolean(station.captureContested),
          progress: held ? 1 : Math.max(0, Math.min(1, station.captureProgress || 0))
        };
      })
    : (room.points || []).map((point) => ({
      id: point.id,
      x: point.x,
      y: point.y,
      radius: point.radius,
      ownerId: point.ownerId,
      ownerTeam: point.ownerTeam,
      contested: Boolean(point.contested),
      progress: point.progress || 0
    }));

  const objectiveControl = {
    total: objectivePoints.length,
    neutral: 0,
    contested: 0,
    teams: {},
    players: {}
  };
  for (const target of objectivePoints) {
    const contested = target.contested;
    const progress = target.progress;
    const ownerId = target.ownerId;
    const ownerTeam = target.ownerTeam;
    if (contested) {
      objectiveControl.contested++;
    } else if (room.rules?.gameMode === "solo") {
      if (!ownerId || progress < 0.98) {
        objectiveControl.neutral++;
      } else {
        objectiveControl.players[ownerId] = (objectiveControl.players[ownerId] || 0) + 1;
      }
    } else {
      if (!ownerTeam || progress < 0.98) {
        objectiveControl.neutral++;
      } else {
        objectiveControl.teams[ownerTeam] = (objectiveControl.teams[ownerTeam] || 0) + 1;
      }
    }
  }

  let bullets = [];
  if (buildBullets) {
    const bulletStart = performanceNow();
    bullets = room.bullets.map((bullet) => ({
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
    }));
    recordDuration(room, "projectileSnapshotConstructionMs", bulletStart);
    if (sendStatic) bump(room, "projectileFullBaselineEntries", bullets.length);
  }

  const shared = {
    ships,
    drones: buildDroneSnapshots(room, now),
    decoys: buildDecoySnapshots(room, now),
    bullets,
    stations: buildStationSnapshots(room, now, sendStatic),
    points: objectivePoints.map((point) => ({
      id: point.id,
      x: round(point.x),
      y: round(point.y),
      radius: point.radius,
      ownerId: point.ownerId,
      ownerTeam: point.ownerTeam,
      contested: point.contested,
      progress: round(point.progress)
    })),
    effects: room.effects.map((effect) => ({ ...effect, age: Math.max(0, round(now - effect.at)), subtype: effect.subtype })),
    objectiveControl
  };
  return shared;
}

function getKnownShipDesigns(client) {
  if (!client) return new Map();
  if (!client.knownShipDesignRevisions) client.knownShipDesignRevisions = new Map();
  return client.knownShipDesignRevisions;
}

function getKnownStationStaticRevisions(client) {
  if (!client) return new Map();
  if (!client.knownStationStaticRevisions) client.knownStationStaticRevisions = new Map();
  return client.knownStationStaticRevisions;
}

function getKnownStationComponentRevisions(client) {
  if (!client) return new Map();
  if (!client.knownStationComponentRevisions) client.knownStationComponentRevisions = new Map();
  return client.knownStationComponentRevisions;
}


function presentNetworkId(value) { return value === null || value === undefined ? null : value; }
function finiteOrNull(value) { const number = Number(value); return Number.isFinite(number) ? number : null; }
function buildSwitchgearSnapshot(_ship) { return []; }

function buildProtectionSnapshot(ship) {
  if (!WIRING_ENABLED) return null;
  return buildPowerProtectionSnapshot(ship);
}

function buildPowerWiringLayoutSnapshot(ship) {
  return buildPowerWiringLayout(ship);
}
function buildPowerWiringRuntimeSnapshot(ship) {
  return buildPowerWiringRuntime(ship);
}

function appendComponentPowerState(entry, ship) {
  entry.componentPower = ship.componentPower.byComponentIndex.map((power) => [power.state, power.networkId, Math.round(power.operationalMultiplier * 1000) / 1000]);
  entry.powerStatus = ship.powerStatus;
  entry.powerRevision = ship.powerRevision || 0;
  entry.wiringRevision = ship.wiringRevision || 0;
}

function appendDetailedPowerTelemetry(entry, ship) {
  appendComponentPowerState(entry, ship);
  if (!WIRING_ENABLED) return;
  entry.powerThermal = buildRuntimePowerThermalSnapshot(ship);
  entry.wiringStatus = wiringStatus(ship);
  entry.switchgear = buildSwitchgearSnapshot(ship);
  entry.powerProtection = buildProtectionSnapshot(ship);
  entry.powerProtectionRevision = ship.powerProtectionRevision || 0;
  entry.powerWiring = buildPowerWiringLayoutSnapshot(ship);
  entry.powerWiringRevision = ship.wiringRevision || 0;
  entry.powerWiringRuntime = buildPowerWiringRuntimeSnapshot(ship);
}

function appendFullShipBaseline(entry, ship, includeTelemetry = true) {
  delete entry.chpD;
  delete entry.componentHeatD;
  entry.design = ship.design || [];
  if (ship.componentPower?.byComponentIndex) {
    if (includeTelemetry) appendDetailedPowerTelemetry(entry, ship);
    else appendComponentPowerState(entry, ship);
  }
  if (ship.componentHp) entry.chp = ship.componentHp.map((hp) => Math.round(hp * 10) / 10);
  if (ship.componentHeat) entry.componentHeat = ship.componentHeat.map((_, i) => buildComponentHeatTuple(ship, i));
  if (ship.componentStorageCharge) entry.storageCharge = ship.componentStorageCharge.map((v) => Math.round(v * 10) / 10);
}

function appendShipDeltas(entry, ship, client = null, options = {}) {
  const includeTelemetry = options.includeTelemetry !== false;
  const forceTelemetry = options.forceTelemetry === true;
  const knownPower = client?.knownShipPowerRevisions instanceof Map ? client.knownShipPowerRevisions : null;
  const known = knownPower ? knownPower.get(ship.id) : undefined;
  const currentPowerRevision = ship.powerRevision || 0;
  const powerChanged = ship.componentPower?.byComponentIndex && (knownPower ? known !== currentPowerRevision : ship.dirtyPower);
  if (powerChanged) {
    appendComponentPowerState(entry, ship);
    if (includeTelemetry && WIRING_ENABLED) {
      entry.powerThermal = buildRuntimePowerThermalSnapshot(ship);
      entry.wiringStatus = wiringStatus(ship);
      entry.switchgear = buildSwitchgearSnapshot(ship);
    }
  }
  // Section 7G: the compact runtime protection block has its own revision so
  // stress/trip/retry changes reach the player even when component allocations
  // are unchanged, while unchanged protection state resends nothing (the
  // client merge preserves the previous block when omitted).
  const knownProtection = client?.knownShipPowerProtectionRevisions instanceof Map ? client.knownShipPowerProtectionRevisions : null;
  const currentProtectionRevision = ship.powerProtectionRevision || 0;
  const protectionChanged = ship.componentPower?.byComponentIndex
    && (knownProtection ? knownProtection.get(ship.id) !== currentProtectionRevision : ship.dirtyPowerProtection);
  if (WIRING_ENABLED && includeTelemetry && protectionChanged) {
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
  if (WIRING_ENABLED && includeTelemetry && wiringLayoutChanged) {
    entry.powerWiring = buildPowerWiringLayoutSnapshot(ship);
    entry.powerWiringRevision = currentWiringRevision;
  }
  // Live per-section runtime block: whenever flow (power) or stress/protection
  // changed. Layout stays cached; only the runtime values refresh.
  if (WIRING_ENABLED && includeTelemetry && (powerChanged || protectionChanged) && ship.componentPower?.byComponentIndex) {
    entry.powerWiringRuntime = buildPowerWiringRuntimeSnapshot(ship);
  }
  // `powerThermal` contains Heat-derived values (component Heat generated,
  // cable Heat generated, cooling, net rate, hottest component) that change
  // during ordinary thermal ticks even when the Power allocator does not run.
  // Send a fresh compact diagnostics block with Heat deltas, without forcing a
  // Power solve or resending static design data.
  if (WIRING_ENABLED && includeTelemetry && !powerChanged && ship.componentPower?.byComponentIndex && ship.dirtyHeat?.size) {
    entry.powerThermal = buildRuntimePowerThermalSnapshot(ship);
  }
  const knownHeatTelemetry = client?.knownShipHeatTelemetryRevisions instanceof Map
    ? client.knownShipHeatTelemetryRevisions
    : null;
  const currentHeatTelemetryRevision = ship.heatTelemetryRevision || 0;
  const heatTelemetryChanged = knownHeatTelemetry
    ? knownHeatTelemetry.get(ship.id) !== currentHeatTelemetryRevision
    : Boolean(ship.dirtyHeat?.size);
  if (WIRING_ENABLED && includeTelemetry && heatTelemetryChanged && ship.componentPower?.byComponentIndex) {
    entry.powerThermal = buildRuntimePowerThermalSnapshot(ship);
    entry.heatTelemetryRevision = currentHeatTelemetryRevision;
  }
  // Focused telemetry is deliberately independent of dirty/revision flags: a
  // newly selected ship must receive a complete current diagnostics block, and
  // the scheduled 2 Hz refresh must not depend on whether a topology changed.
  if (forceTelemetry && ship.componentPower?.byComponentIndex) appendDetailedPowerTelemetry(entry, ship);
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
  // Index the cable component rows once. Looking each row up with
  // `cable.components.find(...)` inside the per-component map made this
  // O(components^2), and it runs per viewer per ship on every snapshot that
  // carries heat deltas.
  const cableComponentsByIndex = new Map();
  for (const entry of cable.components || []) {
    if (entry && !cableComponentsByIndex.has(entry.componentIndex)) cableComponentsByIndex.set(entry.componentIndex, entry);
  }
  const components = (ship.design || []).map((part, i) => {
    const cp = ship.componentPower?.byComponentIndex?.[i] || {};
    const rated = Number(PARTS[part?.type]?.powerGeneration) || 0;
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
    activityLevel: Number(ship.componentPowerActivity?.[i]) || 0,
    componentHeatRate: (Number(ship.componentHeatGenerated?.[i]) || 0) / elapsed,
    powerCableHeatRate: Number(ship.componentPowerCableHeatRate?.[i]) || 0,
    powerCableHeatGenerated: Number(ship.componentPowerCableHeatGenerated?.[i]) || 0,
    hostedActiveSectionIds: cableComponentsByIndex.get(i)?.hostedActiveSectionIds || []
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
    storageChargingMw: finiteOrNull(powerSummary.storageChargingMw),
    storageDischargingMw: finiteOrNull(powerSummary.storageDischargingMw),
    storageComponents: powerSummary.storageComponents || [],
    hottestSectionId: cableSummary.hottestSectionId || null,
    components
  };
}

function wiringStatus(ship) {
  if (!WIRING_ENABLED) return undefined;
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

// Viewer-specific ship-detail policy. Owner and allied ships may receive full
// operational internals (design, per-component HP/Heat, Power allocation, power
// status/thermal diagnostics, wiring status, switchgear, power protection,
// installed wiring layout + runtime). Enemy ships receive only the public
// visual representation (the design needed to draw the hull and weapons) plus
// the externally observable dynamic fields already present in the shared
// baseline (position, velocity, facing, hull/shield totals, radius, weapon
// angles, alive state...).
//
// A null viewer is the trusted/diagnostic path (internal tooling and tests):
// the network delivery path always supplies client.player, so production
// clients are always evaluated against a concrete viewer.
function canViewShipInternals(viewer, ship, room) {
  if (!ship) return false;
  if (!viewer) return true;
  if (viewer.id === ship.ownerId) return true;
  if (room?.rules?.gameMode === "solo") return false;
  const owner = room?.players?.get?.(ship.ownerId);
  return Boolean(owner && viewer.team !== undefined && viewer.team === owner.team);
}

// Every private per-ship field. Enemy entries must never carry any of these,
// and the client merge (public/src/snapshotMerge.js) keeps an identical list so
// cached copies are discarded when a ship becomes public.
const PRIVATE_SHIP_FIELDS = [
  "componentPower", "powerStatus", "powerThermal", "powerRevision", "wiringRevision",
  "powerRuntimeRevision",
  "wiringStatus", "switchgear", "powerProtection", "powerProtectionRevision",
  "powerWiring", "powerWiringRevision", "powerWiringRuntime",
  "chp", "chpD", "componentHeat", "componentHeatD",
  "componentHeatRevision", "heatTelemetryRevision"
];

// Enemy ships: attach only a safe public visual representation. This is the raw
// design geometry (module types/positions/rotations) required to render the
// hull and weapon mounts — it carries NO per-component HP, Heat, Power, wiring,
// switchgear or protection state. Any private field that leaked in from a shared
// baseline copy is stripped here defensively, so redaction holds no matter how
// the base entry was constructed. The `detail: "public"` marker lets the client
// merge discard any private fields cached from an earlier full-detail snapshot
// so redacted data can never survive a visibility change.
function appendPublicShipVisual(entry, ship, includeDesign) {
  entry.detail = "public";
  entry.design = includeDesign ? (ship.design || []) : undefined;
  if (entry.design === undefined) delete entry.design;
  if (includeDesign) entry.chpVisual = buildComponentDamageVisual(ship);
  for (const key of PRIVATE_SHIP_FIELDS) delete entry[key];
}

function buildClientShips(room, sharedShips, client, sendStatic, telemetryFocusShipId, visibilityState = null) {
  const known = getKnownShipDesigns(client);
  const knownVisible = client?.knownVisibleShipIds;
  const sensorVisibility = usesSensorVisibility(room);
  const viewer = client?.player || null;
  const legacyTelemetry = telemetryFocusShipId === undefined;
  const entries = [];
  for (const base of sharedShips) {
    if (sensorVisibility && visibilityState && !visibilityState.visibleEntityIds.has(base.id)) continue;
    const entry = { ...base };
    const ship = room.ships.get(entry.id);
    if (!ship || ship.removed) {
      entries.push(entry);
      continue;
    }
    const revision = ship.designRevision || 1;
    // A hidden ship is removed from the client's merged snapshot. Its design
    // revision may still be "known", but a later compact reacquisition has no
    // entity baseline to merge against. Track what the client actually received
    // in its last written snapshot so reacquisition includes a fresh baseline
    // instead of causing a missing-baseline resync loop.
    const visibleInSensorSnapshot = !sensorVisibility
      || !visibilityState
      || visibilityState?.visibleEntityIds?.has?.(ship.id);
    const visibilityBaselineMissing = sensorVisibility
      && (!(knownVisible instanceof Set) || !knownVisible.has(ship.id));
    const needBaseline = visibleInSensorSnapshot
      && (sendStatic || known.get(ship.id) !== revision || visibilityBaselineMissing);
    if (canViewShipInternals(viewer, ship, room)) {
      entry.detail = "full";
      const focusedTelemetry = telemetryFocusShipId === ship.id;
      const includeTelemetry = legacyTelemetry || focusedTelemetry;
      if (needBaseline) appendFullShipBaseline(entry, ship, includeTelemetry);
      else appendShipDeltas(entry, ship, client, { includeTelemetry, forceTelemetry: focusedTelemetry && !legacyTelemetry });
    } else {
      appendPublicShipVisual(entry, ship, needBaseline);
    }
    entries.push(entry);
  }
  return entries;
}

function buildClientStations(room, sharedStations, client, sendStatic) {
  if (!Array.isArray(sharedStations)) return sharedStations;
  const knownStatic = getKnownStationStaticRevisions(client);
  const knownComponents = getKnownStationComponentRevisions(client);
  const knownCondition = client?.knownConditionStationIds;
  return sharedStations.map((base) => {
    const station = room.stationsById?.get?.(base.id)
      || room.stations?.find?.((entry) => entry.id === base.id);
    if (!station) return base;
    const entry = { ...base };
    const staticRevision = station.revision || 1;
    const componentRevision = station.componentDamageRevision || 0;
    const needsStatic = sendStatic
      || (client && knownStatic.get(station.id) !== staticRevision);
    const needsHealth = sendStatic
      || (client && (
        !(knownCondition instanceof Set)
        || !knownCondition.has(station.id)
        || knownComponents.get(station.id) !== componentRevision
    ));
    if (needsStatic) {
      entry.stationType = station.stationType;
      entry.x = round(station.x);
      entry.y = round(station.y);
      entry.angle = round(station.angle);
      entry.radius = round(station.radius || station.stats?.radius || 0);
      entry.moduleScale = station.moduleScale;
      entry.design = station.design || [];
      if (station.hangar) entry.hangar = station.hangar;
      if (station.hangars) entry.hangars = station.hangars;
      if (station.hardpoints) entry.hardpoints = station.hardpoints;
      entry.weaponAngles = (station.weaponAngles || []).map(round);
      delete entry.weaponAnglePairs;
    }
    if (needsHealth && station.componentHp) {
      entry.maxHp = round(station.maxHp);
      entry.maxShield = round(station.maxShield);
      entry.componentHp = stationComponentHpSnapshot(station);
    }
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

function collectSnapshotStationStaticRevisions(snapshot) {
  const revisions = [];
  for (const station of snapshot?.stations || []) {
    if (station.design) revisions.push([station.id, station.revision || 1]);
  }
  return revisions;
}

function markSnapshotStationStaticWritten(client, revisions = []) {
  const known = getKnownStationStaticRevisions(client);
  for (const [stationId, revision] of revisions) known.set(stationId, revision);
}

function collectSnapshotStationComponentRevisions(snapshot) {
  const revisions = [];
  for (const station of snapshot?.stations || []) {
    if (station.conditionKnown !== false && station.componentHp) {
      revisions.push([station.id, station.componentDamageRevision || 0]);
    }
  }
  return revisions;
}

function collectSnapshotConditionStationIds(snapshot) {
  const ids = [];
  for (const station of snapshot?.stations || []) {
    if (station.conditionKnown !== false) ids.push(station.id);
  }
  return ids;
}

function markSnapshotStationComponentWritten(client, revisions = []) {
  const known = getKnownStationComponentRevisions(client);
  for (const [stationId, revision] of revisions) known.set(stationId, revision);
}

function markSnapshotConditionStationsWritten(client, stationIds = []) {
  if (!client) return;
  client.knownConditionStationIds = new Set(stationIds);
}

function snapshotRoom(room, now, viewer = null, sendStatic = true, shared = null, client = null, options = null) {
  if (!shared) {
    const clientUsesEvents = client && require("./projectileReplication").clientSupportsProjectileEvents(client);
    shared = buildSharedSnapshot(room, now, sendStatic, Boolean(client), !clientUsesEvents);
  }
  const telemetryFocusShipId = options && Object.prototype.hasOwnProperty.call(options, "telemetryFocusShipId")
    ? options.telemetryFocusShipId
    : (client && Object.prototype.hasOwnProperty.call(client, "telemetryFocusShipId") ? client.telemetryFocusShipId : undefined);

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

  const visibilityViewer = client?.player || viewer;
  const visibilityState = visibilityViewer && usesSensorVisibility(room)
    ? ensureTeamVisibility(room, visibilityViewer.team ?? visibilityViewer.id, now)
    : null;
  const snapshot = {
    type: "state",
    room: room.code,
    // Frontend/backend build identification: the client compares these against
    // its own protocol support to detect a stale separately-deployed backend.
    protocolVersion: PROTOCOL_VERSION,
    serverBuildSha: SERVER_BUILD_SHA,
    balanceRevision: BALANCE_REVISION,
    stateEpoch: room.stateEpoch || 1,
    snapshotSeq: room._buildingSnapshotSeq || room.snapshotSeq || 0,
    snapshotKind: sendStatic ? "full" : "compact",
    baseSnapshotSeq: sendStatic ? null : (room._buildingBaseSnapshotSeq ?? Math.max(0, (room._buildingSnapshotSeq || room.snapshotSeq || 1) - 1)),
    staticRevision: room.staticRevision || 1,
    staticRevisions: { world: room.staticRevision || 1, map: room.staticRevision || 1, rules: room.staticRevision || 1, playerDesign: room.staticRevision || 1, shipDesign: room.staticRevision || 1, componentCatalogue: room.componentCatalogueRevision || 1 },
    // The tick this state came from, not the moment it is being sent. This is
    // the client's interpolation timeline: it must advance by exactly as much
    // simulated time as the ships in it actually moved. See tickRoom.
    simulationTimeMs: Math.floor(Number.isFinite(room.simulationTimeMs) ? room.simulationTimeMs : now),
    serverTimeMs: Date.now(),
    createdAtMs: Date.now(),
    phase: room.phase,
    adminId: room.adminId,
    players,
    ships: buildClientShips(room, shared.ships, client, sendStatic, telemetryFocusShipId, visibilityState),
    drones: shared.drones,
    decoys: shared.decoys,
    bullets: shared.bullets,
    effects: shared.effects,
    stations: buildClientStations(room, shared.stations, client, sendStatic),
    points: shared.points,
    winner: room.winner,
    matchStartedAt: room.matchStartedAt,
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
  if (process.env.NODE_ENV !== "production" && room.spawnCollisionDiagnostics) {
    snapshot.spawnCollisionDiagnostics = { ...room.spawnCollisionDiagnostics };
  }
  // Per-client projectile lifecycle overlay.  This is intentionally applied
  // after the shared snapshot is built but before player-specific filtering,
  // so visibility-filtered fallback clients are not affected.
  if (client) {
    const { setPendingDelivery } = require("./projectileReplication");
    const delivery = applyClientProjectiles(room, client, now, sendStatic, snapshot);
    if (delivery) setPendingDelivery(client, room, delivery);
  }
  return client?.player
    ? filterSnapshotForPlayer(room, client.player, snapshot, now)
    : snapshot;
}
function collectSnapshotVisibleShipIds(snapshot) {
  return (snapshot?.ships || []).map((ship) => ship.id);
}
function markSnapshotVisibilityWritten(client, shipIds = []) {
  if (!client) return;
  client.knownVisibleShipIds = new Set(shipIds);
}
function collectSnapshotHeatTelemetryRevisions(snapshot) {
  const revisions = [];
  for (const ship of snapshot?.ships || []) {
    if (ship.powerThermal) revisions.push([ship.id, ship.heatTelemetryRevision || 0]);
  }
  return revisions;
}
function markSnapshotHeatTelemetryWritten(client, revisions = []) {
  if (!client) return;
  if (!client.knownShipHeatTelemetryRevisions) client.knownShipHeatTelemetryRevisions = new Map();
  for (const [shipId, revision] of revisions) client.knownShipHeatTelemetryRevisions.set(shipId, revision);
}

function pruneClientKnownShips(client, shipIds = []) {
  if (!client) return;
  const keep = new Set(shipIds);
  for (const key of ["knownShipDesignRevisions", "knownShipPowerRevisions", "knownShipPowerProtectionRevisions", "knownShipWiringLayoutRevisions", "knownShipHeatTelemetryRevisions"]) {
    const map = client[key];
    if (!(map instanceof Map)) continue;
    for (const id of [...map.keys()]) if (!keep.has(id)) map.delete(id);
  }
}
function pruneClientKnownStations(client, stationIds = []) {
  if (!client) return;
  const keep = new Set(stationIds);
  for (const key of ["knownStationStaticRevisions", "knownStationComponentRevisions"]) {
    const map = client[key];
    if (!(map instanceof Map)) continue;
    for (const id of [...map.keys()]) if (!keep.has(id)) map.delete(id);
  }
}

function canViewPlayerEconomy(viewer, player) {
  if (!viewer || !player) return false;
  if (viewer.id === player.id) return true;
  return viewer.team === player.team;
}

module.exports = {
  pruneClientKnownShips,
  pruneClientKnownStations,
  snapshotRoom,
  buildSharedSnapshot,
  collectSnapshotDesignRevisions,
  collectSnapshotVisibleShipIds,
  markSnapshotVisibilityWritten,
  collectSnapshotPowerRevisions,
  collectSnapshotPowerProtectionRevisions,
  collectSnapshotWiringLayoutRevisions,
  collectSnapshotHeatTelemetryRevisions,
  collectSnapshotStationStaticRevisions,
  collectSnapshotStationComponentRevisions,
  collectSnapshotConditionStationIds,
  markSnapshotDesignsWritten,
  markSnapshotPowerWritten,
  markSnapshotPowerProtectionWritten,
  markSnapshotWiringLayoutWritten,
  markSnapshotHeatTelemetryWritten,
  markSnapshotStationStaticWritten,
  markSnapshotStationComponentWritten,
  markSnapshotConditionStationsWritten,
  canViewPlayerEconomy,
  _test: { buildSwitchgearSnapshot, buildRuntimePowerThermalSnapshot, finiteOrNull }
};
