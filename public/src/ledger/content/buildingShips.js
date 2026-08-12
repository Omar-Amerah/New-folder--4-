// Fleet Ledger authored content: Blueprint construction, validation, pricing, summary, and component-reference guidance.

import { GENERATED_BALANCE } from "./resolvedContentValues.js";

export const BUILDING_SHIPS_CONTENT = Object.freeze({
  articles: Object.freeze([
  {
      id: "blueprint-designer",
      category: "building-ships",
      title: "Blueprint Designer Interface",
      summary: "The Designer Interface, Component Palette, Build Grid, Placement, Removal, Undo, And Reset.",
      keywords: ["blueprint", "designer", "interface", "palette", "grid", "place", "remove", "undo", "reset", "clear"],
      howItWorks: "Open the Blueprint Designer from the side panel or main menu. Select components from the palette, place them on the build grid, right-click to remove them, and press R to rotate when supported. Undo reverses the last physical edit; Reset Design restores the starter ship; Clear All removes everything except the core. The Ship Summary updates live as you build. Use explicit Data Links to associate support components with weapons.",
      importantStats: [
        { label: "Grid Size", value: "15×15" },
        { label: "Grid Coordinate Range", value: "0–14" },
        { label: "Undo Support", value: "Full Edit History" },
        { label: "Core Removal", value: "Not Allowed" },
        { label: "Reset Design", value: "Restores Starter Ship" },
        { label: "Clear All", value: "Removes All Except Core" }
      ],
      practicalUse: "Start with the default design and modify it. Use Clear All for a blank slate, keep the Ship Summary visible to catch issues early, and add explicit Data Links after placing support components and weapons.",
      commonProblems: [
        "Can't Place A Part? Check For Overlap Or Out-Of-Bounds Footprint Cells.",
        "Can't Remove The Core? The Core Is Permanent : Use Clear All To Reset To A Bare Core.",
        "Changes Not Saving? Use The Save Button To Persist The Blueprint."
      ],
      related: ["placement-rules", "structural-connectivity", "ship-validation", "ship-cost-formula", "ship-summary", "power", "heat"]
    },
  {
      id: "placement-rules",
      category: "building-ships",
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
      practicalUse: "Weapons On The Ship's Edges Can Be Rotated To Face Forward, Sideways, Or Backward. Maneuver Thrusters Auto-Face Outward : Place Them On The Correct Side. Drone Bays Cannot Be Rotated : Their Launch Edge Depends On Placement.",
      commonProblems: [
        "Part Facing The Wrong Way? Press R To Cycle Rotations.",
        "Maneuver Thruster Won't Rotate? It Auto-Rotates Based On Position.",
        "Footprint Hanging Off The Grid? Move The Anchor Cell So All Footprint Cells Fit Within 0–14."
      ],
      related: ["blueprint-designer", "structural-connectivity", "engine-exhaust", "ship-validation"]
    },
  {
      id: "structural-connectivity",
      category: "building-ships",
      title: "Structural Connectivity",
      summary: "All Parts Must Connect To The Core Through Side-Adjacent Cells.",
      keywords: ["connectivity", "connected", "disconnected", "adjacent", "core", "heat pipe", "structure", "BFS"],
      howItWorks: "A Blueprint Is Valid Only If Every Part Is Structurally Connected To The Core. Connectivity Is Checked Via Breadth-First Search From The Core Through Side-Adjacent (4-Neighbour) Cells. Two Passes Are Performed: Physical Connectivity (All Parts Reachable) And Structural Connectivity (Non-Heat-Pipe Parts Must Not Rely On Heat Pipe Chains As Their Only Path). Heat Pipes Can Be Reached Through Other Heat Pipes, But A Non-Heat-Pipe Part Cannot Use A Heat-Pipe Chain As Its Only Path Back To The Core. Diagonal Adjacency Does NOT Count : Only Up, Down, Left, And Right. Overlapping Parts Are Filtered Before The Connectivity Check.",
      importantStats: [
        { label: "Adjacency Type", value: "4-Neighbour (Orthogonal)" },
        { label: "Heat Pipe Rule", value: "Non-Heat-Pipe Parts Cannot Depend On Heat Pipe Chains" },
        { label: "Core Required", value: "Exactly 1" },
        { label: "Diagonal Counts", value: "No" }
      ],
      practicalUse: "Build Outward From The Core In A Connected Shape. Avoid Diagonal Gaps : Parts Touching Only At Corners Are Disconnected. Heat Pipes Can Bridge To Radiators But Cannot Be The Structural Spine Of The Ship.",
      commonProblems: [
        "Disconnected Parts Error? Check For Diagonal-Only Connections Or Gaps.",
        "Heat Pipe Causing Issues? A Non-Heat-Pipe Part Behind A Heat Pipe Chain Is Structurally Invalid : Add A Frame Or Armor Path."
      ],
      related: ["blueprint-designer", "placement-rules", "ship-validation", "heat"]
    },
  {
      id: "engine-exhaust",
      category: "building-ships",
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
        "Ship Slow Despite Many Engines? Some Engines May Be Blocked : Check The Ship Summary For Blocked Engine Count.",
        "Maneuver Thruster Blocked? Ensure The Outward-Facing Channel Is Clear."
      ],
      related: ["placement-rules", "movement", "ship-validation", "ship-summary"]
    },
  {
      id: "ship-validation",
      category: "building-ships",
      title: "Ship Validation Rules",
      summary: "All Rules A Blueprint Must Pass Before It Can Be Deployed.",
      keywords: ["validation", "rules", "core", "backup core", "overlap", "bounds", "drone bay", "max per ship", "engine requirement"],
      howItWorks: "Exactly One Core Is Required (Zero = Invalid, Two = Invalid). Maximum One Backup Command Core Is Allowed. All Parts Must Be Within The 15×15 Grid (Coordinates 0–14). No Overlapping Parts. All Parts Must Be Structurally Connected To The Core. Each Component Type Has A Max-Per-Ship Limit. Drone Bays Require A Configured Drone Type (Fighter, Defence, Or Repair) And An Exposed Two-Cell Launch Edge. Maximum Drone Bays Per Ship Is 4. At Least One Engine With Effective Thrust Is Required To Build (Validated At Build Time, Not Design Time). Ship Cost Is The Sum Of Direct Component Costs. The Player Must Have Enough Money To Build The Ship.",
      importantStats: [
        { label: "Core Count Required", value: "Exactly 1" },
        { label: "Backup Core Max", value: "1" },
        { label: "Grid Bounds", value: "0–14" },
        { label: "Max Drone Bays", value: `${GENERATED_BALANCE.drones?.maxBaysPerShip ?? 4}` },
        { label: "Engine Requirement", value: "At Least 1 With Effective Thrust (Build Time)" }
      ],
      practicalUse: "The Designer Warns About Most Issues Live. Drone Bay Configuration (Drone Type) Must Be Set Before Deployment. The Thrust Requirement Is Only Enforced When Building : You Can Save A Design Without Engines But Cannot Deploy It.",
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
      category: "building-ships",
      title: "Ship Cost Formula",
      summary: "Ship Cost Is The Sum Of The Direct Costs On Its Components.",
      keywords: ["cost", "price", "formula", "component cost"],
      howItWorks: "Ship Cost = Sum Of Each Component's Direct Cost. Component costs are defined on the component itself; no base cost, multiplier, weapon premium, or infrastructure surcharge is added.",
      importantStats: [
        { label: "Component Cost", value: "Direct value on each component" }
      ],
      practicalUse: "Balance a ship by changing the direct cost on the components it uses. A Missile that should cost $75 should have cost 75 in the component balance.",
      commonProblems: [
        "Ship Too Expensive? Inspect the direct costs of its components.",
        "Need More Ships? Check available money and the fleet cap."
      ],
      related: ["ship-pricing", "economy", "blueprint-designer", "ship-validation"]
    },
  {
      id: "ship-summary",
      category: "building-ships",
      title: "Ship Summary Panel",
      summary: "The Live Overview Of Build Cost, Mass, Acceleration, Hull, Shield, Weapons, Speed, Turn, Power, And Status Warnings.",
      keywords: ["ship summary", "overview", "stats", "status", "warnings", "mobility", "power details", "combat details", "support details"],
      howItWorks: "The Ship Summary Shows 9 Headline Values: Build Cost, Mass, Acceleration, Hull, Shield, Weapon DPS, Max Speed, Turn Rate, And Power. Below The Overview, Status Messages Appear In A Consistent Healthy, Caution, Then Critical Order Based On Real Conditions: Power Shortfall, Disconnected Components, No Effective Thrust, Mass Drag Limiting Speed, Asymmetric Turning, No Shield Coverage, No Weapons, Backup Command Available, Insufficient Cooling, And Overheating Components. Four Collapsible Detail Sections Provide Engineering Numbers: Mobility Details (Braking, Thrust-To-Mass, Engine Efficiency, Turn Sources, Turn Rates, Blocked Engines), Power Details (Generation, Demand, Delivered, Spare, Efficiency, And Energy Storage), Combat Details (Per-Weapon-Family DPS, Range, Point Defence, Beam Radius, Shield Recharge), And Support Details (Repair Rate, Drone Capacity, Drone Squads, Capture Pressure, Cooling Bonus).",
      importantStats: [
        { label: "Overview Fields", value: "9 (Cost, Mass, Acceleration, Hull, Shield, DPS, Speed, Turn, Power)" },
        { label: "Detail Sections", value: "4 (Mobility, Power, Combat, Support)" },
        { label: "Status Levels", value: "Good, Warning, Bad, Neutral" },
        { label: "Live Updates", value: "Yes : Updates As You Build" }
      ],
      practicalUse: "Watch The Power Field : Spare Means Healthy, Short Means Problems. Check Status Messages For Specific Issues. Expand Detail Sections For Engineering Numbers. The Summary Updates Live As You Build.",
      commonProblems: [
        "Power Showing Short? Add Reactors Or Reduce Power-Hungry Components.",
        "No Effective Thrust? Add Engines With Clear Exhaust Or Restore Power.",
        "Asymmetric Turning? Add Maneuver Thrusters Or Gyroscopes On The Weak Side.",
        "Insufficient Cooling? Add Radiators With Exposed Edges Or Heat Sinks."
      ],
      related: ["blueprint-designer", "power", "heat", "movement", "ship-cost-formula", "engine-exhaust"]
    },
  {
      id: "component-reference",
      category: "component-reference",
      title: "Component Reference",
      summary: "Exact, balance-backed stats and special mechanics for every component in the live catalogue.",
      keywords: ["component", "part", "reference", "stats", "cost", "mass", "hull", "catalogue"],
      howItWorks: "Every component article in this section is generated from the same balance catalogue used by the game. Entries include cost, mass, durability, Power, Heat, weapon values, limits, and any documented conditional mechanics. Search by component name when you know the part; use the learning sections when you need to understand the surrounding system.",
      practicalUse: "Compare exact component entries after deciding what job the ship needs to perform. Recheck conditional-performance and limitation rows before assuming a headline value applies in every state.",
      commonProblems: [],
      related: ["blueprint-designer", "heat", "weapons", "defence", "sensors-detection"]
    }
  ]),
  updates: Object.freeze({
    "blueprint-designer": {
      summary: "Place, rotate, flip, remove, analyse, save, and validate ship designs.",
      howItWorks: "Select a component from the palette and click the 15 by 15 grid to place it. Right-click a component to remove it, press R to rotate the focused component, and press F to flip components that support mirroring. Connectivity is design validation, not edit validation, so temporary disconnected layouts remain editable. Ctrl+Z undoes the last physical edit. Reset Design restores the starter ship; Clear All keeps only the Core. Existing invalid designs are highlighted with the affected component and anchor in Ship Summary. Purchase and save still use the full validity check. The Ship Summary, Heat analysis, and Data analysis update from the current design.",
      practicalUse: "Use the shared connectivity feedback while building. Keep useful intermediate layouts editable, inspect weapon arcs and exposed edges, then resolve every critical warning before purchase or save.",
      commonProblems: [
        "Part will not place? Its transformed footprint overlaps another component or leaves the grid.",
        "Design saves but will not deploy? Saving permits incomplete work; purchase requires a valid ship.",
        "Change missing after reload? Save the blueprint after the physical edit and Data Link changes."
      ]
    },
    "placement-rules": {
      summary: "Footprints, anchors, rotations, flips, and the limits enforced while editing.",
      howItWorks: "Every component occupies one or more grid cells. Its x and y identify the footprint anchor; rotation and optional flipping transform the complete footprint around that anchor. Placement, replacement, removal, rotation, and mirroring reject transformed footprints that leave the grid or overlap another component, while connectivity may be temporarily invalid during editing and is checked by design validation. Weapons and other explicitly rotatable components cycle through their allowed facings. Maneuver Thrusters choose their outward side automatically. Drone Bays keep their authored orientation because their exposed launch edge is part of the design rule.",
      practicalUse: "Rotate weapons to match the intended fighting direction, not merely to make them fit. Use the placement preview for the complete footprint. Finish by checking connectivity, exhaust channels, Drone Bay launch edges, and weapon arcs.",
      commonProblems: [
        "Part faces the wrong way? Focus it and press R; only authored rotations are available.",
        "Maneuver Thruster will not rotate? Its side-facing orientation is selected from placement.",
        "Part appears connected only at a corner? Diagonal contact does not satisfy deployment connectivity."
      ]
    },
    "structural-connectivity": {
      summary: "Every deployed component needs a side-adjacent structural route to the Core.",
      howItWorks: "Connectivity expands complete component footprints and traverses only up, down, left, and right contacts. Every component must first be physically reachable from the Core. A second traversal prevents ordinary components from using a chain of Heat Pipes as their only structural path; Heat Pipes are mounted thermal transport, not hull structure. The designer may hold a disconnected work in progress, while an invalid design is shown with the affected component and anchor. Purchase and save also reject disconnected designs.",
      practicalUse: "Give systems a real frame, armour, or component path back to the Core. Heat Pipes may branch from that structure and attach to hot components or cooling, but should never be the bridge supporting the far side of the ship.",
      commonProblems: [
        "Disconnected warning? Look for a gap or corner-only contact.",
        "A component beyond a Heat Pipe is invalid? Add a non-pipe structural route to it.",
        "Connectivity changed after rotation? Multi-cell footprint contacts rotate with the component."
      ]
    },
    "ship-validation": {
      summary: "The complete difference between a saveable design and a purchasable ship.",
      howItWorks: "A purchased ship needs exactly one Core, no more than one Backup Command Core, no overlap or out-of-bounds footprint, and a valid side-adjacent structural path from every component to the Core. Per-component limits apply. Each Drone Bay needs a selected Fighter, Defence, or Repair loadout and one complete exposed two-cell launch edge. Purchase also requires effective engine thrust, sufficient money, Ready status, an active match, and space below the fleet cap. Saving and Ready Up deliberately do not require a purchase-valid blueprint.",
      importantStats: [
        { label: "Main Core", value: "Exactly 1" },
        { label: "Backup Command Core", value: "Maximum 1" },
        { label: "Grid", value: "15 By 15, No Overlap" },
        { label: "Connectivity", value: "Side-Adjacent Structural Route To Core" },
        { label: "Drone Bays", value: `${GENERATED_BALANCE.drones?.maxBaysPerShip ?? 4} Maximum, Configured Type, Exposed Launch Edge` },
        { label: "Purchase Thrust", value: "At Least One Effective Engine" }
      ],
      practicalUse: "Save unfinished ideas freely, then treat the purchase result as authoritative. Check thrust after exhaust blocking, not merely whether an Engine exists. A request can buy between one and five copies, but each copy still consumes money and fleet capacity.",
      commonProblems: [
        "Engine fitted but thrust is still invalid? Clear the complete exhaust channel.",
        "Drone Bay invalid? Select a drone type and expose one whole two-cell launch edge.",
        "Ready Up succeeded but purchase failed? Readiness is intentionally independent of blueprint validity and money."
      ]
    },
    "ship-cost-formula": {
      title: "Ship Cost",
      summary: "The authoritative purchase price is the sum of placed component catalogue costs.",
      keywords: ["cost", "price", "component cost", "catalogue", "purchase", "money", "quantity"],
      howItWorks: "The server computes unit cost by adding the catalogue cost of every placed component in the saved design. There is no separate base-ship charge, mass surcharge, hull surcharge, weapon-family premium, rounding layer, or minimum and maximum clamp in the authoritative purchase path. Buying several copies multiplies that unit cost by the requested quantity. Component Reference and the Designer palette expose the individual values used by the sum.",
      importantStats: [
        { label: "Unit Cost", value: "Sum Of Every Placed Component Cost" },
        { label: "Quantity Cost", value: "Unit Cost Times Requested Count" },
        { label: "Separate Mass Or Hull Charge", value: "None" },
        { label: "Separate Weapon Premium", value: "None" },
        { label: "Purchase Clamp", value: "None" }
      ],
      practicalUse: "To lower price, remove or replace the components whose catalogue costs matter most. Armour, weapons, support, and structure affect price only through their own component values. Multiply unit price before requesting a batch so the full purchase remains affordable.",
      commonProblems: [
        "Expected a weapon premium? Weapon price is already represented by that component's catalogue cost.",
        "Batch purchase costs more than expected? The unit cost is multiplied by every requested copy.",
        "Displayed estimate and purchase result disagree? The server-computed saved-design price is authoritative."
      ]
    },
    "component-reference": {
      summary: "Balance-backed stats, mechanics, limitations, and interactions for every live component.",
      howItWorks: "Component entries are generated from the live part catalogue and the Ledger's explicit mechanics map. They include current cost, mass, durability, footprint, Power, Heat, weapon or support values, per-ship limits, conditional behaviour, and documented interactions. The learning guides explain system-wide rules that should not be repeated inconsistently on every component card.",
      practicalUse: "Choose a system guide first, then compare exact components that perform the job. Check conditional-performance and limitations rows before treating a headline number as continuously available. Use the inspector link to jump straight from a selected Designer component.",
      commonProblems: [
        "A value differs from an old build? Component entries follow the current loaded balance catalogue.",
        "A card lists a strong value but runtime is lower? Check its Power, Heat, health, stack rank, arc, and target conditions."
      ]
    }
  }),
  extraArticles: Object.freeze([

  ])
});
