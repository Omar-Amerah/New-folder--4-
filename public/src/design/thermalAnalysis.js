// Pure thermal analysis helpers shared by blueprint UI and server-style simulations.

import { PART_DEFS, PART_STATS } from "./parts.js";
import { getOccupiedCells } from "./footprint.js";

const thermalAnalysisCache = new Map();
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/**
 * Build immutable topology and rule profiles for a ship design.
 * @param {Array<{type:string,x:number,y:number,rotation?:number}>} design - Blueprint modules indexed by component id.
 * @returns {object} Thermal model containing profiles, footprints, adjacency, exposure, frame networks, and heat-transfer paths to cooling components.
 */
export function buildThermalModel(design) {
  const rules = globalThis.HeatRules;
  const owners = new Map();
  const cells = [];
  for (let i = 0; i < design.length; i += 1) {
    const module = design[i];
    const stat = PART_STATS[module.type] || PART_STATS.frame;
    const occupied = getOccupiedCells(module.x, module.y, stat.footprint || { width: 1, height: 1 }, module.rotation || 0);
    cells[i] = occupied;
    for (const cell of occupied) owners.set(`${cell.x},${cell.y}`, i);
  }
  const occupiedCoords = [...owners.keys()].map(key => key.split(",").map(Number));
  const exteriorEmpty = new Set();
  if (occupiedCoords.length) {
    const xs = occupiedCoords.map(cell => cell[0]), ys = occupiedCoords.map(cell => cell[1]);
    const minX = Math.min(...xs) - 1, maxX = Math.max(...xs) + 1, minY = Math.min(...ys) - 1, maxY = Math.max(...ys) + 1;
    const queue = [[minX, minY]]; exteriorEmpty.add(`${minX},${minY}`);
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const [x,y] = queue[cursor];
      for (const [dx,dy] of DIRS) {
        const nx=x+dx, ny=y+dy, key=`${nx},${ny}`;
        if (nx<minX||nx>maxX||ny<minY||ny>maxY||owners.has(key)||exteriorEmpty.has(key)) continue;
        exteriorEmpty.add(key); queue.push([nx,ny]);
      }
    }
  }
  const exposed = design.map(() => 0);
  const exteriorDirections = design.map(() => new Set());
  const edgeMaps = design.map(() => new Map());
  for (let i = 0; i < design.length; i += 1) for (const cell of cells[i]) for (const [dx,dy] of DIRS) {
    const neighbour = owners.get(`${cell.x + dx},${cell.y + dy}`);
    if (neighbour === undefined && exteriorEmpty.has(`${cell.x + dx},${cell.y + dy}`)) {
      exposed[i] += 1;
      exteriorDirections[i].add(dx < 0 ? "left" : dx > 0 ? "right" : dy < 0 ? "top" : "bottom");
    }
    else if (neighbour !== undefined && neighbour !== i) edgeMaps[i].set(neighbour, (edgeMaps[i].get(neighbour) || 0) + 1);
  }
  const profiles = design.map((module, i) => {
    const value = { ...rules.profile(module.type, PART_STATS[module.type] || {}), exposedEdges: exposed[i] };
    value.capacity += [...edgeMaps[i].keys()].filter(j => design[j].type === "heatSink").length * 35;
    return value;
  });
  const edges = [];
  for (let i = 0; i < design.length; i += 1) for (const [j, sharedEdges] of edgeMaps[i]) if (j > i) {
    edges.push({ i, j, sharedEdges, conductivity: rules.edgeConductivity(profiles[i], profiles[j]) });
  }
  const frameCoolingDistance = design.map(() => Infinity);
  const coolingFrames = [];
  for (let i = 0; i < design.length; i += 1) {
    if (!isFrame(design[i].type)) continue;
    if ([...edgeMaps[i].keys()].some(j => design[j].type === "radiator" || design[j].type === "heatSink")) {
      frameCoolingDistance[i] = 0; coolingFrames.push(i);
    }
  }
  for (let cursor = 0; cursor < coolingFrames.length; cursor += 1) {
    const frame = coolingFrames[cursor];
    for (const neighbour of edgeMaps[frame].keys()) {
      if (!isFrame(design[neighbour].type) || frameCoolingDistance[neighbour] <= frameCoolingDistance[frame] + 1) continue;
      frameCoolingDistance[neighbour] = frameCoolingDistance[frame] + 1; coolingFrames.push(neighbour);
    }
  }
  return { design, rules, owners, cells, exposed, exteriorDirections, edgeMaps, profiles, edges, frameCoolingDistance };
}

/**
 * Build per-component activity and heat-generation rates for a named thermal scenario.
 * @param {object} model - Output from buildThermalModel().
 * @param {"idle"|"combat"|"full"|string} mode - Load scenario.
 * @returns {{mode:string,generationRates:number[]}} Heat generation rates in heat/second by design index.
 */
export function buildThermalLoad(model, mode = "full", wiring = null, options = {}) {
  const { design, rules } = model;
  let wiringAnalysis = null, power = null;
  try { wiringAnalysis = wiring ? globalThis.WiringRules.analyzeWiring(design, wiring, PART_STATS) : null; power = wiringAnalysis?.power || null; } catch (_) { power = null; }
  const initialStoredHeat = buildInitialStoredHeat(design, model.profiles || [], rules, options);
  const initialHeatStates = buildInitialHeatStates(design, model.profiles || [], rules, initialStoredHeat, options);
  const initialGeneratorAvailability = design.map((module, i) => isPowerGenerator(module.type) && initialHeatStates[i] !== rules.STATE.OVERHEATED);
  const powerState = buildPredictedPowerState(design, power, initialGeneratorAvailability);
  const powerMultiplier = powerState.multipliers;
  const loadMultiplier = (_module, stat) => {
    if (mode === "idle") return (stat.powerGeneration || 0) > 0 ? 0.2 : (stat.shieldRegen || 0) > 0 ? 0.08 : 0;
    if (mode === "combat") {
      if (stat.weapon) return 0.72;
      if ((stat.thrust || 0) > 0) return 0.55;
      if ((stat.shieldRegen || 0) > 0) return 0.65;
      if ((stat.powerGeneration || 0) > 0) return 0.78;
      if ((stat.repairRate || 0) > 0) return 0.45;
      return 0.25;
    }
    return 1;
  };
  const designExhaust = globalThis.EngineExhaustRules.analyze(design, PART_STATS);
  const dataSupport = buildPredictedDataSupport(design, wiringAnalysis, powerMultiplier, { ...options, sourceHeatStates: options.sourceHeatStates || Object.fromEntries(initialHeatStates.map((state, i) => [i, state])) });
  const generationRates = buildPredictedGenerationRates(design, rules, mode, loadMultiplier, designExhaust, dataSupport, powerMultiplier, powerState);
  return {
    mode, powerMultiplier, initialPowerMultiplier: [...powerMultiplier], powerState, power, wiringAnalysis, dataSupport, loadMultiplier, designExhaust,
    generationRates, initialStoredHeat, initialHeatStates
  };
}

