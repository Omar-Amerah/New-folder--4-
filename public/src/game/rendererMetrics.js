const HISTORY_LIMIT = 120;
const baseline = () => ({ frameCount:0, peakEntityViews:0, peakPoolCount:0, textureCreations:0, textureDestructions:0, structuralRebuilds:0, staticMapRebuilds:0, fatalFrameStage:null, frames:[] });
let metrics = baseline();
export function resetRendererMetrics(){ metrics = baseline(); }
export function recordRendererFrame(sample={}){
  metrics.frameCount += 1;
  metrics.peakEntityViews = Math.max(metrics.peakEntityViews, sample.entityViews || 0);
  metrics.peakPoolCount = Math.max(metrics.peakPoolCount, sample.poolCount || 0);
  if (sample.fatalFrameStage) metrics.fatalFrameStage = sample.fatalFrameStage;
  metrics.frames.push({ visible: sample.visible || 0, culled: sample.culled || 0, sceneChildren: sample.sceneChildren || 0, qualityProfile: sample.qualityProfile || "medium", rendererResolution: sample.rendererResolution || 1 });
  if (metrics.frames.length > HISTORY_LIMIT) metrics.frames.shift();
}
export function incrementRendererMetric(name, amount=1){ if (name in metrics) metrics[name] += amount; }
export function rendererMetricsSnapshot(extra={}){ const last = metrics.frames[metrics.frames.length-1] || {}; return { frameCount: metrics.frameCount, activeEntityViews: extra.activeEntityViews || 0, peakEntityViews: metrics.peakEntityViews, activePoolCount: extra.activePoolCount || 0, peakPoolCount: metrics.peakPoolCount, visibleCount: last.visible || 0, culledCount: last.culled || 0, textureCreationCount: metrics.textureCreations, textureDestructionCount: metrics.textureDestructions, textureCacheEntries: extra.textureCacheEntries || 0, zeroLeaseEntries: extra.zeroLeaseEntries || 0, structuralRebuildCount: metrics.structuralRebuilds, staticMapRebuildCount: metrics.staticMapRebuilds, sceneChildCounts: extra.sceneChildCounts || {}, qualityProfile: last.qualityProfile || extra.qualityProfile || "medium", rendererResolution: last.rendererResolution || extra.rendererResolution || 1, fatalFrameStage: metrics.fatalFrameStage }; }
