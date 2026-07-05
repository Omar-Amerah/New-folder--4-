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

const PART_STATS = {
  core: { cost: 0, mass: 7, hp: 120, power: 3, shield: 30, thrust: 0, turn: 0, blaster: 0, missile: 0, railgun: 0, repair: 0 },
  frame: { cost: 4, mass: 2, hp: 38, power: 0, shield: 0, thrust: 0, turn: 0, blaster: 0, missile: 0, railgun: 0, repair: 0 },
  armor: { cost: 9, mass: 6, hp: 115, power: 0, shield: 0, thrust: 0, turn: -0.03, blaster: 0, missile: 0, railgun: 0, repair: 0 },
  engine: { cost: 13, mass: 4, hp: 52, power: -1, shield: 0, thrust: 120, turn: 0.32, blaster: 0, missile: 0, railgun: 0, repair: 0 },
  reactor: { cost: 12, mass: 5, hp: 58, power: 6, shield: 0, thrust: 0, turn: 0.02, blaster: 0, missile: 0, railgun: 0, repair: 0 },
  battery: { cost: 10, mass: 3, hp: 42, power: 2, shield: 52, thrust: 0, turn: 0.01, blaster: 0, missile: 0, railgun: 0, repair: 0 },
  shield: { cost: 16, mass: 5, hp: 48, power: -2, shield: 95, thrust: 0, turn: 0, blaster: 0, missile: 0, railgun: 0, repair: 0 },
  blaster: { cost: 15, mass: 5, hp: 46, power: -2, shield: 0, thrust: 0, turn: -0.02, blaster: 1, missile: 0, railgun: 0, repair: 0 },
  missile: { cost: 22, mass: 7, hp: 54, power: -3, shield: 0, thrust: 0, turn: -0.03, blaster: 0, missile: 1, railgun: 0, repair: 0 },
  railgun: { cost: 24, mass: 8, hp: 58, power: -4, shield: 0, thrust: 0, turn: -0.04, blaster: 0, missile: 0, railgun: 1, repair: 0 },
  repair: { cost: 18, mass: 5, hp: 50, power: -2, shield: 28, thrust: 0, turn: -0.01, blaster: 0, missile: 0, railgun: 0, repair: 1 }
};

const LOCAL_DESIGN_KEY = "modular-fleet-design-v2";
const LOCAL_NAME_KEY = "modular-fleet-name-v1";
const LOCAL_TEAM_KEY = "modular-fleet-team-v1";
const LOCAL_FORMATION_KEY = "modular-fleet-formation-v1";
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
  joinButton: document.getElementById("joinButton"),
  copyButton: document.getElementById("copyButton"),
  botButton: document.getElementById("botButton"),
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
  selectionLabel: document.getElementById("selectionLabel"),
  objectiveLabel: document.getElementById("objectiveLabel"),
  scoreList: document.getElementById("scoreList"),
  eventLog: document.getElementById("eventLog"),
  toastStack: document.getElementById("toastStack"),
  matchProgressFill: document.getElementById("matchProgressFill"),
  matchSummary: document.getElementById("matchSummary"),
  latency: document.getElementById("latencyText"),
  marker: document.getElementById("commandMarker"),
  winner: document.getElementById("winnerBanner")
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
dom.resetButton.addEventListener("click", resetDesign);
dom.copyButton.addEventListener("click", copyInvite);
dom.botButton.addEventListener("click", addBot);
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
  state.selectedShipIds.clear();
  dom.roomLabel.textContent = "----";
  dom.currentRoomCode.textContent = "----";
  dom.currentRoomCard.hidden = true;

  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${protocol}//${location.host}/socket`);
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
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
    joinRoom();
    setTimeout(() => deployDesign(), 240);
    return;
  }
  send({ type: "deploy", design: state.design });
}

