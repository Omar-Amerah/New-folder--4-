// Two-stem adaptive music. Both tracks are the same length and are played as
// layered stems of one piece: the ambient stem runs for the whole session, and
// the combat stem runs alongside it permanently muted, fading up to the same
// volume while combat is happening and back down to silence once it stops.
//
// Playing (rather than starting/stopping) the combat stem is what keeps the two
// layers phase-aligned; starting it on demand would drop it in at an arbitrary
// bar. That alone is not enough — two <audio> elements run on independent
// clocks, start at whatever moment autoplay lets them, and wrap their loops
// separately — so syncStems() below holds the combat stem on the ambient stem's
// clock every tick: snapped exactly while it is silent, and nudged by a tiny
// playbackRate trim while it can be heard.

import { loadPreferences, persistPreferences } from "../localPreferences.js";

const AMBIENT_SRC = "/audio/Ambient.mp3";
const COMBAT_SRC = "/audio/Combat.mp3";

// Combat fades up quickly so it lands with the action, holds for 20s past the
// last combat event, then falls away slowly enough not to sound like a cut.
export const COMBAT_FADE_IN_MS = 1500;
export const COMBAT_HOLD_MS = 20000;
export const COMBAT_FADE_OUT_MS = 4000;

const TICK_MS = 50;
// Phase lock thresholds. Two <audio> elements run on independent clocks and
// wrap their loops independently, so drift has to be actively corrected rather
// than merely tolerated.
//
// Within the deadband the stems are tight enough that no correction is worth
// the disturbance. Past it the combat stem's playbackRate is trimmed so it
// slides back into phase without an audible seek — but only while the stem can
// actually be heard. Whenever the combat stem is silent (out of combat, or
// music muted) a seek costs nothing, so it is snapped to an exact match; that
// is what guarantees every combat entrance starts perfectly aligned.
const SYNC_DEADBAND_SECONDS = 0.012;
// While the stem is silent, anything past this is snapped away outright.
const SILENT_SNAP_SECONDS = 0.03;
const SEEK_COOLDOWN_MS = 500;
// A seek is worth its glitch only once the stems are grossly apart.
const AUDIBLE_RESEEK_SECONDS = 0.35;
// Drift the rate trim is expected to swallow on its own; larger errors just
// clamp to the maximum trim.
const RATE_TRIM_RANGE_SECONDS = 0.3;
// 1.5% is roughly 26 cents of pitch — inaudible on a sustained bed, and closes
// the deadband in a couple of seconds.
const MAX_RATE_TRIM = 0.015;
// Smoothing for the drift estimate: currentTime only advances when the element
// services its audio thread, so raw per-tick readings are quantised and noisy.
const DRIFT_SMOOTHING = 0.25;
// Below this gain the combat stem is buried under the ambient stem, so the
// first moments of a fade-in are still cheap enough to seek through.
const INAUDIBLE_GAIN = 0.03;

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
let smoothedDrift = 0;
let lastSeekAt = -Infinity;

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

function setCombatRate(rate) {
  if (!combatAudio) return;
  if (combatAudio.playbackRate === rate) return;
  try { combatAudio.playbackRate = rate; } catch { /* rate not settable yet */ }
}

// Seeking a media element costs a re-buffer, and its currentTime reading is
// quantised to whatever the audio thread last published, so seeks are rate
// limited: without this the noise floor alone would trigger one every tick.
function seekCombatToAmbient(now) {
  if (now - lastSeekAt < SEEK_COOLDOWN_MS) return;
  try { combatAudio.currentTime = ambientAudio.currentTime; } catch { return; }
  lastSeekAt = now;
  smoothedDrift = 0;
}

// Holds the combat stem on the ambient stem's clock. The two elements drift
// apart over a session — they start at slightly different moments when autoplay
// unlocks, decode on independent clocks, and wrap their loops independently —
// so this runs every tick rather than waiting for the gap to become audible.
//
// Drift is compared modulo the loop length so a wrap-around does not read as a
// full-track jump.
function syncStems(now) {
  if (!ambientAudio || !combatAudio) return;
  if (ambientAudio.paused || combatAudio.paused) {
    // Nothing meaningful to measure; leave the rate neutral so playback resumes
    // at pitch and the next tick re-aligns from scratch.
    setCombatRate(1);
    return;
  }
  const duration = ambientAudio.duration;
  if (!Number.isFinite(duration) || duration <= 0) return;

  let drift = combatAudio.currentTime - ambientAudio.currentTime;
  drift -= Math.round(drift / duration) * duration;
  smoothedDrift += (drift - smoothedDrift) * DRIFT_SMOOTHING;

  // While the combat stem is inaudible a seek has no cost, so keep it exactly
  // locked. Every fade-in therefore begins from a perfect match.
  const audible = musicEnabled && combatGain > INAUDIBLE_GAIN;
  if (!audible) {
    setCombatRate(1);
    if (Math.abs(smoothedDrift) > SILENT_SNAP_SECONDS) seekCombatToAmbient(now);
    return;
  }

  if (Math.abs(smoothedDrift) > AUDIBLE_RESEEK_SECONDS) {
    setCombatRate(1);
    seekCombatToAmbient(now);
    return;
  }
  if (Math.abs(smoothedDrift) <= SYNC_DEADBAND_SECONDS) {
    setCombatRate(1);
    return;
  }
  // Ahead of the ambient stem: play slower. Behind: play faster.
  const correction = Math.max(-1, Math.min(1, smoothedDrift / RATE_TRIM_RANGE_SECONDS));
  setCombatRate(1 - correction * MAX_RATE_TRIM);
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
  syncStems(now);
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
  smoothedDrift = 0;
  lastSeekAt = -Infinity;
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
  smoothedDrift = 0;
  lastSeekAt = -Infinity;
}
