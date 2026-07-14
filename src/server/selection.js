// Shared authoritative selected-ship normalization for player-owned fleet commands.

const MAX_SELECTED_SHIP_IDS = 64;

function normalizeSelectedShipIds(shipIds, options = {}) {
  const allowOmittedAll = options.allowOmittedAll !== false;
  if (shipIds === undefined || shipIds === null) {
    return { ok: true, explicit: false, all: allowOmittedAll, ids: null, code: allowOmittedAll ? "all-owned" : "no-selection" };
  }
  if (!Array.isArray(shipIds)) return { ok: false, explicit: true, all: false, ids: new Set(), code: "malformed-ship-ids" };
  if (shipIds.length > MAX_SELECTED_SHIP_IDS) return { ok: false, explicit: true, all: false, ids: new Set(), code: "too-many-ship-ids" };
  const ids = new Set();
  for (const raw of shipIds) {
    if (typeof raw !== "string" && typeof raw !== "number") return { ok: false, explicit: true, all: false, ids: new Set(), code: "malformed-ship-id" };
    const id = String(raw).trim();
    if (!id || id.length > 48) return { ok: false, explicit: true, all: false, ids: new Set(), code: "malformed-ship-id" };
    ids.add(id);
  }
  return { ok: true, explicit: true, all: false, ids, code: ids.size === 0 ? "empty-selection" : "selected" };
}

function selectOwnedLivingShips(player, shipIds, options = {}) {
  const selection = normalizeSelectedShipIds(shipIds, options);
  if (!selection.ok) return { ...selection, ships: [] };
  if (selection.explicit && selection.ids.size === 0) return { ...selection, ships: [] };
  const ships = (player?.ships || []).filter((ship) => {
    if (!ship || !ship.alive || ship.removed) return false;
    if (selection.explicit) return selection.ids.has(ship.id);
    return selection.all;
  });
  return { ...selection, ships };
}

module.exports = { MAX_SELECTED_SHIP_IDS, normalizeSelectedShipIds, selectOwnedLivingShips };
