// Manages purchase choices, buy commands, limits, quantity scales, and floating statistics tooltips.

import { dom } from "./dom.js";
import { state } from "../state.js";
import { notify } from "./toastUi.js";
import { send } from "../network.js";
import { persistLoadouts } from "../design/blueprintStorage.js";
import { escapeHtml } from "../shared/formatting.js";
import { clamp } from "../shared/math.js";
import { makePurchaseRequestId, makeDesignId } from "../shared/ids.js";
import { isBalanceIncompatible, balanceBlockMessage, getBalanceStatus } from "../balanceStatus.js";
import { formatHull, formatShield, formatSpeed, formatMass, formatEnergy, formatRepair, formatPercent } from "../design/statFormatting.js";
import { weaponAbbrevText, previewColor } from "./savedBlueprintsUi.js";
import { shipThumbnailDataUrl } from "./shipThumbnail.js";
import { isAdmin } from "./lobbyUi.js";
import { analyseBlueprintOnce, analyseSavedBlueprintOnce, counters, resetBlueprintAnalysisCounters } from "../design/blueprintAnalysisCache.js";
import { invalidatePresentation } from "../presentationInvalidation.js";

export function handlePurchasePointerDown(event) {
  if (event.button !== undefined && event.button !== 0) return;
  const card = event.target?.closest?.("[data-option-id]");
  if (!card || !dom.purchaseOptions?.contains(card)) return;
  event.preventDefault();
  clearPressedPurchaseCards();
  card.classList.add("pressed");
  state.purchasePointer = {
    optionId: card.dataset.optionId || "",
    pointerId: event.pointerId,
    x: event.clientX,
    y: event.clientY
  };
  try {
    dom.purchaseOptions.setPointerCapture?.(event.pointerId);
  } catch {
    // Best effort
  }
}

export function handlePurchaseWheel(event) {
  const options = dom.purchaseOptions;
  if (!options) return;
  // The bar owns the wheel while the pointer is over it, so the arena never zooms at the same time.
  event.preventDefault();
  event.stopPropagation();
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? options.clientWidth : 1;
  const delta = (Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY) * unit;
  if (!Number.isFinite(delta) || delta === 0) return;
  options.scrollLeft += delta;
}

export function handlePurchasePointerUp(event) {
  const pointer = state.purchasePointer;
  if (!pointer || pointer.pointerId !== event.pointerId) return;
  clearPurchasePointer();
  try {
    dom.purchaseOptions.releasePointerCapture?.(event.pointerId);
  } catch {
    // Best effort
  }
  const moved = Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y);
  const bounds = dom.purchaseOptions.getBoundingClientRect();
  const releasedInside = event.clientX >= bounds.left
    && event.clientX <= bounds.right
    && event.clientY >= bounds.top
    && event.clientY <= bounds.bottom;
  if (moved > 12 || !releasedInside) return;
  event.preventDefault();
  buyPurchaseOption(pointer.optionId);
}

export function clearPurchasePointer() {
  clearPressedPurchaseCards();
  state.purchasePointer = null;
}

export function clearPressedPurchaseCards() {
  dom.purchaseOptions?.querySelectorAll?.("[data-option-id].pressed")?.forEach((card) => {
    card.classList.remove("pressed");
  });
}

export function setPurchaseCardFeedback(card, className, text) {
  if (!card) return;
  card.className = `purchase-option ${className}`.trim();
  const label = card.querySelector("em");
  if (label) label.textContent = text;
}

export function handlePurchaseKeyboardClick(event) {
  if (event.detail !== 0) return;
  const card = event.target?.closest?.("[data-option-id]");
  if (!card || !dom.purchaseOptions?.contains(card)) return;
  event.preventDefault();
  buyPurchaseOption(card.dataset.optionId || "");
}

export function buyPurchaseOption(optionId) {
  const option = getPurchaseOptions().find((candidate) => candidate.id === optionId);
  if (!option) return;
  const purchase = getPurchaseOptionState(option, state.purchaseQuantity);
  if (state.phase !== "active") {
    setPurchaseError(optionId, "Match not active");
    return;
  }
  const mine = state.mine;
  if (!mine?.ready) {
    setPurchaseError(optionId, "Not ready");
    return;
  }
  // Never buy while the client and server disagree on gameplay balance.
  if (isBalanceIncompatible()) {
    setPurchaseError(optionId, "Balance out of date — refresh");
    notify.error(balanceBlockMessage(), { key: "balance-mismatch", keyTtl: 15000 });
    return;
  }
  if (!purchase.canBuy) {
    setPurchaseError(optionId, purchase.reason);
    return;
  }

  const requestId = makePurchaseRequestId();
  const timeoutId = setTimeout(() => {
    const pending = state.pendingPurchases.get(requestId);
    if (!pending || pending.settled) return;
    pending.timedOut = true;
    pending.timeoutId = setTimeout(() => {
      if (!pending.settled) {
        state.pendingPurchases.delete(requestId);
        invalidatePresentation("purchase-pending");
      }
    }, 10000);
    notify.warning("Request timeout");
    invalidatePresentation("purchase-pending");
  }, 4500);

  state.pendingPurchases.set(requestId, {
    optionId,
    requestId,
    timeoutId,
    count: state.purchaseQuantity,
    totalCost: purchase.totalCost,
    activeShipsBefore: mine.activeShips ?? 0,
    moneyBefore: purchase.money,
    startedAt: performance.now()
  });

  send({
    type: "buyShip",
    design: option.blueprint,
    wiring: option.wiring,
    combatStyle: option.combatStyle || state.combatStyle || "hold",
    count: state.purchaseQuantity,
    requestId
  });

  invalidatePresentation("purchase-pending");
  hidePurchaseTooltip();
  const card = dom.purchaseOptions?.querySelector?.(`[data-option-id="${escapeHtml(optionId)}"]`);
  setPurchaseCardFeedback(card, "pending", "Building...");
}


