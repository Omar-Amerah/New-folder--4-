// Handles WebSocket outbound payload framing, room-wide broadcasts, state snapshot multicasting, and inbound JSON message routing.

const { clampNumber, performanceNow } = require("./utils");

function send(client, data) {
  if (client.isClosed || client.socket.destroyed) return;
  try {
    const { writeFrame } = require("./websocketServer");
    writeFrame(client.socket, JSON.stringify(data));
  } catch {
    const { closeClient } = require("./websocketServer");
    closeClient(client, 1011, "Send failed");
  }
}

function sendPlayer(room, player, data) {
  const client = [...room.clients].find((candidate) => candidate.player?.id === player?.id);
  if (client) send(client, data);
}

function broadcastRoom(room, data) {
  for (const client of room.clients) send(client, data);
}

function broadcastSnapshot(room, now, forceStatic = false) {
  const { snapshotRoom } = require("./snapshots");
<<<<<<< HEAD
=======
  const sendStatic = !room.lastStaticSnapshotAt || now - room.lastStaticSnapshotAt > 2000;
  if (sendStatic) {
    room.lastStaticSnapshotAt = now;
  }
>>>>>>> bf9c0cd4fd11e61a49be55112e9e8f0915a6b916
  for (const client of room.clients) {
    send(client, snapshotRoom(room, now, client.player, forceStatic));
  }
}

function handleMessage(client, message) {
  if (!message || typeof message.type !== "string") return;

  if (message.type === "ping") {
    send(client, { type: "pong", at: Number(message.at) || 0, serverTime: Date.now() });
    return;
  }

  const { joinRoom, maybeStartMatch, balanceTeam, isAdmin, kickPlayer, restartFromEnd, closeLobby, leaveLobby, startDesignPhase } = require("./players");
  const { validateDesign } = require("./shipDesign");
  const { validateBuildShip, sanitizeRequestId, sanitizeFormation, sanitizeTeam, sanitizeName } = require("./validation");
  const { validateBuyShip, buyShip } = require("./economy");
  const { commandShips } = require("./movement");
  const { addBot } = require("./ships");
  const { setRoomRules } = require("./rooms");

  if (message.type === "join") {
    joinRoom(client, message);
    return;
  }

  if (!client.room || !client.player) {
    send(client, { type: "error", message: "Join a room first" });
    return;
  }

  if (message.type === "deploy") {
    if (client.room.phase !== "design" && client.room.phase !== "active") {
      send(client, { type: "error", message: "Ship designs can only be saved during design or active match phases" });
      return;
    }
    const design = validateDesign(message.design);
    if (!design.ok) {
      send(client, { type: "error", message: design.reason });
      return;
    }
    const validation = validateBuildShip(client.room, client.player, design.stats);
    if (client.room.phase === "design" && !validation.ok) {
      send(client, { type: "error", message: validation.reason });
      return;
    }
    client.player.design = design.modules;
    client.player.stats = design.stats;
    client.room.lastStaticSnapshotAt = 0;
    if (client.room.phase === "design") {
      client.player.ready = true;
      client.player.lastReadyAt = performanceNow();
      broadcastRoom(client.room, { type: "notice", message: `${client.player.name} is ready` });
      broadcastSnapshot(client.room, performanceNow(), true);
      maybeStartMatch(client.room, performanceNow());
    } else {
      send(client, { type: "notice", message: `Editor blueprint saved. Buy the current design from the bottom bar for $${design.stats.unitCost}.` });
    }
    return;
  }

  if (message.type === "buyShip") {
    const requestId = sanitizeRequestId(message.requestId);
    if (client.room.phase !== "active") {
      send(client, { type: "purchaseResult", ok: false, requestId, message: "Ships can only be built after the match starts" });
      return;
    }
    const count = clampNumber(message.count, 1, 5);
    const purchaseDesign = validateDesign(message.design);
    if (!purchaseDesign.ok) {
      send(client, { type: "purchaseResult", ok: false, requestId, message: purchaseDesign.reason });
      return;
    }
    const validation = validateBuyShip(client.room, client.player, count, purchaseDesign.stats);
    if (!validation.ok) {
      client.player.lastBuildError = validation.reason;
      send(client, { type: "purchaseResult", ok: false, requestId, message: validation.reason });
      return;
    }
    const createdShips = [];
    for (let i = 0; i < validation.count; i += 1) {
      const ship = buyShip(client.room, client.player, performanceNow(), {
        prevalidated: true,
        stats: validation.shipStats,
        design: purchaseDesign.modules,
        silent: true
      });
      if (ship) createdShips.push(ship);
    }
    send(client, {
      type: "purchaseResult",
      ok: true,
      requestId,
      count: createdShips.length,
      totalCost: validation.totalCost,
      shipIds: createdShips.map((ship) => ship.id),
      money: Math.floor(client.player.money)
    });
    broadcastRoom(client.room, {
      type: "notice",
      message: `${client.player.name} built ${createdShips.length} ship${createdShips.length === 1 ? "" : "s"} for $${validation.totalCost}`
    });
    broadcastSnapshot(client.room, performanceNow());
    return;
  }

  if (message.type === "command") {
    if (client.room.phase !== "active") return;
    const x = clampNumber(message.x, 0, client.room.world.width);
    const y = clampNumber(message.y, 0, client.room.world.height);
    commandShips(client.room, client.player, x, y, {
      shipIds: Array.isArray(message.shipIds) ? message.shipIds : null,
      targetId: typeof message.targetId === "string" ? message.targetId : null,
      formation: sanitizeFormation(message.formation)
    });
    return;
  }

  if (message.type === "setTeam") {
    if (client.room.phase !== "lobby") {
      send(client, { type: "error", message: "Wings can only be changed in the lobby before ship design" });
      return;
    }
    if (client.room.rules?.gameMode === "solo") {
      client.player.team = client.player.id;
      send(client, { type: "error", message: "Solo mode does not use team selection" });
      broadcastSnapshot(client.room, performanceNow(), true);
      return;
    }
    client.player.team = sanitizeTeam(message.team, balanceTeam(client.room));
    broadcastRoom(client.room, { type: "notice", message: `${client.player.name} changed wing` });
    broadcastSnapshot(client.room, performanceNow(), true);
    return;
  }

  if (message.type === "addBot") {
    if (!isAdmin(client.room, client.player)) {
      send(client, { type: "error", message: "Only the room admin can add bots" });
      return;
    }
    if (client.room.phase !== "lobby") {
      send(client, { type: "error", message: "Bots can only be added before ship design starts" });
      return;
    }
    addBot(client.room, client.player);
    return;
  }

  if (message.type === "setRules") {
    setRoomRules(client.room, client.player, message.rules || {});
    return;
  }

  if (message.type === "setName") {
    client.player.name = sanitizeName(message.name, client.player.name);
    return;
  }

  if (message.type === "startDesign") {
    startDesignPhase(client.room, client.player);
    return;
  }

  if (message.type === "kick") {
    kickPlayer(client.room, client.player, String(message.targetId || ""));
    return;
  }

  if (message.type === "restart") {
    restartFromEnd(client.room, client.player);
    return;
  }

  if (message.type === "closeLobby") {
    closeLobby(client.room, client.player);
    return;
  }

  if (message.type === "leaveLobby") {
    leaveLobby(client);
    return;
  }
}

module.exports = {
  send,
  sendPlayer,
  broadcastRoom,
  broadcastSnapshot,
  handleMessage
};
