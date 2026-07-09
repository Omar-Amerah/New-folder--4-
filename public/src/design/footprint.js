export function getOccupiedCells(x, y, footprint, rotation = 0) {
  const cells = [];
  const width = footprint.width || 1;
  const height = footprint.height || 1;
  const normalizedRotation = (rotation % 360 + 360) % 360;

  const isRotated = normalizedRotation === 90 || normalizedRotation === 270;
  const actualWidth = isRotated ? height : width;
  const actualHeight = isRotated ? width : height;

  for (let dy = 0; dy < actualHeight; dy++) {
    for (let dx = 0; dx < actualWidth; dx++) {
      cells.push({ x: x + dx, y: y + dy });
    }
  }

  return cells;
}

export function footprintIncludes(x, y, footprint, rotation, targetX, targetY) {
  const cells = getOccupiedCells(x, y, footprint, rotation);
  return cells.some(cell => cell.x === targetX && cell.y === targetY);
}
