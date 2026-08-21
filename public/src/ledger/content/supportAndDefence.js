// Fleet Ledger authored content: Shields, armour, drones, Data Links, sensors, and repair guidance.

import { formatDistance } from "../../design/statFormatting.js";
import { DRONES, GENERATED_BALANCE, PART_STATS, REPAIR_PROGRESSION_TEXT, REPAIR_STACKING_TEXT, SHIELD_ABSORPTION_TEXT, SHIELD_COMMAND_RELAY_DELAY_TEXT, SHIELD_COMMAND_RELAY_REGEN_TEXT, SHIELD_COMMAND_RELAY_TEXT, SHIELD_DEPLETION_TEXT, SHIELD_IMPACT_HEAT_TEXT, SHIELD_LEAK_TEXT, SHIELD_RESTART_DELAY_TEXT, SHIELD_RESTART_TEXT, droneProjectileEvasionDetail, droneTypeSummary } from "./resolvedContentValues.js";

export const SUPPORT_AND_DEFENCE_CONTENT = Object.freeze({
  articles: Object.freeze([
  {
      id: "defence",
      category: "shields-armour",
      title: "Shields & Armour",
      summary: "How shield fields, armour, hull structure, and active defences keep ships alive.",
      keywords: ["defence", "defense", "shield", "armor", "composite armor", "point defense", "flak", "interceptor", "aegis", "decoy"],
      howItWorks: `Defence components protect ships from incoming damage. Shields absorb damage and regenerate over time (consuming power). Every ${SHIELD_IMPACT_HEAT_TEXT} of blocked Shield damage becomes Heat in the Shield system; 100 blocked damage creates 12 H total, distributed across active Shield generators rather than added independently to each generator. Armor plates add hull HP and can reduce incoming damage. Point defense lasers destroy incoming missiles and drones. Flak cannons provide short-range anti-missile and anti-swarm defence. Interceptor pods offer longer-range missile interception. Aegis projectors project a fast-recharging shield field at high power cost. Decoy launchers deploy false targets that can pull guided missiles away.`,
      practicalUse: "Layer shields over armor for maximum survivability. Point defense is essential against missile-heavy opponents. Use armor on the forward facing for charge-style ships. Decoy launchers counter guided missile spam.",
      commonProblems: [
        "Shields not regenerating? Check power supply : shields need power to regenerate.",
        "Missiles getting through? Add point defense or flak cannons.",
        "Armor not helping enough? Composite armor is lighter but gives less protection per cell than standard armor."
      ],
      related: ["weapons", "blueprint-designer", "power", "heat"]
    },
  {
      id: "drones",
      category: "drones",
      title: "Drones",
      summary: "Drone bays, fighter/defence/repair drones, and squadron mechanics.",
      keywords: ["drone", "drone bay", "fighter", "defence drone", "repair drone", "squadron", "launch"],
      howItWorks: `Drone Bays launch and rebuild configurable squads. Squad sizes, fuel durations and rebuild times depend on the selected drone type: ${droneTypeSummary("squadSize", " drones")}; ${droneTypeSummary("fuelSeconds", "s")} of fuel. Fighter drones attack the parent ship's target, Defence drones guard the parent ship, and Repair drones restore friendly hulls. ${droneProjectileEvasionDetail()} Drones must return to refuel, and a bay needs one complete two-cell edge exposed for launch. A bay uses its authored Activity Heat rate only while producing or operating active drones; a merely idle bay generates no Heat.`,
      importantStats: [
        { label: "Squad Size", value: droneTypeSummary("squadSize", " drones") },
        { label: "Max Bays Per Ship", value: `${DRONES.maxBaysPerShip ?? 4}` },
        { label: "Max Active Per Ship", value: `${DRONES.maxActivePerShip ?? 12}` },
        { label: "Max Active Per Player", value: `${DRONES.maxActivePerPlayer ?? 48}` },
        { label: "Fuel Duration", value: droneTypeSummary("fuelSeconds", "s") },
        { label: "Refuel Time", value: `${DRONES.refuelSeconds ?? 2}s` },
        { label: "Launch Interval", value: `${DRONES.launchIntervalSeconds ?? 0.65}s` },
        { label: "Launch Duration", value: `${DRONES.launchDurationSeconds ?? 0.8}s` },
        { label: "Orphan Lifetime", value: `${DRONES.orphanLifetimeSeconds ?? 3}s` },
        { label: "Standby Power", value: `${DRONES.standbyPowerMw ?? 3} MW` },
        { label: "Active Power", value: `${DRONES.activePowerMw ?? 7} MW` },
        { label: "Production Power", value: `${DRONES.productionPowerMw ?? 11} MW` },
        { label: "Activity Heat", value: `${PART_STATS.droneBay?.activityHeat ?? 0} H/s while producing or operating active drones` }
      ],
      practicalUse: "Fighter drones add DPS to any build. Defence drones protect against enemy drone swarms. Repair drones extend ship longevity. Mix types based on your strategy.",
      commonProblems: [
        "Drones not launching? Ensure the bay has an exposed two-cell edge.",
        "Drones disappearing? They run out of fuel and must return to refuel.",
        "Too many drones? The 12-active-per-ship limit prevents excessive swarms."
      ],
      related: ["weapons", "defence", "support", "blueprint-designer"]
    },
  {
      id: "support",
      category: "data-links",
      title: "Data Links",
      summary: "Connect support sources directly to weapons and decide how each fixed support budget is shared.",
      keywords: ["data links", "support", "targeting computer", "signal amplifier", "stabilizer node", "fire control", "accuracy", "range", "fire rate", "link all"],
      howItWorks: "Data Links are explicit logical connections from a support source to a weapon. Fire Control contributes fire rate, Signal Amplifiers contribute range, and Targeting Computers or Stabilizer Nodes contribute accuracy. Each source owns one fixed budget. Linking that source to one eligible weapon gives the weapon the full effective budget; linking it to several weapons divides the budget evenly between them. Multiple sources can feed the same weapon and their contributions add. A source contributes nothing while destroyed, unpowered, or overheated.",
      importantStats: [
        { label: "Valid Sources", value: "Fire Control, Signal Amplifier, Targeting Computer, Stabilizer Node" },
        { label: "Valid Targets", value: "Weapon Components" },
        { label: "Allocation", value: "Fixed Source Budget Divided Evenly Across Linked Weapons" },
        { label: "Link Geometry", value: "Direct Source-To-Weapon Pair" },
        { label: "Link All", value: "Maximum Coverage, Smaller Per-Weapon Shares" }
      ],
      practicalUse: "Open Data Links in the Blueprint Designer, click a source, then click weapons to link or unlink them; you can also drag from a source to a weapon. Concentrate a source on a key weapon for the largest bonus, or spread it across several weapons for broader coverage. The Data analysis shows the exact budget and per-weapon result.",
      commonProblems: [
        "Source fitted but no bonus delivered? Link it to at least one weapon.",
        "Bonus smaller than expected? The source is sharing its budget across every linked eligible weapon.",
        "Linked source showing offline or reduced? Check its component health, Power, and Heat state."
      ],
      related: ["blueprint-designer", "weapons", "power", "heat", "component-reference"]
    },
  {
      id: "sensors-detection",
      category: "sensors-detection",
      title: "Sensors & Detection",
      summary: "How allied sensor coverage reveals enemies and how omnidirectional and directed sensors stack.",
      keywords: ["sensor", "detection", "visibility", "fog", "full dark", "omnidirectional", "directed", "cone", "remembered contact"],
       howItWorks: "In Sensor Fog and Full Dark matches, enemy ships and drones are live targets only while they fall inside allied sensor coverage. Every hull has the same base omnidirectional range. Each live general Sensor adds its full authored range bonus linearly. Directed Sensors form a separate coverage family and project longer forward cones based on component rotation; aligned cones combine their full bonuses where they overlap. A live sensor contributes its full authored range bonus when operational, while a destroyed or unpowered sensor contributes zero. Allied ships, owned relays, and home stations share coverage with the team. A lost enemy ship leaves a last-known contact for a short time, but remembered contacts cannot be targeted as if they were still visible.",
       importantStats: [
         { label: "Universal Hull Base Range", value: `${GENERATED_BALANCE.visibility?.baseSensorRange ?? 460} m` },
        { label: "Sensor Stacking", value: "Linear full authored bonus per live sensor" },
        { label: "Remembered Contact", value: `${GENERATED_BALANCE.visibility?.rememberedContactSeconds ?? 12}s` }
      ],
      practicalUse: "Use omnidirectional sensors for dependable local awareness and directed sensors for long-range scouting along an expected approach. Rotate directed sensors toward the battlefield and keep sensor ships alive; a fleet can lose both targeting options and information when its coverage collapses.",
      commonProblems: [
        "Enemy marker remains but cannot be attacked? It is a remembered contact, not a live detection.",
        "Directed sensor misses targets beside the ship? Its range applies only inside the facing cone.",
        "Extra sensors add less than expected? Check their Power, health, role, and Directed cone geometry."
      ],
      related: ["combat", "movement", "command", "component:smallSensor", "component:largeDirectedSensor"]
    },
  {
      id: "repair-mechanics",
      category: "advanced-mechanics",
      title: "Repair Mechanics",
      summary: "How hull repair works, diminishing returns, range, and repair beams.",
      keywords: ["repair", "hull", "heal", "diminishing returns", "repair beam", "repair range"],
      howItWorks: `Repair modules restore hull HP over time. The strongest local Repair source contributes 100%, then each additional source contributes ${REPAIR_STACKING_TEXT} as much as the previous one. The progression is ${REPAIR_PROGRESSION_TEXT}. Power, Heat, component state, target need, and command auras determine delivered work. Repair beams project repair at range toward friendly ships and do not use the local Repair stacking warning. The repair range determines how far the beam can reach. Drones can also repair their parent ship and nearby allies.`,
      importantStats: [
        { label: "Repair Range", value: formatDistance(GENERATED_BALANCE.repair?.repairRange ?? 410) },
        { label: "Stacking", value: `Diminishing returns (${REPAIR_STACKING_TEXT} per additional local source)` },
        { label: "Progression", value: REPAIR_PROGRESSION_TEXT }
      ],
      practicalUse: "Use multiple local Repair modules when the added output justifies their Power and Heat cost; each added source contributes less than the previous one. Repair beams are directional; aim them at the ship you want to heal. Repair drones automatically target the parent ship first, then nearby allies.",
      commonProblems: [
        "Repair output lower than the nominal sum? Check Power, Heat, component damage, target need, and aura coverage.",
        "Repair beam not hitting? It's directional; ensure the emitter faces the target."
      ],
      related: ["support", "defence", "drones", "blueprint-designer"]
    }
  ]),
  updates: Object.freeze({
    defence: {
      summary: "Shield absorption and regeneration, armour behaviours, active interception, and decoys.",
      howItWorks: `Shield capacity sources add together; Power affects regeneration, not maximum Shield Capacity. Regeneration sources add their full authored rates linearly, then delivered Power scales regeneration proportionally before Heat and aura modifiers apply. ${SHIELD_DEPLETION_TEXT} ${SHIELD_RESTART_TEXT} ${SHIELD_COMMAND_RELAY_TEXT} A shield hit blocks ${SHIELD_ABSORPTION_TEXT} of the shield-eligible damage it can absorb; ${SHIELD_LEAK_TEXT} of that blocked hull damage leaks through, and shield overflow also reaches hull. Each ${SHIELD_IMPACT_HEAT_TEXT} of blocked Shield damage generates Heat in the Shield system; 100 blocked damage creates 12 H total, distributed across active Shield generators rather than added independently to each generator. Armour then contributes component durability and family-specific protection: each discrete projectile hit applies flat reduction once, while a continuous beam applies that reduction per second while it remains on the plate. Hot, Critical, and Overheated armour reduce that protection multiplier. Ablative structure offers high raw durability without flat reduction, and Refractory protection resists Heat and blocks Thermal Induction Lance transfer while intact. Point defence, flak, interceptors, and decoys act before guided threats land.`,
      importantStats: [
        { label: "Shield Absorption", value: `${SHIELD_ABSORPTION_TEXT} Of Blocked Damage` },
        { label: "Shield Leakage", value: `${SHIELD_LEAK_TEXT} Of Blocked Hull Damage` },
        { label: "Shield Impact Heat", value: SHIELD_IMPACT_HEAT_TEXT },
        { label: "Impact Heat Distribution", value: "Across active Shield generators; 100 blocked damage = 12 H total" },
        { label: "Shield Regen Stacking", value: "Linear full authored rate per live source" },
        { label: "Shield Restart Delay", value: SHIELD_RESTART_DELAY_TEXT },
        { label: "Shield Restart Rule", value: "Only after complete depletion to 0" },
        { label: "Shield Command Relay", value: `Regen ${SHIELD_COMMAND_RELAY_REGEN_TEXT}; restart delay ${SHIELD_COMMAND_RELAY_DELAY_TEXT}` },
        { label: "Minimum Active Shield", value: "10" },
        { label: "Armour Principle", value: "Flat Reduction Favours Many Small Hits" }
      ],
      practicalUse: "Layer defences around the threats you expect. Shields buy renewable protection but need Power, cooling, and restart time. Remember that only complete depletion pauses regeneration. Flat-reduction armour punishes rapid low-damage fire; raw-durability armour is better against heavy hits. Use more than one interception family when missiles are a strategic threat.",
      commonProblems: [
        `Hull takes damage with shield remaining? ${SHIELD_LEAK_TEXT} leakage is intentional.`,
        "More regeneration adds less than expected? Check live shield health, Power, Heat, and aura state.",
        "Scatter fire performs poorly into armour? Each pellet encounters flat reduction separately.",
        "Shield regeneration paused? The restart delay begins only when Shield reaches exactly 0."
      ],
      related: ["damage-and-destruction", "weapons", "projectile-mechanics", "power", "heat"]
    },
    drones: {
      summary: "Bay configuration, launch state, roles, fuel, recall, refuelling, and replacement production.",
      howItWorks: `A Drone Bay controls one selected squad type and needs one complete exposed two-cell launch edge. Deployed bays launch ready slots after the ship leaves its spawn area; Recall orders active drones home. Fighter squads attack hostile drones, the parent's visible focus target, and other visible enemy ships. Defence squads guard close to the parent, intercept hostile guided projectiles first, then engage hostile drones and ships. Repair squads repair their parent first before scoring damaged allies in command range. Fuel forces surviving drones to return, dock, refuel, and launch again. Destroyed slots enter replacement production. Bay Power changes launch and production pace linearly; any positive Power keeps a living, non-Overheated bay operational and commanding its drones, while 0 Power stops launching and may trigger fallback. A destroyed Bay cannot produce replacements or accept docking drones. Losing the parent or Bay leaves its deployed drones only ${DRONES.orphanLifetimeSeconds ?? 3}s before removal.`,
      importantStats: [
        { label: "Squad Size", value: droneTypeSummary("squadSize", " drones") },
        { label: "Fuel", value: droneTypeSummary("fuelSeconds", "s") },
        { label: "Replacement Time", value: droneTypeSummary("productionSeconds", "s") },
        { label: "Maximum Bays", value: `${DRONES.maxBaysPerShip ?? 4} Per Ship` },
        { label: "Active Limits", value: `${DRONES.maxActivePerShip ?? 12} Per Ship, ${DRONES.maxActivePerPlayer ?? 48} Per Player` },
        { label: "Refuel", value: `${DRONES.refuelSeconds ?? 2}s` }
      ],
      practicalUse: "Expose the bay edge and leave clearance outside it. Recall before a dangerous retreat so drones refuel instead of becoming stranded. Fighters need allied detection to keep targets valid; Repair drones are most reliable when their parent stays inside the fight but survives long enough to recover.",
      commonProblems: [
        "Ready drones do not launch? Leave the spawn area and check bay Power and launch-edge exposure.",
        "Drones repeatedly return? Fuel, recall state, lost command range, or low bay Power can force fallback.",
        "Destroyed squad does not immediately reappear? Each slot must complete powered replacement production."
      ]
    },
    support: {
      summary: "Direct source-to-weapon bonuses with explicit targets and divided source budgets.",
      howItWorks: "A Data Link is a logical pair between an eligible support source and a weapon. Fire Control supplies fire rate, Signal Amplifiers supply range, and Targeting Computers or Stabilizer Nodes supply accuracy. Each source owns one fixed nominal budget. It is divided evenly across that source's currently valid linked weapons, then scaled by source health, Power, and Heat. Multiple sources feeding one weapon add their contributions. Fire rate multiplies base rate, range is additive, and accuracy is capped below perfect unless the base weapon is already perfect. Links are identified by component index and invalid ones are pruned when a design changes.",
      importantStats: [
        { label: "Source Budget", value: "Divided Evenly Across Its Valid Linked Weapons" },
        { label: "Multiple Sources", value: "Add On The Same Weapon" },
        { label: "Fire Rate", value: "Multiplicative Bonus" },
        { label: "Range", value: "Additive Bonus" },
        { label: "Accuracy", value: "Additive, Normally Capped At 99%" }
      ],
      practicalUse: "In Data Links, click a source and then toggle weapon targets, or drag directly from source to weapon. Concentrate links on a defining battery for maximum per-weapon effect. Auto-link maximises coverage by linking every eligible source to every weapon; it does not choose an optimal allocation. Clear removes all links.",
      commonProblems: [
        "Support is installed but gives no bonus? It needs at least one valid weapon link.",
        "Each weapon receives less after Auto-link? The same fixed source budget is now split across more targets.",
        "A link vanished after editing? Its saved source or target index no longer identifies an eligible component."
      ]
    },
    "sensors-detection": {
      summary: "Visibility modes, shared coverage, sensor stacking, directed cones, and remembered contacts.",
       howItWorks: "Full visibility reveals all entities. Sensor Fog and Full Dark require an enemy ship or drone to be inside allied live coverage before it can be targeted. Every hull supplies the same omnidirectional base. Each live general Sensor adds its full authored bonus linearly. Directed Sensors form a separate coverage family and project forward cones from their component rotation. Cones aimed along the same bearing combine their full bonuses where they overlap, while differently aimed cones cover their own sectors. Allied ships, owned relays, and home stations share coverage. Detection lingers briefly to prevent boundary flicker; after that, an enemy ship becomes a 12-second last-known contact that cannot be targeted.",
       importantStats: [
         { label: "Hull Base", value: `${GENERATED_BALANCE.visibility?.baseSensorRange ?? 460} m for every hull` },
        { label: "Sensor Stacking", value: "Linear full authored bonus per live sensor" },
        { label: "Detection Linger", value: `${GENERATED_BALANCE.visibility?.detectionLingerSeconds ?? 0.25}s` },
        { label: "Remembered Ship Contact", value: `${GENERATED_BALANCE.visibility?.rememberedContactSeconds ?? 12}s` },
        { label: "Station Coverage", value: `Home ${GENERATED_BALANCE.visibility?.homeStationSensorRange ?? 1400} m, Relay ${GENERATED_BALANCE.visibility?.relayStationSensorRange ?? 950} m` }
      ],
      practicalUse: "Use omnidirectional coverage for local certainty and rotated directed cones for long approaches. Spread sensor responsibility so one destroyed scout does not blind every long-range battery. A relay can be an information objective as well as an income objective.",
      commonProblems: [
        "Enemy outline remains but attack is unavailable? It is a remembered contact.",
        "Large directed range misses a nearby flank? The target is outside the cone bearing.",
        "Extra sensor adds less than its card value? Check live component state, Power, and Directed cone overlap."
      ]
    },
    "repair-mechanics": {
      summary: "Repair need, component restoration, range, Power, Heat, and diminishing stacking.",
      howItWorks: `Repair sources restore repairable hull and component damage rather than reviving a destroyed ship. Local Repair modules use diminishing returns: the strongest source contributes 100%, then each additional source contributes ${REPAIR_STACKING_TEXT} as much as the previous one, following ${REPAIR_PROGRESSION_TEXT}. Local modules repair their own ship. Repair beams require a valid allied target in their directional range and are documented separately from the local Repair stack. Repair drones prioritise damage on their parent, then choose damaged allies in command range. Source health, Power, and Heat scale or stop output, and station repair begins only after its combat delay.`,
      practicalUse: "Repair works best on a hull that can survive burst damage and disengage long enough for recovery. Protect repair sources and Power generation, and do not assume headline healing applies while the source is hot or underpowered.",
      commonProblems: [
        "Repair source is active but output is low? Check Power, Heat, component state, aura coverage, and actual repair need.",
        "Repair beam does nothing? Confirm allied target, range, facing, and source state.",
        "Destroyed ship is not restored? Repair fixes surviving ships; it does not resurrect them."
      ]
    }
  }),
  extraArticles: Object.freeze([

  ])
});