/**
 * Run a deterministic fixed-timestep thermal simulation.
 * @param {object} model - Output from buildThermalModel().
 * @param {{generationRates:number[]}} load - Output from buildThermalLoad().
 * @param {{maxSteps?:number}} [options] - Simulation limits.
 * @returns {object} Raw simulation arrays and aggregate timing/cooling measurements.
 */
export function simulateThermalLoad(model, load, options = {}) {
  const { design, rules, profiles, edges, exposed, frameCoolingDistance } = model;
  let generationRates = [...load.generationRates];
  const mutablePower = load.powerState ? clonePredictedPowerState(load.powerState) : null;
  let powerMultiplier = mutablePower?.multipliers || [...(load.powerMultiplier || design.map(() => 1))];
  let dataSupport = load.dataSupport;
  let generatorShutdownCount = 0, powerReallocationCount = 0, dataReallocationCount = 0;
  let initialPowerMultiplier = [...powerMultiplier];
  let minimumPowerMultiplier = [...powerMultiplier];
  const powerMultiplierTotals = design.map(() => 0);
  const inheritedInitialValues = options.initialHeatStates == null && options.initialHeatValues == null && options.initialHeatRatios == null ? load.initialStoredHeat : undefined;
  const inheritedInitialStates = options.initialHeatStates == null && options.initialHeatValues == null && options.initialHeatRatios == null ? load.initialHeatStates : undefined;
  const heat = buildInitialStoredHeat(design, profiles, rules, { ...options, initialHeatValues: options.initialHeatValues ?? inheritedInitialValues });
  const states = buildInitialHeatStates(design, profiles, rules, heat, { ...options, initialHeatStates: options.initialHeatStates ?? inheritedInitialStates });
  let generatorAvailability = design.map((module, i) => isPowerGenerator(module.type) && states[i] !== rules.STATE.OVERHEATED);
  if (mutablePower) {
    powerMultiplier = recalculatePredictedPowerState(mutablePower, design, generatorAvailability);
    dataSupport = buildPredictedDataSupport(design, load.wiringAnalysis, powerMultiplier, { sourceHeatStates: Object.fromEntries(states.map((state, i) => [i, state])) });
    generationRates = buildPredictedGenerationRates(design, rules, load.mode, load.loadMultiplier, load.designExhaust, dataSupport, powerMultiplier, mutablePower);
    initialPowerMultiplier = [...powerMultiplier];
    minimumPowerMultiplier = [...powerMultiplier];
  }
  const received = design.map(() => 0);
  const transferredOut = design.map(() => 0);
  const cooling = design.map(() => 0);
  const componentVentedOverflowHeat = design.map(() => 0);
  const generatedHeat = design.map(() => 0);
  const timeToOverheat = design.map(() => null);
  const peakRatios = design.map(() => 0);
  const overheatedIndices = new Set();
  const meltdownTimers = design.map(() => 0);
  const meltdownTime = design.map(() => null);
  const uptimeTicks = { weapon: 0, engine: 0, shield: 0 };
  const uptimeTotals = { weapon: 0, engine: 0, shield: 0 };
  let firstOverheatTime = null, firstOverheatIndex = -1, equilibriumTime = null, equilibriumTicks = 0, previousTotalHeat = 0;
  let heatSinkSaturationTime = null, radiatorRemovedTotal = 0, totalCoolingRemoved = 0, totalVentedOverflowHeat = 0, totalAvailableCooling = 0, totalGeneratedHeat = 0, peakAvailableCoolingRate = 0, finalAvailableCoolingRate = 0, finalEffectiveCoolingRate = 0, simulatedSeconds = 0, finalFlows = [];
  let previousDataSourceSignature = buildDataSourceSignature(design, states, powerMultiplier);
  const dt = rules.TICK_SECONDS;
  for (let step = 0; step < (options.maxSteps || 1500); step += 1) {
    simulatedSeconds = (step + 1) * dt;
    const delta = design.map(() => 0);
    let tickEffectiveCoolingRate = 0;
    let tickAvailableCoolingRate = 0;
    received.fill(0); transferredOut.fill(0); cooling.fill(0);
    if (mutablePower) {
      const nextAvailability = design.map((module, i) => isPowerGenerator(module.type) && states[i] !== rules.STATE.OVERHEATED);
      if (nextAvailability.some((value, i) => value !== generatorAvailability[i])) {
        for (let i = 0; i < nextAvailability.length; i += 1) if (generatorAvailability[i] && !nextAvailability[i]) generatorShutdownCount += 1;
        generatorAvailability = nextAvailability;
        powerMultiplier = recalculatePredictedPowerState(mutablePower, design, generatorAvailability);
        powerReallocationCount += 1;
        dataSupport = buildPredictedDataSupport(design, load.wiringAnalysis, powerMultiplier, { sourceHeatStates: Object.fromEntries(states.map((state, i) => [i, state])) });
        dataReallocationCount += 1;
        previousDataSourceSignature = buildDataSourceSignature(design, states, powerMultiplier);
        generationRates = buildPredictedGenerationRates(design, rules, load.mode, load.loadMultiplier, load.designExhaust, dataSupport, powerMultiplier, mutablePower);
      }
    }
    const dataSourceSignature = buildDataSourceSignature(design, states, powerMultiplier);
    if (dataSourceSignature !== previousDataSourceSignature) {
      dataSupport = buildPredictedDataSupport(design, load.wiringAnalysis, powerMultiplier, { sourceHeatStates: Object.fromEntries(states.map((state, i) => [i, state])) });
      dataReallocationCount += 1;
      previousDataSourceSignature = dataSourceSignature;
      generationRates = buildPredictedGenerationRates(design, rules, load.mode, load.loadMultiplier, load.designExhaust, dataSupport, powerMultiplier, mutablePower);
    }
    for (let i = 0; i < design.length; i += 1) { powerMultiplierTotals[i] += powerMultiplier[i] ?? 0; minimumPowerMultiplier[i] = Math.min(minimumPowerMultiplier[i] ?? 1, powerMultiplier[i] ?? 0); }
    for (let i = 0; i < design.length; i += 1) {
      const performance = rules.performanceForState(states[i]);
      const stat = PART_STATS[design[i].type] || {};
      const heatScale = (stat.powerGeneration || 0) > 0 ? (states[i] === rules.STATE.OVERHEATED ? 0 : 1) : stat.weapon ? performance : performance > 0 ? 1 : 0;
      const generated = generationRates[i] * heatScale * dt;
      delta[i] += generated; generatedHeat[i] += generated; totalGeneratedHeat += generated;
      const category = stat.weapon ? "weapon" : (stat.thrust || 0) > 0 ? "engine" : (stat.shieldRegen || 0) > 0 ? "shield" : null;
      if (category) { uptimeTicks[category] += performance; uptimeTotals[category] += 1; }
    }
    const workingHeat = heat.map((value, i) => Math.max(0, value + delta[i]));
    finalFlows = [];
    const pendingTransfers = [];
    const outflow = design.map(() => 0);
    for (const edge of edges) {
      const frameI = isFrame(design[edge.i].type), frameJ = isFrame(design[edge.j].type);
      const routedI = Number.isFinite(frameCoolingDistance[edge.i]), routedJ = Number.isFinite(frameCoolingDistance[edge.j]);
      let conductivity = edge.conductivity;
      if (frameI && frameJ && (routedI || routedJ)) conductivity *= rules.NETWORK_FRAME_BOOST;
      else if ((frameI && routedI) || (frameJ && routedJ)) conductivity *= rules.NETWORK_ATTACHMENT_BOOST;
      const amount = rules.edgeTransfer(workingHeat[edge.i], profiles[edge.i].capacity, workingHeat[edge.j], profiles[edge.j].capacity, conductivity, edge.sharedEdges, dt);
      if (amount === 0) continue;
      pendingTransfers.push({ i: edge.i, j: edge.j, amount });
      outflow[amount > 0 ? edge.i : edge.j] += Math.abs(amount);
    }
    for (const pending of pendingTransfers) {
      const source = pending.amount > 0 ? pending.i : pending.j;
      const scale = outflow[source] > workingHeat[source] ? workingHeat[source] / outflow[source] : 1;
      const amount = pending.amount * scale;
      delta[pending.i] -= amount; delta[pending.j] += amount;
      if (amount > 0) { transferredOut[pending.i] += amount; received[pending.j] += amount; }
      else { received[pending.i] -= amount; transferredOut[pending.j] -= amount; }
      if (Math.abs(amount) / dt >= 0.35) finalFlows.push({ from: amount > 0 ? pending.i : pending.j, to: amount > 0 ? pending.j : pending.i, amount: Math.abs(amount) / dt });
    }
    for (let i = 0; i < design.length; i += 1) {
      let coolingRate = profiles[i].cooling * profiles[i].retention;
      if (design[i].type === "radiator") {
        const exposure = exposed[i] > 0 ? 1 : 0.25;
        const activeCooling = profiles[i].cooling * rules.activeCoolingForState(states[i]) * (powerMultiplier[i] ?? 1);
        const passiveFloor = profiles[i].cooling * 0.12;
        coolingRate = Math.max(passiveFloor, activeCooling) * exposure * profiles[i].retention;
      }
      else if (exposed[i] > 0) coolingRate *= 1.12;
      const coolRatio = Math.max(0, (heat[i] + delta[i]) / Math.max(1, profiles[i].capacity));
      coolingRate *= 0.7 + 0.9 * coolRatio * coolRatio;
      tickAvailableCoolingRate += coolingRate;
      cooling[i] = Math.min(Math.max(0, heat[i] + delta[i]), coolingRate * dt);
      totalCoolingRemoved += cooling[i]; tickEffectiveCoolingRate += cooling[i] / dt;
      if (design[i].type === "radiator") radiatorRemovedTotal += cooling[i];
      delta[i] -= cooling[i];
    }
    for (let i = 0; i < design.length; i += 1) {
      const retainedCeiling = Math.max(profiles[i].capacity * 1.25, heat[i]);
      const unclampedNext = Math.max(0, heat[i] + delta[i]);
      const next = Math.min(retainedCeiling, unclampedNext);
      const overflow = Math.max(0, unclampedNext - next);
      if (overflow > 0) { componentVentedOverflowHeat[i] += overflow; totalVentedOverflowHeat += overflow; }
      heat[i] = next;
      states[i] = rules.stateFor(heat[i] / profiles[i].capacity, states[i]);
      const ratio = heat[i] / profiles[i].capacity;
      peakRatios[i] = Math.max(peakRatios[i], ratio);
      if (states[i] === rules.STATE.OVERHEATED) {
        overheatedIndices.add(i);
        if (timeToOverheat[i] === null) timeToOverheat[i] = (step + 1) * dt;
        if (firstOverheatTime === null) { firstOverheatTime = (step + 1) * dt; firstOverheatIndex = i; }
      }
      if ((PART_STATS[design[i].type]?.powerGeneration || 0) > 0) {
        if (states[i] === rules.STATE.OVERHEATED) {
          meltdownTimers[i] += dt;
          if (meltdownTime[i] === null && meltdownTimers[i] >= rules.REACTOR_MELTDOWN_SECONDS) meltdownTime[i] = (step + 1) * dt;
        } else meltdownTimers[i] = Math.max(0, meltdownTimers[i] - dt * 2);
      }
      if (design[i].type === "heatSink" && ratio >= .9 && heatSinkSaturationTime === null) heatSinkSaturationTime = (step + 1) * dt;
    }
    peakAvailableCoolingRate = Math.max(peakAvailableCoolingRate, tickAvailableCoolingRate);
    totalAvailableCooling += tickAvailableCoolingRate * dt;
    finalAvailableCoolingRate = tickAvailableCoolingRate;
    finalEffectiveCoolingRate = tickEffectiveCoolingRate;
    const totalHeatNow = heat.reduce((sum, value) => sum + value, 0);
    const changePerSecond = Math.abs(totalHeatNow - previousTotalHeat) / dt;
    equilibriumTicks = step > 20 && changePerSecond < 0.04 && !overheatedIndices.size ? equilibriumTicks + 1 : 0;
    if (equilibriumTime === null && equilibriumTicks >= 50) equilibriumTime = (step + 1) * dt;
    previousTotalHeat = totalHeatNow;
    if (equilibriumTime !== null && step * dt > equilibriumTime + 5) break;
  }
  const averagePowerMultiplier = powerMultiplierTotals.map(value => simulatedSeconds > 0 ? value / Math.max(1, Math.round(simulatedSeconds / dt)) : 0);
  return { heat, states, received, transferredOut, cooling, componentVentedOverflowHeat, totalVentedOverflowHeat, generatedHeat, timeToOverheat, peakRatios, overheatedIndices, meltdownTime, uptimeTicks, uptimeTotals, firstOverheatTime, firstOverheatIndex, equilibriumTime, heatSinkSaturationTime, radiatorRemovedTotal, totalCoolingRemoved, totalAvailableCooling, totalGeneratedHeat, peakAvailableCoolingRate, finalAvailableCoolingRate, finalEffectiveCoolingRate, averageAvailableCoolingRate: simulatedSeconds > 0 ? totalAvailableCooling / simulatedSeconds : 0, averageActualCoolingRate: simulatedSeconds > 0 ? totalCoolingRemoved / simulatedSeconds : 0, simulatedSeconds, finalFlows, dt, initialPowerMultiplier, finalPowerMultiplier: [...powerMultiplier], minimumPowerMultiplier, averagePowerMultiplier, generatorShutdownCount, powerReallocationCount, dataReallocationCount, dataSupport };
}

