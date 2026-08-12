"use strict";

// Public facade for the authoritative server Heat runtime.
//
// Processing order is owned by heat/runtime.js:
// inputs -> transfers/conduction -> external/internal cooling -> component
// state transition -> Power/Data invalidation -> telemetry.
//
// Cooling still applies exposure * thermal.retention * heatDissipationMult,
// including the "heatDissipationMultiplier" command aura, and boosts
// STATE.CRITICAL recovery with overheatRecoveryMult from
// "overheatRecoveryMultiplier". The implementation lives in heat/cooling.js.
const HeatRules = require("../../public/src/shared/heatRules");
const {
  isThermalRouteType
} = require("./thermalTopology");
const {
  initShipHeat,
  ensureThermalRuntime,
  wakeHeatRuntime,
  rebuildRuntimeExposure,
  rebuildThermalNetworks,
  recalculateEffectiveThermalCapacities,
  refreshHeatSourceSignatures,
  refreshHeatRuntimeLists,
  refreshLoadedGeneratorComponents,
  invalidateHeatRuntime,
  rebuildCoolantNetworks
} = require("./heat/lifecycle");
const {
  addComponentHeat,
  distributeComponentHeatByWeight,
  componentPerformance,
  effectiveComponentBonus
} = require("./heat/inputs");
const { updateShipHeat } = require("./heat/runtime");
const { buildHeatDebug } = require("./heat/telemetry");

module.exports = {
  STATE: HeatRules.STATE,
  initShipHeat,
  ensureThermalRuntime,
  wakeHeatRuntime,
  rebuildRuntimeExposure,
  rebuildThermalNetworks,
  recalculateEffectiveThermalCapacities,
  refreshHeatSourceSignatures,
  refreshHeatRuntimeLists,
  refreshLoadedGeneratorComponents,
  invalidateHeatRuntime,
  isThermalRouteType,
  isCoolantTransportType: HeatRules.isCoolantTransportType,
  rebuildCoolantNetworks,
  updateShipHeat,
  buildHeatDebug,
  addComponentHeat,
  distributeComponentHeatByWeight,
  componentPerformance,
  effectiveComponentBonus
};
