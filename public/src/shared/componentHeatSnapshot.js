// Component heat snapshot tuple format shared by runtime consumers.
// Full snapshots store componentHeat as an array of tuples:
//   [heat value, state, ratio, capacity]
// Delta snapshots store componentHeatD as a flat compact sequence:
//   [component index, heat value, state, ratio, capacity, ...]
// Keep this format compact: do not add fields without replacing another field.
export const COMPONENT_HEAT_VALUE = 0;
export const COMPONENT_HEAT_STATE = 1;
export const COMPONENT_HEAT_RATIO = 2;
export const COMPONENT_HEAT_CAPACITY = 3;
export const COMPONENT_HEAT_DELTA_INDEX = 0;
export const COMPONENT_HEAT_DELTA_VALUE = 1;
export const COMPONENT_HEAT_DELTA_STATE = 2;
export const COMPONENT_HEAT_DELTA_RATIO = 3;
export const COMPONENT_HEAT_DELTA_CAPACITY = 4;
export const COMPONENT_HEAT_TUPLE_LENGTH = 4;
export const COMPONENT_HEAT_DELTA_STRIDE = 5;

export function normalizeComponentHeatTuple(entry) {
  if (!Array.isArray(entry) || entry.length < COMPONENT_HEAT_TUPLE_LENGTH) return null;
  const heat = Number(entry[COMPONENT_HEAT_VALUE]);
  const state = Number(entry[COMPONENT_HEAT_STATE]);
  const ratio = Number(entry[COMPONENT_HEAT_RATIO]);
  const capacity = Number(entry[COMPONENT_HEAT_CAPACITY]);
  if (!Number.isFinite(heat) || !Number.isFinite(state) || !Number.isFinite(ratio) || !Number.isFinite(capacity)) return null;
  return [Math.max(0, heat), state, Math.max(0, ratio), Math.max(0, capacity)];
}

export function componentHeatTupleFromDelta(delta, offset) {
  if (!Array.isArray(delta) || offset + COMPONENT_HEAT_DELTA_STRIDE > delta.length) return null;
  const index = Number(delta[offset + COMPONENT_HEAT_DELTA_INDEX]);
  if (!Number.isInteger(index) || index < 0) return null;
  const tuple = normalizeComponentHeatTuple([
    delta[offset + COMPONENT_HEAT_DELTA_VALUE],
    delta[offset + COMPONENT_HEAT_DELTA_STATE],
    delta[offset + COMPONENT_HEAT_DELTA_RATIO],
    delta[offset + COMPONENT_HEAT_DELTA_CAPACITY]
  ]);
  return tuple ? { index, tuple } : null;
}
