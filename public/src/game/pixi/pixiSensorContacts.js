// Minimal Pixi rendering for remembered sensor contacts.

import { state } from "../../state.js";
import { isCircleVisible } from "../viewportCulling.js";

const contactGauges = new Map();

function contactMarker(PIXI, contact, now) {
  const radius = 14;
  const color = contact.sourceEntityType === "station" ? "rgba(255,157,85,0.82)" : "rgba(143,216,255,0.82)";
  const zoom = state.camera?.zoom || 1;
  const container = new PIXI.Container();

  const gfx = new PIXI.Graphics();
  gfx.circle(0, 0, radius);
  gfx.fill({ color, alpha: 0.18 });
  gfx.stroke({ width: 1.5 / zoom, color });

  // Direction tick
  const angle = contact.lastKnownAngle || 0;
  gfx.moveTo(0, 0);
  gfx.lineTo(Math.cos(angle) * (radius + 6), Math.sin(angle) * (radius + 6));
  gfx.stroke({ width: 1 / zoom, color });

  const label = new PIXI.Text({
    text: contact.contactClass || "?",
    style: {
      fontFamily: "system-ui, sans-serif",
      fontSize: 10,
      fill: color,
      align: "center"
    }
  });
  label.anchor.set(0.5, 0);
  label.y = radius + 4;

  container.addChild(gfx, label);
  container.x = contact.lastKnownX;
  container.y = contact.lastKnownY;
  container.alpha = 0.7;
  return container;
}

export function updatePixiContacts(env, now, bounds) {
  const layer = env.layers.contacts;
  const contacts = state.snapshot?.contacts || [];
  const desired = new Set();

  for (const contact of contacts) {
    desired.add(contact.id);
    if (!isCircleVisible(contact.lastKnownX, contact.lastKnownY, 20, bounds)) continue;
    let view = contactGauges.get(contact.id);
    if (!view) {
      view = contactMarker(env.PIXI, contact, now);
      contactGauges.set(contact.id, view);
      layer.addChild(view);
    } else {
      view.x = contact.lastKnownX;
      view.y = contact.lastKnownY;
    }
  }

  for (const [id, view] of contactGauges) {
    if (!desired.has(id)) {
      layer.removeChild(view);
      view.destroy();
      contactGauges.delete(id);
    }
  }
}

export function destroyPixiContacts() {
  for (const [id, view] of contactGauges) {
    view.destroy();
    contactGauges.delete(id);
  }
}
