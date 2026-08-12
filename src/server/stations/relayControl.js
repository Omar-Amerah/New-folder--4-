"use strict";

const { INFRASTRUCTURE } = require("../config");
const { performanceNow } = require("../utils");
const { transferRelayControl } = require("../stationCombat");
const { bump, recordDuration, detailedProfileActive } = require("../roomTelemetry");

function updateStationCapture(room, station, dt, now) {
  if (station.stationType !== "relay") return;
  const detailed = detailedProfileActive(room);
  if (detailed) bump(room, "stationRelaysProcessed");

  const cfg = INFRASTRUCTURE.relayStation;
  const radiusSq = cfg.captureRadius * cfg.captureRadius;
  const counts = new Map();
  const candidateStartedAt = detailed ? performanceNow() : 0;
  let candidatesVisited = 0;
  let eligibleShips = 0;
  if (detailed) bump(room, "stationCaptureFullShipScans");
  for (const ship of room.ships?.values() || []) {
    if (detailed) candidatesVisited += 1;
    if (!ship.alive) continue;
    const dx = ship.x - station.x;
    const dy = ship.y - station.y;
    if (dx * dx + dy * dy > radiusSq) continue;
    const player = room.players.get(ship.ownerId);
    if (!player) continue;
    const entry = counts.get(player.team) || { count: 0, ownerId: ship.ownerId };
    entry.count += 1;
    counts.set(player.team, entry);
    if (detailed) eligibleShips += 1;
  }
  if (detailed) {
    bump(room, "stationCaptureCandidatesVisited", candidatesVisited);
    bump(room, "stationCaptureEligibleShips", eligibleShips);
    recordDuration(room, "stationCaptureCandidateCollectionMs", candidateStartedAt);
  }

  const aggregationStartedAt = detailed ? performanceNow() : 0;
  const contenders = [...counts.entries()].sort((a, b) => b[1].count - a[1].count);
  if (detailed) {
    recordDuration(room, "stationCaptureAggregationMs", aggregationStartedAt);
    bump(room, "stationCaptureTeamsPresent", counts.size);
  }
  const transitionStartedAt = detailed ? performanceNow() : 0;
  try {
  const duration = cfg.captureDurationSeconds || 5;
  const decayPerSecond = Number(cfg.captureDecayPerSecond) || 0;

  // `captureTeam` is who the bar currently belongs to, so the client can draw
  // the progress sweep in the capturing side's colour instead of a generic
  // amber. It is cleared with the progress it describes.
  function setProgress(value, team = null) {
    const previous = station.captureProgress || 0;
    const previousTeam = station.captureTeam;
    const next = Math.max(0, Math.min(1, value));
    if (Math.round(next * 100) !== Math.round((station.captureProgress || 0) * 100)) station.captureRevision += 1;
    station.captureProgress = next;
    const nextTeam = next > 0 ? team : null;
    if (station.captureTeam !== nextTeam) {
      station.captureTeam = nextTeam;
      station.captureRevision += 1;
    }
    if (detailed && (next !== previous || nextTeam !== previousTeam)) bump(room, "stationCaptureProgressChanges");
  }

  // Progress bleeds away whenever nobody capturable is standing on the relay.
  // Without this an attacker could bank 4.9 seconds of a 5 second capture,
  // withdraw, and come back at any point in the match to finish it instantly.
  if (contenders.length === 0) {
    station.captureContested = false;
    setProgress((station.captureProgress || 0) - decayPerSecond * dt, station.captureTeam);
    return;
  }

  station.captureContested = contenders.length > 1 && contenders[0][1].count === contenders[1][1].count;
  if (station.captureContested) {
    if (detailed) bump(room, "stationCaptureContestedTicks");
    return;
  }

  const [leaderTeam, leader] = contenders[0];

  function captureStation(newOwnerId, newTeam) {
    setProgress(0);
    transferRelayControl(room, station, newOwnerId, now, { captureMethod: "neutral" });
    if (detailed) bump(room, "stationCapturesCompleted");
  }

  // Owned relays are transferred at destruction time. Only neutral relays use
  // the timed presence capture path below.
  if (station.state !== "neutral") return;

  // A new leader must first erase the previous team's capture bar. Otherwise
  // changing `captureTeam` would let the new side inherit the old progress.
  if (
    station.captureProgress > 0 &&
    station.captureTeam &&
    station.captureTeam !== leaderTeam
  ) {
    setProgress(
      Math.max(0, station.captureProgress - dt / duration),
      station.captureTeam
    );
    return;
  }

  // Taking an unclaimed relay runs the same clock as the old capture path, so
  // the capture ring and objective HUD percentage retain their meaning.
  setProgress((station.captureProgress || 0) + dt / duration, leaderTeam);
  if (station.captureProgress >= 1) captureStation(leader.ownerId, leaderTeam);
  } finally {
    if (detailed) recordDuration(room, "stationCaptureStateTransitionMs", transitionStartedAt);
  }
}

module.exports = { updateStationCapture };
