// Renders top HUD statistics overlays for money, wing fleet sizes, and targeting vectors.

import { dom } from "./dom.js";
import { state } from "../state.js";
import { shipHeatPercent, formatHeatPercent } from "../shared/heatDisplay.js";
import { formatFleet, formatTeamHud } from "./section13bUi.js";

// Diffed DOM writes: updateHud runs on every snapshot (~15x/second), and
// assigning textContent replaces the text node even when the string is
// identical, dirtying layout for nothing. Each write is guarded by a JS-side
// cache of the last value (reading the DOM back would be just as costly).
function setText(el, value) {
  if (el && el.__mfaLastText !== value) { el.__mfaLastText = value; el.textContent = value; }
}
function setTitle(el, value) {
  if (el && el.__mfaLastTitle !== value) { el.__mfaLastTitle = value; el.title = value; }
}

export function updateHud() {
  if (!state.snapshot) return;
  const mine = state.mine;
  const myShips = state.snapshot.ships.filter((ship) => ship.ownerId === state.myId && ship.alive);
  const myTeam = mine?.team;
  const relays = state.snapshot.points.filter((point) => point.ownerTeam === myTeam && point.progress > 0.98).length;
  const income = mine?.income ?? 0;
  const target = currentTarget();
  setText(dom.teamHud, formatTeamHud(myTeam));
  setText(dom.fleetLabel, formatFleet(myShips.length, state.rules?.shipCap ?? mine?.shipCap));
  setText(dom.moneyHud, `$${mine?.money ?? 0}`);
  if (dom.incomeHud) {
    setText(dom.incomeHud, `+$${Math.round(income)}/s`);
    setTitle(dom.incomeHud, mine?.ready
      ? `Base income plus ${relays} captured relay${relays === 1 ? "" : "s"}. Money rises every second.`
      : "Ready with an affordable starting design to begin earning money.");
  }
  setText(dom.relayLabel, String(relays));
  setText(dom.selectionLabel, `${state.selectedShipIds.size}`);
  setText(dom.objectiveLabel, target ? target.label : "None");
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
    if (dom.heatHudFill.__mfaLastHeat !== visualHeat) {
      dom.heatHudFill.__mfaLastHeat = visualHeat;
      if (typeof dom.heatHudFill.style.setProperty === "function") dom.heatHudFill.style.setProperty("--heat-percent", visualHeat);
      else dom.heatHudFill.style.width = visualHeat;
    }
  }
  setText(dom.heatHudLabel, overheatedCount ? `HEAT ${heatText} · ${overheatedCount} OVERHEATED` : hotCount ? `HEAT ${heatText} · ${hotCount} HOT` : `HEAT ${heatText}`);
  if (dom.heatHud) {
    const heatClass = `heat-hud${overheatedCount ? " overheated" : hotCount ? " hot" : ""}`;
    if (dom.heatHud.__mfaLastClass !== heatClass) { dom.heatHud.__mfaLastClass = heatClass; dom.heatHud.className = heatClass; }
    setTitle(dom.heatHud, `${hotCount} hot component${hotCount === 1 ? "" : "s"}, ${overheatedCount} overheated`);
  }
  setText(dom.latency, state.latency == null ? "-- ms" : `${Math.round(state.latency)} ms`);
}

export function currentTarget() {
  if (!state.command) return null;
  if (state.command.targetName) return { label: state.command.targetName };
  return { label: `${Math.round(state.command.x)},${Math.round(state.command.y)}` };
}
