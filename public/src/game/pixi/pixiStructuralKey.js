import { normalizeRotation } from "../../design/rotation.js";
export function shipStructuralRevisionKey({ design = [], trimColor = "", qualityGeneration = 0, artVersion = 1 } = {}) {
  const parts = design.map((part) => `${part.type || "frame"}@${Number(part.x)||0},${Number(part.y)||0},r${normalizeRotation(part.rotation)||0}`);
  if (parts.length > 512) return `v${artVersion}|q${qualityGeneration}|c${trimColor}|n${parts.length}|h${hashString(parts.join(";"))}`;
  return `v${artVersion}|q${qualityGeneration}|c${trimColor}|n${parts.length}|${parts.join(";")}`;
}
function hashString(value){ let h=2166136261; for (let i=0;i<value.length;i+=1){ h ^= value.charCodeAt(i); h = Math.imul(h,16777619); } return (h>>>0).toString(36); }
