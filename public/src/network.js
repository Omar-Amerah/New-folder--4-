// Handles websocket creation, reconnection states, outgoing messages, and incoming packet routing.

import { state } from "./state.js";
import { dom } from "./ui/dom.js";
import { LOCAL_SERVER_KEY } from "./constants.js";
import { handleServerMessage } from "./messages.js";
import { setConnectionStatus, updateLobbyState } from "./ui/lobbyUi.js";

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
  state.socket = socket;
  updateLobbyState();

  socket.addEventListener("open", () => {
    setConnectionStatus("online", "Connected");
    if (onOpenCallback) onOpenCallback();
  });

  socket.addEventListener("message", (event) => {
    try {
      const message = JSON.parse(event.data);
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
  state.socket.send(JSON.stringify(message));
}

export function getSocketUrl() {
  const configured = getConfiguredServerUrl();
  if (configured) return normalizeSocketUrl(configured);
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/socket`;
}

export function getConfiguredServerUrl() {
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
