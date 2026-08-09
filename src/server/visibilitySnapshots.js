// Snapshot filtering for sensor-visibility mode.

const {
  usesSensorVisibility,
  ensureTeamVisibility,
  getVisibleEntityIdsForTeam,
  isPointVisibleInState,
  normalizedTeamId
} = require("./visibility");
const { bump, recordDuration } = require("./roomTelemetry");
const { performanceNow } = require("./utils");

function teamIdForViewer(room, viewer) {
  if (!viewer) return null;
  return normalizedTeamId(room, viewer.team ?? viewer.id ?? null);
}

function entityTeamId(room, entity) {
  return require("./visibilityRuntime").getCachedEntityTeam(room, entity);
}

function isAlliedTo(room, viewerTeam, entity) {
  const entityTeam = entityTeamId(room, entity);
  return viewerTeam && entityTeam && viewerTeam === entityTeam;
}

function isEntityVisibleAtPoint(room, teamId, state, entity, padding = 0, snapshotMeta = null) {
  const hasSnapshotTeam = snapshotMeta?.entityTeamById?.has?.(entity?.id);
  const snapshotTeam = hasSnapshotTeam ? snapshotMeta.entityTeamById.get(entity.id) : null;
  return (hasSnapshotTeam ? Boolean(teamId && snapshotTeam && teamId === snapshotTeam) : isAlliedTo(room, teamId, entity))
    || isPointVisibleInState(state, entity?.x, entity?.y, padding);
}

