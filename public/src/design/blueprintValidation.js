// Validates structural connection rules to make sure all parts connect back to the core.
import "../shared/structuralConnectivity.js";
import "../shared/droneBayRules.js";
import { PART_DEFS, PART_STATS } from "./parts.js";
import { computeStats } from "./componentStats.js";
import { getOccupiedCells } from "./footprint.js";

export function coreCount(parts) {
  return parts.filter((part) => part?.type === "core").length;
}

export function backupCoreCount(parts) {
  return parts.filter((part) => part?.type === "backupCore").length;
}

// Overlap is validated first; the shared BFS (also used by the server's
// deploy validation, so the two sides cannot drift) assumes no overlaps.
export function isConnected(parts) {
  if (isOverlapping(parts)) return false;
  return globalThis.StructuralConnectivity.isConnected(parts, PART_STATS, getOccupiedCells);
}

// Connectivity detail from the same shared traversal used by client and server
// validation. Callers can explain an invalid design without recreating BFS rules.
export function disconnectedComponentIndices(parts, { assumeNoOverlap = false } = {}) {
  if (!Array.isArray(parts) || coreCount(parts) !== 1) return [];
  if (!assumeNoOverlap && isOverlapping(parts)) return [];
  return globalThis.StructuralConnectivity.disconnectedPartIndices(parts, PART_STATS, getOccupiedCells);
}

function disconnectedPartLabel(part) {
  const name = PART_DEFS[part?.type]?.name || part?.type || "Component";
  const x = Number.isFinite(Number(part?.x)) ? Math.trunc(Number(part.x)) : "?";
  const y = Number.isFinite(Number(part?.y)) ? Math.trunc(Number(part.y)) : "?";
  return `${name} at (${x}, ${y})`;
}

export function formatDisconnectedComponents(parts, indices = null) {
  const resolved = Array.isArray(indices) ? indices : disconnectedComponentIndices(parts);
  const details = resolved
    .map((index) => parts?.[index])
    .filter(Boolean)
    .map(disconnectedPartLabel);
  if (!details.length) return "The design has disconnected components.";
  const count = details.length;
  return `${count} disconnected component${count === 1 ? "" : "s"}: ${details.join("; ")}`;
}

export function formatDisconnectedComponentDetails(parts, indices = null) {
  const resolved = Array.isArray(indices) ? indices : disconnectedComponentIndices(parts);
  const details = resolved
    .map((index) => parts?.[index])
    .filter(Boolean)
    .map(disconnectedPartLabel);
  if (details.length === 1) return `${details[0]} has no structural path to the Core`;
  if (details.length > 1) return `${details.length} components have no structural path to the Core: ${details.join("; ")}`;
  return "No component has a structural path to the Core.";
}

export function validateBlueprint(parts, { requireThrust = true, stats = null, normalizationIssues = [] } = {}) {
  const errors = [];
  const firstIssue = normalizationIssues[0];
  if (firstIssue) errors.push(firstIssue.message);
  if (!Array.isArray(parts) || parts.length === 0) errors.push("Invalid design: blueprint is empty.");
  const cores = Array.isArray(parts) ? coreCount(parts) : 0;
  const backupCores = Array.isArray(parts) ? backupCoreCount(parts) : 0;
  if (cores === 0) errors.push("Invalid design: missing core.");
  else if (cores > 1) errors.push("Invalid design: exactly one core is required.");
  if (backupCores > 1) errors.push("Invalid design: maximum one Backup Command Core is allowed.");
  const outOfBounds = Array.isArray(parts) && isOutOfBounds(parts);
  const overlapping = Array.isArray(parts) && isOverlapping(parts);
  const disconnectedIndices = Array.isArray(parts) && cores === 1 && !overlapping
    ? disconnectedComponentIndices(parts, { assumeNoOverlap: true })
    : [];
  if (outOfBounds) errors.push("Invalid design: modules outside build grid.");
  if (overlapping) errors.push("Invalid design: overlapping modules.");
  if (disconnectedIndices.length) errors.push("Invalid design: disconnected parts.");
  if (Array.isArray(parts)) {
    const droneValidation = globalThis.DroneBayRules?.validateDroneBays(parts, PART_STATS, { maximum: PART_STATS.droneBay?.droneConfig?.maxBaysPerShip });
    if (droneValidation && !droneValidation.ok) errors.push(...droneValidation.errors.map((error) => error.message));
  }
  if (requireThrust) {
    const computedStats = stats || (Array.isArray(parts) ? computeStats(parts) : null);
    if (computedStats && computedStats.thrust <= 0) errors.push("Invalid design: add at least one engine.");
    if (computedStats && computedStats.turnRate <= 0) errors.push("Invalid design: ship must be able to turn.");
  }
  return { ok: errors.length === 0, errors, disconnectedComponentIndices: disconnectedIndices };
}

export function isOverlapping(parts) {
  const occupied = new Set();
  for (const part of parts) {
    const stat = PART_STATS[part.type] || PART_STATS.frame;
    const footprint = stat.footprint || { width: 1, height: 1 };
    const cells = getOccupiedCells(part.x, part.y, footprint, part.rotation || 0, part.flipped === true);
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
    const cells = getOccupiedCells(part.x, part.y, footprint, part.rotation || 0, part.flipped === true);
    for (const cell of cells) {
      if (cell.x < 0 || cell.x > 14 || cell.y < 0 || cell.y > 14) return true;
    }
  }
  return false;
}

export function explainConnectionProblem(existingParts, partType, x, y, rotation, flipped = false) {
  const stat = PART_STATS[partType] || PART_STATS.frame;
  const footprint = stat.footprint || { width: 1, height: 1 };
  const cells = getOccupiedCells(x, y, footprint, rotation || 0, flipped === true);

  let sideNeighbor = false;
  let cornerNeighbor = false;

  for (const newCell of cells) {
    for (const existingPart of existingParts) {
      const existingStat = PART_STATS[existingPart.type] || PART_STATS.frame;
      const existingFootprint = existingStat.footprint || { width: 1, height: 1 };
      const existingCells = getOccupiedCells(existingPart.x, existingPart.y, existingFootprint, existingPart.rotation || 0, existingPart.flipped === true);

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
    return "Not connected: modules must share a full side : corner contact does not count";
  }

  if (!sideNeighbor) {
    return "Not connected: place it so one side touches an existing module";
  }

  return partType === "heatPipe"
    ? "Not connected: heat pipes must mount to the ship structurally; they do not provide structural support but components can attach directly for thermal transfer"
    : "Not connected: every non-heat-pipe module needs a structural side-connected path back to the core";
}
