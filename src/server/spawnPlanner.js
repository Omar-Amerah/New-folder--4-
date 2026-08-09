"use strict";

const { hashString, compareEntityIds, compareIdStrings } = require("./utils");
const { TEAM_COLORS, MAP_CLEARANCES, WORLD } = require("./config");
const { validateRelaySpawnGeometry } = require("./mapFairness");
const DEFAULT_SHIP_RADIUS = 46;
const STARTER_SPACING = 96;
const SPAWN_RESERVATION_HULL_COUNT = 1;
const MAX_FALLBACK_ATTEMPTS = 72;
// Four world units is enough to avoid floating-point re-contact without
// turning launch placement into an artificial wide-spread formation.
const SHIP_SPAWN_MARGIN = 4;
const SHIP_SPAWN_RESERVATION_TTL_MS = 5000;
const SHIP_SPAWN_MAX_RINGS = 24;
const WORLD_MARGIN = 42;
const DIAGNOSTIC_KEYS = [
  "spawnPlacementAttempts", "spawnPlacementSuccesses", "spawnPlacementFailures",
  "spawnCandidatesRejectedByAsteroid", "spawnCandidatesRejectedByWorld",
  "spawnCandidatesRejectedByShip", "spawnCandidatesRejectedByReservation",
  "spawnReservationsCreated", "spawnReservationsReleased", "spawnOverlapDetected",
  "shipCollisionPairs", "shipCollisionPenetrationCorrected", "spawnShipsPushedAside"
];

function diagnostics(room) {
  const counters = room.spawnCollisionDiagnostics || (room.spawnCollisionDiagnostics = {});
  if (!counters._initialized) {
    for (const key of DIAGNOSTIC_KEYS) if (!Number.isFinite(counters[key])) counters[key] = 0;
    Object.defineProperty(counters, "_initialized", { value: true, enumerable: false, configurable: true });
  }
  return counters;
}

function bump(room, key, amount = 1) {
  const counters = diagnostics(room);
  counters[key] = (counters[key] || 0) + amount;
}

function authoritativePhysicalRadius(value) {
  if (Number.isFinite(Number(value)) && typeof value !== "object") return Math.max(18, Number(value));
  const radius = Number(value?.physicalRadius ?? value?.stats?.physicalRadius);
  if (Number.isFinite(radius) && radius > 0) return radius;
  const visualRadius = Number(value?.radius ?? value?.stats?.radius ?? value);
  return Math.max(18, (Number.isFinite(visualRadius) ? visualRadius : DEFAULT_SHIP_RADIUS) * 0.56);
}

function expireSpawnReservations(room, now = Date.now()) {
  const source = Array.isArray(room.spawnReservations) ? room.spawnReservations : [];
  if (source.length === 0) {
    room.spawnReservations = source;
    return source;
  }
  let write = 0;
  for (let i = 0; i < source.length; i += 1) {
    const reservation = source[i];
    if (reservation && Number(reservation.expiresAt) > now) source[write++] = reservation;
    else bump(room, "spawnReservationsReleased");
  }
  source.length = write;
  return source;
}

function createSpawnReservations(room, playerId, requestId, placements, now = Date.now()) {
  const active = expireSpawnReservations(room, now);
  const created = placements.map((placement, index) => ({
    id: `${String(requestId)}:${index}`,
    playerId,
    requestId: String(requestId),
    x: placement.x,
    y: placement.y,
    radius: placement.physicalRadius,
    physicalRadius: placement.physicalRadius,
    createdAt: now,
    expiresAt: now + SHIP_SPAWN_RESERVATION_TTL_MS
  }));
  active.push(...created);
  bump(room, "spawnReservationsCreated", created.length);
  return created;
}

