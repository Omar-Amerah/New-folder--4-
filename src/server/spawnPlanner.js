"use strict";

const { hashString } = require("./utils");
const DEFAULT_SHIP_RADIUS = 46;
const STARTER_SPACING = 96;
const MAX_FALLBACK_ATTEMPTS = 72;

function planSpawns(room, options = {}) {
  const players = [...(room.players?.values?.() || [])].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const world = room.world || { width: 5120, height: 3040 };
  const map = room.map || { asteroids: [], relays: [] };
  const seed = (options.seed ?? room.mapSeed ?? map.seed ?? 0) >>> 0;
  const reservations = [];
  const results = [];
  const attempts = [];
  for (const player of players) {
    const reservedRadius = reservationRadius(player, options);
    const preferred = preferredSlots(world, room.rules?.gameMode === "solo", player, players, seed, reservedRadius);
    let placed = null;
    for (const slot of preferred) {
      attempts.push({ playerId: player.id, x: round(slot.x), y: round(slot.y), angle: round(slot.angle), reason: slot.reason });
      const adjusted = findLegalSlot(slot, reservedRadius, world, map, reservations, player, players, room, attempts);
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

function getPlannedSpawn(room, playerId) {
  if (!room.__spawnPlan || room.__spawnPlanKey !== planKey(room)) {
    room.__spawnPlan = planSpawns(room);
    room.__spawnPlanKey = planKey(room);
  }
  return room.__spawnPlan.find((spawn) => spawn.playerId === playerId) || { x: room.world.width / 2, y: room.world.height / 2, angle: 0, reservedRadius: 180 };
}

function planKey(room) {
  return JSON.stringify({ seed: room.mapSeed || room.map?.seed || 0, ids: [...room.players.values()].map((p) => [p.id, p.team, p.shipCap, p.stats?.radius]).sort() });
}

function reservationRadius(player, options = {}) {
  const radius = Math.max(DEFAULT_SHIP_RADIUS, options.shipRadius || player.stats?.radius || DEFAULT_SHIP_RADIUS);
  const count = Math.max(1, Math.min(30, options.starterQuantity || player.stats?.fleetCount || 1));
  return Math.ceil(radius + STARTER_SPACING * Math.sqrt(count));
}

function preferredSlots(world, solo, player, players, seed, radius) {
  const ids = players.map((p) => p.id).sort();
  const byTeam = new Map();
  for (const p of players) {
    const key = solo ? p.id : (p.team === "red" || p.team === "blue" ? p.team : p.id);
    if (!byTeam.has(key)) byTeam.set(key, []);
    byTeam.get(key).push(p);
  }
  for (const group of byTeam.values()) group.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const teamKey = solo ? player.id : (player.team === "red" || player.team === "blue" ? player.team : player.id);
  const group = byTeam.get(teamKey) || [player];
  const index = group.findIndex((p) => p.id === player.id);
  const count = group.length;
  if (!solo && (teamKey === "blue" || teamKey === "red")) {
    const left = teamKey === "blue";
    const x = left ? radius + 80 : world.width - radius - 80;
    const minY = radius + 80;
    const maxY = world.height - radius - 80;
    const y = count === 1 ? world.height / 2 : minY + (maxY - minY) * (index / (count - 1));
    return jitteredLine(x, y, left ? 0 : Math.PI, seed, player.id, radius, world, left ? "blue-side" : "red-side");
  }
  const soloIndex = ids.indexOf(player.id);
  const angle = -Math.PI + (2 * Math.PI * (soloIndex + 0.5)) / Math.max(1, ids.length);
  const sectorRadiusX = world.width * 0.5 - radius - 120;
  const sectorRadiusY = world.height * 0.5 - radius - 120;
  const x = world.width / 2 + Math.cos(angle) * sectorRadiusX * 0.72;
  const y = world.height / 2 + Math.sin(angle) * sectorRadiusY * 0.72;
  return jitteredLine(x, y, angle + Math.PI, seed, player.id, radius, world, "solo-sector");
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

function findLegalSlot(slot, radius, world, map, reservations, player, players, room, attempts) {
  const candidates = [slot];
  for (let i = 0; i < MAX_FALLBACK_ATTEMPTS; i += 1) {
    const ring = 1 + Math.floor(i / 12);
    const theta = (i % 12) * Math.PI / 6;
    candidates.push({ ...slot, x: slot.x + Math.cos(theta) * ring * radius * 0.55, y: slot.y + Math.sin(theta) * ring * radius * 0.55, adjusted: true });
  }
  for (let i = 0; i < candidates.length; i += 1) {
    const c = candidates[i];
    if (!inOwnSector(c, radius, world, player, players, room)) continue;
    if (isLegal(c, radius, world, map, reservations)) return { ...c, attempts: i + 1 };
  }
  return null;
}

function inOwnSector(c, radius, world, player, players, room) {
  if (room.rules?.gameMode === "solo") return c.x >= radius && c.x <= world.width - radius && c.y >= radius && c.y <= world.height - radius;
  if (player.team === "blue") return c.x <= world.width * 0.42;
  if (player.team === "red") return c.x >= world.width * 0.58;
  return true;
}
function isLegal(c, radius, world, map, reservations) {
  if (c.x < radius || c.x > world.width - radius || c.y < radius || c.y > world.height - radius) return false;
  for (const r of reservations) if (Math.hypot(c.x - r.x, c.y - r.y) < radius + r.radius) return false;
  for (const a of map.asteroids || []) if (Math.hypot(c.x - a.x, c.y - a.y) < radius + (a.radius || 0) + 24) return false;
  for (const relay of map.relays || []) if (Math.hypot(c.x - relay.x, c.y - relay.y) < radius + (relay.radius || 0) + 32) return false;
  return true;
}
function summarizeTeams(players) { return players.map((p) => ({ id: p.id, team: p.team, bot: !!p.isBot })); }
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function round(v) { return Math.round(v * 100) / 100; }
module.exports = { planSpawns, getPlannedSpawn, reservationRadius };
