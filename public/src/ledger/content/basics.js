// Fleet Ledger authored content: Entry guidance, multiplayer flow, and player controls.

import { GENERATED_BALANCE } from "./resolvedContentValues.js";

export const BASICS_CONTENT = Object.freeze({
  articles: Object.freeze([
  {
      id: "overview",
      category: "start-here",
      title: "Start Here",
      summary: "Build a valid ship, deploy it, issue orders, and understand what wins a match.",
      keywords: ["start", "new player", "guide", "help", "first ship", "deploy", "win"],
      howItWorks: "The basic loop is simple: build a connected ship around one Core, give it clear engine exhaust and at least one weapon, deploy it, then use selection and right-click orders to contest relays and attack enemy forces. Ships continue fighting according to their chosen combat style after you issue an order. You win by completing the map objective or destroying the enemy home station. The Fleet Ledger stays available from the main menu and Blueprint Designer; search finds both learning articles and exact component entries.",
      practicalUse: "Read Building Ships first, then Combat and Movement. Add Heat, Sensors & Detection, and Data Links once your first design works. Use Component Reference when you need exact stats rather than a system explanation.",
      commonProblems: [],
      related: ["blueprint-designer", "combat", "movement", "economy", "component-reference"]
    },
  {
      id: "multiplayer",
      category: "start-here",
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
        "Disconnected? The game saves your room code for recovery : use the Resume button on the main menu.",
        "Can't start? Only the host can start the design phase."
      ],
      related: ["economy", "blueprint-designer", "controls"]
    },
  {
      id: "controls",
      category: "start-here",
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
    }
  ]),
  updates: Object.freeze({
    overview: {
      summary: "The shortest path from an empty blueprint to a useful fleet.",
      howItWorks: "Build or load a blueprint, Ready Up, then buy ships after the match becomes active. A purchase-valid ship has one Core, effective thrust, a connected non-overlapping layout, and enough Power and cooling for its intended job. Select ships and right-click to move or attack. Use combat styles for continuing behaviour, Sensors to maintain live targets, and relays for income. Classic matches end after one side controls every relay through the victory countdown. Station matches end only when an enemy home station is destroyed.",
      practicalUse: "For a first ship, keep the starter hull, confirm its exhaust remains clear, and add one weapon at a time while watching Power and Heat. Read Building Ships, Controls, Combat, and Economy & Objectives in that order. Use Component Reference only when you need exact part values.",
      commonProblems: [
        "Ready but no ship appeared? Ready Up starts the match; ships are bought from the purchase bar after it starts.",
        "Ship cannot be purchased? Open Ship Validation and resolve the exact purchase error.",
        "Enemy vanished? In sensor-limited modes, a remembered contact is not a live target."
      ]
    },
    multiplayer: {
      summary: "Room setup, four real phases, readiness, reconnects, bots, and rematches.",
      howItWorks: "A room moves through Lobby, Ship Design, Battle, and Ended. In Lobby, the host can edit mode, economy, capacity, map size, asteroid density, infrastructure, and visibility, assign bots, and begin Ship Design. During Ship Design, players may save blueprints and Ready Up independently of blueprint cost or validity. The server starts Battle as soon as every current player is ready; ships are then bought from the purchase bar. Designs may still be saved during Battle. Ended offers rematch and return-to-lobby routes. A disconnected player's identity is temporarily reserved, and Resume uses the saved room and resume credentials to reattach when possible.",
      importantStats: [
        { label: "Phases", value: "Lobby, Ship Design, Battle, Ended" },
        { label: "Battle Start", value: "Every Current Player Ready" },
        { label: "Purchases", value: "After Battle Starts" },
        { label: "Design Saving", value: "Ship Design And Battle" }
      ],
      practicalUse: "Agree on teams and visibility before the host starts design. Ready only when you are comfortable starting the economy clock, but remember you can keep editing and buy a corrected design after Battle begins. Use Resume before creating a replacement identity after a network interruption.",
      commonProblems: [
        "Host cannot change rules? Rule editing is Lobby-only.",
        "Battle does not start? At least one current player is not ready.",
        "Ready player has no ship? Deployment is a separate active-match purchase."
      ]
    },
    controls: {
      summary: "Complete mouse, camera, selection, command, battle, and Designer shortcuts.",
      howItWorks: "Left-click selects; drag creates a selection box and Shift adds to selection. Right-click empty ground moves, Shift-right-click appends a waypoint when exactly one ship is selected, and right-clicking an enemy attacks. Pan with WASD or arrow keys, middle-drag, or Space plus left-drag. The wheel zooms; minimap click centres the camera. Q selects all owned ships, C centres the selection or fleet, F follows, and 0 resets zoom. B stops selected ships, O and I rotate them while held, V toggles component-damage view, and Delete or Backspace requests self-destruction. Escape clears transient selection or closes the active overlay. In the Designer, R rotates, F flips, and Ctrl or Cmd plus Z undoes.",
      importantStats: [
        { label: "Move / Attack", value: "Right-Click Ground / Enemy" },
        { label: "Append Waypoint", value: "Shift + Right-Click, One Ship" },
        { label: "Pan", value: "WASD, Arrows, Middle-Drag, Space + Left-Drag" },
        { label: "Fleet", value: "Q Select All, B Stop, O/I Rotate" },
        { label: "Camera", value: "F Follow, C Centre, 0 Reset Zoom" },
        { label: "Designer", value: "R Rotate, F Flip, Ctrl/Cmd + Z Undo" },
        { label: "Self-Destruct", value: "Delete / Backspace" }
      ],
      practicalUse: "Learn right-click, Q, B, F, and camera drag first. Use one-ship waypoint queues for deliberate obstacle routes and formation leaders. Check focus if a shortcut appears inactive; text and numeric inputs consume typing.",
      commonProblems: [
        "Space-drag does not pan? Hold Space before starting the left drag, or use middle-drag.",
        "Waypoint was not appended? Select exactly one ship and Shift-right-click empty ground.",
        "F flips instead of following? The Designer is open and owns that shortcut."
      ]
    }
  }),
  extraArticles: Object.freeze([

  ])
});