/**
 * Convert raw simulation data into the legacy UI/server-friendly analysis shape.
 * @param {object} model - Output from buildThermalModel().
 * @param {object} load - Output from buildThermalLoad().
 * @param {object} simulation - Output from simulateThermalLoad().
 * @returns {object} Summary metrics, predictions, classes, networks, and warnings.
 */
export function summariseThermalResult(model, load, simulation) {
  const { design, rules, profiles, exposed, exteriorDirections, edgeMaps } = model;
  const { generationRates } = load;
  const { peakRatios, received, transferredOut, cooling, dt, timeToOverheat, meltdownTime, overheatedIndices, uptimeTotals, uptimeTicks, equilibriumTime, firstOverheatTime, firstOverheatIndex, finalFlows, heatSinkSaturationTime, radiatorRemovedTotal, simulatedSeconds } = simulation;
  const predictions = new Map();
  for (let i = 0; i < design.length; i += 1) {
    const isRadiator = design[i].type === "radiator";
    const isExposed = exposed[i] > 0;
    predictions.set(design[i], {
      heat: peakRatios[i] * profiles[i].capacity, capacity: profiles[i].capacity, ratio: peakRatios[i],
      generation: generationRates[i], received: received[i] / dt, transferredOut: transferredOut[i] / dt,
      cooling: cooling[i] / dt, state: rules.stateFor(peakRatios[i], rules.STATE.NORMAL), timeToOverheat: timeToOverheat[i],
      meltdownTime: meltdownTime[i],
      exposedEdges: exposed[i],
      exteriorDirections: [...exteriorDirections[i]],
      exposureCoolingMultiplier: isRadiator ? (isExposed ? 1 : 0.25) : (isExposed ? 1.12 : 1),
      powerMultiplier: simulation.finalPowerMultiplier?.[i] ?? load.powerMultiplier?.[i] ?? 1,
      initialPowerMultiplier: simulation.initialPowerMultiplier?.[i] ?? load.powerMultiplier?.[i] ?? 1,
      minimumPowerMultiplier: simulation.minimumPowerMultiplier?.[i] ?? load.powerMultiplier?.[i] ?? 1,
      radiatorEffectiveCooling: isRadiator ? cooling[i] / dt : 0,
      dataSupportMultiplier: (simulation.dataSupport || load.dataSupport)?.weaponSupportByIndex?.[i]?.fireRateBonus ? 1 + (simulation.dataSupport || load.dataSupport).weaponSupportByIndex[i].fireRateBonus : 1,
      componentVentedOverflowHeat: simulation.componentVentedOverflowHeat?.[i] || 0
    });
  }
  const networks = buildThermalNetworks(model, generationRates);
  const problems = findThermalProblems(model, { ...simulation, networks }, load);
  const actionItems = generateThermalAdvice(problems, model);
  const hottestIndex = peakRatios.reduce((best, value, i) => value > peakRatios[best] ? i : best, 0);
  const componentNetwork = design.map(() => []);
  for (const network of networks) for (const index of [...network.frameIndices, ...network.attached]) componentNetwork[index].push(network.id);
  const componentClasses = new Map(design.map((module, i) => {
    const percent = Math.max(0, Math.min(100, Math.round(peakRatios[i] * 100)));
    const stateClass = percent >= 100 ? "heat-ui-overheated" : percent >= 76 ? "heat-ui-critical" : percent >= 51 ? "heat-ui-hot" : percent >= 26 ? "heat-ui-warm" : "heat-ui-cool";
    const network = componentNetwork[i].length ? networks[componentNetwork[i][0]] : null;
    const networkClass = network ? `thermal-network-${network.id % 4}` : "";
    const frameLoad = isFrame(module.type) ? (peakRatios[i] >= .76 ? " thermal-frame-heavy" : peakRatios[i] >= .26 ? " thermal-frame-moderate" : " thermal-frame-cool") : "";
    const broken = isFrame(module.type) && (network?.isolated || problems.criticalFrames.has(i)) ? " thermal-route-broken" : "";
    const coolingEffect = module.type === "heatSink" ? " heat-sink-absorption" : module.type === "radiator" && exposed[i] ? ` radiator-exposed radiator-exposed-${[...exteriorDirections[i]][0] || "right"}` : "";
    return [module, `${stateClass} ${networkClass}${frameLoad}${broken}${coolingEffect}`.trim()];
  }));
  const componentHeat = new Map(design.map((module, i) => [module, Math.round(peakRatios[i] * 100)]));
  const generation = generationRates.reduce((sum, value) => sum + value, 0);
  const nominalCoolingRate = profiles.reduce((sum, item, i) => sum + (design[i].type === "radiator" ? item.cooling * (exposed[i] ? 1 : 0.25) : item.cooling * (exposed[i] ? 1.12 : 1)), 0);
  const totalCoolingRemoved = simulation.totalCoolingRemoved ?? 0;
  const coolingRate = simulation.averageAvailableCoolingRate ?? (simulatedSeconds > 0 ? totalCoolingRemoved / simulatedSeconds : 0);
  const averageActualCoolingRate = simulation.averageActualCoolingRate ?? (simulatedSeconds > 0 ? totalCoolingRemoved / simulatedSeconds : 0);
  const averageGenerationRate = simulatedSeconds > 0 ? (simulation.totalGeneratedHeat ?? generation * simulatedSeconds) / simulatedSeconds : generation;
  let radiators = 0, exposedRadiators = 0;
  design.forEach((module, i) => { if (module.type === "radiator") { radiators += 1; if (exposed[i]) exposedRadiators += 1; } });
  const peakPredictedHeat = peakRatios.length ? Math.max(...peakRatios) : 0;
  const reserve = coolingRate - averageGenerationRate;
  const balance = overheatedIndices.size ? "Unsustainable" : equilibriumTime !== null && peakPredictedHeat < .76 && reserve >= 0 ? "Stable" : "Marginal";
  const hottestNetwork = networks.length ? networks.reduce((best, network) => {
    const members = [...network.frameIndices, ...network.attached];
    const score = members.length ? Math.max(...members.map(i => peakRatios[i] || 0)) : 0;
    return !best || score > best.score ? { network, score } : best;
  }, null) : null;
  const radiatorCapacitySeconds = design.reduce((sum, module, i) => module.type === "radiator" ? sum + profiles[i].cooling * (exposed[i] ? 1 : .25) * simulatedSeconds : sum, 0);
  const actualCooling = design.reduce((sum, _module, i) => sum + cooling[i] / dt, 0);
  return {
    componentClasses, componentHeat, predictions, flows: finalFlows, networks, criticalFrames: problems.criticalFrames, problemIndices: problems.problemIndices, overloadedNetworkIds: problems.overloadedNetworkIds, exteriorDirections, actionItems,
    cooling: coolingRate >= averageGenerationRate * .7 ? "Good" : coolingRate >= averageGenerationRate * .4 ? "Fair" : "Poor",
    sustained: averageGenerationRate > coolingRate * 1.8 ? "High" : averageGenerationRate > coolingRate ? "Moderate" : "Low",
    hotspot: design[hottestIndex] ? `${PART_DEFS[design[hottestIndex].type]?.name || design[hottestIndex].type} cluster` : "None",
    exposure: !radiators ? "None" : exposedRadiators === radiators ? "Good" : exposedRadiators ? "Fair" : "Poor",
    coolingRate: coolingRate.toFixed(1), nominalCoolingRate: nominalCoolingRate.toFixed(1),
    routeWarning: problems.unroutedHot.length ? `${problems.unroutedHot.length} hot component${problems.unroutedHot.length === 1 ? " has" : "s have"} no frame path to a radiator or Heat Sink` : "All hot systems can reach a radiator or Heat Sink",
    networkWarning: problems.overloadedNetworks.length ? `${problems.overloadedNetworks.length} thermal network overloaded` : "Thermal networks within capacity",
    severWarning: problems.criticalFrames.size ? `${problems.criticalFrames.size} frame block${problems.criticalFrames.size === 1 ? "" : "s"} could sever heat transfer to cooling components` : "No single-frame heat-transfer bottleneck",
    meltdownWarning: problems.meltdownIndices.length ? `${problems.meltdownIndices.length} reactor${problems.meltdownIndices.length === 1 ? "" : "s"} predicted to melt down and explode` : "No reactor meltdowns predicted",
    analysis: {
      mode: load.mode, generation: averageGenerationRate, cooling: coolingRate, nominalCoolingRate, averageEffectiveCoolingRate: coolingRate, averageAvailableCoolingRate: coolingRate, averageActualCoolingRate, finalAvailableCoolingRate: simulation.finalAvailableCoolingRate ?? coolingRate, finalEffectiveCoolingRate: simulation.finalEffectiveCoolingRate ?? averageActualCoolingRate, peakAvailableCoolingRate: simulation.peakAvailableCoolingRate ?? coolingRate, totalCoolingRemoved, totalVentedOverflowHeat: simulation.totalVentedOverflowHeat || 0, componentVentedOverflowHeat: simulation.componentVentedOverflowHeat || [], averageGenerationRate, netAverageHeatRate: averageGenerationRate - coolingRate, net: averageGenerationRate - coolingRate, balance,
      firstOverheatTime, firstOverheatIndex, overheatedCount: overheatedIndices.size,
      meltdownCount: problems.meltdownIndices.length, firstMeltdownTime: problems.firstMeltdownTime, firstMeltdownIndex: problems.firstMeltdownIndex,
      equilibriumTime, peakPredictedHeat, reserve, predictedBalance: balance, actualCooling, actionItems, initialPowerMultiplier: simulation.initialPowerMultiplier, finalPowerMultiplier: simulation.finalPowerMultiplier, minimumPowerMultiplier: simulation.minimumPowerMultiplier, generatorShutdownCount: simulation.generatorShutdownCount || 0, powerReallocationCount: simulation.powerReallocationCount || 0,
      hottestNetwork: hottestNetwork ? describeThermalNetwork(hottestNetwork.network, design) : "No frame network",
      weaponUptime: uptimeTotals.weapon ? uptimeTicks.weapon / uptimeTotals.weapon : 1,
      engineEfficiency: uptimeTotals.engine ? uptimeTicks.engine / uptimeTotals.engine : 1,
      shieldUptime: uptimeTotals.shield ? uptimeTicks.shield / uptimeTotals.shield : 1,
      radiatorUtilisation: radiatorCapacitySeconds > 0 ? Math.min(1, radiatorRemovedTotal / radiatorCapacitySeconds) : 0,
      heatSinkSaturationTime
    }
  };
}

