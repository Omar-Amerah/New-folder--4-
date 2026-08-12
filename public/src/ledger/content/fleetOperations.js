// Fleet Ledger authored content: Command, economy, objectives, stations, and advanced-mechanics guidance.

import { BACKUP_EFFECTIVENESS_TEXT, CAPTURE, ECON, GENERATED_BALANCE } from "./resolvedContentValues.js";

export const FLEET_OPERATIONS_CONTENT = Object.freeze({
  articles: Object.freeze([
  {
      id: "command",
      category: "command",
      title: "Command Systems",
      summary: "Command cores, backup cores, and command auras.",
      keywords: ["command", "core", "backup core", "aura", "command range", "accuracy", "tracking"],
      howItWorks: `Every ship requires a Core component : it is the command centre. If the Core is destroyed, the ship is lost. A Backup Command Core can be installed to keep the ship operational if the main Core is destroyed; while active, weapon accuracy, turn rate and drone command range operate at ${BACKUP_EFFECTIVENESS_TEXT}. Command components project authored effects for friendly ships within range, including weapon accuracy, tracking, and turret response where configured. All command auras share the same range so players can judge coverage at a glance.`,
      importantStats: [
        { label: "Command Aura Range", value: `${GENERATED_BALANCE.commandAura?.range ?? 800} m` },
        { label: "Aura Affects Self", value: `${GENERATED_BALANCE.commandAura?.selfAura ? "Yes" : "No"}` }
      ],
      practicalUse: "Place the Core in a well-protected position : usually the ship's interior. Backup Cores are essential for expensive capital ships. Overlapping command auras from multiple ships stack benefits for fleet engagements.",
      commonProblems: [
        "Ship destroyed when Core killed? Install a Backup Command Core.",
        "Aura not helping? Check that friendly ships are within the aura range.",
        "Core too exposed? Surround it with armor and keep it away from the ship edges."
      ],
      related: ["blueprint-designer", "defence", "support", "economy"]
    },
  {
      id: "economy",
      category: "economy-objectives",
      title: "Economy & Objectives",
      summary: "Money, income, ship purchases, relays, and victory conditions.",
      keywords: ["economy", "money", "income", "ship cap", "relay", "capture", "bounty", "victory", "win", "objective"],
      howItWorks: "Players earn money passively through base income and relay control. Relays are capturable points on the map : controlling them provides additional income. Ships cost money to build, up to a fleet cap. Destroying enemy ships awards kill bounties (28% of the destroyed ship's cost, minimum £24). Capturing a relay awards a £70 bonus. Victory is achieved by holding every relay for the victory countdown or by destroying the enemy home station. Each home station's hull and shields scale with the number of players attacking it.",
      importantStats: [
        { label: "Starting Money", value: `\u00a3${ECON.startingMoney ?? 1000}` },
        { label: "Maximum Money", value: `\u00a3${ECON.maxMoney ?? 99999}` },
        { label: "Base Income", value: `+\u00a3${ECON.baseIncome ?? 20}/s` },
        { label: "Relay Income", value: `+\u00a3${ECON.relayIncome ?? 5}/s Per Relay` },
        { label: "Kill Bounty", value: `${Math.round((ECON.killBountyRatio ?? 0.28) * 100)}% Of Ship Cost (Min \u00a3${ECON.killBountyMin ?? 24})` },
        { label: "Capture Bonus", value: `\u00a3${ECON.captureBonus ?? 70}` },
        { label: "Ship Cap", value: `${ECON.shipCap ?? 30} Ships` }
      ],
      practicalUse: "Balance economy and military: capturing relays early provides income advantage. Don't float money : spend it on ships to project force. Cheap ships are cost-effective for relay capture; expensive ships win fleet engagements.",
      commonProblems: [
        "Can't buy ships? Check your money and fleet cap.",
        "Losing income? Enemy may control more relays : recapture them.",
        "Fleet cap reached? Destroyed ships free up cap space."
      ],
      related: ["movement", "combat-styles", "multiplayer", "blueprint-designer", "ship-pricing", "capture-mechanics"]
    },
  {
      id: "ship-pricing",
      category: "economy-objectives",
      title: "Ship Pricing Formula",
      summary: "How Ship Costs Are Summed Directly From Component Prices.",
      keywords: ["ship pricing", "cost", "formula", "component cost"],
      howItWorks: "The server and client both calculate ship cost by summing component.cost for every component in the design. The component balance is the only place to change a component's price. Fleet capacity and hangar availability are separate rules and do not alter ship cost.",
      importantStats: [
        { label: "Component Cost", value: "Direct value on each component" }
      ],
      practicalUse: "Set direct component prices to control ship cost. Lower-cost ships leave more money for additional purchases, up to the fleet cap.",
      commonProblems: [
        "Ship too expensive? Inspect the direct costs of its components.",
        "Not enough ships? Check your available money and the fleet cap."
      ],
      related: ["economy", "ship-cost-formula"]
    },
  {
      id: "capture-mechanics",
      category: "economy-objectives",
      title: "Relay Capture Mechanics",
      summary: "How relay capture works: progress rates, decay, and multipliers.",
      keywords: ["capture", "relay", "progress", "decay", "rate", "neutral", "control", "victory"],
      howItWorks: "Relays are neutral capturable points. Ships near a relay increase their owner's capture progress. The base capture rate is augmented per ship present. When a relay changes ownership, the new owner gets a progress multiplier to consolidate control faster. If no ships are near a neutral relay, progress decays back toward neutral.",
      importantStats: [
        { label: "Neutral Decay", value: `${GENERATED_BALANCE.capture?.neutralDecayPerSecond ?? 0.08}/s` },
        { label: "Base Capture Rate", value: `${GENERATED_BALANCE.capture?.baseCaptureRate ?? 0.1}/s` },
        { label: "Capture Rate Per Ship", value: `+${GENERATED_BALANCE.capture?.captureRatePerShip ?? 0.045}/s` },
        { label: "New Owner Multiplier", value: `${GENERATED_BALANCE.capture?.newOwnerProgressMultiplier ?? 3}×` }
      ],
      practicalUse: "Send multiple ships to a relay to capture it faster. The new-owner multiplier means freshly captured relays consolidate quickly : push hard right after capture. Hold majority control for 20 seconds to win.",
      commonProblems: [
        "Relay not capturing? Ensure your ships are close enough to the relay.",
        "Relay losing progress? Enemy ships may be contesting or no ships are present to hold it."
      ],
      related: ["economy", "movement", "combat-styles", "multiplayer"]
    },
  {
      id: "advanced-mechanics",
      category: "advanced-mechanics",
      title: "Advanced Mechanics",
      summary: "Detailed interactions that matter after the core build-and-fight loop is familiar.",
      keywords: ["advanced", "projectile", "missile", "repair", "stacking", "formula", "interaction"],
      howItWorks: "This section collects mechanics that are useful for optimisation but are not required to build a first working ship. Use it for projectile collision, missile guidance and countermeasures, diminishing-return Repair output, and other exact interaction rules. Component-specific exceptions and live balance values remain in Component Reference.",
      practicalUse: "Start here when a design works but its real combat result differs from the headline stats. Follow the related articles for the delivery, tracking, stacking, or conditional rule that changes the outcome.",
      commonProblems: [],
      related: ["projectile-mechanics", "missile-guidance", "repair-mechanics", "component-reference"]
    }
  ]),
  updates: Object.freeze({
    command: {
      summary: "Core succession and allied aura types, range, effectiveness, and stacking rules.",
      howItWorks: `Every ship requires one main Core. If it is destroyed, a live and powered Backup Command Core takes control; an unpowered backup has only a two-second emergency reserve. Under Backup Command, weapon accuracy, turn rate and drone command range all operate at ${BACKUP_EFFECTIVENESS_TEXT}. Command components project allied effects inside the shared 800 m radius and do not affect their source ship. Aura strength scales with component Power and Heat. Among overlapping sources of the same aura type, only the strongest applies, with distance and stable source order breaking ties. Different aura types multiply together because they improve different fleet functions.`,
      importantStats: [
        { label: "Aura Radius", value: `${GENERATED_BALANCE.commandAura?.range ?? 800} m` },
        { label: "Affects Source Ship", value: GENERATED_BALANCE.commandAura?.selfAura ? "Yes" : "No" },
        { label: "Same Aura Type", value: "Strongest Source Only" },
        { label: "Different Aura Types", value: "Multipliers Combine" },
        { label: "Backup Effectiveness", value: `${BACKUP_EFFECTIVENESS_TEXT} for weapon accuracy, turn rate and drone command range` },
        { label: "Unpowered Backup Reserve", value: "2s" }
      ],
      practicalUse: "Build command ships as fleet assets and keep intended recipients inside their circles. Avoid duplicating the same aura type unless redundancy is worth the cost; mix complementary aura types for a combined fleet package. A Backup Core protects an expensive hull but is not full performance.",
      commonProblems: [
        "Two identical auras give no extra bonus? Same-type sources suppress all but the strongest.",
        "Aura does not improve its carrier? Self aura is disabled.",
        "Backup exists but the ship still dies? It was destroyed, unpowered beyond its reserve, or not present when the main Core failed."
      ]
    },
    economy: {
      summary: "Active-match income, purchases, relays, bounties, fleet limits, and both victory systems.",
      howItWorks: "Ready players earn base income during an active match, plus income for every relay their team owns. Destroying an enemy ship pays a kill bounty based on its purchase cost, and taking a relay pays a capture bonus to the capturing team. Purchases spend current money and count living ships against the 30-ship cap. Classic mode is won by holding every relay fully controlled and uncontested for 20 seconds. Station mode never awards relay victory: relays remain income, sensor, repair, and strategic objectives, while destroying an enemy home station is the only match win condition.",
      importantStats: [
        { label: "Starting Money", value: `\u00a3${ECON.startingMoney ?? 1000}` },
        { label: "Base Income", value: `\u00a3${ECON.baseIncome ?? 20}/s` },
        { label: "Relay Income", value: `\u00a3${ECON.relayIncome ?? 5}/s Each` },
        { label: "Kill Bounty", value: `${Math.round((ECON.killBountyRatio ?? 0.28) * 100)}% Of Cost, Minimum \u00a3${ECON.killBountyMin ?? 24}` },
        { label: "Capture Bonus", value: `\u00a3${ECON.captureBonus ?? 70}` },
        { label: "Living Ship Cap", value: `${ECON.shipCap ?? 30}` },
        { label: "Classic Victory Hold", value: "20s" }
      ],
      practicalUse: "Treat relay pressure as both economy denial and battlefield positioning. Cheap ships project capture pressure efficiently, while durable fleets protect the income lead. In station mode, use relays to sustain the assault but keep the enemy home station as the strategic end state.",
      commonProblems: [
        "Money is not increasing? Income runs only for Ready players during an active match.",
        "All relays owned but no victory? They must be fully controlled and uncontested for the full Classic countdown.",
        "Relays do not end a station match? Only home-station destruction wins that mode."
      ],
      related: ["ship-pricing", "capture-mechanics", "stations-infrastructure", "movement"]
    },
    "ship-pricing": {
      title: "Purchasing Ships",
      summary: "When purchases are allowed, how quantity works, and what consumes fleet capacity.",
      keywords: ["buy", "purchase", "deploy", "quantity", "money", "fleet cap", "active match", "ready"],
      howItWorks: "Ships are purchased only during an active match by a player who has Readied Up and has a saved blueprint. The server validates the current design, effective thrust, money, and living-ship cap at the moment of purchase. A single request may buy one to five copies. Each copy costs the same authoritative design price and occupies one fleet slot while alive. Destroyed ships free fleet capacity. In station mode, purchases enter the home station's hangar queue and launch as soon as their assigned bay is available rather than appearing instantly.",
      importantStats: [
        { label: "Quantity Per Request", value: "1 To 5" },
        { label: "Living Ship Cap", value: `${ECON.shipCap ?? 30}` },
        { label: "Unit Price", value: "Sum Of Placed Component Costs" },
        { label: "Required Phase", value: "Active" },
        { label: "Required Player State", value: "Ready" }
      ],
      practicalUse: "Buy small batches when hangars are busy. Keep enough money for replacements and check the purchase error before changing a blueprint: phase, readiness, money, cap, and design validity are separate blockers.",
      commonProblems: [
        "Buy button is disabled? Confirm active phase, Ready state, saved blueprint, money, and fleet space.",
        "Station purchase is paid but not visible yet? Its assigned hangar may still be busy.",
        "Need the numeric formula? Open Ship Cost Formula in Building Ships."
      ],
      related: ["ship-cost-formula", "ship-validation", "economy", "stations-infrastructure"]
    },
    "capture-mechanics": {
      summary: "Classic pressure capture and station-mode neutral capture, destruction transfer, and recovery.",
      howItWorks: "In Classic mode, every nearby ship contributes pressure equal to one plus its effective capture bonus. The team or solo player with strictly highest pressure advances the relay; a tie contests it and freezes progress. Empty progress decays. Capture speed is the base rate plus leader pressure times the per-ship rate. After a relay changes ownership, its first progress step is tripled to establish the new owner's foothold. When all relays are fully owned and uncontested, the 20-second victory countdown begins. Station-mode relays use structural state instead: a neutral relay takes 10 uncontested seconds to claim, while reducing an enemy relay to zero hull transfers it immediately to the attacker at 35% hull. A transferred relay recovers without shields and becomes operational after reaching 25% hull. Station relays never trigger victory.",
      importantStats: [
        { label: "Classic Base Rate", value: `${GENERATED_BALANCE.capture?.baseCaptureRate ?? 0.1}/s` },
        { label: "Classic Per Pressure", value: `+${GENERATED_BALANCE.capture?.captureRatePerShip ?? 0.045}/s` },
        { label: "Classic Empty Decay", value: `${GENERATED_BALANCE.capture?.neutralDecayPerSecond ?? 0.08}/s` },
        { label: "Station Neutral Capture", value: `${GENERATED_BALANCE.infrastructure?.relayStation?.captureDurationSeconds ?? 10}s` },
        { label: "Station Transfer Hull", value: `${Math.round((GENERATED_BALANCE.infrastructure?.relayStation?.captureRestoreHpRatio ?? 0.35) * 100)}%` },
        { label: "Station Operational At", value: `${Math.round((GENERATED_BALANCE.infrastructure?.relayStation?.recoveryOperationalHpRatio ?? 0.25) * 100)}% Hull` }
      ],
      practicalUse: "In Classic, bring enough pressure to beat the enemy rather than merely matching it, and protect every relay during the victory hold. In station mode, defend damaged owned relays before they hit zero and escort newly transferred relays through recovery.",
      commonProblems: [
        "Classic progress is frozen? Opposing pressure is tied.",
        "Empty Classic relay loses progress? Unheld partial progress decays.",
        "Station relay changed owner immediately at zero hull? Hostile destruction transfers it; neutral relays use timed capture."
      ],
      related: ["economy", "stations-infrastructure", "movement", "command"]
    },
    "advanced-mechanics": {
      summary: "Exact delivery, guidance, repair, targeting, and damage interactions for optimisation.",
      howItWorks: "Advanced Mechanics explains rules that sit between the headline component stats and the observed result: projectile travel and collision, missile guidance and countermeasures, target validity and firing arcs, component destruction, shield leakage, armour interaction, and delivered repair output. These articles explain stable system behaviour; Component Reference supplies the current numeric part values.",
      practicalUse: "Open this section when a working design behaves differently from its paper DPS, defence, or repair total. Identify whether the gap comes from acquisition, delivery, protection, component state, or recovery, then follow the relevant article.",
      commonProblems: [
        "Paper DPS is higher than combat DPS? Check time on target, arcs, Heat, Power, accuracy, and interception.",
        "Defence total looks healthy but a ship collapses? Inspect leakage, local component loss, and damage-family matchups."
      ],
      related: ["projectile-mechanics", "missile-guidance", "repair-mechanics", "targeting-and-arcs", "damage-and-destruction", "component-reference"]
    }
  }),
  extraArticles: Object.freeze([
  {
      id: "stations-infrastructure",
      category: "economy-objectives",
      title: "Stations & Infrastructure",
      summary: "Home-station launch queues and repair, relay transfer, recovery, and station-mode victory.",
      keywords: ["station", "home station", "relay station", "hangar", "launch queue", "repair", "recovery", "victory"],
      howItWorks: "With station infrastructure enabled, bought ships enter their team's home-station hangar queue and launch as soon as their assigned bay is available. Home stations repair allied ships in their repair radius after a combat delay and are the sole station-mode victory objective. Relay stations add economy, detection, repair, and forward pressure. Neutral relays use timed capture. Hostile relays transfer when their hull reaches zero, return at partial hull without shields, and remain recovering until the operational threshold. Home-station durability scales with the active opposing roster so team size is reflected in the objective.",
      importantStats: [
        { label: "Home Repair Radius", value: `${GENERATED_BALANCE.infrastructure?.homeStation?.repairRadius ?? 520} m` },
        { label: "Home Repair Delay", value: `${GENERATED_BALANCE.infrastructure?.homeStation?.repairDelaySeconds ?? 6}s` },
        { label: "Relay Capture Radius", value: `${GENERATED_BALANCE.infrastructure?.relayStation?.captureRadius ?? 280} m` },
        { label: "Neutral Relay Capture", value: `${GENERATED_BALANCE.infrastructure?.relayStation?.captureDurationSeconds ?? 10}s` },
        { label: "Transferred Relay Hull", value: `${Math.round((GENERATED_BALANCE.infrastructure?.relayStation?.captureRestoreHpRatio ?? 0.35) * 100)}%` },
        { label: "Recovery Threshold", value: `${Math.round((GENERATED_BALANCE.infrastructure?.relayStation?.recoveryOperationalHpRatio ?? 0.25) * 100)}%` }
      ],
      practicalUse: "Keep home-station launch approaches clear, retreat damaged ships into its repair area, and deny attackers sustained time on the objective. Treat a transferred relay as vulnerable until recovery completes.",
      commonProblems: [
        "Purchased ship waits at the station? Its assigned hangar is still occupied by another launch.",
        "Home station does not repair immediately? Recent combat enforces the repair delay.",
        "Relay has no shield after transfer? Recovery deliberately starts at partial hull without shields."
      ],
      related: ["economy", "capture-mechanics", "ship-pricing", "repair-mechanics", "sensors-detection"]
    }
  ])
});