function releaseSpawnReservations(room, reservations) {
  if (!Array.isArray(reservations) || reservations.length === 0) return;
  const ids = new Set(reservations.map((reservation) => reservation.id));
  const active = Array.isArray(room.spawnReservations) ? room.spawnReservations : [];
  let write = 0;
  let released = 0;
  for (let i = 0; i < active.length; i += 1) {
    if (ids.has(active[i]?.id)) released += 1;
    else active[write++] = active[i];
  }
  active.length = write;
  bump(room, "spawnReservationsReleased", released);
}

function candidateBlockReason(room, x, y, physicalRadius, reservations, ignoredReservationIds, ignoredShips) {
  const world = room.world || WORLD;
  const edge = WORLD_MARGIN + physicalRadius;
  if (x < edge || x > world.width - edge || y < edge || y > world.height - edge) return "world";

  const asteroidScratch = room._spawnAsteroidScratch || (room._spawnAsteroidScratch = []);
  const asteroids = room.spatialIndex?.dynamicValid && room.spatialIndex.queryRangeUnordered
    ? room.spatialIndex.queryRangeUnordered("asteroids", x, y, physicalRadius + 512, asteroidScratch)
    : (room.map?.asteroids || []);
  for (const asteroid of asteroids) {
    if (!asteroid) continue;
    const minimum = physicalRadius + Math.max(0, Number(asteroid.radius) || 0) + SHIP_SPAWN_MARGIN;
    if ((x - asteroid.x) ** 2 + (y - asteroid.y) ** 2 < minimum * minimum) return "asteroid";
  }

  // The index is a fast first pass, but room.ships remains authoritative:
  // freshly inserted ships may not have reached the current index yet.
  const checked = new Set();
  const shipScratch = room._spawnShipScratch || (room._spawnShipScratch = []);
  const indexed = room.spatialIndex?.dynamicValid && room.spatialIndex.queryRangeUnordered
    ? room.spatialIndex.queryRangeUnordered("ships", x, y, physicalRadius + 192, shipScratch)
    : [];
  const sources = [indexed, room.ships?.values?.() || []];
  for (const source of sources) {
    for (const ship of source) {
      if (!ship?.alive || checked.has(ship) || ignoredShips?.has(ship)) continue;
      checked.add(ship);
      const minimum = physicalRadius + authoritativePhysicalRadius(ship) + SHIP_SPAWN_MARGIN;
      if ((x - ship.x) ** 2 + (y - ship.y) ** 2 < minimum * minimum) return "ship";
    }
  }

  const allReservations = [];
  if (Array.isArray(room.spawnReservations)) allReservations.push(...room.spawnReservations);
  if (Array.isArray(reservations)) allReservations.push(...reservations);
  const seen = new Set();
  for (const reservation of allReservations) {
    if (!reservation || ignoredReservationIds?.has(reservation.id) || seen.has(reservation)) continue;
    seen.add(reservation);
    const minimum = physicalRadius + authoritativePhysicalRadius(reservation) + SHIP_SPAWN_MARGIN;
    if ((x - reservation.x) ** 2 + (y - reservation.y) ** 2 < minimum * minimum) return "reservation";
  }
  return null;
}