// These arrays depend on team visibility, not on the individual player.
// Snapshot delivery still builds private ship/economy fields per player; this
// only prevents teammates repeating identical projectile/coverage scans.
function filterSharedTacticalEntities(room, teamId, snapshot, state) {
  const startedAt = performanceNow();
  const sharedIdentity = snapshot.__visibilitySharedIdentity || snapshot;
  const publicSource = sharedIdentity === snapshot ? snapshot : sharedIdentity;
  const snapshotMeta = sharedIdentity.snapshotEntityMeta || snapshot.snapshotEntityMeta || null;
  const dronesSource = snapshot.drones || [];
  const decoysSource = snapshot.decoys || [];
  const bulletsSource = snapshot.bullets || [];
  const effectsSource = snapshot.effects || [];
  const stationsSource = publicSource.stations || snapshot.stations || [];
  const shipsSource = publicSource.ships || snapshot.ships || [];
  const revision = Number(state.resultRevision || state.revision || state.computedGeneration) || 0;
  const stateEpoch = snapshot.stateEpoch ?? sharedIdentity.stateEpoch ?? room.stateEpoch ?? 1;
  const snapshotSeq = snapshot.snapshotSeq ?? sharedIdentity.snapshotSeq ?? 0;
  const staticRevision = snapshot.staticRevision ?? sharedIdentity.staticRevision ?? room.staticRevision ?? 1;
  const entityDeltaGeneration = snapshot.entityDeltaGeneration
    ?? sharedIdentity.entityDeltaGeneration
    ?? snapshot.baseSnapshotSeq
    ?? sharedIdentity.baseSnapshotSeq
    ?? 0;
  const projectileEventMode = snapshot.projectileEvents !== undefined;
  const cached = state.snapshotFilterCache;
  if (cached
    && cached.teamId === teamId
    && cached.stateEpoch === stateEpoch
    && cached.snapshotSeq === snapshotSeq
    && cached.staticRevision === staticRevision
    && cached.entityDeltaGeneration === entityDeltaGeneration
    && cached.projectileEventMode === projectileEventMode
    && cached.sharedIdentity === sharedIdentity
    && cached.visibilityRevision === revision
    && cached.dronesSource === dronesSource
    && cached.decoysSource === decoysSource
    && cached.bulletsSource === bulletsSource
    && cached.effectsSource === effectsSource
    && cached.stationsSource === stationsSource
    && cached.shipsSource === shipsSource) {
    room._visibilitySnapshotFilterCacheHits = (Number(room._visibilitySnapshotFilterCacheHits) || 0) + 1;
    bump(room, "visibilitySnapshotFilterCacheHits");
    return cached;
  }

  const visibleSet = state.visibleEntityIds;
  const visibleShipIds = new Set(state.visibleShips?.length ? state.visibleShips : visibleSet);
  const visibleDroneIds = new Set(state.visibleDrones?.length ? state.visibleDrones : visibleSet);
  const visibleStationIds = new Set(state.visibleStations?.length ? state.visibleStations : visibleSet);

  const shipsPublic = [];
  for (const ship of shipsSource) {
    bump(room, "visibilitySnapshotShipsConsidered");
    if (visibleShipIds.has(ship.id)) shipsPublic.push(ship);
  }

  const drones = [];
  for (const drone of dronesSource) {
    bump(room, "visibilitySnapshotDronesConsidered");
    if (visibleDroneIds.has(drone.id)
      && (!snapshotMeta?.dronesById || snapshotMeta.dronesById.has(drone.id))) drones.push(drone);
  }

  const decoys = [];
  for (const decoy of decoysSource) {
    if (isEntityVisibleAtPoint(room, teamId, state, decoy, decoy.radius || 0, snapshotMeta)) decoys.push(decoy);
  }

  const bullets = [];
  for (const bullet of bulletsSource) {
    bump(room, "visibilitySnapshotBulletsConsidered");
    if (isEntityVisibleAtPoint(room, teamId, state, bullet, 0, snapshotMeta)) bullets.push(bullet);
  }

  const effects = [];
  for (const effect of effectsSource) {
    bump(room, "visibilitySnapshotEffectsConsidered");
    const hasPosition = Number.isFinite(Number(effect?.x)) && Number.isFinite(Number(effect?.y));
    if (!hasPosition || isEntityVisibleAtPoint(room, teamId, state, effect, 0, snapshotMeta)) effects.push(effect);
  }

  const next = {
    teamId,
    stateEpoch,
    snapshotSeq,
    staticRevision,
    entityDeltaGeneration,
    projectileEventMode,
    sharedIdentity,
    visibilityRevision: revision,
    shipsSource,
    stationsSource,
    dronesSource,
    decoysSource,
    bulletsSource,
    effectsSource,
    snapshotMeta,
    shipsPublic,
    visibleShipIds,
    visibleDroneIds,
    visibleStationIds,
    stationsPublicOrVisible: stationsSource.map((station) => {
      if (visibleStationIds.has(station.id)) return station;
      return {
        id: station.id,
        stationType: station.stationType,
        team: station.team,
        ownerId: station.ownerId,
        state: station.state === "neutral"
          ? "neutral"
          : (station.stationType === "relay" && (station.team || station.ownerId) ? "controlled" : "unknown"),
        x: station.x,
        y: station.y,
        angle: station.angle,
        radius: station.radius,
        conditionKnown: false,
        mapKnown: true
      };
    }),
    // The remembered map also holds the short detection-linger interval.  A
    // lingered contact is still delivered as a live entity, so it must not be
    // duplicated as a stale contact in the same snapshot.
    rememberedContacts: [...state.remembered.values()]
      .filter((contact) => !visibleSet.has(contact.id))
      .map(buildRememberedContactSnapshot),
    drones,
    decoys,
    bullets,
    effects
  };
  state.snapshotFilterCache = next;
  room._visibilitySnapshotFilterBuilds = (Number(room._visibilitySnapshotFilterBuilds) || 0) + 1;
  bump(room, "visibilitySnapshotFilterBuilds");
  recordDuration(room, "visibilitySnapshotFilterMs", startedAt);
  return next;
}

