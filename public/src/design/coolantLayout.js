// Presentation-side geometry for the Heat Pipe coolant network.
//
// The gameplay rules for a coolant network live in shared/heatRules.js and the
// authoritative networks are solved on the server. This module answers the two
// purely visual questions the renderers ask: which tile edges of a placed Heat
// Pipe carry a live coolant connection, and which components belong to the same
// network as the one under the cursor.
//
// A Heat Pipe is 1x1 and non-rotatable, so the mask is derived entirely from
// orthogonal adjacency — the player never configures ports or direction.

import { getOccupiedCells } from "./footprint.js";

export const CONNECT_NORTH = 1;
export const CONNECT_EAST = 2;
export const CONNECT_SOUTH = 4;
export const CONNECT_WEST = 8;

// Bit order matches componentArt.js's PIPE_DIRECTION_VECTORS.
const DIRECTION_BITS = Object.freeze([
  { dx: 0, dy: -1, bit: CONNECT_NORTH },
  { dx: 1, dy: 0, bit: CONNECT_EAST },
  { dx: 0, dy: 1, bit: CONNECT_SOUTH },
  { dx: -1, dy: 0, bit: CONNECT_WEST }
]);

function isHeatPipe(type) {
  const rules = globalThis.HeatRules;
  return rules ? rules.isCoolantTransportType(type) : type === "heatPipe";
}

function ownerByCell(design, partStats) {
  const owners = new Map();
  for (let i = 0; i < design.length; i += 1) {
    const module = design[i];
    const stat = partStats?.[module.type] || {};
    const cells = getOccupiedCells(module.x, module.y, stat.footprint || { width: 1, height: 1 }, module.rotation || 0);
    for (const cell of cells) owners.set(`${cell.x},${cell.y}`, i);
  }
  return owners;
}

/**
 * Blueprint-space connection mask per design index. Non-pipe components get a
 * mask of the edges on which they touch a Heat Pipe, so a Heat Vent (or any
 * other attachment) can show its coolant stub pointing at the network.
 * @param {Array<{type:string,x:number,y:number,rotation?:number}>} design
 * @param {object} partStats Catalogue used for footprints.
 * @returns {number[]} Four-bit masks indexed by design index.
 */
export function coolantConnectionMasks(design, partStats) {
  const owners = ownerByCell(design, partStats);
  return design.map((module, index) => {
    const stat = partStats?.[module.type] || {};
    const cells = getOccupiedCells(module.x, module.y, stat.footprint || { width: 1, height: 1 }, module.rotation || 0);
    const selfIsPipe = isHeatPipe(module.type);
    let mask = 0;
    for (const cell of cells) {
      for (const { dx, dy, bit } of DIRECTION_BITS) {
        const neighbour = owners.get(`${cell.x + dx},${cell.y + dy}`);
        if (neighbour === undefined || neighbour === index) continue;
        const neighbourIsPipe = isHeatPipe(design[neighbour].type);
        // A pipe couples to pipes and to any component it can exchange heat
        // with; everything else only shows a stub toward an actual pipe.
        if (selfIsPipe || neighbourIsPipe) mask |= bit;
      }
    }
    return mask;
  });
}

/**
 * Rotate a connection mask by quarter turns clockwise in screen space. Renderers
 * that draw ship-local art (arena hull bake, thumbnails, damage panel) need one
 * turn, because blueprint "up" is the ship's forward +x axis.
 * @param {number} mask
 * @param {number} quarterTurns
 * @returns {number}
 */
export function rotateConnectionMask(mask, quarterTurns = 1) {
  const value = (Number(mask) || 0) & 15;
  const turns = ((Math.round(quarterTurns) % 4) + 4) % 4;
  return ((value << turns) | (value >> (4 - turns))) & 15;
}

/**
 * Connection masks in ship-local art space, ready to hand to drawModule from an
 * arena/thumbnail renderer.
 * @param {Array<{type:string,x:number,y:number,rotation?:number}>} design
 * @param {object} partStats
 * @returns {number[]}
 */
export function shipLocalCoolantMasks(design, partStats) {
  return coolantConnectionMasks(design, partStats).map((mask) => rotateConnectionMask(mask, 1));
}

/**
 * The coolant network containing a component: every Heat Pipe in the connected
 * pipe run plus every component attached to it. Used by the designer to explain
 * "what is plumbed to what" on hover without a dedicated plumbing editor.
 * @param {Array<{type:string,x:number,y:number,rotation?:number}>} design
 * @param {number} index Component to look up.
 * @param {object} partStats
 * @returns {{pipes:Set<number>, attachments:Set<number>}|null} null when the
 *   component is neither a pipe nor touching one.
 */
export function coolantNetworkAt(design, index, partStats) {
  if (!design?.[index]) return null;
  const owners = ownerByCell(design, partStats);
  const neighboursOf = (target) => {
    const module = design[target];
    const stat = partStats?.[module.type] || {};
    const cells = getOccupiedCells(module.x, module.y, stat.footprint || { width: 1, height: 1 }, module.rotation || 0);
    const found = new Set();
    for (const cell of cells) {
      for (const { dx, dy } of DIRECTION_BITS) {
        const neighbour = owners.get(`${cell.x + dx},${cell.y + dy}`);
        if (neighbour !== undefined && neighbour !== target) found.add(neighbour);
      }
    }
    return found;
  };

  const seeds = isHeatPipe(design[index].type)
    ? [index]
    : [...neighboursOf(index)].filter((i) => isHeatPipe(design[i].type));
  if (!seeds.length) return null;

  const pipes = new Set();
  const queue = [];
  for (const seed of seeds) { if (!pipes.has(seed)) { pipes.add(seed); queue.push(seed); } }
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    for (const neighbour of neighboursOf(queue[cursor])) {
      if (isHeatPipe(design[neighbour].type) && !pipes.has(neighbour)) { pipes.add(neighbour); queue.push(neighbour); }
    }
  }
  const attachments = new Set();
  for (const pipe of pipes) {
    for (const neighbour of neighboursOf(pipe)) if (!pipes.has(neighbour)) attachments.add(neighbour);
  }
  return { pipes, attachments };
}