function findClearShipSpawnPoint(room, options = {}) {
  const physicalRadius = authoritativePhysicalRadius(options.physicalRadius);
  const navigationRadius = Math.max(physicalRadius, Number(options.navigationRadius) || physicalRadius);
  const preferredX = Number.isFinite(Number(options.preferredX)) ? Number(options.preferredX) : room.world.width / 2;
  const preferredY = Number.isFinite(Number(options.preferredY)) ? Number(options.preferredY) : room.world.height / 2;
  const seed = hashString(`${room.mapSeed || room.map?.seed || 0}:${options.ownerId || ""}:${options.requestId || ""}:${options.shipIndex || 0}`);
  const phase = ((seed >>> 0) / 0x100000000) * Math.PI * 2 + (Number(options.spawnAngle) || 0);
  const step = Math.max(physicalRadius * 2 + SHIP_SPAWN_MARGIN + 0.5, navigationRadius * 1.5);
  const reservations = options.reservations || [];
  const ignored = options.ignoredReservationIds || null;
  let attempts = 0;
  let lastReason = "no-clear-spawn";

  for (let ring = 0; ring <= SHIP_SPAWN_MAX_RINGS; ring += 1) {
    const ringRadius = ring * step;
    const samples = ring === 0 ? 1 : Math.max(8, Math.ceil((Math.PI * 2 * ringRadius) / step));
    for (let sample = 0; sample < samples; sample += 1) {
      const angle = ring === 0 ? phase : phase + (sample * Math.PI * 2) / samples;
      const x = preferredX + Math.cos(angle) * ringRadius;
      const y = preferredY + Math.sin(angle) * ringRadius;
      attempts += 1;
      bump(room, "spawnPlacementAttempts");
      const reason = candidateBlockReason(room, x, y, physicalRadius, reservations, ignored, options.ignoredShips);
      if (!reason) {
        bump(room, "spawnPlacementSuccesses");
        return { ok: true, x: round(x), y: round(y), attempts, adjusted: ring !== 0, reason: ring === 0 ? "preferred-clear" : "outward-search", physicalRadius };
      }
      lastReason = reason;
      const counter = reason === "world" ? "spawnCandidatesRejectedByWorld"
        : reason === "asteroid" ? "spawnCandidatesRejectedByAsteroid"
          : reason === "ship" ? "spawnCandidatesRejectedByShip"
            : "spawnCandidatesRejectedByReservation";
      bump(room, counter);
    }
  }
  bump(room, "spawnPlacementFailures");
  return { ok: false, reason: "no-clear-spawn", blockedBy: lastReason, attempts };
}

function planShipSpawns(room, options = {}) {
  expireSpawnReservations(room, options.now);
  const placements = [];
  const count = Math.max(1, Number(options.count) || 1);
  for (let i = 0; i < count; i += 1) {
    const radius = Array.isArray(options.physicalRadii) ? options.physicalRadii[i] : options.physicalRadius;
    const result = findClearShipSpawnPoint(room, {
      ...options,
      physicalRadius: radius,
      shipIndex: i,
      reservations: placements
    });
    if (!result.ok) return result;
    placements.push({ ...result, radius: result.physicalRadius });
  }
  return { ok: true, placements, attempts: placements.reduce((sum, placement) => sum + placement.attempts, 0) };
}

function assertNoShipOverlap(room, ship, ignored = null) {
  for (const other of room.ships?.values?.() || []) {
    if (!other?.alive || other === ship || ignored?.has(other)) continue;
    const minimum = authoritativePhysicalRadius(ship) + authoritativePhysicalRadius(other);
    if ((ship.x - other.x) ** 2 + (ship.y - other.y) ** 2 < minimum * minimum - 1e-6) {
      bump(room, "spawnOverlapDetected");
      throw new Error(`Spawn overlap: ${ship.id} and ${other.id}`);
    }
  }
  return true;
}

