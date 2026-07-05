"use strict";

const PART_DEFS = {
  core: { name: "Core", color: "#f3f7ff", glyph: "radial-gradient(circle, #ffffff 0 28%, #86ddff 31% 58%, #2b5d92 60%)" },
  frame: { name: "Frame", color: "#8393aa", glyph: "linear-gradient(135deg, #5f6e83 0 35%, #b6c1d2 36% 48%, #5f6e83 49%)" },
  armor: { name: "Armor", color: "#ff9a62", glyph: "linear-gradient(160deg, #ffbd79, #bb4d36)" },
  engine: { name: "Engine", color: "#54d7ff", glyph: "linear-gradient(180deg, #68efff, #225ed8 52%, #111827)" },
  reactor: { name: "Reactor", color: "#ffdc5e", glyph: "radial-gradient(circle, #fff7b3 0 20%, #f4c145 26% 55%, #6b4b12 60%)" },
  battery: { name: "Battery", color: "#7ee0ff", glyph: "linear-gradient(180deg, #d5fbff 0 20%, #47caee 22% 50%, #14536f 52%)" },
  shield: { name: "Shield", color: "#7cffa0", glyph: "radial-gradient(circle, #b9ffd0 0 18%, #39cc75 28% 54%, #114027 58%)" },
  blaster: { name: "Blaster", color: "#ff5f7e", glyph: "linear-gradient(90deg, #31131d 0 18%, #ff5f7e 20% 72%, #ffd1dc 73%)" },
  missile: { name: "Missile", color: "#b995ff", glyph: "linear-gradient(90deg, #27183b 0 25%, #b995ff 26% 68%, #f0dcff 69%)" },
  railgun: { name: "Railgun", color: "#f4f7ff", glyph: "linear-gradient(90deg, #1b2230 0 16%, #f4f7ff 18% 72%, #7aa4ff 74%)" },
  repair: { name: "Repair", color: "#67e08a", glyph: "linear-gradient(45deg, #10381f 0 30%, #67e08a 31% 48%, #d7ffe2 49% 58%, #67e08a 59%)" }
};

const SHIP_ECONOMY = Object.freeze({
  baseShipCost: 48,
  partCostMultiplier: 1.32,
  massCostMultiplier: 0.9,
  hullCostMultiplier: 0.012,
  shieldCostMultiplier: 0.05,
  repairCostMultiplier: 0.8,
  largeShipThreshold: 400,
  largeShipCostTax: 0.15,
  hugeShipThreshold: 700,
  hugeShipCostTax: 0.25,
  weaponPremiums: Object.freeze({
    blaster: 18,
    missile: 32,
    railgun: 48
  })
});

const PART_STATS = {
  core: { cost: 0, mass: 8, hp: 150, powerGeneration: 4, powerUse: 0, shield: 25, shieldRegen: 0.4, thrust: 0, turn: 0, energyStorage: 80, repairRate: 0, weapon: null, description: "The command core of the ship. Provides basic hull, small power generation, starter shield, and energy capacity. Every ship needs a core.", bestUse: "Keep it protected near the center of the ship." },
  frame: { cost: 2, mass: 2, hp: 42, powerGeneration: 0, powerUse: 0, shield: 0, shieldRegen: 0, thrust: 0, turn: 0, energyStorage: 0, repairRate: 0, weapon: null, description: "Cheap structure used to expand the ship shape. Light and inexpensive, but provides limited protection.", bestUse: "Use as connective structure and low-cost hull filler." },
  armor: { cost: 9, mass: 8, hp: 135, powerGeneration: 0, powerUse: 0, shield: 0, shieldRegen: 0, thrust: 0, turn: -0.04, energyStorage: 0, repairRate: 0, weapon: null, description: "Heavy passive protection. Adds a lot of hull for low cost, but increases mass and slightly reduces turning.", bestUse: "Protect cores, reactors, and weapons on brawler ships." },
  engine: { cost: 14, mass: 4, hp: 52, powerGeneration: 0, powerUse: 1, shield: 0, shieldRegen: 0, thrust: 135, turn: 0.24, energyStorage: 0, repairRate: 0, weapon: null, description: "Provides thrust and turning. More engines make the ship faster, especially if the ship is light. Engines consume power.", bestUse: "Add more engines when armor or heavy weapons make the ship sluggish." },
  reactor: { cost: 20, mass: 6, hp: 62, powerGeneration: 9, powerUse: 0, shield: 0, shieldRegen: 0, thrust: 0, turn: 0.01, energyStorage: 30, repairRate: 0, explosionRisk: "Medium when destroyed", weapon: null, description: "Main power source. Generates power for weapons, shields, engines, and repair systems. Also adds a small amount of energy storage.", bestUse: "Required for railguns, shields, and large weapon batteries." },
  battery: { cost: 12, mass: 3, hp: 44, powerGeneration: 0, powerUse: 0, shield: 42, shieldRegen: 0.8, thrust: 0, turn: 0, energyStorage: 180, repairRate: 0, weapon: null, description: "Stores energy and adds a small shield buffer. Useful for shield-heavy or burst-power ships, but does not replace a reactor.", bestUse: "Use for energy storage and backup shielding, not as a primary power source." },
  shield: { cost: 18, mass: 5, hp: 48, powerGeneration: 0, powerUse: 3, shield: 115, shieldRegen: 2.4, thrust: 0, turn: -0.01, energyStorage: 0, repairRate: 0, weapon: null, description: "Active defence module. Adds regenerating shield, but consumes constant power. Strong against light sustained damage.", bestUse: "Protect expensive ships that already have enough reactor output." },
  blaster: { cost: 25, mass: 5, hp: 48, powerGeneration: 0, powerUse: 2, shield: 0, shieldRegen: 0, thrust: 0, turn: -0.02, energyStorage: 0, repairRate: 0, blaster: 1, weapon: makeWeapon("blaster", { damage: 14, fireRate: 1.55, range: 520, projectileSpeed: 650, accuracy: 0.88, tracking: 0 }), description: "Reliable medium-range weapon. Best for sustained DPS and close-to-mid range fighting. Cheap and efficient, but has less range than missiles or railguns.", bestUse: "Efficient sustained damage at close and medium range." },
  missile: { cost: 35, mass: 7, hp: 54, powerGeneration: 0, powerUse: 3, shield: 0, shieldRegen: 0, thrust: 0, turn: -0.03, energyStorage: 0, repairRate: 0, missile: 1, weapon: makeWeapon("missile", { damage: 64, fireRate: 0.3, range: 820, projectileSpeed: 330, accuracy: 0.72, tracking: 0.82 }), description: "Long-range tracking burst weapon. Good against fast or evasive ships. Fires slowly and has lower sustained DPS, but each hit is powerful.", bestUse: "Opening volleys, chasing fast ships, and pressuring from long range." },
  railgun: { cost: 45, mass: 9, hp: 58, powerGeneration: 0, powerUse: 6, shield: 0, shieldRegen: 0, thrust: 0, turn: -0.05, energyStorage: 0, repairRate: 0, railgun: 1, weapon: makeWeapon("railgun", { damage: 105, fireRate: 0.19, range: 1100, projectileSpeed: 1080, accuracy: 0.96, tracking: 0 }), description: "Very long-range precision weapon. High damage, fast projectile, and excellent accuracy. Expensive, heavy, and power-hungry with a slow fire rate.", bestUse: "Sniping expensive ships and forcing enemies away from objectives." },
  repair: { cost: 22, mass: 5, hp: 50, powerGeneration: 0, powerUse: 2, shield: 20, shieldRegen: 0.5, thrust: 0, turn: -0.01, energyStorage: 0, repairRate: 10, repair: 1, weapon: null, description: "Repairs damaged hull over time. Best on larger ships with enough power. Provides sustain, but should not fully replace armour or shields.", bestUse: "Escort groups and durable fleets that fight around relays." }
};

const LOCAL_DESIGN_KEY = "modular-fleet-design-v2";
const LOCAL_NAME_KEY = "modular-fleet-name-v1";
const LOCAL_TEAM_KEY = "modular-fleet-team-v1";
const LOCAL_FORMATION_KEY = "modular-fleet-formation-v1";
const LOCAL_SERVER_KEY = "modular-fleet-server-url-v1";
const WORLD_FALLBACK = { width: 3200, height: 1900 };

const dom = {
  canvas: document.getElementById("arenaCanvas"),
  status: document.getElementById("connectionStatus"),
  roomState: document.getElementById("roomStateText"),
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
  botButton: document.getElementById("botButton"),
  adminControls: document.getElementById("adminControls"),
  startDesignButton: document.getElementById("startDesignButton"),
  closeLobbyButton: document.getElementById("closeLobbyButton"),
  playerList: document.getElementById("playerList"),
  deployButton: document.getElementById("deployButton"),
  resetButton: document.getElementById("resetButton"),
  formationSelect: document.getElementById("formationSelect"),
  palette: document.getElementById("partPalette"),
  partInspector: document.getElementById("partInspector"),
  grid: document.getElementById("buildGrid"),
  buildStatus: document.getElementById("buildStatus"),
  stats: document.getElementById("statsGrid"),
  budget: document.getElementById("budgetText"),
  roomLabel: document.getElementById("roomLabel"),
  fleetLabel: document.getElementById("fleetLabel"),
  relayLabel: document.getElementById("relayLabel"),
  moneyHud: document.getElementById("moneyHudLabel"),
  selectionLabel: document.getElementById("selectionLabel"),
  objectiveLabel: document.getElementById("objectiveLabel"),
  moneyLabel: document.getElementById("moneyLabel"),
  incomeLabel: document.getElementById("incomeLabel"),
  unitCostLabel: document.getElementById("unitCostLabel"),
  fleetCapLabel: document.getElementById("fleetCapLabel"),
  buildShipButton: document.getElementById("buildShipButton"),
  buildFiveButton: document.getElementById("buildFiveButton"),
  scoreList: document.getElementById("scoreList"),
  eventLog: document.getElementById("eventLog"),
  toastStack: document.getElementById("toastStack"),
  matchProgressFill: document.getElementById("matchProgressFill"),
  matchSummary: document.getElementById("matchSummary"),
  latency: document.getElementById("latencyText"),
  marker: document.getElementById("commandMarker"),
  winner: document.getElementById("winnerBanner"),
  endGameScreen: document.getElementById("endGameScreen"),
  endGameTitle: document.getElementById("endGameTitle"),
  endGameSummary: document.getElementById("endGameSummary"),
  endGameActions: document.getElementById("endGameActions"),
  restartButton: document.getElementById("restartButton"),
  endCloseButton: document.getElementById("endCloseButton")
};

const ctx = dom.canvas.getContext("2d", { alpha: false });

const state = {
  socket: null,
  myId: null,
  room: "",
  world: { ...WORLD_FALLBACK },
  parts: {},
  design: loadDesign(),
  selectedPart: "frame",
  selectedShipIds: new Set(),
  snapshot: null,
  map: null,
  phase: "offline",
  adminId: null,
  camera: { x: WORLD_FALLBACK.width / 2, y: WORLD_FALLBACK.height / 2, zoom: 0.58, follow: true, manualZoom: null },
  pointer: { x: 0, y: 0 },
  drag: null,
  keys: new Set(),
  stars: makeStars(260),
  minimap: null,
  notices: [],
  lastPingAt: 0,
  lastPongAt: 0,
  latency: null,
  command: null,
  lastFrameAt: performance.now()
};