function addBot() {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
    joinRoom();
    setTimeout(addBot, 260);
    return;
  }
  send({ type: "addBot" });
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
  dom.roomState.textContent = connected ? `${playerCount} in room` : connecting ? "Connecting" : "Not joined";
  dom.createButton.disabled = connecting;
  dom.joinButton.disabled = connecting;
  dom.copyButton.disabled = !state.room;
  dom.botButton.disabled = !connected;
  dom.currentRoomCard.hidden = !state.room;
  dom.currentRoomCode.textContent = state.room || "----";
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
    state.selectedShipIds.clear();
    dom.roomCode.value = message.room;
    dom.currentRoomCode.textContent = message.room;
    dom.currentRoomCard.hidden = false;
    dom.roomLabel.textContent = message.room;
    setConnectionStatus("online", "Room linked");
    updateLobbyState();
    deployDesign();
    return;
  }

  if (message.type === "state") {
    state.snapshot = message;
    state.room = message.room;
    dom.roomLabel.textContent = message.room;
    pruneSelection();
    updateHud();
    renderScoreboard();
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
    button.innerHTML = `<span class="part-glyph" style="background:${PART_DEFS[type].glyph}"></span><span class="part-name">${PART_DEFS[type].name}</span>`;
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
  dom.partInspector.innerHTML = `
    <div class="part-inspector-title">
      <span style="background:${def.glyph}"></span>
      <strong>${escapeHtml(def.name)}</strong>
    </div>
    <div class="part-inspector-grid">
      ${inspectorStat("Cost", stat.cost)}
      ${inspectorStat("Mass", stat.mass)}
      ${inspectorStat("Hull", stat.hp)}
      ${inspectorStat("Power", stat.power)}
      ${inspectorStat("Shield", stat.shield)}
      ${inspectorStat("Thrust", stat.thrust)}
      ${inspectorStat("Guns", stat.blaster + stat.missile + stat.railgun)}
      ${inspectorStat("Repair", stat.repair)}
    </div>
  `;
}