function pushShipsOutOfSpawn(room, options = {}) {
  const physicalRadius = authoritativePhysicalRadius(options.physicalRadius);
  const preferredX = Number(options.preferredX);
  const preferredY = Number(options.preferredY);
  if (!Number.isFinite(preferredX) || !Number.isFinite(preferredY)) {
    return { ok: false, reason: "invalid-spawn" };
  }

  const liveShips = [...(room.ships?.values?.() || [])]
    .filter((ship) => ship?.alive)
    .sort(compareEntityIds);
  const blockers = liveShips.filter((ship) => {
    const minimum = physicalRadius + authoritativePhysicalRadius(ship) + SHIP_SPAWN_MARGIN;
    return (ship.x - preferredX) ** 2 + (ship.y - preferredY) ** 2 < minimum * minimum;
  });
  if (blockers.length === 0) return { ok: true, moved: [] };

  // Never force a launch point through a wall or asteroid. This override is
  // specifically for ship crowding; static geometry remains authoritative.
  const staticReason = candidateBlockReason(
    room, preferredX, preferredY, physicalRadius, [], null, new Set(liveShips)
  );
  if (staticReason) return { ok: false, reason: staticReason };

  const moved = [];
  const reserved = [{ x: preferredX, y: preferredY, radius: physicalRadius, physicalRadius, id: "launch-centre" }];
  for (let index = 0; index < blockers.length; index += 1) {
    const blocker = blockers[index];
    let dx = blocker.x - preferredX;
    let dy = blocker.y - preferredY;
    let distance = Math.hypot(dx, dy);
    if (distance < 0.001) {
      const angle = ((hashString(`${options.requestId || ""}:${blocker.id}`) >>> 0) / 0x100000000) * Math.PI * 2;
      dx = Math.cos(angle);
      dy = Math.sin(angle);
      distance = 1;
    }
    const blockerRadius = authoritativePhysicalRadius(blocker);
    const minimumDistance = physicalRadius + blockerRadius + SHIP_SPAWN_MARGIN + 0.5;
    const desiredDistance = Math.max(distance, minimumDistance);
    const result = findClearShipSpawnPoint(room, {
      preferredX: preferredX + dx / distance * desiredDistance,
      preferredY: preferredY + dy / distance * desiredDistance,
      physicalRadius: blockerRadius,
      navigationRadius: blockerRadius + 8,
      reservations: reserved,
      ignoredShips: new Set([blocker]),
      ownerId: blocker.ownerId,
      requestId: `push:${options.requestId || ""}:${blocker.id}`,
      shipIndex: index,
      spawnAngle: Math.atan2(dy, dx)
    });
    if (!result.ok) {
      rollbackPushedShips(moved);
      return { ok: false, reason: "no-clear-push-space" };
    }
    moved.push({
      ship: blocker,
      x: blocker.x,
      y: blocker.y,
      targetX: blocker.targetX,
      targetY: blocker.targetY,
      collisionCorrectionX: blocker._collisionCorrectionX,
      collisionCorrectionY: blocker._collisionCorrectionY
    });
    blocker.x = result.x;
    blocker.y = result.y;
    const movement = blocker.movement;
    const movementCommand = movement?.command;
    if (!movementCommand
      || movementCommand.type === "stop"
      || movement?.phase === "idle"
      || movement?.phase === "positioned") {
      blocker.targetX = result.x;
      blocker.targetY = result.y;
    }
    blocker._collisionCorrectionX = (blocker._collisionCorrectionX || 0) + result.x - moved[moved.length - 1].x;
    blocker._collisionCorrectionY = (blocker._collisionCorrectionY || 0) + result.y - moved[moved.length - 1].y;
    reserved.push({ x: result.x, y: result.y, radius: blockerRadius, physicalRadius: blockerRadius, id: `pushed:${blocker.id}` });
  }
  bump(room, "spawnShipsPushedAside", moved.length);
  return { ok: true, moved };
}

function rollbackPushedShips(moved) {
  for (const entry of moved || []) {
    entry.ship.x = entry.x;
    entry.ship.y = entry.y;
    entry.ship.targetX = entry.targetX;
    entry.ship.targetY = entry.targetY;
    entry.ship._collisionCorrectionX = entry.collisionCorrectionX;
    entry.ship._collisionCorrectionY = entry.collisionCorrectionY;
  }
}

