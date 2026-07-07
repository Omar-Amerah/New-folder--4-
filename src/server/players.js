// Handles player join, leave, name updates, team assignment, re-connection matching, and admin promotion checks.

const { COLORS, ECONOMY, TEAM_NAMES, DEFAULT_DESIGN } = require("./config");
const { sanitizeName, sanitizeTeam } = require("./validation");
const { performanceNow } = require("./utils");

function joinRoom(client, message) {
  const { rooms, createRoom, isClosedRoomCode } = require("./rooms");
  const { sanitizeRoomCode } = require("./validation");
  const { send, broadcastRoom, broadcastSnapshot } = require("./messages");
  const { computeStats } = require("./shipStats");

  const requestedCode = sanitizeRoomCode(message.room);
  const code = requestedCode || require("./rooms").makeRoomCode();
  const requestedName = sanitizeName(message.name, `Pilot ${client.id.slice(1)}`);
  if (requestedCode && isClosedRoomCode(code)) {
    send(client, { type: "error", message: "That lobby was closed. Create a new game instead." });
    return;
  }

  let room = rooms.get(code);

  if (!room) {
    room = createRoom(code);
    rooms.set(code, room);
  }

  if (room.phase !== "lobby") {
    const existingPlayer = [...room.players.values()].find(
      (p) => p.name.toLowerCase() === requestedName.toLowerCase() && p.connected === false
    );
    if (!existingPlayer) {
      send(client, { type: "error", message: "That game has already started. Create a new room or wait for the next lobby." });
      return;
    }

    leaveRoom(client);

    const oldPlayerId = existingPlayer.id;
    client.room = room;
    client.player = existingPlayer;
    existingPlayer.id = client.id;
    existingPlayer.connected = true;
    room.clients.add(client);
    room.players.delete(oldPlayerId);
    room.players.set(client.id, existingPlayer);

    ensureAdmin(room);
    room.lastEmptyAt = 0;

    send(client, { type: "joined", id: client.id, room: room.code, world: room.world, map: room.map, phase: room.phase, adminId: room.adminId, rules: room.rules });
    broadcastRoom(room, { type: "notice", message: `${existingPlayer.name} reconnected` });
    broadcastSnapshot(room, performanceNow());
    return;
  }

  if (room.players.size >= room.rules.maxPlayers && !room.clients.has(client)) {
    send(client, { type: "error", message: "Room is full" });
    return;
  }

  if (room.kickedIds?.has(client.id) || room.kickedNames?.has(requestedName.toLowerCase())) {
    send(client, { type: "error", message: "You were kicked from this room by the host." });
    return;
  }

  leaveRoom(client);

  if (!room.playerColors) room.playerColors = new Map();
  let color = room.playerColors.get(requestedName.toLowerCase());
  if (!color) {
    color = COLORS[room.colorCursor % COLORS.length];
    room.colorCursor += 1;
    room.playerColors.set(requestedName.toLowerCase(), color);
  }

  const player = {
    id: client.id,
    name: requestedName,
    color,
    team: sanitizeTeamForMode(room, message.team, client.id),
    isBot: false,
    ai: null,
    ready: false,
    design: DEFAULT_DESIGN.map((part) => ({ ...part })),
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
    score: 0,
    kills: 0,
    losses: 0,
    captures: 0,
    connected: true,
    lastReadyAt: 0
  };

  client.room = room;
  client.player = player;
  room.clients.add(client);
  room.players.set(player.id, player);
  ensureAdmin(room);
  room.lastEmptyAt = 0;

  send(client, { type: "joined", id: client.id, room: room.code, world: room.world, map: room.map, phase: room.phase, adminId: room.adminId, rules: room.rules });
  broadcastRoom(room, { type: "notice", message: `${player.name} joined ${room.code}` });
}