export function isMoneyPurchaseBlocker(reason = "") {
  return /need \$|not enough money|cannot afford/i.test(String(reason));
}

export function setPurchaseQuantity(quantity) {
  state.purchaseQuantity = quantity === 5 ? 5 : 1;
  invalidatePresentation("purchase-quantity");
}

export function clearPendingPurchase(requestId) {
  const pending = state.pendingPurchases.get(requestId);
  if (!pending) return null;
  clearTimeout(pending.timeoutId);
  state.pendingPurchases.delete(requestId);
  invalidatePresentation("purchase-pending");
  return pending;
}

export function reconcilePendingPurchasesWithSnapshot() {
  if (!state.pendingPurchases.size) return;
  const mine = state.mine;
  if (!mine) return;
  const money = currentMatchMoney(mine);
  const activeShips = mine.activeShips ?? 0;
  for (const [requestId, pending] of [...state.pendingPurchases]) {
    if (pending.settled) continue;
    const age = performance.now() - pending.startedAt;
    const shipCountChanged = activeShips >= pending.activeShipsBefore + 1;
    const moneySpent = money <= pending.moneyBefore - Math.max(1, Math.floor((pending.totalCost || 0) * 0.5));
    if (age > 120 && (shipCountChanged || moneySpent)) {
      pending.settled = true;
      clearPendingPurchase(requestId);
    }
  }
}

export function handlePurchaseResult(message) {
  const requestId = message.requestId;
  const pending = requestId ? state.pendingPurchases.get(requestId) : null;
  if (pending) {
    pending.settled = true;
    clearTimeout(pending.timeoutId);
    state.pendingPurchases.delete(requestId);
  }
  if (!message.ok) {
    const reason = message.message || "Purchase failed";
    if (pending?.optionId) setPurchaseError(pending.optionId, reason);
    notify.error(reason);
  }
  // A successful purchase raises no toast. In station mode the hangar's build
  // bar on the station itself is the feedback, and a notification per hull was
  // unwanted noise when queueing several at once. Failures still speak up.
  invalidatePresentation("purchase-pending");
}

export function setPurchaseError(optionId, message) {
  if (isMoneyPurchaseBlocker(message)) return;
  const previous = state.purchaseErrors.get(optionId);
  if (previous?.timeoutId) clearTimeout(previous.timeoutId);
  const timeoutId = setTimeout(() => {
    state.purchaseErrors.delete(optionId);
    invalidatePresentation("purchase-errors");
  }, 1600);
  state.purchaseErrors.set(optionId, { message, timeoutId });
  invalidatePresentation("purchase-errors");
}

// The designer is a local editor over localStorage blueprints -- it needs no
// match, so it opens from the lobby onward. Waiting in the lobby is exactly when
// a player wants to be building the ship they will ready with.
export const DESIGNER_PHASES = ["lobby", "design", "active"];

export function updateEconomySnapshotUi() {
  updatePurchaseAffordability();
}

export function updateDeploymentControls() {
  const mine = state.mine;
  const openState = typeof WebSocket !== "undefined" ? WebSocket.OPEN : 1;
  const connected = state.socket?.readyState === openState && Boolean(state.room);
  const balanceCompatible = !isBalanceIncompatible();
  const pending = Boolean(state.pendingDeploy);
  const inDesign = state.phase === "design";
  const ready = Boolean(mine?.ready);
  const canReady = connected && inDesign && !ready && !pending;
  if (dom.deployButton) {
    dom.deployButton.hidden = !inDesign;
    dom.deployButton.disabled = !canReady;
    dom.deployButton.classList.toggle("is-loading", pending);
    const text = pending ? "Readying…" : ready ? "Waiting for Players" : "Ready Up";
    const label = dom.deployButton.querySelector?.(".deploy-action-label");
    if (label) label.textContent = text;
    dom.deployButton.setAttribute?.("aria-label", text);
    dom.deployButton.title = "";
  }
  if (dom.openBlueprintDesignerButton) {
    dom.openBlueprintDesignerButton.textContent = "Open Blueprint Designer";
    dom.openBlueprintDesignerButton.disabled = !connected
      || !DESIGNER_PHASES.includes(state.phase)
      || !balanceCompatible;
    dom.openBlueprintDesignerButton.title = balanceCompatible ? "" : balanceBlockMessage();
  }
  const diagnostics = state.presentationDiagnostics;
  if (diagnostics) diagnostics.deploymentControlsUpdateCount = (diagnostics.deploymentControlsUpdateCount || 0) + 1;
}

export function updateEconomyUi({ refreshCatalogue = true } = {}) {
  const mine = state.mine;
  const income = mine?.income ?? 0;
  const myTeam = mine?.team;
  const relays = state.snapshot?.points?.filter((point) => point.ownerTeam === myTeam && point.progress > 0.98).length || 0;

  if (dom.incomeHud) {
    dom.incomeHud.textContent = `+$${Math.round(income)}/s`;
    dom.incomeHud.title = mine?.ready
      ? `Base income plus ${relays} captured relay${relays === 1 ? "" : "s"}. Money rises every second.`
      : "Ready up to begin earning money.";
  }
  updateDeploymentControls();

  if (mine) {
    const status = state.phase === "design"
      ? mine.ready ? "Ready. Waiting for the rest of the room." : "Ready up whenever you are ready. Buy a valid ship after the match starts."
      : mine.ready
        ? economyStatusText({ income, relays })
        : "Waiting for ship design";
    if (dom.buildStatus && !dom.buildStatus.className.includes("warning")) {
      dom.buildStatus.textContent = status;
      dom.buildStatus.className = "build-status good";
    }
  }

  if (refreshCatalogue) {
    rebuildPurchaseCatalogue();
  } else {
    updatePurchaseAvailability();
  }
}