function planSpawns(room, options = {}) {
  const players = [...(room.players?.values?.() || [])].sort((a, b) => compareIdStrings(a.id, b.id));
  const world = room.world || WORLD;
  const map = room.map || { asteroids: [], relays: [] };
  const seed = (options.seed ?? room.mapSeed ?? map.seed ?? 0) >>> 0;
  const reservations = [];
  const results = [];
  const attempts = [];
  // Slots are spaced against each other by the player's own reservation radius,
  // but held off the world edge by whichever is larger — that radius or the
  // footprint of the home station that will be planted on the region centre.
  const regionRadius = stationRegionRadius(room);
  for (const player of players) {
    const reservedRadius = reservationRadius(player, options);
    const edgeRadius = Math.max(reservedRadius, regionRadius);
    const preferred = preferredSlots(world, room.rules?.gameMode === "solo", player, players, seed, reservedRadius, edgeRadius);
    let placed = null;
    for (const slot of preferred) {
      attempts.push({ playerId: player.id, x: round(slot.x), y: round(slot.y), angle: round(slot.angle), reason: slot.reason });
      const adjusted = findLegalSlot(slot, reservedRadius, edgeRadius, world, map, reservations, player, players, room, attempts);
      if (adjusted) {
        placed = adjusted;
        break;
      }
    }
    if (!placed) {
      const detail = JSON.stringify({ seed, playerIds: players.map((p) => p.id), teams: summarizeTeams(players), attempts }, null, 2);
      throw new Error(`Unable to plan legal spawn. ${detail}`);
    }
    reservations.push({ x: placed.x, y: placed.y, radius: reservedRadius, playerId: player.id });
    results.push({ playerId: player.id, x: round(placed.x), y: round(placed.y), angle: placed.angle, reservedRadius, valid: true, adjusted: !!placed.adjusted, attempts: placed.attempts || 1 });
  }
  return results;
}

function planSpawnRegions(room, options = {}) {
  const spawns = planSpawns(room, options);
  const players = new Map([...(room.players?.values?.() || [])].map((p) => [p.id, p]));
  const solo = room.rules?.gameMode === "solo";
  const groups = new Map();
  // One region per TEAM, not per player. A team shares a single home station
  // and central launch path, so drawing a separate circle around every team-
  // mate's planned slot left several bases on the map with the station sitting
  // in only one of them. Solo players still each get their own.
  for (const spawn of spawns) {
    const player = players.get(spawn.playerId);
    const team = normalizeTeam(player?.team) || player?.team;
    const key = solo ? `player:${spawn.playerId}` : `team:${team || spawn.playerId}`;
    if (!groups.has(key)) groups.set(key, { ownerId: solo ? spawn.playerId : null, team: solo ? null : team, spawns: [] });
    groups.get(key).spawns.push(spawn);
  }
  const safeZones = [];
  for (const group of groups.values()) {
    const cx = group.spawns.reduce((sum, s) => sum + s.x, 0) / group.spawns.length;
    const cy = group.spawns.reduce((sum, s) => sum + s.y, 0) / group.spawns.length;
    let radius = 0;
    for (const s of group.spawns) radius = Math.max(radius, Math.hypot(s.x - cx, s.y - cy) + s.reservedRadius);
    // In station mode the home station is planted at this centre, so the region
    // has to be able to hold the structure as well as the starting hulls.
    radius = Math.max(radius, stationRegionRadius(room));
    const world = room.world || WORLD;
    const ownerPlayer = group.ownerId ? players.get(group.ownerId) : players.get(group.spawns[0].playerId);
    const borderColor = solo
      ? (ownerPlayer?.color || "#ffffff")
      : (TEAM_COLORS[group.team] || "#ffffff");
    const fillColor = ownerPlayer?.color || borderColor;
    const zone = {
      id: group.ownerId ? `spawn-player-${group.ownerId}` : `spawn-team-${group.team}`,
      x: clamp(round(cx), radius, world.width - radius),
      y: clamp(round(cy), radius, world.height - radius),
      radius,
      color: hexToRgba(fillColor, 0.06),
      borderColor,
      isSpawn: true,
      spawnPlayerIds: group.spawns.map((s) => s.playerId).sort()
    };
    if (group.ownerId) zone.ownerId = group.ownerId;
    if (group.team) zone.team = group.team;
    if (!zoneInsideWorld(zone, room.world || WORLD)) { throw new Error(`Unable to plan legal spawn safe zone: ${zone.id} outside world bounds`); }
    safeZones.push(zone);
  }
  for (let i = 0; i < safeZones.length; i += 1) for (let j = i + 1; j < safeZones.length; j += 1) {
    const a = safeZones[i], b = safeZones[j];
    if (Math.hypot(a.x - b.x, a.y - b.y) < a.radius + b.radius) throw new Error(`Unable to plan legal spawn safe zones: ${a.id} overlaps ${b.id}`);
  }
  // A live generated map must remain legal if a pre-match roster change asks
  // for a fresh spawn plan. Hand-built unit fixtures intentionally omit
  // map.generation and continue to test slot mechanics without terrain rules.
  if (room.map?.generation && room.map?.relays?.length) {
    const relativeErrors = validateRelaySpawnGeometry(room.map.relays, safeZones, room.world || WORLD, MAP_CLEARANCES);
    if (relativeErrors.length) throw new Error(`Unable to plan legal spawn safe zone: ${relativeErrors[0].message}`);
  }
  return { spawns, safeZones, key: planKey(room) };
}

