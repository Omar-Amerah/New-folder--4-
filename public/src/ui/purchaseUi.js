// Manages purchase choices, buy commands, limits, quantity scales, and floating statistics tooltips.

import { dom } from "./dom.js";
import { state } from "../state.js";
import { showToast } from "./toastUi.js";
import { send } from "../network.js";
import { computeStats } from "../design/componentStats.js";
import { isConnected } from "../design/blueprintValidation.js";
import { normalizeDesign } from "../design/blueprintStorage.js";
import { escapeHtml } from "../shared/formatting.js";
import { clamp } from "../shared/math.js";
import { makePurchaseRequestId } from "../shared/ids.js";
import { formatHull, formatShield, formatSpeed, formatMass, formatEnergy, formatRepair, formatPercent } from "../design/statFormatting.js";
import { weaponAbbrevText } from "./savedBlueprintsUi.js";
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

export function setPurchaseOptionFeedback(optionId, className, text) {
  const card = dom.purchaseOptions?.querySelector?.(`[data-option-id="${escapeHtml(optionId)}"]`);
  setPurchaseCardFeedback(card, className, text);
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
    combatStyle: option.combatStyle || state.combatStyle || "charge",
    count: state.purchaseQuantity,
    requestId
  });

  renderPurchaseBar();
  hidePurchaseTooltip();
  const card = dom.purchaseOptions?.querySelector?.(`[data-option-id="${escapeHtml(optionId)}"]`);
  setPurchaseCardFeedback(card, "pending", "Building...");
}