function economyStatusText({ income, relays }) {
  return `Buy ships from the bottom bar. Earning +$${Math.round(income)}/s: base income${relays ? ` + ${relays} relay bonus` : ""}`;
}

let purchaseOptions = null;
let purchaseOptionsKey = null;

function visibleSavedDesigns() {
  const active = getActiveLoadout();
  if (!active || active.id === "all") return state.savedDesigns;
  const byId = new Map(state.savedDesigns.map((saved) => [saved.id, saved]));
  return active.designIds.map((id) => byId.get(id)).filter(Boolean);
}

function makePurchaseOptionKey() {
  const visible = visibleSavedDesigns();
  const balanceRevision = getBalanceStatus().serverRevision || getBalanceStatus().clientRevision || null;
  return {
    design: state.design,
    wiring: state.wiring,
    combatStyle: state.combatStyle || "hold",
    activeLoadoutId: state.activeLoadoutId,
    balanceRevision,
    blueprintRevision: state.presentationLocalRevision?.blueprint || 0,
    wiringRevision: state.presentationLocalRevision?.wiring || 0,
    purchaseRevision: state.presentationLocalRevision?.purchase || 0,
    // Capture saved design object references so mutations / replacements are detected.
    savedRefs: visible.map((saved) => [
      saved.id,
      saved.blueprint,
      saved.wiring,
      saved.updatedAt,
      saved.combatStyle || "hold"
    ])
  };
}

function sameOptionKey(a, b) {
  if (!a || !b) return false;
  if (
    a.design !== b.design || a.wiring !== b.wiring || a.combatStyle !== b.combatStyle
    || a.activeLoadoutId !== b.activeLoadoutId || a.balanceRevision !== b.balanceRevision
    || a.blueprintRevision !== b.blueprintRevision || a.wiringRevision !== b.wiringRevision
    || a.purchaseRevision !== b.purchaseRevision
  ) return false;
  if (a.savedRefs.length !== b.savedRefs.length) return false;
  for (let i = 0; i < a.savedRefs.length; i += 1) {
    const ar = a.savedRefs[i];
    const br = b.savedRefs[i];
    for (let j = 0; j < ar.length; j += 1) {
      if (ar[j] !== br[j]) return false;
    }
  }
  return true;
}

function buildPurchaseOptions() {
  const currentAnalysis = analyseBlueprintOnce({
    blueprint: state.design,
    wiring: state.wiring,
    combatStyle: state.combatStyle || "hold"
  });

  const current = {
    id: "current",
    name: "Current Design",
    source: "editor",
    blueprint: currentAnalysis.normalizedBlueprint,
    wiring: currentAnalysis.normalizedWiring,
    combatStyle: currentAnalysis.combatStyle,
    stats: currentAnalysis.stats,
    validation: { ok: currentAnalysis.validation.ok, reason: currentAnalysis.validation.errors[0] || "" },
    weaponSummary: currentAnalysis.weaponSummary,
    thumbnailKey: currentAnalysis.thumbnailKey
  };

  if (state.designNeedsAttention) {
    current.validation = {
      ok: false,
      reason: "Invalid design: review and save the repaired blueprint before deployment."
    };
  }

  return [
    current,
    ...visibleSavedDesigns().map((saved) => {
      const analysis = analyseSavedBlueprintOnce(saved);
      return {
        id: saved.id,
        name: saved.name,
        source: "saved",
        blueprint: analysis.normalizedBlueprint,
        wiring: analysis.normalizedWiring,
        combatStyle: saved.combatStyle || "hold",
        stats: analysis.stats,
        validation: { ok: analysis.validation.ok, reason: analysis.validation.errors[0] || "" },
        weaponSummary: analysis.weaponSummary,
        thumbnailKey: analysis.thumbnailKey
      };
    })
  ];
}

export function rebuildPurchaseCatalogue() {
  counters.catalogueRebuild++;
  const diagnostics = state.presentationDiagnostics;
  if (diagnostics) diagnostics.purchaseCatalogueBuildCount += 1;
  const startMark = typeof performance !== "undefined" ? `bp-catalogue-rebuild-${Date.now()}` : null;
  if (startMark && typeof performance.mark === "function") performance.mark(startMark);

  purchaseOptions = buildPurchaseOptions();
  purchaseOptionsKey = makePurchaseOptionKey();

  if (typeof document !== "undefined") {
    renderPurchaseCards(purchaseOptions);
    patchPurchaseAvailability();
  }

  if (startMark && typeof performance.measure === "function") {
    try { performance.measure("blueprint-catalogue-rebuild", startMark); } catch {}
  }
}

function ensurePurchaseCatalogue() {
  if (!purchaseOptions || !sameOptionKey(purchaseOptionsKey, makePurchaseOptionKey())) {
    rebuildPurchaseCatalogue();
  }
}

export function getPurchaseOptions() {
  ensurePurchaseCatalogue();
  return purchaseOptions;
}

// ---- Loadout tabs -------------------------------------------------------------

const ALL_LOADOUT = { id: "all", name: "All" };

export function loadoutTabs() {
  return [ALL_LOADOUT, ...(state.loadouts || [])];
}

