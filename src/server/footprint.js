// Rotates a component's footprint around its anchor tile (part.x/part.y).
// Kept in sync with public/src/design/footprint.js so client placement and
// server validation agree on which cells a rotated multi-tile part occupies.
function getOccupiedCells(x, y, footprint, rotation = 0) {
  const cells = [];
  const width = footprint.width || 1;
  const height = footprint.height || 1;
  const normalizedRotation = (rotation % 360 + 360) % 360;

  for (let dy = 0; dy < height; dy++) {
    for (let dx = 0; dx < width; dx++) {
      let ox;
      let oy;
      if (normalizedRotation === 90) {
        ox = -dy;
        oy = dx;
      } else if (normalizedRotation === 180) {
        ox = -dx;
        oy = -dy;
      } else if (normalizedRotation === 270) {
        ox = dy;
        oy = -dx;
      } else {
        ox = dx;
        oy = dy;
      }
      cells.push({ x: x + ox, y: y + oy });
    }
  }

  return cells;
}

function getFootprintBounds(x, y, footprint, rotation = 0) {
  const cells = getOccupiedCells(x, y, footprint, rotation);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const cell of cells) {
    if (cell.x < minX) minX = cell.x;
    if (cell.y < minY) minY = cell.y;
    if (cell.x > maxX) maxX = cell.x;
    if (cell.y > maxY) maxY = cell.y;
  }
  return { minX, minY, maxX, maxY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

function footprintIncludes(x, y, footprint, rotation, targetX, targetY) {
  const cells = getOccupiedCells(x, y, footprint, rotation);
  return cells.some(cell => cell.x === targetX && cell.y === targetY);
}

module.exports = {
  getOccupiedCells,
  getFootprintBounds,
  footprintIncludes
};