dom.pilotName.value = localStorage.getItem(LOCAL_NAME_KEY) || `Pilot-${Math.floor(100 + Math.random() * 900)}`;
dom.teamSelect.value = localStorage.getItem(LOCAL_TEAM_KEY) || "blue";
dom.formationSelect.value = localStorage.getItem(LOCAL_FORMATION_KEY) || "line";

renderPalette();
renderPartInspector();
renderBuildGrid();
renderLocalStats();
updateLobbyState();
resizeCanvas();
requestAnimationFrame(frame);

window.addEventListener("resize", resizeCanvas);
window.addEventListener("keydown", handleKeyDown);
window.addEventListener("keyup", (event) => state.keys.delete(event.key.toLowerCase()));

dom.createButton.addEventListener("click", createGame);
dom.joinButton.addEventListener("click", joinExistingGame);
dom.deployButton.addEventListener("click", deployDesign);
dom.buildShipButton.addEventListener("click", () => buyShips(1));
dom.buildFiveButton.addEventListener("click", () => buyShips(5));
dom.resetButton.addEventListener("click", resetDesign);
dom.copyButton.addEventListener("click", copyInvite);
dom.botButton.addEventListener("click", addBot);
dom.startDesignButton.addEventListener("click", startDesign);
dom.closeLobbyButton.addEventListener("click", closeLobby);
dom.restartButton.addEventListener("click", restartMatch);
dom.endCloseButton.addEventListener("click", closeLobby);
dom.formationSelect.addEventListener("change", () => {
  localStorage.setItem(LOCAL_FORMATION_KEY, dom.formationSelect.value);
});
dom.teamSelect.addEventListener("change", () => {
  localStorage.setItem(LOCAL_TEAM_KEY, dom.teamSelect.value);
  send({ type: "setTeam", team: teamValue() });
});
dom.pilotName.addEventListener("change", () => {
  localStorage.setItem(LOCAL_NAME_KEY, dom.pilotName.value.trim());
  send({ type: "setName", name: dom.pilotName.value });
});
dom.roomCode.addEventListener("keydown", (event) => {
  if (event.key === "Enter") joinExistingGame();
});

dom.canvas.addEventListener("pointerdown", handlePointerDown);
dom.canvas.addEventListener("pointermove", handlePointerMove);
dom.canvas.addEventListener("pointerup", handlePointerUp);
dom.canvas.addEventListener("pointercancel", () => {
  state.drag = null;
});
dom.canvas.addEventListener("wheel", handleWheel, { passive: false });
dom.canvas.addEventListener("contextmenu", (event) => event.preventDefault());

setInterval(() => {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) return;
  state.lastPingAt = performance.now();
  send({ type: "ping", at: state.lastPingAt });
}, 2000);

function createGame() {
  dom.roomCode.value = "";
  joinRoom("");
}

function joinExistingGame() {
  const code = dom.roomCode.value.trim().toUpperCase();
  if (!code) {
    addNotice("Enter a game code or click Create", "warning");
    dom.roomCode.focus();
    return;
  }
  joinRoom(code);
}

function joinRoom(roomCode = "") {
  if (state.socket) state.socket.close();
  state.room = "";
  state.snapshot = null;
  state.map = null;
  state.phase = "offline";
  state.adminId = null;
  state.selectedShipIds.clear();
  dom.roomLabel.textContent = "----";
  dom.currentRoomCode.textContent = "----";
  dom.currentRoomCard.hidden = true;

  const socket = new WebSocket(getSocketUrl());
  state.socket = socket;
  setConnectionStatus("connecting", "Connecting");
  updateLobbyState();

  socket.addEventListener("open", () => {
    if (socket !== state.socket) return;
    const name = dom.pilotName.value.trim();
    localStorage.setItem(LOCAL_NAME_KEY, name);
    send({ type: "join", name, team: teamValue(), room: roomCode });
    setConnectionStatus("online", "Dock linked");
    updateLobbyState();
  });

  socket.addEventListener("message", (event) => {
    if (socket !== state.socket) return;
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    handleServerMessage(message);
  });

  socket.addEventListener("close", () => {
    if (socket !== state.socket) return;
    state.phase = "offline";
    setConnectionStatus("offline", "Offline dock");
    updateLobbyState();
  });

  socket.addEventListener("error", () => {
    if (socket !== state.socket) return;
    setConnectionStatus("error", "Link error");
    updateLobbyState();
  });
}

function deployDesign() {
  if (!state.room || !state.socket || state.socket.readyState !== WebSocket.OPEN) {
    addNotice("Create or join a game first", "warning");
    return;
  }
  if (state.phase !== "design") {
    addNotice("Wait for the admin to start ship design", "warning");
    return;
  }
  send({ type: "deploy", design: state.design });
}

function startDesign() {
  send({ type: "startDesign" });
}

function restartMatch() {
  send({ type: "restart" });
}

function closeLobby() {
  send({ type: "closeLobby" });
}

function kickPlayer(targetId) {
  send({ type: "kick", targetId });
}

function addBot() {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
    joinRoom();
    setTimeout(addBot, 260);
    return;
  }
  send({ type: "addBot" });
}

function buyShips(count) {
  if (!state.room || !state.socket || state.socket.readyState !== WebSocket.OPEN) {
    addNotice("Create or join a game first", "warning");
    return;
  }
  if (state.phase !== "active") {
    addNotice("Build ships after the match starts", "warning");
    return;
  }
  send({ type: "buyShip", count });
}

function send(message) {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) return;
  state.socket.send(JSON.stringify(message));
}

function setConnectionStatus(status, text) {
  dom.status.textContent = text;
  dom.status.className = `connection-status ${status}`;
}

function updateLobbyState() {
  const connected = state.socket?.readyState === WebSocket.OPEN && Boolean(state.room);
  const connecting = state.socket?.readyState === WebSocket.CONNECTING;
  const playerCount = state.snapshot?.players?.length || 0;
  const phase = state.snapshot?.phase || state.phase;
  const admin = isAdmin();
  dom.roomState.textContent = connected ? `${phaseLabel(phase)} | ${playerCount} in room` : connecting ? "Connecting" : "Not joined";
  dom.createButton.disabled = connecting;
  dom.joinButton.disabled = connecting;
  dom.copyButton.disabled = !state.room;
  dom.botButton.disabled = !connected || !admin || phase !== "lobby";
  dom.teamSelect.disabled = connected && phase !== "lobby";
  dom.adminControls.hidden = !connected || !admin || phase === "active";
  dom.startDesignButton.disabled = !connected || !admin || phase !== "lobby" || playerCount === 0;
  dom.closeLobbyButton.disabled = !connected || !admin || phase === "active";
  dom.currentRoomCard.hidden = !state.room;
  dom.currentRoomCode.textContent = state.room || "----";
  updatePhaseSteps(phase);
  updatePhaseDetail(phase);
  renderPlayerList();
}

function phaseLabel(phase) {
  if (phase === "lobby") return "Lobby";
  if (phase === "design") return "Ship design";
  if (phase === "active") return "Battle";
  if (phase === "ended") return "Ended";
  return "Offline";
}

function updatePhaseSteps(phase) {
  const order = ["lobby", "design", "active", "ended"];
  const current = Math.max(0, order.indexOf(phase));
  const entries = [
    [dom.stepLobby, "lobby"],
    [dom.stepDesign, "design"],
    [dom.stepBattle, "active"],
    [dom.stepEnd, "ended"]
  ];
  for (const [element, key] of entries) {
    const index = order.indexOf(key);
    element.className = index === current ? "active" : index < current ? "done" : "";
  }
}

function updatePhaseDetail(phase) {
  const players = state.snapshot?.players || [];
  const ready = players.filter((player) => player.ready).length;
  const mapName = state.snapshot?.map?.name;
  const size = state.snapshot?.mapSizeLabel;
  if (!state.room) {
    dom.phaseDetail.textContent = "Create or join a room to begin.";
  } else if (phase === "lobby") {
    dom.phaseDetail.textContent = isAdmin()
      ? `Waiting room. Add bots, share the code, then start ship design. Map size will use ${players.length || 1} player${players.length === 1 ? "" : "s"}.`
      : "Waiting for the room admin to start ship design.";
  } else if (phase === "design") {
    dom.phaseDetail.textContent = `${ready}/${players.length} ready. Edit your ship, then press Ready. ${size || "Map"}: ${mapName || "generated map"}.`;
  } else if (phase === "active") {
    dom.phaseDetail.textContent = `${size || "Map"}: ${mapName || "generated map"}. Capture relays, build ships, and fight.`;
  } else if (phase === "ended") {
    dom.phaseDetail.textContent = isAdmin() ? "Match ended. Choose Restart or Close lobby." : "Match ended. Waiting for the admin.";
  }
}

function handleServerMessage(message) {
  if (message.type === "hello") {
    state.myId = message.id;
    state.parts = message.parts || {};
    state.world = message.world || { ...WORLD_FALLBACK };
    if (!localStorage.getItem(LOCAL_DESIGN_KEY)) {
      state.design = normalizeDesign(message.defaultDesign || state.design);
      renderBuildGrid();
      renderLocalStats();
    }
    return;
  }

  if (message.type === "joined") {
    state.myId = message.id;
    state.room = message.room;
    state.world = message.world || state.world;
    state.map = message.map || state.map;
    state.phase = message.phase || "lobby";
    state.adminId = message.adminId || null;
    state.selectedShipIds.clear();
    dom.roomCode.value = message.room;
    dom.currentRoomCode.textContent = message.room;
    dom.currentRoomCard.hidden = false;
    dom.roomLabel.textContent = message.room;
    setConnectionStatus("online", "Room linked");
    updateLobbyState();
    return;
  }

  if (message.type === "state") {
    state.snapshot = message;
    state.room = message.room;
    state.world = message.world || state.world;
    state.map = message.map || state.map;
    state.phase = message.phase || state.phase;
    state.adminId = message.adminId || state.adminId;
    dom.roomLabel.textContent = message.room;
    pruneSelection();
    updateHud();
    renderScoreboard();
    updateEconomyUi();
    updateLobbyState();
    updateWinnerBanner();
    return;
  }

  if (message.type === "pong") {
    if (message.at) {
      state.latency = performance.now() - message.at;
      state.lastPongAt = performance.now();
    }
    return;
  }

  if (message.type === "notice") {
    addNotice(message.message, "good");
    return;
  }

  if (message.type === "error") {
    addNotice(message.message || "Server error", "error");
    return;
  }

  if (message.type === "kicked" || message.type === "closed") {
    addNotice(message.message || "Room closed", "error");
    state.room = "";
    state.snapshot = null;
    state.phase = "offline";
    state.selectedShipIds.clear();
    updateLobbyState();
  }
}