export function getActiveLoadout() {
  if (state.activeLoadoutId === "all") return ALL_LOADOUT;
  return (state.loadouts || []).find((lo) => lo.id === state.activeLoadoutId) || ALL_LOADOUT;
}

export function setActiveLoadout(id) {
  state.activeLoadoutId = id;
  state.loadoutEditMode = false;
  persistActiveLoadoutId(id);
  invalidatePresentation("purchase-catalogue");
  renderLoadoutManager();
}

export function addLoadout() {
  if (!state.loadouts) state.loadouts = [];
  if (state.loadouts.length >= 8) {
    notify.warning("Loadout limit reached (8).");
    return;
  }
  const loadout = { id: makeDesignId(), name: `Loadout ${state.loadouts.length + 1}`, designIds: [] };
  state.loadouts.push(loadout);
  persistLoadouts(state.loadouts);
  state.activeLoadoutId = loadout.id;
  state.loadoutEditMode = true;
  state.pendingNewLoadoutName = loadout.id;
  persistActiveLoadoutId(loadout.id);
  invalidatePresentation("purchase-catalogue");
  renderLoadoutManager();
}

export function duplicateLoadout(id) {
  const source = (state.loadouts || []).find((lo) => lo.id === id);
  if (!source) return;
  if (state.loadouts.length >= 8) {
    notify.warning("Loadout limit reached (8).");
    return;
  }
  const copy = { id: makeDesignId(), name: `${source.name} Copy`.slice(0, 20), designIds: [...source.designIds] };
  state.loadouts.push(copy);
  persistLoadouts(state.loadouts);
  state.activeLoadoutId = copy.id;
  state.loadoutEditMode = false;
  persistActiveLoadoutId(copy.id);
  invalidatePresentation("purchase-catalogue");
  renderLoadoutManager();
}

export function deleteLoadout(id) {
  state.loadouts = (state.loadouts || []).filter((lo) => lo.id !== id);
  persistLoadouts(state.loadouts);
  if (state.activeLoadoutId === id) {
    state.activeLoadoutId = "all";
    persistActiveLoadoutId("all");
  }
  state.loadoutEditMode = false;
  invalidatePresentation("purchase-catalogue");
  renderLoadoutManager();
}

export function renameLoadout(id, name) {
  const clean = String(name || "").trim().slice(0, 20);
  if (!clean) return;
  state.loadouts = (state.loadouts || []).map((lo) => (lo.id === id ? { ...lo, name: clean } : lo));
  persistLoadouts(state.loadouts);
  renderPurchaseBar();
  renderLoadoutManager();
}

function persistActiveLoadoutId(id) {
  try {
    localStorage.setItem("modular-fleet-active-loadout-v1", String(id));
  } catch {}
}

export function restoreActiveLoadout() {
  try {
    const saved = localStorage.getItem("modular-fleet-active-loadout-v1");
    if (!saved) return;
    if (saved === "all") { state.activeLoadoutId = "all"; return; }
    const exists = (state.loadouts || []).some((lo) => lo.id === saved);
    state.activeLoadoutId = exists ? saved : "all";
  } catch {}
}

export function toggleDesignInLoadout(designId) {
  const active = getActiveLoadout();
  if (active.id === "all") return;
  const loadout = (state.loadouts || []).find((lo) => lo.id === active.id);
  if (!loadout) return;
  const idx = loadout.designIds.indexOf(designId);
  if (idx >= 0) loadout.designIds.splice(idx, 1);
  else if (loadout.designIds.length < 12) loadout.designIds.push(designId);
  persistLoadouts(state.loadouts);
  invalidatePresentation("purchase-catalogue");
  renderLoadoutManager();
}

export function toggleLoadoutEditMode() {
  state.loadoutEditMode = !state.loadoutEditMode;
  renderLoadoutManager();
}

export function getPurchaseOptionState(option, quantity = state.purchaseQuantity) {
  const mine = state.mine;
  const money = currentMatchMoney(mine);
  const activeShips = mine?.activeShips ?? 0;
  const shipCap = mine?.shipCap ?? state.rules.shipCap ?? 20;
  const remainingSlots = Math.max(0, shipCap - activeShips);
  const totalCost = option.stats.unitCost * quantity;
  const validity = option.validation || { ok: false, reason: "Design unavailable" };
  const pending = getPendingPurchaseForOption(option.id);
  const error = state.purchaseErrors.get(option.id);
  let reason = "";

  if (pending) reason = pending.timedOut ? "Request timeout" : "Building...";
  else if (error) reason = error.message || "Purchase failed";
  else if (state.phase !== "active") reason = "Match not active";
  else if (!mine?.ready) reason = "Ready up before buying ships";
  else if (!validity.ok) reason = validity.reason;
  else if (activeShips + quantity > shipCap) reason = quantity === 1 ? "Fleet full" : `Need ${quantity} fleet slots`;
  else if (money < totalCost) reason = `Need $${Math.ceil(totalCost - money).toLocaleString()} more`;

  return {
    money,
    activeShips,
    shipCap,
    remainingSlots,
    totalCost,
    pending,
    error,
    canBuy: reason === "",
    reason
  };
}

export function getPendingPurchaseForOption(optionId) {
  for (const pending of state.pendingPurchases.values()) {
    if (pending.optionId === optionId) return pending;
  }
  return null;
}

