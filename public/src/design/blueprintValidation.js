// Validates structural connection rules to make sure all parts connect back to the core.
import { PART_STATS } from "./parts.js";
import { getOccupiedCells } from "./footprint.js";

export function coreCount(parts) {
  return parts.filter((part) => part?.type === "core").length;
}

export function isConnected(parts) {
  if (isOverlapping(parts)) return false;
  const core = parts.find((part) => part.type === "core");
  if (!core) return false;

  // Cell -> owning part index, so the BFS below resolves each neighbour cell
  // with one map lookup instead of rescanning every part (this runs on every
  // hover preview). Assumes parts don't overlap — overlap is validated first.
  const partCellsMap = new Map();
  const cellOwner = new Map();

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const stat = PART_STATS[part.type] || PART_STATS.frame;
    const footprint = stat.footprint || { width: 1, height: 1 };
    const cells = getOccupiedCells(part.x, part.y, footprint, part.rotation || 0);
    partCellsMap.set(i, cells);
    for (const cell of cells) {
      cellOwner.set(`${cell.x},${cell.y}`, i);
    }
  }

  const coreIndex = parts.indexOf(core);
  const traverse = (canEnter) => {
    const seenParts = new Set([coreIndex]);
    const queue = [coreIndex];

    for (let i = 0; i < queue.length; i += 1) {
      const partIndex = queue[i];
      const cells = partCellsMap.get(partIndex);

      for (const cell of cells) {
        for (const [nx, ny] of [[cell.x + 1, cell.y], [cell.x - 1, cell.y], [cell.x, cell.y + 1], [cell.x, cell.y - 1]]) {
          const neighbor = cellOwner.get(`${nx},${ny}`);
          if (neighbor !== undefined && !seenParts.has(neighbor) && canEnter(neighbor)) {
            seenParts.add(neighbor);
            queue.push(neighbor);
          }
        }
      }
    }
    return seenParts;
  };

  const physicallyConnected = traverse(() => true);
  if (physicallyConnected.size !== parts.length) return false;

  // Heat pipes can be attached as service conduits, but they are not hull
  // structure and cannot be the only support path for other components.
  const structurallyConnected = traverse(index => parts[index].type !== "heatPipe");
  for (let i = 0; i < parts.length; i += 1) {
    if (parts[i].type !== "heatPipe" && !structurallyConnected.has(i)) return false;
  }

  return true;
}

export function validateBlueprint(parts, { requireThrust = false, stats = null } = {}) {
  const errors = [];
  if (!Array.isArray(parts) || parts.length === 0) errors.push("Invalid design: blueprint is empty.");
  const cores = Array.isArray(parts) ? coreCount(parts) : 0;
  if (cores === 0) errors.push("Invalid design: missing core.");
  else if (cores > 1) errors.push("Invalid design: exactly one core is required.");
  if (Array.isArray(parts) && isOutOfBounds(parts)) errors.push("Invalid design: modules outside build grid.");
  if (Array.isArray(parts) && isOverlapping(parts)) errors.push("Invalid design: overlapping modules.");
  if (Array.isArray(parts) && cores === 1 && !isOverlapping(parts) && !isConnected(parts)) errors.push("Invalid design: disconnected parts.");
  if (requireThrust && stats && stats.thrust <= 0) errors.push("Invalid design: add at least one engine.");
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