function filterSnapshotForPlayer(room, player, snapshot, now) {
  if (!usesSensorVisibility(room)) return { ...snapshot, contacts: [] };
  const teamId = teamIdForViewer(room, player);
  if (!teamId) return { ...snapshot, contacts: [] };

  const state = ensureTeamVisibility(room, teamId, now);
  const shared = filterSharedTacticalEntities(room, teamId, snapshot, state);

  const ships = [];
  const contacts = [];

  for (const ship of snapshot.ships || []) {
    if (shared.visibleShipIds.has(ship.id)) ships.push(ship);
  }
  contacts.push(...shared.rememberedContacts);

  // Stations: always show location, but live details only if allied or visible.
  const stations = [];
  const snapshotMeta = shared.snapshotMeta || snapshot.snapshotEntityMeta || null;
  for (const station of snapshot.stations || []) {
    const roomStation = snapshotMeta?.stationsById?.get?.(station.id)
      || room.stationsById?.get?.(station.id)
      || room.stations?.find?.((entry) => entry.id === station.id);
    const isAllied = snapshotMeta?.entityTeamById?.has?.(station.id)
      ? snapshotMeta.entityTeamById.get(station.id) === teamId
      : (roomStation ? isAlliedTo(room, teamId, roomStation) : false);
    if (isAllied || shared.visibleStationIds.has(station.id)) {
      stations.push(station);
    } else {
      // Static knowledge: position, id, type, ownership and the STRUCTURE —
      // its module layout, scale, hangar geometry and gun hardpoints. A station
      // is a fixed installation sitting in the open, so what it is built from
      // and where its batteries are mounted is not a secret; a player has to be
      // able to see what they are flying into. Turret bearings come with it so
      // the guns track visibly instead of the client having to invent angles.
      //
      // Condition stays hidden: no hp/maxHp, shields, per-component damage or
      // production queue. Captured relays still report the public fact that
      // they are controlled; "unknown" is reserved for a structure whose
      // public state cannot be described without revealing its condition.
      const hiddenStation = {
        id: station.id,
        team: station.team,
        ownerId: station.ownerId,
        // Whether a relay has been captured is already public — it drives the
        // objective HUD, the relay chips and the victory condition — so masking
        // a neutral station as "unknown" would hide something the panel on the
        // right is showing anyway. Condition remains withheld, because it can
        // reveal the station's remaining combat strength.
        state: station.state === "neutral"
          ? "neutral"
          : (station.stationType === "relay" && (station.team || station.ownerId) ? "controlled" : "unknown"),
        revision: station.revision,
        weaponRange: station.weaponRange,
        conditionKnown: false,
        mapKnown: true
      };
      for (const key of [
        "stationType", "x", "y", "angle", "radius", "shieldRadius",
        "design", "hardpoints", "moduleScale", "weaponAngles", "weaponAnglePairs", "hangars", "launches"
      ]) {
        if (station[key] !== undefined) hiddenStation[key] = station[key];
      }
      stations.push(hiddenStation);
    }
  }

  // Event-mode clients carry a per-client bullet baseline/empty list; fallback
  // clients use the visibility-filtered shared bullet list.
  const outputBullets = snapshot.projectileEvents !== undefined
    ? (snapshot.bullets ?? [])
    : shared.bullets;
  const result = {
    ...snapshot,
    ships,
    drones: shared.drones,
    decoys: shared.decoys,
    bullets: outputBullets,
    effects: shared.effects,
    stations,
    contacts
  };
  if (process.env.MFA_VISIBILITY_AUDIT) {
    const auditStartedAt = performanceNow();
    auditSnapshotForInformationLeaks(room, player, result, now);
    recordDuration(room, "visibilityAuditMs", auditStartedAt);
  }
  return result;
}

function buildRememberedContactSnapshot(contact) {
  return {
    id: contact.id,
    entityType: contact.entityType,
    sourceEntityType: contact.sourceEntityType,
    contactClass: contact.contactClass,
    lastKnownX: contact.lastKnownX,
    lastKnownY: contact.lastKnownY,
    lastKnownAngle: contact.lastKnownAngle,
    lastSeenAt: contact.lastSeenAt
  };
}

