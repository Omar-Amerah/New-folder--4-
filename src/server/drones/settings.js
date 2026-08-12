"use strict";

const { BALANCE } = require("../balanceConfig");
const BackupCoreRules = require("../../../public/src/shared/backupCoreRules");

const CONFIG = BALANCE.drones;
const DRONE_DECISION_INTERVAL_MS = 120;
const DRONE_DECISION_INTERVALS_MS = Object.freeze({ defence: 120, fighter: 180, repair: 250 });
const MAX_CONFIGURED_DRONE_SPEED = Math.max(
  0,
  ...Object.values(CONFIG.types || {}).map((entry) => Number(entry?.speed) || 0)
);
const BACKUP_CORE_CONFIGS = Object.freeze(Object.fromEntries(
  Object.entries(CONFIG.types || {}).map(([type, config]) => [type, Object.freeze({
    ...config,
    commandRange: BackupCoreRules.applyActiveSystemEffectiveness(config.commandRange, "backupCore")
  })])
));

function droneConfigForCommandState(parent, droneType) {
  return BackupCoreRules.isBackupCoreActive(parent)
    ? BACKUP_CORE_CONFIGS[droneType]
    : CONFIG.types[droneType];
}

function droneDecisionInterval(type) {
  return Number(DRONE_DECISION_INTERVALS_MS[type]) || DRONE_DECISION_INTERVAL_MS;
}

function hashDroneSequence(sequence) {
  let value = (Number(sequence) || 0) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x45d9f3b) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x45d9f3b) >>> 0;
  value ^= value >>> 16;
  return value >>> 0;
}

function droneStableOrbitPhase(drone) {
  const numericId = Number.parseInt(String(drone?.id || "").replace(/\D/g, ""), 10);
  return ((numericId || Number(drone?.slot) || 0) * 2.399);
}

function buildDroneRuntimeConfig(drone, config, authoritativeSequence = drone?.authoritativeSequence || 0) {
  const commandRange = Math.max(0, Number(config?.commandRange) || 0);
  const weaponRange = Math.max(0, Number(config?.weaponRange) || 0);
  const repairRange = Math.max(0, Number(config?.repairRange) || 0);
  const decisionIntervalMs = droneDecisionInterval(drone?.type);
  return {
    config,
    sourceConfig: config,
    commandRangeSquared: commandRange * commandRange,
    weaponRangeSquared: weaponRange * weaponRange,
    repairRangeSquared: repairRange * repairRange,
    orbitDistance: Math.max(0, Number(config?.orbitDistance) || 0),
    radius: Math.max(1, Number(drone?.radius) || 10),
    supportsEvasion: (Number(config?.evasionLookaheadSeconds) || 0) > 0 && (Number(config?.evasionClearance) || 0) > 0,
    evasionLookaheadSeconds: Math.max(0, Number(config?.evasionLookaheadSeconds) || 0),
    evasionClearance: Math.max(0, Number(config?.evasionClearance) || 0),
    stableOrbitPhase: droneStableOrbitPhase(drone),
    decisionIntervalMs,
    decisionStaggerMs: hashDroneSequence(authoritativeSequence) % decisionIntervalMs,
    fuelCapacitySeconds: Number(config?.fuelSeconds) || CONFIG.fuelSeconds
  };
}

function ensureDroneRuntimeConfig(drone, config = CONFIG.types[drone?.type]) {
  if (!drone || !config) return { config };
  const current = drone._runtimeConfig;
  if (!current || current.sourceConfig !== config || current.radius !== Math.max(1, Number(drone.radius) || 10)) {
    drone._runtimeConfig = buildDroneRuntimeConfig(drone, config, drone.authoritativeSequence);
  }
  return drone._runtimeConfig;
}

function effectiveDroneConfig(parent, drone) {
  const config = droneConfigForCommandState(parent, drone?.type);
  return { config, runtime: ensureDroneRuntimeConfig(drone, config) };
}

module.exports = {
  CONFIG,
  DRONE_DECISION_INTERVAL_MS,
  DRONE_DECISION_INTERVALS_MS,
  MAX_CONFIGURED_DRONE_SPEED,
  droneConfigForCommandState,
  buildDroneRuntimeConfig,
  ensureDroneRuntimeConfig,
  effectiveDroneConfig
};
