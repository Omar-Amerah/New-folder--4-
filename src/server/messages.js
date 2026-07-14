// Handles WebSocket outbound payload framing, room-wide broadcasts, state snapshot multicasting, and inbound JSON message routing.

const { clampNumber, performanceNow } = require("./utils");
const { encodeMessage } = require("./wsCodec");

// Binary WebSocket opcode (0x2) — outbound game data is MessagePack, not text.
const BINARY_OPCODE = 0x2;
let cachedWriteFrame = null;
let cachedCloseClient = null;

function getWriteFrame() {
  if (!cachedWriteFrame) ({ writeFrame: cachedWriteFrame } = require("./websocketServer"));
  return cachedWriteFrame;
}

function getCloseClient() {
  if (!cachedCloseClient) ({ closeClient: cachedCloseClient } = require("./websocketServer"));
  return cachedCloseClient;
}

function send(client, data) {
  sendRaw(client, encodeMessage(data));
}

// `payload` is a pre-encoded MessagePack Buffer (encode once, fan out to many).
function sendRaw(client, payload) {
  if (client.isClosed || client.socket.destroyed) return;
  try {
    getWriteFrame()(client.socket, payload, BINARY_OPCODE);
  } catch {
    getCloseClient()(client, 1011, "Send failed");
  }
}

function sendPlayer(room, player, data) {
  for (const client of room.clients) {
    if (client.player?.id === player?.id) {
      send(client, data);
      return;
    }
  }
}

function broadcastRoom(room, data) {
  const payload = encodeMessage(data);
  for (const client of room.clients) sendRaw(client, payload);
}

function broadcastSnapshot(room, now, forceStatic = false) {
  if (room.clients.size === 0) return;
  const { snapshotRoom, buildSharedSnapshot, markShipDesignsSent } = require("./snapshots");

  // Everything except per-player economy visibility is identical for all viewers,
  // and economy visibility only depends on the viewer's team — so build the bulky
  // shared arrays once and serialize once per team instead of once per client.
  const shared = buildSharedSnapshot(room, now, forceStatic);
  const byTeam = new Map();
  for (const client of room.clients) {
    const key = client.player ? `t:${client.player.team}` : "spectator";
    let payload = byTeam.get(key);
    if (payload === undefined) {
      payload = encodeMessage(snapshotRoom(room, now, client.player, forceStatic, shared));
      byTeam.set(key, payload);
    }
    sendRaw(client, payload);
  }
  markShipDesignsSent(room);
}

