// Authoritative low-frequency, per-component thermal simulation.
const { PARTS } = require("./components");
const { getOccupiedCells } = require("./footprint");
const HeatRules = require("../../public/src/shared/heatRules");

const { TICK_SECONDS, STATE, profile, stateFor, performanceForState, edgeTransfer, edgeConductivity } = HeatRules;
function isThermalRouteType(type) { return /frame/i.test(String(type || "")) || type === "heatPipe"; }

function findExteriorEmptyCells(cellOwners) {
  const occupied = [...cellOwners.keys()].map(key => key.split(",").map(Number));
  if (!occupied.length) return new Set();
  const xs = occupied.map(cell => cell[0]);
  const ys = occupied.map(cell => cell[1]);
  const minX = Math.min(...xs) - 1, maxX = Math.max(...xs) + 1;
  const minY = Math.min(...ys) - 1, maxY = Math.max(...ys) + 1;
  const exterior = new Set([`${minX},${minY}`]);
  const queue = [[minX, minY]];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const [x, y] = queue[cursor];
    for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const nx = x + dx, ny = y + dy, key = `${nx},${ny}`;
      if (nx < minX || nx > maxX || ny < minY || ny > maxY || exterior.has(key) || cellOwners.has(key)) continue;
      exterior.add(key); queue.push([nx, ny]);
    }
  }
  return exterior;
}

function initShipHeat(ship) {
  const design = ship.design || [];
  const cellOwners = new Map();
  const cellsByComponent = [];
  for (let i = 0; i < design.length; i += 1) {
    const module = design[i];
    const footprint = PARTS[module.type]?.footprint || { width: 1, height: 1 };
    const cells = getOccupiedCells(module.x, module.y, footprint, module.rotation || 0);
    cellsByComponent[i] = cells;
    for (const cell of cells) cellOwners.set(`${cell.x},${cell.y}`, i);
  }

  const exteriorEmpty = findExteriorEmptyCells(cellOwners);
  const edgeCounts = design.map(() => new Map());
  const exposedEdges = design.map(() => 0);
  for (let i = 0; i < cellsByComponent.length; i += 1) {
    for (const cell of cellsByComponent[i]) {
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const owner = cellOwners.get(`${cell.x + dx},${cell.y + dy}`);
        if (owner === undefined && exteriorEmpty.has(`${cell.x + dx},${cell.y + dy}`)) exposedEdges[i] += 1;
        else if (owner !== undefined && owner !== i) edgeCounts[i].set(owner, (edgeCounts[i].get(owner) || 0) + 1);
      }
    }
  }

  ship.componentThermals = design.map((module, i) => {
    const thermal = { ...profile(module.type, PARTS[module.type] || {}), exposedEdges: exposedEdges[i] };
    const adjacentSinks = [...edgeCounts[i].keys()].filter(index => design[index]?.type === "heatSink").length;
    thermal.capacity += adjacentSinks * 35;
    return thermal;
  });
  ship.componentAdjacency = edgeCounts.map((edges, i) => [...edges].map(([index, sharedEdges]) => ({
    index,
    sharedEdges,
    conductivity: edgeConductivity(ship.componentThermals[i], ship.componentThermals[index])
  })));
  // Compact arrays indexed by immutable design index.
  ship.componentHeat = design.map(() => 0);
  ship.componentCurrentHeat = ship.componentHeat;
  ship.componentHeatCapacity = ship.componentThermals.map(item => item.capacity);
  ship.componentHeatState = design.map(() => STATE.NORMAL);
  ship.componentHeatGenerated = design.map(() => 0);
  ship.componentHeatReceived = design.map(() => 0);
  ship.componentHeatRemoved = design.map(() => 0);
  ship.componentHeatSentThroughFrame = design.map(() => 0);
  ship.componentHeatRadiated = design.map(() => 0);
  ship.heatGeneratedThisTick = ship.componentHeatGenerated;
  ship.heatReceivedThisTick = ship.componentHeatReceived;
  ship.heatRemovedThisTick = ship.componentHeatRemoved;
  ship.componentHeatInput = design.map(() => 0);
  ship.heatAccumulator = 0;
  ship.currentHeat = 0;
  ship.maxHeat = ship.componentThermals.reduce((sum, item) => sum + item.capacity, 0);
  ship.heatPressure = 0;
  ship.hotComponentCount = 0;
  ship.overheatedComponentCount = 0;
  ship.thermalPowerFactor = 1;
  ship.hasPassiveHeatSource = design.some(module => (PARTS[module.type]?.powerGeneration || 0) > 0);
  ship.hasActiveHeat = ship.hasPassiveHeatSource;
  ship.heatAdjacencyBuilds = (ship.heatAdjacencyBuilds || 0) + 1;
  ship.dirtyHeat = new Set(design.map((_, i) => i));
  rebuildThermalNetworks(ship);
}

