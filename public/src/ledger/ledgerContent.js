// Fleet Ledger content module: owns the article catalogue, categories, manual
// prose, and data-driven article generation from authoritative balance sources.
// Pure data + pure functions — no DOM, no side effects, unit-testable.

import { PART_STATS, PART_DEFS, partCategory, partDescription } from "../design/parts.js";
import { GENERATED_BALANCE } from "../generatedBalance.js";
import { formatMass, formatHull, formatShield, formatThrust, formatEnergy, formatRepair, formatDistance, formatSpeed, formatDamage, formatPercent } from "../design/statFormatting.js";
import { getMechanics, getMechanicsSearchText, SPECIAL_MECHANICS_COMPONENTS, LEDGER_RULE_CONTRACTS } from "./componentMechanics.js";

// Re-export for test access
export { SPECIAL_MECHANICS_COMPONENTS, LEDGER_RULE_CONTRACTS };

export const CATEGORIES = [
  { id: "overview", label: "Overview" },
  { id: "ship-construction", label: "Ship Construction" },
  { id: "power", label: "Power" },
  { id: "heat", label: "Heat" },
  { id: "movement", label: "Movement & Orders" },
  { id: "combat-styles", label: "Combat Styles" },
  { id: "weapons", label: "Weapons" },
  { id: "defence", label: "Defence" },
  { id: "drones", label: "Drones" },
  { id: "support", label: "Support Systems" },
  { id: "command", label: "Command Systems" },
  { id: "economy", label: "Economy & Objectives" },
  { id: "multiplayer", label: "Multiplayer & Lobby" },
  { id: "controls", label: "Controls" }
];

const ECON = GENERATED_BALANCE.economy || {};
const CAPTURE = GENERATED_BALANCE.capture || {};
const DRONES = GENERATED_BALANCE.drones || {};
const WIRING = GENERATED_BALANCE.wiringInfrastructure || {};
const MOVEMENT = GENERATED_BALANCE.movement || {};

// ---------------------------------------------------------------------------
// Manual articles (part 1: overview, construction, power, heat, movement)
// ---------------------------------------------------------------------------