/**
 * Detect thermal routing and capacity problems from a completed simulation.
 * @param {object} model - Output from buildThermalModel().
 * @param {object} simulation - Simulation data plus optional precomputed networks.
 * @param {{generationRates:number[]}} load - Output from buildThermalLoad().
 * @returns {object} Problem sets for unrouted sources, overloaded networks, bottlenecks, sink saturation, and meltdown risk.
 */
export function findThermalProblems(model, simulation, load) {
  const { design, edgeMaps, rules } = model;
  const generationRates = load.generationRates;
  const networks = simulation.networks || buildThermalNetworks(model, generationRates);
  const frameSet = new Set(design.map((module, i) => isFrame(module.type) ? i : -1).filter(i => i >= 0));
  function generatorHasCoolingRoute(generator, removedFrame = -1) {
    const starts = [...edgeMaps[generator].keys()].filter(i => frameSet.has(i) && i !== removedFrame);
    const seen = new Set(starts), queue = starts.slice();
    for (let cursor = 0; cursor < queue.length; cursor += 1) for (const neighbour of edgeMaps[queue[cursor]].keys()) {
      if (frameSet.has(neighbour) && neighbour !== removedFrame && !seen.has(neighbour)) { seen.add(neighbour); queue.push(neighbour); }
    }
    return [...seen].some(frame => [...edgeMaps[frame].keys()].some(i => i !== generator && (design[i].type === "heatSink" || design[i].type === "radiator")));
  }
  const routedGenerators = generationRates.map((rate, i) => rate > 0 && generatorHasCoolingRoute(i));
  const criticalFrames = new Set();
  for (const frame of frameSet) if (generationRates.some((rate, i) => rate > 0 && routedGenerators[i] && !generatorHasCoolingRoute(i, frame))) criticalFrames.add(frame);
  const unroutedHot = generationRates.map((rate, i) => rate > 0 && !routedGenerators[i] && simulation.peakRatios[i] >= rules.THRESHOLDS.hot ? i : -1).filter(i => i >= 0);
  const meltdownIndices = simulation.meltdownTime.map((time, i) => time === null ? -1 : i).filter(i => i >= 0);
  const firstMeltdownIndex = meltdownIndices.reduce((best, i) => best < 0 || simulation.meltdownTime[i] < simulation.meltdownTime[best] ? i : best, -1);
  const overloadedNetworks = networks.filter(network => network.overloaded);
  return {
    unroutedHot,
    overloadedNetworks,
    criticalFrames,
    heatSinkSaturationTime: simulation.heatSinkSaturationTime,
    meltdownIndices,
    firstMeltdownIndex,
    firstMeltdownTime: firstMeltdownIndex >= 0 ? simulation.meltdownTime[firstMeltdownIndex] : null,
    problemIndices: {
      unroutedHot: new Set(unroutedHot),
      criticalFrames: new Set(criticalFrames),
      meltdown: new Set(meltdownIndices)
    },
    overloadedNetworkIds: new Set(overloadedNetworks.map(network => network.id))
  };
}

