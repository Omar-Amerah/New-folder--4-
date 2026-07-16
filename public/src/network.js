// Handles websocket creation, reconnection states, outgoing messages, and incoming packet routing.

import { state } from "./state.js";
import { dom } from "./ui/dom.js";
import { LOCAL_SERVER_KEY } from "./constants.js";
import { handleServerMessage } from "./messages.js";
import { setConnectionStatus, updateLobbyState } from "./ui/lobbyUi.js";
import { getResumeCredential } from "./reconnectStorage.js";

// The production wire protocol is MessagePack over binary WebSocket frames.
// Missing MessagePack is a fatal local transport error, not a silent JSON fallback.
function requireMessagePack() {
  const mp = globalThis.MessagePack;
  if (!mp || typeof mp.encode !== "function" || typeof mp.decode !== "function") {
    throw new Error("MessagePack bundle unavailable; cannot use production WebSocket protocol");
  }
  return mp;
}

function wsEncode(message) {
  return requireMessagePack().encode(message);
}

function wsDecode(data) {
  const mp = requireMessagePack();
  if (!(data instanceof ArrayBuffer)) throw new Error("Server sent unsupported text WebSocket frame");
  return mp.decode(new Uint8Array(data));
}

const RECONNECT = { baseMs: 300, maxMs: 4000, jitterMs: 250, maxDurationMs: 25000, heartbeatIntervalMs: 10000, heartbeatTimeoutMs: 30000 };
const CONNECTION_TIMEOUT_MS = 12000;
function netDiag() {
  if (typeof globalThis === "undefined") return null;
  return globalThis.__mfaNetworkDiagnostics ||= { websocketCreated: false, websocketOpened: false, helloReceived: false, protocolAccepted: false, joinPacketSent: false, joinedReceived: false, firstFullSnapshotReceived: false, sentTypes: [], receivedTypes: [], latestErrors: [], latestNotices: [], socketCloses: [], connectionFailures: [], reconnectAttempts: 0, latestJoinedPlayerId: null, latestAcceptedStateEpoch: null, latestAcceptedSnapshotSequence: null, latestAcceptedSnapshotKind: null, latestSnapshotRejectionReason: null, snapshotEvents: [], snapshotEventId: 0, acceptedFullEventCount: 0, latestCompletedResyncEventId: null, unresolvedRejectionCount: 0, lastSnapshotRejection: null, lastRecoveredRejection: null };
}
function markSentType(type) {
  const diag = netDiag();
  if (!diag) return;
  diag.sentTypes.push({ type, at: Date.now() });
  if (diag.sentTypes.length > 50) diag.sentTypes.shift();
  if (type === "join") diag.joinPacketSent = true;
}
export function recordNetworkEvent(kind, value) {
  const diag = netDiag();
  if (!diag) return;
  const boundedPush = (key, entry, limit = 10) => { diag[key] ||= []; diag[key].push({ ...entry, timestamp: Date.now() }); while (diag[key].length > limit) diag[key].shift(); };
  if (kind === "error") boundedPush("latestErrors", value);
  if (kind === "notice") boundedPush("latestNotices", value);
  if (kind === "joined") diag.latestJoinedPlayerId = value?.playerId || null;
  if (["acceptedSnapshot","snapshotRejected","resyncRequested"].includes(kind)) { diag.snapshotEvents ||= []; const event = { id: ++diag.snapshotEventId, kind, ...value, timestamp: Date.now() }; diag.snapshotEvents.push(event); while (diag.snapshotEvents.length > 100) diag.snapshotEvents.shift(); if (kind === "acceptedSnapshot" && value?.snapshotKind === "full") { diag.acceptedFullEventCount = (diag.acceptedFullEventCount || 0) + 1; diag.latestCompletedResyncEventId = event.id; diag.lastRecoveredRejection = diag.lastSnapshotRejection || null; diag.unresolvedRejectionCount = 0; } if (kind === "snapshotRejected") { diag.unresolvedRejectionCount = (diag.unresolvedRejectionCount || 0) + 1; diag.lastSnapshotRejection = event; } }
  if (kind === "acceptedSnapshot") { diag.latestAcceptedStateEpoch = value?.stateEpoch ?? null; diag.latestAcceptedSnapshotSequence = value?.snapshotSeq ?? null; diag.latestAcceptedSnapshotKind = value?.snapshotKind ?? null; }
  if (kind === "snapshotRejected") diag.latestSnapshotRejectionReason = value?.reason || null;
}
function markReceivedType(type) {
  const diag = netDiag();
  if (!diag) return;
  diag.receivedTypes.push({ type, at: Date.now() });
  if (diag.receivedTypes.length > 50) diag.receivedTypes.shift();
  if (type === "hello") diag.helloReceived = true;
  if (type === "joined") diag.joinedReceived = true;
  if (type === "state") diag.firstFullSnapshotReceived = true;
}