function renderPalette() {
  dom.palette.textContent = "";
  for (const type of Object.keys(PART_DEFS)) {
    if (type === "core") continue;
    const stat = PART_STATS[type];
    const button = document.createElement("button");
    button.type = "button";
    button.className = `part-button${state.selectedPart === type ? " active" : ""}`;
    button.title = `${PART_DEFS[type].name} | cost ${stat.cost} | mass ${stat.mass}`;
    button.innerHTML = `${partIconMarkup(type)}<span class="part-name">${PART_DEFS[type].name}</span>`;
    button.addEventListener("click", () => {
      state.selectedPart = type;
      renderPalette();
      renderPartInspector();
    });
    dom.palette.appendChild(button);
  }
}

function renderPartInspector() {
  const type = state.selectedPart;
  const def = PART_DEFS[type] || PART_DEFS.frame;
  const stat = PART_STATS[type] || PART_STATS.frame;
  const details = [
    ...partInspectorDetails(type, stat),
    ["Cost impact", estimatePartCostImpact(type)]
  ];
  dom.partInspector.innerHTML = `
    <div class="part-inspector-title">
      ${partIconMarkup(type, "inspector-glyph")}
      <strong>${escapeHtml(def.name)}</strong>
    </div>
    <p class="part-description">${escapeHtml(stat.description || "")}</p>
    <div class="part-inspector-grid">
      ${inspectorStat("Cost", stat.cost)}
      ${inspectorStat("Mass", stat.mass)}
      ${inspectorStat("Hull", stat.hp)}
      ${inspectorStat("Power", partPowerText(stat))}
      ${inspectorStat("Shield", stat.shield)}
      ${inspectorStat("Thrust", stat.thrust)}
      ${inspectorStat("Storage", stat.energyStorage)}
      ${inspectorStat("Repair", stat.repairRate)}
    </div>
    <div class="part-detail-list">
      ${details.map(([label, value]) => inspectorDetail(label, value)).join("")}
    </div>
    <div class="part-best-use"><span>Best use</span>${escapeHtml(stat.bestUse || "Flexible ship system.")}</div>
  `;
}

function inspectorStat(label, value) {
  return `<div><span>${label}</span><strong>${value}</strong></div>`;
}