function inspectorStat(label, value) {
  return `<div><span>${label}</span><strong>${value}</strong></div>`;
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
      if (part) cell.style.background = PART_DEFS[part.type].glyph;
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
    if (isConnected(next)) state.design = next;
  } else {
    const next = [...state.design, { x, y, type: state.selectedPart }];
    if (next.length <= 36 && isConnected(next)) {
      state.design = next;
    } else {
      setBuildStatus("Parts must stay connected to the core", "warning");
      showToast("Part not connected", "warning");
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
    setBuildStatus("That would detach part of the hull", "warning");
    showToast("Hull section would detach", "warning");
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
  dom.budget.textContent = `${stats.cost} pts`;
  dom.stats.innerHTML = [
    statMarkup("Fleet", stats.fleetCount),
    statMarkup("Hull", stats.maxHp),
    statMarkup("Shield", stats.maxShield),
    statMarkup("Speed", Math.round(stats.maxSpeed)),
    statMarkup("Power", stats.power),
    statMarkup("Weapons", `${stats.blaster}/${stats.missile}/${stats.railgun}`),
    statMarkup("Repair", stats.repair),
    statMarkup("Mass", stats.mass)
  ].join("");

  const weaponCount = stats.blaster + stats.missile + stats.railgun;
  const className = stats.power < -4 || weaponCount === 0 ? "warning" : "good";
  const text = weaponCount === 0
    ? "No weapons mounted"
    : stats.power < -4
      ? "Power-starved systems fire weaker"
      : "Blueprint ready";
  setBuildStatus(text, className);
}

function setBuildStatus(text, className) {
  dom.buildStatus.textContent = text;
  dom.buildStatus.className = `build-status ${className || ""}`.trim();
}

function statMarkup(label, value) {
  return `<div class="stat"><span>${label}</span><strong>${value}</strong></div>`;
}

function updateHud() {
  if (!state.snapshot) return;
  const mine = state.snapshot.players.find((player) => player.id === state.myId);
  const myShips = state.snapshot.ships.filter((ship) => ship.ownerId === state.myId && ship.alive);
  const myTeam = mine?.team;
  const relays = state.snapshot.points.filter((point) => point.ownerTeam === myTeam && point.progress > 0.98).length;
  const target = currentTarget();
  dom.fleetLabel.textContent = `${myShips.length}/${mine?.stats?.fleet || 0}`;
  dom.relayLabel.textContent = String(relays);
  dom.selectionLabel.textContent = `${state.selectedShipIds.size}`;
  dom.objectiveLabel.textContent = target ? target.label : "None";
  dom.latency.textContent = state.latency == null ? "-- ms" : `${Math.round(state.latency)} ms`;
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
        <div class="score-meta">${escapeHtml(player.teamName || "Solo")} | K ${player.kills} / L ${player.losses} / C ${player.captures}</div>
      </div>
      <div class="score-value">${player.score}</div>
    `;
    dom.scoreList.appendChild(row);
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
  dom.matchProgressFill.style.width = `${progress}%`;
  dom.matchSummary.textContent = `${leader.name} leads ${leader.score}/${maxScore}`;
}

function updateWinnerBanner() {
  const winner = state.snapshot?.winner;
  if (!winner) {
    dom.winner.hidden = true;
    return;
  }
  dom.winner.hidden = false;
  dom.winner.textContent = `${winner.name} won`;
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

function drawModule(x, y, size, color, type, trim) {
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = color;
  ctx.strokeStyle = trim;
  ctx.lineWidth = 1.8;

  if (type === "engine") {
    ctx.beginPath();
    ctx.moveTo(-size * 0.45, -size * 0.45);
    ctx.lineTo(size * 0.45, 0);
    ctx.lineTo(-size * 0.45, size * 0.45);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#ffca57";
    ctx.fillRect(-size * 0.7, -size * 0.18, size * 0.36, size * 0.36);
  } else if (type === "blaster" || type === "missile" || type === "railgun") {
    ctx.fillRect(-size * 0.44, -size * 0.33, size * 0.88, size * 0.66);
    ctx.strokeRect(-size * 0.44, -size * 0.33, size * 0.88, size * 0.66);
    ctx.fillStyle = type === "railgun" ? "#7aa4ff" : "#f8fbff";
    ctx.fillRect(size * 0.1, -size * 0.12, size * 0.58, size * 0.24);
  } else if (type === "shield" || type === "reactor" || type === "core" || type === "battery" || type === "repair") {
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.48, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    if (type === "repair") {
      ctx.strokeStyle = "#d7ffe2";
      ctx.beginPath();
      ctx.moveTo(-size * 0.22, 0);
      ctx.lineTo(size * 0.22, 0);
      ctx.moveTo(0, -size * 0.22);
      ctx.lineTo(0, size * 0.22);
      ctx.stroke();
    }
  } else {
    ctx.fillRect(-size * 0.45, -size * 0.45, size * 0.9, size * 0.9);
    ctx.strokeRect(-size * 0.45, -size * 0.45, size * 0.9, size * 0.9);
  }

  ctx.restore();
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
  ctx.fillText(`${ship.respawnIn}`, ship.x, ship.y - ship.radius - 12);
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

function computeStats(modules) {
  let cost = 0;
  let mass = 0;
  let maxHp = 0;
  let maxShield = 0;
  let power = 0;
  let thrust = 0;
  let turnBonus = 0;
  let blaster = 0;
  let missile = 0;
  let railgun = 0;
  let repair = 0;

  for (const module of modules) {
    const part = PART_STATS[module.type] || PART_STATS.frame;
    cost += part.cost;
    mass += part.mass;
    maxHp += part.hp;
    maxShield += part.shield;
    power += part.power;
    thrust += part.thrust;
    turnBonus += part.turn;
    blaster += part.blaster;
    missile += part.missile;
    railgun += part.railgun;
    repair += part.repair;
  }

  const efficiency = clamp(0.72 + power * 0.045, 0.45, 1.25);
  const maxSpeed = clamp(115 + thrust / Math.max(1, mass) * 17, 105, 360);
  const fleetCount = clamp(Math.floor(225 / Math.max(44, cost + mass * 0.32)), 1, 5);

  return {
    cost,
    mass,
    maxHp: Math.max(140, Math.round(maxHp * 0.82)),
    maxShield: Math.round(maxShield * efficiency),
    power,
    maxSpeed,
    turnRate: clamp(1.2 + turnBonus + thrust / Math.max(55, mass * 20), 0.65, 2.85),
    blaster,
    missile,
    railgun,
    repair,
    fleetCount
  };
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
