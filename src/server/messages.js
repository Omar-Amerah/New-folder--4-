// Handles WebSocket outbound payload framing, room-wide broadcasts, state snapshot multicasting, and inbound JSON message routing.

const { clampNumber, performanceNow } = require("./utils");
const { encodeMessage } = require("./wsCodec");
const { validateClientMessage } = require("./clientSchemas");
const { negotiate, ERROR_CODES, serverEnvelope } = require("./protocol");

// Binary WebSocket opcode (0x2) — outbound game data is MessagePack, not text.
const BINARY_OPCODE = 0x2;
const CONTROL_QUEUE_BYTE_LIMIT = 256 * 1024;
const SNAPSHOT_QUEUE_LIMIT = 2;
const TOTAL_QUEUE_BYTE_LIMIT = 768 * 1024;
const BLOCKED_CLOSE_MS = 15000;
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
  sendRaw(client, encodeMessage(serverEnvelope(client, data)));
}

// `payload` is a pre-encoded MessagePack Buffer (encode once, fan out to many).
function getOutbound(client) {
  if (!client.outbound) client.outbound = { control: [], snapshot: null, bytes: 0, controlBytes: 0, flushing: false, blocked: false, blockedSince: 0, drainListener: null, blockedCloseTimer: null, coalescedSnapshots: 0 };
  return client.outbound;
}

function frameBytes(payload) { return Buffer.isBuffer(payload) ? payload.length + 14 : 14; }
function clearBlockedTimer(out) { if (out.blockedCloseTimer) clearTimeout(out.blockedCloseTimer); out.blockedCloseTimer = null; }
function removeDrain(client, out) { if (out.drainListener && client.socket?.off) client.socket.off('drain', out.drainListener); out.drainListener = null; }
function resetOutbound(client) { const out = getOutbound(client); removeDrain(client, out); clearBlockedTimer(out); out.control = []; out.snapshot = null; out.bytes = 0; out.controlBytes = 0; out.blocked = false; out.blockedSince = 0; }

function enqueueRaw(client, payload, options = {}) {
  if (client.isClosed || client.socket.destroyed) return;
  const out = getOutbound(client);
  const bytes = frameBytes(payload);
  const kind = options.kind || 'control';
  if (kind === 'snapshot-compact') {
    if (out.snapshot) { out.bytes = Math.max(0, out.bytes - out.snapshot.bytes); out.coalescedSnapshots += 1; }
    out.snapshot = { payload, bytes, kind };
    out.bytes += bytes;
  } else if (kind === 'snapshot-full') {
    if (out.snapshot?.kind === 'snapshot-compact') { out.bytes = Math.max(0, out.bytes - out.snapshot.bytes); out.snapshot = null; }
    out.control.push({ payload, bytes, kind });
    out.bytes += bytes; out.controlBytes += bytes;
  } else {
    out.control.push({ payload, bytes, kind });
    out.bytes += bytes; out.controlBytes += bytes;
  }
  if (out.controlBytes > CONTROL_QUEUE_BYTE_LIMIT || out.bytes > TOTAL_QUEUE_BYTE_LIMIT || out.control.length > 128) {
    getCloseClient()(client, 1013, 'rate-limited: outbound-queue-limit');
    return;
  }
  if (!out.blocked) flushOutbound(client);
}

function markBlocked(client, out) {
  if (out.blocked) return;
  out.blocked = true;
  out.blockedSince = Date.now();
  out.drainListener = () => {
    removeDrain(client, out);
    clearBlockedTimer(out);
    out.blocked = false;
    out.blockedSince = 0;
    flushOutbound(client);
  };
  client.socket.once?.('drain', out.drainListener);
  out.blockedCloseTimer = setTimeout(() => {
    if (!client.isClosed && out.blocked && Date.now() - out.blockedSince >= BLOCKED_CLOSE_MS) getCloseClient()(client, 1013, 'rate-limited: outbound-backpressure');
  }, BLOCKED_CLOSE_MS + 25);
  out.blockedCloseTimer.unref?.();
}

function flushOutbound(client) {
  const out = getOutbound(client);
  if (out.flushing || out.blocked || client.isClosed || client.socket.destroyed) return;
  out.flushing = true;
  try {
    while (!out.blocked && (out.control.length || out.snapshot)) {
      const item = out.control.length ? out.control.shift() : out.snapshot;
      if (!out.control.length && item === out.snapshot) out.snapshot = null;
      const ok = getWriteFrame()(client.socket, item.payload, BINARY_OPCODE);
      out.bytes = Math.max(0, out.bytes - item.bytes);
      if (item.kind !== 'snapshot-compact') out.controlBytes = Math.max(0, out.controlBytes - item.bytes);
      if (!ok) markBlocked(client, out);
    }
  } catch {
    getCloseClient()(client, 1011, 'Send failed');
  } finally {
    out.flushing = false;
  }
}

