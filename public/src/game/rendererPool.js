// Reusable bounded object pool for renderer views.
export function createRendererPool({ name = "pool", create, reset = () => {}, destroy = () => {}, maxIdle = 32 } = {}) {
  if (typeof create !== "function") throw new TypeError("create is required");
  const idle = [];
  const active = new Set();
  let peakActive = 0;
  let peakIdle = 0;
  let destroyed = false;
  let duplicateReleases = 0;
  function assertLive() { if (destroyed) throw new Error(`${name} pool is destroyed`); }
  function releaseObject(obj, trimOverflow = true) {
    if (!active.has(obj)) { duplicateReleases += 1; return false; }
    active.delete(obj);
    reset(obj);
    if (!trimOverflow || idle.length < maxIdle) {
      idle.push(obj); peakIdle = Math.max(peakIdle, idle.length);
    } else {
      destroy(obj);
    }
    return true;
  }
  return {
    acquire() { assertLive(); const obj = idle.pop() || create(); active.add(obj); peakActive = Math.max(peakActive, active.size); return obj; },
    release(obj) { assertLive(); return releaseObject(obj); },
    reset() { assertLive(); for (const obj of [...active]) releaseObject(obj, false); this.trim(maxIdle); },
    trim(limit = maxIdle) { assertLive(); while (idle.length > Math.max(0, limit)) destroy(idle.pop()); },
    clear() { if (destroyed) return; for (const obj of active) { reset(obj); destroy(obj); } for (const obj of idle) destroy(obj); active.clear(); idle.length = 0; destroyed = true; },
    activeCount() { return active.size; }, idleCount() { return idle.length; }, peakCount() { return peakActive; }, maxIdleCount() { return maxIdle; },
    diagnostics() { return { name, active: active.size, idle: idle.length, peakActive, peakIdle, maxIdle, duplicateReleases, destroyed }; }
  };
}
