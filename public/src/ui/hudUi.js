// Renders top HUD statistics overlays for money, wing fleet sizes, and targeting vectors.

import { dom } from "./dom.js";
import { state } from "../state.js";
import { shipHeatPercent, formatHeatPercent } from "../shared/heatDisplay.js";

export function updateHud() {
  if (!state.snapshot) return;
  const mine = state.mine;
  const myShips = state.snapshot.ships.filter((ship) => ship.ownerId === state.myId && ship.alive);
  const myTeam = mine?.team;
  const relays = state.snapshot.points.filter((point) => point.ownerTeam === myTeam && point.progress > 0.98).length;
  const income = mine?.income ?? 0;
  const target = currentTarget();
  dom.fleetLabel.textContent = `${myShips.length}`;
  dom.moneyHud.textContent = `$${mine?.money ?? 0}`;
  if (dom.incomeHud) {
    dom.incomeHud.textContent = `+$${Math.round(income)}/s`;
    dom.incomeHud.title = mine?.ready
      ? `Base income plus ${relays} captured relay${relays === 1 ? "" : "s"}. Money rises every second.`
      : "Ready with an affordable starting design to begin earning money.";
  }
  dom.relayLabel.textContent = String(relays);
  dom.selectionLabel.textContent = `${state.selectedShipIds.size}`;
  dom.objectiveLabel.textContent = target ? target.label : "None";
  const selected = myShips.filter(ship => state.selectedShipIds.has(ship.id));
  const heatShips = selected.length ? selected : myShips;
  // Derived from the same heatNow/heatMax stored values the detail panel
  // shows, so the HUD percentage can never disagree with the stored readout.
  const heat = heatShips.length ? Math.max(...heatShips.map(shipHeatPercent)) : 0;
  const hotCount = heatShips.reduce((sum, ship) => sum + (Number(ship.hot) || 0), 0);
  const overheatedCount = heatShips.reduce((sum, ship) => sum + (Number(ship.overheated) || 0), 0);
  const heatText = formatHeatPercent(heat);
  // The bar keeps the real fractional width even when the text reads below 1%.
  if (dom.heatHudFill) {
    const visualHeat = `${Math.max(0, Math.min(100, heat))}%`;
    if (typeof dom.heatHudFill.style.setProperty === "function") dom.heatHudFill.style.setProperty("--heat-percent", visualHeat);
    else dom.heatHudFill.style.width = visualHeat;
  }
  if (dom.heatHudLabel) dom.heatHudLabel.textContent = overheatedCount ? `HEAT ${heatText} · ${overheatedCount} OVERHEATED` : hotCount ? `HEAT ${heatText} · ${hotCount} HOT` : `HEAT ${heatText}`;
  if (dom.heatHud) {
    dom.heatHud.className = `heat-hud${overheatedCount ? " overheated" : hotCount ? " hot" : ""}`;
    dom.heatHud.title = `${hotCount} hot component${hotCount === 1 ? "" : "s"}, ${overheatedCount} overheated`;
  }
  dom.latency.textContent = state.latency == null ? "-- ms" : `${Math.round(state.latency)} ms`;
}

export function currentTarget() {
  if (!state.command) return null;
  if (state.command.targetName) return { label: state.command.targetName };
  return { label: `${Math.round(state.command.x)},${Math.round(state.command.y)}` };
}
