// Handles websocket creation, reconnection states, outgoing messages, and incoming packet routing.

import { state } from "./state.js";
import { dom } from "./ui/dom.js";
import { LOCAL_SERVER_KEY } from "./constants.js";
import { handleServerMessage } from "./messages.js";
import { setConnectionStatus, updateLobbyState } from "./ui/lobbyUi.js";

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

export function connect(url, onOpenCallback) {
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
    setConnectionStatus("online", "Connected");
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
      setConnectionStatus("offline", "Disconnected");
      import("./ui/lobbyUi.js").then((mod) => {
        mod.returnToMainMenu("Disconnected from server", "error");
      });
    }
  });

  socket.addEventListener("error", () => {
    if (state.connectionGeneration === generation && state.socket === socket) {
      setConnectionStatus("error", "Network error");
      import("./ui/lobbyUi.js").then((mod) => {
        mod.returnToMainMenu("Network connection failed", "error");
      });
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