const MANUAL_ARTICLES_PART_1 = [
  {
    id: "overview",
    category: "overview",
    title: "Fleet Ledger Overview",
    summary: "A reference guide to every system in Modular Fleet Arena.",
    keywords: ["guide", "help", "reference", "encyclopedia", "manual"],
    howItWorks: "The Fleet Ledger is an in-game encyclopaedia that explains game systems, components, weapons, and rules. It is available from the main menu and the blueprint designer. Opening the ledger pauses nothing — your game state is preserved behind the overlay. Use the category list to browse, or type in the search bar to find any article by title, keyword, or component name.",
    practicalUse: "New players should start with Ship Construction and Power to understand the core build loop. Experienced players can jump to specific weapon or defence articles for exact stats.",
    commonProblems: [],
    related: ["blueprint-designer", "power", "heat", "movement", "combat-styles"]
  },
  {
    id: "blueprint-designer",
    category: "ship-construction",
    title: "Blueprint Designer Interface",
    summary: "The Designer Interface, Component Palette, Build Grid, Placement, Removal, Undo, And Reset.",
    keywords: ["blueprint", "designer", "interface", "palette", "grid", "place", "remove", "undo", "reset", "clear"],
    howItWorks: "Open The Blueprint Designer From The Side Panel Or Main Menu. The Build Grid Is 15×15 Cells (Coordinates 0–14 On Each Axis). Select A Component From The Palette On The Left, Then Click A Grid Cell To Place It. Right-Click A Placed Part To Remove It — The Core Cannot Be Removed. Press R To Rotate Rotatable Components. Undo (Ctrl+Z) Reverses The Last Physical Edit. Reset Design Restores The Starter Ship; Clear All Removes Everything Except The Core. The Ship Summary Panel Updates Live As You Build. The Wiring Tab Lets You Draw Power And Data Cable Networks.",
    importantStats: [
      { label: "Grid Size", value: "15×15" },
      { label: "Grid Coordinate Range", value: "0–14" },
      { label: "Undo Support", value: "Full Edit History" },
      { label: "Core Removal", value: "Not Allowed" },
      { label: "Reset Design", value: "Restores Starter Ship" },
      { label: "Clear All", value: "Removes All Except Core" }
    ],
    practicalUse: "Start With The Default Design And Modify It. Use Clear All For A Blank Slate. Keep The Ship Summary Panel Visible To Catch Issues Early. Use The Wiring Tab To Route Power And Data Cables After Placing Components.",
    commonProblems: [
      "Can't Place A Part? Check For Overlap Or Out-Of-Bounds Footprint Cells.",
      "Can't Remove The Core? The Core Is Permanent — Use Clear All To Reset To A Bare Core.",
      "Changes Not Saving? Use The Save Button To Persist The Blueprint."
    ],
    related: ["placement-rules", "structural-connectivity", "ship-validation", "ship-cost-formula", "ship-summary", "wiring-infrastructure", "power", "heat"]
  },
  {
    id: "placement-rules",
    category: "ship-construction",
    title: "Component Placement & Rotation",
    summary: "How Footprints Work, Rotation Rules, And Which Components Can Be Rotated.",
    keywords: ["placement", "footprint", "rotation", "rotate", "maneuver thruster", "orientation", "anchor", "multi-cell"],
    howItWorks: "Every Component Has A Footprint (Width × Height In Grid Cells). Multi-Cell Footprints Expand From The Anchor Cell (Part.X, Part.Y). Rotation Pivots Around The Anchor Cell: 0° = Default, 90° = Clockwise, 180° = Flipped, 270° = Counter-Clockwise. Rotatable Components Include Weapons, Defence Components With Weapons, And Any Part With Rotatable Set To True Or Allowed Rotations Defined. Non-Rotatable Components Include Engines, Maneuver Thrusters, And Drone Bays. Maneuver Thrusters Auto-Rotate Based On Position: Left Of Centre → 90°, Right Of Centre → 270°. Components With A Two-Rotation Limit (90°/270°) Auto-Pick Side-Facing Based On X Position Relative To Grid Centre (7). Placement Is Blocked If Any Footprint Cell Is Out Of Bounds (0–14), Overlaps Another Part, Or Would Be Disconnected From The Core.",
    importantStats: [
      { label: "Grid Bounds", value: "0–14 (15×15)" },
      { label: "Rotation Steps", value: "0°, 90°, 180°, 270°" },
      { label: "Maneuver Thruster Auto-Rotation", value: "Based On X vs Centre (7)" },
      { label: "Default Rotation", value: "0°" },
      { label: "Non-Rotatable Types", value: "Engine, Maneuver Thruster, Drone Bay" }
    ],
    practicalUse: "Weapons On The Ship's Edges Can Be Rotated To Face Forward, Sideways, Or Backward. Maneuver Thrusters Auto-Face Outward — Place Them On The Correct Side. Drone Bays Cannot Be Rotated — Their Launch Edge Depends On Placement.",
    commonProblems: [
      "Part Facing The Wrong Way? Press R To Cycle Rotations.",
      "Maneuver Thruster Won't Rotate? It Auto-Rotates Based On Position.",
      "Footprint Hanging Off The Grid? Move The Anchor Cell So All Footprint Cells Fit Within 0–14."
    ],
    related: ["blueprint-designer", "structural-connectivity", "engine-exhaust", "ship-validation"]
  },
  {
    id: "structural-connectivity",
    category: "ship-construction",
    title: "Structural Connectivity",
    summary: "All Parts Must Connect To The Core Through Side-Adjacent Cells.",
    keywords: ["connectivity", "connected", "disconnected", "adjacent", "core", "heat pipe", "structure", "BFS"],
    howItWorks: "A Blueprint Is Valid Only If Every Part Is Structurally Connected To The Core. Connectivity Is Checked Via Breadth-First Search From The Core Through Side-Adjacent (4-Neighbour) Cells. Two Passes Are Performed: Physical Connectivity (All Parts Reachable) And Structural Connectivity (Non-Heat-Pipe Parts Must Not Rely On Heat Pipe Chains As Their Only Path). Heat Pipes Can Be Reached Through Other Heat Pipes, But A Non-Heat-Pipe Part Cannot Use A Heat-Pipe Chain As Its Only Path Back To The Core. Diagonal Adjacency Does NOT Count — Only Up, Down, Left, And Right. Overlapping Parts Are Filtered Before The Connectivity Check.",
    importantStats: [
      { label: "Adjacency Type", value: "4-Neighbour (Orthogonal)" },
      { label: "Heat Pipe Rule", value: "Non-Heat-Pipe Parts Cannot Depend On Heat Pipe Chains" },
      { label: "Core Required", value: "Exactly 1" },
      { label: "Diagonal Counts", value: "No" }
    ],
    practicalUse: "Build Outward From The Core In A Connected Shape. Avoid Diagonal Gaps — Parts Touching Only At Corners Are Disconnected. Heat Pipes Can Bridge To Radiators But Cannot Be The Structural Spine Of The Ship.",
    commonProblems: [
      "Disconnected Parts Error? Check For Diagonal-Only Connections Or Gaps.",
      "Heat Pipe Causing Issues? A Non-Heat-Pipe Part Behind A Heat Pipe Chain Is Structurally Invalid — Add A Frame Or Armor Path."
    ],
    related: ["blueprint-designer", "placement-rules", "ship-validation", "heat"]
  },
  {
    id: "engine-exhaust",
    category: "ship-construction",
    title: "Engine Exhaust Clearance",
    summary: "Engines Need Clear Exhaust Channels Behind Them Or They Provide No Thrust.",
    keywords: ["engine", "exhaust", "blocked", "thrust", "nozzle", "channel", "clearance", "maneuver thruster"],
    howItWorks: "Every Engine And Maneuver Thruster Has An Exhaust Direction Opposite To Its Thrust Direction. The Exhaust Channel Extends From The Nozzle Cells Outward In The Exhaust Direction To The Grid Edge. If Any Other Component Blocks The Exhaust Channel, The Engine Is Blocked And Contributes Zero Thrust. Blocked Engines Still Consume Mass And Cost But Provide No Movement. The Ship Summary Shows A Warning For Blocked Engines. Exhaust Direction Depends On Rotation: 0° = Downward, 90° = Left, 180° = Upward, 270° = Right.",
    importantStats: [
      { label: "Exhaust Grid Size", value: "15" },
      { label: "Blocked Engine Effect", value: "Zero Thrust (Mass And Cost Still Count)" },
      { label: "Exhaust Check Range", value: "Full Channel To Grid Edge" },
      { label: "0° Exhaust Direction", value: "Downward" },
      { label: "90° Exhaust Direction", value: "Left" },
      { label: "180° Exhaust Direction", value: "Upward" },
      { label: "270° Exhaust Direction", value: "Right" }
    ],
    practicalUse: "Place Engines On The Ship's Rear Edge (Bottom Row) Facing Backward (0° Rotation). Ensure No Components Are Behind The Engine Within Its Exhaust Channel. Maneuver Thrusters On The Side Edges Auto-Rotate Outward.",
    commonProblems: [
      "Engine Not Providing Thrust? Check If Another Part Blocks The Exhaust Channel.",
      "Ship Slow Despite Many Engines? Some Engines May Be Blocked — Check The Ship Summary For Blocked Engine Count.",
      "Maneuver Thruster Blocked? Ensure The Outward-Facing Channel Is Clear."
    ],
    related: ["placement-rules", "movement", "ship-validation", "ship-summary"]
  },
  {
    id: "ship-validation",
    category: "ship-construction",
    title: "Ship Validation Rules",
    summary: "All Rules A Blueprint Must Pass Before It Can Be Deployed.",
    keywords: ["validation", "rules", "core", "backup core", "overlap", "bounds", "drone bay", "max per ship", "engine requirement"],
    howItWorks: "Exactly One Core Is Required (Zero = Invalid, Two = Invalid). Maximum One Backup Command Core Is Allowed. All Parts Must Be Within The 15×15 Grid (Coordinates 0–14). No Overlapping Parts. All Parts Must Be Structurally Connected To The Core. Each Component Type Has A Max-Per-Ship Limit. Drone Bays Require A Configured Drone Type (Fighter, Defence, Or Repair) And An Exposed Two-Cell Launch Edge. Maximum Drone Bays Per Ship Is 4. At Least One Engine With Effective Thrust Is Required To Build (Validated At Build Time, Not Design Time). Ship Cost Must Be Within Min/Max Limits. The Player Must Have Enough Money To Build The Ship.",
    importantStats: [
      { label: "Core Count Required", value: "Exactly 1" },
      { label: "Backup Core Max", value: "1" },
      { label: "Grid Bounds", value: "0–14" },
      { label: "Min Ship Cost", value: `\u00a3${GENERATED_BALANCE.shipCostLimits?.minimum ?? 300}` },
      { label: "Max Ship Cost", value: `\u00a3${GENERATED_BALANCE.shipCostLimits?.maximum ?? 2000}` },
      { label: "Max Drone Bays", value: `${GENERATED_BALANCE.drones?.maxBaysPerShip ?? 4}` },
      { label: "Engine Requirement", value: "At Least 1 With Effective Thrust (Build Time)" }
    ],
    practicalUse: "The Designer Warns About Most Issues Live. Drone Bay Configuration (Drone Type) Must Be Set Before Deployment. The Thrust Requirement Is Only Enforced When Building — You Can Save A Design Without Engines But Cannot Deploy It.",
    commonProblems: [
      "Missing Core Error? Every Ship Needs Exactly One Core.",
      "Disconnected Parts Error? See The Structural Connectivity Article.",
      "Drone Bay Error? Set A Drone Type And Ensure An Exposed Two-Cell Edge.",
      "Add At Least One Engine Error? Place An Engine With Clear Exhaust."
    ],
    related: ["blueprint-designer", "structural-connectivity", "engine-exhaust", "ship-cost-formula", "ship-pricing"]
  },
  {
    id: "ship-cost-formula",
    category: "ship-construction",
    title: "Ship Cost & Fleet Count",
    summary: "How Ship Cost Is Calculated From Components, Mass, Weapons, And Wiring.",
    keywords: ["cost", "price", "formula", "fleet count", "weapon premium", "wiring cost", "infrastructure"],
    howItWorks: "Ship Cost = Base Cost + (Component Cost × Part Multiplier) + (Mass × Mass Multiplier) + (Hull × Hull Multiplier) + (Shield × Shield Multiplier) + (Repair Rate × Repair Multiplier) + Weapon Premiums. Weapon Premiums: Blaster £18, Missile £32, Railgun £48, Beam £42 Per Weapon. Wiring Infrastructure Cost (Power + Data Cable) Is Added On Top, Not Multiplied By Hull/Mass/Weapon Premiums. Final Cost Is Clamped To £300–£2000. Fleet Count = Floor(Base / Max(MinDivisor, UnitCost × UnitCostMult + Mass × MassMult)), Clamped To 1–5.",
    importantStats: [
      { label: "Base Ship Cost", value: `\u00a3${GENERATED_BALANCE.shipPricing?.baseShipCost ?? 48}` },
      { label: "Part Cost Multiplier", value: `${GENERATED_BALANCE.shipPricing?.partCostMultiplier ?? 1.32}×` },
      { label: "Mass Cost Multiplier", value: `${GENERATED_BALANCE.shipPricing?.massCostMultiplier ?? 0.9}×` },
      { label: "Hull Cost Multiplier", value: `${GENERATED_BALANCE.shipPricing?.hullCostMultiplier ?? 0.012}×` },
      { label: "Shield Cost Multiplier", value: `${GENERATED_BALANCE.shipPricing?.shieldCostMultiplier ?? 0.05}×` },
      { label: "Repair Cost Multiplier", value: `${GENERATED_BALANCE.shipPricing?.repairCostMultiplier ?? 0.8}×` },
      { label: "Blaster Premium", value: `\u00a3${GENERATED_BALANCE.shipPricing?.weaponPremiums?.blaster ?? 18}/Weapon` },
      { label: "Missile Premium", value: `\u00a3${GENERATED_BALANCE.shipPricing?.weaponPremiums?.missile ?? 32}/Weapon` },
      { label: "Railgun Premium", value: `\u00a3${GENERATED_BALANCE.shipPricing?.weaponPremiums?.railgun ?? 48}/Weapon` },
      { label: "Beam Premium", value: `\u00a3${GENERATED_BALANCE.shipPricing?.weaponPremiums?.beam ?? 42}/Weapon` },
      { label: "Min Ship Cost", value: `\u00a3${GENERATED_BALANCE.shipPricing?.minimum ?? 300}` },
      { label: "Max Ship Cost", value: `\u00a3${GENERATED_BALANCE.shipPricing?.maximum ?? 2000}` },
      { label: "Wiring Cost", value: "Added On Top (Not Multiplied)" },
      { label: "Fleet Count Base", value: `${GENERATED_BALANCE.shipPricing?.fleetCountFormulaInputs?.base ?? 260}` },
      { label: "Fleet Count Min Divisor", value: `${GENERATED_BALANCE.shipPricing?.fleetCountFormulaInputs?.minimumDivisor ?? 58}` },
      { label: "Fleet Count Range", value: "1–5 Ships" }
    ],
    practicalUse: "Cheaper Ships Mean More Ships In Your Fleet. Weapon Premiums Make Expensive Ships Cost-Inefficient. Wiring Cost Is Additive — Long Cable Runs Increase Cost Without Being Subject To Multipliers.",
    commonProblems: [
      "Ship Too Expensive? Reduce Weapon Count, Use Cheaper Weapons, Or Shrink The Design.",
      "Fleet Count Too Low? Lower The Unit Cost — The Formula Divides A Base Value By Cost.",
      "Wiring Cost Too High? Shorten Cable Runs And Use Light Cable For Low-Power Branches."
    ],
    related: ["ship-pricing", "economy", "blueprint-designer", "wiring-infrastructure", "ship-validation"]
  },
  {
    id: "ship-summary",
    category: "ship-construction",
    title: "Ship Summary Panel",
    summary: "The Live Overview Of Build Cost, Mass, Hull, Shield, Weapons, Speed, Turn, Power, And Status Warnings.",
    keywords: ["ship summary", "overview", "stats", "status", "warnings", "mobility", "power details", "combat details", "support details"],
    howItWorks: "The Ship Summary Shows 9 Headline Values: Build Cost, Class, Mass, Hull, Shield, Weapon DPS, Max Speed, Turn Rate, And Power. Below The Overview, Status Messages Appear Based On Real Conditions: Power Shortfall, Load Shedding, Stranded Generation, No Effective Thrust, Mass Drag Limiting Speed, Asymmetric Turning, No Shield Coverage, No Weapons, Backup Command Available, Insufficient Cooling, Overheating Components, And Cable Overload. Four Collapsible Detail Sections Provide Engineering Numbers: Mobility Details (Acceleration, Thrust-To-Mass, Engine Efficiency, Turn Rates, Blocked Engines), Power Details (Generation, Demand, Delivered, Spare, Stranded, Unmet, Efficiency, Penalty, Load Shed, Energy Storage), Combat Details (Per-Weapon-Family DPS, Range, Point Defence, Beam Radius, Shield Recharge), And Support Details (Repair Rate, Drone Capacity, Drone Squads, Capture Pressure, Cooling Bonus).",
    importantStats: [
      { label: "Overview Fields", value: "9 (Cost, Class, Mass, Hull, Shield, DPS, Speed, Turn, Power)" },
      { label: "Detail Sections", value: "4 (Mobility, Power, Combat, Support)" },
      { label: "Status Levels", value: "Good, Warning, Bad, Neutral" },
      { label: "Live Updates", value: "Yes — Updates As You Build" }
    ],
    practicalUse: "Watch The Power Field — Spare Means Healthy, Short Means Problems. Check Status Messages For Specific Issues. Expand Detail Sections For Engineering Numbers. The Summary Updates Live As You Build.",
    commonProblems: [
      "Power Showing Short? Add Reactors Or Reduce Power-Hungry Components.",
      "No Effective Thrust? Add Engines With Clear Exhaust Or Restore Power.",
      "Asymmetric Turning? Add Maneuver Thrusters Or Gyroscopes On The Weak Side.",
      "Insufficient Cooling? Add Radiators With Exposed Edges Or Heat Sinks."
    ],
    related: ["blueprint-designer", "power", "heat", "movement", "ship-cost-formula", "engine-exhaust"]
  },
  {
    id: "power",
    category: "power",
    title: "Power Systems",
    summary: "Power generation, consumption, wiring, and overload protection.",
    keywords: ["power", "reactor", "generator", "battery", "capacitor", "wiring", "cable", "energy", "overload"],
    howItWorks: "Every component either generates or consumes power. Reactors and auxiliary generators produce power; weapons, shields, engines, and support modules consume it. Power is delivered through wiring — physical cable networks that connect sources to consumers. Each cable tier (Light, Standard, Heavy) has a sustained capacity (safe continuous load) and a peak capacity (maximum burst). Drawing above sustained generates extra heat and overload stress. If a cable network is overloaded, protection circuits trip and disconnect non-priority consumers until the load drops.",
    importantStats: [
      { label: "Light Cable Sustained", value: `${WIRING.powerTiers?.light?.sustainedCapacityMw ?? 4} MW` },
      { label: "Light Cable Peak", value: `${WIRING.powerTiers?.light?.peakCapacityMw ?? 7} MW` },
      { label: "Standard Cable Sustained", value: `${WIRING.powerTiers?.standard?.sustainedCapacityMw ?? 10} MW` },
      { label: "Standard Cable Peak", value: `${WIRING.powerTiers?.standard?.peakCapacityMw ?? 16} MW` },
      { label: "Heavy Cable Sustained", value: `${WIRING.powerTiers?.heavy?.sustainedCapacityMw ?? 24} MW` },
      { label: "Heavy Cable Peak", value: `${WIRING.powerTiers?.heavy?.peakCapacityMw ?? 36} MW` },
      { label: "Light Cable Heat Displacement", value: `${WIRING.powerTiers?.light?.heatCapacityDisplacement ?? 2}` },
      { label: "Standard Cable Heat Displacement", value: `${WIRING.powerTiers?.standard?.heatCapacityDisplacement ?? 4}` },
      { label: "Heavy Cable Heat Displacement", value: `${WIRING.powerTiers?.heavy?.heatCapacityDisplacement ?? 8}` },
      { label: "Data Cable Heat Displacement", value: `${WIRING.data?.heatCapacityDisplacement ?? 1}` },
      { label: "Overload Start Ratio", value: `${GENERATED_BALANCE.powerProtection?.overloadStartRatio ?? 1}× Sustained` },
      { label: "Recovery Start Ratio", value: `${GENERATED_BALANCE.powerProtection?.recoveryStartRatio ?? 0.95}× Sustained` },
      { label: "Critical Stress Ratio", value: formatPercent(GENERATED_BALANCE.powerProtection?.criticalStressRatio ?? 0.75) },
      { label: "Trip Cooldown", value: `${GENERATED_BALANCE.powerProtection?.tripCooldownSeconds ?? 4}s` }
    ],
    practicalUse: "Use Standard cable for most builds. Upgrade to Heavy for weapon-heavy ships that draw bursts above 10 MW. Keep power use below generation to maintain full combat efficiency — underpowered ships suffer reduced movement, shields, and weapon performance.",
    commonProblems: [
      "Weapons not firing? Check if power cables are connected and not tripped.",
      "Shields weak? Power deficit reduces shield efficiency by pow(ratio, 1.35).",
      "Cable overheating? Upgrade to a higher tier or split the load across multiple networks."
    ],
    related: ["blueprint-designer", "heat", "wiring-infrastructure"]
  },
  {
    id: "wiring-infrastructure",
    category: "power",
    title: "Wiring Infrastructure",
    summary: "Power and data cable networks, tiers, and costs.",
    keywords: ["wiring", "cable", "power", "data", "network", "tier", "light", "standard", "heavy", "auto-wire"],
    howItWorks: "Wiring physically connects power sources to consumers through cable networks routed through occupied ship cells. Power cable comes in three tiers: Light, Standard, and Heavy. Data cable is a single tier and carries data support signals — it has no capacity or overload mechanics. Cables displace heat capacity from the cells they pass through. Use the Wiring tab in the designer to draw, inspect, and clear networks. Auto-wire creates a simple deterministic Standard-cable route connecting every powered component.",
    importantStats: [
      { label: "Light Cable Cost", value: `\u00a3${WIRING.powerTiers?.light?.costPerHostedCell ?? 1}/Cell` },
      { label: "Standard Cable Cost", value: `\u00a3${WIRING.powerTiers?.standard?.costPerHostedCell ?? 2}/Cell` },
      { label: "Heavy Cable Cost", value: `\u00a3${WIRING.powerTiers?.heavy?.costPerHostedCell ?? 5}/Cell` },
      { label: "Data Cable Cost", value: `\u00a3${WIRING.data?.costPerHostedCell ?? 0.25}/Cell` },
      { label: "Light Cable Heat At Sustained", value: `${WIRING.powerTiers?.light?.cableHeatAtSustainedPerHostedCell ?? 0.35}/Cell` },
      { label: "Standard Cable Heat At Sustained", value: `${WIRING.powerTiers?.standard?.cableHeatAtSustainedPerHostedCell ?? 0.55}/Cell` },
      { label: "Heavy Cable Heat At Sustained", value: `${WIRING.powerTiers?.heavy?.cableHeatAtSustainedPerHostedCell ?? 0.9}/Cell` },
      { label: "Cable Heat Exponent", value: `${WIRING.powerTiers?.light?.cableHeatUtilisationExponent ?? 2.2}` },
      { label: "Light Cable Inspection Label", value: WIRING.powerTiers?.light?.inspectionLabel ?? "Light Cable" },
      { label: "Standard Cable Inspection Label", value: WIRING.powerTiers?.standard?.inspectionLabel ?? "Standard Cable" },
      { label: "Heavy Cable Inspection Label", value: WIRING.powerTiers?.heavy?.inspectionLabel ?? "Heavy Bus" },
      { label: "Data Cable Inspection Label", value: WIRING.data?.inspectionLabel ?? "Data Cable" },
      { label: "Min Component Heat Capacity", value: `${WIRING.minimumComponentHeatCapacity ?? 10}` }
    ],
    practicalUse: "Auto-wire is a good starting point. Manually upgrade critical paths to Heavy cable for weapon-heavy builds. Inspect cable by hovering to see live power flow and load status.",
    commonProblems: [
      "Cable overlapping? Power and Data are separate networks; overlap never silently deletes the other.",
      "Cable too expensive? Use Light cable for low-power branches and Standard for main trunks.",
      "Disconnected sections? Check that cable routes pass through occupied cells only."
    ],
    related: ["power", "heat", "blueprint-designer"]
  },
  {
    id: "heat",
    category: "heat",
    title: "Heat Management",
    summary: "Heat generation, transfer, cooling, and overheating consequences.",
    keywords: ["heat", "thermal", "radiator", "heat sink", "heat pipe", "cooling", "overheat", "meltdown"],
    howItWorks: "Every active component generates heat. Heat accumulates in each component's heat capacity and transfers to adjacent components, frames, and cable routes. Radiators remove heat continuously but only at 25% efficiency when fully enclosed — they need an exposed exterior edge. Heat sinks absorb heat from connected frames and boost adjacent heat capacity. Heat pipes transfer heat to a connected heat sink or radiator route. When a component reaches 100% heat it overheats and shuts down. Reactors that overheat will melt down, dealing area damage.",
    importantStats: [
      { label: "Minimum Component Heat Capacity", value: `${WIRING.minimumComponentHeatCapacity ?? 10}` }
    ],
    practicalUse: "Place radiators on the ship's exterior edges for maximum cooling. Use heat sinks as thermal buffers for burst-heavy weapons. Connect heat pipes to move heat from hot spots to radiator clusters. The Heat analysis tab shows predicted thermal loads under Idle, Typical Combat, and Max Load scenarios.",
    commonProblems: [
      "Reactor melting down? It overheated — add more radiators or reduce sustained load.",
      "Weapons stopping mid-fight? They likely overheated. Add heat sinks near weapon clusters.",
      "Radiators not cooling? Check if they have an exposed exterior edge — enclosed radiators are only 25% effective."
    ],
    related: ["power", "blueprint-designer", "wiring-infrastructure"]
  },
  {
    id: "movement",
    category: "movement",
    title: "Movement & Orders",
    summary: "Engines, thrust, turn rate, mass classes, and issuing commands.",
    keywords: ["movement", "engine", "thrust", "turn", "speed", "mass", "orders", "command", "right-click", "rally"],
    howItWorks: "Ships move using engine thrust. Thrust stacks with diminishing returns: each additional engine contributes 90% of the previous one's thrust (100%, 90%, 81%, 73%, etc.). Turn rate is improved by gyroscopes and maneuver thrusters, also with diminishing returns (92% falloff). Maneuver thrusters provide directional torque based on their distance from the ship's centre of mass — the lever arm grows from a minimum of 0.35 up to a maximum of 1.75 per cell of offset. Mass determines a ship's soft speed and turn caps across four classes. If a ship is underpowered, movement is multiplied by pow(powerGeneration / max(powerUse, 1), 1.8), clamped to a minimum 18%. Shield and system efficiency also drops with pow(ratio, 1.35). Surplus power grants up to 8% bonus movement. Issue orders by selecting ships and right-clicking the arena. Right-click an enemy to focus fire. Set a rally point to direct newly built ships. Ships without engines cannot move. Backup Command Core reduces turn rate by 10%.",
    importantStats: [
      { label: "Engine Stacking Falloff", value: "0.90× Per Engine" },
      { label: "Gyroscope Stacking Falloff", value: "0.92× Per Module" },
      { label: "Maneuver Thruster Stacking Falloff", value: "0.92× Per Module" },
      { label: "Maneuver Min Lever", value: `${MOVEMENT.maneuverThrusterLever?.minimumLever ?? 0.35}` },
      { label: "Maneuver Lever Per Cell", value: `${MOVEMENT.maneuverThrusterLever?.leverPerCell ?? 0.35}` },
      { label: "Maneuver Max Lever", value: `${MOVEMENT.maneuverThrusterLever?.maximumLever ?? 1.75}` },
      { label: "Base Speed", value: "132 m/s" },
      { label: "Speed Per Thrust", value: "1.05" },
      { label: "Mass Turn Divisor", value: "82" },
      { label: "Power Deficit Min", value: "18%" },
      { label: "Power Deficit Exponent", value: "1.8 (Movement), 1.35 (Systems)" },
      { label: "Surplus Power Bonus", value: "Up To +8%" },
      ...((MOVEMENT.massClasses || []).map((c) => ({
        label: `${c.name} (${c.mass})`,
        value: `Speed ${c.softSpeedCap}, Turn ${c.softTurnCap}`
      })))
    ],
    practicalUse: "Light ships are fast and agile — ideal for capture runs and flanking. Capital ships are slow but tanky and pack heavy weapons. Use maneuver thrusters for better turning without adding much straight-line speed. Position maneuver thrusters far from the centre of mass for maximum lever effect. Gyroscopes are simpler but less powerful than a well-placed pair of maneuver thrusters.",
    commonProblems: [
      "Ship not moving? Check for engines and sufficient power.",
      "Turning too slowly? Add gyroscopes or maneuver thrusters.",
      "Ship slow despite engines? High mass reduces speed — check the Ship Summary for your mass class."
    ],
    related: ["combat-styles", "blueprint-designer", "power", "economy"]
  }
];

