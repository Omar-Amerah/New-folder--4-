// Authoritative Blueprint Power preview. UI consumers call the same shared
// max-flow/allocation solver as the server instead of deriving local ratios.

export function solveBlueprintPower(design, wiring, catalogue, infrastructure, options = {}) {
  const PowerFlowRules = globalThis.PowerFlowRules;
  const WiringRules = globalThis.WiringRules;
  if (!PowerFlowRules || !WiringRules || !Array.isArray(design) || !wiring) return null;

  const sourceGenerationByIndex = {};
  design.forEach((module, index) => {
    const type = module?.type;
    const generation = Number(catalogue?.[type]?.powerGeneration) || 0;
    if (generation > 0 || WiringRules.isPowerSourceType(type)) {
      sourceGenerationByIndex[index] = generation;
    }
  });

  try {
    return PowerFlowRules.solvePowerFlow({
      design,
      wiring,
      catalogue,
      infrastructure,
      sourceGenerationByIndex,
      componentOperationalByIndex: design.map((_, index) => options.componentOperationalByIndex?.[index] !== false),
      componentDemandByIndex: options.componentDemandByIndex,
      powerPolicy: wiring.powerPolicy
    });
  } catch (_) {
    return null;
  }
}
