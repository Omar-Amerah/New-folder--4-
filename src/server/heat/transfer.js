"use strict";

// Heat Pipe transport and physical frame/component conduction. Flow formulas
// remain authoritative in shared HeatRules; topology remains authoritative in
// ../thermalTopology.
const HeatRules = require("../../../public/src/shared/heatRules");
const {
  isThermalRouteType
} = require("../thermalTopology");
const { performanceNow } = require("../utils");
const { bump, recordDuration } = require("../roomTelemetry");
const { touchHeatNeighbour } = require("./lifecycle");

const {
  edgeTransfer,
  isCoolantTransportType,
  coolantEdgeConductance,
  coolantEdgeBandwidth,
  solveCoolantNetwork
} = HeatRules;

// Stored heat plus anything generated earlier this tick, for a component that
// may or may not already be in the sparse work set.
function pendingComponentHeat(ship, runtime, index) {
  const stored = Math.max(0, Number(ship.componentHeat?.[index]) || 0);
  return runtime.touchedMembership[index] ? Math.max(0, stored + runtime.delta[index]) : stored;
}

function coolantNetworkHasHeat(ship, runtime, network) {
  for (const pipeIndex of network.pipeIndices) {
    if ((ship.componentHp?.[pipeIndex] ?? 1) <= 0) continue;
    if (pendingComponentHeat(ship, runtime, pipeIndex) > 0) return true;
  }
  for (const attachment of network.attachments) {
    if ((ship.componentHp?.[attachment.index] ?? 1) <= 0) continue;
    if (pendingComponentHeat(ship, runtime, attachment.index) > 0) return true;
  }
  return false;
}

// One coolant-transport step per network. Heat Pipes remove no heat here: every
// unit that leaves one participant arrives at another in the same network, so
// the solve is exactly heat-conserving. Flow direction is derived from the
// participants' relative heat ratios, and is bounded by the shared throughput
// rules in HeatRules.solveCoolantNetwork.
function solveCoolantNetworks(ship, elapsed) {
  const networks = ship.coolantNetworks;
  if (!networks || networks.length === 0) return;
  const runtime = ship._thermalRuntime;
  if (!runtime) return;

  for (const network of networks) {
    network.transportedHeat = 0;
    // A network where nothing holds heat can only produce zero flows, so skip it
    // before touching anything: the sparse work set must not grow by one entry
    // per pipe tile on every solved tick of an idle ship.
    if (!coolantNetworkHasHeat(ship, runtime, network)) continue;
    const alivePipes = [];
    let pipeHeat = 0;
    let pipeCapacity = 0;
    for (const pipeIndex of network.pipeIndices) {
      if ((ship.componentHp?.[pipeIndex] ?? 1) <= 0) continue;
      touchHeatNeighbour(ship, pipeIndex);
      alivePipes.push(pipeIndex);
      pipeHeat += Math.max(0, runtime.workingHeat[pipeIndex]);
      pipeCapacity += Math.max(1, ship.componentThermals[pipeIndex].capacity);
    }
    if (alivePipes.length === 0) continue;

    // Participant 0..n-1 are the attachments; the pipe tiles follow as one node.
    const attachments = [];
    const participants = [];
    let pipeNodeConductance = 0;
    let pipeNodeBandwidth = 0;
    for (const attachment of network.attachments) {
      const index = attachment.index;
      if ((ship.componentHp?.[index] ?? 1) <= 0) continue;
      touchHeatNeighbour(ship, index);
      const conductance = coolantEdgeConductance(attachment.sharedEdges);
      const bandwidth = coolantEdgeBandwidth(attachment.sharedEdges);
      pipeNodeConductance += conductance;
      pipeNodeBandwidth += bandwidth;
      attachments.push(attachment);
      participants.push({
        heat: Math.max(0, runtime.workingHeat[index]),
        capacity: Math.max(1, ship.componentThermals[index].capacity),
        conductance,
        bandwidth
      });
    }
    if (attachments.length === 0) continue;
    // The coolant in the pipes is always fully coupled to the network it forms,
    // so the pipe node's conductance is the sum of its attachments'. Its tiny
    // capacity is what keeps pipes from acting as storage.
    participants.push({ heat: pipeHeat, capacity: pipeCapacity, conductance: pipeNodeConductance, bandwidth: pipeNodeBandwidth });

    const deltas = solveCoolantNetwork(participants, elapsed);
    for (let k = 0; k < attachments.length; k += 1) {
      const delta = deltas[k];
      if (delta === 0) continue;
      const index = attachments[k].index;
      runtime.delta[index] += delta;
      runtime.workingHeat[index] += delta;
      if (delta > 0) {
        ship.componentHeatReceived[index] += delta;
        network.transportedHeat += delta;
      } else {
        ship.componentHeatTransferredOut[index] += -delta;
      }
    }

    // The pipe node's own change is split across its tiles: heat arriving fills
    // them in proportion to capacity, heat leaving drains them in proportion to
    // what each one actually holds, so no tile can be driven negative.
    const pipeDelta = deltas[deltas.length - 1];
    const weightTotal = pipeDelta > 0 ? pipeCapacity : pipeHeat;
    if (pipeDelta !== 0 && weightTotal > 0) {
      let assigned = 0;
      for (let k = 0; k < alivePipes.length; k += 1) {
        const pipeIndex = alivePipes[k];
        const weight = pipeDelta > 0
          ? Math.max(1, ship.componentThermals[pipeIndex].capacity)
          : Math.max(0, runtime.workingHeat[pipeIndex]);
        const share = k === alivePipes.length - 1 ? pipeDelta - assigned : pipeDelta * (weight / weightTotal);
        assigned += share;
        runtime.delta[pipeIndex] += share;
        runtime.workingHeat[pipeIndex] += share;
        if (share > 0) ship.componentHeatReceived[pipeIndex] += share;
        else if (share < 0) ship.componentHeatTransferredOut[pipeIndex] += -share;
      }
    }
  }
}