function stageOf(attempt) {
  if (attempt?.joinedReceived) return "joined received";
  if (attempt?.joinSent) return "join sent";
  if (attempt?.helloReceived) return "hello received";
  if (attempt?.opened) return "socket opened";
  return "creating socket";
}

function urlHostname(url) {
  try { return new URL(url).hostname || "unknown"; } catch { return "invalid"; }
}

function connectionFailureMessage(category) {
  switch (category) {
    case "timeout": return "The game server did not respond. It may be waking up or temporarily offline. Wait a moment and try again.";
    case "origin-rejected": return "The multiplayer server rejected this website. Check the server’s allowed origin configuration.";
    case "invalid-url": return "The multiplayer server address is invalid. Open Settings and check the server URL.";
    case "closed-before-join": return "Connected to the server, but the game could not be created or joined.";
    case "unavailable":
    default: return "Could not reach the multiplayer server. Check the server address or confirm that the server is running.";
  }
}

function categorizeConnectionFailure(kind, attempt, event) {
  if (kind === "timeout") return "timeout";
  if (kind === "invalid-url") return "invalid-url";
  const reason = String(event?.reason || "").toLowerCase();
  if (event?.code === 1008 || event?.code === 403 || reason.includes("403") || reason.includes("origin")) return "origin-rejected";
  if (attempt?.opened && !attempt?.joinedReceived) return "closed-before-join";
  return "unavailable";
}

function recordConnectionFailure(attempt, category, event) {
  const diag = netDiag();
  if (!diag) return;
  const entry = {
    hostname: urlHostname(attempt?.url || ""),
    stage: stageOf(attempt),
    elapsedMs: Math.max(0, Math.round(performance.now() - (attempt?.startedAt || performance.now()))),
    closeCode: event?.code ?? null,
    closeReason: event?.reason || "",
    opened: Boolean(attempt?.opened),
    helloReceived: Boolean(attempt?.helloReceived),
    joinSent: Boolean(attempt?.joinSent),
    category,
    timestamp: Date.now()
  };
  diag.connectionFailures ||= [];
  diag.connectionFailures.push(entry);
  while (diag.connectionFailures.length > 10) diag.connectionFailures.shift();
  diag.latestConnectionFailure = entry;
}

function failConnectionAttempt(attempt, category, event) {
  if (!attempt || attempt.failed) return;
  attempt.failed = true;
  if (attempt.timeout) { clearTimeout(attempt.timeout); attempt.timeout = null; }
  const message = connectionFailureMessage(category);
  recordConnectionFailure(attempt, category, event);
  state.joiningLobby = false;
  state.reconnectAllowed = false;
  setConnectionStatus("error", message);
  updateLobbyState();
  import("./ui/lobbyUi.js").then((mod) => {
    mod.showMenuNotice(message, "error");
    mod.updateLobbyState();
  });
}