function patchPurchaseAvailability() {
  counters.availabilityUpdate++;
  if (!dom.purchaseBar || !dom.purchaseOptions) return;
  dom.purchaseQuantityOne?.classList?.toggle("active", state.purchaseQuantity === 1);
  dom.purchaseQuantityFive?.classList?.toggle("active", state.purchaseQuantity === 5);
  dom.purchaseQuantityOne?.setAttribute?.("aria-pressed", String(state.purchaseQuantity === 1));
  dom.purchaseQuantityFive?.setAttribute?.("aria-pressed", String(state.purchaseQuantity === 5));

  ensurePurchaseCatalogue();
  const options = purchaseOptions || [];
  const color = previewColor();

  const cards = Array.from(dom.purchaseOptions.children);
  options.forEach((option, i) => {
    const card = cards[i];
    if (!card) return;
    const optionState = getPurchaseOptionState(option, state.purchaseQuantity);
    const className = `purchase-option ${optionState.pending ? "pending" : optionState.error ? "error" : optionState.canBuy ? "ready" : "disabled"}`;
    if (card.className !== className) card.className = className;
    const ariaDisabled = String(!optionState.canBuy);
    if (card.getAttribute?.("aria-disabled") !== ariaDisabled) card.setAttribute?.("aria-disabled", ariaDisabled);
    const descriptionId = `purchase-status-${option.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
    if (card.getAttribute?.("aria-describedby") !== descriptionId) card.setAttribute?.("aria-describedby", descriptionId);

    setCardText(card, "strong", option.name);
    setCardText(card, ".purchase-cost", purchaseCostText(option, optionState));
    setCardText(card, ".purchase-weapons", option.weaponSummary || weaponSummaryText(option.stats));
    const statusText = purchaseStatusText(optionState);
    setCardText(card, ".purchase-status", statusText);
    const statusDescription = card.querySelector(".purchase-status-description");
    if (statusDescription) statusDescription.id = descriptionId;
    setCardText(card, ".purchase-status-description", purchaseStatusDescription(optionState));
    const title = statusText || "Ready to build";
    if (card.title !== title) card.title = title;

    // Thumbnails are static and are only baked when the option is created or the
    // Blueprint/colour changes; availability-only updates do not touch them.
    const thumbSpan = card.querySelector(".purchase-thumb");
    if (thumbSpan && option.thumbnailKey) {
      const thumbCacheKey = `${color}|96|${option.thumbnailKey}`;
      if (thumbSpan.dataset.thumbKey !== thumbCacheKey) {
        thumbSpan.dataset.thumbKey = thumbCacheKey;
        const thumb = shipThumbnailDataUrl(option.blueprint, color, 96);
        thumbSpan.innerHTML = thumb ? `<img src="${thumb}" alt="" draggable="false">` : "";
      }
    }
  });
}

export function updatePurchaseAffordability() {
  const diagnostics = state.presentationDiagnostics;
  if (diagnostics) diagnostics.purchaseAffordabilityUpdateCount += 1;
  patchPurchaseAvailability();
}

export function updatePurchasePendingState() {
  const diagnostics = state.presentationDiagnostics;
  if (diagnostics) diagnostics.purchasePendingUpdateCount += 1;
  patchPurchaseAvailability();
}

export function updatePurchaseErrors() {
  const diagnostics = state.presentationDiagnostics;
  if (diagnostics) diagnostics.purchaseErrorUpdateCount += 1;
  patchPurchaseAvailability();
}

export function updatePurchaseCatalogue() {
  rebuildPurchaseCatalogue();
}

export function updatePurchaseAvailability() {
  updatePurchaseAffordability();
}

function renderPurchaseCards(options) {
  if (!dom.purchaseBar || !dom.purchaseOptions) return;
  const color = previewColor();
  const modeChanged = dom.purchaseOptions.dataset.mode !== "buy";
  const existingCards = modeChanged ? [] : Array.from(dom.purchaseOptions.children);
  if (modeChanged) {
    dom.purchaseOptions.textContent = "";
    dom.purchaseOptions.dataset.mode = "buy";
  }

  const optionsMatch = existingCards.length === options.length &&
    options.every((opt, i) => existingCards[i]?.dataset?.optionId === opt.id);

  if (!optionsMatch) {
    dom.purchaseOptions.textContent = "";
    existingCards.length = 0;
  }

  options.forEach((option, i) => {
    let card = existingCards[i];
    const isNew = !card;

    if (isNew) {
      card = document.createElement("button");
      card.type = "button";
      if (card.dataset) card.dataset.optionId = option.id;
      card.innerHTML = `
        <span class="purchase-thumb"></span>
        <span class="purchase-info">
          <strong></strong>
          <span class="purchase-cost"></span>
          <small class="purchase-weapons"></small>
          <em class="purchase-status"></em>
          <span class="sr-only purchase-status-description"></span>
        </span>`;

      card.addEventListener?.("mouseenter", (event) => showPurchaseTooltip(option.id, event));
      card.addEventListener?.("mousemove", (event) => positionPurchaseTooltip(event));
      card.addEventListener?.("mouseleave", hidePurchaseTooltip);
      card.addEventListener?.("focus", (event) => showPurchaseTooltip(option.id, event));
      card.addEventListener?.("blur", hidePurchaseTooltip);
    }

    const thumbSpan = card.querySelector(".purchase-thumb");
    if (thumbSpan && option.thumbnailKey) {
      const thumbCacheKey = `${color}|96|${option.thumbnailKey}`;
      if (thumbSpan.dataset.thumbKey !== thumbCacheKey) {
        thumbSpan.dataset.thumbKey = thumbCacheKey;
        const thumb = shipThumbnailDataUrl(option.blueprint, color, 96);
        thumbSpan.innerHTML = thumb ? `<img src="${thumb}" alt="" draggable="false">` : "";
      }
    }

    setCardText(card, "strong", option.name);
    setCardText(card, ".purchase-cost", `$${option.stats.unitCost}`);
    setCardText(card, ".purchase-weapons", option.weaponSummary || weaponSummaryText(option.stats));
    const optionState = getPurchaseOptionState(option, state.purchaseQuantity);
    const statusText = purchaseStatusText(optionState);
    setCardText(card, ".purchase-status", statusText);
    const statusDescription = card.querySelector(".purchase-status-description");
    if (statusDescription) statusDescription.id = `purchase-status-${option.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
    setCardText(card, ".purchase-status-description", purchaseStatusDescription(optionState));
    const title = statusText || "Ready to build";
    if (card.title !== title) card.title = title;

    if (isNew) dom.purchaseOptions.appendChild(card);
  });
}

export function renderPurchaseBar() {
  // Loadout membership is catalogue state, not affordability state.
  renderLoadoutTabs(dom.loadoutTabs, false);
  ensurePurchaseCatalogue();
  updatePurchaseAvailability();
}

export function purchaseStatusText(optionState) {
  if (optionState.pending) return "Building…";
  if (optionState.error) return `Purchase failed — ${optionState.reason || "Server rejected request"}`;
  if (optionState.canBuy) return "";
  const reason = optionState.reason || "Not available";
  if (/^Need \$/.test(reason)) return reason;
  if (/^Need \d+/.test(reason) && !/fleet slots$/.test(reason)) return reason.replace(/slots$/, "fleet slots");
  if (/^Invalid design:/i.test(reason)) return compactDesignIssue(reason);
  if (/^Design invalid\s*[—-]/i.test(reason)) return compactDesignIssue(reason);
  if (/^Missing /i.test(reason)) return `⚠ ${capitalizeStatusReason(reason)}`;
  if (/^Purchase failed/i.test(reason)) return reason.replace(/^Purchase failed:?\s*/i, "Purchase failed — ");
  return reason;
}

function purchaseStatusDescription(optionState) {
  return purchaseStatusText(optionState) || "Ready to build";
}

function compactDesignIssue(reason) {
  const clean = String(reason)
    .replace(/^Invalid design:\s*/i, "")
    .replace(/^Design invalid\s*[—-]\s*/i, "")
    .trim();
  return `⚠ ${capitalizeStatusReason(clean)}`;
}

function capitalizeStatusReason(reason) {
  const text = String(reason || "Not available");
  return text ? `${text.charAt(0).toUpperCase()}${text.slice(1)}` : "Not available";
}

// Updates a child element's text only when it changed, avoiding needless DOM work
// and preserving the surrounding interactive state.
function setCardText(card, selector, text) {
  const el = card.querySelector(selector);
  if (el && el.textContent !== text) el.textContent = text;
}

// Renders the loadout tab strip into `strip`. With `manage` (the Blueprint-screen
// loadout maker) it also shows create/rename/edit/delete controls; without it
// (the purchase bar) the tabs only *select* a saved loadout.
function loadoutShipCount(tab) {
  if (tab.id === "all") return state.savedDesigns.length;
  return (tab.designIds || []).filter((id) => state.savedDesigns.some((s) => s.id === id)).length;
}

function renderLoadoutTabs(strip = dom.loadoutTabs, manage = false) {
  if (!strip) return;
  const active = getActiveLoadout();

  const signature = JSON.stringify({
    tabs: loadoutTabs().map((tab) => [tab.id, tab.name, loadoutShipCount(tab)]),
    active: state.activeLoadoutId,
    edit: state.loadoutEditMode,
    manage,
    pendingNew: state.pendingNewLoadoutName || null
  });
  if (strip.dataset.sig === signature) return;
  strip.dataset.sig = signature;
  strip.textContent = "";

  for (const tab of loadoutTabs()) {
    const isActive = tab.id === state.activeLoadoutId;
    const count = loadoutShipCount(tab);

    if (manage && state.pendingNewLoadoutName === tab.id) {
      const input = document.createElement("input");
      input.className = "loadout-tab-rename";
      input.value = tab.name;
      input.maxLength = 20;
      input.setAttribute("role", "tab");
      input.setAttribute("aria-label", "Name new loadout");
      input.addEventListener("blur", () => {
        state.pendingNewLoadoutName = null;
        renameLoadout(tab.id, input.value);
      });
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") input.blur();
        else if (event.key === "Escape") {
          state.pendingNewLoadoutName = null;
          deleteLoadout(tab.id);
        }
        event.stopPropagation();
      });
      strip.appendChild(input);
      input.focus();
      input.select();
      continue;
    }

    const btn = document.createElement("button");
    btn.type = "button";
    const purchaseFilter = !manage && strip === dom.loadoutTabs;
    btn.className = `loadout-tab${isActive ? " active" : ""}${purchaseFilter ? " purchase-filter-tab" : ""}`;
    btn.textContent = `${tab.name} · ${count}`;
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-selected", String(isActive));
    if (purchaseFilter) {
      btn.setAttribute("aria-label", `${tab.name} filter, ${count} saved design${count === 1 ? "" : "s"}`);
      btn.title = `Show ${tab.name.toLowerCase()} ships (${count})`;
    }
    btn.addEventListener("click", () => setActiveLoadout(tab.id));
    strip.appendChild(btn);
  }

  if (!manage) return;

  const add = document.createElement("button");
  add.type = "button";
  add.className = "loadout-tab loadout-tab-add";
  add.textContent = "+";
  add.title = "New loadout";
  add.setAttribute("aria-label", "New loadout");
  add.addEventListener("click", addLoadout);
  strip.appendChild(add);

  if (active.id !== "all" && state.pendingNewLoadoutName !== active.id) {
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = `loadout-tab loadout-tab-manage${state.loadoutEditMode ? " active" : ""}`;
    edit.textContent = state.loadoutEditMode ? "✓ Done" : "✎ Edit Ships";
    edit.title = "Choose which ships are in this loadout";
    edit.addEventListener("click", toggleLoadoutEditMode);
    strip.appendChild(edit);

    const menu = document.createElement("details");
    menu.className = "loadout-tab loadout-tab-menu";
    const summary = document.createElement("summary");
    summary.textContent = "⋯";
    summary.title = "Loadout options";
    summary.setAttribute("aria-label", "Loadout options");
    menu.appendChild(summary);
    const menuList = document.createElement("div");
    menuList.className = "loadout-menu-dropdown";

    const renameBtn = document.createElement("button");
    renameBtn.type = "button";
    renameBtn.textContent = "Rename";
    renameBtn.addEventListener("click", () => { menu.open = false; beginRenameLoadoutInline(active); });
    menuList.appendChild(renameBtn);

    const dupBtn = document.createElement("button");
    dupBtn.type = "button";
    dupBtn.textContent = "Duplicate";
    dupBtn.addEventListener("click", () => { menu.open = false; duplicateLoadout(active.id); });
    menuList.appendChild(dupBtn);

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "danger";
    delBtn.textContent = "Delete";
    delBtn.addEventListener("click", () => { menu.open = false; deleteLoadout(active.id); });
    menuList.appendChild(delBtn);

    menu.appendChild(menuList);
    bindLoadoutMenuDropdown(menu);
    strip.appendChild(menu);
  }
}

