const HISTORY_LIMIT = 360;
const PHASES = ["startup", "warmup", "steady", "transition", "cleanup"];
const phaseBaseline = () => ({ frameCount: 0, totalMs: 0, worstMs: 0, over33: 0, over50: 0, samples: [] });
const baseline = () => ({ frameCount:0, peakEntityViews:0, peakPoolCount:0, textureCreations:0, textureDestructions:0, structuralRebuilds:0, staticMapRebuilds:0, fatalFrameStage:null, frames:[], phases: Object.fromEntries(PHASES.map((p)=>[p, phaseBaseline()])), currentPhase: "startup", resetAt: 0 });
let metrics = baseline();
function finite(value, fallback = 0) { return Number.isFinite(value) ? value : fallback; }
function percentile(samples, p) { if (!samples.length) return 0; const sorted = [...samples].sort((a,b)=>a-b); return sorted[Math.min(sorted.length-1, Math.floor((sorted.length-1)*p))]; }
function summarize(bucket) { const n = bucket.frameCount || 0; return { measuredFrames: n, averageMs: n ? bucket.totalMs / n : 0, p50Ms: percentile(bucket.samples, 0.50), p95Ms: percentile(bucket.samples, 0.95), p99Ms: percentile(bucket.samples, 0.99), worstMs: bucket.worstMs || 0, framesOver33Ms: bucket.over33 || 0, framesOver50Ms: bucket.over50 || 0, renderedFps: bucket.totalMs > 0 ? (n * 1000) / bucket.totalMs : 0 }; }
export function resetRendererMetrics(phase = "startup"){ metrics = baseline(); metrics.currentPhase = PHASES.includes(phase) ? phase : "startup"; metrics.resetAt = performance?.now?.() || Date.now(); }
export function setRendererMetricsPhase(phase, { reset = false } = {}) { if (!PHASES.includes(phase)) return metrics.currentPhase; metrics.currentPhase = phase; if (reset) metrics.phases[phase] = phaseBaseline(); return metrics.currentPhase; }
export function recordRendererFrame(sample={}){
  const durationMs = finite(sample.durationMs, 0);
  const phase = PHASES.includes(sample.phase) ? sample.phase : metrics.currentPhase;
  metrics.frameCount += 1;
  metrics.peakEntityViews = Math.max(metrics.peakEntityViews, sample.entityViews || 0);
  metrics.peakPoolCount = Math.max(metrics.peakPoolCount, sample.poolCount || 0);
  if (sample.fatalFrameStage) metrics.fatalFrameStage = sample.fatalFrameStage;
  const bucket = metrics.phases[phase] || metrics.phases.steady;
  bucket.frameCount += 1; bucket.totalMs += durationMs; bucket.worstMs = Math.max(bucket.worstMs, durationMs); if (durationMs > 33) bucket.over33 += 1; if (durationMs > 50) bucket.over50 += 1; bucket.samples.push(durationMs); if (bucket.samples.length > HISTORY_LIMIT) bucket.samples.shift();
  metrics.frames.push({ at: finite(sample.at, performance?.now?.() || Date.now()), durationMs, phase, visible: sample.visible || 0, culled: sample.culled || 0, sceneChildren: sample.sceneChildren || 0, qualityProfile: sample.qualityProfile || "medium", rendererResolution: sample.rendererResolution || 1 });
  if (metrics.frames.length > HISTORY_LIMIT) metrics.frames.shift();
}
export function incrementRendererMetric(name, amount=1){ if (name in metrics) metrics[name] += amount; }
export function rendererMetricsSnapshot(extra={}){ const last = metrics.frames[metrics.frames.length-1] || {}; return { frameCount: metrics.frameCount, measuredFrames: metrics.frameCount, currentPhase: metrics.currentPhase, phases: Object.fromEntries(Object.entries(metrics.phases).map(([k,v])=>[k, summarize(v)])), rollingFrameStats: summarize({ frameCount: metrics.frames.length, totalMs: metrics.frames.reduce((a,f)=>a+finite(f.durationMs),0), worstMs: Math.max(0,...metrics.frames.map(f=>finite(f.durationMs))), over33: metrics.frames.filter(f=>f.durationMs>33).length, over50: metrics.frames.filter(f=>f.durationMs>50).length, samples: metrics.frames.map(f=>finite(f.durationMs)) }), activeEntityViews: extra.activeEntityViews || 0, peakEntityViews: metrics.peakEntityViews, activePoolCount: extra.activePoolCount || 0, peakPoolCount: metrics.peakPoolCount, visibleCount: last.visible || 0, culledCount: last.culled || 0, textureCreationCount: metrics.textureCreations, textureDestructionCount: metrics.textureDestructions, textureCacheEntries: extra.textureCacheEntries || 0, zeroLeaseEntries: extra.zeroLeaseEntries || 0, structuralRebuildCount: metrics.structuralRebuilds, staticMapRebuildCount: metrics.staticMapRebuilds, sceneChildCounts: extra.sceneChildCounts || {}, qualityProfile: last.qualityProfile || extra.qualityProfile || "medium", rendererResolution: last.rendererResolution || extra.rendererResolution || 1, fatalFrameStage: metrics.fatalFrameStage }; }