function applyHeatTransfers(ship, heat, runtime, elapsed, room) {
  for (const index of runtime.workComponents) runtime.workingHeat[index] = Math.max(0, heat[index] + runtime.delta[index]);

  const topology = runtime.topology;
  runtime.edgeVisitToken = (runtime.edgeVisitToken + 1) >>> 0;
  if (runtime.edgeVisitToken === 0) {
    runtime.edgeVisitStamps.fill(0);
    runtime.edgeVisitToken = 1;
  }
  const edgeToken = runtime.edgeVisitToken;
  for (const index of runtime.workComponents) {
    const start = topology.incidentEdgeOffsets[index];
    const end = topology.incidentEdgeOffsets[index + 1];
    for (let offset = start; offset < end; offset += 1) {
      const edgeId = topology.incidentEdgeIds[offset];
      if (runtime.edgeVisitStamps[edgeId] === edgeToken) continue;
      runtime.edgeVisitStamps[edgeId] = edgeToken;
      runtime.candidateEdgeIds.push(edgeId);
    }
  }
  const transferRank = topology.transferRank;
  runtime.candidateEdgeIds.sort((left, right) =>
    transferRank[left] - transferRank[right] || left - right
  );

  solveCoolantNetworks(ship, elapsed);

  let transferStart = performanceNow();
  let transferCount = 0;
  for (const edgeId of runtime.candidateEdgeIds) {
    const i = topology.edgeA[edgeId];
    const j = topology.edgeB[edgeId];
    const typeI = ship.design[i]?.type;
    const typeJ = ship.design[j]?.type;
    // Heat Pipes exchange heat only through their coolant network, solved above.
    if (isCoolantTransportType(typeI) || isCoolantTransportType(typeJ)) continue;
    touchHeatNeighbour(ship, i);
    touchHeatNeighbour(ship, j);
    const aliveI = (ship.componentHp?.[i] ?? 1) > 0;
    const aliveJ = (ship.componentHp?.[j] ?? 1) > 0;
    if ((!aliveI && isThermalRouteType(ship.design[i].type)) || (!aliveJ && isThermalRouteType(ship.design[j].type))) continue;
    // Local physical conduction only. Material differences already live in the
    // base edge conductivity, so a long frame chain conducts like metal - it is
    // no longer a boosted stand-in for a Heat Pipe run.
    const conductivity = (!aliveI || !aliveJ) ? HeatRules.CONDUCTIVITY.destroyed : topology.edgeBaseConductivity[edgeId];
    const transfer = edgeTransfer(
      runtime.workingHeat[i], ship.componentThermals[i].capacity,
      runtime.workingHeat[j], ship.componentThermals[j].capacity,
      conductivity, topology.edgeSharedEdges[edgeId], elapsed
    );
    if (transfer === 0) continue;
    runtime.transferEdgeIds[transferCount] = edgeId;
    runtime.transferAmounts[transferCount] = transfer;
    runtime.outflow[transfer > 0 ? i : j] += Math.abs(transfer);
    transferCount += 1;
  }
  runtime.transferCount = transferCount;
  bump(room, "heatEdgesVisited", runtime.candidateEdgeIds.length);

  let transfersApplied = 0;
  for (let transferIndex = 0; transferIndex < transferCount; transferIndex += 1) {
    const edgeId = runtime.transferEdgeIds[transferIndex];
    const i = topology.edgeA[edgeId];
    const j = topology.edgeB[edgeId];
    const pendingTransfer = runtime.transferAmounts[transferIndex];
    const source = pendingTransfer > 0 ? i : j;
    const scale = runtime.outflow[source] > runtime.workingHeat[source]
      ? runtime.workingHeat[source] / runtime.outflow[source] : 1;
    const transfer = pendingTransfer * scale;
    runtime.delta[i] -= transfer;
    runtime.delta[j] += transfer;
    if (transfer > 0) {
      ship.componentHeatTransferredOut[i] += transfer;
      ship.componentHeatReceived[j] += transfer;
      if (topology.edgeThroughFrame[edgeId]) ship.componentHeatSentThroughFrame[i] += transfer;
    } else if (transfer < 0) {
      ship.componentHeatReceived[i] -= transfer;
      ship.componentHeatTransferredOut[j] -= transfer;
      if (topology.edgeThroughFrame[edgeId]) ship.componentHeatSentThroughFrame[j] -= transfer;
    }
    transfersApplied += 1;
  }
  bump(room, "heatTransfersApplied", transfersApplied);
  recordDuration(room, "heatTransferMs", transferStart);
}

module.exports = {
  applyHeatTransfers
};
