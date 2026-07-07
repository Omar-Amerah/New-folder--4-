// Client smoothing and interpolation helper utilities.

import { approach } from "../shared/math.js";

export function interpolateValue(current, target, rate) {
  return approach(current, target, rate);
}
