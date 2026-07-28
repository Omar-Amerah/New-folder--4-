"use strict";

function movementMetrics() {
  return global.__mfaMovePerf || null;
}

function bumpMovementMetric(name, amount = 1) {
  const metrics = movementMetrics();
  if (metrics) metrics[name] = (metrics[name] || 0) + amount;
}

module.exports = { bumpMovementMetric };
