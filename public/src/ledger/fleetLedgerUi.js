// Fleet Ledger UI module: manages the overlay, navigation, search, article
// rendering, history (back/forward), and keyboard accessibility.
//
// This module owns no global mutable state. All state is encapsulated in a
// single `ledgerState` object created on init and torn down on close.

import { dom } from "../ui/dom.js";
import { CATEGORIES, getAllArticles, getArticleById, getArticlesByCategory, getRelatedArticles, searchArticles } from "./ledgerContent.js";
import { escapeHtml } from "../shared/formatting.js";

let ledgerState = null;

function ensureState() {
  if (!ledgerState) {
    ledgerState = {
      history: [],
      historyIndex: -1,
      currentArticleId: null,
      searchQuery: "",
      searchResults: [],
      lastFocusedElement: null,
      categoryNavEl: null,
      contentEl: null,
      relatedEl: null,
      searchInputEl: null,
      backButtonEl: null,
      forwardButtonEl: null,
      homeButtonEl: null,
      closeButtonEl: null,
      overlayEl: null
    };
  }
  return ledgerState;
}

export function renderArticleContent(article) {
  if (!article) return "";
  const parts = [];

  const catLabel = CATEGORIES.find((c) => c.id === article.category)?.label || article.category;
  parts.push(`<h2 class="ledger-article-title">${escapeHtml(article.title)}</h2>`);
  parts.push(`<span class="ledger-article-category">${escapeHtml(catLabel)}</span>`);
  parts.push(`<p class="ledger-article-summary">${escapeHtml(article.summary)}</p>`);

  const tocItems = [];

  if (article.howItWorks) {
    tocItems.push({ id: "how-it-works", label: "How It Works" });
    parts.push(`<section class="ledger-section" id="ledger-sec-how-it-works"><h3 class="ledger-section-heading">How It Works</h3><p>${escapeHtml(article.howItWorks)}</p></section>`);
  }

  if (article.importantStats && article.importantStats.length) {
    tocItems.push({ id: "key-stats", label: "Key Stats" });
    const rows = article.importantStats
      .map((s) => `<div class="ledger-key-stat-row"><dt class="ledger-key-stat-label">${escapeHtml(s.label)}</dt><dd class="ledger-key-stat-value">${escapeHtml(s.value)}</dd></div>`)
      .join("");
    parts.push(`<section class="ledger-section ledger-key-stats-section" id="ledger-sec-key-stats" aria-labelledby="ledger-key-stats-heading"><h3 class="ledger-section-heading" id="ledger-key-stats-heading">Key Stats</h3><dl class="ledger-key-stat-list">${rows}</dl></section>`);
  }

  if (article.conditionalPerformance && article.conditionalPerformance.length) {
    tocItems.push({ id: "conditional-performance", label: "Conditional Performance" });
    const rows = article.conditionalPerformance
      .map((s) => {
        const cls = s.warning ? " ledger-stat-row-warning" : "";
        const detail = s.detail ? `<div class="ledger-stat-detail">${escapeHtml(s.detail)}</div>` : "";
        return `<div class="ledger-stat-row${cls}"><span class="ledger-stat-label">${escapeHtml(s.label)}</span><span class="ledger-stat-value">${escapeHtml(s.value)}</span>${detail}</div>`;
      })
      .join("");
    parts.push(`<section class="ledger-section" id="ledger-sec-conditional-performance"><h3 class="ledger-section-heading">Conditional Performance</h3><div class="ledger-stat-grid">${rows}</div><p class="ledger-section-note">Values vary by condition : these are not base stats.</p></section>`);
  }

  if (article.specialMechanics && article.specialMechanics.length) {
    tocItems.push({ id: "special-mechanics", label: "Special Mechanics" });
    const rows = article.specialMechanics
      .map((m) => {
        const cls = m.warning ? " ledger-mechanics-row-warning" : "";
        const detail = m.detail ? `<div class="ledger-mechanics-detail">${escapeHtml(m.detail)}</div>` : "";
        const condition = m.condition ? `<div class="ledger-mechanics-condition">Condition: ${escapeHtml(m.condition)}</div>` : "";
        return `<div class="ledger-mechanics-row${cls}"><span class="ledger-mechanics-label">${escapeHtml(m.label)}</span><span class="ledger-mechanics-value">${escapeHtml(m.value)}</span>${detail}${condition}</div>`;
      })
      .join("");
    parts.push(`<section class="ledger-section" id="ledger-sec-special-mechanics"><h3 class="ledger-section-heading">Special Mechanics</h3><div class="ledger-mechanics-grid">${rows}</div></section>`);
  }

  if (article.requirementsLimitations && article.requirementsLimitations.length) {
    tocItems.push({ id: "requirements", label: "Requirements & Limitations" });
    const rows = article.requirementsLimitations
      .map((r) => {
        const cls = r.warning ? " ledger-mechanics-row-warning" : "";
        const detail = r.detail ? `<div class="ledger-mechanics-detail">${escapeHtml(r.detail)}</div>` : "";
        return `<div class="ledger-mechanics-row${cls}"><span class="ledger-mechanics-label">${escapeHtml(r.label)}</span><span class="ledger-mechanics-value">${escapeHtml(r.value)}</span>${detail}</div>`;
      })
      .join("");
    parts.push(`<section class="ledger-section" id="ledger-sec-requirements"><h3 class="ledger-section-heading">Requirements & Limitations</h3><div class="ledger-mechanics-grid">${rows}</div></section>`);
  }

  if (article.interactions && article.interactions.length) {
    tocItems.push({ id: "interactions", label: "Interactions" });
    const rows = article.interactions
      .map((i) => {
        const detail = i.detail ? `<div class="ledger-mechanics-detail">${escapeHtml(i.detail)}</div>` : "";
        return `<div class="ledger-mechanics-row"><span class="ledger-mechanics-label">${escapeHtml(i.label)}</span><span class="ledger-mechanics-value">${escapeHtml(i.value)}</span>${detail}</div>`;
      })
      .join("");
    parts.push(`<section class="ledger-section" id="ledger-sec-interactions"><h3 class="ledger-section-heading">Interactions</h3><div class="ledger-mechanics-grid">${rows}</div></section>`);
  }

  if (article.practicalUse) {
    tocItems.push({ id: "practical-use", label: "Practical Use" });
    parts.push(`<section class="ledger-section" id="ledger-sec-practical-use"><h3 class="ledger-section-heading">Practical Use</h3><p>${escapeHtml(article.practicalUse)}</p></section>`);
  }

  if (article.commonProblems && article.commonProblems.length) {
    tocItems.push({ id: "common-problems", label: "Common Problems" });
    const items = article.commonProblems
      .map((p) => `<li>${escapeHtml(p)}</li>`)
      .join("");
    parts.push(`<section class="ledger-section" id="ledger-sec-common-problems"><h3 class="ledger-section-heading">Common Problems</h3><ul class="ledger-problems">${items}</ul></section>`);
  }

  if (tocItems.length > 1) {
    const tocLinks = tocItems
      .map((t) => `<button type="button" class="ledger-toc-link" data-ledger-scroll="${escapeHtml(t.id)}">${escapeHtml(t.label)}</button>`)
      .join("");
    const toc = `<nav class="ledger-toc" aria-label="Article sections">${tocLinks}</nav>`;
    parts.splice(3, 0, toc);
  }

  return parts.join("");
}