function bindLoadoutMenuDropdown(menu) {
  const summary = menu.querySelector("summary");
  const dropdown = menu.querySelector(".loadout-menu-dropdown");
  if (!summary || !dropdown) return;

  const scrollContainer = menu.closest(".designer-inspector-panel, .designer-right-col, .menu-panel");

  const removeListeners = () => {
    document.removeEventListener("pointerdown", closeOnOutside);
    scrollContainer?.removeEventListener("scroll", closeMenu);
  };

  const closeMenu = () => {
    if (!menu.open) return;
    menu.open = false;
    removeListeners();
  };

  const closeOnOutside = (event) => {
    if (!menu.open || menu.contains(event.target)) return;
    menu.open = false;
    removeListeners();
  };

  const positionDropdown = () => {
    if (!menu.open) return;
    const rect = summary.getBoundingClientRect();
    const width = dropdown.offsetWidth || 150;
    let left = rect.right - width + 55;
    let top = rect.bottom + 4;
    if (left < 4) left = 4;
    if (left + width > window.innerWidth - 4) left = window.innerWidth - width - 4;
    dropdown.style.left = `${left}px`;
    dropdown.style.top = `${top}px`;
    document.addEventListener("pointerdown", closeOnOutside);
    scrollContainer?.addEventListener("scroll", closeMenu, { passive: true });
  };

  summary.addEventListener("click", () => {
    if (!menu.open) {
      requestAnimationFrame(() => requestAnimationFrame(positionDropdown));
    }
  });
}

