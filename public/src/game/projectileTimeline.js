// Pure projectile presentation timing.  Keeping this separate from Pixi makes
// the spawn-time boundary testable without constructing a renderer.

export function selectProjectileSample(currentSample, previousSample, renderTimeMs) {
  if (!currentSample) return null;
  const currentTime = Number(currentSample.simulationTimeMs);
  if (!Number.isFinite(currentTime) || !Number.isFinite(renderTimeMs)) return null;
  if (renderTimeMs < currentTime) return previousSample || null;
  return currentSample;
}

export function projectBallisticProjectile(currentSample, previousSample, renderTimeMs) {
  const sample = selectProjectileSample(currentSample, previousSample, renderTimeMs);
  if (!sample) return null;
  const sampleTime = Number(sample.simulationTimeMs);
  const delta = Math.max(0, (renderTimeMs - sampleTime) / 1000);
  return {
    sample,
    x: sample.x + sample.vx * delta,
    y: sample.y + sample.vy * delta,
    vx: sample.vx,
    vy: sample.vy
  };
}
