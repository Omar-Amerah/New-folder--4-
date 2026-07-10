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

  if (!requestedCode) {
    for (const existingRoom of Array.from(rooms.values())) {
      if (existingRoom.adminId) {
        const adminPlayer = existingRoom.players.get(existingRoom.adminId);
        if (adminPlayer && adminPlayer.name.toLowerCase() === requestedName.toLowerCase()) {
          closeLobby(existingRoom, adminPlayer);
        }
      }
    }
  }
  if (requestedCode && isClosedRoomCode(code)) {
    send(client, { type: "error", message: "That lobby was closed. Create a new game instead." });
    return;
  }

  let room = rooms.get(code);

  if (!room) {
    room = createRoom(code);
    rooms.set(code, room);
  }

  let existingPlayer = [...room.players.values()].find(
    (p) => p.name.toLowerCase() === requestedName.toLowerCase() && p.connected === false
  );

  // A fast page refresh during an active game often races ahead of the old
  // socket's close, so the previous player is still marked connected when the
  // rejoin arrives. Reclaim that slot instead of rejecting the returning player
  // with "game already started".
  if (!existingPlayer && room.phase !== "lobby") {
    const stale = [...room.players.values()].find(
      (p) => p.name.toLowerCase() === requestedName.toLowerCase() && p.connected === true
    );
    if (stale) {
      for (const oldClient of [...room.clients]) {
        if (oldClient !== client && oldClient.player === stale) {
          // Detach first so the orphaned socket's eventual close does not tear
          // down the slot we are reclaiming.
          oldClient.room = null;
          oldClient.player = null;
          room.clients.delete(oldClient);
          try { oldClient.socket.destroy(); } catch { /* already gone */ }
        }
      }
      if (stale.disconnectTimeout) {
        clearTimeout(stale.disconnectTimeout);
        stale.disconnectTimeout = null;
      }
      stale.connected = false;
      existingPlayer = stale;
    }
  }

  if (existingPlayer) {
    leaveRoom(client);

    const oldPlayerId = existingPlayer.id;
    client.room = room;
    client.player = existingPlayer;
    existingPlayer.id = client.id;
    existingPlayer.connected = true;

    // Clear out any pending deletion timeout if they rejoined in the lobby
    if (existingPlayer.disconnectTimeout) {
      clearTimeout(existingPlayer.disconnectTimeout);
      existingPlayer.disconnectTimeout = null;
    }

    room.clients.add(client);
    room.players.delete(oldPlayerId);
    room.players.set(client.id, existingPlayer);

    // If the reconnected player was admin, their admin ID needs to match their new client ID
    if (room.adminId === oldPlayerId) {
      room.adminId = client.id;
    } else {
      ensureAdmin(room);
    }

    room.lastEmptyAt = 0;

    send(client, { type: "joined", id: client.id, room: room.code, world: room.world, map: room.map, phase: room.phase, adminId: room.adminId, rules: room.rules });
    broadcastRoom(room, { type: "notice", message: `${existingPlayer.name} reconnected` });
    broadcastSnapshot(room, performanceNow(), true);
  checkEmptyLobby(room);
    return;
  }

  if (room.phase !== "lobby") {
    send(client, { type: "error", message: "That game has already started. Create a new room or wait for the next lobby." });
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
  broadcastSnapshot(room, performanceNow(), true);
  checkEmptyLobby(room);
}

function leaveRoom(client, explicitLeave = false) {
  if (client.room && client.player) {
    const { room, player } = client;
    for (const ship of player.ships) {
      ship.alive = false;
      ship.removed = true;
      room.ships.delete(ship.id);
    }
    player.ships = [];
    room.clients.delete(client);

    player.connected = false;

    if (explicitLeave) {
      room.players.delete(player.id);
      if (room.adminId === player.id) {
        room.adminId = null;
      }
    } else {
      // Give them a grace period to reconnect if they refreshed
      player.disconnectTimeout = setTimeout(() => {
        if (!player.connected && room.players.has(player.id)) {
          room.players.delete(player.id);
          if (room.adminId === player.id) {
            room.adminId = null;
            ensureAdmin(room);
          }
          if (room.clients.size > 0) {
            const { broadcastSnapshot } = require("./messages");
            broadcastSnapshot(room, performanceNow(), true);
          }
          checkEmptyLobby(room);
        }
      }, 5000);
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

  if (client.room) checkEmptyLobby(client.room);
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
  player.ships = [];
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
  const players = [...room.players.values()].filter((player) => player.connected !== false);
  if (!players.length || players.some((player) => !player.ready)) return;
  room.phase = "active";
  room.winner = null;
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
  if (room.players.size < 1) return;

  const { prepareArenaForCurrentPlayers } = require("./rooms");
  prepareArenaForCurrentPlayers(room);
  room.phase = "design";
  room.winner = null;
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
  if (room.phase !== "ended") {
    sendPlayer(room, requester, { type: "error", message: "Return to lobby is available after the match ends" });
    return;
  }

  room.phase = "lobby";
  room.winner = null;
  room.winnerAt = 0;
  for (const ship of room.ships.values()) {
    ship.removed = true;
  }
  room.ships.clear();
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
  broadcastRoom(room, { type: "notice", message: "Returned to lobby" });
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

