const { clampNumber, performanceNow } = require("./utils");
const { gameplayNow } = require("./gameplayTime");
const { SNAPSHOT_HZ } = require("./config");
const { validateClientMessage } = require("./clientSchemas");
const { negotiate, ERROR_CODES } = require("./protocol");
const { send, sendPlayer, broadcastRoom } = require("./outbound");
const { sendFullSnapshot, broadcastSnapshot } = require("./snapshotDelivery");
const { initializeClient } = require("./projectileReplication");
const { getRoute } = require("./routeRegistry");
const { invalidateRelationshipCache, isTelemetryFocusEligible, revalidateTelemetryFocusForRoom } = require("./relationships");

const RATE_LIMITS = {
  frequent: { capacity: 90, refillPerSecond: 45, types: new Set(["command", "stop", "rotate", "setCombatStyle", "setOrbitDirection", "setTelemetryFocus", "setRallyPoint", "resetRallyPoint", "ping"]) },
  management: { capacity: 24, refillPerSecond: 4, types: new Set(["join", "ready", "deploy", "buyShip", "destruct", "setTeam", "addBot", "setRules", "setName", "startDesign", "kick", "restart", "returnToLobby", "restartLobby", "closeLobby", "leaveLobby", "requestFullState"]) }
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
  const { recordPurchaseStage } = require("./performanceTelemetry");
  const { computeStats } = require("./shipStats");
  const { validateBuildShip, sanitizeRequestId, sanitizeTeam, sanitizeName, sanitizeCombatStyle, sanitizeMovementToggles, sanitizeOrbitDirection } = require("./validation");
  const { buyShip, executePurchase } = require("./economy");
  const { applyCombatStyle, applyMovementToggles, applyOrbitDirection, commandShips, stopShips, rotateShips } = require("./movement");
  const { requestSelfDestruct } = require("./combat");
  const { MAX_COMBAT_SELECTED_SHIP_IDS, selectOwnedLivingShips } = require("./selection");
  const { addBot } = require("./ships");
  const { setRoomRules } = require("./rooms");

  if (message.type === "join") {
    const negotiated = negotiate(message);
    if (!negotiated.ok) {
      send(client, { type: "error", code: negotiated.code, message: negotiated.message, retryable: false, requestId: message.requestId });
      return;
    }
    client.protocol = { protocolVersion: message.protocolVersion, minProtocolVersion: message.minProtocolVersion, maxProtocolVersion: message.maxProtocolVersion, frontendBuildSha: message.frontendBuildSha || null, capabilities: message.capabilities || [] };
    // Older protocol-4 clients do not report selection focus. Preserve their
    // historical all-detail snapshots until they refresh to the focused stream.
    client.telemetryFocusShipId = client.protocol.capabilities.includes("telemetry-focus-v1") ? null : undefined;
    client.telemetryLastWrittenFocusId = null;
    client.telemetryLastWrittenAt = 0;
    joinRoom(client, message);
    if (client.room) initializeClient(client, client.room, true);
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

  const markReady = (notice = "Ready confirmed — the match starts as soon as every pilot is ready.") => {
    if (client.room.phase !== "design") {
      send(client, { type: "error", message: "You can only ready up during ship design" });
      return;
    }
    if (client.player.ready) return;
    client.player.ready = true;
    client.player.lastReadyAt = performanceNow();
    client.room.lastStaticSnapshotAt = 0;
    send(client, { type: "notice", message: notice });
    broadcastRoom(client.room, { type: "notice", message: `${client.player.name} is ready` });
    broadcastSnapshot(client.room, performanceNow(), true);
    maybeStartMatch(client.room, performanceNow());
  };

  if (message.type === "ready") {
    markReady();
    return;
  }

  if (message.type === "deploy") {
    if (client.room.phase !== "design" && client.room.phase !== "active") {
      send(client, { type: "error", message: "Ship designs can only be saved during design or active match phases" });
      return;
    }
    // Older clients used deploy as their Ready Up action. Preserve that wire
    // contract without bringing ship validation back into readiness; only an
    // active-match deploy is a blueprint save and therefore needs validation.
    if (client.room.phase === "design") {
      markReady("Design saved — you are ready. The match starts as soon as every pilot is ready.");
      return;
    }
    const design = validateDesign(message.design);
    if (!design.ok) {
      send(client, { type: "error", message: design.reason });
      return;
    }
    // Server-side wiring normalization: only raw segments are accepted, and
    // networks/connectivity are re-derived — client results are never trusted.
    // A deploy without a wiring field keeps the player's previous wiring
    // (re-normalized against the new modules) instead of wiping it. Stats are
    // recomputed WITH the normalized wiring so infrastructure cost is part of
    // the authoritative price and affordability check.
    const deployWiring = validateWiring(design.modules, message.wiring !== undefined ? message.wiring : client.player.wiring).wiring;
    const deployStats = computeStats(design.modules, deployWiring);
    const validation = validateBuildShip(client.room, client.player, deployStats);
    if (!validation.ok) {
      send(client, { type: "error", message: validation.reason });
      return;
    }
    client.player.design = design.modules;
    client.player.wiring = deployWiring;
    client.player.dataLinks = require("../../public/src/shared/dataSupportRules").normalizeDataLinks(design.modules, message.dataLinks || [], require("./components").PARTS);
    client.player.stats = deployStats;
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
    send(client, { type: "notice", message: `Editor blueprint saved. Buy the current design from the bottom bar for $${deployStats.unitCost}.` });
    return;
  }

  if (message.type === "buyShip") {
    const requestId = sanitizeRequestId(message.requestId);
    if (!requestId) {
      send(client, { type: "purchaseResult", ok: false, requestId, code: "invalid-request", message: "Invalid purchase request" });
      return;
    }
    const now = gameplayNow(client.room, performanceNow());
    const count = clampNumber(message.count, 1, 5);
    const purchaseDesign = validateDesign(message.design);
    if (!purchaseDesign.ok) {
      send(client, { type: "purchaseResult", ok: false, requestId, code: "invalid-design", message: purchaseDesign.reason });
      return;
    }
    const combatStyleRaw = message.combatStyle || client.player.combatStyle;
    const combatStyle = sanitizeCombatStyle(combatStyleRaw, client.player.combatStyle || "hold");
    const purchaseWiring = validateWiring(purchaseDesign.modules, message.wiring).wiring;
    if (message.wiring !== undefined) client.player.wiring = purchaseWiring;
    // Affordability and the deducted cost must include infrastructure, so stats
    // are recomputed against the normalized purchase wiring.
    const purchaseStats = computeStats(purchaseDesign.modules, purchaseWiring);
    const result = executePurchase(client.room, client.player, {
      requestId,
      count,
      stats: purchaseStats,
      design: purchaseDesign.modules,
      wiring: purchaseWiring,
      combatStyle,
      combatStyleRaw
    }, now);
    const sendStart = performance.now();
    send(client, result);
    recordPurchaseStage("purchaseResultSendTime", performance.now() - sendStart);
    if (!result.ok || result.duplicate) return;
    broadcastRoom(client.room, {
      type: "notice",
      message: `${client.player.name} built ${result.count} ship${result.count === 1 ? "" : "s"}`
    });
    
    // Coalesce snapshot: mark room for snapshot and let the regular scheduler
    // deliver it. If the next scheduled snapshot is too far away, arm a fallback
    // timer; any delivered snapshot clears this timer to prevent duplicates.
    client.room._pendingSnapshot = true;
    client.room._pendingSnapshotAt = now;

    const SNAPSHOT_INTERVAL_MS = 1000 / Math.max(1, SNAPSHOT_HZ);
    const FALLBACK_THRESHOLD_MS = 50;
    const timeToNext = client.room._nextScheduledSnapshotAt
      ? Math.max(0, client.room._nextScheduledSnapshotAt - now)
      : SNAPSHOT_INTERVAL_MS;

    if (!client.room._snapshotCoalesceTimer && timeToNext > FALLBACK_THRESHOLD_MS) {
      // Fire just before the next regular snapshot would arrive so the fallback
      // bridges the latency gap without racing the scheduler.
      const fallbackDelay = Math.min(FALLBACK_THRESHOLD_MS, timeToNext);
      client.room._snapshotCoalesceTimer = setTimeout(() => {
        client.room._snapshotCoalesceTimer = null;
        if (client.room._pendingSnapshot) {
          const snapshotStart = performance.now();
          broadcastSnapshot(client.room, client.room._pendingSnapshotAt);
          recordPurchaseStage("postPurchaseSnapshotConstruction", performance.now() - snapshotStart);
        }
      }, fallbackDelay);
      client.room._snapshotCoalesceTimer.unref?.();
    }
    
    return;
  }

  if (message.type === "setMovementToggles") {
    const requestId = message.requestId || null;
    if (client.room.phase !== "active") {
      send(client, { type: "movementTogglesResult", requestId, ok: false, code: "wrong-phase", message: "Movement toggles can only be changed during an active match." });
      return;
    }
    const scope = message.scope || null;
    const selectedOptions = scope ? { scope } : { max: MAX_COMBAT_SELECTED_SHIP_IDS };
    const selected = selectOwnedLivingShips(client.player, scope ? undefined : message.shipIds, selectedOptions);
    if (!selected.ok) {
      send(client, { type: "movementTogglesResult", requestId, ok: false, code: selected.code || "invalid-selection", message: "Invalid ship selection for movement toggles." });
      return;
    }
    const updatedShipIds = [];
    let applied = null;
    for (const ship of selected.ships) {
      // Merged per ship, so toggling one checkbox over a mixed selection does
      // not quietly overwrite the settings each hull already had.
      applied = applyMovementToggles(ship, message.toggles);
      updatedShipIds.push(ship.id);
    }
    if (updatedShipIds.length === 0) {
      send(client, { type: "movementTogglesResult", requestId, ok: false, code: "no-authorized-ships", message: "No owned living ships matched the movement toggle request." });
      return;
    }
    // A selection-wide change also becomes the player's default for new hulls,
    // matching how the combat stance behaves.
    if (!selected.explicit) {
      client.player.movementToggles = sanitizeMovementToggles(message.toggles, client.player.movementToggles);
    }
    broadcastSnapshot(client.room, performanceNow());
    send(client, { type: "movementTogglesResult", requestId, ok: true, toggles: applied, updatedCount: updatedShipIds.length, updatedShipIds });
    return;
  }

  if (message.type === "setCombatStyle") {
    const requestId = message.requestId || null;
    if (client.room.phase !== "active") {
      send(client, { type: "combatStyleResult", requestId, ok: false, code: "wrong-phase", message: "Combat style can only be changed during an active match." });
      return;
    }
    const combatStyle = sanitizeCombatStyle(message.combatStyle, client.player.combatStyle || "hold");
    const scope = message.scope || null;
    const selectedOptions = scope ? { scope } : { max: MAX_COMBAT_SELECTED_SHIP_IDS };
    const selected = selectOwnedLivingShips(client.player, scope ? undefined : message.shipIds, selectedOptions);
    if (!selected.ok) {
      send(client, { type: "combatStyleResult", requestId, ok: false, code: selected.code || "invalid-selection", message: "Invalid ship selection for combat style." });
      return;
    }
    // An Orbit selection may name the direction to start in. Omitted, each ship
    // keeps the way round it already had, which is what makes switching to Hold
    // and back restore the direction rather than reset it.
    const requestedDirection = message.orbitDirection === undefined
      ? undefined
      : sanitizeOrbitDirection(message.orbitDirection);
    let updatedCount = 0;
    const updatedShipIds = [];
    for (const ship of selected.ships) {
      applyCombatStyle(ship, combatStyle, requestedDirection);
      updatedCount++;
      updatedShipIds.push(ship.id);
    }
    if (updatedCount === 0) {
      send(client, { type: "combatStyleResult", requestId, ok: false, code: "no-authorized-ships", message: "No owned living ships matched the style request." });
      return;
    }
    if (!selected.explicit) client.player.combatStyle = combatStyle;
    if (!selected.explicit && requestedDirection !== undefined) client.player.orbitDirection = requestedDirection;
    broadcastSnapshot(client.room, performanceNow());
    send(client, { type: "combatStyleResult", requestId, ok: true, combatStyle, orbitDirection: requestedDirection ?? null, updatedCount, updatedShipIds });
    return;
  }

  // Direction only. This deliberately does not go through the combat-style
  // handler: reissuing the stance would clear each ship's Hold facing and
  // engagement latches, and a player flipping C to AC mid-fight has not asked
  // for their ships to let go of anything.
  if (message.type === "setOrbitDirection") {
    const requestId = message.requestId || null;
    if (client.room.phase !== "active") {
      send(client, { type: "orbitDirectionResult", requestId, ok: false, code: "wrong-phase", message: "Orbit direction can only be changed during an active match." });
      return;
    }
    const orbitDirection = sanitizeOrbitDirection(message.orbitDirection);
    const scope = message.scope || null;
    const selectedOptions = scope ? { scope } : { max: MAX_COMBAT_SELECTED_SHIP_IDS };
    const selected = selectOwnedLivingShips(client.player, scope ? undefined : message.shipIds, selectedOptions);
    if (!selected.ok) {
      send(client, { type: "orbitDirectionResult", requestId, ok: false, code: selected.code || "invalid-selection", message: "Invalid ship selection for orbit direction." });
      return;
    }
    const updatedShipIds = [];
    for (const ship of selected.ships) {
      applyOrbitDirection(ship, orbitDirection);
      updatedShipIds.push(ship.id);
    }
    if (updatedShipIds.length === 0) {
      send(client, { type: "orbitDirectionResult", requestId, ok: false, code: "no-authorized-ships", message: "No owned living ships matched the orbit direction request." });
      return;
    }
    if (!selected.explicit) client.player.orbitDirection = orbitDirection;
    broadcastSnapshot(client.room, performanceNow());
    send(client, { type: "orbitDirectionResult", requestId, ok: true, orbitDirection, updatedCount: updatedShipIds.length, updatedShipIds });
    return;
  }

  if (message.type === "setDroneBayMode") {
    if (client.room.phase !== "active") return;
    const now = gameplayNow(client.room, performanceNow());
    const changed = require("./drones").setDroneBayMode(client.room, client.player, message.shipId, message.componentId, message.mode, now);
    if (changed) broadcastSnapshot(client.room, now);
    return;
  }

  if (message.type === "setTelemetryFocus") {
    let shipId = typeof message.shipId === "string" ? message.shipId : null;
    if (shipId && !isTelemetryFocusEligible(client, shipId, client.room)) shipId = null;
    if (client.telemetryFocusShipId !== shipId) {
      client.telemetryFocusShipId = shipId;
      client.telemetryLastWrittenFocusId = null;
      client.telemetryLastWrittenAt = 0;
    }
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
      finalFacing: Number.isFinite(message.finalFacing) ? message.finalFacing : null,
      formation: typeof message.formation === "string" ? message.formation : null,
      direction: Number.isFinite(message.direction) ? message.direction : null
    });
    return;
  }

  if (message.type === "destruct") {
    if (client.room.phase !== "active") return;
    const shipIds = Object.prototype.hasOwnProperty.call(message, "shipIds") ? message.shipIds : undefined;
    requestSelfDestruct(client.room, client.player, shipIds, gameplayNow(client.room, performanceNow()));
    return;
  }

  if (message.type === "stop") {
    if (client.room.phase !== "active") return;
    const shipIds = Object.prototype.hasOwnProperty.call(message, "shipIds") ? message.shipIds : undefined;
    stopShips(client.room, client.player, shipIds);
    return;
  }

  if (message.type === "rotate") {
    if (client.room.phase !== "active") return;
    const shipIds = Object.prototype.hasOwnProperty.call(message, "shipIds") ? message.shipIds : undefined;
    rotateShips(client.room, client.player, {
      direction: message.direction,
      active: message.active,
      shipIds
    });
    return;
  }

  if (message.type === "setTeam") {
    if (client.room.phase !== "lobby") {
      send(client, { type: "error", message: "Wings can only be changed in the lobby before ship design" });
      return;
    }
    const previousTeam = client.player.team;
    if (client.room.rules?.gameMode === "solo") {
      // The lobby UI hides the wing selector in solo mode, so this is only
      // reachable from non-UI clients — answer informatively, not as an error.
      client.player.team = client.player.id;
      invalidateRelationshipCache(client.room);
      require("./commandAuras").invalidateCommandAuraAllegiance(client.room, client.player, previousTeam, client.player.team);
      require("./visibility").invalidateVisibility(client.room, { reason: "player-team-change", allegianceChanged: true });
      send(client, { type: "notice", message: "Solo mode: every pilot fights alone, so wings are not used" });
      broadcastSnapshot(client.room, performanceNow(), true);
      return;
    }
    client.player.team = sanitizeTeam(message.team, balanceTeam(client.room));
    invalidateRelationshipCache(client.room);
    require("./commandAuras").invalidateCommandAuraAllegiance(client.room, client.player, previousTeam, client.player.team);
    require("./visibility").invalidateVisibility(client.room, { reason: "player-team-change", allegianceChanged: true });
    revalidateTelemetryFocusForRoom(client.room);
    require("./spawnPlanner").invalidateSpawnPlan(client.room);
    broadcastRoom(client.room, { type: "notice", message: `${client.player.name} changed wing` });
    broadcastSnapshot(client.room, performanceNow(), true);
    return;
  }

  if (message.type === "setColor") {
    if (client.room.phase !== "lobby") {
      send(client, { type: "error", message: "Colour can only be changed in the lobby before ship design" });
      return;
    }
    const color = String(message.color || "").trim();
    if (!/^#[0-9A-Fa-f]{6}$/.test(color)) {
      send(client, { type: "error", message: "Invalid colour" });
      return;
    }
    client.player.color = color.toLowerCase();
    if (client.room.playerColors && client.player.name) {
      client.room.playerColors.set(client.player.name.toLowerCase(), client.player.color);
    }
    broadcastRoom(client.room, { type: "notice", message: `${client.player.name} changed colour` });
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
