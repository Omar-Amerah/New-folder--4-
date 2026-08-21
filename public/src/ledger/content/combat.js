// Fleet Ledger authored content: Combat, weapons, targeting, projectile delivery, and destruction guidance.

import { formatPercent } from "../../design/statFormatting.js";
import { AUTOMATIC_COMPONENT_TARGETING_TEXT, GENERATED_BALANCE, SHIELD_ABSORPTION_TEXT, SHIELD_LEAK_TEXT } from "./resolvedContentValues.js";

export const COMBAT_CONTENT = Object.freeze({
  articles: Object.freeze([
  {
      id: "combat",
      category: "combat",
      title: "Combat Basics",
      summary: "How ships acquire targets, bring weapons to bear, and keep fighting after an order.",
      keywords: ["combat", "attack", "target", "focus fire", "range", "firing arc", "line of sight"],
      howItWorks: "Right-clicking an enemy gives the selected ships a focus-fire target. A ship can fire only when it has a valid, detected target inside a weapon's range and firing arc, with a clear firing solution. Its combat style decides how it moves around that target. Destroying the main Core destroys the ship unless a functioning Backup Command Core takes over. Damage lands on shields and components, so losing propulsion, cooling, sensors, support, or weapons can change what a surviving ship is able to do.",
      practicalUse: "Match the hull to its intended range and facing. Put narrow-arc weapons where the chosen combat style can keep them on target, layer defences around critical systems, and concentrate fire when you need to remove one enemy quickly.",
      commonProblems: [
        "Ship sees an enemy but does not fire? Check weapon range, firing arc, line of sight, Power, and Heat.",
        "Ship moves in an unexpected way? Its combat style still governs movement after target acquisition.",
        "Focus fire stopped? The target may be destroyed, hidden from Sensors, or no longer valid."
      ],
      related: ["combat-styles", "weapons", "defence", "sensors-detection", "movement"]
    },
  {
      id: "weapons",
      category: "weapons",
      title: "Weapons",
      summary: "Overview of all weapon types and their roles in combat.",
      keywords: ["weapon", "missile", "rail", "laser", "cannon", "beam", "torpedo", "flak", "emp", "shield disruption", "point defence", "damage", "dps"],
      howItWorks: "Weapons are the primary damage-dealing components. Each weapon type has distinct trade-offs: missiles track targets but can be intercepted, rails have long range and high alpha damage but slow fire rates, lasers provide continuous beam damage, cannons offer rapid fire with moderate damage, and beams melt shields. EMP Cannon removes a fixed fraction of target maximum Shield without dealing hull damage. Weapon stats are auto-generated from the authoritative component balance data. Select a specific weapon from the category list to see exact damage, fire rate, range, and tracking values.",
      practicalUse: "Mix weapon types for flexibility: missiles for burst, rails for range, point defense for anti-missile, and EMP Cannon for anti-Shield disruption. Check the component articles for exact stats and trade-offs.",
      commonProblems: [
        "Weapons not firing? Check the weapon's power state and whether it is alive and enabled.",
        "Missiles intercepted? Consider overwhelming enemy point defense with swarm missiles.",
        "Rails missing? They have narrow arcs : position ships carefully."
      ],
      related: ["combat-styles", "defence", "power", "heat", "blueprint-designer"]
    },
  {
      id: "combat-styles",
      category: "combat",
      title: "Combat Styles",
      summary: "Charge, Hold, Orbit, Kite, and Static define how ships move around their current combat target.",
      keywords: ["combat", "style", "hold", "charge", "orbit", "kite", "static", "behavior", "ai", "stance"],
      howItWorks: "Each ship follows one of five combat movement styles. Charge pursues continuously, leads a moving target, and drives through weapon range to contact without braking. Hold approaches when outside preferred weapon range, then fires from an established position without retreating from closer targets. Orbit flies a ring at its intended radius with a stable direction and continuous radial correction. Kite holds its target near the far edge of its main battery: it runs when the range collapses or a fast attacker is about to collapse it, eases back in when it drifts too far out, and closes only when the target leaves that battery's reach. There is no reverse thrust, so a kiting ship picks a hull heading that both opens the range and keeps guns bearing -- a rear-mounted railgun keeps firing while the ship accelerates away, while a nose gun loses coverage during the turn and gets it back once the range is safe. It routes around asteroids and stations and turns away from the map edge instead of grinding along it. Static never repositions for combat at all: it holds the ground it is standing on and turns to face whatever it is shooting. Ships acquire another nearby enemy when their current target becomes invalid. A move order you issue by hand overrides all of this until you give the ship another command.",
      importantStats: [
        { label: "Hold Range Ratio", value: "80% Of Max Weapon Range" },
        { label: "Charge Stop", value: "Contact Distance" },
        { label: "Orbit Range Ratio", value: "75% Of Max Weapon Range" },
        { label: "Kite Preferred Range", value: "90% Of Main Battery Reach" },
        { label: "Kite Retreat Below", value: "78% Of Main Battery Reach" },
        { label: "Kite Closes Above", value: "96% Of Main Battery Reach" },
        { label: "Static Movement", value: "None" }
      ],
      practicalUse: "Hold is the general ranged default. Charge suits ships that must force close contact. Orbit rewards agile ships that can sustain a curved course. Kite suits fast, long-range ships, and it is at its best with the main gun mounted to the rear so the ship can shoot down its own wake. Static suits ships you want anchored exactly where you put them.",
      commonProblems: [
        "Ship not engaging? It may have no weapons with range, or the target is out of range.",
        "Hold ship moving closer? Its target has moved outside preferred weapon range.",
        "Kite ship moving away? Its target is inside the retreat threshold, or is closing fast enough to be about to cross it.",
        "Kite ship not shooting while it runs? Its guns are mounted forward. Rotate the main weapon to the rear and it will fire down its own wake.",
        "Ship ignoring its stance? You gave it a move or stop order by hand -- those hold until you command it again.",
        "Want to change style mid-match? Select ships and use the combat style buttons in the match panel."
      ],
      related: ["movement", "weapons", "defence"]
    },
  {
      id: "projectile-mechanics",
      category: "advanced-mechanics",
      title: "Projectile Mechanics",
      summary: "How projectiles travel, collide, and interact with shields and hull.",
      keywords: ["projectile", "collision", "shield", "hull", "hit radius", "intercept", "missile", "rail", "impact"],
      howItWorks: `Projectiles travel at their weapon's projectile speed toward the target. Each projectile type has a hit radius for collision detection. Missiles have a larger hit radius than rails. When a projectile hits a shield, it deals damage modified by the weapon's shield damage multiplier. Shields absorb ${SHIELD_ABSORPTION_TEXT} of blocked damage; ${SHIELD_LEAK_TEXT} leaks to hull. When a projectile hits hull, it deals damage modified by the hull damage multiplier. Occupied grid cells define Hull collision, so tapered and clipped component artwork is cosmetic and does not cut matching corners out of the server hit geometry. Low-Shield EMP is the deliberate exception: it couples to the ship's physical electromagnetic envelope rather than requiring a living-component hit. Point defence and flak can intercept missiles within the intercept radius.`,
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
      practicalUse: "Missiles are easier to intercept due to larger hit radius and slower speed. Rails are harder to intercept : small hit radius and very high speed. Shields provide a collision radius that can catch near-misses.",
      commonProblems: [
        "Shots passing through shields? The shield collision radius may not be large enough for the projectile.",
        "Missiles shot down? Enemy point defence intercepts within 20 m."
      ],
      related: ["weapons", "defence", "missile-guidance"]
    },
  {
      id: "missile-guidance",
      category: "advanced-mechanics",
      title: "Missile Guidance",
      summary: "How missiles track targets, turn, and get countered by ECM.",
       keywords: ["missile", "guidance", "tracking", "turn rate", "ecm", "lead", "arming"],
       howItWorks: "Missiles travel at their listed Projectile Speed throughout flight. They arm with a reduced turn rate, then switch to full tracking after the arming phase. Turn rate scales with the weapon's tracking stat squared. Missiles lead their targets based on lead strength, while ECM from electronic warfare command centres can reduce missile tracking effectiveness.",
      importantStats: [
        { label: "Arming Turn Rate", value: `${GENERATED_BALANCE.missileGuidance?.armingTurnRate ?? 0.1}` },
        { label: "Default Tracking", value: `${GENERATED_BALANCE.missileGuidance?.defaultTracking ?? 0.5}` },
        { label: "Base Turn Rate", value: `${GENERATED_BALANCE.missileGuidance?.baseTurnRate ?? 0.7}` },
        { label: "Turn Rate Base", value: `${GENERATED_BALANCE.missileGuidance?.turnRateBase ?? 0.45}` },
        { label: "Tracking² Multiplier", value: `${GENERATED_BALANCE.missileGuidance?.turnRateTrackingSquaredMultiplier ?? 4.2}×` },
        { label: "Lead Strength Multiplier", value: `${GENERATED_BALANCE.missileGuidance?.leadStrengthMultiplier ?? 0.35}×` },
         { label: "ECM Cap", value: formatPercent(GENERATED_BALANCE.missileGuidance?.ecmCap ?? 0.55) }
      ],
      practicalUse: "Higher tracking weapons turn harder : swarm missiles track better than torpedoes. ECM from Electronic Warfare Command Centres can reduce tracking by up to 55%, making missiles miss agile targets.",
      commonProblems: [
        "Missiles missing? Target may be too agile or ECM is reducing tracking.",
        "Torpedoes not hitting? They have low tracking (0.2) : use against slow or stationary targets."
      ],
      related: ["weapons", "projectile-mechanics", "defence", "command"]
    }
  ]),
  updates: Object.freeze({
    combat: {
      summary: "Detection, target validity, firing solutions, damage, and loss of systems.",
      keywords: ["combat", "attack", "target", "focus fire", "range", "firing arc", "line of sight", "spawn protection", "safe zone", "spawn zone", "hostile heat"],
      howItWorks: "Right-clicking a visible enemy assigns it as the selected ships' explicit target. A weapon fires only when its target is alive, currently targetable by the team, inside range and firing arc, and accepted by its firing-solution checks. Turrets rotate toward their solution rather than firing through an invalid bearing. Shields, armour, and component placement determine where damage goes. Destroyed components immediately lose their function. Spawn Protection: While a ship remains inside its own/team spawn zone, it cannot fire and cannot take combat damage or hostile Heat. This covers normal damage, direct component damage, induction Heat, and impact Heat. Normal combat begins after it leaves the zone. Destroying the main Core destroys the ship unless an operational Backup Command Core takes control.",
      practicalUse: "Concentrate fire to remove a dangerous system or hull before repairs recover it. Leave your own/team spawn zone before expecting weapons to fire or incoming damage and hostile Heat to resolve. Match weapon arcs to the combat style, protect the Core and propulsion, and keep a sensor source near long-range ships in restricted visibility modes.",
      commonProblems: [
        "Target is visible but a weapon does not fire? Check that weapon's range, arc, aim, Power, Heat, and line of fire.",
        "Fleet stopped focus firing? The explicit target died or ceased to be a valid live target.",
        "Ship survives but performs poorly? Inspect component damage; intact hull does not mean intact systems.",
        "Turrets track but do not fire? The ship may still be inside its own/team spawn zone; leave the zone to begin normal combat.",
        "Enemy damage or Heat has no effect? The target may still be inside its own/team spawn zone."
      ],
      related: ["targeting-and-arcs", "combat-styles", "damage-and-destruction", "defence", "sensors-detection"]
    },
    weapons: {
      summary: "Choose weapons by target, delivery method, range, arc, and counterplay.",
      howItWorks: "Every weapon combines damage or Heat effect, fire rate, range, firing arc, tracking, Power demand, Heat, and delivery rules. Blasters are direct general-purpose guns. Autocannons trade reach for rapid anti-hull fire. Beams apply sustained pressure and are strong against shields. Rail weapons deliver precise long-range hits through narrow arcs. Missiles, swarms, and torpedoes guide toward targets but can be intercepted or diverted. Fragmentation and scatter weapons distribute damage across an area or pellets. Thermal Induction Lances inject Heat rather than ordinary damage. Proximity and demolition charges demand very close delivery. Exact live values and component-specific exceptions are in Component Reference.",
      importantStats: [
        { label: "Direct Fire", value: "Blasters, Autocannons, Beams, Rails, Plasma, Scatter" },
        { label: "Guided", value: "Missiles, Swarms, Torpedoes" },
        { label: "Area And Multi-Hit", value: "Fragmentation, Scatter, Flak" },
        { label: "Thermal Attack", value: "Thermal Induction Lance" },
        { label: "Close Delivery", value: "Proximity And Demolition Charges" }
      ],
      practicalUse: "Start with one coherent main battery whose ranges and arcs overlap. Add a second family only to solve a real weakness, such as interception, shields, armour, or close attackers. Use Data Links to concentrate accuracy, range, or fire-rate support on the weapons that define the ship.",
      commonProblems: [
        "Headline DPS never appears? The weapon may spend time aiming, cooling, reloading, travelling, or being intercepted.",
        "Mixed battery fires in fragments? Its ranges or arcs do not create one shared firing envelope.",
        "Thermal Lance appears to deal no damage? Its purpose is Heat injection, with shield reduction and Refractory protection applying."
      ],
      related: ["targeting-and-arcs", "combat", "projectile-mechanics", "missile-guidance", "support", "component-reference"]
    },
    "combat-styles": {
      summary: "Charge, Hold, Orbit, Kite, and Static control movement around the current target.",
      howItWorks: "Charge drives to contact and is the natural style for proximity-charge ramming ships. Hold approaches until it has a usable firing solution near 80% of maximum weapon reach, then maintains position without backing away from close targets. Orbit continuously flies a ring near 85% of reach and can reverse orbit direction. Kite prefers 90% of main-battery reach, retreats below 78%, and closes above 96%; because ships cannot thrust backward, rear-facing guns keep firing most reliably during retreat. Static never repositions for combat, though it can turn to aim. Auto Engage controls automatic target acquisition. Pursue controls whether a non-explicit target may pull a ship back into range; an explicit attack order remains authoritative.",
      importantStats: [
        { label: "Hold Enter", value: "80% Of Max Weapon Range" },
        { label: "Hold Resume", value: "105%" },
        { label: "Orbit", value: "85%" },
        { label: "Kite", value: "90% Preferred, 78% Retreat, 96% Close" },
        { label: "Static", value: "No Automatic Repositioning" }
      ],
      practicalUse: "Use Hold as the dependable ranged stance, Orbit for agile ships that can keep arcs aligned, Kite for fast long-range hulls with rear coverage, Charge for contact weapons, and Static when exact ground matters. Change the stance and movement toggles on selected ships during battle.",
      commonProblems: [
        "Hold moves closer than expected? It is seeking the first usable solution, not just numeric range.",
        "Kite turns away and stops firing? Its main weapons lack rear coverage.",
        "Ship does not acquire nearby enemies? Check Auto Engage, detection, and whether any weapon can use the target."
      ]
    },
    "projectile-mechanics": {
      summary: "Projectile travel, swept collision, shield interaction, overflow, splash, and interception.",
      howItWorks: `Projectile weapons create authoritative moving shots that use swept collision between simulation steps. A shield interaction requires a live shield above its minimum and applies the weapon's shield multiplier. The shield absorbs up to available capacity; ${SHIELD_ABSORPTION_TEXT} of the blocked portion is prevented, ${SHIELD_LEAK_TEXT} of corresponding hull damage leaks through, and any overflow continues to hull. Hull damage then applies its own weapon multiplier and local protection. Splash and pellet weapons can create several protection interactions. Interceptable guided projectiles may be destroyed by point defence, flak, interceptor systems, or Defence drones before impact.`,
      practicalUse: "Judge a delivery system by time to impact and counterplay, not card damage alone. Saturate interception with multiple threats, use fast direct shots against agile targets, and remember that shields reduce rather than guarantee zero hull damage.",
      commonProblems: [
        `Hull is damaged through a healthy shield? ${SHIELD_LEAK_TEXT} leakage is part of shield absorption.`,
        "Projectile vanished before impact? An active defence intercepted it or its lifetime ended.",
        "Multi-pellet shot is weak into armour? Each pellet can meet flat reduction separately."
      ]
    },
    "missile-guidance": {
       summary: "Arming, constant projectile speed, lead, tracking, ECM resistance, loss of target, and interception.",
       howItWorks: "Guided weapons travel at their listed Projectile Speed, arm with limited turning, and steer toward a predicted intercept. Effective turning rises strongly with tracking. Electronic-warfare command effects reduce missile tracking up to the configured cap, and agile targets can outrun a weak solution. Guidance still requires a valid target relationship; decoys may redirect suitable missiles, while point defence and other interceptors can destroy them. Torpedoes trade tracking for heavy payload and are most reliable against slow, large, or stationary targets.",
      practicalUse: "Launch from a geometry that gives the missile room to arm and turn. Use higher-tracking families against agile hulls, torpedoes against stations and capitals, and saturation when the target has layered interception.",
      commonProblems: [
        "Missile spirals or misses close targets? It lacked turn room during arming.",
        "Torpedo misses a light ship? Its low tracking is an intentional target tradeoff.",
        "Guided salvo changes target? Decoy and target-validity rules can redirect it."
      ]
    }
  }),
  extraArticles: Object.freeze([
  {
      id: "targeting-and-arcs",
      category: "weapons",
      title: "Targeting, Arcs & Firing Solutions",
      summary: "Why a valid enemy may still not be a valid shot.",
      keywords: ["targeting", "arc", "turret", "aim", "line of sight", "range", "detected", "focus fire", "component", "weighted random", "point defence"],
      howItWorks: `Target selection and weapon permission are separate. A ship may hold an explicit or automatic target, but each weapon independently checks team visibility, target type, range, authored firing arc, turret aim, operational state, and any weapon-specific solution. Narrow fixed arcs reward hull facing; wide turrets trade less hull dependence for their own tracking and aim time. Losing live detection invalidates hostile targeting even while a remembered contact remains visible on the map. The Automatic Component Targeting guide explains the global subsystem-selection rules in detail. ${AUTOMATIC_COMPONENT_TARGETING_TEXT} Retained component aims and Heat mechanics remain otherwise unchanged.`,
      practicalUse: "Design one overlapping battery envelope and choose a combat style that keeps it on target. Test front, side, and retreat bearings. Use directed sensors and Data Links only after the geometry already works.",
      commonProblems: [
        "Some guns fire and others do not? Their arcs, ranges, or aim states differ.",
        "Remembered marker cannot be focused? Last-known information is not live targeting permission.",
        "Kiting ship loses its main battery? Rotate the defining weapons toward the retreat bearing."
      ],
      related: ["weapons", "combat", "combat-styles", "sensors-detection", "support", "automatic-component-targeting"]
    },
  {
      id: "automatic-component-targeting",
      category: "weapons",
      title: "Automatic Component Targeting",
      summary: "How ordinary weapons choose components inside an enemy ship.",
      keywords: ["automatic", "component", "targeting", "weighted", "random", "retarget", "point defence", "specialist"],
      howItWorks: AUTOMATIC_COMPONENT_TARGETING_TEXT,
      practicalUse: "Expose important systems when you want them to be attractive targets, but do not rely on an ordinary weapon to select one exact subsystem every time. Use a specialist weapon when its documented priority matches the system you need to pressure.",
      commonProblems: [
        "The weapon chose Structure or another system instead? Ordinary component targeting is weighted, not guaranteed.",
        "The same component stayed under fire? Weapons can retain a component aim for a period before selecting again.",
        "Point Defence ignored a ship component? Point Defence chooses incoming threats, not components inside a ship."
      ],
      related: ["targeting-and-arcs", "weapons", "combat", "defence", "component-reference"]
    },
  {
      id: "damage-and-destruction",
      category: "combat",
      title: "Damage, Components & Ship Destruction",
      summary: "How local component loss degrades a ship before the hull is finally lost.",
      keywords: ["damage", "component damage", "core", "destroyed", "backup core", "hull", "self destruct"],
      howItWorks: "Hits resolve against shields and the impacted ship structure. Component health is authoritative: a destroyed Engine removes thrust, a destroyed weapon stops firing, lost sensors remove their coverage, damaged cooling changes Heat survival, and lost generation changes the shared Power ratio. The ship can remain alive while these systems fail. Destroying the main Core is terminal unless a valid Backup Command Core assumes control. Delete or Backspace sends an explicit self-destruction request for selected owned ships.",
      practicalUse: "Use V and the selected-ship damage panel to distinguish hull survival from functional survival. Protect the Core, generation, propulsion, and cooling with geometry and defence appropriate to the likely incoming direction.",
      commonProblems: [
        "Ship has hull but cannot move or shoot? The required components may be destroyed or offline.",
        "Backup ship is weaker after Core loss? Backup command intentionally applies accuracy, turn, and drone-range penalties.",
        "Self-destruct did not affect an enemy? It applies only to selected owned ships."
      ],
      related: ["combat", "defence", "power", "heat", "command"]
    }
  ])
});
