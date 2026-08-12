import { disconnectedComponentIndices } from "../../design/blueprintValidation.js";

export function disconnectedComponentIndexSet(design) {
  return new Set(disconnectedComponentIndices(design));
}
