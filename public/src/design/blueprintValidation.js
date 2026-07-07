// Validates structural connection rules to make sure all parts connect back to the core.

export function isConnected(parts) {
  const core = parts.find((part) => part.type === "core");
  if (!core) return false;
  const keys = new Set(parts.map((part) => `${part.x},${part.y}`));
  const seen = new Set([`${core.x},${core.y}`]);
  const queue = [core];

  for (let i = 0; i < queue.length; i += 1) {
    const part = queue[i];
    for (const [x, y] of [[part.x + 1, part.y], [part.x - 1, part.y], [part.x, part.y + 1], [part.x, part.y - 1]]) {
      const key = `${x},${y}`;
      if (keys.has(key) && !seen.has(key)) {
        seen.add(key);
        queue.push({ x, y });
      }
    }
  }

  return seen.size === parts.length;
}

export function explainConnectionProblem(existingParts, x, y) {
  const sideNeighbor = existingParts.some(
    (part) => Math.abs(part.x - x) + Math.abs(part.y - y) === 1
  );
  const cornerNeighbor = existingParts.some(
    (part) => Math.abs(part.x - x) === 1 && Math.abs(part.y - y) === 1
  );

  if (!sideNeighbor && cornerNeighbor) {
    return "Not connected: modules must share a full side — corner contact does not count";
  }

  if (!sideNeighbor) {
    return "Not connected: place it so one side touches an existing module";
  }

  return "Not connected: every module needs a side-connected path back to the core";
}

