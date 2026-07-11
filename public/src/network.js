// Handles websocket creation, reconnection states, outgoing messages, and incoming packet routing.

import { state } from "./state.js";
import { dom } from "./ui/dom.js";
import { LOCAL_SERVER_KEY } from "./constants.js";
import { handleServerMessage } from "./messages.js";
import { setConnectionStatus, updateLobbyState } from "./ui/lobbyUi.js";

// The server speaks MessagePack over binary WebSocket frames (vendored global
// `MessagePack`, loaded via a <script> tag in index.html). We fall back to JSON
// if the library is unavailable (e.g. the test sandbox) so nothing hard-breaks.
function wsEncode(message) {
  const mp = globalThis.MessagePack;
  return mp ? mp.encode(message) : JSON.stringify(message);
}

function wsDecode(data) {
  const mp = globalThis.MessagePack;
  if (data instanceof ArrayBuffer) {
    const bytes = new Uint8Array(data);
    return mp ? mp.decode(bytes) : JSON.parse(new TextDecoder().decode(bytes));
  }
  // Text frame (JSON) — legacy/fallback path.
  return JSON.parse(data);
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
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  state.socket = socket;
  updateLobbyState();

  socket.addEventListener("open", () => {
    setConnectionStatus("online", "Connected");
    if (onOpenCallback) onOpenCallback();
  });

  socket.addEventListener("message", (event) => {
    try {
      const message = wsDecode(event.data);
      handleServerMessage(message);
    } catch (err) {
      console.error("Failed to parse incoming WS message:", err);
    }
  });

  socket.addEventListener("close", () => {
    if (state.socket === socket) {
      setConnectionStatus("offline", "Disconnected");
      import("./ui/lobbyUi.js").then((mod) => {
        mod.returnToMainMenu("Disconnected from server", "error");
      });
    }
  });

  socket.addEventListener("error", () => {
    if (state.socket === socket) {
      setConnectionStatus("error", "Network error");
      import("./ui/lobbyUi.js").then((mod) => {
        mod.returnToMainMenu("Network connection failed", "error");
      });
    }
  });
}

export function send(message) {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) return;
  state.socket.send(wsEncode(message));
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
