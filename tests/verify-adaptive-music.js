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
  constructor(src){ this.src = src; this.loop = false; this.preload = ''; this.volume = 0; this.paused = false; this.duration = 240; this.currentTime = 0; created.push(this); }
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
assert.ok(ambient.src.endsWith('Always.wav') && combat.src.endsWith('Combat.wav'));
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

// Drift correction keeps the two stems phase-aligned.
combat.currentTime = 12.0;
ambient.currentTime = 11.0;
advance(50);
assert.equal(combat.currentTime, 11.0, 'a drifted combat stem is reseeked onto the ambient stem');
combat.currentTime = 11.1;
ambient.currentTime = 11.0;
advance(50);
assert.equal(combat.currentTime, 11.1, 'small drift is left alone');

console.log('Adaptive music verification passed');
