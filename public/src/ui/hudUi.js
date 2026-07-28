// Independently invalidated, diff-written top HUD sections.

import { dom } from "./dom.js";
import { state } from "../state.js";
import { shipHeatPercent, formatHeatPercent } from "../shared/heatDisplay.js";
import { formatFleet, formatTeamHud } from "./section13bUi.js";

function setText(el, value) {
  if (el && el.__mfaLastText !== value) {
    el.__mfaLastText = value;
    el.textContent = value;
    bumpWrite();
  }
}
function setTitle(el, value) {
  if (el && el.__mfaLastTitle !== value) {
    el.__mfaLastTitle = value;
    el.title = value;
    bumpWrite();
  }
}
function economyData() {
  if (!state.snapshot || !state.snapshotIndex) return null;
  const mine = state.mine;
  const myTeam = mine?.team;
  const relays = (state.snapshotIndex.relaysByTeam.get(myTeam) || [])
    .reduce((count, point) => count + (point.progress > 0.98 ? 1 : 0), 0);
  return { mine, myTeam, relays };
}
function bump(name) {
  const diagnostics = state.presentationDiagnostics;
  if (diagnostics) diagnostics[name] = (diagnostics[name] || 0) + 1;
}
function bumpWrite() {
  const diagnostics = state.presentationDiagnostics;
  if (!diagnostics) return;
  diagnostics.presentationDomWriteCount += 1;
  diagnostics.hudDomWriteCount += 1;
}

export function updateTeamHud() {
  bump("teamHudUpdateCount");
  const mine = state.mine;
  if (mine) setText(dom.teamHud, formatTeamHud(mine.team));
}
export function updateFleetHud() {
  bump("fleetHudUpdateCount");
  const index = state.snapshotIndex;
  if (index) setText(dom.fleetLabel, formatFleet(index.ownLivingShips.length, state.rules?.shipCap ?? state.mine?.shipCap));
}
export function updateEconomyHud() {
  bump("economyHudUpdateCount");
  const d = economyData(); if (!d) return;
  const income = d.mine?.income ?? 0;
  setText(dom.moneyHud, `$${d.mine?.money ?? 0}`);
  setText(dom.incomeHud, `+$${Math.round(income)}/s`);
  setTitle(dom.incomeHud, d.mine?.ready
    ? `Base income plus ${d.relays} captured relay${d.relays === 1 ? "" : "s"}. Money rises every second.`
    : "Ready with an affordable starting design to begin earning money.");
}
export function updateRelayHud() {
  bump("relayHudUpdateCount");
  const d = economyData(); if (d) setText(dom.relayLabel, String(d.relays));
}
export function updateSelectionHud() {
  bump("selectionHudUpdateCount");
  setText(dom.selectionLabel, `${state.selectedShipIds.size}`);
}
export function updateObjectiveHud() {
  const target = currentTarget();
  setText(dom.objectiveLabel, target ? target.label : "None");
  bump("objectiveHudUpdateCount");
}
export function updateHeatHud() {
  bump("heatHudUpdateCount");
  const index = state.snapshotIndex; if (!index) return;
  const selected = index.selectedLivingShips.filter((ship) => ship.ownerId === state.myId);
  if (dom.heatHud && dom.heatHud.hidden !== (selected.length === 0)) {
    dom.heatHud.hidden = selected.length === 0;
    bumpWrite();
  }
  const heatShips = selected.length ? selected : index.ownLivingShips;
  const heat = heatShips.length ? Math.max(...heatShips.map(shipHeatPercent)) : 0;
  const hotCount = heatShips.reduce((sum, ship) => sum + (Number(ship.hot) || 0), 0);
  const overheatedCount = heatShips.reduce((sum, ship) => sum + (Number(ship.overheated) || 0), 0);
  const heatText = formatHeatPercent(heat);
  if (dom.heatHudFill) {
    const visualHeat = `${Math.max(0, Math.min(100, heat))}%`;
    if (dom.heatHudFill.__mfaLastHeat !== visualHeat) {
      dom.heatHudFill.__mfaLastHeat = visualHeat;
      if (typeof dom.heatHudFill.style.setProperty === "function") dom.heatHudFill.style.setProperty("--heat-percent", visualHeat);
      else dom.heatHudFill.style.width = visualHeat;
      bumpWrite();
    }
  }
  setText(dom.heatHudLabel, overheatedCount ? `HEAT ${heatText} · ${overheatedCount} OVERHEATED` : hotCount ? `HEAT ${heatText} · ${hotCount} HOT` : `HEAT ${heatText}`);
  if (dom.heatHud) {
    const heatClass = `heat-hud${overheatedCount ? " overheated" : hotCount ? " hot" : ""}`;
    if (dom.heatHud.__mfaLastClass !== heatClass) {
      dom.heatHud.__mfaLastClass = heatClass;
      dom.heatHud.className = heatClass;
      bumpWrite();
    }
    setTitle(dom.heatHud, `${hotCount} hot component${hotCount === 1 ? "" : "s"}, ${overheatedCount} overheated`);
  }
}
export function updateLatencyHud() {
  setText(dom.latency, state.latency == null ? "-- ms" : `${Math.round(state.latency)} ms`);
  bump("latencyHudUpdateCount");
}
export function updateHud() {
  updateTeamHud(); updateFleetHud(); updateEconomyHud(); updateRelayHud();
  updateSelectionHud(); updateObjectiveHud(); updateHeatHud(); updateLatencyHud();
}
export function currentTarget() {
  if (!state.command) return null;
  if (state.command.targetName) return { label: state.command.targetName };
  return { label: `${Math.round(state.command.x)},${Math.round(state.command.y)}` };
}