function inspectorDetail(label, value) {
  return `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function partPowerText(stat) {
  const generation = stat.powerGeneration || 0;
  const use = stat.powerUse || 0;
  if (generation && use) return `+${generation} / -${use}`;
  if (generation) return `+${generation}`;
  if (use) return `-${use}`;
  return "0";
}

function partInspectorDetails(type, stat) {
  if (stat.weapon) {
    const weapon = stat.weapon;
    return [
      ["Damage", weapon.damage],
      ["Range", `${weapon.range} units`],
      ["Fire rate", `${weapon.fireRate} shots/s`],
      ["Reload", `${weapon.reload}s`],
      ["DPS", weapon.dps.toFixed(1)],
      ["Projectile speed", weapon.projectileSpeed],
      ["Accuracy", `${Math.round(weapon.accuracy * 100)}%`],
      ["Tracking", weapon.tracking ? `${Math.round(weapon.tracking * 100)}%` : "None"],
      ["Power use", stat.powerUse]
    ];
  }

  if (type === "engine") {
    return [
      ["Thrust", stat.thrust],
      ["Mass", stat.mass],
      ["Speed contribution", "Total thrust / total mass"],
      ["Power use", stat.powerUse]
    ];
  }

  if (type === "reactor") {
    return [
      ["Power generation", `+${stat.powerGeneration}`],
      ["Energy storage", stat.energyStorage],
      ["Explosion risk", stat.explosionRisk || "Not implemented"],
      ["Mass", stat.mass]
    ];
  }

  if (type === "battery") {
    return [
      ["Energy storage", stat.energyStorage],
      ["Shield", stat.shield],
      ["Recharge", `${stat.shieldRegen}/s`],
      ["Power generation", stat.powerGeneration]
    ];
  }

  if (type === "shield") {
    return [
      ["Shield amount", stat.shield],
      ["Recharge rate", `${stat.shieldRegen}/s`],
      ["Power draw", stat.powerUse],
      ["Mass", stat.mass]
    ];
  }

  if (type === "repair") {
    return [
      ["Repair rate", `${stat.repairRate}/s`],
      ["Power use", stat.powerUse],
      ["Shield", stat.shield],
      ["Mass", stat.mass]
    ];
  }

  return [
    ["Hull", stat.hp],
    ["Mass", stat.mass],
    ["Cost", stat.cost],
    ["Power", partPowerText(stat)]
  ];
}

function estimatePartCostImpact(type) {
  const current = computeStats(state.design);
  const occupied = new Set(state.design.map((part) => `${part.x},${part.y}`));
  for (const part of state.design) {
    const candidates = [
      { x: part.x + 1, y: part.y },
      { x: part.x - 1, y: part.y },
      { x: part.x, y: part.y + 1 },
      { x: part.x, y: part.y - 1 }
    ];
    for (const cell of candidates) {
      const key = `${cell.x},${cell.y}`;
      if (cell.x < 0 || cell.x > 6 || cell.y < 0 || cell.y > 6 || occupied.has(key)) continue;
      const next = [...state.design, { x: cell.x, y: cell.y, type }];
      if (!isConnected(next)) continue;
      const updated = computeStats(next);
      return `+$${updated.unitCost - current.unitCost} final cost`;
    }
  }
  return "No open connected cell";
}

function partIconMarkup(type, extraClass = "") {
  const safeType = String(type || "frame").replace(/[^a-z0-9_-]/gi, "").toLowerCase();
  const classes = ["part-glyph", `part-${safeType}`, extraClass].filter(Boolean).join(" ");
  return `<span class="${classes}" aria-hidden="true"><span></span></span>`;
}

function makeWeapon(type, stats) {
  const fireRate = Number(stats.fireRate) || 1;
  const damage = Number(stats.damage) || 0;
  return {
    type,
    damage,
    fireRate,
    reload: Number((1 / fireRate).toFixed(2)),
    range: stats.range,
    projectileSpeed: stats.projectileSpeed,
    accuracy: stats.accuracy,
    tracking: stats.tracking || 0,
    dps: Number((damage * fireRate).toFixed(1))
  };
}

function renderBuildGrid() {
  dom.grid.textContent = "";
  const byCell = new Map(state.design.map((part) => [`${part.x},${part.y}`, part]));

  for (let y = 0; y < 7; y += 1) {
    for (let x = 0; x < 7; x += 1) {
      const part = byCell.get(`${x},${y}`);
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = `build-cell${part ? ` occupied ${part.type}` : ""}`;
      cell.title = part ? PART_DEFS[part.type].name : "Empty";
      if (part) cell.innerHTML = partIconMarkup(part.type, "build-glyph");
      cell.addEventListener("click", () => editCell(x, y));
      cell.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        removeCell(x, y);
      });
      dom.grid.appendChild(cell);
    }
  }
}

function editCell(x, y) {
  const existing = state.design.find((part) => part.x === x && part.y === y);
  if (existing?.type === "core") return;

  if (existing) {
    const next = state.design.map((part) => part.x === x && part.y === y ? { x, y, type: state.selectedPart } : part);
    if (isConnected(next)) {
      state.design = next;
    } else {
      const message = explainConnectionProblem(next, x, y, true);
      setBuildStatus(message, "warning");
      showToast(message, "warning");
      return;
    }
  } else {
    const next = [...state.design, { x, y, type: state.selectedPart }];
    if (isConnected(next)) {
      state.design = next;
    } else {
      const message = explainConnectionProblem(next, x, y, false);
      setBuildStatus(message, "warning");
      showToast(message, "warning");
      return;
    }
  }

  persistDesign();
  renderBuildGrid();
  renderLocalStats();
}

function removeCell(x, y) {
  const existing = state.design.find((part) => part.x === x && part.y === y);
  if (!existing || existing.type === "core") return;
  const next = state.design.filter((part) => part.x !== x || part.y !== y);
  if (isConnected(next)) {
    state.design = next;
    persistDesign();
    renderBuildGrid();
    renderLocalStats();
  } else {
    const message = "Removing that part would disconnect modules from the core";
    setBuildStatus(message, "warning");
    showToast(message, "warning");
  }
}

function resetDesign() {
  state.design = defaultDesign();
  persistDesign();
  renderBuildGrid();
  renderLocalStats();
}

function renderLocalStats() {
  const stats = computeStats(state.design);
  dom.budget.textContent = `Parts $${stats.cost}`;
  dom.stats.innerHTML = [
    statMarkup("Fleet", stats.fleetCount),
    statMarkup("Hull", stats.maxHp),
    statMarkup("Shield", stats.maxShield),
    statMarkup("Speed", Math.round(stats.maxSpeed)),
    statMarkup("Power", `${stats.powerGeneration}/${stats.powerUse}`),
    statMarkup("Final Cost", `$${stats.unitCost}`),
    statMarkup("Thrust/Mass", stats.thrustRatio),
    statMarkup("Weapons", `${stats.blaster}/${stats.missile}/${stats.railgun}`),
    statMarkup("Repair", stats.repairRate),
    statMarkup("Mass", stats.mass),
    costBreakdownMarkup(stats.costBreakdown)
  ].join("");

  setBuildStatus(stats.warnings.length ? stats.warnings.join(" | ") : "Blueprint ready", stats.warnings.length ? "warning" : "good");
  updateEconomyUi();
}

function setBuildStatus(text, className) {
  dom.buildStatus.textContent = text;
  dom.buildStatus.className = `build-status ${className || ""}`.trim();
}

function statMarkup(label, value) {
  return `<div class="stat"><span>${label}</span><strong>${value}</strong></div>`;
}

function costBreakdownMarkup(breakdown) {
  if (!breakdown) return "";
  return `
    <div class="stat cost-breakdown">
      <span>Cost Breakdown</span>
      <strong>$${breakdown.total}</strong>
      <small>Base $${breakdown.base} | Parts $${breakdown.parts} | Mass $${breakdown.mass} | Hull $${breakdown.hull} | Shield $${breakdown.shield} | Repair $${breakdown.repair} | Weapons $${breakdown.weaponPremium} | Size tax $${breakdown.sizeTax}</small>
    </div>
  `;
}

function updateHud() {
  if (!state.snapshot) return;
  const mine = state.snapshot.players.find((player) => player.id === state.myId);
  const myShips = state.snapshot.ships.filter((ship) => ship.ownerId === state.myId && ship.alive);
  const myTeam = mine?.team;
  const relays = state.snapshot.points.filter((point) => point.ownerTeam === myTeam && point.progress > 0.98).length;
  const target = currentTarget();
  dom.fleetLabel.textContent = `${myShips.length}/${mine?.shipCap || 0}`;
  dom.moneyHud.textContent = `$${mine?.money ?? 0}`;
  dom.relayLabel.textContent = String(relays);
  dom.selectionLabel.textContent = `${state.selectedShipIds.size}`;
  dom.objectiveLabel.textContent = target ? target.label : "None";
  dom.latency.textContent = state.latency == null ? "-- ms" : `${Math.round(state.latency)} ms`;
}

function updateEconomyUi() {
  const mine = state.snapshot?.players?.find((player) => player.id === state.myId);
  const localStats = computeStats(state.design);
  const money = mine?.money ?? 0;
  const income = mine?.income ?? 0;
  const unitCost = mine?.stats?.unitCost ?? localStats.unitCost;
  const activeShips = mine?.activeShips ?? 0;
  const shipCap = mine?.shipCap ?? 0;
  const myTeam = mine?.team;
  const relays = state.snapshot?.points?.filter((point) => point.ownerTeam === myTeam && point.progress > 0.98).length || 0;
  const activeFleetCost = mine?.activeFleetCost ?? 0;
  const deploymentBudget = mine?.deploymentBudget ?? 0;
  const budgetRemaining = deploymentBudget ? deploymentBudget - activeFleetCost : Infinity;
  const canAfford = money >= unitCost;
  const withinDeploymentBudget = unitCost <= budgetRemaining;
  const canBuild = state.phase === "active" && Boolean(mine?.ready) && canAfford && withinDeploymentBudget && activeShips < shipCap;
  const canBuildFive = state.phase === "active" && Boolean(mine?.ready) && canAfford && withinDeploymentBudget && activeShips < shipCap;
  const canReady = state.phase === "design" && !mine?.ready;

  dom.moneyLabel.textContent = `$${Math.floor(money)}`;
  dom.incomeLabel.textContent = `+$${Math.round(income)}/s`;
  dom.incomeLabel.title = mine?.ready
    ? `Base income plus ${relays} captured relay${relays === 1 ? "" : "s"}. Money rises every second.`
    : "Save a blueprint to begin earning money.";
  dom.unitCostLabel.textContent = `$${unitCost}`;
  dom.unitCostLabel.title = canAfford ? "Can afford this ship" : `Need $${unitCost - money} more`;
  dom.fleetCapLabel.textContent = deploymentBudget ? `$${activeFleetCost}/$${deploymentBudget}` : `${activeShips}/${shipCap || "-"}`;
  dom.fleetCapLabel.title = deploymentBudget ? `Deployment budget remaining: $${Math.max(0, budgetRemaining)}` : "Active ships / fleet cap";
  dom.buildShipButton.disabled = !canBuild;
  dom.buildFiveButton.disabled = !canBuildFive;
  dom.deployButton.disabled = !canReady;
  dom.deployButton.textContent = mine?.ready && state.phase === "design" ? "Ready" : state.phase === "design" ? "Ready ship" : "Save blueprint";

  if (mine) {
    const status = state.phase === "design"
      ? mine.ready ? "Ready. Waiting for the rest of the room." : "Design your ship, then press Ready ship."
      : mine.ready
        ? economyStatusText({ income, relays, canAfford, withinDeploymentBudget, unitCost, money, budgetRemaining })
        : "Waiting for ship design";
    if (!dom.buildStatus.className.includes("warning")) setBuildStatus(status, "good");
  }
}

function economyStatusText({ income, relays, canAfford, withinDeploymentBudget, unitCost, money, budgetRemaining }) {
  if (!canAfford) return `Cannot afford this ship. Need $${Math.ceil(unitCost - money)} more.`;
  if (!withinDeploymentBudget) return `Fleet exceeds deployment budget by $${Math.ceil(unitCost - budgetRemaining)}.`;
  return `Can afford this ship. Earning +$${Math.round(income)}/s: base income${relays ? ` + ${relays} relay bonus` : ""}`;
}

function currentTarget() {
  if (!state.command) return null;
  if (state.command.targetName) return { label: state.command.targetName };
  return { label: `${Math.round(state.command.x)},${Math.round(state.command.y)}` };
}

function renderScoreboard() {
  if (!state.snapshot) return;
  const players = [...state.snapshot.players].sort((a, b) => b.score - a.score);
  dom.scoreList.textContent = "";
  updateMatchMeter(players);

  for (const player of players) {
    const row = document.createElement("div");
    row.className = `score-row${player.id === state.myId ? " mine" : ""}`;
    row.innerHTML = `
      <span class="score-color" style="background:${player.color}"></span>
      <div>
        <div class="score-name">${escapeHtml(player.name)}${player.id === state.myId ? " *" : ""}${player.isBot ? " CPU" : ""}</div>
        <div class="score-meta">${escapeHtml(player.teamName || "Solo")} | $${player.money} +${Math.round(player.income)}/s | K ${player.kills} / L ${player.losses}</div>
      </div>
      <div class="score-value">${player.score}</div>
    `;
    dom.scoreList.appendChild(row);
  }
}

function renderPlayerList() {
  if (!dom.playerList) return;
  const players = state.snapshot?.players || [];
  dom.playerList.textContent = "";
  if (!players.length) return;

  for (const player of players) {
    const row = document.createElement("div");
    row.className = `player-row${player.id === state.myId ? " mine" : ""}`;
    const canKick = isAdmin() && player.id !== state.myId && state.phase !== "active";
    const status = player.isAdmin ? "Admin" : player.ready ? "Ready" : state.phase === "design" ? "Designing" : player.isBot ? "Bot" : "Waiting";
    row.innerHTML = `
      <span class="score-color" style="background:${player.color}"></span>
      <div>
        <strong>${escapeHtml(player.name)}${player.id === state.myId ? " (you)" : ""}</strong>
        <span>${escapeHtml(player.teamName || "Solo")} | ${status}</span>
      </div>
      ${canKick ? `<button type="button" data-kick="${escapeHtml(player.id)}">Kick</button>` : ""}
    `;
    const kickButton = row.querySelector?.("[data-kick]");
    if (kickButton) {
      kickButton.addEventListener("click", () => kickPlayer(player.id));
    }
    dom.playerList.appendChild(row);
  }
}

function updateMatchMeter(players) {
  if (!players.length) {
    dom.matchProgressFill.style.width = "0%";
    dom.matchSummary.textContent = "No active match";
    return;
  }

  const maxScore = state.snapshot.maxScore || 900;
  const leader = players[0];
  const progress = clamp(leader.score / maxScore * 100, 0, 100);
  const mapName = state.snapshot.map?.name ? `${state.snapshot.map.name} | ` : "";
  dom.matchProgressFill.style.width = `${progress}%`;
  dom.matchSummary.textContent = `${mapName}${leader.name} leads ${leader.score}/${maxScore}`;
}

function updateWinnerBanner() {
  const winner = state.snapshot?.winner;
  if (!winner || state.phase !== "ended") {
    dom.winner.hidden = true;
    dom.endGameScreen.hidden = true;
    return;
  }
  dom.winner.hidden = false;
  dom.winner.textContent = `${winner.name} won`;
  dom.endGameScreen.hidden = false;
  dom.endGameTitle.textContent = `${winner.name} won`;
  const mine = state.snapshot?.players?.find((player) => player.id === state.myId);
  dom.endGameSummary.innerHTML = rewardSummaryMarkup(mine?.lastReward, mine?.money);
  dom.endGameActions.hidden = !isAdmin();
}

function rewardSummaryMarkup(reward, money) {
  if (!reward) {
    return escapeHtml(isAdmin()
      ? "Restart sends everyone back to ship design with a new generated map."
      : "Waiting for the room admin to restart or close the lobby.");
  }
  const title = reward.didWin ? "Battle Result: Victory" : "Battle Result: Defeat";
  const lines = reward.didWin
    ? [
        ["Base reward", reward.base],
        ["Enemy destroyed", reward.destroyed],
        ["Victory bonus", reward.victory],
        ["Survival bonus", reward.survival],
        ["Efficiency bonus", reward.efficiency]
      ]
    : [
        ["Loss support", reward.lossSupport],
        ["Enemy destroyed", reward.destroyed]
      ];
  const penalty = reward.didWin && reward.overpowerMultiplier < 1
    ? `<li>Overpowered fleet penalty applied: ${Math.round(reward.overpowerMultiplier * 100)}% victory bonus</li>`
    : "";
  return `
    <span>${escapeHtml(title)}</span>
    <ul class="reward-list">
      ${lines.map(([label, value]) => `<li>${escapeHtml(label)}: $${Math.round(value || 0)}</li>`).join("")}
      ${penalty}
      <li><strong>Total earned: $${Math.round(reward.total || 0)}</strong></li>
      <li>New balance: $${Math.floor(money || 0)}</li>
    </ul>
  `;
}

function addNotice(text, tone = "") {
  const clean = String(text || "").slice(0, 90);
  state.notices.unshift({ text: clean, tone, at: performance.now() });
  state.notices = state.notices.slice(0, 7);
  dom.eventLog.textContent = "";
  for (const notice of state.notices) {
    const line = document.createElement("div");
    line.textContent = notice.text;
    dom.eventLog.appendChild(line);
  }
  showToast(clean, tone);
}

function showToast(text, tone = "") {
  if (!dom.toastStack) return;
  const toast = document.createElement("div");
  toast.className = `toast ${tone || ""}`.trim();
  toast.textContent = text;
  dom.toastStack.prepend(toast);

  while (dom.toastStack.children.length > 4) {
    dom.toastStack.lastElementChild.remove();
  }

  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateY(-6px)";
  }, 2600);
  setTimeout(() => toast.remove(), 3200);
}

function copyInvite() {
  const url = new URL(location.href);
  if (state.room) url.searchParams.set("room", state.room);
  const configuredServer = getConfiguredServerUrl();
  if (configuredServer) url.searchParams.set("server", configuredServer);
  const text = state.room ? `${url.toString()}  Room: ${state.room}` : url.toString();
  if (!navigator.clipboard?.writeText) {
    addNotice("Clipboard unavailable", "warning");
    return;
  }
  navigator.clipboard.writeText(text).then(
    () => addNotice("Invite copied", "good"),
    () => addNotice("Clipboard unavailable", "warning")
  );
}

function getSocketUrl() {
  const configured = getConfiguredServerUrl();
  if (configured) return normalizeSocketUrl(configured);
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/socket`;
}

function getConfiguredServerUrl() {
  const params = new URLSearchParams(location.search);
  const fromUrl = params.get("server");
  if (fromUrl) {
    localStorage.setItem(LOCAL_SERVER_KEY, fromUrl);
    return fromUrl;
  }
  return localStorage.getItem(LOCAL_SERVER_KEY) || "";
}

function normalizeSocketUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol === "http:") url.protocol = "ws:";
    if (url.protocol === "https:") url.protocol = "wss:";
    if (!url.pathname || url.pathname === "/") url.pathname = "/socket";
    return url.toString();
  } catch {
    return value;
  }
}

function handlePointerDown(event) {
  if (!state.snapshot) return;
  dom.canvas.setPointerCapture(event.pointerId);
  state.pointer = { x: event.clientX, y: event.clientY };

  if (event.button === 2) {
    event.preventDefault();
    issueCommand(event);
    return;
  }

  if (event.button !== 0) return;

  const mini = minimapWorldAt(event.clientX, event.clientY);
  if (mini) {
    state.camera.x = mini.x;
    state.camera.y = mini.y;
    state.camera.follow = false;
    return;
  }

  state.drag = {
    pointerId: event.pointerId,
    startClientX: event.clientX,
    startClientY: event.clientY,
    currentClientX: event.clientX,
    currentClientY: event.clientY,
    startWorld: screenToWorld(event.clientX, event.clientY),
    currentWorld: screenToWorld(event.clientX, event.clientY),
    shift: event.shiftKey
  };
}

