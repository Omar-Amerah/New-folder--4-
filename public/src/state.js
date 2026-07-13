// Owns the main mutable client state object.

import { WORLD_FALLBACK } from "./constants.js";
import { loadDesign, loadSavedDesigns, loadLoadouts } from "./design/blueprintStorage.js";

function makeStars(count) {
  const stars = [];
  for (let i = 0; i < count; i += 1) {
    const bright = Math.random() > 0.78;
    stars.push({
      x: Math.random(),
      y: Math.random(),
      size: bright ? 2 : 1,
      drift: -0.006 - Math.random() * 0.018,
      color: bright ? "rgba(220,242,255,0.86)" : "rgba(170,194,220,0.42)"
    });
  }
  return stars;
}

export const state = {
  visualShips: new Map(),
  socket: null,
  myId: null,
  room: "",
  world: { ...WORLD_FALLBACK },
  parts: {},
  design: loadDesign().modules,
  combatStyle: loadDesign().combatStyle,
  savedDesigns: loadSavedDesigns(),
  loadedEditorBlueprintId: null,
  draggingSavedDesignId: null,
  loadouts: loadLoadouts(),
  activeLoadoutId: "all",
  loadoutEditMode: false,
  purchaseQuantity: 1,
  selectedPart: "frame",
  selectedPartCategory: "Structure",
  previewRotation: 0,
  hoveredCell: null,
  selectedCell: null,
  blueprintView: "build",
  thermalLoadMode: "full",
  heatTool: "place",
  heatFlowView: "local",
  showAllHeatFlows: false,
  hoveredHeatPartIndex: null,
  inspectedHeatPartIndex: null,
  shipStatusView: "damage",
  debugTurrets: false,
  selectedShipIds: new Set(),
  activeShipGroup: null,
  shipGroups: { group1: new Set(), group2: new Set(), group3: new Set(), group4: new Set(), group5: new Set() },
  shipGroupBaseCombatStyles: new Map(),
  shipGroupSettings: {
    group1: { formation: "line", combatStyle: "ship" },
    group2: { formation: "line", combatStyle: "ship" },
    group3: { formation: "line", combatStyle: "ship" },
    group4: { formation: "line", combatStyle: "ship" },
    group5: { formation: "line", combatStyle: "ship" }
  },
  settingRallyPoint: false,
  snapshot: null,
  mine: null,
  map: null,
  phase: "offline",
  joiningLobby: false,
  adminId: null,
  camera: { x: WORLD_FALLBACK.width / 2, y: WORLD_FALLBACK.height / 2, zoom: 0.58, follow: true, manualZoom: null },
  pointer: { x: 0, y: 0 },
  drag: null,
  keys: new Set(),
  stars: makeStars(260),
  rules: { startingMoney: 700, shipCap: 30, maxPlayers: 12, mapSize: "auto", gameMode: "teams", asteroidDensity: "medium" },
  minimap: null,
  shipHud: new Map(),
  engineSmoke: [],
  engineSmokeEmitters: new Map(),
  pendingPurchases: new Map(),
  purchaseErrors: new Map(),
  purchasePointer: null,
  savedDesignPointer: null,
  pendingDeleteDesignId: null,
  pendingKickTargetId: null,
  kickPointer: null,
  notices: [],
  lastPingAt: 0,
  lastPongAt: 0,
  latency: null,
  command: null,
  lastFrameAt: performance.now()
};