/**
 * Produce ordered player-facing recommendations from detected thermal problems.
 * @param {object} problems - Output from findThermalProblems().
 * @param {object} model - Output from buildThermalModel().
 * @returns {string[]} Ordered recommendation strings.
 */
export function generateThermalAdvice(problems, model) {
  const { design } = model;
  const actionItems = [];
  if (problems.unroutedHot.length) actionItems.push(`${describeThermalComponent(problems.unroutedHot[0], design)} has no frame/heat-pipe path to a radiator or Heat Sink.`);
  if (problems.overloadedNetworks.length) {
    const network = problems.overloadedNetworks[0];
    actionItems.push(`${describeThermalNetwork(network, design)} is overloaded by ${(network.generation - network.cooling).toFixed(1)} H/s; add exposed radiators or split the heat-transfer path.`);
  }
  if (problems.criticalFrames.size) actionItems.push(`${describeThermalComponent([...problems.criticalFrames][0], design)} is a single-frame heat-transfer bottleneck; add a parallel frame or heat-pipe path.`);
  if (problems.heatSinkSaturationTime !== null) actionItems.push(`A heat sink saturates at ${problems.heatSinkSaturationTime.toFixed(1)} s; pair it with more exposed radiator output.`);
  if (problems.meltdownIndices.length) actionItems.push(`${describeThermalComponent(problems.firstMeltdownIndex, design)} is predicted to melt down; transfer reactor heat away or reduce sustained load.`);
  return actionItems;
}