function handlePointerMove(event) {
  state.pointer = { x: event.clientX, y: event.clientY };
  if (!state.drag || state.drag.pointerId !== event.pointerId) return;
  state.drag.currentClientX = event.clientX;
  state.drag.currentClientY = event.clientY;
  state.drag.currentWorld = screenToWorld(event.clientX, event.clientY);
}

function handlePointerUp(event) {
  if (!state.drag || state.drag.pointerId !== event.pointerId) return;
  const drag = state.drag;
  state.drag = null;

  const distance = Math.hypot(event.clientX - drag.startClientX, event.clientY - drag.startClientY);
  if (distance < 6) {
    selectAt(drag.currentWorld, drag.shift);
  } else {
    selectBox(drag.startWorld, drag.currentWorld, drag.shift);
  }
  updateHud();
}

function handleWheel(event) {
  event.preventDefault();
  const before = screenToWorld(event.clientX, event.clientY);
  const factor = event.deltaY > 0 ? 0.9 : 1.1;
  state.camera.manualZoom = clamp((state.camera.manualZoom || state.camera.zoom) * factor, 0.32, 1.45);
  state.camera.zoom = state.camera.manualZoom;
  const after = screenToWorld(event.clientX, event.clientY);
  state.camera.x += before.x - after.x;
  state.camera.y += before.y - after.y;
  state.camera.follow = false;
}

function handleKeyDown(event) {
  const tag = document.activeElement?.tagName;
  if (tag === "INPUT" || tag === "SELECT" || tag === "BUTTON") return;
  const key = event.key.toLowerCase();
  state.keys.add(key);

  if (key === "q") {
    event.preventDefault();
    selectAllOwnShips();
  } else if (key === "f") {
    event.preventDefault();
    state.camera.follow = true;
  } else if (key === "escape") {
    state.selectedShipIds.clear();
    updateHud();
  }
}

function issueCommand(event) {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) return;
  if (state.phase !== "active") return;
  const mini = minimapWorldAt(event.clientX, event.clientY);
  const world = mini || screenToWorld(event.clientX, event.clientY);
  const targetShip = findShipAt(world.x, world.y, (ship) => ship.ownerId !== state.myId && ship.alive);
  const targetPlayer = targetShip ? playerMap().get(targetShip.ownerId) : null;
  const shipIds = selectedShipIdsForCommand();

  state.command = {
    x: targetShip?.x || world.x,
    y: targetShip?.y || world.y,
    targetName: targetPlayer?.name || null,
    at: performance.now()
  };

  send({
    type: "command",
    x: targetShip?.x || world.x,
    y: targetShip?.y || world.y,
    targetId: targetShip?.id || null,
    shipIds,
    formation: dom.formationSelect.value
  });
  showCommandMarker(event.clientX, event.clientY);
}

function selectedShipIdsForCommand() {
  pruneSelection();
  if (state.selectedShipIds.size > 0) return [...state.selectedShipIds];
  return ownLiveShips().map((ship) => ship.id);
}

function selectAt(world, additive) {
  const ship = findShipAt(world.x, world.y, (candidate) => candidate.ownerId === state.myId && candidate.alive);
  if (!additive) state.selectedShipIds.clear();
  if (ship) {
    if (state.selectedShipIds.has(ship.id) && additive) state.selectedShipIds.delete(ship.id);
    else state.selectedShipIds.add(ship.id);
    state.camera.follow = true;
  }
}

function selectBox(a, b, additive) {
  if (!additive) state.selectedShipIds.clear();
  const minX = Math.min(a.x, b.x);
  const maxX = Math.max(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const maxY = Math.max(a.y, b.y);
  for (const ship of ownLiveShips()) {
    if (ship.x >= minX && ship.x <= maxX && ship.y >= minY && ship.y <= maxY) {
      state.selectedShipIds.add(ship.id);
    }
  }
  if (state.selectedShipIds.size > 0) state.camera.follow = true;
}

function selectAllOwnShips() {
  state.selectedShipIds = new Set(ownLiveShips().map((ship) => ship.id));
  updateHud();
}

function pruneSelection() {
  const live = new Set(ownLiveShips().map((ship) => ship.id));
  for (const id of [...state.selectedShipIds]) {
    if (!live.has(id)) state.selectedShipIds.delete(id);
  }
}

function ownLiveShips() {
  return state.snapshot?.ships?.filter((ship) => ship.ownerId === state.myId && ship.alive) || [];
}

function findShipAt(x, y, predicate) {
  const ships = state.snapshot?.ships || [];
  let best = null;
  let bestDistance = Infinity;
  for (const ship of ships) {
    if (!predicate(ship)) continue;
    const distance = Math.hypot(ship.x - x, ship.y - y);
    if (distance <= ship.radius + 14 && distance < bestDistance) {
      best = ship;
      bestDistance = distance;
    }
  }
  return best;
}

function resizeCanvas() {
  const rect = dom.canvas.getBoundingClientRect();
  const ratio = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  dom.canvas.width = Math.max(1, Math.floor(rect.width * ratio));
  dom.canvas.height = Math.max(1, Math.floor(rect.height * ratio));
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
}

function frame(now) {
  const dt = Math.min(0.05, Math.max(0.001, (now - state.lastFrameAt) / 1000));
  state.lastFrameAt = now;
  updateCamera(dt);
  renderArena(now);
  requestAnimationFrame(frame);
}

function updateCamera(dt) {
  const rect = dom.canvas.getBoundingClientRect();
  const fitZoom = clamp(Math.min(rect.width / 1300, rect.height / 820), 0.42, 0.82);
  if (state.camera.manualZoom == null) state.camera.zoom = fitZoom;

  const panSpeed = 760 * dt / state.camera.zoom;
  let moved = false;
  if (state.keys.has("arrowleft") || state.keys.has("a")) {
    state.camera.x -= panSpeed;
    moved = true;
  }
  if (state.keys.has("arrowright") || state.keys.has("d")) {
    state.camera.x += panSpeed;
    moved = true;
  }
  if (state.keys.has("arrowup") || state.keys.has("w")) {
    state.camera.y -= panSpeed;
    moved = true;
  }
  if (state.keys.has("arrowdown") || state.keys.has("s")) {
    state.camera.y += panSpeed;
    moved = true;
  }
  if (moved) state.camera.follow = false;

  if (state.camera.follow) {
    const focusShips = [...state.selectedShipIds].length
      ? (state.snapshot?.ships || []).filter((ship) => state.selectedShipIds.has(ship.id) && ship.alive)
      : ownLiveShips();
    if (focusShips.length) {
      const targetX = focusShips.reduce((sum, ship) => sum + ship.x, 0) / focusShips.length;
      const targetY = focusShips.reduce((sum, ship) => sum + ship.y, 0) / focusShips.length;
      state.camera.x += (targetX - state.camera.x) * 0.055;
      state.camera.y += (targetY - state.camera.y) * 0.055;
    }
  }

  state.camera.x = clamp(state.camera.x, 0, state.world.width);
  state.camera.y = clamp(state.camera.y, 0, state.world.height);
}

function renderArena(now) {
  const rect = dom.canvas.getBoundingClientRect();
  ctx.clearRect(0, 0, rect.width, rect.height);
  drawBackdrop(rect);

  ctx.save();
  applyCamera(rect);
  drawWorldGrid();
  drawMapFeatures(now);
  drawRelays();
  drawCommandTarget(now);
  drawBullets();
  drawShips();
  drawEffects();
  drawSelectionBox();
  ctx.restore();

  drawMinimap(rect);

  if (!state.snapshot) {
    ctx.fillStyle = "rgba(237,244,255,0.72)";
    ctx.font = "700 15px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Join a room to enter the arena", rect.width / 2, rect.height / 2);
  }
}

function drawBackdrop(rect) {
  const gradient = ctx.createLinearGradient(0, 0, rect.width, rect.height);
  gradient.addColorStop(0, "#040710");
  gradient.addColorStop(0.55, "#0a111d");
  gradient.addColorStop(1, "#05070c");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, rect.width, rect.height);

  ctx.save();
  ctx.globalAlpha = 0.88;
  for (const star of state.stars) {
    const x = (star.x * rect.width + state.camera.x * star.drift) % rect.width;
    const y = (star.y * rect.height + state.camera.y * star.drift) % rect.height;
    ctx.fillStyle = star.color;
    ctx.fillRect(x < 0 ? x + rect.width : x, y < 0 ? y + rect.height : y, star.size, star.size);
  }
  ctx.restore();
}

function drawWorldGrid() {
  ctx.save();
  ctx.lineWidth = 1 / state.camera.zoom;
  ctx.strokeStyle = "rgba(130,160,205,0.11)";
  for (let x = 0; x <= state.world.width; x += 160) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, state.world.height);
    ctx.stroke();
  }
  for (let y = 0; y <= state.world.height; y += 160) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(state.world.width, y);
    ctx.stroke();
  }

  ctx.strokeStyle = "rgba(255,255,255,0.22)";
  ctx.lineWidth = 3 / state.camera.zoom;
  ctx.strokeRect(0, 0, state.world.width, state.world.height);
  ctx.restore();
}

function drawMapFeatures(now) {
  const map = currentMap();
  if (!map) return;

  for (const cloud of map.clouds || []) drawNebula(cloud);
  for (const asteroid of map.asteroids || []) drawAsteroid(asteroid, now);
}

