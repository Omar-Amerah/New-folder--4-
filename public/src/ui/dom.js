// Centralizes document.getElementById lookups to decouple modular code from direct DOM queries.

export const dom = {
  canvas: document.getElementById("arenaCanvas"),
  blueprintDesignerScreen: document.getElementById("blueprintDesignerScreen"),
  openBlueprintDesignerButton: document.getElementById("openBlueprintDesignerButton"),
  closeBlueprintDesignerButton: document.getElementById("closeBlueprintDesignerButton"),
  status: document.getElementById("connectionStatus"),
  roomState: document.getElementById("roomStateText"),
  mainMenuNotice: document.getElementById("mainMenuNotice"),
  pilotName: document.getElementById("pilotName"),
  teamSelect: document.getElementById("teamSelect"),
  roomCode: document.getElementById("roomCode"),
  createButton: document.getElementById("createButton"),
  currentRoomCard: document.getElementById("currentRoomCard"),
  currentRoomCode: document.getElementById("currentRoomCode"),
  phaseDetail: document.getElementById("phaseDetail"),
  stepLobby: document.getElementById("stepLobby"),
  stepDesign: document.getElementById("stepDesign"),
  stepBattle: document.getElementById("stepBattle"),
  stepEnd: document.getElementById("stepEnd"),
  joinButton: document.getElementById("joinButton"),
  copyButton: document.getElementById("copyButton"),
  copyCodeButton: document.getElementById("copyCodeButton"),
  botButton: document.getElementById("botButton"),
  leaveLobbyButton: document.getElementById("leaveLobbyButton"),
  hostActions: document.getElementById("hostActions"),
  rulesStatus: document.getElementById("rulesStatus"),
  rulesGrid: document.getElementById("rulesGrid"),
  rulesReadOnly: document.getElementById("rulesReadOnly"),
  gameModeSelect: document.getElementById("gameModeSelect"),
  startingMoneyInput: document.getElementById("startingMoneyInput"),
  maxPlayersInput: document.getElementById("maxPlayersInput"),
  mapSizeSelect: document.getElementById("mapSizeSelect"),
  asteroidDensitySelect: document.getElementById("asteroidDensitySelect"),
  teamChoiceCard: document.getElementById("teamChoiceCard"),
  teamChoiceStatus: document.getElementById("teamChoiceStatus"),
  adminControls: document.getElementById("adminControls"),
  startDesignButton: document.getElementById("startDesignButton"),
  restartLobbyButton: document.getElementById("restartLobbyButton"),
  closeLobbyButton: document.getElementById("closeLobbyButton"),
  playerList: document.getElementById("playerList"),
  deployButton: document.getElementById("deployButton"),
  shipGroupTotal: document.getElementById("shipGroupTotal"),
  shipGroupList: document.getElementById("shipGroupList"),
  rallyPanel: document.getElementById("rallyPanel"),
  rallyStatus: document.getElementById("rallyStatus"),
  rallyPointButton: document.getElementById("rallyPointButton"),
  resetRallyButton: document.getElementById("resetRallyButton"),
  resetButton: document.getElementById("resetButton"),
  clearGridButton: document.getElementById("clearGridButton"),
  formationSelect: document.getElementById("formationSelect"),
  palette: document.getElementById("partPalette"),
  partInspector: document.getElementById("partInspector"),
  grid: document.getElementById("buildGrid"),
  blueprintBuildTab: document.getElementById("blueprintBuildTab"),
  blueprintHeatTab: document.getElementById("blueprintHeatTab"),
  blueprintHeatLegend: document.getElementById("blueprintHeatLegend"),
  thermalLoadModes: document.getElementById("thermalLoadModes"),
  thermalScenarioLabel: document.getElementById("thermalScenarioLabel"),
  fullLoadThermalPanel: document.getElementById("fullLoadThermalPanel"),
  buildStatus: document.getElementById("buildStatus"),
  shipStatusChip: document.getElementById("shipStatusChip"),
  shipStatusText: document.getElementById("shipStatusText"),
  shipStatusDetails: document.getElementById("shipStatusDetails"),
  stats: document.getElementById("statsGrid"),
  saveDesignButton: document.getElementById("saveDesignButton"),
  savedDesignList: document.getElementById("savedDesignList"),
  combatStyleSelect: document.getElementById("combatStyleSelect"),
  blueprintCostBanner: document.getElementById("blueprintCostBanner"),
  blueprintCostLabel: document.getElementById("blueprintCostLabel"),
  blueprintCostStatus: document.getElementById("blueprintCostStatus"),
  blueprintCostBreakdown: document.getElementById("blueprintCostBreakdown"),
  roomLabel: document.getElementById("roomLabel"),
  fleetLabel: document.getElementById("fleetLabel"),
  relayLabel: document.getElementById("relayLabel"),
  moneyHud: document.getElementById("moneyHudLabel"),
  incomeHud: document.getElementById("incomeHudLabel"),
  heatHud: document.getElementById("heatHud"),
  heatHudFill: document.getElementById("heatHudFill"),
  heatHudLabel: document.getElementById("heatHudLabel"),
  selectionLabel: document.getElementById("selectionLabel"),
  objectiveLabel: document.getElementById("objectiveLabel"),
  purchaseBar: document.getElementById("purchaseBar"),
  purchaseQuantityOne: document.getElementById("purchaseQuantityOne"),
  purchaseQuantityFive: document.getElementById("purchaseQuantityFive"),
  purchaseOptions: document.getElementById("purchaseOptions"),
  loadoutTabs: document.getElementById("loadoutTabs"),
  loadoutManagerTabs: document.getElementById("loadoutManagerTabs"),
  loadoutManagerEditor: document.getElementById("loadoutManagerEditor"),
  purchaseTooltip: document.getElementById("purchaseTooltip"),
  statTooltip: document.getElementById("statTooltip"),
  scoreList: document.getElementById("scoreList"),
  eventLog: document.getElementById("eventLog"),
  toastStack: document.getElementById("toastStack"),
  matchProgressFill: document.getElementById("matchProgressFill"),
  matchSummary: document.getElementById("matchSummary"),
  selectionPanel: document.getElementById("selectionPanel"),
  selectionPanelCount: document.getElementById("selectionPanelCount"),
  combatStyleControls: document.getElementById("combatStyleControls"),
  shipDamagePanel: document.getElementById("shipDamagePanel"),
  shipHeatSummary: document.getElementById("shipHeatSummary"),
  shipDamageCanvas: document.getElementById("shipDamageCanvas"),
  shipDamageHover: document.getElementById("shipDamageHover"),
  coreStatusLabel: document.getElementById("coreStatusLabel"),
  damageFeed: document.getElementById("damageFeed"),
  damageViewToggle: document.getElementById("damageViewToggle"),
  shipDamageTab: document.getElementById("shipDamageTab"),
  shipHeatTab: document.getElementById("shipHeatTab"),
  damageLegend: document.getElementById("damageLegend"),
  heatLegend: document.getElementById("heatLegend"),
  latency: document.getElementById("latencyText"),
  marker: document.getElementById("commandMarker"),
  winner: document.getElementById("winnerBanner"),
  endGameScreen: document.getElementById("endGameScreen"),
  minimizeEndGameButton: document.getElementById("minimizeEndGameButton"),
  showEndGameButton: document.getElementById("showEndGameButton"),
  endGameTitle: document.getElementById("endGameTitle"),
  endGameSummary: document.getElementById("endGameSummary"),
  endGameActions: document.getElementById("endGameActions"),
  restartButton: document.getElementById("restartButton"),
  returnToLobbyButton: document.getElementById("returnToLobbyButton"),
  endCloseButton: document.getElementById("endCloseButton"),
  endLeaveButton: document.getElementById("endLeaveButton"),
  mainMenuScreen: document.getElementById("mainMenuScreen"),
  lobbyManagementScreen: document.getElementById("lobbyManagementScreen"),
  settingsScreen: document.getElementById("settingsScreen"),
  renderQualitySelect: document.getElementById("renderQualitySelect"),
  debugOverlayToggle: document.getElementById("debugOverlayToggle"),
  combatEffectsToggle: document.getElementById("combatEffectsToggle"),
  mobileTestingToggle: document.getElementById("mobileTestingToggle"),
  debugOverlay: document.getElementById("debugOverlay"),
  mainMenuButton: document.getElementById("mainMenuButton"),
  lobbyManagementButton: document.getElementById("lobbyManagementButton"),
  settingsButton: document.getElementById("settingsButton"),
  mainMenuCloseButton: document.getElementById("mainMenuCloseButton"),
  lobbyCloseButton: document.getElementById("lobbyCloseButton"),
  settingsCloseButton: document.getElementById("settingsCloseButton"),
  serverUrlInput: document.getElementById("serverUrlInput"),
  saveServerButton: document.getElementById("saveServerButton"),
  clearServerButton: document.getElementById("clearServerButton"),
  confirmModal: document.getElementById("confirmModal"),
  confirmModalTitle: document.getElementById("confirmModalTitle"),
  confirmModalMessage: document.getElementById("confirmModalMessage"),
  confirmCancelButton: document.getElementById("confirmCancelButton"),
  confirmAcceptButton: document.getElementById("confirmAcceptButton")
};

// The 2D context is acquired lazily: the PixiJS backend needs the canvas free
// for a WebGL context, so only the Canvas 2D fallback ever calls acquireArenaCtx().
export let ctx = null;

export function acquireArenaCtx() {
  if (!ctx) ctx = dom.canvas.getContext("2d", { alpha: false });
  return ctx;
}

// Temporarily points the shared ctx at another 2D context so existing draw
// functions can render into offscreen canvases (used for texture baking).
export function withCanvasContext(tempCtx, fn) {
  const previous = ctx;
  ctx = tempCtx;
  try {
    return fn();
  } finally {
    ctx = previous;
  }
}

// Recovery path: if a failed WebGL init claimed the canvas, a fresh element is
// needed before a 2D context can be obtained again.
export function replaceArenaCanvasElement() {
  const fresh = dom.canvas.cloneNode(false);
  dom.canvas.replaceWith(fresh);
  dom.canvas = fresh;
  ctx = null;
  return fresh;
}
