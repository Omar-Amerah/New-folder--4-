// Handles player join, leave, name updates, team assignment, re-connection matching, and admin promotion checks.

const crypto = require("crypto");
const { COLORS, ECONOMY, TEAM_NAMES, DEFAULT_DESIGN, DEFAULT_WIRING } = require("./config");
const { sanitizeName, sanitizeTeam } = require("./validation");
const { performanceNow } = require("./utils");

// A player who drops (refresh or brief disconnect) keeps their ships and state
// for this long; the server only despawns them if no reconnection arrives first.
const RECONNECT_GRACE_MS = Number(process.env.RECONNECT_GRACE_MS || 10000);
const MAX_RESUME_TOKEN_LENGTH = 128;
let nextStablePlayerId = 1;

function makePlayerId(room) {
  let id;
  do { id = `pl${nextStablePlayerId++}`; } while (room.players.has(id));
  return id;
}

function makeResumeToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function normalizePlayerName(name) {
  return String(name || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function safeEqualToken(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length === 0 || a.length > MAX_RESUME_TOKEN_LENGTH || b.length > MAX_RESUME_TOKEN_LENGTH) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function findPlayerByResumeToken(room, token) {
  if (typeof token !== "string" || token.length > MAX_RESUME_TOKEN_LENGTH) return null;
  for (const player of room.players.values()) {
    if (!player.isBot && !player.removed && safeEqualToken(token, player.resumeToken)) return player;
  }
  return null;
}

function findReservedNameOwner(room, requestedName, exceptId = null) {
  const key = normalizePlayerName(requestedName);
  return [...room.players.values()].find((p) => !p.removed && p.id !== exceptId && normalizePlayerName(p.name) === key) || null;
}

// Ships are only removed when a player truly leaves (deliberate leave/kick, or
// the reconnect grace period elapses). The server stays authoritative for this.
function despawnPlayerShips(room, player) {
  for (const ship of player.ships) {
    ship.alive = false;
    ship.removed = true;
    room.ships.delete(ship.id);
  }
  player.ships = [];
  room.bullets = room.bullets.filter((bullet) => bullet.ownerId !== player.id);
}

function joinRoom(client, message) {
  const { rooms, createRoom, isClosedRoomCode } = require("./rooms");
  const { sanitizeRoomCode } = require("./validation");
  const { send, broadcastRoom, broadcastSnapshot } = require("./messages");
  const { computeStats } = require("./shipStats");

  const requestedCode = sanitizeRoomCode(message.room);
  const code = requestedCode || require("./rooms").makeRoomCode();
  const requestedName = sanitizeName(message.name, `Pilot ${client.id.slice(1)}`);
  const resumeToken = typeof message.resumeToken === "string" ? message.resumeToken.slice(0, MAX_RESUME_TOKEN_LENGTH) : "";

  if (requestedCode && isClosedRoomCode(code)) {
    send(client, { type: "error", message: "That lobby was closed. Create a new game instead." });
    return;
  }

  // The room is only created once the join actually succeeds (below). Creating
  // it eagerly left a ghost empty room behind every rejected join, and the
  // idle cleanup would then remember that code as closed — poisoning a
  // pre-agreed room code for the whole closed-code TTL.
  let room = rooms.get(code) || null;

  let existingPlayer = room ? findPlayerByResumeToken(room, resumeToken) : null;

  if (resumeToken && !existingPlayer) {
    // The code matters: the client clears its stored credential only on
    // credential-expired/credential-invalid, so omitting it locks the player
    // into resending the same dead token on every subsequent join attempt.
    const { ERROR_CODES } = require("./protocol");
    send(client, { type: "error", code: ERROR_CODES.CREDENTIAL_EXPIRED, message: "Reconnect credential expired or invalid. Please join as a new player." });
    return;
  }

  const nameOwner = room ? findReservedNameOwner(room, requestedName, existingPlayer?.id) : null;
  if (nameOwner) {
    send(client, { type: "error", message: nameOwner.connected === false ? "Name temporarily reserved by a disconnected player" : "Name already in use" });
    return;
  }

  if (existingPlayer) {
    if (client.room || client.player) leaveRoom(client);
    attachClientToPlayer(room, existingPlayer, client);
    if (existingPlayer.disconnectTimeout) {
      clearTimeout(existingPlayer.disconnectTimeout);
      existingPlayer.disconnectTimeout = null;
    }
    existingPlayer.connected = true;
    existingPlayer.removed = false;
    room.clients.add(client);
    ensureAdmin(room);
    room.lastEmptyAt = 0;

    send(client, { type: "joined", id: existingPlayer.id, playerId: existingPlayer.id, connectionId: client.id, attachmentId: client.attachmentId, resumeToken: existingPlayer.resumeToken, room: room.code, world: room.world, map: room.map, phase: room.phase, adminId: room.adminId, rules: room.rules });
    broadcastRoom(room, { type: "notice", message: `${existingPlayer.name} reconnected` });
    broadcastSnapshot(room, performanceNow(), true);
    checkEmptyLobby(room);
    return;
  }

  if (room && room.phase !== "lobby") {
    send(client, { type: "error", message: "That game has already started. Create a new room or wait for the next lobby." });
    return;
  }

  if (room && room.players.size >= room.rules.maxPlayers && !room.clients.has(client)) {
    send(client, { type: "error", message: "Room is full" });
    return;
  }

  // Kicks are enforced by reserved name: player ids and connection ids are
  // both minted fresh on every join, so a name is the only stable handle a
  // room has for a kicked player.
  if (room?.kickedNames?.has(normalizePlayerName(requestedName))) {
    send(client, { type: "error", message: "You were kicked from this room by the host." });
    return;
  }

  leaveRoom(client);

  if (!room) {
    room = createRoom(code);
    rooms.set(code, room);
  }

  if (!room.playerColors) room.playerColors = new Map();
  let color = room.playerColors.get(requestedName.toLowerCase());
  if (!color) {
    color = COLORS[room.colorCursor % COLORS.length];
    room.colorCursor += 1;
    room.playerColors.set(requestedName.toLowerCase(), color);
  }

  const player = {
    id: makePlayerId(room),
    name: requestedName,
    color,
    team: sanitizeTeamForMode(room, message.team, client.id),
    isBot: false,
    ai: null,
    ready: false,
    design: DEFAULT_DESIGN.map((part) => ({ ...part })),
    wiring: {
      version: DEFAULT_WIRING.version,
      power: { sections: DEFAULT_WIRING.power.sections.map((section) => ({ ...section })), connections: DEFAULT_WIRING.power.connections.map((connection) => ({ ...connection, sectionIds: [...connection.sectionIds] })) },
      data: { sections: DEFAULT_WIRING.data.sections.map((section) => ({ ...section })), connections: DEFAULT_WIRING.data.connections.map((connection) => ({ ...connection, sectionIds: [...connection.sectionIds] })) }
    },
    stats: computeStats(DEFAULT_DESIGN),
    ships: [],
    money: room.rules.startingMoney,
    bank: room.rules.startingMoney,
    income: ECONOMY.baseIncome,
    earned: room.rules.startingMoney,
    spent: 0,
    maxMoney: ECONOMY.maxMoney,
    shipCap: ECONOMY.shipCap,
    deployedFleetCost: 0,
    destroyedEnemyCost: 0,
    lostFleetCost: 0,
    lastReward: null,
    rallyPoint: null,
    score: 0,
    kills: 0,
    losses: 0,
    captures: 0,
    connected: true,
    lastReadyAt: 0,
    resumeToken: makeResumeToken(),
    attachmentId: 0,
    removed: false,
    purchaseRequests: new Map()
  };
  if (room.rules?.gameMode === "solo") player.team = player.id;

  attachClientToPlayer(room, player, client);
  room.clients.add(client);
  room.players.set(player.id, player);
  require("./spawnPlanner").invalidateSpawnPlan(room);
  ensureAdmin(room);
  room.lastEmptyAt = 0;

  send(client, { type: "joined", id: player.id, playerId: player.id, connectionId: client.id, attachmentId: client.attachmentId, resumeToken: player.resumeToken, room: room.code, world: room.world, map: room.map, phase: room.phase, adminId: room.adminId, rules: room.rules });
  broadcastRoom(room, { type: "notice", message: `${player.name} joined ${room.code}` });
  broadcastSnapshot(room, performanceNow(), true);
  checkEmptyLobby(room);
}

function isCurrentAttachment(client) {
  return Boolean(client && client.room && client.player && client.player.client === client && client.player.attachmentId === client.attachmentId);
}

function attachClientToPlayer(room, player, client) {
  const oldClient = player.client;
  player.attachmentId = (player.attachmentId || 0) + 1;
  player.client = client;
  client.room = room;
  client.player = player;
  client.attachmentId = player.attachmentId;
  if (oldClient && oldClient !== client) {
    room.clients.delete(oldClient);
    oldClient.room = null;
    oldClient.player = null;
    oldClient.replaced = true;
    try { oldClient.socket.destroy(); } catch { /* already closed */ }
  }
}

function leaveRoom(client, explicitLeave = false) {
  if (client.room && client.player) {
    const { room, player } = client;
    const current = isCurrentAttachment(client);
    room.clients.delete(client);
    if (!current) {
      client.room = null;
      client.player = null;
      return;
    }
    player.client = null;
    player.connected = false;

    if (explicitLeave) {
      // Deliberate leave/kick: remove the player and their ships immediately.
      player.resumeToken = null;
      player.removed = true;
      despawnPlayerShips(room, player);
      room.players.delete(player.id);
      if (room.adminId === player.id) {
        room.adminId = null;
      }
    } else {
      // Refresh / brief disconnect: keep the player and their ships alive for a
      // reconnect grace period so a page refresh does not lose the fleet. Ships
      // are only despawned if no reconnection arrives before the timer fires.
      if (player.disconnectTimeout) clearTimeout(player.disconnectTimeout);
      player.disconnectTimeout = setTimeout(() => {
        if (!player.connected && !player.client && room.players.has(player.id)) {
          player.resumeToken = null;
          player.removed = true;
          despawnPlayerShips(room, player);
          room.players.delete(player.id);
          if (room.adminId === player.id) {
            room.adminId = null;
            ensureAdmin(room);
          }
          if (room.clients.size > 0) {
            const { broadcastSnapshot } = require("./messages");
            broadcastSnapshot(room, performanceNow(), true);
          }
          // The pruned player may have been the last not-ready blocker; without
          // this re-check the design phase stalls even though everyone left is
          // ready. maybeStartMatch is phase-guarded internally.
          maybeStartMatch(room, performanceNow());
          checkEmptyLobby(room);
        }
      }, RECONNECT_GRACE_MS);
    }

    if (room.clients.size === 0) {
      room.lastEmptyAt = Date.now();
    } else {
      const { broadcastRoom } = require("./messages");
      ensureAdmin(room);
      broadcastRoom(room, { type: "notice", message: explicitLeave ? `${player.name} left` : `${player.name} disconnected` });
      if (room.phase === "design") {
        const { maybeStartMatch } = require("./players");
        maybeStartMatch(room, performanceNow());
      }
    }
  }

  if (client.room) checkEmptyLobby(client.room);
  client.room = null;
  client.player = null;
  client.attachmentId = 0;
}

function leaveLobby(client) {
  const { send, broadcastSnapshot } = require("./messages");
  const { rooms } = require("./rooms");
  if (!client.room || !client.player) {
    send(client, { type: "leftLobby", message: "Left lobby" });
    return;
  }
  const room = client.room;
  const code = room.code;
  leaveRoom(client, true);
  send(client, { type: "leftLobby", message: `Left lobby ${code}` });
  if (room.clients.size === 0) {
    rooms.delete(code);
    return;
  }
  broadcastSnapshot(room, performanceNow());
}

function kickPlayer(room, requester, targetId) {
  const { sendPlayer, broadcastRoom, broadcastSnapshot } = require("./messages");
  if (!isAdmin(room, requester)) {
    sendPlayer(room, requester, { type: "error", message: "Only the room admin can kick players" });
    return;
  }
  if (room.phase !== "lobby" && room.phase !== "design") {
    sendPlayer(room, requester, { type: "error", message: "Players can only be kicked before the match starts" });
    return;
  }
  if (!targetId || targetId === requester.id) {
    sendPlayer(room, requester, { type: "error", message: "Choose another player to kick" });
    return;
  }

  const target = room.players.get(targetId);
  if (!target) {
    sendPlayer(room, requester, { type: "error", message: "That player is no longer in the room" });
    return;
  }

  removePlayerFromRoom(room, target, "kicked");
  room.kickedNames.add(normalizePlayerName(target.name));
  broadcastRoom(room, { type: "notice", message: `${target.name} was kicked` });
  if (room.phase === "design") maybeStartMatch(room, performanceNow());
  broadcastSnapshot(room, performanceNow());
}

function removePlayerFromRoom(room, player, reason) {
  const { send } = require("./messages");
  for (const ship of player.ships) {
    ship.alive = false;
    ship.removed = true;
    room.ships.delete(ship.id);
  }
  player.ships = [];
  player.resumeToken = null;
  player.removed = true;
  if (player.disconnectTimeout) clearTimeout(player.disconnectTimeout);
  room.players.delete(player.id);
  room.bullets = room.bullets.filter((bullet) => bullet.ownerId !== player.id);
  for (const point of room.points) {
    if (point.ownerId === player.id) {
      if (room.rules?.gameMode === "solo") {
        point.ownerId = null;
        point.ownerTeam = null;
        point.progress = 0;
      } else {
        const teammate = [...room.players.values()].find((candidate) => candidate.id !== player.id && candidate.team === player.team && !candidate.removed);
        point.ownerId = teammate?.id || null;
      }
      point.contested = false;
    }
  }

  if (!player.isBot) {
    const client = [...room.clients].find((candidate) => candidate.player?.id === player.id);
    if (client) {
      send(client, { type: "kicked", message: reason === "kicked" ? "You were kicked by the room admin" : "Removed from room" });
      room.clients.delete(client);
      client.room = null;
      client.player = null;
      client.attachmentId = 0;
    }
  }

  ensureAdmin(room);
  checkEmptyLobby(room);
}

function ensureAdmin(room) {
  if (room.adminId && room.players.has(room.adminId)) {
    const adminPlayer = room.players.get(room.adminId);
    if (!adminPlayer.isBot && (adminPlayer.connected !== false || adminPlayer.disconnectTimeout)) {
      return;
    }
  }
  const nextAdmin = [...room.players.values()].find((player) => !player.isBot && (player.connected !== false || player.disconnectTimeout));
  room.adminId = nextAdmin?.id || null;
}

function isAdmin(room, player) {
  return Boolean(room && player && room.adminId === player.id && !player.isBot);
}

function sanitizeTeamForMode(room, requestedTeam, fallbackId) {
  return sanitizeTeam(requestedTeam, balanceTeam(room));
}

function balanceTeam(room) {
  const blue = [...room.players.values()].filter((player) => player.team === "blue").length;
  const red = [...room.players.values()].filter((player) => player.team === "red").length;
  return blue <= red ? "blue" : "red";
}

function teamLabel(room, team, fallback) {
  if (room.rules?.gameMode === "solo") {
    const owner = room.players.get(team);
    return owner?.name || fallback || "No wing";
  }
  if (TEAM_NAMES[team]) return TEAM_NAMES[team];
  const owner = room.players.get(team);
  return owner?.name || fallback || "Solo";
}

function resetPlayerForMatch(room, player, now, options = {}) {
  const { buyShip } = require("./economy");
  for (const oldShip of player.ships) {
    oldShip.removed = true;
    room.ships.delete(oldShip.id);
  }
  player.ships = [];
  const startingMoney = room.rules?.startingMoney ?? ECONOMY.startingMoney;
  player.money = startingMoney;
  player.income = ECONOMY.baseIncome;
  player.earned = player.money;
  player.spent = 0;
  player.deployedFleetCost = 0;
  player.destroyedEnemyCost = 0;
  player.lostFleetCost = 0;
  player.lastReward = null;
  player.lastBuildError = "";
  if (player.purchaseRequests) player.purchaseRequests.clear();
  player.rallyPoint = null;
  room.bullets = room.bullets.filter((bullet) => bullet.ownerId !== player.id);
  if (options.spawn && player.ready) {
    buyShip(room, player, now, { starter: true });
  }
}

function resetRoundPlayerStats(player) {
  player.score = 0;
  player.kills = 0;
  player.losses = 0;
  player.captures = 0;
  player.destroyedEnemyCost = 0;
  player.lostFleetCost = 0;
  player.deployedFleetCost = 0;
  player.shipsBuilt = 0;
  player.lastReward = null;
  player.lastBuildError = "";
}

function maybeStartMatch(room, now) {
  if (room.phase !== "design") return;
  const { broadcastRoom, broadcastSnapshot } = require("./messages");
  const players = [...room.players.values()].filter((player) => !player.removed && !player.isBot ? (player.connected !== false || player.disconnectTimeout) : !player.removed);
  if (!players.length || players.some((player) => !player.ready)) return;
  room.phase = "active";
  room.winner = null;
  room.rewardsFinalizedForWinner = null;
  room.winnerAt = 0;
  room.matchStartedAt = now;
  room.controlVictory = {
    team: null,
    playerId: null,
    startedAt: null,
    remaining: null,
    requiredSeconds: 20
  };
  room.lastScoreAt = now;
  for (const player of players) {
    resetPlayerForMatch(room, player, now, { spawn: true });
  }
  broadcastRoom(room, { type: "notice", message: "All pilots ready. Match started." });
  broadcastSnapshot(room, now, true);
}

function startDesignPhase(room, requester) {
  const { sendPlayer, broadcastRoom, broadcastSnapshot } = require("./messages");
  if (!isAdmin(room, requester)) {
    sendPlayer(room, requester, { type: "error", message: "Only the room admin can start ship design" });
    return;
  }
  if (room.phase !== "lobby") {
    sendPlayer(room, requester, { type: "error", message: "Ship design has already started" });
    return;
  }
  if (room.players.size < 1) {
    sendPlayer(room, requester, { type: "error", message: "The room needs at least one player before ship design can start" });
    return;
  }

  const { prepareArenaForCurrentPlayers } = require("./rooms");
  prepareArenaForCurrentPlayers(room);
  room.phase = "design";
  room.winner = null;
  room.rewardsFinalizedForWinner = null;
  room.winnerAt = 0;
  room.controlVictory = {
    team: null,
    playerId: null,
    startedAt: null,
    remaining: null,
    requiredSeconds: 20
  };
  room.lastScoreAt = performanceNow();
  for (const player of room.players.values()) {
    resetRoundPlayerStats(player);
    player.ready = player.isBot;
    player.lastReadyAt = 0;
    resetPlayerForMatch(room, player, performanceNow(), { spawn: false });
  }
  broadcastRoom(room, { type: "notice", message: `Ship design started on ${room.mapSizeLabel} map` });
  broadcastSnapshot(room, performanceNow(), true);
  checkEmptyLobby(room);
}

function restartFromEnd(room, requester) {
  const { sendPlayer, broadcastRoom, broadcastSnapshot } = require("./messages");
  if (!isAdmin(room, requester)) {
    sendPlayer(room, requester, { type: "error", message: "Only the room admin can restart the match" });
    return;
  }
  if (room.phase !== "ended") {
    sendPlayer(room, requester, { type: "error", message: "Restart is available after the match ends" });
    return;
  }
  const { prepareArenaForCurrentPlayers } = require("./rooms");
  prepareArenaForCurrentPlayers(room);
  room.phase = "design";
  room.winner = null;
  room.rewardsFinalizedForWinner = null;
  room.winnerAt = 0;
  room.controlVictory = {
    team: null,
    playerId: null,
    startedAt: null,
    remaining: null,
    requiredSeconds: 20
  };
  room.lastScoreAt = performanceNow();
  for (const player of room.players.values()) {
    resetRoundPlayerStats(player);
    player.ready = player.isBot;
    resetPlayerForMatch(room, player, performanceNow(), { spawn: false });
  }
  broadcastRoom(room, { type: "notice", message: "New ship design phase started" });
  broadcastSnapshot(room, performanceNow(), true);
}

function returnToLobbyPhase(room, requester) {
  const { sendPlayer, broadcastRoom, broadcastSnapshot } = require("./messages");
  if (!isAdmin(room, requester)) {
    sendPlayer(room, requester, { type: "error", message: "Only the room admin can return to lobby" });
    return;
  }
  if (!["design", "active", "ended"].includes(room.phase)) {
    sendPlayer(room, requester, { type: "error", message: "Return to lobby is available after ship design starts" });
    return;
  }
  const notice = room.phase === "ended" ? "Returned to lobby" : "Lobby restarted";
  resetRoomToLobby(room, notice, broadcastRoom, broadcastSnapshot);
}

function resetRoomToLobby(room, notice, broadcastRoom, broadcastSnapshot) {
  room.phase = "lobby";
  room.winner = null;
  room.rewardsFinalizedForWinner = null;
  room.winnerAt = 0;
  for (const ship of room.ships.values()) {
    ship.removed = true;
  }
  room.ships.clear();
  room.drones = new Map();
  room.bullets = [];
  room.effects = [];
  room.controlVictory = {
    team: null,
    playerId: null,
    startedAt: null,
    remaining: null,
    requiredSeconds: 20
  };
  for (const player of room.players.values()) {
    resetRoundPlayerStats(player);
    player.ready = player.isBot;
    player.ships = [];
  }
  broadcastRoom(room, { type: "notice", message: notice });
  broadcastSnapshot(room, performanceNow(), true);
  checkEmptyLobby(room);
}

function checkEmptyLobby(room) {
  if (room.phase !== "lobby") {
    if (room.emptyLobbyTimeout) {
      clearTimeout(room.emptyLobbyTimeout);
      room.emptyLobbyTimeout = null;
    }
    return;
  }

  const hasHumans = [...room.players.values()].some(player => !player.isBot && (player.connected !== false || player.disconnectTimeout));

  if (hasHumans) {
    if (room.emptyLobbyTimeout) {
      clearTimeout(room.emptyLobbyTimeout);
      room.emptyLobbyTimeout = null;
    }
  } else if (!room.emptyLobbyTimeout) {
    room.emptyLobbyTimeout = setTimeout(() => {
      closeLobby(room, null);
    }, 10000);
  }
}

function closeLobby(room, requester) {
  const { sendPlayer, send } = require("./messages");
  if (requester !== null && !isAdmin(room, requester)) {
    sendPlayer(room, requester, { type: "error", message: "Only the room admin can close the lobby" });
    return;
  }
  if (room.emptyLobbyTimeout) {
    clearTimeout(room.emptyLobbyTimeout);
    room.emptyLobbyTimeout = null;
  }
  const code = room.code;
  const { rememberClosedRoom, rooms } = require("./rooms");
  rememberClosedRoom(code);
  for (const player of room.players.values()) {
    if (player.disconnectTimeout) clearTimeout(player.disconnectTimeout);
    player.resumeToken = null;
    player.removed = true;
    player.client = null;
  }
  for (const client of [...room.clients]) {
    send(client, { type: "closed", message: requester === null ? "Lobby closed due to inactivity" : "The room admin closed this lobby" });
    client.room = null;
    client.player = null;
  }
  room.clients.clear();
  room.players.clear();
  room.bullets = [];
  room.effects = [];
  rooms.delete(code);
}

module.exports = {
  joinRoom,
  leaveRoom,
  leaveLobby,
  kickPlayer,
  removePlayerFromRoom,
  ensureAdmin,
  isAdmin,
  sanitizeTeamForMode,
  isCurrentAttachment,
  findReservedNameOwner,
  normalizePlayerName,
  balanceTeam,
  teamLabel,
  resetPlayerForMatch,
  resetRoundPlayerStats,
  maybeStartMatch,
  startDesignPhase,
  restartFromEnd,
  returnToLobbyPhase,
  closeLobby
};
