const { clampNumber, performanceNow } = require("./utils");
const { validateClientMessage } = require("./clientSchemas");
const { negotiate, ERROR_CODES } = require("./protocol");
const { send, sendPlayer, broadcastRoom } = require("./outbound");
const { sendFullSnapshot, broadcastSnapshot } = require("./snapshotDelivery");
const { getRoute } = require("./routeRegistry");

const RATE_LIMITS = {
  frequent: { capacity: 90, refillPerSecond: 45, types: new Set(["command", "setCombatStyle", "setRallyPoint", "resetRallyPoint", "ping"]) },
  management: { capacity: 24, refillPerSecond: 4, types: new Set(["join", "deploy", "buyShip", "destruct", "setTeam", "addBot", "setRules", "setName", "startDesign", "kick", "restart", "returnToLobby", "restartLobby", "closeLobby", "leaveLobby", "requestFullState"]) }
};
function bucketForType(type) {
  if (RATE_LIMITS.frequent.types.has(type)) return "frequent";
  if (RATE_LIMITS.management.types.has(type)) return "management";
  return "management";
}
function checkRateLimit(client, type, now = Date.now()) {
  client.rateLimits ||= {};
  const key = bucketForType(type);
  const cfg = RATE_LIMITS[key];
  const bucket = client.rateLimits[key] ||= { tokens: cfg.capacity, updatedAt: now };
  const elapsed = Math.max(0, (now - bucket.updatedAt) / 1000);
  bucket.tokens = Math.min(cfg.capacity, bucket.tokens + elapsed * cfg.refillPerSecond);
  bucket.updatedAt = now;
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

function handleMessage(client, message) {
  const schema = validateClientMessage(message);
  if (!schema.ok) {
    send(client, { type: "error", code: schema.code, message: schema.message, requestId: message?.requestId });
    return;
  }

  const route = getRoute(message.type);
  if (!route) {
    send(client, { type: "error", code: "unknown-type", message: "Unknown message type", requestId: message?.requestId });
    return;
  }

  if (!checkRateLimit(client, message.type)) {
    send(client, { type: "error", code: "rate-limited", message: "Too many requests", requestId: message.requestId });
    return;
  }

  if (message.type === "ping") {
    send(client, { type: "pong", at: Number(message.at) || 0, clientPingNonce: message.clientPingNonce, serverTimeMs: Date.now() });
    return;
  }

  const { joinRoom, maybeStartMatch, balanceTeam, isAdmin, kickPlayer, restartFromEnd, returnToLobbyPhase, closeLobby, leaveLobby, startDesignPhase, isCurrentAttachment, findReservedNameOwner } = require("./players");
  const { validateDesign, validateWiring } = require("./shipDesign");
  const { validateBuildShip, sanitizeRequestId, sanitizeFormation, sanitizeTeam, sanitizeName, sanitizeCombatStyle } = require("./validation");
  const { buyShip, executePurchase } = require("./economy");
  const { commandShips } = require("./movement");
  const { requestSelfDestruct } = require("./combat");
  const { selectOwnedLivingShips } = require("./selection");
  const { addBot } = require("./ships");
  const { setRoomRules } = require("./rooms");

  if (message.type === "join") {
    const negotiated = negotiate(message);
    if (!negotiated.ok) {
      send(client, { type: "error", code: negotiated.code, message: negotiated.message, retryable: false, requestId: message.requestId });
      return;
    }
    client.protocol = { protocolVersion: message.protocolVersion, minProtocolVersion: message.minProtocolVersion, maxProtocolVersion: message.maxProtocolVersion, frontendBuildSha: message.frontendBuildSha || null, capabilities: message.capabilities || [] };
    joinRoom(client, message);
    return;
  }

  if (!client.room || !client.player) {
    send(client, { type: "error", code: ERROR_CODES.JOIN_REQUIRED, message: "Join a room first", requestId: message.requestId });
    return;
  }

  if (!isCurrentAttachment(client)) {
    send(client, { type: "error", code: ERROR_CODES.STALE_ATTACHMENT, message: "This connection is no longer active for that player", requestId: message.requestId });
    return;
  }

  if (message.type === "requestFullState") {
    const now = Date.now();
    client.lastFullStateRequestAt ||= 0;
    if (now - client.lastFullStateRequestAt < 1000) return;
    client.lastFullStateRequestAt = now;
    if (client.snapshotBaseline) client.snapshotBaseline.fullRequired = true;
    sendFullSnapshot(client, performanceNow(), message.reason || "client-request");
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
    // Server-side wiring normalization: only raw segments are accepted, and
    // networks/connectivity are re-derived — client results are never trusted.
    // A deploy without a wiring field keeps the player's previous wiring
    // (re-normalized against the new modules) instead of wiping it.
    client.player.wiring = validateWiring(design.modules, message.wiring !== undefined ? message.wiring : client.player.wiring).wiring;
    client.player.stats = design.stats;
    const combatStyle = sanitizeCombatStyle(message.combatStyle, sanitizeCombatStyle(client.player.combatStyle));
    client.player.combatStyle = combatStyle;

    if (process.env.NODE_ENV !== "production") {
      console.log(`[DEBUG] Deploy received from player ${client.player.id} with combatStyle: ${combatStyle}`);
    }

    if (client.room.phase === "active") {
      // Saving the editor blueprint during a live match updates only the future-purchase
      // design/style snapshot. Existing ships are immutable unless the explicit
      // setCombatStyle command targets deployed ships.
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
    const purchaseWiring = validateWiring(purchaseDesign.modules, message.wiring).wiring;
    if (message.wiring !== undefined) client.player.wiring = purchaseWiring;
    const result = executePurchase(client.room, client.player, {
      requestId,
      count,
      stats: purchaseDesign.stats,
      design: purchaseDesign.modules,
      wiring: purchaseWiring,
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
    const selected = selectOwnedLivingShips(client.player, Object.prototype.hasOwnProperty.call(message, "shipIds") ? message.shipIds : undefined);
    if (!selected.ok) return;
    let updatedCount = 0;
    for (const ship of selected.ships) {
      ship.combatStyle = combatStyle;
      ship.orbitDir = undefined;
      ship.lastOrbitTargetId = null;
      updatedCount++;
    }
    if (!selected.explicit) client.player.combatStyle = combatStyle;
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
    const shipIds = Object.prototype.hasOwnProperty.call(message, "shipIds") ? message.shipIds : undefined;
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
    require("./spawnPlanner").invalidateSpawnPlan(client.room);
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


module.exports = { handleMessage, checkRateLimit, RATE_LIMITS };
