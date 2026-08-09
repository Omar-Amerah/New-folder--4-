// Explicit invalidation channel for presentation changes that do not originate
// in an authoritative snapshot. The message/presentation coordinator installs
// the handler; feature modules only name the semantic reason.

import { state } from "./state.js";

let invalidationHandler = null;
const pendingInvalidations = [];

export function registerPresentationInvalidationHandler(handler) {
  invalidationHandler = typeof handler === "function" ? handler : null;
  if (!invalidationHandler || pendingInvalidations.length === 0) return;
  const pending = pendingInvalidations.splice(0);
  for (const entry of pending) invalidationHandler(entry.reason, entry.detail);
}

export function invalidatePresentation(reason, detail = null) {
  if (!reason) return;
  const key = String(reason);
  const revisions = state.presentationLocalRevision;
  if (revisions) {
    if (key === "blueprint-edit") revisions.blueprint += 1;
    if (key === "purchase-catalogue") revisions.purchase += 1;
    if (key === "telemetry-component" || key === "panel-mode") revisions.telemetry += 1;
    if (key === "rally" || key === "rally-mode") revisions.rally += 1;
  }
  if (invalidationHandler) {
    invalidationHandler(key, detail);
    return;
  }
  pendingInvalidations.push({ reason: key, detail });
}
