// Renders notifications, warning notices, and overlay alert toasts.

import { dom } from "./dom.js";
import { state } from "../state.js";

const DURATIONS = {
  clipboard: 1800,
  routine: 2600,
  warning: 5000,
  error: 12000,
  urgent: 8000
};

const activeToastKeys = new Map();

function isKeyBlocked(key) {
  const until = activeToastKeys.get(key);
  if (!until) return false;
  if (until > performance.now()) return true;
  activeToastKeys.delete(key);
  return false;
}

function blockToastKey(key, ttl = 5000) {
  if (!key) return;
  activeToastKeys.set(key, performance.now() + ttl);
  setTimeout(() => {
    if (activeToastKeys.get(key) <= performance.now()) activeToastKeys.delete(key);
  }, ttl + 100);
}

function syncToastModalClass() {
  if (!dom.toastStack) return;
  const modalOpen = (dom.confirmModal && !dom.confirmModal.hidden) ||
                    (dom.keybindsModal && !dom.keybindsModal.hidden);
  dom.toastStack.classList.toggle("modal-open", modalOpen);
}

if (typeof MutationObserver !== "undefined") {
  const toastModalObserver = new MutationObserver(syncToastModalClass);
  if (dom.confirmModal) toastModalObserver.observe(dom.confirmModal, { attributes: true, attributeFilter: ["hidden"] });
  if (dom.keybindsModal) toastModalObserver.observe(dom.keybindsModal, { attributes: true, attributeFilter: ["hidden"] });
}

export function showToast(text, toneOrOptions = "") {
  if (!dom.toastStack || !text) return;
  syncToastModalClass();
  const options = typeof toneOrOptions === "string" ? { tone: toneOrOptions } : toneOrOptions || {};
  const tone = options.tone || "";
  const key = options.key;
  if (key && isKeyBlocked(key)) return;

  const duration = options.duration ?? DURATIONS[tone] ?? DURATIONS.routine;
  const toast = document.createElement("div");
  toast.className = `toast ${tone}`.trim();
  if (options.color) toast.style.borderLeftColor = options.color;
  toast.textContent = text;
  if (options.role) toast.setAttribute("role", options.role);
  dom.toastStack.prepend(toast);

  while (dom.toastStack.children.length > 4) {
    dom.toastStack.lastElementChild.remove();
  }

  if (key) blockToastKey(key, options.keyTtl ?? 5000);

  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateY(-6px)";
  }, duration);
  setTimeout(() => toast.remove(), duration + 600);
}

export function addLog(text, tone = "") {
  const clean = String(text || "").slice(0, 120);
  if (state.notices.length && state.notices[0].text === clean && state.notices[0].tone === tone) return;
  state.notices.unshift({ text: clean, tone, at: performance.now() });
  state.notices = state.notices.slice(0, 20);
  renderCombatLog();
}

export function addNotice(text, tone = "") {
  addLog(text, tone);
  showToast(text, tone);
}

function syncCombatLogToggle() {
  if (dom.combatLog && dom.combatLog.dataset.expanded == null) dom.combatLog.dataset.expanded = "false";
  const expanded = dom.combatLog?.dataset.expanded === "true";
  if (dom.combatLogToggle) {
    dom.combatLogToggle.textContent = expanded ? "Collapse" : "Expand";
    dom.combatLogToggle.setAttribute("aria-expanded", String(expanded));
  }
}

function renderCombatLog() {
  if (!dom.eventLog || !state.notices) return;
  dom.eventLog.textContent = "";
  const expanded = dom.combatLog?.dataset.expanded === "true";
  const limit = expanded ? 10 : 1;
  for (const notice of state.notices.slice(0, limit)) {
    const line = document.createElement("div");
    line.className = `log-entry ${notice.tone || ""}`.trim();
    line.textContent = notice.text;
    dom.eventLog.appendChild(line);
  }
}

function toggleCombatLog() {
  if (!dom.combatLog) return;
  dom.combatLog.dataset.expanded = dom.combatLog.dataset.expanded === "true" ? "false" : "true";
  syncCombatLogToggle();
  renderCombatLog();
}

export const notify = {
  error(text, options = {}) {
    addLog(text, "error");
    showToast(text, { tone: "error", ...options });
  },
  warning(text, options = {}) {
    addLog(text, "warning");
    showToast(text, { tone: "warning", ...options });
  },
  urgent(text, options = {}) {
    addLog(text, "urgent");
    showToast(text, { tone: "urgent", ...options });
  },
  // Neutral confirmation of something the player just did that has no other
  // visible result yet (a station build order, for instance).
  info(text, options = {}) {
    addLog(text, "good");
    showToast(text, { tone: "good", ...options });
  },
  clipboard(text, success = true) {
    const tone = success ? "good" : "warning";
    showToast(text, { tone, duration: DURATIONS.clipboard });
  },
  log(text, tone = "") {
    addLog(text, tone);
  },
  inline() {
    // Callers should update the relevant control directly; this is a no-op.
  },
  silent() {
    // Explicit no-op for events that need no feedback.
  }
};

if (dom.combatLogToggle) {
  dom.combatLogToggle.addEventListener("click", toggleCombatLog);
}

