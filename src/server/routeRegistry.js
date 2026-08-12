"use strict";

const joined = { requiresJoin: true, requiresCurrentAttachment: true };
const frequent = Object.freeze({ bucket: "frequent", limit: 90, windowMs: 2000 });
const management = Object.freeze({ bucket: "management", limit: 24, windowMs: 6000 });
const phaseTransition = Object.freeze({ bucket: "phase", limit: 8, windowMs: 5000 });
const ROUTES = [
  { type: "ping", requiresJoin: false, requiresCurrentAttachment: false, phases: ["any"], admin: false, requestId: "optional", rateLimit: frequent, mayTriggerStaticSnapshot: false, mayBroadcast: false },
  { type: "join", requiresJoin: false, requiresCurrentAttachment: false, phases: ["any"], admin: false, requestId: "optional", rateLimit: { bucket: "join", limit: 8, windowMs: 10_000 }, mayTriggerStaticSnapshot: true, mayBroadcast: true },
  { type: "requestFullState", ...joined, phases: ["lobby","design","active","ended"], admin: false, requestId: "optional", rateLimit: { bucket: "full-state", limit: 1, windowMs: 1000 }, mayTriggerStaticSnapshot: false, mayBroadcast: false },
  { type: "ready", ...joined, phases: ["design"], admin: false, requestId: "optional", rateLimit: { bucket: "ready", limit: 6, windowMs: 5000 }, mayTriggerStaticSnapshot: true, mayBroadcast: true },
  { type: "deploy", ...joined, phases: ["design","active"], admin: false, requestId: "optional", rateLimit: { bucket: "deploy", limit: 6, windowMs: 5000 }, mayTriggerStaticSnapshot: true, mayBroadcast: true },
  { type: "buyShip", ...joined, phases: ["active"], admin: false, requestId: "required", rateLimit: { bucket: "buyShip", limit: 12, windowMs: 5000 }, mayTriggerStaticSnapshot: false, mayBroadcast: true },
  { type: "setCombatStyle", ...joined, phases: ["active"], admin: false, requestId: "optional", rateLimit: frequent, mayTriggerStaticSnapshot: false, mayBroadcast: true },
  { type: "setOrbitDirection", ...joined, phases: ["active"], admin: false, requestId: "optional", rateLimit: frequent, mayTriggerStaticSnapshot: false, mayBroadcast: true },
  { type: "setMovementToggles", ...joined, phases: ["active"], admin: false, requestId: "optional", rateLimit: frequent, mayTriggerStaticSnapshot: false, mayBroadcast: true },
  { type: "setDroneBayMode", ...joined, phases: ["active"], admin: false, requestId: "optional", rateLimit: management, mayTriggerStaticSnapshot: false, mayBroadcast: true },
  { type: "setTelemetryFocus", ...joined, phases: ["lobby","design","active","ended"], admin: false, requestId: "optional", rateLimit: frequent, mayTriggerStaticSnapshot: false, mayBroadcast: false },
  { type: "setRallyPoint", ...joined, phases: ["active"], admin: false, requestId: "optional", rateLimit: frequent, mayTriggerStaticSnapshot: false, mayBroadcast: true },
  { type: "resetRallyPoint", ...joined, phases: ["active"], admin: false, requestId: "optional", rateLimit: frequent, mayTriggerStaticSnapshot: false, mayBroadcast: true },
  { type: "command", ...joined, phases: ["active"], admin: false, requestId: "optional", rateLimit: { bucket: "command", limit: 30, windowMs: 1000 }, mayTriggerStaticSnapshot: false, mayBroadcast: false },
  { type: "stop", ...joined, phases: ["active"], admin: false, requestId: "optional", rateLimit: { bucket: "command", limit: 30, windowMs: 1000 }, mayTriggerStaticSnapshot: false, mayBroadcast: false },
  { type: "rotate", ...joined, phases: ["active"], admin: false, requestId: "optional", rateLimit: { bucket: "command", limit: 30, windowMs: 1000 }, mayTriggerStaticSnapshot: false, mayBroadcast: false },
  { type: "destruct", ...joined, phases: ["active"], admin: false, requestId: "optional", rateLimit: management, mayTriggerStaticSnapshot: false, mayBroadcast: false },
  { type: "setTeam", ...joined, phases: ["lobby"], admin: false, requestId: "optional", rateLimit: management, mayTriggerStaticSnapshot: true, mayBroadcast: true },
  { type: "setColor", ...joined, phases: ["lobby"], admin: false, requestId: "optional", rateLimit: management, mayTriggerStaticSnapshot: true, mayBroadcast: true },
  { type: "addBot", ...joined, phases: ["lobby"], admin: true, requestId: "optional", rateLimit: { bucket: "addBot", limit: 6, windowMs: 5000 }, mayTriggerStaticSnapshot: true, mayBroadcast: true },
  { type: "setRules", ...joined, phases: ["lobby"], admin: true, requestId: "optional", rateLimit: { bucket: "setRules", limit: 8, windowMs: 5000 }, mayTriggerStaticSnapshot: true, mayBroadcast: true },
  { type: "setName", ...joined, phases: ["lobby","design","active","ended"], admin: false, requestId: "optional", rateLimit: management, mayTriggerStaticSnapshot: true, mayBroadcast: true },
  { type: "startDesign", ...joined, phases: ["lobby"], admin: true, requestId: "optional", rateLimit: phaseTransition, mayTriggerStaticSnapshot: true, mayBroadcast: true },
  { type: "kick", ...joined, phases: ["lobby","design","active","ended"], admin: true, requestId: "optional", rateLimit: { bucket: "kick", limit: 6, windowMs: 5000 }, mayTriggerStaticSnapshot: true, mayBroadcast: true },
  { type: "restart", ...joined, phases: ["ended"], admin: true, requestId: "optional", rateLimit: phaseTransition, mayTriggerStaticSnapshot: true, mayBroadcast: true },
  { type: "returnToLobby", ...joined, phases: ["design","active","ended"], admin: true, requestId: "optional", rateLimit: phaseTransition, mayTriggerStaticSnapshot: true, mayBroadcast: true },
  { type: "restartLobby", ...joined, phases: ["design","active","ended"], admin: true, requestId: "optional", rateLimit: phaseTransition, mayTriggerStaticSnapshot: true, mayBroadcast: true },
  { type: "closeLobby", ...joined, phases: ["lobby","design","active","ended"], admin: true, requestId: "optional", rateLimit: phaseTransition, mayTriggerStaticSnapshot: false, mayBroadcast: true },
  { type: "leaveLobby", ...joined, phases: ["lobby","design","active","ended"], admin: false, requestId: "optional", rateLimit: management, mayTriggerStaticSnapshot: true, mayBroadcast: true }
].map(Object.freeze);
const routesByType = Object.freeze(Object.fromEntries(ROUTES.map((route) => [route.type, route])));
module.exports = { ROUTES: Object.freeze(ROUTES.slice()), routesByType, getRoute: (type) => routesByType[type] || null };