// The radius a spawn region needs to contain a home station. Zero outside
// station mode, where no structure is planted at the region centre. Read from
// the authored template so the two can never drift apart.
function stationRegionRadius(room) {
  if (room?.rules?.infrastructureMode !== "stations") return 0;
  const { buildHomeStationGeometry } = require("./stationTemplates");
  const shell = buildHomeStationGeometry().shell;
  return Math.hypot(shell.maxX - shell.minX, shell.maxY - shell.minY) / 2 + 40;
}

function getSpawnRegionPlan(room) {
  // Once combat starts, roster changes must not move the surviving players'
  // bases. The frozen plan may retain an unused entry for a departed player;
  // that is intentional and keeps every other assignment stable.
  if (room.__spawnPlanFrozen && room.__spawnRegionPlan) return room.__spawnRegionPlan;
  if (!room.__spawnRegionPlan || room.__spawnPlanKey !== planKey(room)) {
    room.__spawnRegionPlan = planSpawnRegions(room);
    room.__spawnPlan = room.__spawnRegionPlan.spawns;
    room.__spawnPlanKey = room.__spawnRegionPlan.key;
  }
  return room.__spawnRegionPlan;
}

function freezeSpawnPlan(room) {
  if (!room) return null;
  // Resolve once against the complete finalized roster before enabling the
  // freeze. getSpawnRegionPlan can therefore still refresh a stale design plan.
  const plan = getSpawnRegionPlan(room);
  room.__spawnPlanFrozen = true;
  return plan;
}

function getPlannedSpawn(room, playerId) {
  return getSpawnRegionPlan(room).spawns.find((spawn) => spawn.playerId === playerId) || { x: room.world.width / 2, y: room.world.height / 2, angle: 0, reservedRadius: 180 };
}

function planKey(room) {
  return JSON.stringify({ seed: room.mapSeed || room.map?.seed || 0, mode: room.rules?.gameMode, world: [room.world?.width, room.world?.height], ids: [...room.players.values()].map((p) => [p.id, p.team, p.stats?.radius, p.isBot]).sort() });
}

function invalidateSpawnPlan(room) {
  if (!room) return;
  delete room.__spawnPlan;
  delete room.__spawnRegionPlan;
  delete room.__spawnPlanKey;
  delete room.__spawnPlanFrozen;
}

function reservationRadius(player, options = {}) {
  const radius = Math.max(DEFAULT_SHIP_RADIUS, options.shipRadius || player.stats?.radius || DEFAULT_SHIP_RADIUS);
  return Math.ceil(radius + STARTER_SPACING * Math.sqrt(SPAWN_RESERVATION_HULL_COUNT));
}