function rebuildThermalNetworks(ship) {
  if (!ship.componentAdjacency) return;
  const design = ship.design || [];
  const aliveFrames = new Set();
  for (let i = 0; i < design.length; i += 1) if (isThermalRouteType(design[i].type) && (ship.componentHp?.[i] ?? 1) > 0) aliveFrames.add(i);
  const visited = new Set();
  const networks = [];
  ship.componentThermalNetworks = design.map(() => []);
  ship.frameCoolingDistance = design.map(() => Infinity);
  for (const start of aliveFrames) {
    if (visited.has(start)) continue;
    const frames = [];
    const attached = new Set();
    const queue = [start]; visited.add(start);
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const index = queue[cursor]; frames.push(index);
      for (const edge of ship.componentAdjacency[index]) {
        const neighbour = edge.index;
        if (aliveFrames.has(neighbour)) {
          if (!visited.has(neighbour)) { visited.add(neighbour); queue.push(neighbour); }
        } else if ((ship.componentHp?.[neighbour] ?? 1) > 0) attached.add(neighbour);
      }
    }
    const members = new Set([...frames, ...attached]);
    const generators = [...attached].filter(i => HeatRules.activityHeat(design[i].type, PARTS[design[i].type] || {}) > 0);
    const sinks = [...attached].filter(i => design[i].type === "heatSink");
    const radiators = [...attached].filter(i => design[i].type === "radiator");
    const id = networks.length;
    for (const index of members) ship.componentThermalNetworks[index].push(id);
    const connectedFrameCells = frames.map(index => ({ index, x: design[index].x, y: design[index].y }));
    networks.push({ id, frameIndices: frames, connectedFrameCells, attachedComponents: [...attached], generators, sinks, radiators, totalStoredHeat: 0, totalStorageCapacity: 0, totalCoolingCapacity: 0, overloaded: false });

    // Cached distance-to-cooling field: used only as a mild conductivity boost,
    // never as an instant/global heat drain.
    const coolers = new Set([...sinks, ...radiators]);
    const distanceQueue = [];
    for (const frame of frames) {
      const touchesCooling = ship.componentAdjacency[frame].some(edge => coolers.has(edge.index));
      if (touchesCooling) { ship.frameCoolingDistance[frame] = 0; distanceQueue.push(frame); }
    }
    for (let cursor = 0; cursor < distanceQueue.length; cursor += 1) {
      const frame = distanceQueue[cursor];
      const nextDistance = ship.frameCoolingDistance[frame] + 1;
      for (const edge of ship.componentAdjacency[frame]) {
        const neighbour = edge.index;
        if (!frames.includes(neighbour) || nextDistance >= ship.frameCoolingDistance[neighbour]) continue;
        ship.frameCoolingDistance[neighbour] = nextDistance;
        distanceQueue.push(neighbour);
      }
    }
  }
  ship.thermalNetworks = networks;
  ship.thermalNetworkBuilds = (ship.thermalNetworkBuilds || 0) + 1;
}

function addComponentHeat(ship, index, amount) {
  if (!ship.componentHeatInput || !Number.isFinite(amount) || amount <= 0) return;
  if (index < 0 || index >= ship.componentHeatInput.length) return;
  ship.componentHeatInput[index] += amount;
  ship.hasActiveHeat = true;
}

function componentPerformance(ship, index) {
  return performanceForState(ship.componentHeatState?.[index] || STATE.NORMAL);
}

function systemPerformance(ship, predicate) {
  let weighted = 0;
  let total = 0;
  for (let i = 0; i < (ship.design || []).length; i += 1) {
    const part = PARTS[ship.design[i].type] || {};
    if (!predicate(part, ship.design[i]) || (ship.componentHp?.[i] ?? 1) <= 0) continue;
    weighted += componentPerformance(ship, i);
    total += 1;
  }
  return total ? weighted / total : 1;
}

