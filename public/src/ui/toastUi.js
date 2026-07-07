// Renders notifications, warning notices, and overlay alert toasts.

import { dom } from "./dom.js";
import { state } from "../state.js";


export function showToast(text, tone = "") {
  if (!dom.toastStack) return;
  const toast = document.createElement("div");
  toast.className = `toast ${tone || ""}`.trim();
  toast.textContent = text;
  dom.toastStack.prepend(toast);

  while (dom.toastStack.children.length > 4) {
    dom.toastStack.lastElementChild.remove();
  }

  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateY(-6px)";
  }, 2600);
  setTimeout(() => toast.remove(), 3200);
}

export function addNotice(text, tone = "") {
  const clean = String(text || "").slice(0, 90);
  state.notices.unshift({ text: clean, tone, at: performance.now() });
  state.notices = state.notices.slice(0, 7);
  if (dom.eventLog) {
    dom.eventLog.textContent = "";
    for (const notice of state.notices) {
      const line = document.createElement("div");
      line.textContent = notice.text;
      dom.eventLog.appendChild(line);
    }
  }
  showToast(clean, tone);
}

