"use strict";

const { clampNumber, fastHypot } = require("./utils");
const { areAllies, areEnemies } = require("./combat");
const { selectOwnedLivingShips } = require("./selection");
const { WORLD_MARGIN } = require("./movementTuning");
const {
  navigationClearanceRadius,
  separationRadius
} = require("./movementCollision");
const { nearestClearPoint } = require("./movementNavigation");
const {
  ensureMovementRuntime,
  nextMovementCommandId,
  resetNavigation,
  resetStyleMemory,
  setManualRotation,
  setMovementCommand,
  syncMovementTarget
} = require("./movementRuntime");

function clearTargetReferences(ship) {
  ship.focusTargetId = null;
  ship.combatTargetId = null;
  ship.repairTargetId = null;
}

function commandRecord(id, type, destination = null, targetId = null, finalFacing = null) {
  return { id, type, destination, targetId, finalFacing };
}

function slotOffsets(count, spacing) {
  if (count <= 1) return [{ x: 0, y: 0 }];
  const columns = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / columns);
  const offsets = [];
  for (let index = 0; index < count; index += 1) {
    const col = index % columns;
    const row = Math.floor(index / columns);
    const entriesInRow = Math.min(columns, count - row * columns);
    offsets.push({
      x: (col - (entriesInRow - 1) / 2) * spacing,
      y: (row - (rows - 1) / 2) * spacing
    });
  }
  return offsets;
}

function slotDoesNotOverlap(point, radius, assigned) {
  return assigned.every((entry) =>
    fastHypot(point.x - entry.x, point.y - entry.y) >= radius + entry.radius + 4);
}

function clearNonOverlappingSlot(room, desired, ship, assigned, ordinal, spacing) {
  const radius = separationRadius(ship);
  for (let attempt = 0; attempt < 48; attempt += 1) {
    const ring = attempt === 0 ? 0 : Math.ceil(attempt / 8);
    const turn = attempt === 0 ? 0 : (attempt - 1) % 8;
    const angle = turn * Math.PI / 4 + ordinal * 0.173;
    const candidate = {
      x: desired.x + Math.cos(angle) * ring * spacing,
      y: desired.y + Math.sin(angle) * ring * spacing
    };
    const clear = nearestClearPoint(
      room,
      candidate.x,
      candidate.y,
      navigationClearanceRadius(ship)
    );
    if (!clear.clear || !slotDoesNotOverlap(clear, radius, assigned)) continue;
    return { x: clear.x, y: clear.y, radius };
  }
  return null;
}