function preferredSlots(world, solo, player, players, seed, radius, edgeRadius = radius) {
  const ids = players.map((p) => p.id).sort();
  const byTeam = new Map();
  for (const p of players) {
    const team = normalizeTeam(p.team);
    const key = solo ? p.id : (team || p.id);
    if (!byTeam.has(key)) byTeam.set(key, []);
    byTeam.get(key).push(p);
  }
  for (const group of byTeam.values()) group.sort((a, b) => compareIdStrings(a.id, b.id));
  const teamKey = solo ? player.id : (normalizeTeam(player.team) || player.id);
  const group = byTeam.get(teamKey) || [player];
  const index = group.findIndex((p) => p.id === player.id);
  const count = group.length;
  if (!solo && (teamKey === "blue" || teamKey === "red")) {
    const left = teamKey === "blue";
    const groupRadius = Math.max(edgeRadius, count * radius + 20 * (count - 1));
    const x = left ? groupRadius + 80 : world.width - groupRadius - 80;
    const minY = edgeRadius + 80;
    const maxY = world.height - edgeRadius - 80;
    // Team-mates cluster around one base rather than being strung out along the
    // whole side of the map. They share a home station, so their slots have to
    // sit close enough together that a single safe zone covers all of them and
    // the station lands in the middle of it.
    const spacing = radius * 2 + 40;
    const y = clamp(world.height / 2 + (index - (count - 1) / 2) * spacing, minY, maxY);
    return jitteredLine(x, y, left ? 0 : Math.PI, seed, player.id, edgeRadius, world, left ? "blue-side" : "red-side");
  }
  const soloIndex = ids.indexOf(player.id);
  // Small station arenas need the diagonal corners: their 840u home shell and
  // relay clearance cannot both fit when two or four solo regions are placed on
  // a cardinal ring. Corner sectors remain symmetric and leave a central relay
  // plus its forward-clearance corridor available.
  if (ids.length >= 2 && ids.length <= 4 && world.width <= 6400) {
    const inset = edgeRadius + 80;
    const positions = ids.length === 2
      ? [[inset, inset], [world.width - inset, world.height - inset]]
      : [
        [inset, inset],
        [world.width - inset, inset],
        [world.width - inset, world.height - inset],
        [inset, world.height - inset]
      ];
    const [x, y] = positions[Math.max(0, soloIndex) % positions.length];
    const angle = Math.atan2(world.height / 2 - y, world.width / 2 - x);
    return jitteredLine(x, y, angle, seed, player.id, edgeRadius, world, "solo-corner");
  }
  // Larger arenas retain the circular solo layout. Two-player rooms use the
  // short axis here so the long axis remains available for relay symmetry.
  const phase = ids.length === 2 ? 0 : ids.length === 4 ? -Math.PI / 4 : 0;
  const angle = -Math.PI + phase + (2 * Math.PI * (soloIndex + 0.5)) / Math.max(1, ids.length);
  // Solo fairness is measured in world units. A normalized ellipse made the
  // side spawns much farther from the centre than the top/bottom spawns on a
  // widescreen arena, so a central relay could never be equally reachable.
  // Keep the actual spawn ring circular and leave a deterministic station-sized
  // margin to the world edge.
  const ringRadius = Math.max(0, Math.min(world.width, world.height) * 0.5 - edgeRadius - 80);
  const x = world.width / 2 + Math.cos(angle) * ringRadius;
  const y = world.height / 2 + Math.sin(angle) * ringRadius;
  return jitteredLine(x, y, angle + Math.PI, seed, player.id, edgeRadius, world, "solo-sector");
}

function jitteredLine(x, y, angle, seed, id, radius, world, reason) {
  const slots = [{ x, y, angle, reason }];
  const h = hashString(`${seed}:${id}`);
  for (let i = 1; i <= 8; i += 1) {
    const sign = i % 2 ? 1 : -1;
    const dist = Math.ceil(i / 2) * radius * 0.42;
    slots.push({ x: x + Math.cos(angle + Math.PI / 2) * dist * sign + ((h % 17) - 8), y: y + Math.sin(angle + Math.PI / 2) * dist * sign + (((h >>> 5) % 17) - 8), angle, reason: `${reason}-fallback` });
  }
  return slots.map((s) => ({ ...s, x: clamp(s.x, radius, world.width - radius), y: clamp(s.y, radius, world.height - radius) }));
}

