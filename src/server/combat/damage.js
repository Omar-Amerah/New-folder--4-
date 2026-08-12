"use strict";

const { PARTS } = require("../components");
const { applyHullDamage, isComponentAlive, onComponentDestroyed, markComponentDamageChanged } = require("../componentHealth");
const { distributeComponentHeatByWeight } = require("../heat");
const HeatRules = require("../../../public/src/shared/heatRules");
const ShieldRules = require("../../../public/src/shared/shieldRules");
const { effectiveShieldCapacityContributions } = require("../componentPower");
const { markShipRepairCacheDirty } = require("../repairCache");

function createDamageRuntime({
  isInSafeZone,
  applyBeamHullDamage,
  evaluateShipCommandState,
  destroyShip
}) {
  const SHIELD_IMPACT_HEAT_PER_BLOCKED_DAMAGE = ShieldRules.IMPACT_HEAT_PER_BLOCKED_DAMAGE;

  function applyDirectComponentDamage(room, ship, index, damage, attackerId, now) {
  
    if (isInSafeZone(room, ship.x, ship.y, ship) || damage <= 0) return 0;
  
    ship.lastDamagedBy = attackerId;
  
    if (!ship.componentHp || !isComponentAlive(ship, index)) return 0;
  
  
  
    const part = PARTS[ship.design[index].type] || PARTS.frame;
  
    let effectiveDamage = damage;
  
    if (part.armorFlatReduction > 0) {
  
      const protection = HeatRules.passiveProtectionForState(ship.componentHeatState?.[index] || HeatRules.STATE.NORMAL);
  
      const reduction = part.armorFlatReduction * protection;
  
      effectiveDamage = Math.max(0, effectiveDamage - Math.max(0, reduction));
  
    }
  
    if (effectiveDamage <= 0) return 0;
  
  
  
    if (ship.design[index].type === "core") {
  
      const dealt = Math.min(ship.componentHp[index], effectiveDamage);
  
      if (dealt > 0) {
  
        ship.componentHp[index] -= dealt;
  
        markComponentDamageChanged(ship, index);
  
        if (ship.componentHp[index] <= 0.0001) {
  
          ship.componentHp[index] = 0;
  
          onComponentDestroyed(room, ship, index, now);
  
        }
  
        pushDamageEffect(room, ship, now, dealt, false);
  
      }
  
      if (ship.hp <= 0.001) destroyShip(room, ship, attackerId, now);
  
      else evaluateShipCommandState(room, ship, now, attackerId);
  
      if (dealt > 0) markShipRepairCacheDirty(ship);
  
      return dealt;
  
    }
  
  
  
    const passiveStructure = HeatRules.isPassiveStructure(ship.design[index].type, part);
  
    const mult = passiveStructure ? HeatRules.structuralDamageMultiplierForState(ship.componentHeatState?.[index] || HeatRules.STATE.NORMAL) : 1;
  
    const incomingToHp = effectiveDamage * mult;
  
    const dealt = Math.min(ship.componentHp[index], incomingToHp);
  
  
  
    if (dealt > 0) {
  
      ship.componentHp[index] -= dealt;
  
      if (ship.design[index].type === "heatSink") require("../heat").recalculateEffectiveThermalCapacities(ship, index);
  
      ship.hp -= dealt;
  
      markComponentDamageChanged(ship, index);
  
      if (ship.componentHp[index] <= 0.0001) {
  
        ship.componentHp[index] = 0;
  
        onComponentDestroyed(room, ship, index, now);
  
      }
  
      pushDamageEffect(room, ship, now, dealt, false);
  
    }
  
  
  
    if (ship.hp <= 0.001) {
  
      destroyShip(room, ship, attackerId, now);
  
    } else {
  
      evaluateShipCommandState(room, ship, now, attackerId);
  
    }
  
  
  
    if (dealt > 0) markShipRepairCacheDirty(ship);
  
    return dealt;
  
  }
  
  function damageShip(room, ship, damage, attackerId, now, sourceX, sourceY, options = {}) {
  
    if (isInSafeZone(room, ship.x, ship.y, ship)) return; // Invincible in own/team spawn
    if (!Number.isFinite(damage)) return; // Invalid damage values cannot produce meaningful resolution
  
  
  
    if (ship.stats.frontDamageReduction && sourceX !== undefined && sourceY !== undefined) {
  
      if (isDamageFromFront(ship, sourceX, sourceY, ship.stats.frontArc)) {
  
        damage *= (1 - ship.stats.frontDamageReduction);
  
        if (!ship.lastBlockedTextAt || now - ship.lastBlockedTextAt > 350) {
  
          ship.lastBlockedTextAt = now;
  
          room.effects.push({ type: "text", text: "BLOCKED", x: ship.x, y: ship.y, at: now });
  
        }
  
      }
  
    }
  
    ship.lastDamagedBy = attackerId;
  
  
  
    const SHIELD_ABSORPTION = ShieldRules.SHIELD_ABSORPTION_FRACTION;
  
  
  
    const shieldMultiplier = Number.isFinite(Number(options.shieldDamageMultiplier ?? 1)) ? Number(options.shieldDamageMultiplier ?? 1) : 1;
  
    const hullMultiplier = Number.isFinite(Number(options.hullDamageMultiplier ?? 1)) ? Number(options.hullDamageMultiplier ?? 1) : 1;
  
  
  
    let hullDamage = damage * hullMultiplier;
  
  
  
    if (ship.shield > 0) {
  
      const shieldDamage = damage * shieldMultiplier;
  
      const safeShield = Number.isFinite(ship.shield) ? Math.max(0, ship.shield) : 0;
      const safeShieldDamage = Number.isFinite(shieldDamage) ? Math.max(0, shieldDamage) : safeShield;
      const blockedShieldDamage = Math.min(safeShield, safeShieldDamage);
  
      ship.shield = Math.max(0, safeShield - blockedShieldDamage);
  
  
  
      const absorbedRatio = shieldDamage > 0
  
        ? blockedShieldDamage / shieldDamage
  
        : 0;
  
  
  
      const absorbedHullDamage = hullDamage * absorbedRatio;
  
      const overflowHullDamage = hullDamage - absorbedHullDamage;
  
      const bleedThroughDamage = absorbedHullDamage * (1 - SHIELD_ABSORPTION);
  
  
  
      hullDamage = bleedThroughDamage + overflowHullDamage;
  
  
  
      if (blockedShieldDamage > 0) {
  
        distributeComponentHeatByWeight(
  
          ship,
  
          effectiveShieldCapacityContributions(ship),
  
          blockedShieldDamage * SHIELD_IMPACT_HEAT_PER_BLOCKED_DAMAGE
  
        );
  
        pushDamageEffect(room, ship, now, blockedShieldDamage, true);
  
      }
  
    }
  
  
  
    if (hullDamage > 0) {
  
      let applied = 0;
  
      if (options.intersections) {
  
        applied = applyBeamHullDamage(room, ship, hullDamage, now, options.intersections, options);
  
      } else {
  
        const impactX = sourceX !== undefined ? sourceX : ship.x;
  
        const impactY = sourceY !== undefined ? sourceY : ship.y;
  
        applied = applyHullDamage(room, ship, hullDamage, now, impactX, impactY, {
  
          beamDeltaSeconds: options.beamDeltaSeconds,
  
          impactHeatPerDamage: options.impactHeatPerDamage,
  
          penetrationProfile: options.penetrationProfile
  
        });
  
      }
  
      if (applied > 0) {
  
        pushDamageEffect(room, ship, now, applied, false);
  
        markShipRepairCacheDirty(ship);
  
      }
  
    }
  
  
  
    if (ship.hp <= 0.001) {
  
      destroyShip(room, ship, attackerId, now);
  
    } else {
  
      evaluateShipCommandState(room, ship, now, attackerId);
  
    }
  
  }
  
  const DMG_EFFECT_MERGE_MS = 160;
  
  
  
  function pushDamageEffect(room, ship, now, amount, isShield) {
  
    const key = isShield ? "lastShieldDmgEffect" : "lastHullDmgEffect";
  
    const previous = ship[key];
  
    if (previous && now - previous.at < DMG_EFFECT_MERGE_MS) {
  
      previous.amount = Math.round((previous.amount + amount) * 10) / 10;
  
      previous.x = ship.x;
  
      previous.y = ship.y;
  
      return;
  
    }
  
    const effect = {
  
      type: "dmg",
  
      x: ship.x,
  
      y: ship.y,
  
      at: now,
  
      amount: Math.round(amount * 10) / 10,
  
      isShield
  
    };
  
    ship[key] = effect;
  
    room.effects.push(effect);
  
  }

  return {
    applyDirectComponentDamage,
    damageShip
  };
}

module.exports = { createDamageRuntime };
