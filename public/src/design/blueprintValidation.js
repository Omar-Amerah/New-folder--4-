// Validates structural connection rules to make sure all parts connect back to the core.
import "../shared/structuralConnectivity.js";
import "../shared/droneBayRules.js";
import { PART_STATS } from "./parts.js";
import { computeStats } from "./componentStats.js";
import { getOccupiedCells } from "./footprint.js";

export function coreCount(parts) {
  return parts.filter((part) => part?.type === "core").length;
}

// Overlap is validated first; the shared BFS (also used by the server's
// deploy validation, so the two sides cannot drift) assumes no overlaps.
export function isConnected(parts) {
  if (isOverlapping(parts)) return false;
  return globalThis.StructuralConnectivity.isConnected(parts, PART_STATS, getOccupiedCells);
}

export function validateBlueprint(parts, { requireThrust = true, stats = null, normalizationIssues = [] } = {}) {
  const errors = [];
  const firstIssue = normalizationIssues[0];
  if (firstIssue) errors.push(firstIssue.message);
  if (!Array.isArray(parts) || parts.length === 0) errors.push("Invalid design: blueprint is empty.");
  const cores = Array.isArray(parts) ? coreCount(parts) : 0;
  if (cores === 0) errors.push("Invalid design: missing core.");
  else if (cores > 1) errors.push("Invalid design: exactly one core is required.");
  if (Array.isArray(parts) && isOutOfBounds(parts)) errors.push("Invalid design: modules outside build grid.");
  if (Array.isArray(parts) && isOverlapping(parts)) errors.push("Invalid design: overlapping modules.");
  if (Array.isArray(parts) && cores === 1 && !isOverlapping(parts) && !isConnected(parts)) errors.push("Invalid design: disconnected parts.");
  if (Array.isArray(parts)) {
    const droneValidation = globalThis.DroneBayRules?.validateDroneBays(parts, PART_STATS, { maximum: PART_STATS.droneBay?.droneConfig?.maxBaysPerShip });
    if (droneValidation && !droneValidation.ok) errors.push(...droneValidation.errors.map((error) => error.message));
  }
  if (requireThrust) {
    const computedStats = stats || (Array.isArray(parts) ? computeStats(parts) : null);
    if (computedStats && computedStats.thrust <= 0) errors.push("Invalid design: add at least one engine.");
  }
  return { ok: errors.length === 0, errors };
}

export function isOverlapping(parts) {
  const occupied = new Set();
  for (const part of parts) {
    const stat = PART_STATS[part.type] || PART_STATS.frame;
    const footprint = stat.footprint || { width: 1, height: 1 };
    const cells = getOccupiedCells(part.x, part.y, footprint, part.rotation || 0);
    for (const cell of cells) {
      const key = `${cell.x},${cell.y}`;
      if (occupied.has(key)) return true;
      occupied.add(key);
    }
  }
  return false;
}

export function isOutOfBounds(parts) {
  for (const part of parts) {
    const stat = PART_STATS[part.type] || PART_STATS.frame;
    const footprint = stat.footprint || { width: 1, height: 1 };
    const cells = getOccupiedCells(part.x, part.y, footprint, part.rotation || 0);
    for (const cell of cells) {
      if (cell.x < 0 || cell.x > 14 || cell.y < 0 || cell.y > 14) return true;
    }
  }
  return false;
}

export function explainConnectionProblem(existingParts, partType, x, y, rotation) {
  const stat = PART_STATS[partType] || PART_STATS.frame;
  const footprint = stat.footprint || { width: 1, height: 1 };
  const cells = getOccupiedCells(x, y, footprint, rotation || 0);

  let sideNeighbor = false;
  let cornerNeighbor = false;

  for (const newCell of cells) {
    for (const existingPart of existingParts) {
      const existingStat = PART_STATS[existingPart.type] || PART_STATS.frame;
      const existingFootprint = existingStat.footprint || { width: 1, height: 1 };
      const existingCells = getOccupiedCells(existingPart.x, existingPart.y, existingFootprint, existingPart.rotation || 0);

      for (const exCell of existingCells) {
        if (Math.abs(exCell.x - newCell.x) + Math.abs(exCell.y - newCell.y) === 1) {
          sideNeighbor = true;
        }
        if (Math.abs(exCell.x - newCell.x) === 1 && Math.abs(exCell.y - newCell.y) === 1) {
          cornerNeighbor = true;
        }
      }
    }
  }

  if (!sideNeighbor && cornerNeighbor) {
    return "Not connected: modules must share a full side — corner contact does not count";
  }

  if (!sideNeighbor) {
    return "Not connected: place it so one side touches an existing module";
  }

  return partType === "heatPipe"
    ? "Not connected: heat pipes must mount to the ship and connect to a sink or radiator route; they do not provide structural support"
    : "Not connected: every non-heat-pipe module needs a structural side-connected path back to the core";
}
