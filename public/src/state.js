// Owns the main mutable client state object.

import { WORLD_FALLBACK } from "./constants.js";
import { loadDesign, loadSavedDesigns, loadLoadouts } from "./design/blueprintStorage.js";
import { GENERATED_BALANCE } from "./generatedBalance.js";

const initialDesign = loadDesign();

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

export const DEFAULT_THERMAL_LOAD_MODE = "combat";

export const PRESENTATION_DIAGNOSTIC_DEFAULTS = Object.freeze({
  snapshotAcceptedCount: 0,
  presentationDispatchCount: 0,
  presentationErrorCount: 0,
  phaseTransitionCount: 0,
  phasePresentationSyncCount: 0,
  economyHudUpdateCount: 0,
  fleetHudUpdateCount: 0,
  relayHudUpdateCount: 0,
  selectionHudUpdateCount: 0,
  objectiveHudUpdateCount: 0,
  heatHudUpdateCount: 0,
  latencyHudUpdateCount: 0,
  teamHudUpdateCount: 0,
  lobbyPlayerListRebuildCount: 0,
  lobbyPlayerRowPatchCount: 0,
  hiddenLobbyDomWriteCount: 0,
  selectedVitalsUpdateCount: 0,
  selectedDamageUpdateCount: 0,
  selectedHeatUpdateCount: 0,
  selectedPowerUpdateCount: 0,
  selectedStaticGeometryBuildCount: 0,
  selectedStaticWiringBuildCount: 0,
  selectedDynamicRedrawCount: 0,
  purchaseAffordabilityUpdateCount: 0,
  purchasePendingUpdateCount: 0,
  purchaseErrorUpdateCount: 0,
  purchaseCatalogueBuildCount: 0,
  deploymentControlsUpdateCount: 0,
  matchStatusUpdateCount: 0,
  stationPanelUpdateCount: 0,
  relayStatusUpdateCount: 0,
  controlVictoryStatusUpdateCount: 0,
  scoreboardStatusUpdateCount: 0,
  winnerUpdateCount: 0,
  presentationDomWriteCount: 0,
  hudDomWriteCount: 0,
  lobbyDomWriteCount: 0,
  purchaseDomWriteCount: 0,
  selectedPanelDomWriteCount: 0
});

function makePresentationDiagnostics() {
  return {
    ...PRESENTATION_DIAGNOSTIC_DEFAULTS,
    latest: {
      previousPhase: null,
      acceptedPhase: null,
      statePhase: null,
      snapshotSeq: null,
      phaseChanged: null,
      operations: []
    }
  };
}