function addHeatToType(ship, predicate, amount) {
  // Destroyed components discard incoming heat, so only split across live
  // matches — otherwise part of the heat silently vanishes into wreckage.
  const matches = [];
  for (let i = 0; i < (ship.design || []).length; i += 1) {
    if ((ship.componentHp?.[i] ?? 1) <= 0) continue;
    if (predicate(PARTS[ship.design[i].type] || {}, ship.design[i])) matches.push(i);
  }
  if (!matches.length) return;
  for (const i of matches) addComponentHeat(ship, i, amount / matches.length);
}

// A reactor pinned at the overheat failure state (heat >= capacity) for this long
// melts down and explodes. The delay telegraphs the failure and prevents a single
// spike from instantly chaining through a reactor bank. The constants live in the
// shared HeatRules so the designer's meltdown prediction uses the same values.
const { REACTOR_MELTDOWN_SECONDS, REACTOR_EXPLOSION_RADIUS, REACTOR_EXPLOSION_DAMAGE } = HeatRules;

function updateShipHeat(ship, dt, room, now) {
  if (!ship.alive || !ship.componentHeat) return;
  const pending = ship.componentHeatInput.some(value => value > 0);
  if (!ship.hasActiveHeat && !ship.hasPassiveHeatSource && !pending) return;
  ship.heatAccumulator += dt;
  if (ship.heatAccumulator < TICK_SECONDS) return;
  const elapsed = Math.min(0.6, ship.heatAccumulator);
  ship.heatAccumulator = 0;
  ship.lastHeatTickDelta = elapsed;

  const heat = ship.componentHeat;
  const delta = heat.map(() => 0);
  ship.componentHeatGenerated.fill(0);
  ship.componentHeatReceived.fill(0);
  ship.componentHeatRemoved.fill(0);
  ship.componentHeatSentThroughFrame.fill(0);
  ship.componentHeatRadiated.fill(0);
  let remainsActive = false;

  // Local generation only. Cooling is applied after transfers so a radiator can
  // remove heat arriving through its frame route in the same thermal tick.
  for (let i = 0; i < heat.length; i += 1) {
    const alive = (ship.componentHp?.[i] ?? 1) > 0;
    const part = PARTS[ship.design[i].type] || {};
    const thermal = ship.componentThermals[i];
    const damagedMultiplier = alive && ship.componentMaxHp?.[i] ? 1 + 0.15 * (1 - ship.componentHp[i] / ship.componentMaxHp[i]) : 1;
    const load = part.powerGeneration > 0 ? Math.min(1, (ship.stats.powerUse || 0) / Math.max(1, ship.stats.powerGeneration || 1)) : 0;
    const steady = alive && part.powerGeneration > 0 ? (2 + part.powerGeneration * 0.42) * load * elapsed * damagedMultiplier : 0;
    const generated = alive ? ship.componentHeatInput[i] * damagedMultiplier + steady : 0;
    ship.componentHeatInput[i] = 0;
    ship.componentHeatGenerated[i] = generated;
    delta[i] += generated;

  }

  // Cached edges only; normalized-ratio transfers are calculated against the
  // same pre-transfer snapshot, then each component's total outflow is scaled
  // down so it never sends more heat than it holds (per-edge clamps alone let a
  // component with several colder neighbours overdraw, minting heat from the
  // final max(0, ...) clamp). Scaling keeps transfers order independent.
  const workingHeat = heat.map((value, i) => Math.max(0, value + delta[i]));
  const pendingTransfers = [];
  const outflow = heat.map(() => 0);
  for (let i = 0; i < heat.length; i += 1) {
    for (const edge of ship.componentAdjacency[i]) {
      const j = edge.index;
      if (j <= i) continue;
      const aliveI = (ship.componentHp?.[i] ?? 1) > 0;
      const aliveJ = (ship.componentHp?.[j] ?? 1) > 0;
      if ((!aliveI && isThermalRouteType(ship.design[i].type)) || (!aliveJ && isThermalRouteType(ship.design[j].type))) continue;
      let conductivity = (!aliveI || !aliveJ) ? HeatRules.CONDUCTIVITY.destroyed : edge.conductivity;
      const frameI = isThermalRouteType(ship.design[i].type);
      const frameJ = isThermalRouteType(ship.design[j].type);
      const routedI = Number.isFinite(ship.frameCoolingDistance?.[i]);
      const routedJ = Number.isFinite(ship.frameCoolingDistance?.[j]);
      if (aliveI && aliveJ && frameI && frameJ && (routedI || routedJ)) conductivity *= HeatRules.NETWORK_FRAME_BOOST;
      else if (aliveI && aliveJ && ((frameI && routedI) || (frameJ && routedJ))) conductivity *= HeatRules.NETWORK_ATTACHMENT_BOOST;
      const transfer = edgeTransfer(workingHeat[i], ship.componentThermals[i].capacity, workingHeat[j], ship.componentThermals[j].capacity, conductivity, edge.sharedEdges, elapsed);
      if (transfer === 0) continue;
      pendingTransfers.push({ i, j, transfer, throughFrame: frameI || frameJ });
      outflow[transfer > 0 ? i : j] += Math.abs(transfer);
    }
  }
  for (const pending of pendingTransfers) {
    const { i, j, throughFrame } = pending;
    const source = pending.transfer > 0 ? i : j;
    const scale = outflow[source] > workingHeat[source] ? workingHeat[source] / outflow[source] : 1;
    const transfer = pending.transfer * scale;
    delta[i] -= transfer;
    delta[j] += transfer;
    if (transfer > 0) {
      ship.componentHeatRemoved[i] += transfer;
      ship.componentHeatReceived[j] += transfer;
      if (throughFrame) ship.componentHeatSentThroughFrame[i] += transfer;
    } else if (transfer < 0) {
      ship.componentHeatReceived[i] -= transfer;
      ship.componentHeatRemoved[j] -= transfer;
      if (throughFrame) ship.componentHeatSentThroughFrame[j] -= transfer;
    }
  }

  // Natural/radiator cooling consumes post-transfer heat, allowing connected
  // radiators to create a persistent temperature gradient through the frames.
  for (let i = 0; i < heat.length; i += 1) {
    const thermal = ship.componentThermals[i];
    let coolingRate = thermal.cooling * thermal.retention;
    if (ship.design[i].type === "radiator") coolingRate *= thermal.exposedEdges > 0 ? 1 : 0.25;
    else if (thermal.exposedEdges > 0) coolingRate *= 1.12;
    // Thermodynamics: a hotter body sheds heat faster. Passive dissipation scales
    // with the component's fill ratio — hotspots bleed off quickly — but the floor
    // stays high enough that cool/normal components still dissipate properly
    // (a low floor here starves normal cooling and makes everything creep hot).
    const ratio = Math.max(0, (heat[i] + delta[i]) / Math.max(1, thermal.capacity));
    const tempFactor = 0.7 + 0.9 * ratio * ratio;
    coolingRate *= tempFactor;
    const removed = Math.min(Math.max(0, heat[i] + delta[i]), coolingRate * elapsed);
    ship.componentHeatRemoved[i] += removed;
    if (ship.design[i].type === "radiator") ship.componentHeatRadiated[i] = removed;
    delta[i] -= removed;
  }

  let totalHeat = 0;
  let totalCapacity = 0;
  let hotCount = 0;
  let overheatedCount = 0;
  let availablePower = 0;
  let nominalPower = 0;
  let meltdowns = null;
  if (!ship.componentMeltdown) ship.componentMeltdown = heat.map(() => 0);
  for (let i = 0; i < heat.length; i += 1) {
    const alive = (ship.componentHp?.[i] ?? 1) > 0;
    const capacity = ship.componentThermals[i].capacity;
    const next = Math.max(0, Math.min(capacity * 1.25, heat[i] + delta[i]));
    const oldState = ship.componentHeatState[i];
    const nextState = stateFor(next / capacity, oldState);
    if (nextState !== oldState || Math.abs(next - heat[i]) >= 0.5) ship.dirtyHeat.add(i);
    heat[i] = next;
    ship.componentHeatState[i] = nextState;
    if (alive) {
      totalHeat += next;
      totalCapacity += capacity;
      if (nextState >= STATE.HOT) hotCount += 1;
      if (nextState === STATE.OVERHEATED) overheatedCount += 1;
      const output = PARTS[ship.design[i].type]?.powerGeneration || 0;
      nominalPower += output;
      availablePower += output * performanceForState(nextState);
      // Reactors (power sources) that stay at overheat failure melt down.
      if (output > 0) {
        if (nextState === STATE.OVERHEATED) {
          ship.componentMeltdown[i] += elapsed;
          if (ship.componentMeltdown[i] >= REACTOR_MELTDOWN_SECONDS) (meltdowns || (meltdowns = [])).push(i);
        } else {
          ship.componentMeltdown[i] = Math.max(0, ship.componentMeltdown[i] - elapsed * 2);
        }
      }
    }
    if (next > 0.05) remainsActive = true;
  }
  ship.currentHeat = totalHeat;
  ship.maxHeat = totalCapacity;
  ship.heatPressure = totalCapacity > 0 ? totalHeat / totalCapacity : 0;
  ship.hotComponentCount = hotCount;
  ship.overheatedComponentCount = overheatedCount;
  ship.thermalPowerFactor = nominalPower > 0 ? availablePower / nominalPower : 1;
  ship.hasActiveHeat = remainsActive || ship.hasPassiveHeatSource;
  for (const network of ship.thermalNetworks || []) {
    const members = [...network.frameIndices, ...network.attachedComponents];
    network.totalStoredHeat = members.reduce((sum, index) => sum + heat[index], 0);
    network.totalStorageCapacity = members.reduce((sum, index) => sum + ship.componentThermals[index].capacity, 0);
    network.totalCoolingCapacity = network.sinks.reduce((sum, index) => sum + ship.componentThermals[index].cooling, 0)
      + network.radiators.reduce((sum, index) => sum + ship.componentThermals[index].cooling * (ship.componentThermals[index].exposedEdges ? 1 : 0.25), 0);
    network.totalCooling = network.radiators.reduce((sum, index) => sum + ship.componentHeatRadiated[index], 0)
      + network.sinks.reduce((sum, index) => sum + ship.componentHeatRemoved[index], 0);
    const generation = network.generators.reduce((sum, index) => sum + HeatRules.activityHeat(ship.design[index].type, PARTS[ship.design[index].type] || {}), 0);
    network.overloaded = generation > network.totalCoolingCapacity;
  }

  // Resolve any reactor meltdowns after the thermal state is settled. Detonation
  // deals hp damage to neighbours (not heat), so it cannot instantly cascade; a
  // ship reduced to 0 hull or a destroyed core is finished off here.
  if (meltdowns && room) {
    const { detonateComponent } = require("./componentHealth");
    for (const index of meltdowns) {
      if (ship.componentHp[index] <= 0) continue;
      ship.componentMeltdown[index] = 0;
      detonateComponent(room, ship, index, REACTOR_EXPLOSION_RADIUS, REACTOR_EXPLOSION_DAMAGE, now);
    }
    if (ship.alive && (ship.hp <= 0.001 || ship.coreDestroyed)) {
      require("./combat").destroyShip(room, ship, ship.lastDamagedBy || null, now);
    }
  }
}

