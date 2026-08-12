// Presents transient validation feedback inside the Blueprint Designer shell.
// Persistent validity remains the responsibility of Ship Summary.

import { dom } from "./dom.js";
import {
  formatDisconnectedComponents,
  formatDisconnectedComponentDetails
} from "../design/blueprintValidation.js";

export const DESIGNER_NOTICE_DURATION_MS = 3200;
const NOTICE_FADE_OUT_MS = 180;
const SAME_NOTICE_GUARD_MS = 750;
const NOTICE_GRID_EDGE_INSET_PX = 0;
const GENERIC_DISCONNECTED_ERROR = /^Invalid design:\s*disconnected parts\.$/i;

let dismissTimer = null;
let removeTimer = null;
let lastShownSignature = null;
let lastShownAt = 0;
let noticeSequence = 0;

function now() {
  return Date.now();
}

function clearNoticeTimers() {
  if (dismissTimer !== null) clearTimeout(dismissTimer);
  if (removeTimer !== null) clearTimeout(removeTimer);
  dismissTimer = null;
  removeTimer = null;
}

function noticeSignature(message, detail) {
  return `${message}\u0000${detail}`;
}

function validationNoticeCopy({ design = [], errors = [], disconnectedComponentIndices = [] } = {}) {
  const resolvedErrors = Array.isArray(errors) ? errors.filter(Boolean).map(String) : [];
  const resolvedIndices = Array.isArray(disconnectedComponentIndices) ? disconnectedComponentIndices : [];
  const otherErrors = resolvedErrors.filter((error) => !GENERIC_DISCONNECTED_ERROR.test(error));

  if (resolvedIndices.length) {
    const message = resolvedIndices.length === 1
      ? formatDisconnectedComponents(design, resolvedIndices)
      : `${resolvedIndices.length} disconnected components`;
    const detail = [formatDisconnectedComponentDetails(design, resolvedIndices), ...otherErrors]
      .filter(Boolean)
      .join(" ");
    return { message, detail: detail || message };
  }

  const message = resolvedErrors[0] || "Cannot save invalid blueprint.";
  return { message, detail: resolvedErrors.join(" ") || message };
}

function noticeShell(notice) {
  return notice?.parentElement || notice?.parentNode || null;
}

function intersects(a, b) {
  if (!a || !b) return false;
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

// The notice is absolutely positioned in the designer center shell. Prefer the
// gap below the utility row, but fall back to the utility row itself when the
// responsive layout leaves no room before the forward marker or grid.
function positionDesignerNotice() {
  const notice = dom.blueprintDesignerNotice;
  const shell = noticeShell(notice);
  const utility = shell?.querySelector?.(".designer-top");
  const marker = shell?.querySelector?.(".forward-marker");
  const grid = dom.gridStage;
  if (!notice || !shell || !utility || !grid || typeof shell.getBoundingClientRect !== "function") return;

  const shellRect = shell.getBoundingClientRect();
  const utilityRect = utility.getBoundingClientRect();
  const markerRect = marker?.getBoundingClientRect?.() || null;
  const gridRect = grid.getBoundingClientRect?.() || null;
  if (!gridRect) return;

  // Anchor the notice to the live workspace/grid edge rather than the shell's
  // right edge, which sits against the inspector at wider desktop sizes. Keep
  // only the live grid/shell clearance so the notice returns to its original
  // horizontal anchor without touching the boundary.
  const gridRightInset = Math.max(8, Math.round(shellRect.right - gridRect.right));
  notice.style.right = `${gridRightInset + NOTICE_GRID_EDGE_INSET_PX}px`;
  const noticeRect = notice.getBoundingClientRect?.() || null;
  if (!noticeRect) return;

  const gapTop = utilityRect.bottom - shellRect.top + 14;
  const gridBottomLimit = gridRect.top - shellRect.top - noticeRect.height - 8;
  let top = Math.min(gapTop, gridBottomLimit);
  const candidateRect = {
    left: noticeRect.left,
    right: noticeRect.right,
    top: shellRect.top + top,
    bottom: shellRect.top + top + noticeRect.height
  };

  if (intersects(candidateRect, markerRect)) {
    const belowMarker = markerRect.bottom - shellRect.top + 4;
    top = belowMarker + noticeRect.height <= gridBottomLimit
      ? belowMarker
      : utilityRect.top - shellRect.top + 8;
  }

  notice.style.top = `${Math.max(0, Math.round(top))}px`;
}

function renderNotice(message, detail, signature) {
  const notice = dom.blueprintDesignerNotice;
  if (!notice) return false;

  clearNoticeTimers();
  notice.textContent = "";

  const icon = document.createElement("span");
  icon.className = "blueprint-designer-notice-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = "";

  const copy = document.createElement("span");
  copy.className = "blueprint-designer-notice-copy";
  copy.textContent = message;

  notice.appendChild(icon);
  notice.appendChild(copy);
  notice.hidden = false;
  notice.className = "blueprint-designer-notice is-error is-visible";
  notice.dataset.noticeKey = signature;
  notice.dataset.noticeSequence = String(++noticeSequence);
  notice.setAttribute("aria-label", `Blueprint validation: ${detail}`);
  notice.title = detail;
  positionDesignerNotice();

  dismissTimer = setTimeout(() => {
    notice.classList.remove("is-visible");
    removeTimer = setTimeout(() => {
      if (notice.dataset.noticeKey !== signature) return;
      notice.hidden = true;
      notice.textContent = "";
      notice.removeAttribute("aria-label");
      notice.removeAttribute("title");
    }, NOTICE_FADE_OUT_MS);
  }, DESIGNER_NOTICE_DURATION_MS);
  return true;
}

export function showDesignerValidationNotice({ message, detail = message, key = null } = {}) {
  if (!message) return false;
  const notice = dom.blueprintDesignerNotice;
  if (!notice) return false;
  const cleanMessage = String(message).trim();
  const cleanDetail = String(detail || cleanMessage).trim();
  if (!cleanMessage) return false;
  const signature = String(key || noticeSignature(cleanMessage, cleanDetail));
  const currentTime = now();
  const sameNoticeIsVisible = !notice.hidden && notice.dataset.noticeKey === signature;
  if (
    signature === lastShownSignature &&
    (sameNoticeIsVisible || currentTime - lastShownAt < SAME_NOTICE_GUARD_MS)
  ) return false;

  lastShownSignature = signature;
  lastShownAt = currentTime;
  return renderNotice(cleanMessage, cleanDetail, signature);
}

export function showDesignerValidationNoticeForValidation(options = {}) {
  return showDesignerValidationNotice(validationNoticeCopy(options));
}

export function resetDesignerNoticeForTests() {
  clearNoticeTimers();
  lastShownSignature = null;
  lastShownAt = 0;
  noticeSequence = 0;
  const notice = dom.blueprintDesignerNotice;
  if (!notice) return;
  notice.hidden = true;
  notice.textContent = "";
  notice.className = "blueprint-designer-notice";
  notice.removeAttribute("aria-label");
  notice.removeAttribute("title");
}

if (typeof window !== "undefined") {
  window.addEventListener?.("resize", positionDesignerNotice);
}