export const state = {
  visualShips: new Map(),
  socket: null,
  connectionGeneration: 0,
  connectionId: null,
  myId: null,
  room: "",
  world: { ...WORLD_FALLBACK },
  parts: {},
  design: initialDesign.modules,
  wiring: initialDesign.wiring,
  dataLinks: initialDesign.dataLinks || [],
  combatStyle: initialDesign.combatStyle,
  // Which way round the Orbit button offers next when the current selection has
  // no single answer of its own -- nothing orbiting yet, or a mixed selection.
  // Ships carry their own direction authoritatively; this is only the UI's
  // opening bid. 1 is clockwise, -1 anticlockwise.
  orbitDirectionPreference: 1,
  designNormalizationIssues: Array.isArray(initialDesign.normalizationIssues) ? initialDesign.normalizationIssues : [],
  designNeedsAttention: Boolean(initialDesign.needsAttention),
  savedDesigns: loadSavedDesigns(),
  loadedEditorBlueprintId: null,
  draggingSavedDesignId: null,
  loadouts: loadLoadouts(),
  activeLoadoutId: "all",
  loadoutEditMode: false,
  pendingNewLoadoutName: null,
  purchaseQuantity: 1,
  selectedPart: "frame",
  selectedPartCategory: "Structure",
  previewRotation: 0,
  hoveredCell: null,
  selectedCell: null,
  blueprintView: "build",
  designerInspectorTab: "design",
  designerAnalysisTab: "heat",
  savedBlueprintSearch: "",
  savedBlueprintSort: "manual",
  // Manual Wiring editor state. Physical section tier is stored in wiring,
  // while this object only tracks an unfinished path and inspection.
  wiringUi: {
    mode: "power",
    // Section 7B Power tools. Data keeps the simpler single-tier workflow and
    // ignores tool/tier selection. selectedPowerTier persists for the session.
    wiringTool: "draw",
    selectedPowerTier: "standard",
    hoveredSectionId: null,
    selectedIndex: null,
    selectedConnectionKey: null,
    selectedSectionId: null,
    selectedPowerShortageNetworkId: null,
    hoveredPowerShortageNetworkId: null,
    sourceIndex: null,
    path: [],
    hoverCell: null,
    livePointer: null,
    dragging: false,
    undoStack: []
  },
  thermalLoadMode: DEFAULT_THERMAL_LOAD_MODE,
  heatFlowView: "local",
  showAllHeatFlows: false,
  hoveredHeatPartIndex: null,
  pendingBlueprintDestructiveAction: null,
  pendingWiringClearNetwork: null,
  pendingDirtyAction: null,
  shipStatusView: "damage",
  debugTurrets: false,
  selectedShipIds: new Set(),
  // Courses this client has drawn for single ships: shipId -> ordered [{x, y}],
  // starting with the leg the ship is flying now. It is a record of what was
  // ordered, not a copy of server state -- the queue itself lives on the server,
  // and this exists so the path can be drawn without putting every ship's
  // pending orders on the wire for everyone to see. Entries are trimmed against
  // the ship's published destination each frame and dropped once they no longer
  // describe the order the ship is actually under.
  orderQueues: new Map(),
  // Station selection is deliberately separate from ship selection: stations are
  // inspectable but not commandable, so they must never join a command group.
  selectedStationId: null,
  desiredTelemetryFocusShipId: null,
  telemetryFocusLastSentShipId: null,
  telemetryFocusLastSentGeneration: null,
  joinedConnectionGeneration: null,
  activeShipGroup: null,
  shipGroups: { group1: new Set(), group2: new Set(), group3: new Set(), group4: new Set(), group5: new Set() },
  shipGroupBaseCombatStyles: new Map(),
  shipGroupSettings: {
    group1: { combatStyle: "ship" },
    group2: { combatStyle: "ship" },
    group3: { combatStyle: "ship" },
    group4: { combatStyle: "ship" },
    group5: { combatStyle: "ship" }
  },
  settingRallyPoint: false,
  snapshot: null,
  snapshotIndex: null,
  presentationDiagnostics: makePresentationDiagnostics(),
  presentationLocalRevision: {
    blueprint: 0,
    wiring: 0,
    purchase: 0,
    telemetry: 0,
    rally: 0
  },
  snapshotNetwork: { stateEpoch: 0, snapshotSeq: 0, staticRevision: 0, hasFullBaseline: false, resyncing: false, lastResyncRequestAt: 0 },
  // Backend identification from hello/state messages:
  // { protocolVersion, buildSha, compatibility: "ok" | "stale" | "incompatible" }
  server: null,
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
  rules: { startingMoney: GENERATED_BALANCE.economy.startingMoney, shipCap: 30, maxPlayers: 8, mapSize: "auto", gameMode: "teams", asteroidDensity: "medium", infrastructureMode: "stations", visibilityMode: "sensors" },
  minimap: null,
  shipHud: new Map(),
  engineSmoke: [],
  engineSmokeEmitters: new Map(),
  pendingPurchases: new Map(),
  purchaseErrors: new Map(),
  purchaseResults: new Map(),
  purchasePointer: null,
  savedDesignPointer: null,
  pendingCombatStyle: null,
  pendingMovementToggles: new Map(),
  pendingDeleteDesignId: null,
  pendingKickTargetId: null,
  kickPointer: null,
  notices: [],
  lastPingAt: 0,
  lastPongAt: 0,
  latency: null,
  command: null,
  pendingStartDesign: false,
  pendingDeploy: false,
  pendingEndGameAction: null,
  lastFrameAt: performance.now()
};
