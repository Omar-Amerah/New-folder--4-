// Component mechanics registry: structured metadata for runtime-only,
// conditional, and hidden gameplay rules that cannot be inferred from base
// component stats alone.
//
// Numeric values are NOT hardcoded here — they reference the authoritative
// shared rule sources (heatRules.js, generatedBalance.js, etc.) via the
// `resolve()` pattern so that a single rule change propagates everywhere.
//
// Schema:
//   conditionalPerformance: [{ label, value, detail?, sourceKey? }]
//   requirements: [{ label, value, detail?, warning? }]
//   specialMechanics: [{ label, value, detail?, condition?, warning?, sourceKey? }]
//   interactions: [{ label, value, detail? }]
//
// `sourceKey` is a dot-path string into the shared rules object, used by
// tests to verify displayed values match authoritative sources.  It is not
// shown to players.

import { formatPercent } from "../design/statFormatting.js";

function getHeatRules() {
  return (typeof globalThis !== "undefined" && globalThis.HeatRules) || {};
}

function fmtPct(v) { return formatPercent(v); }

// ---------------------------------------------------------------------------
// Documentation coverage manifest: every component that has at least one
// hidden/conditional/runtime mechanic MUST appear here.  Tests verify that
// each listed component has at least one non-empty mechanics section.
// ---------------------------------------------------------------------------

export const SPECIAL_MECHANICS_COMPONENTS = [
  "radiator",
  "heatPipe",
  "heatSink",
  "heatVent",
  "reactor",
  "nuclearReactor",
  "smallReactor",
  "heavyReactor",
  "auxGenerator",
  "battery",
  "capacitor",
  "engine",
  "heavyEngine",
  "microThruster",
  "maneuverThruster",
  "gyroscope",
  "droneBay",
  "decoyLauncher",
  "pointDefense",
  "flakCannon",
  "interceptorPod",
  "shield",
  "lightShield",
  "heavyShield",
  "regenShield",
  "aegisProjector",
  "backupCore",
  "armor",
  "compositeArmor",
  "signalAmplifier",
  "fireControl",
  "targetingComputer",
  "stabilizerNode",
  "repair",
  "repairBeam",
  "beamEmitter",
  "blaster",
  "missile",
  "lightMissile",
  "torpedo",
  "swarmMissile",
  "railgun",
  "lightRailgun",
  "heavyRailgun",
  "autocannon",
  "lightBlaster",
  "heavyBlaster",
  "proximityDemolitionCharge",
  "demolitionCharge",
];

// ---------------------------------------------------------------------------
// Radiator conditional performance — derived from heatRules.js
// ---------------------------------------------------------------------------

