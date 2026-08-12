"use strict";

// EMP Cannon disruption is deliberately separate from ordinary damage. It only
// spends current Shield, using a fraction of maximum Shield as the request.
// The normal Shield runtime observes a transition to zero on its next update and
// owns the existing restart-delay timer and Command Relay modifiers.
function applyEmpShieldDisruption(target, fraction = 0.5, attackerId, now) {
  const shieldBefore = Math.max(0, Number(target?.shield) || 0);
  const maxShield = Math.max(0, Number(target?.maxShield) || 0);
  const share = Math.max(0, Math.min(1, Number(fraction) || 0));
  const requested = maxShield * share;
  const removed = Math.min(shieldBefore, requested);
  const shieldAfter = Math.max(0, shieldBefore - removed);

  if (target && removed > 0) {
    target.shield = shieldAfter;
    target.lastDamagedBy = attackerId ?? target.lastDamagedBy;
    target.lastDamagedAt = now;
  }

  return {
    shieldBefore,
    shieldAfter: target ? Math.max(0, Number(target.shield) || 0) : shieldBefore,
    maxShield,
    requested,
    removed,
    depleted: shieldAfter <= 0
  };
}

module.exports = { applyEmpShieldDisruption };
