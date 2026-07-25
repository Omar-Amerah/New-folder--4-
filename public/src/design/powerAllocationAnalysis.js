// Authoritative Blueprint Power preview. UI consumers call the same shared
// max-flow/allocation solver as the server instead of deriving local ratios.

export function solveBlueprintPower(design, wiring, catalogue, infrastructure, options = {}) {
  const pRules = globalThis.PowerFlowRules || (typeof require !== "undefined" ? require("../shared/powerFlowRules") : null);
  const wRules = globalThis.WiringRules || (typeof require !== "undefined" ? require("../shared/wiringRules") : null);
  if (!pRules || !wRules || !Array.isArray(design) || !wiring) return null;

  const sourceGenerationByIndex = {};
  design.forEach((module, index) => {
    const type = module?.type;
    const generation = Number(catalogue?.[type]?.powerGeneration) || 0;
    if (generation > 0) {
      sourceGenerationByIndex[index] = generation;
    }
  });

  try {
    return pRules.solvePowerFlow({
      design,
      wiring,
      catalogue,
      infrastructure,
      sourceGenerationByIndex,
      componentOperationalByIndex: design.map((_, index) => options.componentOperationalByIndex?.[index] !== false),
      componentDemandByIndex: options.componentDemandByIndex,
      powerPolicy: wiring.powerPolicy
    });
  } catch (err) {
    console.error("solveBlueprintPower error:", err);
    return null;
  }
}
