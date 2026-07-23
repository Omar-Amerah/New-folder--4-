// Manages purchase choices, buy commands, limits, quantity scales, and floating statistics tooltips.

import { dom } from "./dom.js";
import { state } from "../state.js";
import { showToast } from "./toastUi.js";
import { send } from "../network.js";
import { computeStats } from "../design/componentStats.js";
import { validateBlueprint, isConnected } from "../design/blueprintValidation.js";
import { normalizeDesign, normalizeWiring, persistLoadouts } from "../design/blueprintStorage.js";
import { escapeHtml } from "../shared/formatting.js";
import { clamp } from "../shared/math.js";
import { makePurchaseRequestId, makeDesignId } from "../shared/ids.js";
import { formatHull, formatShield, formatSpeed, formatMass, formatEnergy, formatRepair, formatPercent } from "../design/statFormatting.js";
import { weaponAbbrevText, previewColor } from "./savedBlueprintsUi.js";
import { shipThumbnailDataUrl } from "./shipThumbnail.js";
import { isAdmin } from "./lobbyUi.js";

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
  if (!purchase.canBuy) {
    setPurchaseError(optionId, purchase.reason);
    return;
  }

  const requestId = makePurchaseRequestId();
  const timeoutId = setTimeout(() => {
    state.pendingPurchases.delete(requestId);
    renderPurchaseBar();
    showToast("Request timeout", "warning");
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
    combatStyle: option.combatStyle || state.combatStyle || "charge",
    count: state.purchaseQuantity,
    requestId
  });

  renderPurchaseBar();
  hidePurchaseTooltip();
  const card = dom.purchaseOptions?.querySelector?.(`[data-option-id="${escapeHtml(optionId)}"]`);
  setPurchaseCardFeedback(card, "pending", "Building...");
}


export function isMoneyPurchaseBlocker(reason = "") {
  return /need \$|not enough money|cannot afford/i.test(String(reason));
}

export function setPurchaseQuantity(quantity) {
  state.purchaseQuantity = quantity === 5 ? 5 : 1;
  renderPurchaseBar();
}

export function clearPendingPurchase(requestId) {
  const pending = state.pendingPurchases.get(requestId);
  if (!pending) return null;
  clearTimeout(pending.timeoutId);
  state.pendingPurchases.delete(requestId);
  renderPurchaseBar();
  return pending;
}

export function reconcilePendingPurchasesWithSnapshot() {
  if (!state.pendingPurchases.size) return;
  const mine = state.mine;
  if (!mine) return;
  const money = currentMatchMoney(mine);
  const activeShips = mine.activeShips ?? 0;
  for (const [requestId, pending] of [...state.pendingPurchases]) {
    const age = performance.now() - pending.startedAt;
    const shipCountChanged = activeShips >= pending.activeShipsBefore + 1;
    const moneySpent = money <= pending.moneyBefore - Math.max(1, Math.floor((pending.totalCost || 0) * 0.5));
    if (age > 120 && (shipCountChanged || moneySpent)) {
      clearPendingPurchase(requestId);
      showToast(`Built ${pending.count} ship${pending.count === 1 ? "" : "s"}`, "good");
    }
  }
}

export function setPurchaseError(optionId, message) {
  if (isMoneyPurchaseBlocker(message)) return;
  const previous = state.purchaseErrors.get(optionId);
  if (previous?.timeoutId) clearTimeout(previous.timeoutId);
  const timeoutId = setTimeout(() => {
    state.purchaseErrors.delete(optionId);
    renderPurchaseBar();
  }, 1600);
  state.purchaseErrors.set(optionId, { message, timeoutId });
  renderPurchaseBar();
}