export function isUnaffordablePurchaseOption(optionId) {
  const option = getPurchaseOptions().find((candidate) => candidate.id === optionId);
  if (!option) return false;
  const purchase = getPurchaseOptionState(option, state.purchaseQuantity);
  return !purchase.canBuy && isMoneyPurchaseBlocker(purchase.reason);
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
  const localStats = computeStats(state.design);
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
  dom.deployButton.hidden = state.phase === "active";
  dom.deployButton.disabled = !(canReady || canSaveActiveDesign);
  dom.deployButton.textContent = mine?.ready && state.phase === "design"
    ? "Ready"
    : state.phase === "design"
      ? localStatus.blockers.length ? readyBlockerButtonText(localStatus.blockers[0]) : `Ready with this design - $${unitCost}`
      : state.phase === "active"
        ? saveBlueprintButtonText()
        : saveBlueprintButtonText();

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

function saveBlueprintButtonText() {
  const existing = state.savedDesigns.find((design) => design.id === state.loadedEditorBlueprintId);
  return existing ? `Update "${existing.name}"` : "Save Blueprint";
}

function economyStatusText({ income, relays, canAfford, unitCost, money }) {
  if (!canAfford) return `Current editor design needs $${Math.ceil(unitCost - money)} more. Buy affordable ships from the bottom bar.`;
  return `Buy ships from the bottom bar. Earning +$${Math.round(income)}/s: base income${relays ? ` + ${relays} relay bonus` : ""}`;
}

export function getPurchaseOptions() {
  return [
    {
      id: "current",
      name: "Current Design",
      source: "editor",
      blueprint: state.design.map((part) => ({ ...part })),
      combatStyle: state.combatStyle || "charge",
      stats: computeStats(state.design)
    },
    ...state.savedDesigns.map((saved) => ({
      id: saved.id,
      name: saved.name,
      source: "saved",
      blueprint: normalizeDesign(saved.blueprint).map((part) => ({ ...part })),
      combatStyle: saved.combatStyle || "charge",
      stats: computeStats(saved.blueprint)
    }))
  ];
}

export function getPurchaseOptionState(option, quantity = state.purchaseQuantity) {
  const mine = state.mine;
  const money = currentMatchMoney(mine);
  const activeShips = mine?.activeShips ?? 0;
  const shipCap = mine?.shipCap ?? state.rules.shipCap ?? 20;
  const remainingSlots = Math.max(0, shipCap - activeShips);
  const totalCost = option.stats.unitCost * quantity;
  const validity = validateBlueprintForPurchase(option.blueprint);
  const pending = getPendingPurchaseForOption(option.id);
  const error = state.purchaseErrors.get(option.id);
  let reason = "";

  if (pending) reason = "Building...";
  else if (error) reason = error.message || "Purchase failed";
  else if (state.phase !== "active") reason = "Match not active";
  else if (!mine?.ready) reason = "Not ready";
  else if (!validity.ok) reason = validity.reason;
  else if (activeShips + quantity > shipCap) reason = quantity === 1 ? "Fleet full" : `Need ${quantity} slots`;
  else if (money < totalCost) reason = `Need $${Math.ceil(totalCost - money)}`;

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

export function validateBlueprintForPurchase(blueprint) {
  if (!Array.isArray(blueprint) || blueprint.length === 0) return { ok: false, reason: "Invalid design" };
  if (blueprint.filter((part) => part.type === "core").length !== 1) return { ok: false, reason: "Invalid core" };
  if (!isConnected(blueprint)) return { ok: false, reason: "Disconnected" };
  return { ok: true, reason: "" };
}

export function renderPurchaseBar() {
  if (!dom.purchaseBar || !dom.purchaseOptions) return;
  dom.purchaseQuantityOne?.classList?.toggle("active", state.purchaseQuantity === 1);
  dom.purchaseQuantityFive?.classList?.toggle("active", state.purchaseQuantity === 5);
  dom.purchaseQuantityOne?.setAttribute?.("aria-pressed", String(state.purchaseQuantity === 1));
  dom.purchaseQuantityFive?.setAttribute?.("aria-pressed", String(state.purchaseQuantity === 5));

  const options = getPurchaseOptions();
  const existingCards = Array.from(dom.purchaseOptions.children);

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
      
      card.addEventListener?.("mouseenter", (event) => showPurchaseTooltip(option.id, event));
      card.addEventListener?.("mousemove", (event) => positionPurchaseTooltip(event));
      card.addEventListener?.("mouseleave", hidePurchaseTooltip);
      card.addEventListener?.("focus", (event) => showPurchaseTooltip(option.id, event));
      card.addEventListener?.("blur", hidePurchaseTooltip);
    }

    const className = `purchase-option ${optionState.pending ? "pending" : optionState.error ? "error" : optionState.canBuy ? "ready" : "disabled"}`;
    if (card.className !== className) {
      card.className = className;
    }
    const ariaDisabled = String(!optionState.canBuy);
    if (card.getAttribute?.("aria-disabled") !== ariaDisabled) {
      card.setAttribute?.("aria-disabled", ariaDisabled);
    }

    const innerHTML = `
      <strong>${escapeHtml(option.name)}</strong>
      <span>${purchaseCostText(option, optionState)}</span>
      <small>${weaponSummaryText(option.stats)}</small>
      <em>${optionState.pending ? "Building..." : optionState.canBuy ? "Ready" : escapeHtml(optionState.reason)}</em>
    `;
    if (card.innerHTML !== innerHTML) {
      card.innerHTML = innerHTML;
    }

    if (isNew) {
      dom.purchaseOptions.appendChild(card);
    }
  });
}

export function purchaseCostText(option, optionState) {
  if (state.purchaseQuantity === 1) return `$${option.stats.unitCost}`;
  return `$${option.stats.unitCost} each | $${optionState.totalCost} total`;
}

export function weaponSummaryText(stats) {
  return `(${weaponAbbrevText(stats)})`;
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
      ${tooltipStat("Turn", stats.turnRate.toFixed(2))}
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

  if (!state.design.length) blockers.push("Invalid design: blueprint is empty.");
  if (!hasCore) blockers.push("Invalid design: missing core.");
  if (!isConnected(state.design)) blockers.push("Invalid design: disconnected parts.");
  if (money < stats.unitCost) blockers.push(`${isActiveBuild ? "Cannot afford ship" : "Cannot ready design"}. Need $${Math.ceil(stats.unitCost - money)} more.`);

  const warnings = [...stats.warnings];
  if (money > 0 && stats.unitCost > money * 0.75) warnings.push("High cost for current money.");
  if (stats.maxShield < 35 && stats.maxHp < 210) warnings.push("Weak defence: low combined hull and shield.");

  return { blockers, warnings };
}
