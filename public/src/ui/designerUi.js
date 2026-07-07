import { state, deployDesign, startDesign, dom } from "./dom.js";
import { send } from "./purchaseUi.js";
import { addNotice } from "./scoreboardUi.js";


export function deployDesign() {
  if (!state.room || !state.socket || state.socket.readyState !== WebSocket.OPEN) {
    addNotice("Create or join a game first", "warning");
    return;
  }
  if (state.phase !== "design" && state.phase !== "active") {
    addNotice("Wait for ship design or match start", "warning");
    return;
  }
  send({ type: "deploy", design: state.design });
}

export function startDesign() {
  send({ type: "startDesign" });
}