// `payload` is a pre-encoded MessagePack Buffer (encode once, fan out to many).
function sendRaw(client, payload, options = {}) { enqueueRaw(client, payload, options); }

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

function ensureSnapshotBaseline(client, room) {
  if (!client.snapshotBaseline) client.snapshotBaseline = {};
  const b = client.snapshotBaseline;
  if (b.stateEpoch !== (room.stateEpoch || 1)) {
    b.stateEpoch = room.stateEpoch || 1;
    b.lastSentSeq = 0;
    b.lastFullSeq = 0;
    b.fullRequired = true;
    b.staticRevisionKnown = 0;
  }
  if (b.fullRequired === undefined) b.fullRequired = true;
  return b;
}

function sendFullSnapshot(client, now = performanceNow(), reason = 'resync') {
  if (!client.room) return;
  const room = client.room;
  const { snapshotRoom, buildSharedSnapshot } = require('./snapshots');
  const b = ensureSnapshotBaseline(client, room);
  const seq = (room.snapshotSeq = Math.max(0, room.snapshotSeq || 0) + 1);
  room._buildingSnapshotSeq = seq;
  const shared = buildSharedSnapshot(room, now, true);
  const payload = encodeMessage(snapshotRoom(room, now, client.player, true, shared));
  delete room._buildingSnapshotSeq;
  b.lastSentSeq = seq; b.lastFullSeq = seq; b.fullRequired = false; b.staticRevisionKnown = room.staticRevision || 1; b.queuedSnapshotKind = 'full';
  sendRaw(client, payload, { kind: 'snapshot-full' });
}

function broadcastSnapshot(room, now, forceStatic = false) {
  if (room.clients.size === 0) return;
  const { snapshotRoom, buildSharedSnapshot, markShipDesignsSent } = require('./snapshots');
  const seq = (room.snapshotSeq = Math.max(0, room.snapshotSeq || 0) + 1);
  room._buildingSnapshotSeq = seq;
  const fullShared = forceStatic ? buildSharedSnapshot(room, now, true) : null;
  const compactShared = forceStatic ? null : buildSharedSnapshot(room, now, false);
  const byVariant = new Map();
  for (const client of room.clients) {
    const b = ensureSnapshotBaseline(client, room);
    const full = forceStatic || b.fullRequired || b.staticRevisionKnown !== (room.staticRevision || 1) || b.lastSentSeq !== seq - 1;
    const shared = full ? (fullShared || buildSharedSnapshot(room, now, true)) : compactShared;
    const key = `${client.player ? `t:${client.player.team}` : 'spectator'}|e:${room.stateEpoch}|rev:${room.staticRevision}|kind:${full ? 'full':'compact'}|base:${full ? 0 : b.lastSentSeq}`;
    let payload = byVariant.get(key);
    if (payload === undefined) {
      payload = encodeMessage(snapshotRoom(room, now, client.player, full, shared));
      byVariant.set(key, payload);
    }
    b.lastSentSeq = seq; b.queuedSnapshotKind = full ? 'full' : 'compact';
    if (full) { b.lastFullSeq = seq; b.fullRequired = false; b.staticRevisionKnown = room.staticRevision || 1; }
    sendRaw(client, payload, { kind: full ? 'snapshot-full' : 'snapshot-compact' });
  }
  delete room._buildingSnapshotSeq;
  markShipDesignsSent(room);
}

function handleMessage(client, message) {
  const schema = validateClientMessage(message);
  if (!schema.ok) {
    send(client, { type: "error", code: schema.code, message: schema.message, requestId: message?.requestId });
    return;
  }

  if (message.type === "ping") {
    send(client, { type: "pong", at: Number(message.at) || 0, clientPingNonce: message.clientPingNonce, serverTimeMs: Date.now() });
    return;
  }

  const { joinRoom, maybeStartMatch, balanceTeam, isAdmin, kickPlayer, restartFromEnd, returnToLobbyPhase, closeLobby, leaveLobby, startDesignPhase, isCurrentAttachment, findReservedNameOwner } = require("./players");
  const { validateDesign } = require("./shipDesign");
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

module.exports = {
  send,
  sendPlayer,
  broadcastRoom,
  sendFullSnapshot,
  broadcastSnapshot,
  handleMessage,
  getOutbound,
  enqueueRaw,
  flushOutbound,
  resetOutbound,
  constants: { CONTROL_QUEUE_BYTE_LIMIT, SNAPSHOT_QUEUE_LIMIT, TOTAL_QUEUE_BYTE_LIMIT, BLOCKED_CLOSE_MS }
};