/**
 * Public legacy facade that orchestrates model, load, simulation, summary, problem, and advice phases.
 * @param {Array<{type:string,x:number,y:number,rotation?:number}>} design - Blueprint modules.
 * @param {string} [mode="full"] - Thermal scenario: idle, combat, or full.
 * @returns {object} Legacy thermal-analysis result consumed by existing UI callers.
 */
export function analyzeDesignHeat(design, wiring = null, mode = "full") {
  if (typeof wiring === "string") { mode = wiring; wiring = null; }
  const types = [...new Set(design.map(module => module.type))];
  const thermalSignature = types.map(type => {
    const stat = PART_STATS[type] || {};
    return [type, stat.powerGeneration, stat.thrust, stat.shieldRegen, stat.repairRate, stat.weapon?.damage, stat.weapon?.fireRate].join(":");
  }).join("|");
  const cacheKey = `${mode}|${thermalSignature}|${JSON.stringify(wiring)}|${JSON.stringify(design.map(module => [module.type,module.x,module.y,module.rotation || 0]))}`;
  const cached = thermalAnalysisCache.get(cacheKey);
  if (cached?.design === design) return cached.result;
  const model = buildThermalModel(design);
  const load = buildThermalLoad(model, mode, wiring);
  const simulation = simulateThermalLoad(model, load);
  const result = summariseThermalResult(model, load, simulation);
  if (thermalAnalysisCache.size > 24) thermalAnalysisCache.clear();
  thermalAnalysisCache.set(cacheKey, { design, result });
  return result;
}