function buildHeatDebug(ship) {
  const dt = Math.max(0.001, ship.lastHeatTickDelta || TICK_SECONDS);
  return {
    shipId: ship.id,
    currentHeat: ship.currentHeat,
    maxHeat: ship.maxHeat,
    components: (ship.design || []).map((module, index) => ({
      index,
      type: module.type,
      currentHeat: ship.componentHeat?.[index] || 0,
      generatedPerSecond: (ship.componentHeatGenerated?.[index] || 0) / dt,
      receivedFromNetworkPerSecond: (ship.componentHeatReceived?.[index] || 0) / dt,
      sentThroughFramePerSecond: (ship.componentHeatSentThroughFrame?.[index] || 0) / dt,
      removedByRadiatorPerSecond: (ship.componentHeatRadiated?.[index] || 0) / dt
    })),
    networks: (ship.thermalNetworks || []).map(network => ({
      id: network.id,
      totalHeat: network.totalStoredHeat,
      totalCoolingPerSecond: (network.totalCooling || 0) / dt,
      attachedRadiators: network.radiators.slice(),
      attachedHeatSources: network.generators.slice(),
      overloaded: network.overloaded
    }))
  };
}

module.exports = { STATE, initShipHeat, rebuildThermalNetworks, updateShipHeat, buildHeatDebug, addComponentHeat, addHeatToType, componentPerformance, systemPerformance };
