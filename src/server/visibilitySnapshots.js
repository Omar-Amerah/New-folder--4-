// Snapshot filtering for sensor-visibility mode.

const {
  usesSensorVisibility,
  ensureTeamVisibility,
  getVisibleEntityIdsForTeam,
  isPointVisibleInState,
  teamOfEntity,
  normalizedTeamId
} = require("./visibility");

function teamIdForViewer(room, viewer) {
  if (!viewer) return null;
  return normalizedTeamId(room, viewer.team ?? viewer.id ?? null);
}

function entityTeamId(room, entity) {
  return teamOfEntity(room, entity);
}

function isAlliedTo(room, viewerTeam, entity) {
  const entityTeam = entityTeamId(room, entity);
  return viewerTeam && entityTeam && viewerTeam === entityTeam;
}

function isEntityVisibleAtPoint(room, teamId, state, entity, padding = 0) {
  return isAlliedTo(room, teamId, entity)
    || isPointVisibleInState(state, entity?.x, entity?.y, padding);
}

// These arrays depend on team visibility, not on the individual player.
// Snapshot delivery still builds private ship/economy fields per player; this
// only prevents teammates repeating identical projectile/coverage scans.
function filterSharedTacticalEntities(room, teamId, snapshot, state) {
  const dronesSource = snapshot.drones || [];
  const decoysSource = snapshot.decoys || [];
  const bulletsSource = snapshot.bullets || [];
  const effectsSource = snapshot.effects || [];
  const cached = state.snapshotFilterCache;
  if (cached
    && cached.generation === state.computedGeneration
    && cached.dronesSource === dronesSource
    && cached.decoysSource === decoysSource
    && cached.bulletsSource === bulletsSource
    && cached.effectsSource === effectsSource) {
    room._visibilitySnapshotFilterCacheHits = (Number(room._visibilitySnapshotFilterCacheHits) || 0) + 1;
    return cached;
  }

  const visibleSet = state.visibleEntityIds;
  const drones = [];
  for (const drone of dronesSource) {
    const entity = room.drones?.get?.(drone.id);
    if (!entity) continue;
    if (isAlliedTo(room, teamId, entity) || visibleSet.has(drone.id)) drones.push(drone);
  }

  const decoys = [];
  for (const decoy of decoysSource) {
    const entity = room.decoys?.get?.(decoy.id) || decoy;
    if (isEntityVisibleAtPoint(room, teamId, state, entity, entity.radius || 0)) decoys.push(decoy);
  }

  const bullets = [];
  for (const bullet of bulletsSource) {
    if (isEntityVisibleAtPoint(room, teamId, state, bullet)) bullets.push(bullet);
  }

  const effects = [];
  for (const effect of effectsSource) {
    const hasPosition = Number.isFinite(Number(effect?.x)) && Number.isFinite(Number(effect?.y));
    if (!hasPosition || isEntityVisibleAtPoint(room, teamId, state, effect)) effects.push(effect);
  }

  const next = {
    generation: state.computedGeneration,
    dronesSource,
    decoysSource,
    bulletsSource,
    effectsSource,
    drones,
    decoys,
    bullets,
    effects
  };
  state.snapshotFilterCache = next;
  room._visibilitySnapshotFilterBuilds = (Number(room._visibilitySnapshotFilterBuilds) || 0) + 1;
  return next;
}

function filterSnapshotForPlayer(room, player, snapshot, now) {
  if (!usesSensorVisibility(room)) return { ...snapshot, contacts: [] };
  const teamId = teamIdForViewer(room, player);
  if (!teamId) return { ...snapshot, contacts: [] };

  const state = ensureTeamVisibility(room, teamId, now);
  const visibleSet = state.visibleEntityIds;
  const remembered = state.remembered;

  const ships = [];
  const contacts = [];

  for (const ship of snapshot.ships || []) {
    const entity = room.ships?.get?.(ship.id);
    if (!entity) continue;
    if (isAlliedTo(room, teamId, entity)) {
      ships.push(ship);
      continue;
    }
    if (visibleSet.has(ship.id)) {
      ships.push(ship);
    }
    // hidden: drop
  }
  for (const [id, contact] of remembered) {
    if (!visibleSet.has(id)) contacts.push(buildRememberedContactSnapshot(contact));
  }

  const shared = filterSharedTacticalEntities(room, teamId, snapshot, state);

  // Stations: always show location, but live details only if allied or visible.
  const stations = [];
  for (const station of snapshot.stations || []) {
    const roomStation = room.stationsById?.get?.(station.id)
      || room.stations?.find?.((entry) => entry.id === station.id);
    const isAllied = roomStation ? isAlliedTo(room, teamId, roomStation) : false;
    if (isAllied || visibleSet.has(station.id)) {
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
      // production queue, and `state` reads "unknown".
      const hiddenStation = {
        id: station.id,
        team: station.team,
        ownerId: station.ownerId,
        // Whether a relay has been captured is already public — it drives the
        // objective HUD, the relay chips and the victory condition — so masking
        // a neutral station as "unknown" would hide something the panel on the
        // right is showing anyway. Only the operational/disabled distinction is
        // withheld, because that is the part that reveals condition.
        state: station.state === "neutral" ? "neutral" : "unknown",
        revision: station.revision,
        weaponRange: station.weaponRange,
        conditionKnown: false,
        mapKnown: true
      };
      for (const key of [
        "stationType", "x", "y", "angle", "radius",
        "design", "hardpoints", "moduleScale", "weaponAngles", "weaponAnglePairs", "hangar"
      ]) {
        if (station[key] !== undefined) hiddenStation[key] = station[key];
      }
      stations.push(hiddenStation);
    }
  }

  const result = {
    ...snapshot,
    ships,
    drones: shared.drones,
    decoys: shared.decoys,
    bullets: shared.bullets,
    effects: shared.effects,
    stations,
    contacts
  };
  if (process.env.MFA_VISIBILITY_AUDIT) auditSnapshotForInformationLeaks(room, player, result, now);
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
  "wiringStatus", "switchgear", "powerProtection", "powerWiring", "powerWiringRuntime", "storageCharge"
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
