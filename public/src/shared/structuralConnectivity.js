// Shared structural connectivity rules for the browser designer and the Node
// server. A blueprint is connected when every part reaches the core through
// side-adjacent cells, and no non-heat-pipe part relies on a heat-pipe chain as
// its only path back to the core (heat pipes are mounted service conduits, not
// hull structure). Callers supply their part catalogue and footprint expansion
// so this module stays dependency-free; overlap filtering is the caller's job.
(function initStructuralConnectivity(root, factory) {
  const api = factory();
  root.StructuralConnectivity = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function structuralConnectivityFactory() {
  "use strict";

  function isConnected(parts, catalogue, getOccupiedCells) {
    const core = parts.find((part) => part.type === "core");
    if (!core) return false;

    // Cell -> owning part index so each neighbour lookup is O(1). This runs on
    // every hover preview client-side. Assumes parts don't overlap.
    const partCellsMap = new Map();
    const cellOwner = new Map();

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const stat = catalogue[part.type] || catalogue.frame || {};
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

    const structurallyConnected = traverse((index) => parts[index].type !== "heatPipe");
    for (let i = 0; i < parts.length; i += 1) {
      if (parts[i].type !== "heatPipe" && !structurallyConnected.has(i)) return false;
    }

    return true;
  }

  return Object.freeze({ isConnected });
}));