function handleMessage(client, message) {
  if (!message || typeof message.type !== "string") return;

  if (message.type === "ping") {
    send(client, { type: "pong", at: Number(message.at) || 0, serverTime: Date.now() });
    return;
  }

  const { joinRoom, maybeStartMatch, balanceTeam, isAdmin, kickPlayer, restartFromEnd, returnToLobbyPhase, closeLobby, leaveLobby, startDesignPhase, isCurrentAttachment, findReservedNameOwner } = require("./players");
  const { validateDesign } = require("./shipDesign");
  const { validateBuildShip, sanitizeRequestId, sanitizeFormation, sanitizeTeam, sanitizeName, sanitizeCombatStyle } = require("./validation");
  const { buyShip, executePurchase } = require("./economy");
  const { commandShips } = require("./movement");
  const { requestSelfDestruct } = require("./combat");
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

  if (!isCurrentAttachment(client)) {
    send(client, { type: "error", message: "This connection is no longer active for that player" });
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
    const combatStyle = sanitizeCombatStyle(message.combatStyle, sanitizeCombatStyle(client.player.combatStyle));
    client.player.combatStyle = combatStyle;

    if (process.env.NODE_ENV !== "production") {
      console.log(`[DEBUG] Deploy received from player ${client.player.id} with combatStyle: ${combatStyle}`);
    }

    if (client.room.phase === "active") {
      let updatedCount = 0;
      for (const ship of client.player.ships) {
        if (!ship.alive) continue;
        ship.combatStyle = combatStyle;
        ship.orbitDir = undefined;
        ship.lastOrbitTargetId = null;
        updatedCount++;
      }
      if (process.env.NODE_ENV !== "production") {
        console.log(`[DEBUG] Updated combatStyle of ${updatedCount} live ships for player ${client.player.id} to: ${combatStyle}`);
      }
      broadcastSnapshot(client.room, performanceNow(), true);
    }

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
    if (!requestId) {
      send(client, { type: "purchaseResult", ok: false, requestId, code: "invalid-request", message: "Invalid purchase request" });
      return;
    }
    const now = performanceNow();
    const count = clampNumber(message.count, 1, 5);
    const purchaseDesign = validateDesign(message.design);
    if (!purchaseDesign.ok) {
      send(client, { type: "purchaseResult", ok: false, requestId, code: "invalid-design", message: purchaseDesign.reason });
      return;
    }
    const combatStyle = sanitizeCombatStyle(message.combatStyle, client.player.combatStyle || "sentry");
    const result = executePurchase(client.room, client.player, {
      requestId,
      count,
      stats: purchaseDesign.stats,
      design: purchaseDesign.modules,
      combatStyle
    }, now);
    send(client, result);
    if (!result.ok || result.duplicate) return;
    broadcastRoom(client.room, {
      type: "notice",
      message: `${client.player.name} built ${result.count} ship${result.count === 1 ? "" : "s"}`
    });
    broadcastSnapshot(client.room, now);
    return;
  }

  if (message.type === "setCombatStyle") {
    if (client.room.phase !== "active") return;
    const combatStyle = sanitizeCombatStyle(message.combatStyle, client.player.combatStyle || "sentry");
    const shipIdSet = Array.isArray(message.shipIds)
      ? new Set(message.shipIds.map((id) => String(id)).slice(0, 64))
      : null;
    let updatedCount = 0;
    for (const ship of client.player.ships) {
      if (!ship.alive) continue;
      if (shipIdSet && shipIdSet.size > 0 && !shipIdSet.has(ship.id)) continue;
      ship.combatStyle = combatStyle;
      ship.orbitDir = undefined;
      ship.lastOrbitTargetId = null;
      updatedCount++;
    }
    if (!shipIdSet || shipIdSet.size === 0) client.player.combatStyle = combatStyle;
    if (updatedCount > 0) broadcastSnapshot(client.room, performanceNow());
    return;
  }

  if (message.type === "setRallyPoint") {
    if (client.room.phase !== "active") return;
    const x = clampNumber(message.x, 0, client.room.world.width);
    const y = clampNumber(message.y, 0, client.room.world.height);
    const { nearestClearPoint } = require("./movement");
    client.player.rallyPoint = nearestClearPoint(client.room, x, y, 48);
    broadcastSnapshot(client.room, performanceNow());
    return;
  }

  if (message.type === "resetRallyPoint") {
    if (client.room.phase !== "active") return;
    client.player.rallyPoint = null;
    broadcastSnapshot(client.room, performanceNow());
    return;
  }

  if (message.type === "command") {
    if (client.room.phase !== "active") return;
    const x = clampNumber(message.x, 0, client.room.world.width);
    const y = clampNumber(message.y, 0, client.room.world.height);
    commandShips(client.room, client.player, x, y, {
      shipIds: Object.prototype.hasOwnProperty.call(message, "shipIds") ? message.shipIds : undefined,
      targetId: typeof message.targetId === "string" ? message.targetId : null,
      formation: sanitizeFormation(message.formation)
    });
    return;
  }

  if (message.type === "destruct") {
    if (client.room.phase !== "active") return;
    const shipIds = Array.isArray(message.shipIds) ? message.shipIds.slice(0, 64) : null;
    requestSelfDestruct(client.room, client.player, shipIds, performanceNow());
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
    const oldName = client.player.name;
    const nextName = sanitizeName(message.name, client.player.name);
    if (findReservedNameOwner(client.room, nextName, client.player.id)) {
      send(client, { type: "error", message: "Name already in use" });
      return;
    }
    client.player.name = nextName;
    if (oldName !== client.player.name) {
      broadcastRoom(client.room, { type: "notice", message: `${oldName} changed name to ${client.player.name}` });
      broadcastSnapshot(client.room, performanceNow(), true);
    }
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

  if (message.type === "returnToLobby" || message.type === "restartLobby") {
    returnToLobbyPhase(client.room, client.player);
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
