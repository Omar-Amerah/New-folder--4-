// Renders top HUD statistics overlays for money, wing fleet sizes, and targeting vectors.

import { dom } from "./dom.js";
import { state } from "../state.js";

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
  const heat = heatShips.length ? Math.max(...heatShips.map(ship => Number(ship.heat) || 0)) : 0;
  const hotCount = heatShips.reduce((sum, ship) => sum + (Number(ship.hot) || 0), 0);
  const overheatedCount = heatShips.reduce((sum, ship) => sum + (Number(ship.overheated) || 0), 0);
  if (dom.heatHudFill) dom.heatHudFill.style.width = `${heat}%`;
  if (dom.heatHudLabel) dom.heatHudLabel.textContent = overheatedCount ? `HEAT ${heat}% · ${overheatedCount} OVERHEATED` : hotCount ? `HEAT ${heat}% · ${hotCount} HOT` : `HEAT ${heat}%`;
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
