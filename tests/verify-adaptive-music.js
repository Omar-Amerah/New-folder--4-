import assert from 'node:assert/strict';

const stored = new Map();
globalThis.localStorage = globalThis.localStorage || {
  getItem(k){ return stored.has(k) ? stored.get(k) : null; },
  setItem(k,v){ stored.set(k,String(v)); },
  removeItem(k){ stored.delete(k); }
};
globalThis.window = globalThis.window || { addEventListener(){}, removeEventListener(){} };

// Minimal <audio> stand-in. Records the volume the music system writes so the
// fade curve can be asserted directly.
const created = [];
globalThis.Audio = class {
  constructor(src){ this.src = src; this.loop = false; this.preload = ''; this.volume = 0; this.paused = false; this.duration = 240; this.currentTime = 0; this.playbackRate = 1; created.push(this); }
  play(){ this.paused = false; return Promise.resolve(); }
  pause(){ this.paused = true; }
};
globalThis.setInterval = () => 0;
globalThis.clearInterval = () => {};

const music = await import('../public/src/audio/musicSystem.js');
const { COMBAT_FADE_IN_MS, COMBAT_HOLD_MS, COMBAT_FADE_OUT_MS } = music;

music.initMusic({ musicEnabled: true, musicVolume: 0.5 });
const [ambient, combat] = created;
assert.equal(created.length, 2, 'ambient and combat stems are both created');
assert.ok(ambient.src.endsWith('Ambient.mp3') && combat.src.endsWith('Combat.mp3'));
assert.ok(ambient.loop && combat.loop, 'both stems loop');
assert.ok(!ambient.paused && !combat.paused, 'both stems play at all times');

// Advances the fade state machine in small steps, as the real 50ms timer does.
let clock = 1_000_000;
function advance(ms, { combatActive = false } = {}) {
  const end = clock + ms;
  while (clock < end) {
    clock = Math.min(end, clock + 50);
    if (combatActive) music.updateMusicCombatState({ bullets: [{ id: 'b1' }] }, clock);
    music.musicTick(clock);
  }
}

advance(0);
assert.equal(ambient.volume, 0.5, 'ambient plays at the configured music volume');
assert.equal(combat.volume, 0, 'combat starts muted');

advance(2000);
assert.equal(combat.volume, 0, 'combat stays muted while nothing is happening');

// Non-combat effects must not wake the combat stem.
music.updateMusicCombatState({ bullets: [], effects: [{ type: 'repairbeam' }, { type: 'dronelaunch' }, { type: 'beam', subtype: 'induction' }] }, clock);
advance(2000);
assert.equal(combat.volume, 0, 'support effects do not count as combat');

// Combat effects do.
music.updateMusicCombatState({ bullets: [], effects: [{ type: 'shieldhit' }] }, clock);
advance(200);
assert.ok(combat.volume > 0, 'a combat effect starts the fade in');

advance(COMBAT_FADE_IN_MS, { combatActive: true });
assert.equal(combat.volume, 0.5, 'combat fades in to the same volume as ambient');
assert.equal(ambient.volume, 0.5, 'ambient is unaffected by combat');

// Sustained combat holds it there.
advance(30_000, { combatActive: true });
assert.equal(combat.volume, 0.5, 'combat stays up while fighting continues');

// Last combat event: hold for 20s, then fade to silence.
advance(COMBAT_HOLD_MS - 1000);
assert.equal(combat.volume, 0.5, 'combat holds full volume through the 20s tail');
advance(2000);
assert.ok(combat.volume < 0.5 && combat.volume > 0, 'combat fades out after the hold expires');
advance(COMBAT_FADE_OUT_MS);
assert.equal(combat.volume, 0, 'combat returns to silence');
assert.equal(ambient.volume, 0.5, 'ambient never stops');

// Renewed combat during the fade-out brings it back up.
advance(500, { combatActive: true });
assert.ok(combat.volume > 0, 'new combat re-triggers the fade in');
advance(COMBAT_FADE_IN_MS, { combatActive: true });
assert.equal(combat.volume, 0.5);

// Volume and mute settings.
music.setMusicVolume(0.2);
assert.equal(ambient.volume, 0.2, 'ambient follows the volume setting immediately');
assert.equal(combat.volume, 0.2, 'combat follows the volume setting at full gain');
music.setMusicEnabled(false);
assert.equal(ambient.volume, 0, 'mute silences ambient');
assert.equal(combat.volume, 0, 'mute silences combat');
assert.ok(!ambient.paused && !combat.paused, 'muting keeps both stems running so they stay in phase');
music.setMusicEnabled(true);
assert.equal(ambient.volume, 0.2, 'unmuting restores the configured volume');

// Persisted settings survive a reload.
const { loadPreferences } = await import('../public/src/localPreferences.js');
const prefs = loadPreferences().preferences;
assert.equal(prefs.musicVolume, 0.2, 'music volume persists');
assert.equal(prefs.musicEnabled, true, 'music enabled state persists');

// --- Phase lock between the two stems -------------------------------------
// While the combat stem is silent a seek is inaudible, so it is snapped onto
// the ambient stem exactly. That is what makes every fade-in start aligned.
advance(COMBAT_HOLD_MS + COMBAT_FADE_OUT_MS + 1000);
assert.equal(music.getCombatMusicGain(), 0, 'combat stem is silent again');

ambient.currentTime = 11.0;
combat.currentTime = 12.0;
advance(50);
assert.equal(combat.currentTime, 11.0, 'a silent combat stem is snapped onto the ambient stem');
assert.equal(combat.playbackRate, 1, 'snapping does not touch the playback rate');

// Media elements publish currentTime coarsely, so a few milliseconds of
// apparent drift is noise and must not provoke a seek on every tick.
ambient.currentTime = 30.0;
combat.currentTime = 30.008;
advance(1000);
assert.equal(combat.currentTime, 30.008, 'measurement noise does not provoke a seek');

// Once the stem is audible, drift is corrected by trimming its rate instead —
// a seek would be heard as a jump in the middle of the music.
advance(COMBAT_FADE_IN_MS + 200, { combatActive: true });
assert.ok(music.getCombatMusicGain() > 0.99, 'combat stem is at full gain');

ambient.currentTime = 40.0;
combat.currentTime = 40.1;
advance(200, { combatActive: true });
assert.equal(combat.currentTime, 40.1, 'an audible stem is not reseeked for ordinary drift');
assert.ok(combat.playbackRate < 1, 'a stem running ahead is slowed down');

ambient.currentTime = 50.1;
combat.currentTime = 50.0;
advance(400, { combatActive: true });
assert.ok(combat.playbackRate > 1, 'a stem running behind is sped up');
assert.ok(Math.abs(combat.playbackRate - 1) <= 0.02, 'the rate trim stays small enough to be inaudible');

// A wrap-around is a phase match, not a full-track jump.
ambient.currentTime = 0.02;
combat.currentTime = 239.99;
advance(400, { combatActive: true });
assert.equal(combat.currentTime, 239.99, 'looping past the end is not mistaken for gross drift');

// In phase: no correction at all.
ambient.currentTime = 60.0;
combat.currentTime = 60.0;
advance(1000, { combatActive: true });
assert.equal(combat.playbackRate, 1, 'stems in phase run at normal speed');

// Gross drift is worth the glitch even while audible.
ambient.currentTime = 70.0;
combat.currentTime = 71.5;
advance(1000, { combatActive: true });
assert.equal(combat.currentTime, 70.0, 'grossly drifted stems are reseeked even when audible');
assert.equal(combat.playbackRate, 1, 'the rate trim is released after a reseek');

console.log('Adaptive music verification passed');