function clearReconnectTimer(){ if(state.reconnect?.timer){ clearTimeout(state.reconnect.timer); state.reconnect.timer=null; } }
function clearHeartbeat(){ if(state.heartbeat?.timer) clearInterval(state.heartbeat.timer); if(state.heartbeat?.timeout) clearTimeout(state.heartbeat.timeout); state.heartbeat={}; }
export function disableReconnect(reason="explicit") { state.reconnectAllowed=false; state.disconnectIntent=reason; clearReconnectTimer(); }
function scheduleReconnect(url, joinPayload){
  const diag = netDiag(); if (diag) diag.reconnectAttempts = (diag.reconnectAttempts || 0) + 1;
  if(!state.reconnectAllowed || !joinPayload?.room) return false;
  const r=state.reconnect ||= { attempts:0, startedAt:performance.now(), timer:null, url, joinPayload };
  r.url=url; r.joinPayload=joinPayload;
  if(r.timer) return true;
  if(performance.now()-r.startedAt>RECONNECT.maxDurationMs){ setConnectionStatus("error","Reconnect failed"); return false; }
  const delay=Math.min(RECONNECT.maxMs, RECONNECT.baseMs * 2 ** r.attempts) + Math.floor(Math.random()*RECONNECT.jitterMs);
  r.attempts += 1; setConnectionStatus("reconnecting","Reconnecting");
  r.timer=setTimeout(()=>{ r.timer=null; connect(url, ()=>send(withClientProtocol({...joinPayload, resumeToken:getResumeCredential(joinPayload.room)})), { reconnect:true, joinPayload }); }, delay);
  return true;
}
function startHeartbeat(generation, socket){
  clearHeartbeat();
  state.heartbeat={ timer:setInterval(()=>{
    if(state.connectionGeneration!==generation || state.socket!==socket || socket.readyState!==WebSocket.OPEN) return;
    const nonce=`${generation}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    state.lastPingAt=performance.now(); send({type:"ping", at:state.lastPingAt, clientPingNonce:nonce});
    if(state.heartbeat.timeout) clearTimeout(state.heartbeat.timeout);
    state.heartbeat.timeout=setTimeout(()=>{ if(state.connectionGeneration===generation && state.socket===socket){ try{socket.close();}catch{} scheduleReconnect(state.reconnect?.url || getSocketUrl(), state.reconnect?.joinPayload); } }, RECONNECT.heartbeatTimeoutMs);
  }, RECONNECT.heartbeatIntervalMs) };
}

export function connect(url, onOpenCallback, options = {}) {
  clearReconnectTimer();
  clearHeartbeat();
  if (!options.reconnect) state.reconnect = { attempts:0, startedAt:performance.now(), timer:null, url, joinPayload: options.joinPayload || null };
  if (options.joinPayload) { state.reconnectAllowed = true; state.reconnect.joinPayload = options.joinPayload; state.reconnect.url = url; }
  if (state.connectionAttempt?.timeout) { clearTimeout(state.connectionAttempt.timeout); state.connectionAttempt.timeout = null; }
  if (state.socket) {
    try {
      state.socket.close();
    } catch {
      // Ignore
    }
  }

  setConnectionStatus("connecting", "Connecting");
  const generation = (state.connectionGeneration || 0) + 1;
  state.connectionGeneration = generation;
  let socket;
  let attempt = null;
  try {
    socket = new WebSocket(url);
  } catch (err) {
    attempt = { url, startedAt: performance.now() };
    failConnectionAttempt(attempt, "invalid-url");
    return;
  }
  attempt = { url, startedAt: performance.now(), opened: false, helloReceived: false, joinSent: false, joinedReceived: false, serverErrorReceived: false, failed: false, timeout: null };
  const diag = netDiag();
  if (diag) { diag.websocketCreated = true; diag.websocketUrl = url; diag.websocketUrlHostname = urlHostname(url); diag.connectionStage = "creating socket"; }
  socket.binaryType = "arraybuffer";
  state.socket = socket;
  state.connectionAttempt = attempt;
  updateLobbyState();
  attempt.timeout = setTimeout(() => {
    if (state.connectionGeneration !== generation || state.socket !== socket || attempt.opened) return;
    try { socket.close(); } catch {}
    failConnectionAttempt(attempt, "timeout");
  }, CONNECTION_TIMEOUT_MS);

  socket.addEventListener("open", () => {
    if (state.connectionGeneration !== generation || state.socket !== socket) return;
    if (attempt.timeout) { clearTimeout(attempt.timeout); attempt.timeout = null; }
    attempt.opened = true;
    const diag = netDiag();
    if (diag) { diag.websocketOpened = true; diag.connectionStage = stageOf(attempt); }
    setConnectionStatus(options.reconnect ? "reconnected" : "online", options.reconnect ? "Resumed" : "Connected");
    startHeartbeat(generation, socket);
    if (onOpenCallback) onOpenCallback();
  });

  socket.addEventListener("message", (event) => {
    if (state.connectionGeneration !== generation || state.socket !== socket) return;
    try {
      const message = wsDecode(event.data);
      markReceivedType(message?.type);
      if (message?.type === "hello") attempt.helloReceived = true;
      if (message?.type === "joined") attempt.joinedReceived = true;
      if (message?.type === "error") attempt.serverErrorReceived = true;
      { const diag = netDiag(); if (diag) diag.connectionStage = stageOf(attempt); }
      handleServerMessage(message);
      const diag = netDiag();
      if (diag && message?.type === "hello") diag.protocolAccepted = state.server?.compatibility === "ok";
    } catch (err) {
      console.error("Failed to parse incoming WS message:", err);
    }
  });

  socket.addEventListener("close", (event) => {
    const diag = netDiag();
    if (diag) { diag.socketCloses ||= []; diag.socketCloses.push({ code: event.code, reason: event.reason, clean: event.wasClean, timestamp: Date.now() }); if (diag.socketCloses.length > 10) diag.socketCloses.shift(); }
    if (state.connectionGeneration === generation && state.socket === socket) {
      clearHeartbeat();
      if (attempt.timeout) { clearTimeout(attempt.timeout); attempt.timeout = null; }
      if (!attempt.joinedReceived) {
        if (attempt.serverErrorReceived) { state.joiningLobby = false; updateLobbyState(); return; }
        failConnectionAttempt(attempt, categorizeConnectionFailure("close", attempt, event), event); return;
      }
      if (state.reconnectAllowed && scheduleReconnect(url, state.reconnect?.joinPayload)) return;
      setConnectionStatus("offline", "Disconnected");
      import("./ui/lobbyUi.js").then((mod) => { mod.returnToMainMenu("Disconnected from server", "error"); });
    }
  });

  socket.addEventListener("error", () => {
    if (state.connectionGeneration === generation && state.socket === socket) {
      if (attempt.timeout) { clearTimeout(attempt.timeout); attempt.timeout = null; }
      if (!attempt.joinedReceived) { failConnectionAttempt(attempt, categorizeConnectionFailure("error", attempt)); return; }
      if (state.reconnectAllowed && scheduleReconnect(url, state.reconnect?.joinPayload)) return;
      setConnectionStatus("error", "Network error");
      import("./ui/lobbyUi.js").then((mod) => { mod.returnToMainMenu("Network connection failed", "error"); });
    }
  });
}

export function send(message) {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
    console.warn("Cannot send while WebSocket is offline", message?.type);
    return false;
  }
  state.socket.send(wsEncode(message));
  markSentType(message?.type);
  if (message?.type === "join" && state.connectionAttempt) state.connectionAttempt.joinSent = true;
  return true;
}

export function getSocketUrl() {
  const configured = getConfiguredServerUrl();
  if (configured) return normalizeSocketUrl(configured);
  if (typeof location === "undefined") return "";
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/socket`;
}

export function getConfiguredServerUrl() {
  if (typeof location === "undefined" || typeof localStorage === "undefined") return "";
  const params = new URLSearchParams(location.search);
  const fromUrl = params.get("server");
  if (fromUrl) {
    localStorage.setItem(LOCAL_SERVER_KEY, fromUrl);
    return fromUrl;
  }
  return localStorage.getItem(LOCAL_SERVER_KEY) || "";
}

export function normalizeSocketUrl(value) {
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

export function withClientProtocol(message) {
  return {
    protocolVersion: globalThis.MFAProtocol?.PROTOCOL_VERSION ?? 4,
    minProtocolVersion: globalThis.MFAProtocol?.MIN_SUPPORTED_PROTOCOL ?? 4,
    maxProtocolVersion: globalThis.MFAProtocol?.MAX_SUPPORTED_PROTOCOL ?? 4,
    frontendBuildSha: globalThis.MFA_FRONTEND_BUILD_SHA || "dev",
    capabilities: ["messagepack", "resume-v1", "heartbeat-v1"],
    ...message
  };
}