function generateDestinationSlots(room, ships, destination) {
  const ordered = ships.slice().sort((a, b) =>
    String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
  const largestRadius = ordered.reduce(
    (largest, ship) => Math.max(largest, separationRadius(ship)),
    18
  );
  const spacing = largestRadius * 2 + 12;
  const offsets = slotOffsets(ordered.length, spacing);
  const assigned = [];
  const slots = new Map();
  for (let index = 0; index < ordered.length; index += 1) {
    const offset = offsets[index];
    const desired = {
      x: destination.x + offset.x,
      y: destination.y + offset.y
    };
    const slot = clearNonOverlappingSlot(
      room,
      desired,
      ordered[index],
      assigned,
      index,
      spacing
    );
    if (!slot) continue;
    assigned.push(slot);
    slots.set(ordered[index].id, { x: slot.x, y: slot.y });
  }
  return slots;
}

function setAttackCommand(ship, commandId, targetId) {
  clearTargetReferences(ship);
  ship.combatTargetId = targetId;
  ship.focusTargetId = targetId;
  resetStyleMemory(ship, ship.combatStyle);
  setMovementCommand(
    ship,
    commandRecord(`${commandId}:${ship.id}`, "attack", null, targetId, null)
  );
  syncMovementTarget(ship);
}

function setRepairCommand(ship, commandId, targetId) {
  clearTargetReferences(ship);
  ship.repairTargetId = targetId;
  resetStyleMemory(ship, ship.combatStyle);
  setMovementCommand(
    ship,
    commandRecord(`${commandId}:${ship.id}`, "repair", null, targetId, null)
  );
  syncMovementTarget(ship);
}

function setMoveCommand(ship, commandId, destination, finalFacing) {
  clearTargetReferences(ship);
  resetStyleMemory(ship, ship.combatStyle);
  setMovementCommand(
    ship,
    commandRecord(
      `${commandId}:${ship.id}`,
      "move",
      destination,
      null,
      Number.isFinite(finalFacing) ? finalFacing : null
    )
  );
  syncMovementTarget(ship);
}

function commandShips(room, player, x, y, options = {}) {
  const selected = selectOwnedLivingShips(player, options.shipIds);
  if (!selected.ok) return { ok: false, code: selected.code, commanded: 0 };
  const ships = selected.ships;
  if (ships.length === 0) return { ok: true, code: "none", commanded: 0 };

  const clickedTarget = options.targetId == null
    ? null
    : room.ships?.get(String(options.targetId));
  const livingTarget = clickedTarget?.alive ? clickedTarget : null;
  const selectedIds = new Set(ships.map((ship) => ship.id));
  const enemy = livingTarget
    && areEnemies(room, player?.id, livingTarget.ownerId);
  const ally = livingTarget
    && !selectedIds.has(livingTarget.id)
    && areAllies(room, player?.id, livingTarget.ownerId);
  const commandId = nextMovementCommandId(
    room,
    enemy ? "a" : (ally ? "r" : "m")
  );

  if (enemy) {
    for (const ship of ships) setAttackCommand(ship, commandId, livingTarget.id);
    return { ok: true, code: "attack", commanded: ships.length };
  }
  if (ally) {
    for (const ship of ships) setRepairCommand(ship, commandId, livingTarget.id);
    return { ok: true, code: "repair", commanded: ships.length };
  }

  const width = room?.world?.width || 2000;
  const height = room?.world?.height || 1600;
  const destination = {
    x: clampNumber(x, WORLD_MARGIN, width - WORLD_MARGIN),
    y: clampNumber(y, WORLD_MARGIN, height - WORLD_MARGIN)
  };
  const slots = generateDestinationSlots(room, ships, destination);
  let commanded = 0;
  for (const ship of ships) {
    const slot = slots.get(ship.id);
    if (!slot) {
      setMovementCommand(
        ship,
        commandRecord(`${commandId}:${ship.id}`, "stop", { x: ship.x, y: ship.y })
      );
      syncMovementTarget(ship);
      continue;
    }
    setMoveCommand(ship, commandId, slot, options.finalFacing);
    commanded += 1;
  }
  return {
    ok: true,
    code: commanded === ships.length ? "move" : "partial-move",
    commanded
  };
}

function commandShipsToAssignedSlots(room, ships, slots, options = {}) {
  const commandId = nextMovementCommandId(room, options.prefix || "m");
  let commanded = 0;
  for (const ship of ships || []) {
    if (!ship?.alive) continue;
    const slot = slots?.get(ship.id);
    if (!slot || !Number.isFinite(slot.x) || !Number.isFinite(slot.y)) continue;
    setMoveCommand(ship, commandId, { x: slot.x, y: slot.y }, options.finalFacing);
    commanded += 1;
  }
  return commanded;
}

function stopShips(room, player, shipIds) {
  const selected = selectOwnedLivingShips(player, shipIds);
  if (!selected.ok) return { ok: false, code: selected.code, commanded: 0 };
  const commandId = nextMovementCommandId(room, "s");
  for (const ship of selected.ships) {
    clearTargetReferences(ship);
    resetStyleMemory(ship, ship.combatStyle);
    setMovementCommand(
      ship,
      commandRecord(`${commandId}:${ship.id}`, "stop", { x: ship.x, y: ship.y })
    );
    syncMovementTarget(ship);
  }
  return { ok: true, code: "stop", commanded: selected.ships.length };
}

function rotateShips(room, player, options) {
  const direction = options?.direction;
  const active = options?.active;
  const shipIds = options?.shipIds;
  const selected = selectOwnedLivingShips(player, shipIds);
  if (!selected.ok) return { ok: false, code: selected.code, commanded: 0 };
  for (const ship of selected.ships) {
    if (!active) {
      setManualRotation(ship, null);
      continue;
    }
    setManualRotation(ship, direction);
    syncMovementTarget(ship);
  }
  return { ok: true, code: "rotate", commanded: selected.ships.length };
}

function applyCombatStyle(ship, combatStyle) {
  ship.combatStyle = combatStyle;
  const runtime = ensureMovementRuntime(ship);
  resetStyleMemory(ship, combatStyle);
  if (combatStyle === "sentry"
    && runtime.command?.type === "move"
    && runtime.phase !== "positioned") {
    runtime.style.sentryPosition = null;
  }
  resetNavigation(ship);
}

module.exports = {
  applyCombatStyle,
  commandShips,
  commandShipsToAssignedSlots,
  generateDestinationSlots,
  rotateShips,
  stopShips
};