function findLegalSlot(slot, radius, edgeRadius, world, map, reservations, player, players, room, attempts) {
  const candidates = [slot];
  for (let i = 0; i < MAX_FALLBACK_ATTEMPTS; i += 1) {
    const ring = 1 + Math.floor(i / 12);
    const theta = (i % 12) * Math.PI / 6;
    candidates.push({ ...slot, x: slot.x + Math.cos(theta) * ring * radius * 0.55, y: slot.y + Math.sin(theta) * ring * radius * 0.55, adjusted: true });
  }
  for (let i = 0; i < candidates.length; i += 1) {
    const c = candidates[i];
    if (!inOwnSector(c, radius, world, player, players, room)) continue;
    if (isLegal(c, radius, edgeRadius, world, map, reservations)) return { ...c, attempts: i + 1 };
  }
  return null;
}

function inOwnSector(c, radius, world, player, players, room) {
  if (room.rules?.gameMode === "solo") return c.x >= radius && c.x <= world.width - radius && c.y >= radius && c.y <= world.height - radius;
  const team = normalizeTeam(player.team);
  if (team === "blue") return c.x <= world.width * 0.42;
  if (team === "red") return c.x >= world.width * 0.58;
  return true;
}
function isLegal(c, radius, edgeRadius, world, map, reservations) {
  // The world margin uses edgeRadius so the safe zone this slot ends up inside —
  // which in station mode has to hold the home station — cannot fall off the map.
  if (c.x < edgeRadius || c.x > world.width - edgeRadius || c.y < edgeRadius || c.y > world.height - edgeRadius) return false;
  for (const r of reservations) if (Math.hypot(c.x - r.x, c.y - r.y) < radius + r.radius) return false;
  // In station mode the slot is also the centre of a protected station region.
  // Reserve map objects against that larger region, not only against the
  // starter hull, so the later safe-zone validation cannot reject a plan that
  // the slot solver had considered legal.
  const regionFootprint = Math.max(radius, edgeRadius);
  for (const a of map.asteroids || []) if (Math.hypot(c.x - a.x, c.y - a.y) < regionFootprint + (a.radius || 0) + MAP_CLEARANCES.asteroidToSpawnSlot) return false;
  for (const relay of map.relays || []) if (Math.hypot(c.x - relay.x, c.y - relay.y) < regionFootprint + (relay.radius || 0) + MAP_CLEARANCES.relayToSafeZone) return false;
  return true;
}
function summarizeTeams(players) { return players.map((p) => ({ id: p.id, team: p.team, bot: !!p.isBot })); }
function normalizeTeam(team) { if (team === "blue" || team === 0 || team === "0") return "blue"; if (team === "red" || team === 1 || team === "1") return "red"; return null; }
function hexToRgba(hex, alpha) { const h = hex.replace("#", ""); const r = parseInt(h.substring(0, 2), 16); const g = parseInt(h.substring(2, 4), 16); const b = parseInt(h.substring(4, 6), 16); return `rgba(${r},${g},${b},${alpha})`; }
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function round(v) { return Math.round(v * 100) / 100; }
function zoneInsideWorld(zone, world) { return zone.x - zone.radius >= 0 && zone.x + zone.radius <= world.width && zone.y - zone.radius >= 0 && zone.y + zone.radius <= world.height; }
module.exports = {
  planSpawns, planSpawnRegions, getSpawnRegionPlan, freezeSpawnPlan, getPlannedSpawn,
  reservationRadius, invalidateSpawnPlan, authoritativePhysicalRadius,
  findClearShipSpawnPoint, planShipSpawns, createSpawnReservations,
  releaseSpawnReservations, expireSpawnReservations, assertNoShipOverlap,
  pushShipsOutOfSpawn, rollbackPushedShips,
  SHIP_SPAWN_MARGIN, SHIP_SPAWN_RESERVATION_TTL_MS
};