// ---------------------------------------------------------------------------
// Manual articles (part 2: combat-styles, defence, drones, support, command)
// ---------------------------------------------------------------------------

const MANUAL_ARTICLES_PART_2 = [
  {
    id: "weapons",
    category: "weapons",
    title: "Weapons",
    summary: "Overview of all weapon types and their roles in combat.",
    keywords: ["weapon", "missile", "rail", "laser", "cannon", "beam", "torpedo", "flak", "point defence", "damage", "dps"],
    howItWorks: "Weapons are the primary damage-dealing components. Each weapon type has distinct trade-offs: missiles track targets but can be intercepted, rails have long range and high alpha damage but slow fire rates, lasers provide continuous beam damage, cannons offer rapid fire with moderate damage, and beams melt shields. Weapon stats are auto-generated from the authoritative component balance data. Select a specific weapon from the category list to see exact damage, fire rate, range, and tracking values.",
    practicalUse: "Mix weapon types for flexibility: missiles for burst, rails for range, point defense for anti-missile. Check the component articles for exact stats and trade-offs.",
    commonProblems: [
      "Weapons not firing? Check power supply and cable connections.",
      "Missiles intercepted? Consider overwhelming enemy point defense with swarm missiles.",
      "Rails missing? They have narrow arcs — position ships carefully."
    ],
    related: ["combat-styles", "defence", "power", "heat", "blueprint-designer"]
  },
  {
    id: "combat-styles",
    category: "combat-styles",
    title: "Combat Styles",
    summary: "Charge, Hold, Orbit, Kite, and Static define how ships move around their current combat target.",
    keywords: ["combat", "style", "hold", "charge", "orbit", "kite", "static", "behavior", "ai", "stance"],
    howItWorks: "Each ship follows one of five combat movement styles. Charge pursues continuously, leads a moving target, and drives through weapon range to contact without braking. Hold approaches when outside preferred weapon range, then fires from an established position without retreating from closer targets. Orbit circles at its intended radius with a stable direction and continuous radial correction. Kite retreats when too close, slides along the world edge rather than pinning itself against it, stops retreating once safe range is restored, and approaches only when the target is beyond weapon range. Static never repositions for combat at all: it holds the ground it is standing on and turns to face whatever it is shooting. Ships acquire another nearby enemy when their current target becomes invalid. A move order you issue by hand overrides all of this until you give the ship another command.",
    importantStats: [
      { label: "Hold Range Ratio", value: "90% Of Max Weapon Range" },
      { label: "Charge Stop", value: "Contact Distance" },
      { label: "Orbit Range Ratio", value: "75% Of Max Weapon Range" },
      { label: "Kite Safe Range", value: "90% Of Max Weapon Range" },
      { label: "Static Movement", value: "None" }
    ],
    practicalUse: "Hold is the general ranged default. Charge suits ships that must force close contact. Orbit rewards agile ships that can sustain a curved course. Kite suits long-range ships built to preserve separation. Static suits ships you want anchored exactly where you put them.",
    commonProblems: [
      "Ship not engaging? It may have no weapons with range, or the target is out of range.",
      "Hold ship moving closer? Its target has moved outside preferred weapon range.",
      "Kite ship moving away? Its target is inside the safe-range threshold.",
      "Ship ignoring its stance? You gave it a move or stop order by hand -- those hold until you command it again.",
      "Want to change style mid-match? Select ships and use the combat style buttons in the match panel."
    ],
    related: ["movement", "weapons", "defence"]
  },
  {
    id: "defence",
    category: "defence",
    title: "Defence Systems",
    summary: "Shields, armor, point defense, flak, and damage mitigation.",
    keywords: ["defence", "defense", "shield", "armor", "composite armor", "point defense", "flak", "interceptor", "aegis", "decoy"],
    howItWorks: "Defence components protect ships from incoming damage. Shields absorb damage and regenerate over time (consuming power). Armor plates add hull HP and can reduce incoming damage. Point defense lasers destroy incoming missiles and drones. Flak cannons provide short-range anti-missile and anti-swarm defence. Interceptor pods offer longer-range missile interception. Aegis projectors project a fast-recharging shield field at high power cost. Decoy launchers deploy false targets that can pull guided missiles away.",
    practicalUse: "Layer shields over armor for maximum survivability. Point defense is essential against missile-heavy opponents. Use armor on the forward facing for charge-style ships. Decoy launchers counter guided missile spam.",
    commonProblems: [
      "Shields not regenerating? Check power supply — shields need power to regenerate.",
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
    howItWorks: "Drone Bays launch and rebuild squads of configurable drones. Each bay launches a squad of 3 drones by default. Drones come in three types: Fighter (attacks the parent ship's target and nearby hostile drones), Defence (guards the parent ship and prioritises hostile drones), and Repair (repairs the parent ship, then nearby friendly ships). Drones have limited fuel and must return to refuel. A bay must have one complete two-cell edge exposed for launch.",
    importantStats: [
      { label: "Squad Size", value: `${DRONES.squadSize ?? 3}` },
      { label: "Max Bays Per Ship", value: `${DRONES.maxBaysPerShip ?? 4}` },
      { label: "Max Active Per Ship", value: `${DRONES.maxActivePerShip ?? 12}` },
      { label: "Max Active Per Player", value: `${DRONES.maxActivePerPlayer ?? 48}` },
      { label: "Fuel Duration", value: `${DRONES.fuelSeconds ?? 15}s` },
      { label: "Refuel Time", value: `${DRONES.refuelSeconds ?? 2}s` },
      { label: "Launch Interval", value: `${DRONES.launchIntervalSeconds ?? 0.65}s` },
      { label: "Launch Duration", value: `${DRONES.launchDurationSeconds ?? 0.8}s` },
      { label: "Orphan Lifetime", value: `${DRONES.orphanLifetimeSeconds ?? 3}s` },
      { label: "Standby Power", value: `${DRONES.standbyPowerMw ?? 3} MW` },
      { label: "Active Power", value: `${DRONES.activePowerMw ?? 7} MW` },
      { label: "Production Power", value: `${DRONES.productionPowerMw ?? 11} MW` },
      { label: "Standby Heat", value: `${DRONES.standbyHeatPerSecond ?? 0.5}/s` },
      { label: "Active Heat", value: `${DRONES.activeHeatPerSecond ?? 1.2}/s` },
      { label: "Production Heat", value: `${DRONES.productionHeatPerSecond ?? 3}/s` }
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
    category: "support",
    title: "Support Systems",
    summary: "Repair modules, targeting computers, signal amplifiers, stabilizer nodes, and fire control.",
    keywords: ["support", "repair", "targeting", "signal", "stabilizer", "fire control", "accuracy", "range", "fire rate"],
    howItWorks: "Support components provide non-weapon utility that enhances your ship's combat effectiveness. Repair modules restore hull HP to the parent ship and nearby allies. Targeting computers improve weapon accuracy. Signal amplifiers extend weapon range. Stabilizer nodes improve accuracy and slightly help turning. Fire Control improves weapon fire rate. Repair Beams project a hull-recovery beam toward friendly ships. Each support component consumes power and should be wired into your power network.",
    practicalUse: "Repair modules are valuable on tanky ships that expect to take damage. Targeting computers benefit any weapon-heavy build. Signal amplifiers extend range for railguns and blasters. Stabilizer nodes are a good all-round pick that also helps turning. Fire Control increases DPS for all weapons in range.",
    commonProblems: [
      "Repair not working? The module needs power and a valid target in range.",
      "Targeting computer not helping? Its accuracy bonus applies to all weapons within the ship's fire control range.",
      "Signal amplifier not extending range? It adds a flat range bonus to all weapons on the ship."
    ],
    related: ["defence", "command", "power", "weapons"]
  },
  {
    id: "command",
    category: "command",
    title: "Command Systems",
    summary: "Command cores, backup cores, and command auras.",
    keywords: ["command", "core", "backup core", "aura", "command range", "accuracy", "tracking"],
    howItWorks: "Every ship requires a Core component — it is the command centre. If the Core is destroyed, the ship is lost. A Backup Command Core can be installed to keep the ship operational if the main Core is destroyed, but with reduced combat efficiency. Command components project a command aura that improves weapon accuracy, tracking, and target acquisition for friendly ships within range. All command auras share the same range so players can judge coverage at a glance.",
    importantStats: [
      { label: "Command Aura Range", value: `${GENERATED_BALANCE.commandAura?.range ?? 800} m` },
      { label: "Aura Affects Self", value: `${GENERATED_BALANCE.commandAura?.selfAura ? "Yes" : "No"}` }
    ],
    practicalUse: "Place the Core in a well-protected position — usually the ship's interior. Backup Cores are essential for expensive capital ships. Overlapping command auras from multiple ships stack benefits for fleet engagements.",
    commonProblems: [
      "Ship destroyed when Core killed? Install a Backup Command Core.",
      "Aura not helping? Check that friendly ships are within the aura range.",
      "Core too exposed? Surround it with armor and keep it away from the ship edges."
    ],
    related: ["blueprint-designer", "defence", "support", "economy"]
  }
];

// ---------------------------------------------------------------------------
// Manual articles (part 3: economy, multiplayer, controls)
// ---------------------------------------------------------------------------

const MANUAL_ARTICLES_PART_3 = [
  {
    id: "economy",
    category: "economy",
    title: "Economy & Objectives",
    summary: "Money, income, ship purchases, relays, and victory conditions.",
    keywords: ["economy", "money", "income", "ship cap", "relay", "capture", "bounty", "victory", "win", "objective"],
    howItWorks: "Players earn money passively through base income and relay control. Relays are capturable points on the map — controlling them provides additional income. Ships cost money to build, up to a fleet cap. Destroying enemy ships awards kill bounties (28% of the destroyed ship's cost, minimum £24). Capturing a relay awards a £70 bonus. Victory is achieved by controlling a majority of relays for a sustained period or by eliminating all enemy ships.",
    importantStats: [
      { label: "Starting Money", value: `\u00a3${ECON.startingMoney ?? 1000}` },
      { label: "Maximum Money", value: `\u00a3${ECON.maxMoney ?? 99999}` },
      { label: "Base Income", value: `+\u00a3${ECON.baseIncome ?? 20}/s` },
      { label: "Relay Income", value: `+\u00a3${ECON.relayIncome ?? 5}/s Per Relay` },
      { label: "Kill Bounty", value: `${Math.round((ECON.killBountyRatio ?? 0.28) * 100)}% Of Ship Cost (Min \u00a3${ECON.killBountyMin ?? 24})` },
      { label: "Capture Bonus", value: `\u00a3${ECON.captureBonus ?? 70}` },
      { label: "Ship Cap", value: `${ECON.shipCap ?? 30} Ships` }
    ],
    practicalUse: "Balance economy and military: capturing relays early provides income advantage. Don't float money — spend it on ships to project force. Cheap ships are cost-effective for relay capture; expensive ships win fleet engagements.",
    commonProblems: [
      "Can't buy ships? Check your money and fleet cap.",
      "Losing income? Enemy may control more relays — recapture them.",
      "Fleet cap reached? Destroyed ships free up cap space."
    ],
    related: ["movement", "combat-styles", "multiplayer", "blueprint-designer", "ship-pricing", "rewards", "capture-mechanics"]
  },
  {
    id: "ship-pricing",
    category: "economy",
    title: "Ship Pricing Formula",
    summary: "How ship costs are calculated from components, mass, and weapon premiums.",
    keywords: ["ship pricing", "cost", "formula", "weapon premium", "mass cost", "hull cost", "fleet count"],
    howItWorks: "Ship cost is calculated from a base cost plus component costs, mass, hull, shield, and repair contributions, multiplied by a part cost multiplier. Weapons add additional premiums based on family. The number of ships you can field is derived from the fleet count formula, which divides a base value by the ship's unit cost and mass.",
    importantStats: [
      { label: "Base Ship Cost", value: `\u00a3${GENERATED_BALANCE.shipPricing?.baseShipCost ?? 48}` },
      { label: "Part Cost Multiplier", value: `${GENERATED_BALANCE.shipPricing?.partCostMultiplier ?? 1.32}×` },
      { label: "Mass Cost Multiplier", value: `${GENERATED_BALANCE.shipPricing?.massCostMultiplier ?? 0.9}×` },
      { label: "Hull Cost Multiplier", value: `${GENERATED_BALANCE.shipPricing?.hullCostMultiplier ?? 0.012}×` },
      { label: "Shield Cost Multiplier", value: `${GENERATED_BALANCE.shipPricing?.shieldCostMultiplier ?? 0.05}×` },
      { label: "Repair Cost Multiplier", value: `${GENERATED_BALANCE.shipPricing?.repairCostMultiplier ?? 0.8}×` },
      { label: "Blaster Premium", value: `\u00a3${GENERATED_BALANCE.shipPricing?.weaponPremiums?.blaster ?? 18}` },
      { label: "Missile Premium", value: `\u00a3${GENERATED_BALANCE.shipPricing?.weaponPremiums?.missile ?? 32}` },
      { label: "Railgun Premium", value: `\u00a3${GENERATED_BALANCE.shipPricing?.weaponPremiums?.railgun ?? 48}` },
      { label: "Beam Premium", value: `\u00a3${GENERATED_BALANCE.shipPricing?.weaponPremiums?.beam ?? 42}` },
      { label: "Min Ship Cost", value: `\u00a3${GENERATED_BALANCE.shipPricing?.minimum ?? 300}` },
      { label: "Max Ship Cost", value: `\u00a3${GENERATED_BALANCE.shipPricing?.maximum ?? 2000}` },
      { label: "Fleet Count Base", value: `${GENERATED_BALANCE.shipPricing?.fleetCountFormulaInputs?.base ?? 260}` },
      { label: "Fleet Count Min Divisor", value: `${GENERATED_BALANCE.shipPricing?.fleetCountFormulaInputs?.minimumDivisor ?? 58}` },
      { label: "Fleet Count Unit Cost Mult", value: `${GENERATED_BALANCE.shipPricing?.fleetCountFormulaInputs?.unitCostMultiplier ?? 0.72}×` },
      { label: "Fleet Count Mass Mult", value: `${GENERATED_BALANCE.shipPricing?.fleetCountFormulaInputs?.massMultiplier ?? 0.45}×` },
      { label: "Fleet Count Min", value: `${GENERATED_BALANCE.shipPricing?.fleetCountFormulaInputs?.minimum ?? 1}` },
      { label: "Fleet Count Max", value: `${GENERATED_BALANCE.shipPricing?.fleetCountFormulaInputs?.maximum ?? 5}` }
    ],
    practicalUse: "Weapon premiums make weapon-heavy ships more expensive. Cheaper ships mean more ships in your fleet — consider mass-producing cost-effective designs.",
    commonProblems: [
      "Ship too expensive? Reduce weapon count or use cheaper weapon types.",
      "Not enough ships? Lower the ship cost to increase fleet count."
    ],
    related: ["economy", "ship-cost-formula", "rewards"]
  },
  {
    id: "rewards",
    category: "economy",
    title: "Match Rewards",
    summary: "End-of-match rewards: victory bonuses, survival bonuses, efficiency bonuses, and loss support.",
    keywords: ["rewards", "victory", "bonus", "survival", "efficiency", "loss support", "end of match", "payout"],
    howItWorks: "At the end of a match, players receive rewards based on performance. Winners get a base reward plus a victory bonus, with a minimum win reward. Losers get loss support with a minimum loss reward. Destroying enemy ships grants additional rewards proportional to the destroyed ship's cost. Surviving ships grant a per-ship survival bonus. An efficiency bonus rewards cost-effective play.",
    importantStats: [
      { label: "Base Reward", value: `\u00a3${GENERATED_BALANCE.rewards?.baseReward ?? 30}` },
      { label: "Victory Bonus", value: `\u00a3${GENERATED_BALANCE.rewards?.victoryBonus ?? 80}` },
      { label: "Loss Support", value: `\u00a3${GENERATED_BALANCE.rewards?.lossSupport ?? 35}` },
      { label: "Minimum Win Reward", value: `\u00a3${GENERATED_BALANCE.rewards?.minimumWinReward ?? 90}` },
      { label: "Minimum Loss Reward", value: `\u00a3${GENERATED_BALANCE.rewards?.minimumLossReward ?? 35}` },
      { label: "Destroyed Enemy Cost Mult", value: `${GENERATED_BALANCE.rewards?.destroyedEnemyCostMultiplier ?? 0.35}×` },
      { label: "Max Destroyed Reward", value: `\u00a3${GENERATED_BALANCE.rewards?.maxDestroyedReward ?? 250}` },
      { label: "Loss Destroyed Multiplier", value: `${GENERATED_BALANCE.rewards?.lossDestroyedMultiplier ?? 0.18}×` },
      { label: "Survival Bonus Per Ship", value: `\u00a3${GENERATED_BALANCE.rewards?.survivalBonusPerShip ?? 15}` },
      { label: "Efficiency Bonus Scale", value: `\u00a3${GENERATED_BALANCE.rewards?.efficiencyBonusScale ?? 45}` },
      { label: "Max Efficiency Bonus", value: `\u00a3${GENERATED_BALANCE.rewards?.maxEfficiencyBonus ?? 80}` },
      { label: "Min Overpower Reward Mult", value: `${GENERATED_BALANCE.rewards?.minimumOverpowerRewardMultiplier ?? 0.65}×` }
    ],
    practicalUse: "Winning is the biggest payout, but destroying enemy ships and keeping yours alive adds significantly. Efficient fleets (low cost, high performance) earn extra bonuses.",
    commonProblems: [
      "Low rewards? Focus on destroying enemy ships and keeping yours alive.",
      "Loss support too low? It's designed to keep losing players in the game — win next round."
    ],
    related: ["economy", "ship-pricing", "multiplayer"]
  },
  {
    id: "capture-mechanics",
    category: "economy",
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
    practicalUse: "Send multiple ships to a relay to capture it faster. The new-owner multiplier means freshly captured relays consolidate quickly — push hard right after capture. Hold majority control for 20 seconds to win.",
    commonProblems: [
      "Relay not capturing? Ensure your ships are close enough to the relay.",
      "Relay losing progress? Enemy ships may be contesting or no ships are present to hold it."
    ],
    related: ["economy", "movement", "combat-styles", "multiplayer"]
  },
  {
    id: "multiplayer",
    category: "multiplayer",
    title: "Multiplayer & Lobby",
    summary: "Creating rooms, joining games, teams, bots, and match flow.",
    keywords: ["multiplayer", "lobby", "room", "code", "join", "create", "team", "bot", "host", "spectator"],
    howItWorks: "Create a private room from the main menu to get a room code. Share the code with friends so they can join. The host can configure game rules (mode, starting money, max players, map size, asteroid density) and add bots. Players choose a team (Blue Wing or Red Wing). The match flows through four phases: Lobby, Design, Battle, and End. During Design, all players build their ships simultaneously. During Battle, ships fight automatically based on their combat styles and player-issued commands.",
    importantStats: [
      { label: "Max Players Per Room", value: `${GENERATED_BALANCE.fleetLimits?.shipCap ? 8 : 8}` },
      { label: "Room Code Length", value: "6 Characters" },
      { label: "Game Modes", value: "Teams Or Solo" }
    ],
    practicalUse: "For 1v1 practice, create a room with 2 max players and add a bot. For team games, coordinate with teammates on fleet composition. The host can restart the lobby for rematches without creating a new room.",
    commonProblems: [
      "Can't join? Check the room code is correct and the host is online.",
      "Disconnected? The game saves your room code for recovery — use the Resume button on the main menu.",
      "Can't start? Only the host can start the design phase."
    ],
    related: ["economy", "blueprint-designer", "controls"]
  },
  {
    id: "controls",
    category: "controls",
    title: "Controls",
    summary: "Keyboard shortcuts, mouse commands, and camera controls.",
    keywords: ["controls", "keyboard", "shortcut", "keybind", "mouse", "camera", "hotkey"],
    howItWorks: "Ships are selected with left-click or drag-box. Right-click issues move or attack commands. The camera pans with WASD or edge-scroll, zooms with the mouse wheel, and follows selected ships with F. Press Q to select all own ships, C to center on selected ships, 0 to reset zoom. Press V to toggle component damage view. In the designer, R rotates the focused part and Ctrl+Z undoes the last edit.",
    importantStats: [
      { label: "Select All", value: "Q" },
      { label: "Stop Ships", value: "B" },
      { label: "Follow Camera", value: "F" },
      { label: "Center On Selection", value: "C" },
      { label: "Reset Zoom", value: "0" },
      { label: "Damage View Toggle", value: "V" },
      { label: "Rotate Part (Designer)", value: "R" },
      { label: "Undo (Designer)", value: "Ctrl+Z" },
      { label: "Self-Destruct", value: "Del / Backspace" }
    ],
    practicalUse: "Master Q (select all) and right-click commands first. Use F to follow your fleet in battle. Press V to check damage on selected ships mid-fight.",
    commonProblems: [
      "Keys not working? Make sure no input field is focused.",
      "Can't pan camera? Use WASD or hold Space + drag.",
      "Rotate not working? R only works in the designer when a part is focused."
    ],
    related: ["movement", "combat-styles", "blueprint-designer"]
  },
  {
    id: "power-protection",
    category: "power",
    title: "Power Overload Protection",
    summary: "How overload stress, circuit breakers, and automatic recovery work.",
    keywords: ["power", "overload", "protection", "circuit breaker", "trip", "stress", "recovery", "blackout"],
    howItWorks: "When a cable network draws above its sustained capacity, overload stress accumulates. Stress builds faster at peak load. When stress reaches the critical threshold, the protection circuit trips and disconnects non-priority consumers. After tripping, the system waits for a cooldown period before attempting to reclose. Recovery begins when load drops below the recovery start ratio. The system automatically retries reclosing if the sustained load is safe.",
    importantStats: [
      { label: "Overload Start Ratio", value: `${GENERATED_BALANCE.powerProtection?.overloadStartRatio ?? 1}× Sustained` },
      { label: "Recovery Start Ratio", value: `${GENERATED_BALANCE.powerProtection?.recoveryStartRatio ?? 0.95}× Sustained` },
      { label: "Base Stress Per Second", value: `${GENERATED_BALANCE.powerProtection?.baseStressPerSecond ?? 0.12}` },
      { label: "Additional Stress At Peak", value: `${GENERATED_BALANCE.powerProtection?.additionalStressPerSecondAtPeak ?? 0.38}/s` },
      { label: "Recovery Per Second", value: `${GENERATED_BALANCE.powerProtection?.recoveryPerSecond ?? 0.25}` },
      { label: "Critical Stress Ratio", value: formatPercent(GENERATED_BALANCE.powerProtection?.criticalStressRatio ?? 0.75) },
      { label: "Trip Cooldown", value: `${GENERATED_BALANCE.powerProtection?.tripCooldownSeconds ?? 4}s` },
      { label: "Retry Interval", value: `${GENERATED_BALANCE.powerProtection?.retryIntervalSeconds ?? 2}s` },
      { label: "Safe Reclose Ratio", value: `${GENERATED_BALANCE.powerProtection?.safeRecloseSustainedRatio ?? 0.9}× Sustained` },
      { label: "Max Automatic Retry Subsets", value: `${GENERATED_BALANCE.powerProtection?.maxAutomaticRetrySubsets ?? 1024}` },
      { label: "Max Protection Delta", value: `${GENERATED_BALANCE.powerProtection?.maximumProtectionDeltaSeconds ?? 0.25}s` }
    ],
    practicalUse: "Keep sustained load below cable capacity to avoid tripping. If tripped, reduce power consumption (turn off non-essential systems) or add more generation. Heavy cable trips less often under burst loads.",
    commonProblems: [
      "Power tripping repeatedly? The load is above sustained capacity — upgrade cable or reduce consumers.",
      "Not recovering? Load must drop below 95% of sustained for recovery to begin."
    ],
    related: ["power", "wiring-infrastructure", "blueprint-designer"]
  },
  {
    id: "power-demand",
    category: "power",
    title: "Power Demand & Standby",
    summary: "How much power each system type draws in standby and active modes.",
    keywords: ["power", "demand", "standby", "consumption", "fraction", "command", "propulsion", "shields", "weapons", "repair"],
    howItWorks: "When systems are not actively engaged, they draw a fraction of their full power use as standby. Command cores always draw full power. Propulsion and shields draw 15% standby. Weapons draw 10% standby. Repair and cooling support draw 10-15% standby. This means even idle ships consume some power — ensure your reactor can cover standby loads plus active combat loads.",
    importantStats: Object.entries(GENERATED_BALANCE.powerDemand?.standbyFractions || {}).map(([key, val]) => ({
      label: `${key.charAt(0).toUpperCase() + key.slice(1)} Standby`,
      value: formatPercent(val)
    })),
    practicalUse: "A ship with many weapons but low reactor capacity may be fine at idle but blackout when all weapons fire. Size your reactor for active load, not just standby.",
    commonProblems: [
      "Ship works idle but fails in combat? Active power draw exceeds generation.",
      "Reactor not keeping up? Add aux generators or reduce power-hungry components."
    ],
    related: ["power", "wiring-infrastructure", "power-protection", "heat"]
  },
  {
    id: "projectile-mechanics",
    category: "weapons",
    title: "Projectile Mechanics",
    summary: "How projectiles travel, collide, and interact with shields and hull.",
    keywords: ["projectile", "collision", "shield", "hull", "hit radius", "intercept", "missile", "rail", "impact"],
    howItWorks: "Projectiles travel at their weapon's projectile speed toward the target. Each projectile type has a hit radius for collision detection. Missiles have a larger hit radius than rails. When a projectile hits a shield, it deals damage modified by the weapon's shield damage multiplier. Shields absorb 95% of blocked damage; 5% leaks to hull. When a projectile hits hull, it deals damage modified by the hull damage multiplier. Point defence and flak can intercept missiles within the intercept radius.",
    importantStats: [
      { label: "Shield Hit Minimum", value: `${GENERATED_BALANCE.projectiles?.shieldHitMinimum ?? 10}` },
      { label: "Shield Collision Min Radius", value: `${GENERATED_BALANCE.projectiles?.shieldCollision?.minimumRadius ?? 30} m` },
      { label: "Shield Collision Flat Padding", value: `${GENERATED_BALANCE.projectiles?.shieldCollision?.flatPadding ?? 8} m` },
      { label: "Shield Collision Radius Mult", value: `${GENERATED_BALANCE.projectiles?.shieldCollision?.radiusMultiplier ?? 0.18}×` },
      { label: "Missile Hit Radius", value: `${GENERATED_BALANCE.projectiles?.hitRadius?.missile ?? 14} m` },
      { label: "Rail Hit Radius", value: `${GENERATED_BALANCE.projectiles?.hitRadius?.rail ?? 9} m` },
      { label: "Default Hit Radius", value: `${GENERATED_BALANCE.projectiles?.hitRadius?.default ?? 6} m` },
      { label: "Intercept Radius", value: `${GENERATED_BALANCE.projectiles?.interceptRadius ?? 20} m` },
      { label: "World Padding", value: `${GENERATED_BALANCE.projectiles?.worldPadding ?? 80} m` },
      { label: "Effect Lifetime", value: `${GENERATED_BALANCE.projectiles?.effectLifetime ?? 1.2}s` },
      { label: "Missile Map Impact Margin", value: `${GENERATED_BALANCE.projectiles?.mapImpactMargins?.missile ?? 8} m` },
      { label: "Rail Map Impact Margin", value: `${GENERATED_BALANCE.projectiles?.mapImpactMargins?.rail ?? 3} m` },
      { label: "Default Map Impact Margin", value: `${GENERATED_BALANCE.projectiles?.mapImpactMargins?.default ?? 5} m` }
    ],
    practicalUse: "Missiles are easier to intercept due to larger hit radius and slower speed. Rails are harder to intercept — small hit radius and very high speed. Shields provide a collision radius that can catch near-misses.",
    commonProblems: [
      "Shots passing through shields? The shield collision radius may not be large enough for the projectile.",
      "Missiles shot down? Enemy point defence intercepts within 20 m."
    ],
    related: ["weapons", "defence", "missile-guidance"]
  },
  {
    id: "missile-guidance",
    category: "weapons",
    title: "Missile Guidance",
    summary: "How missiles track targets, turn, and get countered by ECM.",
    keywords: ["missile", "guidance", "tracking", "turn rate", "ecm", "lead", "acceleration", "arming"],
    howItWorks: "Missiles arm with a reduced turn rate, then switch to full tracking after the arming phase. Turn rate scales with the weapon's tracking stat squared. Missiles lead their targets based on lead strength. ECM from electronic warfare command centres can reduce missile tracking effectiveness, capped at a maximum reduction. Missiles accelerate from launch speed toward their maximum speed.",
    importantStats: [
      { label: "Arming Turn Rate", value: `${GENERATED_BALANCE.missileGuidance?.armingTurnRate ?? 0.1}` },
      { label: "Default Tracking", value: `${GENERATED_BALANCE.missileGuidance?.defaultTracking ?? 0.5}` },
      { label: "Base Turn Rate", value: `${GENERATED_BALANCE.missileGuidance?.baseTurnRate ?? 0.7}` },
      { label: "Turn Rate Base", value: `${GENERATED_BALANCE.missileGuidance?.turnRateBase ?? 0.45}` },
      { label: "Tracking² Multiplier", value: `${GENERATED_BALANCE.missileGuidance?.turnRateTrackingSquaredMultiplier ?? 4.2}×` },
      { label: "Lead Strength Multiplier", value: `${GENERATED_BALANCE.missileGuidance?.leadStrengthMultiplier ?? 0.35}×` },
      { label: "ECM Cap", value: formatPercent(GENERATED_BALANCE.missileGuidance?.ecmCap ?? 0.55) },
      { label: "Default Max Speed", value: formatSpeed(GENERATED_BALANCE.missileGuidance?.defaultMaxSpeed ?? 460) },
      { label: "Acceleration", value: `${GENERATED_BALANCE.missileGuidance?.acceleration ?? 95} m/s²` }
    ],
    practicalUse: "Higher tracking weapons turn harder — swarm missiles track better than torpedoes. ECM from Electronic Warfare Command Centres can reduce tracking by up to 55%, making missiles miss agile targets.",
    commonProblems: [
      "Missiles missing? Target may be too agile or ECM is reducing tracking.",
      "Torpedoes not hitting? They have low tracking (0.2) — use against slow or stationary targets."
    ],
    related: ["weapons", "projectile-mechanics", "defence", "command"]
  },
  {
    id: "repair-mechanics",
    category: "support",
    title: "Repair Mechanics",
    summary: "How hull repair works, stacking, range, and repair beams.",
    keywords: ["repair", "hull", "heal", "stacking", "repair beam", "repair range", "multiplier"],
    howItWorks: "Repair modules restore hull HP over time. Multiple repair sources on the same ship stack with diminishing returns — each additional source contributes less. Repair beams project repair at range toward friendly ships. The repair range determines how far the beam can reach. Drones can also repair their parent ship and nearby allies.",
    importantStats: [
      { label: "Repair Range", value: formatDistance(GENERATED_BALANCE.repair?.repairRange ?? 410) },
      { label: "Stacking Multiplier", value: `${GENERATED_BALANCE.repair?.stackingMultiplier ?? 0.62}×` }
    ],
    practicalUse: "Multiple repair modules stack but with 62% efficiency per additional source. Repair beams are directional — aim them at the ship you want to heal. Repair drones automatically target the parent ship first, then nearby allies.",
    commonProblems: [
      "Repair not stacking well? Each additional source contributes 62% of the previous.",
      "Repair beam not hitting? It's directional — ensure the emitter faces the target."
    ],
    related: ["support", "defence", "drones", "blueprint-designer"]
  }
];

// ---------------------------------------------------------------------------
// Data-driven component article generation
// ---------------------------------------------------------------------------

const CATEGORY_MAP = {
  "Structure": "ship-construction",
  "Power": "power",
  "Engines": "movement",
  "Weapons": "weapons",
  "Defence": "defence",
  "Support": "support",
  "Command": "command",
  "Heat Components": "heat"
};

function categoryForPart(partId) {
  if (partId === "droneBay") return "drones";
  const raw = partCategory(partId);
  return CATEGORY_MAP[raw] || "ship-construction";
}

function titleCase(str) {
  return str.replace(/([A-Z])/g, ' $1').replace(/^./, (s) => s.toUpperCase()).trim();
}

function statLabel(key) {
  const labels = {
    cost: "Cost",
    mass: "Mass",
    hull: "Hull HP",
    shield: "Shield HP",
    shieldRegen: "Shield Regen",
    thrust: "Thrust",
    turn: "Turn Rate",
    powerGeneration: "Power Generation",
    powerUse: "Power Use",
    energy: "Energy",
    repair: "Repair",
    damage: "Damage",
    fireRate: "Fire Rate",
    range: "Range",
    projectileSpeed: "Projectile Speed",
    tracking: "Tracking",
    splashRadius: "Splash Radius",
    maxPerShip: "Max Per Ship"
  };
  return labels[key] || titleCase(key);
}

function formatStat(key, value) {
  if (value == null || value === 0) return null;
  switch (key) {
    case "mass": return formatMass(value);
    case "hull": return formatHull(value);
    case "shield": return formatShield(value);
    case "thrust": return formatThrust(value);
    case "energy": return formatEnergy(value);
    case "repair": return formatRepair(value);
    case "range": return formatDistance(value);
    case "projectileSpeed": return formatSpeed(value);
    case "damage": return formatDamage(value);
    case "powerGeneration": return `+${value} MW`;
    case "powerUse": return `${value} MW`;
    case "cost": return `\u00a3${value}`;
    case "fireRate": return `${value}/s`;
    case "tracking": return formatPercent(value);
    default: return String(value);
  }
}

function relatedForPart(partId) {
  const cat = categoryForPart(partId);
  const catArticleMap = { "ship-construction": "blueprint-designer" };
  const related = [catArticleMap[cat] || cat];
  if (cat === "weapons") related.push("defence", "power", "heat", "projectile-mechanics", "missile-guidance");
  else if (cat === "defence") related.push("weapons", "power", "projectile-mechanics");
  else if (cat === "support") related.push("defence", "command", "repair-mechanics");
  else if (cat === "command") related.push("blueprint-designer", "defence", "support");
  else if (cat === "drones") related.push("weapons", "defence", "repair-mechanics");
  else if (cat === "movement") related.push("combat-styles", "power");
  else if (cat === "power") related.push("heat", "wiring-infrastructure", "power-protection", "power-demand");
  else if (cat === "heat") related.push("power", "wiring-infrastructure");
  else related.push("blueprint-designer", "power", "heat");
  return [...new Set(related.filter((r) => r !== partId))];
}

function generateComponentArticle(partId) {
  const stats = PART_STATS[partId];
  const def = PART_DEFS[partId];
  if (!stats || !def) return null;

  const cat = categoryForPart(partId);
  const name = def.name || partId;
  const desc = partDescription(partId, stats) || stats.description || "";

  const importantStats = [];
  for (const key of ["cost", "mass", "hull", "shield", "shieldRegen", "thrust", "turn", "powerGeneration", "powerUse", "energy", "repair", "damage", "fireRate", "range", "projectileSpeed", "tracking", "splashRadius", "maxPerShip"]) {
    const formatted = formatStat(key, stats[key]);
    if (formatted) importantStats.push({ label: statLabel(key), value: formatted });
  }

  // Footprint
  if (stats.footprint) {
    importantStats.push({ label: "Footprint", value: `${stats.footprint.width}×${stats.footprint.height}` });
  }

  // Armor reduction
  if (stats.armorFlatReduction) {
    importantStats.push({ label: "Armor Reduction", value: `${stats.armorFlatReduction} Flat` });
  }

  // Rotatable
  if (stats.rotatable) {
    importantStats.push({ label: "Rotatable", value: "Yes" });
  }

  // Shape type
  if (stats.shapeType) {
    importantStats.push({ label: "Shape", value: titleCase(stats.shapeType) });
  }

  // Stat scale
  if (stats.statScale) {
    importantStats.push({ label: "Stat Scale", value: formatPercent(stats.statScale) });
  }

  // Weapon details
  const w = stats.weapon;
  if (w) {
    if (w.family) importantStats.push({ label: "Weapon Family", value: titleCase(w.family) });
    if (w.damage) importantStats.push({ label: "Damage", value: formatDamage(w.damage) });
    if (w.fireRate) importantStats.push({ label: "Fire Rate", value: `${w.fireRate}/s` });
    if (w.range) importantStats.push({ label: "Range", value: formatDistance(w.range) });
    if (w.projectileSpeed != null) importantStats.push({ label: "Projectile Speed", value: w.projectileSpeed === 0 ? "Hitscan / Beam" : formatSpeed(w.projectileSpeed) });
    if (w.accuracy != null) importantStats.push({ label: "Accuracy", value: formatPercent(w.accuracy) });
    if (w.tracking != null && w.tracking !== 0) importantStats.push({ label: "Tracking", value: formatPercent(w.tracking) });
    if (w.arc) importantStats.push({ label: "Firing Arc", value: `${w.arc}°` });
    if (w.shieldDamageMultiplier != null) importantStats.push({ label: "Shield Damage Multiplier", value: `${w.shieldDamageMultiplier}×` });
    if (w.hullDamageMultiplier != null) importantStats.push({ label: "Hull Damage Multiplier", value: `${w.hullDamageMultiplier}×` });
    if (w.aimSpeed) importantStats.push({ label: "Aim Speed", value: `${w.aimSpeed} rad/s` });
    if (w.radius) importantStats.push({ label: "Beam Radius", value: formatDistance(w.radius) });
    if (w.chargeRampSeconds) importantStats.push({ label: "Charge Ramp", value: `${w.chargeRampSeconds}s` });
    if (w.maxChargeDamageBonus) importantStats.push({ label: "Max Charge Bonus", value: formatPercent(w.maxChargeDamageBonus) });
    if (w.burnThroughCarryMultiplier) importantStats.push({ label: "Burn-Through Carry", value: `${w.burnThroughCarryMultiplier}×` });
    if (w.impactHeatPerDamage) importantStats.push({ label: "Impact Heat Per Damage", value: `${w.impactHeatPerDamage}` });
    if (w.missileHp) importantStats.push({ label: "Missile HP", value: `${w.missileHp}` });
    if (w.trackTime) importantStats.push({ label: "Track Duration", value: `${w.trackTime}s` });
    if (w.trackingDelay) importantStats.push({ label: "Tracking Delay", value: `${w.trackingDelay}s` });
    if (w.antiMissile) importantStats.push({ label: "Anti-Missile", value: "Yes" });
    if (w.shipDamageMultiplier != null) importantStats.push({ label: "Ship Damage Multiplier", value: `${w.shipDamageMultiplier}×` });
    if (w.blastDamage) importantStats.push({ label: "Blast Damage", value: formatDamage(w.blastDamage) });
    if (w.blastRadius) importantStats.push({ label: "Blast Radius", value: formatDistance(w.blastRadius) });
    if (w.proximityFuseRadius) importantStats.push({ label: "Proximity Fuse Radius", value: formatDistance(w.proximityFuseRadius) });
    if (w.innerFullDamageRadius) importantStats.push({ label: "Full Damage Radius", value: formatDistance(w.innerFullDamageRadius) });
    if (w.falloffExponent) importantStats.push({ label: "Blast Falloff Exponent", value: `${w.falloffExponent}` });
    if (w.armourPenetration != null) importantStats.push({ label: "Armour Piercing", value: `${w.armourPenetration}` });
    if (w.directImpactBonus != null) importantStats.push({ label: "Direct Impact Bonus", value: `${w.directImpactBonus}` });
    if (w.targetPriority && w.targetPriority.length) {
      importantStats.push({ label: "Target Priority", value: w.targetPriority.map((t) => titleCase(t)).join(" → ") });
    }
  }

  // Aura details
  const aura = stats.aura;
  if (aura) {
    if (aura.type) importantStats.push({ label: "Aura Type", value: titleCase(aura.type) });
    if (aura.weaponAccuracyMultiplier) importantStats.push({ label: "Accuracy Aura", value: `${aura.weaponAccuracyMultiplier}×` });
    if (aura.weaponTrackingMultiplier) importantStats.push({ label: "Tracking Aura", value: `${aura.weaponTrackingMultiplier}×` });
    if (aura.targetAcquisitionMultiplier) importantStats.push({ label: "Target Acquisition Aura", value: `${aura.targetAcquisitionMultiplier}×` });
    if (aura.turretAimSpeedMultiplier) importantStats.push({ label: "Aim Speed Aura", value: `${aura.turretAimSpeedMultiplier}×` });
    if (aura.pointDefenceTrackingMultiplier) importantStats.push({ label: "Point Defence Tracking Aura", value: `${aura.pointDefenceTrackingMultiplier}×` });
    if (aura.flakTrackingMultiplier) importantStats.push({ label: "Flak Tracking Aura", value: `${aura.flakTrackingMultiplier}×` });
    if (aura.interceptionReactionMultiplier) importantStats.push({ label: "Interception Reaction Aura", value: `${aura.interceptionReactionMultiplier}×` });
    if (aura.shieldRegenMultiplier) importantStats.push({ label: "Shield Regen Aura", value: `${aura.shieldRegenMultiplier}×` });
    if (aura.shieldRestartDelayMultiplier) importantStats.push({ label: "Shield Restart Aura", value: `${aura.shieldRestartDelayMultiplier}×` });
    if (aura.repairRateMultiplier) importantStats.push({ label: "Repair Aura", value: `${aura.repairRateMultiplier}×` });
    if (aura.heatDissipationMultiplier) importantStats.push({ label: "Heat Dissipation Aura", value: `${aura.heatDissipationMultiplier}×` });
    if (aura.overheatRecoveryMultiplier) importantStats.push({ label: "Overheat Recovery Aura", value: `${aura.overheatRecoveryMultiplier}×` });
    if (aura.accelerationMultiplier) importantStats.push({ label: "Acceleration Aura", value: `${aura.accelerationMultiplier}×` });
    if (aura.turnRateMultiplier) importantStats.push({ label: "Turn Rate Aura", value: `${aura.turnRateMultiplier}×` });
    if (aura.sensorRangeMultiplier) importantStats.push({ label: "Sensor Range Aura", value: `${aura.sensorRangeMultiplier}×` });
    if (aura.missileTrackingResistanceMultiplier) importantStats.push({ label: "Missile Tracking Resistance Aura", value: `${aura.missileTrackingResistanceMultiplier}×` });
    if (aura.componentAimRetentionMultiplier) importantStats.push({ label: "Aim Retention Aura", value: `${aura.componentAimRetentionMultiplier}×` });
  }

  // Battery / Capacitor details
  if (stats.energyCapacity) importantStats.push({ label: "Energy Capacity", value: formatEnergy(stats.energyCapacity) });
  if (stats.maxChargeRate) importantStats.push({ label: "Max Charge Rate", value: `${stats.maxChargeRate} MW` });
  if (stats.maxDischargeRate) importantStats.push({ label: "Max Discharge Rate", value: `${stats.maxDischargeRate} MW` });
  if (stats.chargeEfficiency) importantStats.push({ label: "Charge Efficiency", value: formatPercent(stats.chargeEfficiency) });
  if (stats.dischargeEfficiency) importantStats.push({ label: "Discharge Efficiency", value: formatPercent(stats.dischargeEfficiency) });
  if (stats.dischargeHeatAtMax) importantStats.push({ label: "Discharge Heat At Max", value: `${stats.dischargeHeatAtMax}` });

  // Reactor meltdown
  if (stats.meltdownDamage) importantStats.push({ label: "Meltdown Damage", value: formatDamage(stats.meltdownDamage) });
  if (stats.meltdownRadius) importantStats.push({ label: "Meltdown Radius", value: formatDistance(stats.meltdownRadius) });

  // Decoy details
  const decoy = stats.decoy;
  if (decoy) {
    if (decoy.capacity) importantStats.push({ label: "Decoy Capacity", value: `${decoy.capacity}` });
    if (decoy.initialStock != null) importantStats.push({ label: "Initial Stock", value: `${decoy.initialStock}` });
    if (decoy.productionSeconds) importantStats.push({ label: "Production Time", value: `${decoy.productionSeconds}s` });
    if (decoy.launchCooldownSeconds) importantStats.push({ label: "Launch Cooldown", value: `${decoy.launchCooldownSeconds}s` });
    if (decoy.lifetimeSeconds) importantStats.push({ label: "Decoy Lifetime", value: `${decoy.lifetimeSeconds}s` });
    if (decoy.triggerRange) importantStats.push({ label: "Trigger Range", value: formatDistance(decoy.triggerRange) });
    if (decoy.attractionRange) importantStats.push({ label: "Attraction Range", value: formatDistance(decoy.attractionRange) });
    if (decoy.attractionChance) importantStats.push({ label: "Attraction Chance", value: formatPercent(decoy.attractionChance) });
    if (decoy.driftSpeed) importantStats.push({ label: "Drift Speed", value: formatSpeed(decoy.driftSpeed) });
    if (decoy.collisionRadius) importantStats.push({ label: "Collision Radius", value: formatDistance(decoy.collisionRadius) });
  }

  // Proximity charge details
  const prox = stats.proximityCharge;
  if (prox) {
    if (prox.triggerRadius) importantStats.push({ label: "Trigger Radius", value: formatDistance(prox.triggerRadius) });
    if (prox.triggerConfirmationSeconds) importantStats.push({ label: "Trigger Confirmation", value: `${prox.triggerConfirmationSeconds}s` });
    if (prox.blastRadius) importantStats.push({ label: "Blast Radius", value: formatDistance(prox.blastRadius) });
    if (prox.centreDamage) importantStats.push({ label: "Centre Damage", value: formatDamage(prox.centreDamage) });
    if (prox.falloffExponent) importantStats.push({ label: "Blast Falloff", value: `${prox.falloffExponent}` });
    if (prox.maxAffectedComponents === null) importantStats.push({ label: "Max Affected Components", value: "Unlimited" });
    else if (prox.maxAffectedComponents) importantStats.push({ label: "Max Affected Components", value: `${prox.maxAffectedComponents}` });
    importantStats.push({ label: "Damages Friendly Ships", value: prox.damagesFriendlyShips === false ? "No" : "Yes" });
    if (prox.internalDamageReduction) importantStats.push({ label: "Internal Damage Reduction", value: formatPercent(prox.internalDamageReduction) });
  }

  // Maneuver thruster
  if (stats.lateralThrust) importantStats.push({ label: "Lateral Thrust", value: formatThrust(stats.lateralThrust) });
  if (stats.allowedRotations) importantStats.push({ label: "Allowed Rotations", value: `${stats.allowedRotations.join("°, ")}°` });

  // Utility type
  if (stats.utility) importantStats.push({ label: "Utility Type", value: titleCase(stats.utility) });
  if (stats.fireRateBonus) importantStats.push({ label: "Fire Rate Bonus", value: formatPercent(stats.fireRateBonus) });
  if (stats.accuracyBonus) importantStats.push({ label: "Accuracy Bonus", value: formatPercent(stats.accuracyBonus) });
  if (stats.rangeBonus) importantStats.push({ label: "Range Bonus", value: formatDistance(stats.rangeBonus) });

  // Drone bay drone config reference
  if (partId === "droneBay") {
    const droneConfig = stats.droneConfig || DRONES;
    if (droneConfig.squadSize) importantStats.push({ label: "Squad Size", value: `${droneConfig.squadSize}` });
    if (droneConfig.maxBaysPerShip) importantStats.push({ label: "Max Bays Per Ship", value: `${droneConfig.maxBaysPerShip}` });
    if (droneConfig.maxActivePerShip) importantStats.push({ label: "Max Active Per Ship", value: `${droneConfig.maxActivePerShip}` });
    if (droneConfig.fuelSeconds) importantStats.push({ label: "Fuel Duration", value: `${droneConfig.fuelSeconds}s` });
    if (droneConfig.refuelSeconds) importantStats.push({ label: "Refuel Time", value: `${droneConfig.refuelSeconds}s` });
    if (droneConfig.launchIntervalSeconds) importantStats.push({ label: "Launch Interval", value: `${droneConfig.launchIntervalSeconds}s` });
    if (droneConfig.launchDurationSeconds) importantStats.push({ label: "Launch Duration", value: `${droneConfig.launchDurationSeconds}s` });
    if (droneConfig.standbyPowerMw) importantStats.push({ label: "Standby Power", value: `${droneConfig.standbyPowerMw} MW` });
    if (droneConfig.activePowerMw) importantStats.push({ label: "Active Power", value: `${droneConfig.activePowerMw} MW` });
    if (droneConfig.productionPowerMw) importantStats.push({ label: "Production Power", value: `${droneConfig.productionPowerMw} MW` });

    // Drone type details
    const types = droneConfig.types || {};
    for (const [typeId, typeData] of Object.entries(types)) {
      importantStats.push({ label: `${typeData.label || typeId} — Hull`, value: `${typeData.hull} HP` });
      importantStats.push({ label: `${typeData.label || typeId} — Speed`, value: formatSpeed(typeData.speed) });
      if (typeData.damage) importantStats.push({ label: `${typeData.label || typeId} — Damage`, value: formatDamage(typeData.damage) });
      if (typeData.fireRate) importantStats.push({ label: `${typeData.label || typeId} — Fire Rate`, value: `${typeData.fireRate}/s` });
      if (typeData.repairPerSecond) importantStats.push({ label: `${typeData.label || typeId} — Repair`, value: `${typeData.repairPerSecond} HP/s` });
      if (typeData.commandRange) importantStats.push({ label: `${typeData.label || typeId} — Command Range`, value: formatDistance(typeData.commandRange) });
      if (typeData.squadSize) importantStats.push({ label: `${typeData.label || typeId} — Squad Size`, value: `${typeData.squadSize}` });
      if (typeData.fuelSeconds) importantStats.push({ label: `${typeData.label || typeId} — Fuel`, value: `${typeData.fuelSeconds}s` });
      if (typeData.productionSeconds) importantStats.push({ label: `${typeData.label || typeId} — Rebuild Time`, value: `${typeData.productionSeconds}s` });
    }
  }

  // Power category
  if (stats.powerCategory) importantStats.push({ label: "Power Category", value: titleCase(stats.powerCategory) });

  const keywords = [name.toLowerCase(), partId.toLowerCase(), cat];
  if (def.category) keywords.push(def.category.toLowerCase());
  if (w) keywords.push(w.family, "weapon");
  if (aura) keywords.push("aura", aura.type);
  if (stats.utility) keywords.push(stats.utility);

  // Build practical use and common problems based on category
  let practicalUse = "";
  let commonProblems = [];

  if (w) {
    const dps = (w.damage * w.fireRate).toFixed(1);
    practicalUse = `Theoretical DPS: ${dps}. `;
    if (w.family === "missile") practicalUse += "Vulnerable to point defence — overwhelm with numbers or mix with other weapons. ";
    if (w.family === "railgun") practicalUse += "Best at long range against slow or stationary targets. Narrow arc requires careful positioning. ";
    if (w.family === "beam") practicalUse += "Sustained shield-breaking — ramps up damage over 15s. Keep the beam on target. ";
    if (w.family === "blaster") practicalUse += "General-purpose weapon with good accuracy and moderate range. ";
    if (w.family === "pointDefense" || w.family === "flak") practicalUse += "Anti-missile and anti-drone defence — negligible damage to ships. ";
    commonProblems.push("Not firing? Check power supply and cable connections.");
    if (w.arc < 90) commonProblems.push("Narrow firing arc — position the ship to face the target.");
    if (w.tracking > 0) commonProblems.push("Missiles can be intercepted by enemy point defence.");
  }

  if (aura) {
    practicalUse += `Projects a ${aura.type} command aura affecting friendly ships within ${GENERATED_BALANCE.commandAura?.range ?? 800} m. `;
    commonProblems.push("Aura does not affect the ship itself — coordinate with fleet members.");
  }

  if (stats.armorFlatReduction) {
    practicalUse += `Reduces incoming damage by ${stats.armorFlatReduction} flat per hit. `;
  }

  if (stats.meltdownDamage) {
    commonProblems.push("Reactor will melt down if overheated — ensure adequate cooling.");
  }

  // Merge structured mechanics from the registry
  const mechanics = getMechanics(partId);
  const conditionalPerformance = mechanics?.conditionalPerformance || null;
  const requirementsLimitations = mechanics?.requirements || null;
  const specialMechanics = mechanics?.specialMechanics || null;
  const interactions = mechanics?.interactions || null;

  // Add mechanics text to keywords for search
  if (mechanics) {
    const mechText = getMechanicsSearchText(partId);
    if (mechText) keywords.push(mechText);
  }

  return {
    id: `component:${partId}`,
    category: cat,
    title: name,
    summary: desc,
    keywords,
    howItWorks: desc,
    importantStats,
    conditionalPerformance,
    requirementsLimitations,
    specialMechanics,
    interactions,
    practicalUse: practicalUse || "See the category overview article for general guidance.",
    commonProblems: commonProblems.length ? commonProblems : ["See the category overview article for common issues."],
    related: relatedForPart(partId),
    isComponent: true,
    partId
  };
}

function generateAllComponentArticles() {
  const articles = [];
  for (const partId of Object.keys(PART_STATS)) {
    const article = generateComponentArticle(partId);
    if (article) articles.push(article);
  }
  return articles;
}

// ---------------------------------------------------------------------------
// Combined article catalogue
// ---------------------------------------------------------------------------

export function getAllArticles() {
  return [
    ...MANUAL_ARTICLES_PART_1,
    ...MANUAL_ARTICLES_PART_2,
    ...MANUAL_ARTICLES_PART_3,
    ...generateAllComponentArticles()
  ];
}

export function getArticleById(id) {
  return getAllArticles().find((a) => a.id === id) || null;
}

export function getArticlesByCategory(categoryId) {
  return getAllArticles().filter((a) => a.category === categoryId);
}

export function getRelatedArticles(article) {
  if (!article || !article.related) return [];
  return article.related
    .map((id) => getArticleById(id))
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Search index
// ---------------------------------------------------------------------------

export function searchArticles(query) {
  if (!query || !query.trim()) return [];
  const q = query.toLowerCase().trim();
  const terms = q.split(/\s+/);
  const articles = getAllArticles();
  const scored = [];

  for (const article of articles) {
    const haystack = [
      article.title,
      article.summary,
      article.category,
      ...(article.keywords || []),
      // Index mechanics sections for search
      ...((article.specialMechanics || []).flatMap((m) => [m.label, m.value, m.detail, m.condition].filter(Boolean))),
      ...((article.requirementsLimitations || []).flatMap((m) => [m.label, m.value, m.detail].filter(Boolean))),
      ...((article.interactions || []).flatMap((m) => [m.label, m.value, m.detail].filter(Boolean))),
      ...((article.conditionalPerformance || []).flatMap((m) => [m.label, m.value, m.detail].filter(Boolean)))
    ].join(" ").toLowerCase();

    let score = 0;
    for (const term of terms) {
      if (article.title.toLowerCase().includes(term)) score += 10;
      if (haystack.includes(term)) score += 1;
    }
    if (score > 0) scored.push({ article, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.article);
}

// ---------------------------------------------------------------------------
// Validation helpers (used by tests)
// ---------------------------------------------------------------------------

export function validateArticles() {
  const errors = [];
  const articles = getAllArticles();
  const ids = new Set();
  const categoryIds = new Set(CATEGORIES.map((c) => c.id));

  for (const article of articles) {
    if (!article.id) errors.push(`Article missing id: ${article.title}`);
    if (ids.has(article.id)) errors.push(`Duplicate article id: ${article.id}`);
    ids.add(article.id);
    if (!article.title) errors.push(`Article missing title: ${article.id}`);
    if (!article.category) errors.push(`Article missing category: ${article.id}`);
    if (!categoryIds.has(article.category)) errors.push(`Article ${article.id} has unknown category: ${article.category}`);
    if (article.related) {
      for (const ref of article.related) {
        if (!ids.has(ref) && !getAllArticles().some((a) => a.id === ref)) {
          errors.push(`Article ${article.id} references unknown article: ${ref}`);
        }
      }
    }
  }

  return errors;
}
