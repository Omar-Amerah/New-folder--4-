// Owns the main mutable client state object.

import { WORLD_FALLBACK } from "./constants.js";
import { loadDesign, loadSavedDesigns } from "./design/blueprintStorage.js";

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
  purchaseQuantity: 1,
  selectedPart: "frame",
  selectedPartCategory: "Structure",
  previewRotation: 0,
  hoveredCell: null,
  selectedCell: null,
  selectedShipIds: new Set(),
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
  rules: { startingMoney: 700, shipCap: 30, maxPlayers: 12, mapSize: "auto", gameMode: "teams" },
  minimap: null,
  shipHud: new Map(),
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
