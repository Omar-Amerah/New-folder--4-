// Fleet Ledger authored content: Power, Heat, and movement teaching content.

import { BACKUP_EFFECTIVENESS_TEXT, BRAKE_ACCEL_RATIO, HEAT_MANUAL_CONTENT, MOVEMENT } from "./resolvedContentValues.js";

export const ENGINEERING_CONTENT = Object.freeze({
  articles: Object.freeze([
  {
      id: "power",
      category: "building-ships",
      title: "Power Systems",
      summary: "One shared Power pool, proportional shortages, and automatic energy storage.",
      keywords: ["power", "reactor", "generator", "battery", "capacitor", "energy", "availability"],
      howItWorks: "Live, enabled generators contribute their current Heat-adjusted output to one ship-wide pool. Active consumers contribute demand. If generation is short, charged storage shares the deficit proportionally according to each unit's available discharge rate. Any remaining shortage gives every live consumer the same proportional Power ratio; there is no component priority. Spare generator output charges storage proportionally according to each unit's available charge rate after demand is met, and storage never charges and discharges in the same solve. Overheated active components produce no useful output even when Power is available.",
      importantStats: [
        { label: "Distribution", value: "One Ship-Wide Pool" },
        { label: "Shortage Allocation", value: "Same Proportional Ratio For All Consumers" },
        { label: "Movement Shortage", value: `Linear Power ratio, ${Math.round(MOVEMENT.power.minimumMultiplier * 100)}% to ${Math.round(MOVEMENT.power.maximumMultiplier * 100)}%` },
        { label: "Other Active Systems", value: `Linear Power ratio, ${Math.round(MOVEMENT.power.minimumMultiplier * 100)}% to ${Math.round(MOVEMENT.power.maximumMultiplier * 100)}%` },
        { label: "Storage", value: "Automatic Discharge On Deficit, Charge On Surplus" }
      ],
      practicalUse: "Size generation for sustained demand and use storage for bursts, not permanent supply. A small deficit slows propulsion, weapons, support, and other active systems together. Watch reactor Heat because generation can fall before the demand panel changes.",
      commonProblems: [
        "Everything is partly weak at once? The shared Power ratio is below one.",
        "Storage empties immediately? Demand exceeds generation by more than the reserve can sustain.",
        "Rated generation looks sufficient but output is short? Inspect generator health and Heat state."
      ],
      related: ["blueprint-designer", "heat", "support"]
    },
  {
      id: "heat",
      category: "heat",
      title: "Heat Management",
      ...HEAT_MANUAL_CONTENT,
      related: ["power", "blueprint-designer"]
    },
  {
      id: "movement",
      category: "movement",
      title: "Movement & Orders",
      summary: "Engines, thrust, turn rate, continuous mass effects, and issuing commands.",
      keywords: ["movement", "engine", "thrust", "turn", "speed", "mass", "orders", "command", "right-click", "rally"],
      howItWorks: `Ships move using engine thrust. Live engines and directional actuators stack linearly: each contributes its full authored value after explicit Power, Heat, exhaust, and geometry conditions. Generic positive and negative turn modifiers from non-actuator components adjust the ship's symmetric turn rate. Maneuver thrusters provide directional torque based on their distance from the ship's centre of mass, with a lever from ${MOVEMENT.maneuverThrusterLever.minimumLever} up to ${MOVEMENT.maneuverThrusterLever.maximumLever}. Mass affects movement continuously. Acceleration shows how quickly the ship changes velocity. Turn rate comes from the ship's turning systems and decreases continuously as mass increases. Functioning generators and available battery discharge supply one ship-wide Power pool. Each powered movement consumer receives a linear share of available Power, and surplus supply does not increase movement. Issue orders by selecting ships and right-clicking the arena. Right-click an enemy to focus fire. Set a rally point to direct newly built ships. Ships without engines cannot move. Under Backup Command, turn rate follows ${BACKUP_EFFECTIVENESS_TEXT} effectiveness.`,
      importantStats: [
        { label: "Engine And Actuator Stacking", value: "Linear per live component" },
        { label: "Maneuver Min Lever", value: `${MOVEMENT.maneuverThrusterLever.minimumLever}` },
        { label: "Maneuver Lever Per Cell", value: `${MOVEMENT.maneuverThrusterLever.leverPerCell}` },
        { label: "Maneuver Max Lever", value: `${MOVEMENT.maneuverThrusterLever.maximumLever}` },
        { label: "Maximum Speed", value: "Calculated continuously from thrust and mass" },
        { label: "Braking", value: `${BRAKE_ACCEL_RATIO}x current acceleration` },
        { label: "Mass Turn Scaling", value: "Turn authority decreases continuously as mass increases" },
        { label: "Movement Power Scaling", value: `Linear per consumer, capped at ${Math.round(MOVEMENT.power.maximumMultiplier * 100)}%` },
        { label: "Surplus Power", value: "Charges storage; no movement bonus" }
      ],
      practicalUse: "Mass affects movement continuously, so balance propulsion and turning systems against the hull you are building. Use maneuver thrusters for better turning without adding much straight-line speed. Position maneuver thrusters far from the centre of mass for maximum lever effect. Gyroscopes are simpler but less powerful than a well-placed pair of maneuver thrusters.",
      commonProblems: [
        "Ship not moving? Check for engines and sufficient power.",
        "Turning too slowly? Add gyroscopes or maneuver thrusters.",
        "Ship slow despite engines? Mass reduces speed continuously : check the Ship Summary for Mass, Acceleration, and Max Speed."
      ],
      related: ["combat-styles", "blueprint-designer", "power", "economy"]
    }
  ]),
  updates: Object.freeze({
    power: {
      summary: "One shared Power pool, proportional shortages, and automatic energy storage.",
      howItWorks: "Live, enabled generators contribute their current Heat-adjusted output to one ship-wide pool. Active consumers contribute demand. If generation is short, charged storage shares the deficit proportionally according to each unit's available discharge rate. Any remaining shortage gives every live consumer the same proportional Power ratio; there is no component priority. Spare generator output charges storage proportionally according to each unit's available charge rate after demand is met, and storage never charges and discharges in the same solve. Overheated active components produce no useful output even when Power is available.",
      importantStats: [
        { label: "Distribution", value: "One Ship-Wide Pool" },
        { label: "Shortage Allocation", value: "Same Proportional Ratio For All Consumers" },
        { label: "Movement Shortage", value: `Linear Power ratio, ${Math.round(MOVEMENT.power.minimumMultiplier * 100)}% to ${Math.round(MOVEMENT.power.maximumMultiplier * 100)}%` },
        { label: "Other Active Systems", value: `Linear Power ratio, ${Math.round(MOVEMENT.power.minimumMultiplier * 100)}% to ${Math.round(MOVEMENT.power.maximumMultiplier * 100)}%` },
        { label: "Storage", value: "Automatic Discharge On Deficit, Charge On Surplus" }
      ],
      practicalUse: "Size generation for sustained demand and use storage for bursts, not permanent supply. A small deficit slows propulsion, weapons, support, and other active systems together. Watch reactor Heat because generation can fall before the demand panel changes.",
      commonProblems: [
        "Everything is partly weak at once? The shared Power ratio is below one.",
        "Storage empties immediately? Demand exceeds generation by more than the reserve can sustain.",
        "Rated generation looks sufficient but output is short? Inspect generator health and Heat state."
      ]
    },
    heat: {
      ...HEAT_MANUAL_CONTENT
    },
    movement: {
      summary: "Momentum, forward thrust, turning authority, waypoints, and continuous orders.",
       howItWorks: `Ships retain momentum and accelerate only along their forward thrust direction; there is no reverse or lateral engine thrust. Braking decelerates at ${BRAKE_ACCEL_RATIO}x normal forward acceleration. Turning creates an arc instead of snapping velocity onto a new heading. Ships have no built-in hull turn: Engines, Gyroscopes, and Maneuver Thrusters provide turn authority, and multiple live turn contributions stack directly. Mass affects movement continuously. Acceleration shows how quickly the ship changes velocity. Turn rate comes from the ship's turning systems and decreases continuously as mass increases. Generic authored turn modifiers adjust the symmetric rate when a ship has real turn authority. Maneuver torque depends on vertical distance from centre of mass and which side the thruster faces, so left and right turn authority can differ. Each movement consumer receives a linear share of available Power; surplus Power charges storage but does not boost movement. Right-click empty space for a move order, Shift-right-click to append waypoints for one selected ship, right-click an enemy to focus it, and use a rally point for new purchases.`,
      importantStats: [
         { label: "Engine And Actuator Stacking", value: "Linear per live component" },
         { label: "Braking", value: `${BRAKE_ACCEL_RATIO}x forward acceleration` },
         { label: "Turn Authority", value: "No built-in hull turn; Engines, Gyroscopes, and Maneuver Thrusters" },
         { label: "Maneuver Lever", value: `${MOVEMENT.maneuverThrusterLever.minimumLever} Minimum, +${MOVEMENT.maneuverThrusterLever.leverPerCell} Per Cell, ${MOVEMENT.maneuverThrusterLever.maximumLever} Maximum` },
         { label: "Mass", value: "Affects movement continuously" },
         { label: "Acceleration", value: "Shows how quickly the ship changes velocity" },
         { label: "Turn Rate", value: "Turning systems, reduced continuously by mass" },
         { label: "Movement Power Scaling", value: `Linear per consumer, capped at ${Math.round(MOVEMENT.power.maximumMultiplier * 100)}%` }
      ],
      practicalUse: `Plan braking distance and facing before contact. Ships brake at ${BRAKE_ACCEL_RATIO}x their forward acceleration, so stopping distance is much shorter than an acceleration-only estimate. Put Maneuver Thrusters above or below centre of mass and fit both turning directions unless asymmetry is deliberate. Use queued waypoints for a precise route around obstacles; use combat styles for continuing behaviour around a target.`,
      commonProblems: [
        "Ship curves past its destination? It must turn its forward thrust into a braking solution.",
        "One turn direction is weak? Check Maneuver Thruster side, vertical lever, health, exhaust, and Power.",
        "Shift-right-click replaced the route? Waypoint appending works only with one selected ship and empty ground."
      ]
    }
  }),
  extraArticles: Object.freeze([

  ])
});
