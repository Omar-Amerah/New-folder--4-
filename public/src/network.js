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
function clearReconnectTimer(){ if(state.reconnect?.timer){ clearTimeout(state.reconnect.timer); state.reconnect.timer=null; } }
function clearHeartbeat(){ if(state.heartbeat?.timer) clearInterval(state.heartbeat.timer); if(state.heartbeat?.timeout) clearTimeout(state.heartbeat.timeout); state.heartbeat={}; }
export function disableReconnect(reason="explicit") { state.reconnectAllowed=false; state.disconnectIntent=reason; clearReconnectTimer(); }
function scheduleReconnect(url, joinPayload){
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
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  state.socket = socket;
  updateLobbyState();

  socket.addEventListener("open", () => {
    if (state.connectionGeneration !== generation || state.socket !== socket) return;
    setConnectionStatus(options.reconnect ? "reconnected" : "online", options.reconnect ? "Resumed" : "Connected");
    startHeartbeat(generation, socket);
    if (onOpenCallback) onOpenCallback();
  });

  socket.addEventListener("message", (event) => {
    if (state.connectionGeneration !== generation || state.socket !== socket) return;
    try {
      const message = wsDecode(event.data);
      handleServerMessage(message);
    } catch (err) {
      console.error("Failed to parse incoming WS message:", err);
    }
  });

  socket.addEventListener("close", () => {
    if (state.connectionGeneration === generation && state.socket === socket) {
      clearHeartbeat();
      if (state.reconnectAllowed && scheduleReconnect(url, state.reconnect?.joinPayload)) return;
      setConnectionStatus("offline", "Disconnected");
      import("./ui/lobbyUi.js").then((mod) => { mod.returnToMainMenu("Disconnected from server", "error"); });
    }
  });

  socket.addEventListener("error", () => {
    if (state.connectionGeneration === generation && state.socket === socket) {
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