function representativeRatioForState(state, rules) {
  if (state === rules.STATE.NORMAL) return 0.05;
  if (state === rules.STATE.WARM) return 0.50;
  if (state === rules.STATE.HOT) return 0.75;
  if (state === rules.STATE.CRITICAL) return 0.92;
  if (state === rules.STATE.OVERHEATED) return 1.04;
  return 0;
}
function buildInitialStoredHeat(design, profiles, rules, options = {}) {
  return design.map((_, i) => {
    if (options.initialHeatValues?.[i] != null) return Math.max(0, Number(options.initialHeatValues[i]) || 0);
    if (options.initialHeatRatios?.[i] != null) return Math.max(0, Number(options.initialHeatRatios[i]) || 0) * Math.max(1, profiles[i]?.capacity || 1);
    if (options.initialHeatStates?.[i] != null) return representativeRatioForState(options.initialHeatStates[i], rules) * Math.max(1, profiles[i]?.capacity || 1);
    return 0;
  });
}
function buildInitialHeatStates(design, profiles, rules, heat, options = {}) {
  return design.map((_, i) => {
    const capacity = Math.max(1, profiles[i]?.capacity || 1);
    const derived = rules.stateFor((heat[i] || 0) / capacity, rules.STATE.NORMAL);
    const supplied = options.initialHeatStates?.[i];
    const hasStoredOverride = options.initialHeatValues?.[i] != null || options.initialHeatRatios?.[i] != null;
    if (supplied == null || !hasStoredOverride) return derived;
    const suppliedRatio = representativeRatioForState(supplied, rules);
    if (rules.stateFor(suppliedRatio, rules.STATE.NORMAL) !== supplied) throw new Error(`Initial Heat state for component ${i} is not representable`);
    if (derived !== supplied) throw new Error(`Initial Heat state for component ${i} (${supplied}) does not match stored Heat state (${derived})`);
    return supplied;
  });
}
function buildDataSourceSignature(design, states, powerMultiplier) {
  const rules = globalThis.DataSupportRules;
  if (!rules?.isDataSupportSource) return "";
  return design.map((module, i) => rules.isDataSupportSource(module.type) ? `${i}:${states[i]}:${globalThis.HeatRules.activeOutputForState(states[i])}:${powerMultiplier[i] ?? 0}:1` : null).filter(Boolean).join('|');
}

function isPowerGenerator(type) { return (Number(PART_STATS[type]?.powerGeneration) || 0) > 0; }
function buildPredictedPowerState(design, power, available = null) {
  const networks = (power?.networks || []).map(network => ({ ...network, sourceIndices: [...(network.sourceIndices || [])], consumerIndices: [...(network.consumerIndices || [])] }));
  const state = { networks, multipliers: design.map(() => 1) };
  return Object.assign(state, { multipliers: recalculatePredictedPowerState(state, design, available || design.map((m)=>isPowerGenerator(m.type))) });
}
function clonePredictedPowerState(state) { return { networks: state.networks.map(n => ({ ...n, sourceIndices: [...(n.sourceIndices || [])], consumerIndices: [...(n.consumerIndices || [])] })), multipliers: [...state.multipliers] }; }
function recalculatePredictedPowerState(state, design, available) {
  const multipliers = design.map((module) => (Number(PART_STATS[module.type]?.powerUse) || 0) > 0 ? 0 : 1);
  for (const network of state.networks || []) {
    const generation = (network.sourceIndices || []).reduce((sum, i) => sum + (available[i] ? Number(PART_STATS[design[i]?.type]?.powerGeneration) || 0 : 0), 0);
    const demand = Math.max(0, Number(network.demandMw) || 0);
    const efficiency = demand <= 0 ? 1 : Math.max(0, Math.min(1, generation / demand));
    network.availableGenerationMw = generation; network.liveDemandMw = demand; network.runtimeLoadRatio = generation > 0 ? Math.max(0, Math.min(1, demand / generation)) : 0; network.availableEfficiency = efficiency;
    for (const i of network.consumerIndices || []) multipliers[i] = efficiency;
  }
  state.multipliers = multipliers; return multipliers;
}
function buildPredictedGenerationRates(design, rules, mode, loadMultiplier, designExhaust, dataSupport, powerMultiplier, powerState) {
  const activity = design.map((module, index) => (Number(PART_STATS[module.type]?.powerUse) || 0) <= 0 ? 1 : powerMultiplier[index]);
  return design.map((module, index) => {
    const stat = PART_STATS[module.type] || {}; const effectiveWeapon = dataSupport?.weaponProfileByIndex?.[index] || stat.weapon;
    if ((stat.thrust || 0) > 0 && !designExhaust.validEngineIndices.has(index)) return 0;
    if ((stat.powerGeneration || 0) > 0) {
      const network = powerState?.networks?.find(entry => (entry.sourceIndices || []).includes(index));
      const localLoad = network ? Math.max(0, Math.min(1, (Number(network.liveDemandMw ?? network.demandMw) || 0) / Math.max(Number(network.availableGenerationMw ?? network.generationMw) || 0, 0.0001))) : 0;
      return rules.activityHeat(module.type, stat) * loadMultiplier(module, stat) * localLoad;
    }
    if (stat.weapon && effectiveWeapon) {
      const baseHeat = rules.activityHeat(module.type, { ...stat, weapon: effectiveWeapon });
      const beamFireRateScale = effectiveWeapon.type === "beam" ? (Number(effectiveWeapon.fireRate) || 0) / Math.max(Number(stat.weapon.fireRate) || 0, 0.0001) : 1;
      return baseHeat * beamFireRateScale * loadMultiplier(module, { ...stat, weapon: effectiveWeapon }) * activity[index];
    }
    return rules.activityHeat(module.type, stat) * loadMultiplier(module, stat) * activity[index];
  });
}