function getVisibleContactsForTeam(room, teamId, now) {
  if (!usesSensorVisibility(room)) return [];
  const state = ensureTeamVisibility(room, teamId, now);
  return [...state.remembered.values()];
}

const LEAK_SENSITIVE_SHIP_FIELDS = [
  "componentPower", "powerStatus", "powerThermal", "chp", "chpD", "componentHeat", "componentHeatD",
  "storageCharge"
];
const LEAK_SENSITIVE_STATION_FIELDS = [
  "hp", "maxHp", "shield", "maxShield", "componentHp", "productionQueue", "conditionKnown"
];

function auditSnapshotForInformationLeaks(room, player, snapshot, now) {
  if (!room || !player) return;
  const viewerTeam = teamIdForViewer(room, player);
  if (!viewerTeam) return;
  const visibleIds = getVisibleEntityIdsForTeam(room, viewerTeam, now);
  for (const ship of snapshot.ships || []) {
    const entity = room.ships?.get?.(ship.id);
    if (!entity) continue;
    if (isAlliedTo(room, viewerTeam, entity)) continue;
    if (!visibleIds.has(ship.id)) throw new Error(`audit leak: hidden enemy ship ${ship.id} in snapshot for ${player.id}`);
    for (const field of LEAK_SENSITIVE_SHIP_FIELDS) {
      if (ship[field] !== undefined) throw new Error(`audit leak: private field ${field} for ${ship.id}`);
    }
  }
  for (const contact of snapshot.contacts || []) {
    if (contact.x !== undefined || contact.y !== undefined) throw new Error(`audit leak: live position in contact ${contact.id}`);
  }
  for (const drone of snapshot.drones || []) {
    const entity = room.drones?.get?.(drone.id);
    if (entity && !isAlliedTo(room, viewerTeam, entity) && !visibleIds.has(drone.id)) {
      throw new Error(`audit leak: hidden enemy drone ${drone.id} in snapshot for ${player.id}`);
    }
  }
  for (const bullet of snapshot.bullets || []) {
    const entity = room.projectileById?.get?.(bullet.id)
      || room.bullets?.find?.((entry) => entry?.id === bullet.id);
    if (!entity || isAlliedTo(room, viewerTeam, entity)) continue;
    if (!isPointVisibleInState(ensureTeamVisibility(room, viewerTeam, now), bullet.x, bullet.y, bullet.radius || 0)) {
      throw new Error(`audit leak: hidden enemy bullet ${bullet.id} in snapshot for ${player.id}`);
    }
  }
  for (const effect of snapshot.effects || []) {
    if (!Number.isFinite(Number(effect?.x)) || !Number.isFinite(Number(effect?.y))) continue;
    if (!isPointVisibleInState(ensureTeamVisibility(room, viewerTeam, now), effect.x, effect.y)) {
      throw new Error(`audit leak: hidden effect ${effect.id || "unknown"} in snapshot for ${player.id}`);
    }
  }
  for (const station of snapshot.stations || []) {
    const entity = room.stationsById?.get?.(station.id)
      || room.stations?.find?.((entry) => entry.id === station.id);
    if (!entity || isAlliedTo(room, viewerTeam, entity) || visibleIds.has(station.id)) continue;
    if (station.conditionKnown !== false) {
      throw new Error(`audit leak: hidden station condition marker ${station.id} in snapshot for ${player.id}`);
    }
    for (const field of LEAK_SENSITIVE_STATION_FIELDS) {
      if (field !== "conditionKnown" && station[field] !== undefined) {
        throw new Error(`audit leak: private station field ${field} for ${station.id}`);
      }
    }
  }
}

module.exports = {
  filterSnapshotForPlayer,
  getVisibleContactsForTeam,
  buildRememberedContactSnapshot,
  entityTeamId,
  isAlliedTo,
  teamIdForViewer,
  auditSnapshotForInformationLeaks
};