function renderRelatedArticles(article) {
  const related = getRelatedArticles(article);
  if (!related.length) return "";
  const items = related
    .map((a) => `<button type="button" class="ledger-related-item" data-ledger-article="${escapeHtml(a.id)}">${escapeHtml(a.title)}</button>`)
    .join("");
  return `<h3 class="ledger-related-heading">Related</h3><div class="ledger-related-list">${items}</div>`;
}

function renderCategoryNav() {
  const state = ensureState();
  const currentArticle = state.currentArticleId ? getArticleById(state.currentArticleId) : null;
  const expandedCat = currentArticle?.category || null;

  const blocks = CATEGORIES.map((cat) => {
    const catArticles = getArticlesByCategory(cat.id);
    const count = catArticles.length;
    const isExpanded = cat.id === expandedCat;
    const cls = isExpanded ? "ledger-cat-item ledger-cat-current" : "ledger-cat-item";

    const articleItems = catArticles.map((a) => {
      const isActive = a.id === state.currentArticleId;
      const itemCls = isActive ? "ledger-cat-article is-active" : "ledger-cat-article";
      return `<button type="button" class="${itemCls}" data-ledger-article="${escapeHtml(a.id)}"${isActive ? ' aria-current="true"' : ''}>${escapeHtml(a.title)}</button>`;
    }).join("");

    return `<div class="ledger-cat-group${isExpanded ? " is-expanded" : ""}">
      <button type="button" class="${cls}" data-ledger-category="${escapeHtml(cat.id)}"${isExpanded ? ' aria-current="true"' : ''}><span class="ledger-cat-label">${escapeHtml(cat.label)}</span><span class="ledger-cat-count">${count}</span></button>
      <div class="ledger-cat-articles"${isExpanded ? "" : " hidden"}>${articleItems}</div>
    </div>`;
  }).join("");
  return blocks;
}