function leaveRoom(client) {
  if (client.room && client.player) {
    const { room, player } = client;
    for (const ship of player.ships) {
      ship.alive = false;
      ship.removed = true;
      room.ships.delete(ship.id);
    }
    room.clients.delete(client);
    if (room.phase === "lobby") {
      room.players.delete(player.id);
    } else {
      player.connected = false;
    }
    room.bullets = room.bullets.filter((bullet) => bullet.ownerId !== player.id);
    if (room.clients.size === 0) {
      room.lastEmptyAt = Date.now();
    } else {
      const { broadcastRoom } = require("./messages");
      ensureAdmin(room);
      broadcastRoom(room, { type: "notice", message: `${player.name} left` });
      if (room.phase === "design") {
        const { maybeStartMatch } = require("./players");
        maybeStartMatch(room, performanceNow());
      }
    }
  }

  client.room = null;
  client.player = null;
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
  leaveRoom(client);
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
  room.kickedIds.add(target.id);
  room.kickedNames.add(target.name.toLowerCase());
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
  room.players.delete(player.id);
  room.bullets = room.bullets.filter((bullet) => bullet.ownerId !== player.id);
  for (const point of room.points) {
    if (point.ownerId === player.id) {
      point.ownerId = null;
      point.ownerTeam = null;
      point.progress = 0;
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
    }
  }

  ensureAdmin(room);
}

function ensureAdmin(room) {
  if (room.adminId && room.players.has(room.adminId) && !room.players.get(room.adminId).isBot && room.players.get(room.adminId).connected !== false) return;
  const nextAdmin = [...room.players.values()].find((player) => !player.isBot && player.connected !== false);
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
  player.lastReward = null;
  player.lastBuildError = "";
}

function maybeStartMatch(room, now) {
  if (room.phase !== "design") return;
  const { broadcastRoom } = require("./messages");
  const players = [...room.players.values()].filter((player) => player.connected !== false);
  if (!players.length || players.some((player) => !player.ready)) return;
  room.phase = "active";
  room.winner = null;
  room.winnerAt = 0;
  room.lastScoreAt = now;
  for (const player of players) {
    resetPlayerForMatch(room, player, now, { spawn: true });
  }
  broadcastRoom(room, { type: "notice", message: "All pilots ready. Match started." });
}

function startDesignPhase(room, requester) {
  const { sendPlayer, broadcastRoom } = require("./messages");
  if (!isAdmin(room, requester)) {
    sendPlayer(room, requester, { type: "error", message: "Only the room admin can start ship design" });
    return;
  }
  if (room.phase !== "lobby") {
    sendPlayer(room, requester, { type: "error", message: "Ship design has already started" });
    return;
  }
  if (room.players.size < 1) return;

  const { prepareArenaForCurrentPlayers } = require("./rooms");
  prepareArenaForCurrentPlayers(room);
  room.phase = "design";
  room.winner = null;
  room.winnerAt = 0;
  room.lastScoreAt = performanceNow();
  for (const player of room.players.values()) {
    resetRoundPlayerStats(player);
    player.ready = player.isBot;
    player.lastReadyAt = 0;
    resetPlayerForMatch(room, player, performanceNow(), { spawn: false });
  }
  broadcastRoom(room, { type: "notice", message: `Ship design started on ${room.mapSizeLabel} map` });
}

function restartFromEnd(room, requester) {
  const { sendPlayer, broadcastRoom } = require("./messages");
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
  room.winnerAt = 0;
  room.lastScoreAt = performanceNow();
  for (const player of room.players.values()) {
    resetRoundPlayerStats(player);
    player.ready = player.isBot;
    resetPlayerForMatch(room, player, performanceNow(), { spawn: false });
  }
  broadcastRoom(room, { type: "notice", message: "New ship design phase started" });
}

function closeLobby(room, requester) {
  const { sendPlayer, send } = require("./messages");
  if (!isAdmin(room, requester)) {
    sendPlayer(room, requester, { type: "error", message: "Only the room admin can close the lobby" });
    return;
  }
  const code = room.code;
  const { rememberClosedRoom, rooms } = require("./rooms");
  rememberClosedRoom(code);
  for (const client of [...room.clients]) {
    send(client, { type: "closed", message: "The room admin closed this lobby" });
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
  balanceTeam,
  teamLabel,
  resetPlayerForMatch,
  resetRoundPlayerStats,
  maybeStartMatch,
  startDesignPhase,
  restartFromEnd,
  closeLobby
};

