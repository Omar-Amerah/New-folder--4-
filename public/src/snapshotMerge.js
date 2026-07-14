import { COMPONENT_HEAT_DELTA_STRIDE, componentHeatTupleFromDelta, normalizeComponentHeatTuple } from "./shared/componentHeatSnapshot.js";

export function mergeStaticPlayerFields(previousPlayers, nextPlayers) {
  if (!Array.isArray(previousPlayers) || !Array.isArray(nextPlayers)) return nextPlayers;
  const oldPlayers = new Map(previousPlayers.map((p) => [p.id, p]));
  return nextPlayers.map((player) => {
    const oldPlayer = oldPlayers.get(player.id);
    if (!oldPlayer) return player;
    const merged = { ...player };
    if (merged.design === undefined) merged.design = oldPlayer.design;
    if (merged.stats === undefined) merged.stats = oldPlayer.stats;
    return merged;
  });
}

export function applyComponentHpDelta(previousHp, delta) {
  if (!Array.isArray(previousHp)) return undefined;
  if (!Array.isArray(delta) || delta.length === 0) return previousHp;
  const merged = previousHp.slice();
  for (let k = 0; k + 1 < delta.length; k += 2) {
    const index = Number(delta[k]);
    const hp = Number(delta[k + 1]);
    if (!Number.isInteger(index) || index < 0 || index >= merged.length || !Number.isFinite(hp)) continue;
    merged[index] = hp;
  }
  return merged;
}

export function normalizeComponentHeatSnapshot(componentHeat) {
  if (!Array.isArray(componentHeat)) return componentHeat;
  return componentHeat.map((entry) => normalizeComponentHeatTuple(entry) || [0, 0, 0, 0]);
}

export function applyComponentHeatDelta(previousHeat, delta) {
  if (!Array.isArray(previousHeat)) return undefined;
  if (!Array.isArray(delta) || delta.length === 0) return previousHeat;
  const merged = previousHeat.map((value) => Array.isArray(value) ? value.slice() : value);
  for (let k = 0; k + COMPONENT_HEAT_DELTA_STRIDE <= delta.length; k += COMPONENT_HEAT_DELTA_STRIDE) {
    const update = componentHeatTupleFromDelta(delta, k);
    if (!update || update.index >= merged.length) continue;
    merged[update.index] = update.tuple;
  }
  return merged;
}

export function mergeCachedShipFields(previousShips, nextShips) {
  if (!Array.isArray(previousShips) || !Array.isArray(nextShips)) return nextShips;
  const oldShips = new Map(previousShips.map((ship) => [ship.id, ship]));
  return nextShips.map((ship) => {
    const oldShip = oldShips.get(ship.id);
    if (!oldShip) {
      return { ...ship, componentHeat: normalizeComponentHeatSnapshot(ship.componentHeat) };
    }
    const merged = { ...ship };
    if (merged.design === undefined) merged.design = oldShip.design;
    if (merged.chp === undefined) {
      const hp = applyComponentHpDelta(oldShip.chp, merged.chpD);
      if (hp !== undefined) merged.chp = hp;
    }
    if (merged.componentHeat !== undefined) {
      merged.componentHeat = normalizeComponentHeatSnapshot(merged.componentHeat);
    } else {
      const heat = applyComponentHeatDelta(oldShip.componentHeat, merged.componentHeatD);
      if (heat !== undefined) merged.componentHeat = heat;
    }
    return merged;
  });
}