function predictedPowerMultiplier(index, module, power) {
  const stat = PART_STATS[module?.type] || {};
  if ((Number(stat.powerUse) || 0) <= 0) return 1;
  const network = power?.networkByComponent?.get?.(index) || power?.networks?.find?.((entry) => (entry.consumerIndices || []).includes(index));
  if (!network || !(network.sourceIndices || []).length || !(network.consumerIndices || []).includes(index)) return 0;
  const value = Number(network.availableEfficiency ?? ((Number(network.generationMw) || 0) / Math.max(Number(network.demandMw) || 0, 0.0001)));
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function buildPredictedDataSupport(design, wiringAnalysis, powerMultiplier, options = {}) {
  const rules = globalThis.DataSupportRules;
  if (!rules || !wiringAnalysis?.data?.networks) return { weaponProfileByIndex: [], weaponSupportByIndex: [] };
  const sourceMultiplier = (index) => {
    const forcedState = options.sourceHeatStates?.[index];
    const thermal = forcedState == null ? 1 : globalThis.HeatRules.activeOutputForState(forcedState);
    return (powerMultiplier[index] ?? 0) * thermal;
  };
  const support = rules.analyzeDataSupport(design, wiringAnalysis.data.networks, PART_STATS, { sourceMultiplier });
  const weaponProfileByIndex = Array(design.length).fill(null);
  const weaponSupportByIndex = Array(design.length).fill(null);
  for (const weapon of support.weaponBonuses || []) {
    weaponSupportByIndex[weapon.weaponIndex] = weapon;
    weaponProfileByIndex[weapon.weaponIndex] = rules.effectiveWeaponProfile(PART_STATS[weapon.weaponType]?.weapon || {}, weapon);
  }
  return { support, weaponProfileByIndex, weaponSupportByIndex };
}

function buildThermalNetworks(model, generationRates) {
  const { design, profiles, exposed, edgeMaps } = model;
  const frameSet = new Set(design.map((module, i) => isFrame(module.type) ? i : -1).filter(i => i >= 0));
  const frameVisited = new Set();
  const networks = [];
  for (const start of frameSet) {
    if (frameVisited.has(start)) continue;
    const frameIndices = [], attached = new Set(), queue = [start]; frameVisited.add(start);
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const index = queue[cursor]; frameIndices.push(index);
      for (const neighbour of edgeMaps[index].keys()) {
        if (frameSet.has(neighbour)) { if (!frameVisited.has(neighbour)) { frameVisited.add(neighbour); queue.push(neighbour); } }
        else attached.add(neighbour);
      }
    }
    const generators = [...attached].filter(i => generationRates[i] > 0);
    const coolers = [...attached].filter(i => design[i].type === "heatSink" || design[i].type === "radiator");
    const networkGeneration = generators.reduce((sum, i) => sum + generationRates[i], 0);
    const networkCooling = coolers.reduce((sum, i) => sum + profiles[i].cooling * (design[i].type === "radiator" && !exposed[i] ? .25 : 1), 0);
    networks.push({ id: networks.length, frameIndices, attached: [...attached], generators, coolers, generation: networkGeneration, cooling: networkCooling, overloaded: networkGeneration > networkCooling, isolated: generators.length > 0 && coolers.length === 0 });
  }
  return networks;
}

function isFrame(type) { return /frame/i.test(String(type || "")) || type === "heatPipe"; }

export function describeThermalComponent(index, design) {
  const module = design[index];
  if (!module) return "None";
  const sameType = design.filter(candidate => candidate.type === module.type);
  const name = PART_DEFS[module.type]?.name || module.type;
  if (sameType.length < 2) return name;
  const horizontal = module.x < 7 ? "Left" : module.x > 7 ? "Right" : "Centre";
  const vertical = module.y < 7 ? "Forward" : module.y > 7 ? "Aft" : "Midship";
  return `${horizontal === "Centre" ? vertical : horizontal} ${name}`;
}

function describeThermalNetwork(network, design) {
  const generators = network.generators.map(index => design[index]);
  if (!generators.length) return `Thermal network ${network.id + 1}`;
  const averageY = generators.reduce((sum, module) => sum + module.y, 0) / generators.length;
  const region = averageY < 6.5 ? "Forward" : averageY > 7.5 ? "Aft" : "Midship";
  const weaponCount = generators.filter(module => PART_STATS[module.type]?.weapon).length;
  const engineCount = generators.filter(module => (PART_STATS[module.type]?.thrust || 0) > 0).length;
  return `${region} ${weaponCount >= engineCount ? "weapon" : "engine"} cluster`;
}

globalThis.DesignThermalAnalysis = { analyzeDesignHeat, buildThermalModel, buildThermalLoad, simulateThermalLoad, summariseThermalResult };
