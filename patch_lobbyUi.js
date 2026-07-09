const fs = require('fs');

const path = "public/src/ui/lobbyUi.js";
let content = fs.readFileSync(path, 'utf8');

const search = `
export function renderPlayerList() {
  if (!dom.playerList || dom.lobbyManagementScreen?.hidden) return;
  const players = state.snapshot?.players || [];
  dom.playerList.textContent = "";
  if (!players.length) return;

  for (const player of players) {
    const row = document.createElement("div");
    row.className = \`player-row\${player.id === state.myId ? " mine" : ""}\`;
    const canKick = isAdmin() && player.id !== state.myId && state.phase !== "active";
    const status = player.isAdmin ? "Admin" : player.ready ? "Ready" : state.phase === "design" ? "Designing" : player.isBot ? "Bot" : "Waiting";
    row.innerHTML = \`
      <span class="score-color" style="background:\${player.color}"></span>
      <div>
        <strong>\${escapeHtml(player.name)}\${player.id === state.myId ? " (you)" : ""}</strong>
        <span>\${escapeHtml(state.rules?.gameMode === "solo" ? "No wing" : player.teamName || "Blue wing")} | \${status}</span>
      </div>
      \${canKick ? \`<button type="button" data-kick="\${escapeHtml(player.id)}">Kick</button>\` : ""}
    \`;
    dom.playerList.appendChild(row);
  }
}
`;

const replace = `
function createPlayerRow(player) {
  const row = document.createElement("div");
  row.className = \`player-row\${player.id === state.myId ? " mine" : ""}\`;
  const canKick = isAdmin() && player.id !== state.myId && state.phase !== "active";
  const status = player.isAdmin ? "Admin" : player.ready ? "Ready" : state.phase === "design" ? "Designing" : player.isBot ? "Bot" : "Waiting";
  row.innerHTML = \`
    <span class="score-color" style="background:\${player.color}"></span>
    <div>
      <strong>\${escapeHtml(player.name)}\${player.id === state.myId ? " (you)" : ""}</strong>
      <span>\${escapeHtml(state.rules?.gameMode === "solo" ? "No wing" : player.teamName || "Blue wing")} | \${status}</span>
    </div>
    \${canKick ? \`<button type="button" data-kick="\${escapeHtml(player.id)}">Kick</button>\` : ""}
  \`;
  return row;
}

export function renderPlayerList() {
  if (!dom.playerList || dom.lobbyManagementScreen?.hidden) return;
  const players = state.snapshot?.players || [];
  dom.playerList.textContent = "";
  if (!players.length) return;

  if (state.rules?.gameMode === "solo") {
    for (const player of players) {
      dom.playerList.appendChild(createPlayerRow(player));
    }
  } else {
    const blueTeam = players.filter((p) => p.team !== "red");
    const redTeam = players.filter((p) => p.team === "red");

    const blueHeader = document.createElement("div");
    blueHeader.className = "section-heading compact";
    blueHeader.innerHTML = "<h2>Blue wing</h2>";
    dom.playerList.appendChild(blueHeader);

    if (blueTeam.length === 0) {
      const empty = document.createElement("div");
      empty.textContent = "No players";
      empty.style.opacity = "0.5";
      empty.style.marginBottom = "1rem";
      empty.style.fontSize = "0.85rem";
      dom.playerList.appendChild(empty);
    } else {
      for (const player of blueTeam) {
        dom.playerList.appendChild(createPlayerRow(player));
      }
    }

    const redHeader = document.createElement("div");
    redHeader.className = "section-heading compact";
    redHeader.style.marginTop = "0.5rem";
    redHeader.innerHTML = "<h2>Red wing</h2>";
    dom.playerList.appendChild(redHeader);

    if (redTeam.length === 0) {
      const empty = document.createElement("div");
      empty.textContent = "No players";
      empty.style.opacity = "0.5";
      empty.style.fontSize = "0.85rem";
      dom.playerList.appendChild(empty);
    } else {
      for (const player of redTeam) {
        dom.playerList.appendChild(createPlayerRow(player));
      }
    }
  }
}
`;

if (content.includes(search.trim())) {
  content = content.replace(search.trim(), replace.trim());
  fs.writeFileSync(path, content, 'utf8');
  console.log("Successfully patched lobbyUi.js");
} else {
  console.log("Could not find search block");
}