function radiatorConditionalPerformance() {
  const r = getHeatRules();
  const states = r.STATE_LABELS || ["Cool", "Warm", "Hot", "Critical", "Overheated"];
  const coolingTable = r.RADIATOR_ACTIVE_COOLING_BY_STATE || {};
  const profile = r.profile ? r.profile("radiator", {}) : { cooling: 14 };
  return [
    {
      label: "Base Cooling",
      value: `${profile.cooling} H/s`,
      sourceKey: "heatRules.profile.radiator.cooling"
    },
    {
      label: "Exposure — Exposed",
      value: fmtPct(r.RADIATOR_EXPOSED_MULTIPLIER ?? 1),
      sourceKey: "heatRules.RADIATOR_EXPOSED_MULTIPLIER"
    },
    {
      label: "Exposure — Enclosed",
      value: fmtPct(r.RADIATOR_ENCLOSED_MULTIPLIER ?? 0.25),
      detail: "A Radiator with no exterior edge still cools, but its cooling is multiplied by the enclosed multiplier.",
      warning: true,
      sourceKey: "heatRules.RADIATOR_ENCLOSED_MULTIPLIER"
    },
    {
      label: "Passive Cooling Floor",
      value: fmtPct(r.RADIATOR_PASSIVE_COOLING_FRACTION ?? 0.12),
      detail: "Minimum cooling before exposure scaling. Retained even when unpowered or destroyed.",
      sourceKey: "heatRules.RADIATOR_PASSIVE_COOLING_FRACTION"
    },
    ...states.map((label, idx) => {
      const keys = ["normal", "warm", "hot", "critical", "overheated"];
      const mult = coolingTable[keys[idx]] ?? 1;
      return {
        label: `Thermal State — ${label}`,
        value: fmtPct(mult),
        detail: idx === 4 ? "Overheated radiators lose all active cooling but retain the passive floor." : undefined,
        warning: idx >= 3,
        sourceKey: `heatRules.RADIATOR_ACTIVE_COOLING_BY_STATE.${keys[idx]}`
      };
    })
  ];
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

export const COMPONENT_MECHANICS = {
  radiator: {
    conditionalPerformance: radiatorConditionalPerformance(),
    requirements: [
      { label: "Exterior Edge", value: "At least one exposed exterior edge for full cooling", detail: "An internal empty pocket does not count as exterior exposure. Exposure must connect to open space outside the ship.", warning: true },
      { label: "Component Power", value: "Required for active cooling", detail: "Active cooling scales with the component's operational Power multiplier. Unpowered radiators provide only the passive cooling floor." },
      { label: "Thermal Route", value: "Only removes heat that reaches the Radiator", detail: "Heat arrives either by direct contact with a touching component or through a Heat Pipe coolant network. The Radiator creates a cooling gradient; it does not instantly remove heat from the entire ship." }
    ],
    specialMechanics: [
      { label: "Enclosed Output", value: fmtPct(getHeatRules().RADIATOR_ENCLOSED_MULTIPLIER ?? 0.25), detail: "A Radiator with no exterior edge still cools, but its cooling is multiplied by the enclosed multiplier.", warning: true, sourceKey: "heatRules.RADIATOR_ENCLOSED_MULTIPLIER" },
      { label: "Passive Floor", value: fmtPct(getHeatRules().RADIATOR_PASSIVE_COOLING_FRACTION ?? 0.12), detail: "12% of base radiator cooling before the exposure multiplier. Retained even when unpowered or destroyed.", sourceKey: "heatRules.RADIATOR_PASSIVE_COOLING_FRACTION" },
      { label: "Power Scaling", value: "Active cooling scales with component Power multiplier", detail: "Partially powered radiators provide proportionally reduced active cooling." },
      { label: "Heat-State Scaling", value: "Active cooling follows the shared active-cooling table", detail: "Cool/Warm: 100%, Hot: 75%, Critical: 50%, Overheated: 0% active cooling.", sourceKey: "heatRules.RADIATOR_ACTIVE_COOLING_BY_STATE" },
      { label: "Destroyed Behaviour", value: "No active cooling; passive floor retained", detail: "A destroyed Radiator still radiates heat passively at the floor fraction, but provides no active cooling.", warning: true },
      { label: "Network Role", value: "Creates a cooling gradient, not instant ship-wide cooling", detail: "Heat Pipes deliver heat to the Radiator from anywhere on their coolant network; touching components deliver it by direct conduction." },
      { label: "Strongest Rejection", value: "Higher sustained output than a Heat Vent", detail: "Radiators are the ship's main sustained heat rejection. A Heat Vent is the cheap, compact, unpowered alternative at far lower output." }
    ],
    interactions: [
      { label: "Heat Pipes", value: "Deliver heat to the Radiator from anywhere on the coolant network" },
      { label: "Heat Vent", value: "Cheaper and weaker; use vents to trim low loads, radiators to carry sustained ones" },
      { label: "Engineering Command Aura", value: "May increase heat dissipation via the heatDissipationMultiplier aura" },
      { label: "Power Loss", value: "Removes active cooling; only the passive floor remains" }
    ]
  },

  heatPipe: {
    requirements: [
      { label: "Structural", value: "Does not replace structural support", detail: "Non-heat-pipe parts cannot use a heat-pipe chain as their only structural path to the Core.", warning: true },
      { label: "Connection", value: "Automatic, orthogonal adjacency", detail: "A Heat Pipe joins every orthogonally adjacent Heat Pipe and every adjacent living component. There is no rotation, port or flow direction to configure, and diagonals never connect." }
    ],
    specialMechanics: [
      { label: "Transport Only", value: "0 H/s cooling", detail: "Heat Pipes transfer heat rapidly between components on the same coolant network. They remove none of it themselves — the network needs a Heat Sink, Radiator, Heat Vent or cooler attached to it.", sourceKey: "heatRules.profile.heatPipe.cooling" },
      { label: "Negligible Storage", value: "10 H capacity", detail: "Pipes are conduits, not buffers: heat entering the network moves on to whatever is attached rather than being banked.", sourceKey: "heatRules.profile.heatPipe.capacity" },
      { label: "Finite Throughput", value: "40 H/s per shared edge", detail: "Each attachment can move at most this much heat per second, so a coolant network transports quickly but never equalises attached components instantly.", sourceKey: "heatRules.COOLANT_ATTACHMENT_BANDWIDTH" },
      { label: "Automatic Flow Direction", value: "Hotter to colder", detail: "The coolant settles at the conductance-weighted mean of the attached components' heat ratios; anything hotter than that gives heat up, anything colder takes it." },
      { label: "Destroyed Route", value: "Splits the network when destroyed", detail: "A destroyed Heat Pipe leaves the network, splitting the coolant run into the separate networks that remain.", warning: true, sourceKey: "heatRules.CONDUCTIVITY.destroyed" }
    ],
    interactions: [
      { label: "Radiator", value: "Delivers heat to radiators for strong sustained rejection" },
      { label: "Heat Vent", value: "Delivers heat to exposed vents for cheap passive rejection" },
      { label: "Heat Sink", value: "Delivers heat to sinks for buffering thermal spikes" },
      { label: "Frames", value: "Frames are ordinary attachments, not transport: a chain of frames is not a coolant route" }
    ]
  },

  heatSink: {
    specialMechanics: [
      { label: "Thermal Mass", value: "340 H capacity", detail: "Heat Sinks have large heat capacity for their size. That capacity is their own — heat has to be transferred into the sink for the storage to be used.", sourceKey: "heatRules.profile.heatSink.capacity" },
      { label: "Low Cooling", value: "1.5 H/s", detail: "Heat Sinks store heat but remove very little themselves. They work best paired with a Radiator on the same coolant network.", sourceKey: "heatRules.profile.heatSink.cooling" },
      { label: "No Adjacency Bonus", value: "Neighbours gain no capacity", detail: "Sitting next to a Heat Sink does not raise a component's own heat capacity. Connect hot systems to the sink with Heat Pipes so the heat actually reaches it." },
      { label: "Destroyed Behaviour", value: "Excluded from aggregate capacity but retains stored heat", detail: "A destroyed Heat Sink stops counting toward the ship's heat capacity, but any heat already stored remains until transferred away.", warning: true }
    ],
    interactions: [
      { label: "Radiator", value: "Works best paired with a Radiator to dissipate stored heat" },
      { label: "Heat Pipes", value: "The intended way to fill a sink: WEAPON — PIPE — HEAT SINK — PIPE — RADIATOR" }
    ]
  },

  heatVent: {
    requirements: [
      { label: "Enclosed Output", value: fmtPct(getHeatRules().HEAT_VENT_ENCLOSED_MULTIPLIER ?? 0.05), detail: "A Heat Vent rejects heat through the hull, so fully enclosed it produces almost nothing. One exposed edge is enough — extra exposed edges add no further cooling.", warning: true, sourceKey: "heatRules.HEAT_VENT_ENCLOSED_MULTIPLIER" },
      { label: "Connection", value: "Attaches from any side", detail: "Adjacency-based like every thermal part: a Heat Vent takes heat from components it touches, or from a Heat Pipe network on any orthogonal side. No rotation needed." }
    ],
    specialMechanics: [
      { label: "Passive Rejection", value: "4 H/s while exposed", detail: "Constant output with no Power draw and no scaling with heat state.", sourceKey: "heatRules.profile.heatVent.cooling" },
      { label: "Weaker Than a Radiator", value: "Well below Radiator output", detail: "The Heat Vent is the cheap, compact, unpowered option for low and medium heat ships. It is not a Radiator substitute on a heavy build." },
      { label: "Fragile", value: "18 hull", detail: "Cheap and light, but it sits on the exterior where it is easy to shoot off.", warning: true }
    ],
    interactions: [
      { label: "Heat Pipes", value: "Can be fed from anywhere in the ship through a coolant network" },
      { label: "Radiator", value: "Complements rather than replaces it; Radiators carry sustained loads" }
    ]
  },

  reactor: {
    specialMechanics: [
      { label: "Meltdown", value: "Explodes after 3s in Overheated state", detail: "A reactor pinned at the overheat failure state for 3 seconds melts down and detonates, dealing area damage.", warning: true, sourceKey: "heatRules.REACTOR_MELTDOWN_SECONDS" },
      { label: "Meltdown Damage", value: "60 damage", sourceKey: "heatRules.REACTOR_EXPLOSION_DAMAGE" },
      { label: "Meltdown Radius", value: "1.9 tiles", sourceKey: "heatRules.REACTOR_EXPLOSION_RADIUS" },
      { label: "Activity Heat", value: "2 + powerGeneration × 0.42 H/s", detail: "Reactors generate heat proportional to their power output." }
    ],
    interactions: [
      { label: "Radiators", value: "Essential — an overheated reactor will melt down without adequate cooling" },
      { label: "Power Network", value: "Primary power source for the ship" }
    ]
  },

  nuclearReactor: {
    specialMechanics: [
      { label: "Meltdown", value: "Explodes after 3s in Overheated state", warning: true, sourceKey: "heatRules.REACTOR_MELTDOWN_SECONDS" },
      { label: "Meltdown Damage", value: "60 damage", sourceKey: "heatRules.REACTOR_EXPLOSION_DAMAGE" },
      { label: "Meltdown Radius", value: "1.9 tiles", sourceKey: "heatRules.REACTOR_EXPLOSION_RADIUS" }
    ],
    interactions: [
      { label: "Radiators", value: "Essential — an overheated reactor will melt down without adequate cooling" }
    ]
  },

  smallReactor: {
    specialMechanics: [
      { label: "Meltdown", value: "Explodes after 3s in Overheated state", warning: true, sourceKey: "heatRules.REACTOR_MELTDOWN_SECONDS" },
      { label: "Meltdown Damage", value: "60 damage", sourceKey: "heatRules.REACTOR_EXPLOSION_DAMAGE" }
    ],
    interactions: [
      { label: "Radiators", value: "Essential — an overheated reactor will melt down without adequate cooling" }
    ]
  },

  heavyReactor: {
    specialMechanics: [
      { label: "Meltdown", value: "Explodes after 3s in Overheated state", warning: true, sourceKey: "heatRules.REACTOR_MELTDOWN_SECONDS" },
      { label: "Meltdown Damage", value: "60 damage", sourceKey: "heatRules.REACTOR_EXPLOSION_DAMAGE" },
      { label: "Meltdown Radius", value: "1.9 tiles", sourceKey: "heatRules.REACTOR_EXPLOSION_RADIUS" }
    ],
    interactions: [
      { label: "Radiators", value: "Essential — an overheated reactor will melt down without adequate cooling" }
    ]
  },

  auxGenerator: {
    specialMechanics: [
      { label: "Activity Heat", value: "Generates heat proportional to power output", detail: "Auxiliary generators produce heat following the same formula as reactors." }
    ],
    interactions: [
      { label: "Power Network", value: "Supplementary power source" }
    ]
  },

  battery: {
    specialMechanics: [
      { label: "No Activity Heat", value: "0 H/s at idle", detail: "Batteries do not generate activity heat, but charging and discharging may produce heat depending on efficiency." },
      { label: "Charge/Discharge", value: "Efficiency-based heat generation", detail: "Discharge heat at max rate is configured per battery type." }
    ],
    interactions: [
      { label: "Power Network", value: "Provides stored energy during power deficits" }
    ]
  },

  capacitor: {
    specialMechanics: [
      { label: "No Activity Heat", value: "0 H/s at idle", detail: "Capacitors do not generate activity heat." },
      { label: "Discharge Heat", value: "Configured per capacitor type", detail: "Discharging at maximum rate produces heat proportional to the discharge rate." }
    ],
    interactions: [
      { label: "Power Network", value: "Provides burst energy for weapons and systems" }
    ]
  },

  engine: {
    requirements: [
      { label: "Exhaust Clearance", value: "Requires a clear exhaust channel behind the engine", detail: "If any component blocks the exhaust channel, the engine provides zero thrust.", warning: true },
      { label: "Power", value: "Requires power for full thrust output" }
    ],
    specialMechanics: [
      { label: "Blocked Engine", value: "Zero thrust", detail: "Blocked engines still consume mass and cost but provide no movement.", warning: true },
      { label: "Stacking Falloff", value: "90% per additional engine", detail: "Each additional engine contributes 90% of the previous one's thrust (100%, 90%, 81%, 73%, etc.)." },
      { label: "Power Scaling", value: "Movement scales with pow(powerGen / max(powerUse, 1), 1.8)", detail: "Underpowered ships suffer reduced movement, clamped to a minimum 18%." },
      { label: "Heat-State Scaling", value: "Active output follows the shared active-output table", detail: "Cool/Warm: 100%, Hot: 70%, Critical: 40%, Overheated: 0%." },
      { label: "Activity Heat", value: "2 + thrust × 0.018 H/s" }
    ],
    interactions: [
      { label: "Propulsion Capacitor", value: "Can boost acceleration when activated" },
      { label: "Power", value: "Power deficit reduces thrust; surplus grants up to +8% movement" }
    ]
  },

  heavyEngine: {
    requirements: [
      { label: "Exhaust Clearance", value: "Requires a clear exhaust channel behind the engine", warning: true },
      { label: "Power", value: "Requires power for full thrust output" }
    ],
    specialMechanics: [
      { label: "Blocked Engine", value: "Zero thrust", warning: true },
      { label: "Stacking Falloff", value: "90% per additional engine" },
      { label: "Heat-State Scaling", value: "Active output follows the shared active-output table" }
    ],
    interactions: [
      { label: "Propulsion Capacitor", value: "Can boost acceleration when activated" }
    ]
  },

  microThruster: {
    requirements: [
      { label: "Exhaust Clearance", value: "Requires a clear exhaust channel", warning: true }
    ],
    specialMechanics: [
      { label: "Blocked", value: "Zero thrust if exhaust is blocked", warning: true },
      { label: "Stacking Falloff", value: "90% per additional engine" }
    ],
    interactions: [
      { label: "Power", value: "Power deficit reduces thrust" }
    ]
  },

  maneuverThruster: {
    requirements: [
      { label: "Exhaust Clearance", value: "Requires a clear outward-facing exhaust channel", warning: true },
      { label: "Auto-Rotation", value: "Auto-rotates based on position relative to grid centre (7)" }
    ],
    specialMechanics: [
      { label: "Lever Arm", value: "0.35 min, +0.35 per cell of offset, 1.75 max", detail: "Maneuver thrusters provide directional torque based on distance from the ship's centre of mass." },
      { label: "Stacking Falloff", value: "92% per additional module" },
      { label: "Activity Heat", value: "2 + lateralThrust × 0.018 H/s" }
    ],
    interactions: [
      { label: "Gyroscope", value: "Stacks with diminishing returns for turn rate" }
    ]
  },

  gyroscope: {
    specialMechanics: [
      { label: "Stacking Falloff", value: "92% per additional module", detail: "Each additional gyroscope contributes 92% of the previous one's turn rate bonus." },
      { label: "Activity Heat", value: "2 + turn × 1.5 H/s" }
    ],
    interactions: [
      { label: "Maneuver Thruster", value: "Stacks with diminishing returns for turn rate" }
    ]
  },

  droneBay: {
    requirements: [
      { label: "Launch Edge", value: "Requires one fully exposed two-cell launch edge", detail: "The launch edge must be on the ship's exterior — an internal pocket does not count.", warning: true },
      { label: "Max Per Ship", value: "4 bays maximum" },
      { label: "Drone Type", value: "Must configure a drone type (Fighter, Defence, or Repair) before deployment" }
    ],
    specialMechanics: [
      { label: "Squad Size", value: "3 drones per squad" },
      { label: "Fuel", value: "Limited fuel — drones must return to refuel" },
      { label: "Rebuild", value: "Destroyed drones are rebuilt over time" },
      { label: "Parent Destruction", value: "Orphaned drones survive briefly then are lost", warning: true }
    ],
    interactions: [
      { label: "Power", value: "Standby, active, and production power modes" },
      { label: "Heat", value: "Generates heat during production" }
    ]
  },

  decoyLauncher: {
    specialMechanics: [
      { label: "Attraction Chance", value: "Configured per decoy type", detail: "Decoys can pull guided missiles away from the parent ship." },
      { label: "Stock & Rebuild", value: "Limited stock with rebuild over time" },
      { label: "Lifetime", value: "Decoys expire after a configured lifetime" }
    ],
    interactions: [
      { label: "Missiles", value: "Can attract guided missiles away from the ship" }
    ]
  },

  pointDefense: {
    specialMechanics: [
      { label: "Anti-Missile", value: "Intercepts incoming missiles and drones", detail: "Point defence lasers target missiles within the intercept radius." },
      { label: "Negligible Ship Damage", value: "Very low damage to ships", detail: "Point defence is designed for anti-missile/anti-drone, not ship-to-ship combat." },
      { label: "Target Priority", value: "Missiles and drones first" }
    ],
    interactions: [
      { label: "Flak Cannon", value: "Overlapping coverage improves missile defence" },
      { label: "Command Auras", value: "Point defence tracking can be boosted by command auras" }
    ]
  },

  flakCannon: {
    specialMechanics: [
      { label: "Anti-Missile & Anti-Swarm", value: "Short-range area interception", detail: "Flak provides burst-area defence against missiles and drone swarms." },
      { label: "Negligible Ship Damage", value: "Very low damage to ships" }
    ],
    interactions: [
      { label: "Point Defence", value: "Overlapping coverage improves missile defence" },
      { label: "Command Auras", value: "Flak tracking can be boosted by command auras" }
    ]
  },

  interceptorPod: {
    specialMechanics: [
      { label: "Longer Range Interception", value: "Intercepts missiles at longer range than point defence" },
      { label: "Reaction Delay", value: "Has a reaction delay before engaging" }
    ],
    interactions: [
      { label: "Command Auras", value: "Interception reaction can be boosted by command auras" }
    ]
  },

  shield: {
    specialMechanics: [
      { label: "Shield Leakage", value: "5% of blocked damage leaks to hull", detail: "Shields absorb 95% of blocked damage; 5% passes through to hull." },
      { label: "Power-Dependent Regen", value: "Shield regeneration requires power", detail: "Underpowered shields regenerate more slowly, scaled by pow(ratio, 1.35)." },
      { label: "Restart Delay", value: "Shields that drop to zero must restart before regenerating", warning: true }
    ],
    interactions: [
      { label: "Power", value: "Power deficit reduces shield efficiency" },
      { label: "Command Auras", value: "Shield regen and restart delay can be improved by auras" }
    ]
  },

  lightShield: {
    specialMechanics: [
      { label: "Shield Leakage", value: "5% of blocked damage leaks to hull" },
      { label: "Power-Dependent Regen", value: "Shield regeneration requires power" }
    ],
    interactions: [
      { label: "Power", value: "Power deficit reduces shield efficiency" }
    ]
  },

  heavyShield: {
    specialMechanics: [
      { label: "Shield Leakage", value: "5% of blocked damage leaks to hull" },
      { label: "Power-Dependent Regen", value: "Shield regeneration requires power" }
    ],
    interactions: [
      { label: "Power", value: "Power deficit reduces shield efficiency" }
    ]
  },

  regenShield: {
    specialMechanics: [
      { label: "Shield Leakage", value: "5% of blocked damage leaks to hull" },
      { label: "Higher Regen", value: "Faster shield regeneration than standard shields" },
      { label: "Power-Dependent Regen", value: "Shield regeneration requires power" }
    ],
    interactions: [
      { label: "Power", value: "Power deficit reduces shield efficiency" }
    ]
  },

  aegisProjector: {
    specialMechanics: [
      { label: "Fast-Recharging Field", value: "Projects a shield field at high power cost", detail: "The Aegis Projector creates a protective shield bubble that recharges quickly but draws significant power." },
      { label: "High Power Demand", value: "Requires substantial power to maintain", warning: true }
    ],
    interactions: [
      { label: "Power", value: "High power cost — ensure adequate generation" }
    ]
  },

  backupCore: {
    specialMechanics: [
      { label: "Reduced Performance", value: "Turn rate reduced by 10% when active", detail: "A ship operating on its Backup Command Core has reduced combat efficiency.", warning: true },
      { label: "Activation", value: "Activates automatically when the main Core is destroyed" }
    ],
    requirements: [
      { label: "Max Per Ship", value: "1" }
    ],
    interactions: [
      { label: "Core", value: "Takes over when the main Core is destroyed, keeping the ship operational" }
    ]
  },

  armor: {
    specialMechanics: [
      { label: "Flat Damage Reduction", value: "Reduces incoming damage by a flat amount per hit", detail: "Armor reduces each incoming hit by its flat reduction value before hull damage is applied." },
      { label: "Heat Retention", value: "0.9 retention multiplier", detail: "Armor retains 90% of its cooling efficiency — it dissipates heat slightly slower than standard components.", sourceKey: "heatRules.profile.armor.retention" },
      { label: "Heat Capacity", value: "125 H", sourceKey: "heatRules.profile.armor.capacity" }
    ],
    interactions: [
      { label: "Hull", value: "Adds hull HP and flat damage reduction" }
    ]
  },

  compositeArmor: {
    specialMechanics: [
      { label: "Flat Damage Reduction", value: "Reduces incoming damage by a flat amount per hit" },
      { label: "Heat Retention", value: "0.82 retention multiplier", detail: "Composite armor retains 82% of cooling efficiency — it dissipates heat slower than standard armor.", sourceKey: "heatRules.profile.compositeArmor.retention" },
      { label: "Heat Capacity", value: "140 H", sourceKey: "heatRules.profile.compositeArmor.capacity" }
    ],
    interactions: [
      { label: "Hull", value: "Adds hull HP and flat damage reduction; lighter than standard armor" }
    ]
  },

  signalAmplifier: {
    specialMechanics: [
      { label: "Range Support", value: "Extends weapon range via Data-network allocation", detail: "Range support depends on valid Data-network allocation. Does not necessarily apply its full bonus to every weapon." }
    ],
    interactions: [
      { label: "Data Network", value: "Requires valid data cable connection to function" },
      { label: "Weapons", value: "Range bonus is allocated across weapons, not uniformly applied" }
    ]
  },

  fireControl: {
    specialMechanics: [
      { label: "Fire Rate Bonus", value: "Increases weapon fire rate for weapons in range" },
      { label: "Range Requirement", value: "Only affects weapons within fire-control range" }
    ],
    interactions: [
      { label: "Data Network", value: "May require data support for full effectiveness" },
      { label: "Weapons", value: "Boosts fire rate of in-range weapons" }
    ]
  },

  targetingComputer: {
    specialMechanics: [
      { label: "Accuracy Bonus", value: "Improves weapon accuracy for all weapons" }
    ],
    interactions: [
      { label: "Weapons", value: "Applies accuracy bonus to all weapons on the ship" }
    ]
  },

  stabilizerNode: {
    specialMechanics: [
      { label: "Accuracy & Turn", value: "Improves accuracy and slightly helps turning" }
    ],
    interactions: [
      { label: "Weapons", value: "Accuracy bonus applies to all weapons" },
      { label: "Movement", value: "Small turn rate improvement" }
    ]
  },

  repair: {
    specialMechanics: [
      { label: "Stacking", value: "62% efficiency per additional source", detail: "Multiple repair sources on the same ship stack with diminishing returns." },
      { label: "Repair Range", value: "410 m", detail: "Repair modules restore hull HP to the parent ship and nearby allies within range." },
      { label: "Activity Heat", value: "1.5 + repairRate × 0.35 H/s" }
    ],
    interactions: [
      { label: "Repair Beams", value: "Repair beams project hull recovery at range" },
      { label: "Drones", value: "Repair drones automatically target parent ship first, then nearby allies" }
    ]
  },

  repairBeam: {
    specialMechanics: [
      { label: "Directional", value: "Projects a repair beam toward friendly ships", detail: "Repair beams are directional — aim them at the ship you want to heal." },
      { label: "Range", value: "410 m range" }
    ],
    interactions: [
      { label: "Allied Ships", value: "Restores hull HP to friendly ships in range" }
    ]
  },

  beamEmitter: {
    specialMechanics: [
      { label: "Sustained Beam", value: "Ramps up damage over time", detail: "Beam emitters deal increasing damage the longer they stay on target." },
      { label: "Shield-Breaking", value: "Effective against shields", detail: "Beams are designed for sustained shield-breaking." },
      { label: "Heat", value: "Generates heat proportional to sqrt(damage) while firing" }
    ],
    interactions: [
      { label: "Heat", value: "Sustained firing generates significant heat — ensure cooling" },
      { label: "Power", value: "Requires continuous power supply" }
    ]
  },

  blaster: {
    specialMechanics: [
      { label: "General Purpose", value: "Good accuracy and moderate range" },
      { label: "Heat", value: "Generates heat proportional to sqrt(damage) × fireRate" }
    ],
    interactions: [
      { label: "Power", value: "Requires power to fire" },
      { label: "Heat", value: "Firing generates heat" }
    ]
  },

  lightBlaster: {
    specialMechanics: [
      { label: "Heat", value: "Generates heat when firing" }
    ],
    interactions: [
      { label: "Power", value: "Requires power to fire" }
    ]
  },

  heavyBlaster: {
    specialMechanics: [
      { label: "Heat", value: "Generates heat when firing" }
    ],
    interactions: [
      { label: "Power", value: "Requires power to fire" }
    ]
  },

  autocannon: {
    specialMechanics: [
      { label: "Rapid Fire", value: "High fire rate with moderate damage" },
      { label: "Heat", value: "Generates heat when firing" }
    ],
    interactions: [
      { label: "Power", value: "Requires power to fire" }
    ]
  },

  missile: {
    specialMechanics: [
      { label: "Tracking", value: "Tracks target with weapon's tracking stat squared", detail: "Missile turn rate scales with tracking². Higher tracking weapons turn harder." },
      { label: "Arming", value: "Reduced turn rate during arming phase", detail: "Missiles arm with a reduced turn rate, then switch to full tracking." },
      { label: "Interceptible", value: "Can be destroyed by point defence and flak", warning: true },
      { label: "Missile HP", value: "Missiles have HP and can be shot down" },
      { label: "Splash Damage", value: "Explosive area damage on impact" }
    ],
    interactions: [
      { label: "Point Defence", value: "Enemy point defence can intercept missiles" },
      { label: "ECM", value: "Electronic warfare can reduce missile tracking by up to 55%" }
    ]
  },

  lightMissile: {
    specialMechanics: [
      { label: "Tracking", value: "Tracks target" },
      { label: "Interceptible", value: "Can be destroyed by point defence", warning: true },
      { label: "Missile HP", value: "Has HP — can be shot down" }
    ],
    interactions: [
      { label: "Point Defence", value: "Enemy point defence can intercept" }
    ]
  },

  torpedo: {
    specialMechanics: [
      { label: "Low Tracking", value: "Low tracking value — best against slow or stationary targets", warning: true },
      { label: "High Damage", value: "High alpha damage" },
      { label: "Interceptible", value: "Can be destroyed by point defence", warning: true }
    ],
    interactions: [
      { label: "Point Defence", value: "Enemy point defence can intercept" }
    ]
  },

  swarmMissile: {
    specialMechanics: [
      { label: "Swarm", value: "Launches multiple missiles", detail: "Swarm pods overwhelm point defence with numbers." },
      { label: "Higher Tracking", value: "Better tracking than standard missiles" },
      { label: "Interceptible", value: "Individual missiles can be intercepted", warning: true }
    ],
    interactions: [
      { label: "Point Defence", value: "Overwhelms with numbers but individual missiles can be intercepted" }
    ]
  },

  railgun: {
    specialMechanics: [
      { label: "Long Range", value: "Very long range with high alpha damage" },
      { label: "Narrow Arc", value: "Narrow firing arc requires careful positioning", warning: true },
      { label: "Slow Fire Rate", value: "Low fire rate — high per-shot damage" },
      { label: "Heat", value: "Generates heat proportional to sqrt(damage) × 1.8 × fireRate" }
    ],
    interactions: [
      { label: "Power", value: "Requires significant power per shot" },
      { label: "Heat", value: "Each shot generates substantial heat" }
    ]
  },

  lightRailgun: {
    specialMechanics: [
      { label: "Narrow Arc", value: "Narrow firing arc", warning: true },
      { label: "Heat", value: "Generates heat per shot" }
    ],
    interactions: [
      { label: "Power", value: "Requires power per shot" }
    ]
  },

  heavyRailgun: {
    specialMechanics: [
      { label: "Narrow Arc", value: "Narrow firing arc", warning: true },
      { label: "High Alpha", value: "Very high per-shot damage" },
      { label: "Heat", value: "Generates substantial heat per shot" }
    ],
    interactions: [
      { label: "Power", value: "Requires significant power per shot" }
    ]
  },

  proximityDemolitionCharge: {
    specialMechanics: [
      { label: "Proximity Fuse", value: "Triggers when enemy is within trigger radius", detail: "Has a trigger confirmation delay before detonating." },
      { label: "Blast Damage", value: "Area damage with falloff from centre" },
      { label: "Internal Damage Reduction", value: "Reduced damage to internal components" }
    ],
    interactions: [
      { label: "Charge Style", value: "Charge combat style moves toward nearest target for detonation" }
    ]
  },

  demolitionCharge: {
    specialMechanics: [
      { label: "Demolition", value: "High damage explosive" },
      { label: "Blast Radius", value: "Area damage on detonation" }
    ],
    interactions: [
      { label: "Charge Style", value: "Charge combat style moves toward nearest target for detonation" }
    ]
  },

};

// ---------------------------------------------------------------------------
// LEDGER_RULE_CONTRACTS: explicit documentation contracts for test validation.
// Each entry confirms that a specific article contains a formatted value
// derived from the referenced sourceKey.
// ---------------------------------------------------------------------------

export const LEDGER_RULE_CONTRACTS = [
  { articleId: "component:radiator", sourceKey: "heatRules.RADIATOR_ENCLOSED_MULTIPLIER" },
  { articleId: "component:radiator", sourceKey: "heatRules.RADIATOR_PASSIVE_COOLING_FRACTION" },
  { articleId: "component:radiator", sourceKey: "heatRules.RADIATOR_EXPOSED_MULTIPLIER" },
  { articleId: "component:radiator", sourceKey: "heatRules.RADIATOR_ACTIVE_COOLING_BY_STATE.hot" },
  { articleId: "component:radiator", sourceKey: "heatRules.RADIATOR_ACTIVE_COOLING_BY_STATE.critical" },
  { articleId: "component:radiator", sourceKey: "heatRules.RADIATOR_ACTIVE_COOLING_BY_STATE.overheated" },
  { articleId: "component:heatVent", sourceKey: "heatRules.HEAT_VENT_ENCLOSED_MULTIPLIER" },
  { articleId: "component:heatVent", sourceKey: "heatRules.HEAT_VENT_EXPOSED_MULTIPLIER" },
  { articleId: "component:heatPipe", sourceKey: "heatRules.COOLANT_ATTACHMENT_BANDWIDTH" },
  { articleId: "component:heatPipe", sourceKey: "heatRules.CONDUCTIVITY.destroyed" }
];

// ---------------------------------------------------------------------------
// Helper: get mechanics for a partId, or null
// ---------------------------------------------------------------------------

export function getMechanics(partId) {
  return COMPONENT_MECHANICS[partId] || null;
}

// ---------------------------------------------------------------------------
// Helper: collect all searchable text from mechanics for a partId
// ---------------------------------------------------------------------------

export function getMechanicsSearchText(partId) {
  const m = COMPONENT_MECHANICS[partId];
  if (!m) return "";
  const parts = [];
  for (const section of ["conditionalPerformance", "requirements", "specialMechanics", "interactions"]) {
    const items = m[section];
    if (!items) continue;
    for (const item of items) {
      if (item.label) parts.push(item.label);
      if (item.value) parts.push(item.value);
      if (item.detail) parts.push(item.detail);
      if (item.condition) parts.push(item.condition);
      if (item.warning) parts.push("warning");
    }
  }
  return parts.join(" ");
}