function renderSearchResults() {
  const state = ensureState();
  if (!state.searchQuery) return null;
  const results = state.searchResults;
  if (!results.length) return `<div class="ledger-search-empty">No articles found for "${escapeHtml(state.searchQuery)}"</div>`;
  const items = results
    .slice(0, 30)
    .map((a) => {
      const cat = CATEGORIES.find((c) => c.id === a.category);
      const catLabel = cat ? cat.label : a.category;
      return `<button type="button" class="ledger-search-result" data-ledger-article="${escapeHtml(a.id)}"><span class="ledger-search-result-title">${escapeHtml(a.title)}</span><span class="ledger-search-result-cat">${escapeHtml(catLabel)}</span></button>`;
    })
    .join("");
  return `<div class="ledger-search-results">${items}</div>`;
}

function updateNavButtons() {
  const state = ensureState();
  if (state.backButtonEl) state.backButtonEl.disabled = state.historyIndex <= 0;
  if (state.forwardButtonEl) state.forwardButtonEl.disabled = state.historyIndex >= state.history.length - 1;
}

function navigateTo(articleId, pushHistory = true) {
  const state = ensureState();
  const article = getArticleById(articleId);
  if (!article) return;

  if (pushHistory) {
    state.history = state.history.slice(0, state.historyIndex + 1);
    state.history.push(articleId);
    state.historyIndex = state.history.length - 1;
  }

  state.currentArticleId = articleId;
  state.searchQuery = "";
  if (state.searchInputEl) state.searchInputEl.value = "";

  renderCurrentArticle();
  updateNavButtons();
}

function renderCurrentArticle() {
  const state = ensureState();
  const article = getArticleById(state.currentArticleId);
  if (!article) return;

  if (state.contentEl) state.contentEl.innerHTML = renderArticleContent(article);
  if (state.relatedEl) state.relatedEl.innerHTML = renderRelatedArticles(article);
  if (state.categoryNavEl) state.categoryNavEl.innerHTML = renderCategoryNav();
}

function showHome() {
  const state = ensureState();
  state.history = state.history.slice(0, state.historyIndex + 1);
  state.history.push("overview");
  state.historyIndex = state.history.length - 1;
  state.currentArticleId = "overview";
  state.searchQuery = "";
  if (state.searchInputEl) state.searchInputEl.value = "";
  renderCurrentArticle();
  updateNavButtons();
}

function goBack() {
  const state = ensureState();
  if (state.historyIndex > 0) {
    state.historyIndex--;
    state.currentArticleId = state.history[state.historyIndex];
    renderCurrentArticle();
    updateNavButtons();
  }
}

function goForward() {
  const state = ensureState();
  if (state.historyIndex < state.history.length - 1) {
    state.historyIndex++;
    state.currentArticleId = state.history[state.historyIndex];
    renderCurrentArticle();
    updateNavButtons();
  }
}

function handleSearch(event) {
  const state = ensureState();
  const query = event.target.value;
  state.searchQuery = query;
  state.searchResults = searchArticles(query);

  const contentEl = state.contentEl;
  if (!contentEl) return;

  if (query && query.trim()) {
    const resultsHtml = renderSearchResults();
    contentEl.innerHTML = `<h2 class="ledger-article-title">Search: ${escapeHtml(query)}</h2>` + (resultsHtml || "");
    if (state.relatedEl) state.relatedEl.innerHTML = "";
  } else {
    renderCurrentArticle();
  }
}