// The loadout maker, rendered inside the Blueprint screen: full management tabs
// plus the add-designs editor for the active custom loadout.
export function renderLoadoutManager() {
  if (!dom.loadoutManagerTabs) return;
  renderLoadoutTabs(dom.loadoutManagerTabs, true);
  const active = getActiveLoadout();
  const editing = state.loadoutEditMode && active.id !== "all";
  if (dom.loadoutManagerEditor) {
    dom.loadoutManagerEditor.hidden = !editing;
    if (editing) renderLoadoutEditor(active, dom.loadoutManagerEditor);
    else dom.loadoutManagerEditor.textContent = "";
  }
}

function beginRenameLoadoutInline(tab) {
  state.pendingNewLoadoutName = null;
  const strip = dom.loadoutManagerTabs || dom.loadoutTabs;
  if (!strip) return;
  const btn = strip.querySelector(`.loadout-tab.active`);
  if (!btn) { renderLoadoutManager(); return; }
  const input = document.createElement("input");
  input.className = "loadout-tab-rename";
  input.value = tab.name;
  input.maxLength = 20;
  input.setAttribute("role", "tab");
  input.setAttribute("aria-label", `Rename ${tab.name}`);
  btn.replaceWith(input);
  input.focus();
  input.select();
  const commit = () => renameLoadout(tab.id, input.value);
  input.addEventListener("blur", commit);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") input.blur();
    else if (event.key === "Escape") renderLoadoutManager();
    event.stopPropagation();
  });
}

function renderLoadoutEditor(loadout, container = dom.loadoutManagerEditor) {
  if (!container) return;
  container.textContent = "";
  const color = previewColor();

  if (state.savedDesigns.length === 0) {
    const empty = document.createElement("div");
    empty.className = "loadout-editor-empty";
    empty.textContent = "Save blueprints first, then add them to this loadout.";
    container.appendChild(empty);
    return;
  }

  for (const saved of state.savedDesigns) {
    const included = loadout.designIds.includes(saved.id);
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = `loadout-chip${included ? " included" : ""}`;
    const thumb = shipThumbnailDataUrl(saved.blueprint, color, 60);
    chip.innerHTML = `
      <span class="loadout-chip-check">${included ? "✓" : "+"}</span>
      <span class="purchase-thumb">${thumb ? `<img src="${thumb}" alt="" draggable="false">` : ""}</span>
      <span class="loadout-chip-name">${escapeHtml(saved.name)}</span>
    `;
    chip.addEventListener("click", () => toggleDesignInLoadout(saved.id));
    container.appendChild(chip);
  }
}

