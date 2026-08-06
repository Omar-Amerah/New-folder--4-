// Two-stem adaptive music. Both tracks are the same length and are played as
// layered stems of one piece: the ambient stem runs for the whole session, and
// the combat stem runs alongside it permanently muted, fading up to the same
// volume while combat is happening and back down to silence once it stops.
//
// Playing (rather than starting/stopping) the combat stem is what keeps the two
// layers phase-aligned; starting it on demand would drop it in at an arbitrary
// bar. A drift correction below repairs the small clock skew two independent
// <audio> elements accumulate over a long session.

import { loadPreferences, persistPreferences } from "../localPreferences.js";

const AMBIENT_SRC = "/audio/Ambient.mp3";
const COMBAT_SRC = "/audio/Combat.mp3";

// Combat fades up quickly so it lands with the action, holds for 20s past the
// last combat event, then falls away slowly enough not to sound like a cut.
export const COMBAT_FADE_IN_MS = 1500;
export const COMBAT_HOLD_MS = 20000;
export const COMBAT_FADE_OUT_MS = 4000;

const TICK_MS = 50;
// Beyond this the two stems are audibly out of phase and worth a hard reseek.
const MAX_DRIFT_SECONDS = 0.25;

// Effects the server emits that mean "something is shooting or being shot".
// Support and logistics effects (repair beams, drone launches, warps, floating
// status text) are deliberately excluded — they happen constantly out of
// combat and would pin the combat stem on forever.
const COMBAT_EFFECT_TYPES = new Set([
  "beam",
  "laserPdPulse",
  "laserpd",
  "pdIntercept",
  "droneshot",
  "droneburst",
  "boom",
  "railhit",
  "rockhit",
  "shieldhit",
  "spark",
  "burst",
  "flakburst",
  "decoyburst",
  "selfdestruct",
  "destructcharge",
  "dmg"
]);

let ambientAudio = null;
let combatAudio = null;
let tickTimer = null;
let lastTickAt = 0;

let musicEnabled = true;
let musicVolume = 0.6;
// 0 = combat stem silent, 1 = combat stem at full music volume.
let combatGain = 0;
let lastCombatAt = -Infinity;
let unlockBound = false;

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function createLoop(src) {
  const audio = new Audio(src);
  audio.loop = true;
  audio.preload = "auto";
  audio.volume = 0;
  return audio;
}

function applyVolumes() {
  if (ambientAudio) ambientAudio.volume = musicEnabled ? musicVolume : 0;
  // The combat stem never gets louder than the ambient stem — at full gain the
  // two sit at exactly the same level, which is what makes them read as one
  // piece of music rather than a second track layered on top.
  if (combatAudio) combatAudio.volume = musicEnabled ? musicVolume * combatGain : 0;
}

// Retries playback until a user gesture satisfies the browser autoplay policy.
// The elements stay "playing" from the game's point of view either way; only
// the actual decode is deferred.
function attemptPlayback() {
  for (const audio of [ambientAudio, combatAudio]) {
    if (!audio || !audio.paused) continue;
    const started = audio.play();
    if (started && typeof started.catch === "function") started.catch(bindUnlockGesture);
  }
}

function bindUnlockGesture() {
  if (unlockBound || typeof window === "undefined") return;
  unlockBound = true;
  const unlock = () => {
    unlockBound = false;
    window.removeEventListener("pointerdown", unlock);
    window.removeEventListener("keydown", unlock);
    attemptPlayback();
  };
  window.addEventListener("pointerdown", unlock, { once: true });
  window.addEventListener("keydown", unlock, { once: true });
}

// Two independent media elements drift apart over minutes. Nudge the combat
// stem back onto the ambient stem's clock, comparing modulo the loop length so
// a wrap-around does not read as a full-track jump.
function correctStemDrift() {
  if (!ambientAudio || !combatAudio) return;
  if (ambientAudio.paused || combatAudio.paused) return;
  const duration = ambientAudio.duration;
  if (!Number.isFinite(duration) || duration <= 0) return;
  let drift = combatAudio.currentTime - ambientAudio.currentTime;
  drift -= Math.round(drift / duration) * duration;
  if (Math.abs(drift) <= MAX_DRIFT_SECONDS) return;
  try { combatAudio.currentTime = ambientAudio.currentTime; } catch { /* seek not ready yet */ }
}

export function musicTick(now = Date.now()) {
  const dt = lastTickAt ? Math.min(1000, Math.max(0, now - lastTickAt)) : 0;
  lastTickAt = now;

  const target = now - lastCombatAt <= COMBAT_HOLD_MS ? 1 : 0;
  if (target > combatGain) {
    combatGain = Math.min(1, combatGain + dt / COMBAT_FADE_IN_MS);
  } else if (target < combatGain) {
    combatGain = Math.max(0, combatGain - dt / COMBAT_FADE_OUT_MS);
  }

  applyVolumes();
  attemptPlayback();
  correctStemDrift();
}

// Called once per rendered frame with the snapshot being drawn. Any live
// projectile or combat effect counts as "combat is happening right now" and
// restarts the 20s hold.
export function updateMusicCombatState(snapshot, now = Date.now()) {
  if (!snapshot) return;
  if (snapshot.bullets && snapshot.bullets.length > 0) {
    lastCombatAt = now;
    return;
  }
  const effects = snapshot.effects;
  if (!effects || effects.length === 0) return;
  for (const effect of effects) {
    if (!COMBAT_EFFECT_TYPES.has(effect.type)) continue;
    // The induction lance shares the "beam" type but carries no damage.
    if (effect.type === "beam" && effect.subtype === "induction") continue;
    lastCombatAt = now;
    return;
  }
}

export function setMusicEnabled(enabled) {
  musicEnabled = !!enabled;
  persistPreferences({ ...loadPreferences().preferences, musicEnabled });
  applyVolumes();
  if (musicEnabled) attemptPlayback();
}

export function setMusicVolume(volume) {
  musicVolume = clamp01(volume);
  persistPreferences({ ...loadPreferences().preferences, musicVolume });
  applyVolumes();
}

export function getMusicEnabled() { return musicEnabled; }
export function getMusicVolume() { return musicVolume; }
// Exposed for tests and the debug overlay: 0 while out of combat, 1 at full combat.
export function getCombatMusicGain() { return combatGain; }

export function initMusic(preferences) {
  if (typeof Audio === "undefined" || ambientAudio) return;
  const prefs = preferences || loadPreferences().preferences;
  musicEnabled = prefs.musicEnabled !== false;
  musicVolume = clamp01(prefs.musicVolume);

  ambientAudio = createLoop(AMBIENT_SRC);
  combatAudio = createLoop(COMBAT_SRC);
  applyVolumes();
  attemptPlayback();

  lastTickAt = 0;
  tickTimer = setInterval(() => musicTick(Date.now()), TICK_MS);
}

export function destroyMusic() {
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = null;
  for (const audio of [ambientAudio, combatAudio]) {
    if (!audio) continue;
    audio.pause();
    audio.src = "";
  }
  ambientAudio = null;
  combatAudio = null;
  combatGain = 0;
  lastCombatAt = -Infinity;
}
