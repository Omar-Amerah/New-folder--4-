import { state } from "./state.js";
import { send } from "./network.js";

function isFocusEligible(ship) {
  return ship?.detail === "full";
}

export function synchronizeTelemetryFocus() {
  const joined = state.joinedConnectionGeneration !== null && state.joinedConnectionGeneration === state.connectionGeneration;

  let desired = null;
  if (joined && state.selectedShipIds.size === 1) {
    const [selectedId] = [...state.selectedShipIds];
    const ship = state.snapshotIndex?.shipById?.get(selectedId)
      || (!state.snapshotIndex ? state.snapshot?.ships?.find((candidate) => candidate.id === selectedId) : null);
    if (ship && isFocusEligible(ship)) desired = selectedId;
  }

  state.desiredTelemetryFocusShipId = desired;

  const socketOpen = state.socket && state.socket.readyState === WebSocket.OPEN;
  const currentGeneration = state.connectionGeneration;
  const lastSentGeneration = state.telemetryFocusLastSentGeneration;
  const lastSentShipId = state.telemetryFocusLastSentShipId;
  const shouldSend = socketOpen && joined && (lastSentGeneration !== currentGeneration || lastSentShipId !== desired);

  let latestFailureReason = null;
  if (shouldSend) {
    if (send({ type: "setTelemetryFocus", shipId: desired })) {
      state.telemetryFocusLastSentShipId = desired;
      state.telemetryFocusLastSentGeneration = currentGeneration;
    } else {
      latestFailureReason = "send-failed";
    }
  } else if (joined && lastSentShipId !== desired) {
    latestFailureReason = socketOpen ? "send-failed" : "socket-not-open";
  }

  if (typeof process !== "undefined" && process.env && process.env.NODE_ENV !== "production") {
    const focusedShip = desired
      ? state.snapshotIndex?.shipById?.get(desired)
        || (!state.snapshotIndex ? state.snapshot?.ships?.find((candidate) => candidate.id === desired) : null)
      : null;
    globalThis.__mfaTelemetryFocusDiagnostics = {
      desiredTelemetryFocusShipId: desired,
      telemetryFocusLastSentShipId: state.telemetryFocusLastSentShipId,
      telemetryFocusLastSentGeneration: state.telemetryFocusLastSentGeneration,
      joinedConnectionGeneration: state.joinedConnectionGeneration,
      connectionGeneration: state.connectionGeneration,
      joined,
      socketOpen,
      hasPowerThermal: Boolean(focusedShip?.powerThermal),
      latestFailureReason,
      at: Date.now()
    };
  }
}