function handleContentClick(event) {
  const target = event.target;

  const scrollBtn = target.closest("[data-ledger-scroll]");
  if (scrollBtn) {
    event.preventDefault();
    const secId = `ledger-sec-${scrollBtn.getAttribute("data-ledger-scroll")}`;
    const state = ensureState();
    const section = state.contentEl?.querySelector(`#${secId}`);
    if (section) section.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }

  const articleBtn = target.closest("[data-ledger-article]");
  if (articleBtn) {
    event.preventDefault();
    navigateTo(articleBtn.getAttribute("data-ledger-article"));
    return;
  }
  const catBtn = target.closest("[data-ledger-category]");
  if (catBtn) {
    event.preventDefault();
    const catId = catBtn.getAttribute("data-ledger-category");
    const group = catBtn.closest(".ledger-cat-group");
    if (group) {
      const articlesDiv = group.querySelector(".ledger-cat-articles");
      if (articlesDiv) {
        const willExpand = articlesDiv.hidden;
        articlesDiv.hidden = !willExpand;
        group.classList.toggle("is-expanded", willExpand);
        catBtn.classList.toggle("ledger-cat-current", willExpand);
        catBtn.setAttribute("aria-current", willExpand ? "true" : "false");
      }
    }
    return;
  }
}

function handleKeyDown(event) {
  if (event.key === "Escape") {
    event.preventDefault();
    closeLedger();
    return;
  }
  if (event.ctrlKey || event.metaKey) return;
  if (event.target && event.target.tagName === "INPUT") return;
  if (event.key === "ArrowLeft") {
    event.preventDefault();
    goBack();
  } else if (event.key === "ArrowRight") {
    event.preventDefault();
    goForward();
  } else if (event.key === "Home") {
    event.preventDefault();
    showHome();
  }
}

export function openLedger(articleId = "overview") {
  const state = ensureState();
  const overlay = dom.ledgerOverlay;
  if (!overlay) return;

  state.lastFocusedElement = document.activeElement;
  overlay.hidden = false;
  overlay.setAttribute("aria-hidden", "false");

  state.categoryNavEl = dom.ledgerCategoryNav;
  state.contentEl = dom.ledgerContent;
  state.relatedEl = dom.ledgerRelated;
  state.searchInputEl = dom.ledgerSearchInput;
  state.backButtonEl = dom.ledgerBackButton;
  state.forwardButtonEl = dom.ledgerForwardButton;
  state.homeButtonEl = dom.ledgerHomeButton;
  state.closeButtonEl = dom.ledgerCloseButton;
  state.overlayEl = overlay;

  state.history = [];
  state.historyIndex = -1;
  navigateTo(articleId);

  if (state.searchInputEl) state.searchInputEl.focus();

  if (!state._listenersAttached) {
    state._listenersAttached = true;
    if (state.backButtonEl) state.backButtonEl.addEventListener("click", goBack);
    if (state.forwardButtonEl) state.forwardButtonEl.addEventListener("click", goForward);
    if (state.homeButtonEl) state.homeButtonEl.addEventListener("click", showHome);
    if (state.closeButtonEl) state.closeButtonEl.addEventListener("click", closeLedger);
    if (state.searchInputEl) state.searchInputEl.addEventListener("input", handleSearch);
    if (state.contentEl) state.contentEl.addEventListener("click", handleContentClick);
    if (state.categoryNavEl) state.categoryNavEl.addEventListener("click", handleContentClick);
    if (state.relatedEl) state.relatedEl.addEventListener("click", handleContentClick);
    overlay.addEventListener("keydown", handleKeyDown);
  }
}

export function closeLedger() {
  const state = ensureState();
  const overlay = dom.ledgerOverlay;
  if (!overlay || overlay.hidden) return;

  overlay.hidden = true;
  overlay.setAttribute("aria-hidden", "true");

  if (state.lastFocusedElement && state.lastFocusedElement.focus) {
    state.lastFocusedElement.focus();
  }
}

export function isLedgerOpen() {
  const overlay = dom.ledgerOverlay;
  return overlay ? !overlay.hidden : false;
}

export function initLedger() {
  const state = ensureState();
  const overlay = dom.ledgerOverlay;
  if (!overlay) return;
  state.overlayEl = overlay;
}

export function openArticle(partId) {
  const articleId = `component:${partId}`;
  const article = getArticleById(articleId);
  if (article) {
    openLedger(articleId);
  } else {
    openLedger("overview");
  }
}
