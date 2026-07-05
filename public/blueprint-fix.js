"use strict";

(() => {
  if (typeof state === "undefined" || typeof dom === "undefined") return;

  state.renamingSavedDesignId = null;

  function editorStats() {
    return computeStats(state.design);
  }

  function loadBlueprint(id) {
    const saved = state.savedDesigns.find((design) => design.id === id);
    if (!saved) return;
    state.design = normalizeDesign(saved.blueprint);
    state.activeSavedDesignId = saved.id;
    state.renamingSavedDesignId = null;
    persistDesign();
    renderBuildGrid();
    renderLocalStats();
    renderSavedDesigns();
    updateEconomyUi();
    showToast(`${saved.name} loaded into editor`, "good");
  }

  function renameBlueprint(id, value) {
    const cleanName = String(value || "").trim().slice(0, 28);
    state.renamingSavedDesignId = null;
    if (!cleanName) {
      renderSavedDesigns();
      return;
    }
    state.savedDesigns = state.savedDesigns.map((design) => design.id === id ? { ...design, name: cleanName, updatedAt: Date.now() } : design);
    persistSavedDesigns();
    renderSavedDesigns();
    showToast(`Renamed ${cleanName}`, "good");
  }

  function deleteBlueprint(id) {
    const saved = state.savedDesigns.find((design) => design.id === id);
    if (!saved) return;
    if (typeof confirm === "function" && !confirm(`Delete ${saved.name}?`)) return;
    state.savedDesigns = state.savedDesigns.filter((design) => design.id !== id);
    if (state.activeSavedDesignId === id) state.activeSavedDesignId = null;
    state.renamingSavedDesignId = null;
    persistSavedDesigns();
    renderSavedDesigns();
    showToast(`Deleted ${saved.name}`, "warning");
  }

  loadSavedDesign = loadBlueprint;
  renameSavedDesign = (id) => {
    state.renamingSavedDesignId = id;
    renderSavedDesigns();
  };
  deleteSavedDesign = deleteBlueprint;

  buyShips = function buyShipsFromEditor(count) {
    if (!state.room || !state.socket || state.socket.readyState !== WebSocket.OPEN) {
      addNotice("Create or join a game first", "warning");
      return;
    }
    if (state.phase !== "active") {
      addNotice("Build ships after the match starts", "warning");
      return;
    }
    send({ type: "buyShip", count, design: state.design });
  };

  renderSavedDesigns = function renderSimpleSavedBlueprints() {
    if (!dom.savedDesignList) return;
    dom.savedDesignList.textContent = "";
    const mine = state.snapshot?.players?.find((player) => player.id === state.myId);
    const money = currentMatchMoney(mine);

    if (!state.savedDesigns.length) {
      const empty = document.createElement("div");
      empty.className = "saved-design-empty";
      empty.textContent = "No saved blueprints yet.";
      dom.savedDesignList.appendChild(empty);
      return;
    }

    for (const saved of state.savedDesigns) {
      const stats = computeStats(saved.blueprint);
      const affordable = money >= stats.unitCost;
      const row = document.createElement("div");
      row.className = `saved-design-card compact ${affordable ? "affordable" : "expensive"}`;

      if (state.renamingSavedDesignId === saved.id) {
        row.innerHTML = `
          <form class="blueprint-rename-form">
            <input type="text" value="${escapeHtml(saved.name)}" maxlength="28" aria-label="Blueprint name">
            <button type="submit">Save</button>
            <button type="button" data-cancel>Cancel</button>
          </form>
        `;
        const form = row.querySelector("form");
        const input = row.querySelector("input");
        form.addEventListener("submit", (event) => {
          event.preventDefault();
          renameBlueprint(saved.id, input.value);
        });
        row.querySelector("[data-cancel]")?.addEventListener("click", () => {
          state.renamingSavedDesignId = null;
          renderSavedDesigns();
        });
        dom.savedDesignList.appendChild(row);
        input.focus();
        input.select();
        continue;
      }

      row.innerHTML = `
        <div class="saved-design-topline">
          <strong>${escapeHtml(saved.name)}</strong>
          <span class="saved-design-status ${affordable ? "affordable" : "expensive"}">${affordable ? "Affordable" : "Too expensive"}</span>
        </div>
        <div class="saved-design-summary">Cost $${stats.unitCost} · Weapons ${stats.blaster}/${stats.missile}/${stats.railgun} · Speed ${Math.round(stats.maxSpeed)}</div>
        ${affordable ? "" : `<div class="saved-design-need">Need $${Math.ceil(stats.unitCost - money)} more</div>`}
        <div class="saved-design-actions compact">
          <button type="button" data-use="${escapeHtml(saved.id)}">Use</button>
          <button type="button" data-rename="${escapeHtml(saved.id)}">Rename</button>
          <button type="button" data-delete="${escapeHtml(saved.id)}" class="danger">Delete</button>
        </div>
      `;

      row.querySelector("[data-use]")?.addEventListener("click", () => loadBlueprint(saved.id));
      row.querySelector("[data-rename]")?.addEventListener("click", () => {
        state.renamingSavedDesignId = saved.id;
        renderSavedDesigns();
      });
      row.querySelector("[data-delete]")?.addEventListener("click", () => deleteBlueprint(saved.id));
      dom.savedDesignList.appendChild(row);
    }
  };

  const oldUpdateEconomyUi = updateEconomyUi;
  updateEconomyUi = function updateSimpleEditorEconomyUi() {
    oldUpdateEconomyUi();
    const stats = editorStats();
    const mine = state.snapshot?.players?.find((player) => player.id === state.myId);
    const money = currentMatchMoney(mine);
    const designPhase = state.phase === "design" || !state.snapshot;

    if (dom.budgetCard) dom.budgetCard.hidden = true;
    if (dom.moneyTitle) dom.moneyTitle.textContent = designPhase ? "Starting money" : "Current money";
    if (dom.unitCostTitle) dom.unitCostTitle.textContent = designPhase ? "Blueprint cost" : "Ship cost";
    if (dom.afterBuildTitle) dom.afterBuildTitle.textContent = designPhase ? "After ready" : "After build";
    if (dom.unitCostLabel) dom.unitCostLabel.textContent = `$${stats.unitCost}`;
    if (dom.afterBuildLabel) dom.afterBuildLabel.textContent = money >= stats.unitCost ? `$${Math.floor(money - stats.unitCost)}` : `Need $${Math.ceil(stats.unitCost - money)}`;
    if (dom.deployButton) {
      dom.deployButton.hidden = state.phase === "active";
      if (state.phase === "design") {
        dom.deployButton.textContent = money >= stats.unitCost ? "Ready with this design" : `Cannot Ready - Need $${Math.ceil(stats.unitCost - money)}`;
      }
    }
  };

  const style = document.createElement("style");
  style.textContent = `.saved-design-card.compact{padding:14px 16px;gap:8px}.saved-design-topline{display:flex;align-items:center;justify-content:space-between;gap:10px}.saved-design-summary{color:var(--muted,#9aa7b8);font-size:.9rem}.saved-design-status{border:1px solid rgba(255,255,255,.13);border-radius:999px;padding:3px 8px;font-size:.75rem;text-transform:uppercase}.saved-design-status.affordable{color:#8df3c2;background:rgba(69,214,143,.1)}.saved-design-status.expensive{color:#ffd37b;background:rgba(255,202,87,.1)}.saved-design-need{color:#ffd37b;font-size:.88rem}.saved-design-actions.compact{display:flex;gap:8px;flex-wrap:wrap;margin-top:6px}.saved-design-actions.compact button,.blueprint-rename-form button{min-height:34px;padding:6px 10px;font-size:.85rem}.saved-design-actions.compact .danger{border-color:rgba(255,95,126,.35)}.blueprint-rename-form{display:grid;grid-template-columns:1fr auto auto;gap:8px;align-items:center}.blueprint-rename-form input{min-width:0}`;
  document.head.appendChild(style);

  renderSavedDesigns();
  updateEconomyUi();
})();
