"use strict";
const assert = require("assert");
const fs = require("fs");

const source = fs.readFileSync("public/src/network.js", "utf8");
const messages = fs.readFileSync("public/src/messages.js", "utf8");

function has(text, label) { assert(source.includes(text) || messages.includes(text), `missing ${label}`); }

has("const CONNECTION_TIMEOUT_MS = 12000", "12s connection timeout");
has("The game server did not respond. It may be waking up or temporarily offline. Wait a moment and try again.", "timeout message");
has("Could not reach the multiplayer server. Check the server address or confirm that the server is running.", "unavailable message");
has("Connected to the server, but the game could not be created or joined.", "pre-join close message");
has("The multiplayer server rejected this website. Check the server’s allowed origin configuration.", "origin rejection message");
has("The multiplayer server address is invalid. Open Settings and check the server URL.", "invalid URL message");
has("message.code === \"credential-expired\"", "server-provided errors are handled without replacement");
has("message.code === \"credential-invalid\"", "explicit join errors keep server message path");

for (const stage of ["creating socket", "socket opened", "hello received", "join sent", "joined received"]) {
  has(stage, `connection stage ${stage}`);
}

for (const field of ["hostname", "stage", "elapsedMs", "closeCode", "closeReason", "opened", "helloReceived", "joinSent", "category"]) {
  has(field, `connection diagnostic field ${field}`);
}

assert(/state\.joiningLobby = false;[\s\S]*setConnectionStatus\("error"/.test(source), "failed attempts reset loading and set error status");
assert(source.includes("state.reconnectAllowed = false"), "failed create/join attempts do not auto-retry indefinitely");
assert(source.includes("if (state.connectionAttempt?.timeout) { clearTimeout"), "newer attempts clear prior timeout");
assert(source.includes("if (attempt.timeout) { clearTimeout"), "socket open/close/error clears timeout");
assert(source.includes("if (attempt.serverErrorReceived) { state.joiningLobby = false; updateLobbyState(); return; }"), "server explicit join error is not replaced by close text");
assert(source.includes("if (!attempt.joinedReceived)"), "disconnect before successful join avoids generic disconnected message");

console.log("Connection create/join error coverage passed");