export function updateEconomyUi() {
  const mine = state.mine;
  const localStats = computeStats(state.design, { wiring: state.wiring });
  const localStatus = getShipStatus(localStats);
  const money = currentMatchMoney(mine);
  const income = mine?.income ?? 0;
  const myTeam = mine?.team;
  const relays = state.snapshot?.points?.filter((point) => point.ownerTeam === myTeam && point.progress > 0.98).length || 0;
  const unitCost = localStats.unitCost;
  const canAfford = money >= unitCost;
  const canReady = state.phase === "design" && !mine?.ready && localStatus.blockers.length === 0;
  const canSaveActiveDesign = state.phase === "active" && Boolean(mine?.ready);

  if (dom.incomeHud) {
    dom.incomeHud.textContent = `+$${Math.round(income)}/s`;
    dom.incomeHud.title = mine?.ready
      ? `Base income plus ${relays} captured relay${relays === 1 ? "" : "s"}. Money rises every second.`
      : "Ready with an affordable starting design to begin earning money.";
  }
  dom.deployButton.hidden = state.phase !== "design";
  dom.deployButton.disabled = !canReady;

  if (dom.openBlueprintDesignerButton) {
    if (state.phase === "design" && !mine?.ready) {
      dom.openBlueprintDesignerButton.textContent = "Blueprint Designer";
      dom.openBlueprintDesignerButton.style.border = "2px solid var(--amber)";
    } else {
      dom.openBlueprintDesignerButton.textContent = "Blueprint Designer";
      dom.openBlueprintDesignerButton.style.border = "";
    }
  }
  dom.deployButton.textContent = mine?.ready && state.phase === "design"
    ? "Ready"
    : `Ready with current design ($${unitCost})`;

  if (mine) {
    const status = state.phase === "design"
      ? mine.ready ? "Ready. Waiting for the rest of the room." : "Design your starting ship, then ready with this design."
      : mine.ready
        ? economyStatusText({ income, relays, canAfford, unitCost, money })
        : "Waiting for ship design";
    if (dom.buildStatus && !dom.buildStatus.className.includes("warning")) {
      dom.buildStatus.textContent = status;
      dom.buildStatus.className = "build-status good";
    }
  }
  renderPurchaseBar();
}

function readyBlockerButtonText(reason) {
  if (/Need \$(\d+)/.test(reason)) return `Cannot Ready - Need $${reason.match(/Need \$(\d+)/)[1]}`;
  if (reason.includes("missing core")) return "Cannot Ready - Missing Core";
  if (reason.includes("disconnected")) return "Cannot Ready - Disconnected";
  if (reason.includes("blueprint is empty")) return "Cannot Ready - Empty Design";
  return "Cannot Ready";
}

function economyStatusText({ income, relays, canAfford, unitCost, money }) {
  if (!canAfford) return `Current editor design needs $${Math.ceil(unitCost - money)} more. Buy affordable ships from the bottom bar.`;
  return `Buy ships from the bottom bar. Earning +$${Math.round(income)}/s: base income${relays ? ` + ${relays} relay bonus` : ""}`;
}

export function getPurchaseOptions() {
  const current = {
    id: "current",
    name: "Current Design",
    source: "editor",
    blueprint: state.design.map((part) => ({ ...part })),
    wiring: normalizeWiring(state.wiring, state.design),
    combatStyle: state.combatStyle || "charge",
    stats: computeStats(state.design, { wiring: normalizeWiring(state.wiring, state.design) })
  };

  // The active loadout tab decides which saved designs are buyable. The implicit
  // "All" tab shows every saved design; a custom loadout shows only its members.
  const active = getActiveLoadout();
  let designs;
  if (!active || active.id === "all") {
    designs = state.savedDesigns;
  } else {
    const byId = new Map(state.savedDesigns.map((saved) => [saved.id, saved]));
    designs = active.designIds.map((id) => byId.get(id)).filter(Boolean);
  }

  return [
    current,
    ...designs.map((saved) => {
      const modules = normalizeDesign(saved.blueprint);
      return {
        id: saved.id,
        name: saved.name,
        source: "saved",
        blueprint: modules.map((part) => ({ ...part })),
        wiring: normalizeWiring(saved.wiring, modules),
        combatStyle: saved.combatStyle || "charge",
        stats: computeStats(modules, { wiring: normalizeWiring(saved.wiring, modules) })
      };
    })
  ];
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
  renderLoadouts();
}

export function addLoadout() {
  if (!state.loadouts) state.loadouts = [];
  if (state.loadouts.length >= 8) {
    showToast("Loadout limit reached (8).", "warning");
    return;
  }
  const loadout = { id: makeDesignId(), name: `Loadout ${state.loadouts.length + 1}`, designIds: [] };
  state.loadouts.push(loadout);
  persistLoadouts(state.loadouts);
  state.activeLoadoutId = loadout.id;
  state.loadoutEditMode = true; // jump straight to picking ships
  renderLoadouts();
}

export function deleteLoadout(id) {
  state.loadouts = (state.loadouts || []).filter((lo) => lo.id !== id);
  persistLoadouts(state.loadouts);
  if (state.activeLoadoutId === id) state.activeLoadoutId = "all";
  state.loadoutEditMode = false;
  renderLoadouts();
}

export function renameLoadout(id, name) {
  const clean = String(name || "").trim().slice(0, 20);
  if (!clean) return;
  state.loadouts = (state.loadouts || []).map((lo) => (lo.id === id ? { ...lo, name: clean } : lo));
  persistLoadouts(state.loadouts);
  renderLoadouts();
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
  renderLoadouts();
}

export function toggleLoadoutEditMode() {
  state.loadoutEditMode = !state.loadoutEditMode;
  renderLoadouts();
}

