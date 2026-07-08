
let cachedRenderQuality = null;

export function getRenderQuality() {
  if (cachedRenderQuality !== null) return cachedRenderQuality;
  const stored = localStorage.getItem("mfa.renderQuality");
  if (["low", "medium", "high"].includes(stored)) {
    cachedRenderQuality = stored;
  } else {
    cachedRenderQuality = "high";
  }
  return cachedRenderQuality;
}

export function setRenderQuality(quality) {
  if (["low", "medium", "high"].includes(quality)) {
    localStorage.setItem("mfa.renderQuality", quality);
    cachedRenderQuality = quality;
  }
}

export function qualityShadowBlur(value) {
  const q = getRenderQuality();
  if (q === "low") return 0;
  if (q === "medium") return value * 0.45;
  return value;
}

export function getRenderQualityDprCap() {
  const q = getRenderQuality();
  if (q === "low") return 1.25;
  if (q === "medium") return 1.5;
  return 2.0;
}
