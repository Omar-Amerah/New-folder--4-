import { SNAPSHOT_REJECTION } from "./snapshotMerge.js";

export const CANONICAL_RESYNC_REASONS = Object.freeze([
  "client-request",
  "sequence-gap",
  "epoch-change",
  "static-revision",
  "reconnect",
  "heartbeat-timeout",
  "malformed-snapshot"
]);
const ACCEPTED = new Set(CANONICAL_RESYNC_REASONS);

export function mapSnapshotResyncReason(localReason, fallback = "client-request") {
  const safeFallback = ACCEPTED.has(fallback) ? fallback : "client-request";
  if (typeof localReason !== "string") return safeFallback;
  const reason = localReason.trim();
  if (!reason) return safeFallback;
  switch (reason) {
    case SNAPSHOT_REJECTION.SEQUENCE_GAP:
    case SNAPSHOT_REJECTION.WRONG_BASE:
      return "sequence-gap";
    case SNAPSHOT_REJECTION.MISSING_BASELINE:
      return "client-request";
    case SNAPSHOT_REJECTION.STALE_EPOCH:
      return "epoch-change";
    case SNAPSHOT_REJECTION.STATIC_REVISION_MISMATCH:
      return "static-revision";
    case SNAPSHOT_REJECTION.MALFORMED_DELTA:
    case SNAPSHOT_REJECTION.INCOMPATIBLE_SNAPSHOT:
    case "malformed-snapshot":
      return "malformed-snapshot";
    case "epoch-change":
    case "reconnect":
    case "heartbeat-timeout":
    case "client-request":
      return reason;
    default:
      return safeFallback;
  }
}

export function buildRequestFullStateMessage(networkState = {}, localReason, options = {}) {
  const wireReason = mapSnapshotResyncReason(localReason, options.fallbackReason);
  const message = {
    type: "requestFullState",
    epoch: Number.isInteger(networkState.stateEpoch) ? networkState.stateEpoch : 0,
    sequence: Number.isInteger(networkState.snapshotSeq) ? networkState.snapshotSeq : 0,
    reason: wireReason
  };
  if (typeof options.requestId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(options.requestId)) message.requestId = options.requestId;
  return { message, localReason, wireReason };
}