export function getPurchaseOptionState(option, quantity = state.purchaseQuantity) {
  const mine = state.mine;
  const money = currentMatchMoney(mine);
  const activeShips = mine?.activeShips ?? 0;
  const shipCap = mine?.shipCap ?? state.rules.shipCap ?? 20;
  const remainingSlots = Math.max(0, shipCap - activeShips);
  const totalCost = option.stats.unitCost * quantity;
  const validity = validateBlueprintForPurchase(option.blueprint, option);
  const pending = getPendingPurchaseForOption(option.id);
  const error = state.purchaseErrors.get(option.id);
  let reason = "";

  if (pending) reason = "Building...";
  else if (error) reason = error.message || "Purchase failed";
  else if (state.phase !== "active") reason = "Match not active";
  else if (!mine?.ready) reason = "Complete your starting ship first";
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

export function validateBlueprintForPurchase(blueprint, option = null) {
  if (option?.source === "editor" && state.designNeedsAttention) return { ok: false, reason: "Invalid design: review and save the repaired blueprint before deployment." };
  const validation = validateBlueprint(blueprint, {
    requireThrust: true,
    stats: Array.isArray(blueprint) ? (option?.stats || computeStats(blueprint, { wiring: option?.wiring })) : null
  });
  return { ok: validation.ok, reason: validation.errors[0] || "" };
}

export function renderPurchaseBar() {
  if (!dom.purchaseBar || !dom.purchaseOptions) return;
  dom.purchaseQuantityOne?.classList?.toggle("active", state.purchaseQuantity === 1);
  dom.purchaseQuantityFive?.classList?.toggle("active", state.purchaseQuantity === 5);
  dom.purchaseQuantityOne?.setAttribute?.("aria-pressed", String(state.purchaseQuantity === 1));
  dom.purchaseQuantityFive?.setAttribute?.("aria-pressed", String(state.purchaseQuantity === 5));

  // The purchase bar only lets you *pick* a saved loadout; creating/editing them
  // lives in the Blueprint screen's loadout manager.
  renderLoadoutTabs(dom.loadoutTabs, false);

  const options = getPurchaseOptions();
  const color = previewColor();
  const modeChanged = dom.purchaseOptions.dataset.mode !== "buy";
  const existingCards = modeChanged ? [] : Array.from(dom.purchaseOptions.children);
  if (modeChanged) {
    dom.purchaseOptions.textContent = "";
    dom.purchaseOptions.dataset.mode = "buy";
  }

  const optionsMatch = existingCards.length === options.length &&
    options.every((opt, i) => existingCards[i].dataset?.optionId === opt.id);

  if (!optionsMatch) {
    dom.purchaseOptions.textContent = "";
    existingCards.length = 0;
  }

  options.forEach((option, i) => {
    const optionState = getPurchaseOptionState(option, state.purchaseQuantity);
    let card = existingCards[i];
    const isNew = !card;

    if (isNew) {
      card = document.createElement("button");
      card.type = "button";
      if (card.dataset) card.dataset.optionId = option.id;
      // Build the persistent sub-structure once. Subsequent renders update only
      // the text/thumbnail that changed, so hover/focus/press state and the
      // thumbnail <img> element survive the per-snapshot re-render.
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

    const className = `purchase-option ${optionState.pending ? "pending" : optionState.error ? "error" : optionState.canBuy ? "ready" : "disabled"}`;
    if (card.className !== className) card.className = className;
    const ariaDisabled = String(!optionState.canBuy);
    if (card.getAttribute?.("aria-disabled") !== ariaDisabled) card.setAttribute?.("aria-disabled", ariaDisabled);
    const descriptionId = `purchase-status-${option.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
    if (card.getAttribute?.("aria-describedby") !== descriptionId) card.setAttribute?.("aria-describedby", descriptionId);

    // Regenerate the (canvas-rendered) thumbnail only when the blueprint or team
    // colour changes, not every snapshot.
    const thumbSig = `${color}|${option.blueprint.length}|${JSON.stringify(option.blueprint)}`;
    const thumbSpan = card.querySelector(".purchase-thumb");
    if (thumbSpan && thumbSpan.dataset.sig !== thumbSig) {
      thumbSpan.dataset.sig = thumbSig;
      const thumb = shipThumbnailDataUrl(option.blueprint, color, 96);
      thumbSpan.innerHTML = thumb ? `<img src="${thumb}" alt="" draggable="false">` : "";
    }

    setCardText(card, "strong", option.name);
    setCardText(card, ".purchase-cost", purchaseCostText(option, optionState));
    setCardText(card, ".purchase-weapons", weaponSummaryText(option.stats));
    const statusText = purchaseStatusText(optionState);
    setCardText(card, ".purchase-status", statusText);
    const statusDescription = card.querySelector(".purchase-status-description");
    if (statusDescription) statusDescription.id = descriptionId;
    setCardText(card, ".purchase-status-description", statusText);
    if (card.title !== statusText) card.title = statusText;

    if (isNew) dom.purchaseOptions.appendChild(card);
  });
}

export function purchaseStatusText(optionState) {
  if (optionState.pending) return "Building…";
  if (optionState.error) return `Purchase failed — ${optionState.reason || "Server rejected request"}`;
  if (optionState.canBuy) return "Available to build";
  const reason = optionState.reason || "Not available";
  if (/^Need \$/.test(reason)) return reason;
  if (/^Need \d+/.test(reason) && !/fleet slots$/.test(reason)) return reason.replace(/slots$/, "fleet slots");
  if (/^Invalid design:/i.test(reason)) return `Design invalid — ${reason.replace(/^Invalid design:\s*/i, "")}`;
  if (/^Missing /i.test(reason)) return `Design invalid — ${reason}`;
  if (/^Purchase failed/i.test(reason)) return reason.replace(/^Purchase failed:?\s*/i, "Purchase failed — ");
  return reason;
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
function renderLoadoutTabs(strip = dom.loadoutTabs, manage = false) {
  if (!strip) return;
  const active = getActiveLoadout();

  // These strips re-render on every snapshot. Only rebuild (which recreates the
  // buttons + their click listeners) when something actually changed, so a click
  // between two redraws can't target a button that gets replaced before it fires
  // — and an in-progress rename input isn't destroyed mid-edit.
  const signature = JSON.stringify({
    tabs: loadoutTabs().map((tab) => [tab.id, tab.name]),
    active: state.activeLoadoutId,
    edit: state.loadoutEditMode,
    manage
  });
  if (strip.dataset.sig === signature) return;
  strip.dataset.sig = signature;
  strip.textContent = "";

  for (const tab of loadoutTabs()) {
    const isActive = tab.id === state.activeLoadoutId;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `loadout-tab${isActive ? " active" : ""}`;
    btn.textContent = tab.name;
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-selected", String(isActive));
    btn.addEventListener("click", () => setActiveLoadout(tab.id));
    if (manage && tab.id !== "all") {
      btn.title = "Double-click to rename";
      btn.addEventListener("dblclick", (event) => { event.preventDefault(); beginRenameLoadout(btn, tab); });
    }
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

  // Manage controls for a custom loadout.
  if (active.id !== "all") {
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = `loadout-tab loadout-tab-manage${state.loadoutEditMode ? " active" : ""}`;
    edit.textContent = state.loadoutEditMode ? "✓ Done" : "✎ Edit";
    edit.title = "Choose which ships are in this loadout";
    edit.addEventListener("click", toggleLoadoutEditMode);
    strip.appendChild(edit);

    const del = document.createElement("button");
    del.type = "button";
    del.className = "loadout-tab loadout-tab-del";
    del.textContent = "🗑";
    del.title = "Delete this loadout";
    del.setAttribute("aria-label", "Delete loadout");
    del.addEventListener("click", () => deleteLoadout(active.id));
    strip.appendChild(del);
  }
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

// Re-render both the purchase-bar tabs and the Blueprint-screen loadout maker.
function renderLoadouts() {
  renderPurchaseBar();
  renderLoadoutManager();
}

function beginRenameLoadout(btn, tab) {
  const input = document.createElement("input");
  input.className = "loadout-tab-rename";
  input.value = tab.name;
  input.maxLength = 20;
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
  const displayStyle = (option.combatStyle || "charge").charAt(0).toUpperCase() + (option.combatStyle || "charge").slice(1);
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

function getShipStatus(stats) {
  const mine = state.mine;
  const blockers = [];
  const money = currentMatchMoney(mine);
  const isActiveBuild = state.phase === "active";
  const hasCore = state.design.filter((part) => part.type === "core").length === 1;

  if (state.designNeedsAttention) blockers.push("Invalid design: review and save the repaired blueprint before deployment.");
  if (!state.design.length) blockers.push("Invalid design: blueprint is empty.");
  if (!hasCore) blockers.push("Invalid design: missing core.");
  if (!isConnected(state.design)) blockers.push("Invalid design: disconnected parts.");
  if (stats.thrust <= 0) blockers.push("Invalid design: add at least one engine.");
  if (money < stats.unitCost) blockers.push(`${isActiveBuild ? "Cannot afford ship" : "Cannot ready design"}. Need $${Math.ceil(stats.unitCost - money)} more.`);

  const warnings = [...stats.warnings];
  if (money > 0 && stats.unitCost > money * 0.75) warnings.push("High cost for current money.");
  if (stats.maxShield < 35 && stats.maxHp < 210) warnings.push("Weak defence: low combined hull and shield.");

  return { blockers, warnings };
}