function drawNebula(cloud) {
  const rx = cloud.rx || 300;
  const ry = cloud.ry || 180;
  const color = cloud.color || "56,213,255";
  const alpha = cloud.alpha || 0.12;

  ctx.save();
  ctx.translate(cloud.x, cloud.y);
  ctx.rotate(cloud.rotation || 0);
  const gradient = ctx.createRadialGradient(0, 0, Math.min(rx, ry) * 0.1, 0, 0, rx);
  gradient.addColorStop(0, `rgba(${color}, ${alpha})`);
  gradient.addColorStop(0.52, `rgba(${color}, ${alpha * 0.42})`);
  gradient.addColorStop(1, `rgba(${color}, 0)`);
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawAsteroid(asteroid, now) {
  const radius = asteroid.radius || 60;
  const shape = asteroid.shape?.length ? asteroid.shape : [1, 0.92, 1.08, 0.9, 1.12, 0.96, 1.05, 0.88, 1.1, 0.95, 1.03, 0.9];
  const base = asteroid.shade === "warm" ? "#5a4939" : "#394657";
  const edge = asteroid.shade === "warm" ? "#ad8b64" : "#8495aa";

  ctx.save();
  ctx.translate(asteroid.x, asteroid.y);
  ctx.rotate((asteroid.rotation || 0) + (asteroid.spin || 0) * now * 0.001);
  ctx.shadowColor = "rgba(0,0,0,0.42)";
  ctx.shadowBlur = 18;
  ctx.shadowOffsetY = 8;

  const gradient = ctx.createLinearGradient(-radius, -radius, radius, radius);
  gradient.addColorStop(0, edge);
  gradient.addColorStop(0.38, base);
  gradient.addColorStop(1, "#171d26");
  ctx.fillStyle = gradient;
  ctx.strokeStyle = "rgba(220,235,255,0.22)";
  ctx.lineWidth = Math.max(1.5, 2.5 / state.camera.zoom);
  ctx.beginPath();
  for (let i = 0; i < shape.length; i += 1) {
    const angle = i / shape.length * Math.PI * 2;
    const r = radius * shape[i];
    const x = Math.cos(angle) * r;
    const y = Math.sin(angle) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.stroke();

  ctx.fillStyle = "rgba(0,0,0,0.24)";
  ctx.strokeStyle = "rgba(255,255,255,0.14)";
  for (const crater of asteroid.craters || []) {
    const angle = crater.angle || 0;
    const distance = radius * (crater.distance || 0.3);
    const craterRadius = radius * (crater.radius || 0.12);
    ctx.beginPath();
    ctx.arc(Math.cos(angle) * distance, Math.sin(angle) * distance, craterRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  ctx.restore();
}

function drawRelays() {
  const snap = state.snapshot;
  if (!snap) return;
  const players = playerMap();

  for (const point of snap.points) {
    const owner = point.ownerId ? players.get(point.ownerId) : null;
    const color = owner?.color || "rgba(180,200,225,0.62)";

    ctx.save();
    ctx.translate(point.x, point.y);
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.12;
    ctx.beginPath();
    ctx.arc(0, 0, point.radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 0.76;
    ctx.lineWidth = 3 / state.camera.zoom;
    ctx.beginPath();
    ctx.arc(0, 0, point.radius, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * point.progress);
    ctx.stroke();

    ctx.globalAlpha = 1;
    ctx.fillStyle = "#eaf3ff";
    ctx.font = `${Math.max(18, 24 / state.camera.zoom)}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(point.id, 0, 0);
    ctx.restore();
  }
}

function drawCommandTarget(now) {
  if (!state.command) return;
  const age = now - state.command.at;
  if (age > 1600) {
    state.command = null;
    return;
  }
  const alpha = 1 - age / 1600;
  ctx.save();
  ctx.translate(state.command.x, state.command.y);
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = state.command.targetName ? "#ff5f7e" : "#ffca57";
  ctx.lineWidth = 3 / state.camera.zoom;
  ctx.beginPath();
  ctx.arc(0, 0, 26 + age * 0.025, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(-42, 0);
  ctx.lineTo(42, 0);
  ctx.moveTo(0, -42);
  ctx.lineTo(0, 42);
  ctx.stroke();
  ctx.restore();
}

function drawBullets() {
  const snap = state.snapshot;
  if (!snap) return;
  const players = playerMap();

  for (const bullet of snap.bullets) {
    const owner = players.get(bullet.ownerId);
    const color = owner?.color || "#ffffff";
    ctx.save();
    ctx.translate(bullet.x, bullet.y);
    ctx.rotate(Math.atan2(bullet.vy, bullet.vx));
    ctx.fillStyle = bullet.type === "missile" ? "#f7d37b" : bullet.type === "rail" ? "#f4f7ff" : color;
    ctx.shadowColor = ctx.fillStyle;
    ctx.shadowBlur = bullet.type === "rail" ? 22 : bullet.type === "missile" ? 18 : 12;
    if (bullet.type === "rail") {
      ctx.fillRect(-18, -2, 36, 4);
    } else {
      ctx.fillRect(bullet.type === "missile" ? -10 : -7, bullet.type === "missile" ? -3 : -2, bullet.type === "missile" ? 20 : 14, bullet.type === "missile" ? 6 : 4);
    }
    ctx.restore();
  }
}

function drawShips() {
  const snap = state.snapshot;
  if (!snap) return;
  const players = playerMap();

  for (const ship of snap.ships) {
    const player = players.get(ship.ownerId);
    if (!player) continue;
    drawShip(ship, player);
  }
}

function drawShip(ship, player) {
  const selected = state.selectedShipIds.has(ship.id);
  const alpha = ship.alive ? 1 : 0.32;
  ctx.save();
  ctx.translate(ship.x, ship.y);
  ctx.rotate(ship.angle);
  ctx.globalAlpha = alpha;

  const design = player.design || [];
  const scale = 13;
  drawShipStructure(design, scale, player.color);
  for (const part of design) {
    const def = PART_DEFS[part.type] || PART_DEFS.frame;
    const px = (part.x - 3) * scale;
    const py = (part.y - 3) * scale;
    drawModule(px, py, scale - 1, def.color, part.type, player.color);
  }

  ctx.strokeStyle = player.color;
  ctx.lineWidth = 2.5 / state.camera.zoom;
  ctx.beginPath();
  ctx.moveTo(ship.radius + 8, 0);
  ctx.lineTo(ship.radius - 8, -7);
  ctx.lineTo(ship.radius - 8, 7);
  ctx.closePath();
  ctx.stroke();
  ctx.restore();

  if (selected) drawSelectionRing(ship);
  if (ship.focusTargetId) drawFocusLine(ship);
  drawHealthBars(ship, player);
  drawShipName(ship, player);
  if (!ship.alive) drawRespawn(ship);
}

function drawShipStructure(design, scale, color) {
  const keys = new Set(design.map((part) => `${part.x},${part.y}`));
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineWidth = Math.max(3, scale * 0.26);
  ctx.strokeStyle = "rgba(0,0,0,0.42)";
  drawStructureLines(design, keys, scale);
  ctx.lineWidth = Math.max(1.2, scale * 0.12);
  ctx.strokeStyle = color;
  ctx.globalAlpha *= 0.48;
  drawStructureLines(design, keys, scale);
  ctx.restore();
}

function drawStructureLines(design, keys, scale) {
  ctx.beginPath();
  for (const part of design) {
    const x = (part.x - 3) * scale;
    const y = (part.y - 3) * scale;
    if (keys.has(`${part.x + 1},${part.y}`)) {
      ctx.moveTo(x, y);
      ctx.lineTo(x + scale, y);
    }
    if (keys.has(`${part.x},${part.y + 1}`)) {
      ctx.moveTo(x, y);
      ctx.lineTo(x, y + scale);
    }
  }
  ctx.stroke();
}

function drawModule(x, y, size, color, type, trim) {
  ctx.save();
  ctx.translate(x, y);
  ctx.lineWidth = Math.max(1.15, size * 0.12);
  ctx.strokeStyle = trim;
  ctx.shadowColor = color;
  ctx.shadowBlur = type === "core" || type === "reactor" || type === "shield" ? 8 : 3;

  const fill = ctx.createLinearGradient(-size * 0.55, -size * 0.55, size * 0.55, size * 0.55);
  fill.addColorStop(0, "rgba(255,255,255,0.42)");
  fill.addColorStop(0.24, color);
  fill.addColorStop(1, "rgba(8,12,20,0.92)");
  ctx.fillStyle = fill;

  if (type === "core") {
    roundRect(ctx, -size * 0.48, -size * 0.48, size * 0.96, size * 0.96, size * 0.18);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#f8fbff";
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.24, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#6ee7ff";
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.36, 0, Math.PI * 2);
    ctx.stroke();
  } else if (type === "frame") {
    roundRect(ctx, -size * 0.46, -size * 0.46, size * 0.92, size * 0.92, size * 0.12);
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = "rgba(255,255,255,0.42)";
    ctx.lineWidth = Math.max(1, size * 0.08);
    ctx.beginPath();
    ctx.moveTo(-size * 0.28, -size * 0.28);
    ctx.lineTo(size * 0.28, size * 0.28);
    ctx.moveTo(size * 0.28, -size * 0.28);
    ctx.lineTo(-size * 0.28, size * 0.28);
    ctx.stroke();
  } else if (type === "armor") {
    ctx.beginPath();
    ctx.moveTo(-size * 0.42, -size * 0.24);
    ctx.lineTo(-size * 0.18, -size * 0.48);
    ctx.lineTo(size * 0.42, -size * 0.34);
    ctx.lineTo(size * 0.48, size * 0.2);
    ctx.lineTo(size * 0.18, size * 0.48);
    ctx.lineTo(-size * 0.48, size * 0.34);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = "rgba(255,244,220,0.38)";
    ctx.beginPath();
    ctx.moveTo(-size * 0.18, -size * 0.34);
    ctx.lineTo(size * 0.24, size * 0.28);
    ctx.stroke();
  } else if (type === "engine") {
    ctx.beginPath();
    ctx.moveTo(-size * 0.48, -size * 0.38);
    ctx.lineTo(size * 0.4, -size * 0.24);
    ctx.lineTo(size * 0.48, size * 0.24);
    ctx.lineTo(-size * 0.48, size * 0.38);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#ffca57";
    ctx.beginPath();
    ctx.moveTo(-size * 0.58, -size * 0.18);
    ctx.lineTo(-size * 0.95, 0);
    ctx.lineTo(-size * 0.58, size * 0.18);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#89f7ff";
    ctx.fillRect(-size * 0.35, -size * 0.16, size * 0.26, size * 0.32);
  } else if (type === "blaster") {
    drawWeaponBase(size, color);
    ctx.fillStyle = "#ffd1dc";
    roundRect(ctx, size * 0.02, -size * 0.13, size * 0.62, size * 0.26, size * 0.08);
    ctx.fill();
  } else if (type === "missile") {
    drawWeaponBase(size, color);
    ctx.fillStyle = "#f0dcff";
    ctx.beginPath();
    ctx.moveTo(size * 0.64, 0);
    ctx.lineTo(size * 0.08, -size * 0.2);
    ctx.lineTo(-size * 0.08, 0);
    ctx.lineTo(size * 0.08, size * 0.2);
    ctx.closePath();
    ctx.fill();
  } else if (type === "railgun") {
    drawWeaponBase(size, color);
    ctx.strokeStyle = "#f4f7ff";
    ctx.lineWidth = Math.max(1.2, size * 0.1);
    ctx.beginPath();
    ctx.moveTo(-size * 0.04, -size * 0.16);
    ctx.lineTo(size * 0.68, -size * 0.16);
    ctx.moveTo(-size * 0.04, size * 0.16);
    ctx.lineTo(size * 0.68, size * 0.16);
    ctx.stroke();
    ctx.fillStyle = "#7aa4ff";
    ctx.fillRect(size * 0.42, -size * 0.06, size * 0.16, size * 0.12);
  } else if (type === "reactor") {
    drawRoundSystem(size);
    ctx.fillStyle = "#fff7b3";
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#6b4b12";
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.36, 0, Math.PI * 2);
    ctx.stroke();
  } else if (type === "battery") {
    roundRect(ctx, -size * 0.42, -size * 0.42, size * 0.84, size * 0.84, size * 0.12);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#d5fbff";
    for (let i = 0; i < 3; i += 1) {
      ctx.fillRect(-size * 0.25, -size * 0.28 + i * size * 0.21, size * 0.5, size * 0.09);
    }
  } else if (type === "shield") {
    drawRoundSystem(size);
    ctx.strokeStyle = "#b9ffd0";
    ctx.lineWidth = Math.max(1, size * 0.08);
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.34, Math.PI * 0.15, Math.PI * 1.85);
    ctx.stroke();
  } else if (type === "repair") {
    drawRoundSystem(size);
    ctx.strokeStyle = "#d7ffe2";
    ctx.lineWidth = Math.max(1.4, size * 0.12);
    ctx.beginPath();
    ctx.moveTo(-size * 0.24, 0);
    ctx.lineTo(size * 0.24, 0);
    ctx.moveTo(0, -size * 0.24);
    ctx.lineTo(0, size * 0.24);
    ctx.stroke();
  } else {
    roundRect(ctx, -size * 0.44, -size * 0.44, size * 0.88, size * 0.88, size * 0.1);
    ctx.fill();
    ctx.stroke();
  }

  ctx.restore();
}

function drawWeaponBase(size) {
  roundRect(ctx, -size * 0.46, -size * 0.32, size * 0.68, size * 0.64, size * 0.12);
  ctx.fill();
  ctx.stroke();
}

function drawRoundSystem(size) {
  ctx.beginPath();
  ctx.arc(0, 0, size * 0.46, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
}

function drawSelectionRing(ship) {
  ctx.save();
  ctx.strokeStyle = "#ffca57";
  ctx.lineWidth = 2.5 / state.camera.zoom;
  ctx.setLineDash([10 / state.camera.zoom, 7 / state.camera.zoom]);
  ctx.beginPath();
  ctx.arc(ship.x, ship.y, ship.radius + 14, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function drawFocusLine(ship) {
  const target = state.snapshot?.ships?.find((candidate) => candidate.id === ship.focusTargetId);
  if (!target) return;
  ctx.save();
  ctx.globalAlpha = 0.36;
  ctx.strokeStyle = "#ff5f7e";
  ctx.lineWidth = 1.5 / state.camera.zoom;
  ctx.beginPath();
  ctx.moveTo(ship.x, ship.y);
  ctx.lineTo(target.x, target.y);
  ctx.stroke();
  ctx.restore();
}

function drawHealthBars(ship, player) {
  if (!ship.alive) return;
  const width = Math.max(42, ship.radius * 1.6);
  const y = ship.y - ship.radius - 22;
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fillRect(ship.x - width / 2, y, width, 5);
  ctx.fillStyle = player.color;
  ctx.fillRect(ship.x - width / 2, y, width * clamp(ship.hp / ship.maxHp, 0, 1), 5);
  if (ship.maxShield > 0) {
    ctx.fillStyle = "rgba(96,220,255,0.82)";
    ctx.fillRect(ship.x - width / 2, y - 6, width * clamp(ship.shield / ship.maxShield, 0, 1), 3);
  }
  ctx.restore();
}

function drawShipName(ship, player) {
  if (!ship.alive || state.camera.zoom < 0.48) return;
  ctx.save();
  ctx.fillStyle = "rgba(237,244,255,0.74)";
  ctx.font = `${Math.max(10, 11 / state.camera.zoom)}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.fillText(player.name, ship.x, ship.y + ship.radius + 18);
  ctx.restore();
}

function drawRespawn(ship) {
  ctx.save();
  ctx.fillStyle = "rgba(237,244,255,0.7)";
  ctx.font = `${Math.max(11, 13 / state.camera.zoom)}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.fillText("lost", ship.x, ship.y - ship.radius - 12);
  ctx.restore();
}

function drawEffects() {
  const snap = state.snapshot;
  if (!snap) return;
  for (const effect of snap.effects) {
    const age = effect.age || 0;
    const t = clamp(age / 900, 0, 1);
    ctx.save();
    ctx.translate(effect.x, effect.y);
    ctx.globalAlpha = 1 - t;
    if (effect.type === "boom") {
      ctx.fillStyle = "#ffca57";
      ctx.beginPath();
      ctx.arc(0, 0, 18 + t * 64, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#ff5f7e";
      ctx.lineWidth = 5 / state.camera.zoom;
      ctx.beginPath();
      ctx.arc(0, 0, 34 + t * 84, 0, Math.PI * 2);
      ctx.stroke();
    } else if (effect.type === "repair") {
      ctx.strokeStyle = "#67e08a";
      ctx.lineWidth = 3 / state.camera.zoom;
      ctx.beginPath();
      ctx.arc(0, 0, 16 + t * 28, 0, Math.PI * 2);
      ctx.stroke();
    } else if (effect.type === "railhit") {
      ctx.strokeStyle = "#f4f7ff";
      ctx.lineWidth = 3 / state.camera.zoom;
      ctx.beginPath();
      ctx.moveTo(-24 - t * 24, 0);
      ctx.lineTo(24 + t * 24, 0);
      ctx.moveTo(0, -24 - t * 24);
      ctx.lineTo(0, 24 + t * 24);
      ctx.stroke();
    } else if (effect.type === "rockhit") {
      ctx.fillStyle = "rgba(196,174,142,0.82)";
      ctx.beginPath();
      ctx.arc(0, 0, 5 + t * 18, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(255,226,175,0.72)";
      ctx.lineWidth = 2 / state.camera.zoom;
      ctx.beginPath();
      ctx.moveTo(-10 - t * 12, -4);
      ctx.lineTo(8 + t * 18, 5);
      ctx.stroke();
    } else {
      ctx.fillStyle = effect.type === "warp" ? "#38d5ff" : "#f3f7ff";
      ctx.beginPath();
      ctx.arc(0, 0, 8 + t * 32, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}

function drawSelectionBox() {
  if (!state.drag) return;
  const a = state.drag.startWorld;
  const b = state.drag.currentWorld;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const width = Math.abs(a.x - b.x);
  const height = Math.abs(a.y - b.y);
  if (width < 12 && height < 12) return;
  ctx.save();
  ctx.fillStyle = "rgba(56,213,255,0.08)";
  ctx.strokeStyle = "rgba(56,213,255,0.82)";
  ctx.lineWidth = 2 / state.camera.zoom;
  ctx.fillRect(x, y, width, height);
  ctx.strokeRect(x, y, width, height);
  ctx.restore();
}

function drawMinimap(rect) {
  const w = Math.min(190, Math.max(142, rect.width * 0.19));
  const h = w * (state.world.height / state.world.width);
  const x = rect.width - w - 14;
  const y = rect.height - h - 14;
  state.minimap = { x, y, w, h };

  ctx.save();
  ctx.fillStyle = "rgba(7,12,20,0.78)";
  ctx.strokeStyle = "rgba(174,199,231,0.25)";
  ctx.lineWidth = 1;
  roundRect(ctx, x, y, w, h, 8);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  roundRect(ctx, x, y, w, h, 8);
  ctx.clip();

  const sx = w / state.world.width;
  const sy = h / state.world.height;
  const snap = state.snapshot;
  const map = currentMap();
  if (map) {
    for (const cloud of map.clouds || []) {
      ctx.fillStyle = `rgba(${cloud.color || "56,213,255"}, 0.12)`;
      ctx.beginPath();
      ctx.ellipse(x + cloud.x * sx, y + cloud.y * sy, Math.max(3, cloud.rx * sx), Math.max(2, cloud.ry * sy), cloud.rotation || 0, 0, Math.PI * 2);
      ctx.fill();
    }
    for (const asteroid of map.asteroids || []) {
      ctx.fillStyle = "rgba(172,185,202,0.45)";
      ctx.strokeStyle = "rgba(22,28,37,0.82)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(x + asteroid.x * sx, y + asteroid.y * sy, Math.max(2.5, asteroid.radius * sx), 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  if (snap) {
    const players = playerMap();
    for (const point of snap.points) {
      const owner = players.get(point.ownerId);
      ctx.fillStyle = owner?.color || "rgba(220,230,245,0.42)";
      ctx.globalAlpha = 0.75;
      ctx.beginPath();
      ctx.arc(x + point.x * sx, y + point.y * sy, 4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    for (const ship of snap.ships) {
      if (!ship.alive) continue;
      const player = players.get(ship.ownerId);
      ctx.fillStyle = player?.color || "#ffffff";
      ctx.fillRect(x + ship.x * sx - 2, y + ship.y * sy - 2, 4, 4);
    }
  }

  const viewW = rect.width / state.camera.zoom;
  const viewH = rect.height / state.camera.zoom;
  ctx.strokeStyle = "#ffca57";
  ctx.lineWidth = 1;
  ctx.strokeRect(
    x + (state.camera.x - viewW / 2) * sx,
    y + (state.camera.y - viewH / 2) * sy,
    viewW * sx,
    viewH * sy
  );
  ctx.restore();
}

function applyCamera(rect) {
  ctx.translate(rect.width / 2, rect.height / 2);
  ctx.scale(state.camera.zoom, state.camera.zoom);
  ctx.translate(-state.camera.x, -state.camera.y);
}

function screenToWorld(clientX, clientY) {
  const rect = dom.canvas.getBoundingClientRect();
  return {
    x: state.camera.x + (clientX - rect.left - rect.width / 2) / state.camera.zoom,
    y: state.camera.y + (clientY - rect.top - rect.height / 2) / state.camera.zoom
  };
}

function minimapWorldAt(clientX, clientY) {
  if (!state.minimap) return null;
  const rect = dom.canvas.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  const mini = state.minimap;
  if (x < mini.x || x > mini.x + mini.w || y < mini.y || y > mini.y + mini.h) return null;
  return {
    x: clamp((x - mini.x) / mini.w * state.world.width, 0, state.world.width),
    y: clamp((y - mini.y) / mini.h * state.world.height, 0, state.world.height)
  };
}

function showCommandMarker(clientX, clientY) {
  const rect = dom.canvas.getBoundingClientRect();
  dom.marker.hidden = false;
  dom.marker.style.left = `${clientX - rect.left}px`;
  dom.marker.style.top = `${clientY - rect.top}px`;
  dom.marker.style.animation = "none";
  dom.marker.offsetHeight;
  dom.marker.style.animation = "";
}

function playerMap() {
  return new Map((state.snapshot?.players || []).map((player) => [player.id, player]));
}

function isAdmin() {
  return state.adminId === state.myId || Boolean(state.snapshot?.players?.find((player) => player.id === state.myId && player.isAdmin));
}

function currentMap() {
  return state.snapshot?.map || state.map;
}

function teamValue() {
  return dom.teamSelect.value === "free" ? "free" : dom.teamSelect.value;
}

function loadDesign() {
  try {
    const saved = JSON.parse(localStorage.getItem(LOCAL_DESIGN_KEY) || "null");
    return normalizeDesign(saved);
  } catch {
    return normalizeDesign(null);
  }
}

function persistDesign() {
  localStorage.setItem(LOCAL_DESIGN_KEY, JSON.stringify(state.design));
}

function defaultDesign() {
  return [
    { x: 3, y: 3, type: "core" },
    { x: 3, y: 4, type: "reactor" },
    { x: 2, y: 4, type: "engine" },
    { x: 4, y: 4, type: "engine" },
    { x: 2, y: 3, type: "blaster" },
    { x: 4, y: 3, type: "blaster" },
    { x: 3, y: 2, type: "shield" },
    { x: 2, y: 2, type: "armor" },
    { x: 4, y: 2, type: "armor" },
    { x: 3, y: 5, type: "battery" }
  ];
}

function normalizeDesign(input) {
  const fallback = defaultDesign();
  const source = Array.isArray(input) ? input : fallback;
  const seen = new Set();
  const clean = [];

  for (const raw of source) {
    const x = Math.trunc(Number(raw?.x));
    const y = Math.trunc(Number(raw?.y));
    const type = String(raw?.type || "");
    const key = `${x},${y}`;
    if (x < 0 || x > 6 || y < 0 || y > 6 || !PART_DEFS[type] || seen.has(key)) continue;
    seen.add(key);
    clean.push({ x, y, type });
  }

  if (clean.filter((part) => part.type === "core").length !== 1 || !isConnected(clean)) return fallback;
  return clean;
}

function isConnected(parts) {
  const core = parts.find((part) => part.type === "core");
  if (!core) return false;
  const keys = new Set(parts.map((part) => `${part.x},${part.y}`));
  const seen = new Set([`${core.x},${core.y}`]);
  const queue = [core];

  for (let i = 0; i < queue.length; i += 1) {
    const part = queue[i];
    for (const [x, y] of [[part.x + 1, part.y], [part.x - 1, part.y], [part.x, part.y + 1], [part.x, part.y - 1]]) {
      const key = `${x},${y}`;
      if (keys.has(key) && !seen.has(key)) {
        seen.add(key);
        queue.push({ x, y });
      }
    }
  }

  return seen.size === parts.length;
}

function explainConnectionProblem(parts, x, y, replacing) {
  if (!parts.some((part) => part.type === "core")) {
    return "Blueprint must keep exactly one core module";
  }

  const target = parts.find((part) => part.x === x && part.y === y);
  if (target) {
    const sideNeighbor = parts.some((part) => part !== target && Math.abs(part.x - x) + Math.abs(part.y - y) === 1);
    const cornerNeighbor = parts.some((part) => part !== target && Math.abs(part.x - x) === 1 && Math.abs(part.y - y) === 1);

    if (!sideNeighbor && cornerNeighbor) {
      return "Not connected: modules must touch by a full side; corner contact does not count";
    }

    if (!sideNeighbor) {
      return "Not connected: place it so one side touches an existing module";
    }
  }

  if (replacing) {
    return "That change would break the side-connected path back to the core";
  }

  return "Not connected to the core: every module needs a side-connected path to the core";
}

function computeStats(modules) {
  let cost = 0;
  let mass = 0;
  let maxHp = 0;
  let maxShield = 0;
  let shieldRegen = 0;
  let powerGeneration = 0;
  let powerUse = 0;
  let thrust = 0;
  let turnBonus = 0;
  let energyStorage = 0;
  let blaster = 0;
  let missile = 0;
  let railgun = 0;
  let repair = 0;
  let repairRate = 0;
  const weaponTotals = {
    blaster: weaponAccumulator(),
    missile: weaponAccumulator(),
    railgun: weaponAccumulator()
  };

  for (const module of modules) {
    const part = PART_STATS[module.type] || PART_STATS.frame;
    cost += part.cost;
    mass += part.mass;
    maxHp += part.hp;
    maxShield += part.shield;
    shieldRegen += part.shieldRegen || 0;
    powerGeneration += part.powerGeneration || 0;
    powerUse += part.powerUse || 0;
    thrust += part.thrust;
    turnBonus += part.turn;
    energyStorage += part.energyStorage || 0;
    blaster += part.blaster || 0;
    missile += part.missile || 0;
    railgun += part.railgun || 0;
    repair += part.repair || 0;
    repairRate += part.repairRate || 0;
    if (part.weapon) addWeaponStats(weaponTotals[part.weapon.type], part.weapon);
  }

  const power = powerGeneration - powerUse;
  const powerRatio = powerUse > 0 ? powerGeneration / powerUse : 1.2;
  const efficiency = clamp(powerUse > 0 ? 0.58 + powerRatio * 0.42 : 1.08, 0.48, 1.15);
  const thrustRatio = thrust / Math.max(1, mass);
  // Mobility balance: armor and large weapons add mass, while engines add thrust.
  // Speed and acceleration scale from total thrust divided by total mass so heavy ships need more engines.
  const maxSpeed = clamp(82 + thrustRatio * 21 * clamp(efficiency, 0.62, 1.08), 72, 360);
  const accel = clamp(46 + thrustRatio * 46 * clamp(efficiency, 0.55, 1.08), 38, 420);
  const costBreakdown = calculateCostBreakdown({ cost, mass, maxHp, maxShield, repairRate, blaster, missile, railgun });
  const unitCost = costBreakdown.total;
  const fleetCount = clamp(Math.floor(260 / Math.max(58, unitCost * 0.72 + mass * 0.45)), 1, 5);
  const warnings = shipWarnings({ powerGeneration, powerUse, thrustRatio, blaster, missile, railgun, mass, turnRate: clamp(1.05 + turnBonus + thrustRatio * 0.035, 0.55, 2.85), repair, shield: maxShield, modules });

  return {
    cost,
    unitCost,
    mass: Math.round(mass),
    maxHp: Math.max(140, Math.round(maxHp * 0.82)),
    maxShield: Math.round(maxShield * efficiency),
    shieldRegen: Number((shieldRegen * clamp(efficiency, 0.4, 1.12)).toFixed(2)),
    powerGeneration,
    powerUse,
    power,
    efficiency: Number(efficiency.toFixed(2)),
    thrust,
    thrustRatio: Number(thrustRatio.toFixed(2)),
    energyStorage,
    accel: Math.round(accel),
    maxSpeed,
    turnRate: clamp(1.05 + turnBonus + thrustRatio * 0.035, 0.55, 2.85),
    blaster,
    missile,
    railgun,
    repair,
    repairRate,
    blasterRange: weaponRange(weaponTotals.blaster),
    missileRange: weaponRange(weaponTotals.missile),
    railgunRange: weaponRange(weaponTotals.railgun),
    weaponDps: Number((weaponTotals.blaster.dps + weaponTotals.missile.dps + weaponTotals.railgun.dps).toFixed(1)),
    weapons: summarizeWeaponTotals(weaponTotals),
    warnings,
    costBreakdown,
    fleetCount
  };
}

function calculateCostBreakdown(stats) {
  const base = SHIP_ECONOMY.baseShipCost;
  const parts = stats.cost * SHIP_ECONOMY.partCostMultiplier;
  const mass = stats.mass * SHIP_ECONOMY.massCostMultiplier;
  const hull = stats.maxHp * SHIP_ECONOMY.hullCostMultiplier;
  const shield = stats.maxShield * SHIP_ECONOMY.shieldCostMultiplier;
  const repair = stats.repairRate * SHIP_ECONOMY.repairCostMultiplier;
  const weaponPremium =
    stats.blaster * SHIP_ECONOMY.weaponPremiums.blaster +
    stats.missile * SHIP_ECONOMY.weaponPremiums.missile +
    stats.railgun * SHIP_ECONOMY.weaponPremiums.railgun;
  const preTaxTotal = base + parts + mass + hull + shield + repair + weaponPremium;
  const largeTax = Math.max(0, preTaxTotal - SHIP_ECONOMY.largeShipThreshold) * SHIP_ECONOMY.largeShipCostTax;
  const hugeTax = Math.max(0, preTaxTotal - SHIP_ECONOMY.hugeShipThreshold) * SHIP_ECONOMY.hugeShipCostTax;
  const sizeTax = largeTax + hugeTax;
  return {
    base: Math.round(base),
    parts: Math.round(parts),
    mass: Math.round(mass),
    hull: Math.round(hull),
    shield: Math.round(shield),
    repair: Math.round(repair),
    weaponPremium: Math.round(weaponPremium),
    sizeTax: Math.round(sizeTax),
    total: clamp(Math.round(preTaxTotal + sizeTax), 80, 1100)
  };
}

function weaponAccumulator() {
  return { count: 0, damage: 0, range: 0, fireRate: 0, reload: 0, projectileSpeed: 0, accuracy: 0, tracking: 0, dps: 0 };
}

function addWeaponStats(total, weapon) {
  total.count += 1;
  total.damage += weapon.damage;
  total.range = Math.max(total.range, weapon.range);
  total.fireRate += weapon.fireRate;
  total.reload += calculateReload(weapon);
  total.projectileSpeed += weapon.projectileSpeed;
  total.accuracy += weapon.accuracy;
  total.tracking += weapon.tracking || 0;
  total.dps += calculateDps(weapon);
}

function calculateDps(weapon) {
  return Number(((weapon.damage || 0) * (weapon.fireRate || 0)).toFixed(1));
}

function calculateReload(weapon) {
  return Number((1 / Math.max(0.01, weapon.fireRate || 1)).toFixed(2));
}

function weaponRange(total) {
  return total.count > 0 ? total.range : 0;
}

function summarizeWeaponTotals(totals) {
  const result = {};
  for (const [type, total] of Object.entries(totals)) {
    result[type] = {
      count: total.count,
      damage: total.damage,
      range: total.range,
      fireRate: Number(total.fireRate.toFixed(2)),
      reload: total.count ? Number((total.reload / total.count).toFixed(2)) : 0,
      projectileSpeed: total.count ? Math.round(total.projectileSpeed / total.count) : 0,
      accuracy: total.count ? Number((total.accuracy / total.count).toFixed(2)) : 0,
      tracking: total.count ? Number((total.tracking / total.count).toFixed(2)) : 0,
      dps: Number(total.dps.toFixed(1))
    };
  }
  return result;
}

function shipWarnings(stats) {
  const warnings = [];
  const weaponCount = stats.blaster + stats.missile + stats.railgun;
  const hasReactor = stats.modules.some((module) => module.type === "reactor");
  if (stats.powerGeneration < stats.powerUse) warnings.push(`Power deficit: uses ${stats.powerUse} but generates ${stats.powerGeneration}`);
  if (!hasReactor && stats.powerUse > PART_STATS.core.powerGeneration) warnings.push("No reactor: high-power systems need stronger generation");
  if (stats.thrustRatio < 3.2 && stats.mass > 18) warnings.push("Low mobility: heavy for its engine power");
  if (stats.mass > 85 || stats.turnRate < 0.85) warnings.push("Heavy ship: turning will be slow");
  if (stats.repair > 0 && stats.powerGeneration < stats.powerUse) warnings.push("Repair installed but power is insufficient");
  if (stats.shield > 0 && stats.powerGeneration < stats.powerUse) warnings.push("Shields installed but power is insufficient");
  if (weaponCount === 0) warnings.push("No weapons: this ship cannot attack");
  return warnings;
}

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

function roundRect(context, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.arcTo(x + width, y, x + width, y + height, r);
  context.arcTo(x + width, y + height, x, y + height, r);
  context.arcTo(x, y + height, x, y, r);
  context.arcTo(x, y, x + width, y, r);
  context.closePath();
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[char]);
}

const roomFromUrl = new URLSearchParams(location.search).get("room");
if (roomFromUrl) {
  dom.roomCode.value = roomFromUrl.toUpperCase().slice(0, 8);
}