export function purchaseCostText(option, optionState) {
  if (state.purchaseQuantity === 1) return `$${option.stats.unitCost}`;
  return `$${option.stats.unitCost} each | $${optionState.totalCost} total`;
}

export function weaponSummaryText(stats) {
  return `${stats.weaponDps} DPS`;
}

export function showPurchaseTooltip(optionId, event) {
  const option = getPurchaseOptions().find((candidate) => candidate.id === optionId);
  if (!option || !dom.purchaseTooltip) return;
  const optionState = getPurchaseOptionState(option, state.purchaseQuantity);
  const stats = option.stats;
  const displayStyle = (option.combatStyle || "hold").charAt(0).toUpperCase() + (option.combatStyle || "hold").slice(1);
  dom.purchaseTooltip.innerHTML = `
    <div class="purchase-tooltip-head">
      <strong>${escapeHtml(option.name)}</strong>
      <span>${escapeHtml(inferShipRole(stats))}</span>
    </div>
    <div class="purchase-tooltip-status ${optionState.canBuy ? "ready" : "blocked"}">
      <span>${optionState.canBuy ? "Can buy" : "Cannot buy"}</span>
      <strong>${optionState.canBuy ? `$${optionState.totalCost}` : escapeHtml(optionState.reason)}</strong>
    </div>
    <div class="purchase-tooltip-grid">
      ${tooltipStat("Style", displayStyle)}
      ${tooltipStat("Cost", `$${stats.unitCost}`)}
      ${state.purchaseQuantity > 1 ? tooltipStat("Total", `$${optionState.totalCost}`) : ""}
      ${tooltipStat("Hull", formatHull(stats.maxHp))}
      ${tooltipStat("Shield", `${formatShield(stats.maxShield)} (+${stats.shieldRegen}/s)`)}
      ${tooltipStat("Speed", formatSpeed(Math.round(stats.maxSpeed)))}
      ${tooltipStat(Math.abs(Number(stats.turnRateLeft ?? stats.turnRate ?? 0) - Number(stats.turnRateRight ?? stats.turnRate ?? 0)) < 0.01 ? "Turn rate" : "Turn L/R", Math.abs(Number(stats.turnRateLeft ?? stats.turnRate ?? 0) - Number(stats.turnRateRight ?? stats.turnRate ?? 0)) < 0.01 ? `${Number(stats.turnRateLeft ?? stats.turnRate ?? 0).toFixed(2)}` : `${Number(stats.turnRateLeft ?? stats.turnRate ?? 0).toFixed(2)} / ${Number(stats.turnRateRight ?? stats.turnRate ?? 0).toFixed(2)}`)}
      ${tooltipStat("Mass", formatMass(stats.mass))}
      ${tooltipStat("Power Use/Gen", `${stats.powerUse}/${stats.powerGeneration} MW`)}
      ${tooltipStat("Energy", formatEnergy(stats.energyStorage))}
      ${tooltipStat("Repair", formatRepair(stats.repairRate))}
      ${stats.coolingBonus > 0 ? tooltipStat("Cooling", `${formatPercent(stats.coolingBonus)} reload`) : ""}
      ${stats.captureBonus > 0 ? tooltipStat("Capture", `+${formatPercent(stats.captureBonus)}`) : ""}
      ${tooltipStat("Weapons", weaponSummaryText(stats))}
      ${tooltipStat("DPS", stats.weaponDps)}
    </div>
  `;
  dom.purchaseTooltip.hidden = false;
  positionPurchaseTooltip(event);
}

function tooltipStat(label, value) {
  return `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

export function positionPurchaseTooltip(event) {
  if (!dom.purchaseTooltip || dom.purchaseTooltip.hidden) return;
  const margin = 14;
  const rect = dom.purchaseTooltip.getBoundingClientRect();
  const sourceRect = event.currentTarget?.getBoundingClientRect?.();
  const pointerX = event.clientX || sourceRect?.left || window.innerWidth / 2;
  const pointerY = event.clientY || sourceRect?.top || window.innerHeight / 2;
  const left = clamp(pointerX + 14, margin, window.innerWidth - rect.width - margin);
  const top = clamp(pointerY - rect.height - 12, margin, window.innerHeight - rect.height - margin);
  dom.purchaseTooltip.style.left = `${left}px`;
  dom.purchaseTooltip.style.top = `${top}px`;
}

export function hidePurchaseTooltip() {
  if (dom.purchaseTooltip) dom.purchaseTooltip.hidden = true;
}

export function inferShipRole(stats) {
  const weapons = stats.blaster + stats.missile + stats.railgun + (stats.beam || 0);
  if (stats.repair > 0 && stats.weaponDps < 30) return "Support";
  if ((stats.beam || 0) >= Math.max(stats.blaster, stats.missile, stats.railgun) && (stats.beam || 0) > 0) return "Beam Ship";
  if (stats.railgun >= Math.max(stats.blaster, stats.missile) && stats.railgun > 0) return "Rail Platform";
  if (stats.missile >= Math.max(stats.blaster, stats.railgun) && stats.missile > 0) return "Missile Boat";
  if (stats.maxHp + stats.maxShield > 700 && stats.maxSpeed < 190) return "Heavy Tank";
  if (stats.maxSpeed > 250 && stats.unitCost < 420) return "Fast Scout";
  if (weapons > 0) return "Brawler";
  return "Utility";
}

function currentMatchMoney(mine) {
  return mine ? Number(mine.money) || 0 : state.rules.startingMoney;
}
