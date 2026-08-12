"use strict";

function placeholderHandler() {}

const joined = { requiresJoin: true, requiresCurrentAttachment: true };
const frequent = Object.freeze({ bucket: "frequent", limit: 90, windowMs: 2000 });
const management = Object.freeze({ bucket: "management", limit: 24, windowMs: 6000 });
const phaseTransition = Object.freeze({ bucket: "phase", limit: 8, windowMs: 5000 });
const ROUTES = [
  { type: "ping", handler: placeholderHandler, requiresJoin: false, requiresCurrentAttachment: false, phases: ["any"], admin: false, requestId: "optional", rateLimit: frequent, mayTriggerStaticSnapshot: false, mayBroadcast: false },
  { type: "join", handler: placeholderHandler, requiresJoin: false, requiresCurrentAttachment: false, phases: ["any"], admin: false, requestId: "optional", rateLimit: { bucket: "join", limit: 8, windowMs: 10_000 }, mayTriggerStaticSnapshot: true, mayBroadcast: true },
  { type: "requestFullState", handler: placeholderHandler, ...joined, phases: ["lobby","design","active","ended"], admin: false, requestId: "optional", rateLimit: { bucket: "full-state", limit: 1, windowMs: 1000 }, mayTriggerStaticSnapshot: false, mayBroadcast: false },
  { type: "ready", handler: placeholderHandler, ...joined, phases: ["design"], admin: false, requestId: "optional", rateLimit: { bucket: "ready", limit: 6, windowMs: 5000 }, mayTriggerStaticSnapshot: true, mayBroadcast: true },
  { type: "deploy", handler: placeholderHandler, ...joined, phases: ["design","active"], admin: false, requestId: "optional", rateLimit: { bucket: "deploy", limit: 6, windowMs: 5000 }, mayTriggerStaticSnapshot: true, mayBroadcast: true },
  { type: "buyShip", handler: placeholderHandler, ...joined, phases: ["active"], admin: false, requestId: "required", rateLimit: { bucket: "buyShip", limit: 12, windowMs: 5000 }, mayTriggerStaticSnapshot: false, mayBroadcast: true },
  { type: "setCombatStyle", handler: placeholderHandler, ...joined, phases: ["active"], admin: false, requestId: "optional", rateLimit: frequent, mayTriggerStaticSnapshot: false, mayBroadcast: true },
  { type: "setOrbitDirection", handler: placeholderHandler, ...joined, phases: ["active"], admin: false, requestId: "optional", rateLimit: frequent, mayTriggerStaticSnapshot: false, mayBroadcast: true },
  { type: "setMovementToggles", handler: placeholderHandler, ...joined, phases: ["active"], admin: false, requestId: "optional", rateLimit: frequent, mayTriggerStaticSnapshot: false, mayBroadcast: true },
  { type: "setDroneBayMode", handler: placeholderHandler, ...joined, phases: ["active"], admin: false, requestId: "optional", rateLimit: management, mayTriggerStaticSnapshot: false, mayBroadcast: true },
  { type: "setTelemetryFocus", handler: placeholderHandler, ...joined, phases: ["lobby","design","active","ended"], admin: false, requestId: "optional", rateLimit: frequent, mayTriggerStaticSnapshot: false, mayBroadcast: false },
  { type: "setRallyPoint", handler: placeholderHandler, ...joined, phases: ["active"], admin: false, requestId: "optional", rateLimit: frequent, mayTriggerStaticSnapshot: false, mayBroadcast: true },
  { type: "resetRallyPoint", handler: placeholderHandler, ...joined, phases: ["active"], admin: false, requestId: "optional", rateLimit: frequent, mayTriggerStaticSnapshot: false, mayBroadcast: true },
  { type: "command", handler: placeholderHandler, ...joined, phases: ["active"], admin: false, requestId: "optional", rateLimit: { bucket: "command", limit: 30, windowMs: 1000 }, mayTriggerStaticSnapshot: false, mayBroadcast: false },
  { type: "stop", handler: placeholderHandler, ...joined, phases: ["active"], admin: false, requestId: "optional", rateLimit: { bucket: "command", limit: 30, windowMs: 1000 }, mayTriggerStaticSnapshot: false, mayBroadcast: false },
  { type: "rotate", handler: placeholderHandler, ...joined, phases: ["active"], admin: false, requestId: "optional", rateLimit: { bucket: "command", limit: 30, windowMs: 1000 }, mayTriggerStaticSnapshot: false, mayBroadcast: false },
  { type: "destruct", handler: placeholderHandler, ...joined, phases: ["active"], admin: false, requestId: "optional", rateLimit: management, mayTriggerStaticSnapshot: false, mayBroadcast: false },
  { type: "setTeam", handler: placeholderHandler, ...joined, phases: ["lobby"], admin: false, requestId: "optional", rateLimit: management, mayTriggerStaticSnapshot: true, mayBroadcast: true },
  { type: "setColor", handler: placeholderHandler, ...joined, phases: ["lobby"], admin: false, requestId: "optional", rateLimit: management, mayTriggerStaticSnapshot: true, mayBroadcast: true },
  { type: "addBot", handler: placeholderHandler, ...joined, phases: ["lobby"], admin: true, requestId: "optional", rateLimit: { bucket: "addBot", limit: 6, windowMs: 5000 }, mayTriggerStaticSnapshot: true, mayBroadcast: true },
  { type: "setRules", handler: placeholderHandler, ...joined, phases: ["lobby"], admin: true, requestId: "optional", rateLimit: { bucket: "setRules", limit: 8, windowMs: 5000 }, mayTriggerStaticSnapshot: true, mayBroadcast: true },
  { type: "setName", handler: placeholderHandler, ...joined, phases: ["lobby","design","active","ended"], admin: false, requestId: "optional", rateLimit: management, mayTriggerStaticSnapshot: true, mayBroadcast: true },
  { type: "startDesign", handler: placeholderHandler, ...joined, phases: ["lobby"], admin: true, requestId: "optional", rateLimit: phaseTransition, mayTriggerStaticSnapshot: true, mayBroadcast: true },
  { type: "kick", handler: placeholderHandler, ...joined, phases: ["lobby","design","active","ended"], admin: true, requestId: "optional", rateLimit: { bucket: "kick", limit: 6, windowMs: 5000 }, mayTriggerStaticSnapshot: true, mayBroadcast: true },
  { type: "restart", handler: placeholderHandler, ...joined, phases: ["ended"], admin: true, requestId: "optional", rateLimit: phaseTransition, mayTriggerStaticSnapshot: true, mayBroadcast: true },
  { type: "returnToLobby", handler: placeholderHandler, ...joined, phases: ["design","active","ended"], admin: true, requestId: "optional", rateLimit: phaseTransition, mayTriggerStaticSnapshot: true, mayBroadcast: true },
  { type: "restartLobby", handler: placeholderHandler, ...joined, phases: ["design","active","ended"], admin: true, requestId: "optional", rateLimit: phaseTransition, mayTriggerStaticSnapshot: true, mayBroadcast: true },
  { type: "closeLobby", handler: placeholderHandler, ...joined, phases: ["lobby","design","active","ended"], admin: true, requestId: "optional", rateLimit: phaseTransition, mayTriggerStaticSnapshot: false, mayBroadcast: true },
  { type: "leaveLobby", handler: placeholderHandler, ...joined, phases: ["lobby","design","active","ended"], admin: false, requestId: "optional", rateLimit: management, mayTriggerStaticSnapshot: true, mayBroadcast: true }
].map(Object.freeze);
const routesByType = Object.freeze(Object.fromEntries(ROUTES.map((route) => [route.type, route])));
module.exports = { ROUTES: Object.freeze(ROUTES.slice()), routesByType, getRoute: (type) => routesByType[type] || null };
