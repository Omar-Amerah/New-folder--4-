// Fleet Ledger catalogue composition and public query API.

import { BASICS_CONTENT } from "./basics.js";
import { BUILDING_SHIPS_CONTENT } from "./buildingShips.js";
import { ENGINEERING_CONTENT } from "./engineering.js";
import { COMBAT_CONTENT } from "./combat.js";
import { SUPPORT_AND_DEFENCE_CONTENT } from "./supportAndDefence.js";
import { FLEET_OPERATIONS_CONTENT } from "./fleetOperations.js";
import { generateAllComponentArticles } from "./componentArticles.js";
import { SPECIAL_MECHANICS_COMPONENTS, LEDGER_RULE_CONTRACTS } from "../componentMechanics.js";

export { SPECIAL_MECHANICS_COMPONENTS, LEDGER_RULE_CONTRACTS };

export const CATEGORIES = [
  { id: "start-here", label: "Start Here" },
  { id: "building-ships", label: "Building Ships" },
  { id: "combat", label: "Combat" },
  { id: "heat", label: "Heat" },
  { id: "movement", label: "Movement" },
  { id: "sensors-detection", label: "Sensors & Detection" },
  { id: "data-links", label: "Data Links" },
  { id: "weapons", label: "Weapons" },
  { id: "shields-armour", label: "Shields & Armour" },
  { id: "drones", label: "Drones" },
  { id: "command", label: "Command" },
  { id: "economy-objectives", label: "Economy & Objectives" },
  { id: "advanced-mechanics", label: "Advanced Mechanics" },
  { id: "component-reference", label: "Component Reference" }
];

const CATEGORY_LANDING_ARTICLES = Object.freeze({
  "start-here": "overview",
  "building-ships": "blueprint-designer",
  combat: "combat",
  heat: "heat",
  movement: "movement",
  "sensors-detection": "sensors-detection",
  "data-links": "support",
  weapons: "weapons",
  "shields-armour": "defence",
  drones: "drones",
  command: "command",
  "economy-objectives": "economy",
  "advanced-mechanics": "advanced-mechanics",
  "component-reference": "component-reference"
});

const CONTENT_MODULES = Object.freeze([
  BASICS_CONTENT,
  BUILDING_SHIPS_CONTENT,
  ENGINEERING_CONTENT,
  COMBAT_CONTENT,
  SUPPORT_AND_DEFENCE_CONTENT,
  FLEET_OPERATIONS_CONTENT
]);
const MANUAL_ARTICLES_BY_ID = new Map(
  CONTENT_MODULES.flatMap((content) => content.articles).map((article) => [article.id, article])
);
const EXTRA_ARTICLES_BY_ID = new Map(
  CONTENT_MODULES.flatMap((content) => content.extraArticles).map((article) => [article.id, article])
);
const MANUAL_ARTICLE_UPDATES = Object.freeze(Object.assign({}, ...CONTENT_MODULES.map((content) => content.updates)));
const MANUAL_ARTICLE_ORDER = Object.freeze([
  "overview",
  "blueprint-designer",
  "placement-rules",
  "structural-connectivity",
  "engine-exhaust",
  "ship-validation",
  "ship-cost-formula",
  "ship-summary",
  "power",
  "heat",
  "movement",
  "combat",
  "weapons",
  "combat-styles",
  "defence",
  "drones",
  "support",
  "sensors-detection",
  "command",
  "economy",
  "ship-pricing",
  "capture-mechanics",
  "multiplayer",
  "controls",
  "projectile-mechanics",
  "missile-guidance",
  "repair-mechanics",
  "advanced-mechanics",
  "component-reference"
]);
const EXTRA_ARTICLE_ORDER = Object.freeze([
  "targeting-and-arcs",
  "automatic-component-targeting",
  "damage-and-destruction",
  "stations-infrastructure"
]);

function currentManualArticle(article) {
  const update = MANUAL_ARTICLE_UPDATES[article.id];
  return update ? { ...article, ...update } : article;
}

function orderedArticles(order, registry) {
  return order.map((id) => registry.get(id)).filter(Boolean);
}

export function getAllArticles() {
  return [
    ...orderedArticles(MANUAL_ARTICLE_ORDER, MANUAL_ARTICLES_BY_ID).map(currentManualArticle),
    ...orderedArticles(EXTRA_ARTICLE_ORDER, EXTRA_ARTICLES_BY_ID),
    ...generateAllComponentArticles()
  ];
}

export function getArticleById(id) {
  return getAllArticles().find((a) => a.id === id) || null;
}

export function getArticlesByCategory(categoryId) {
  const landingId = CATEGORY_LANDING_ARTICLES[categoryId];
  const articles = getAllArticles().filter((a) => a.category === categoryId);
  if (!landingId) return articles;
  return articles.sort((a, b) => {
    if (a.id === landingId) return -1;
    if (b.id === landingId) return 1;
    if (categoryId === "component-reference") return a.title.localeCompare(b.title);
    return 0;
  });
}

export function getRelatedArticles(article) {
  if (!article || !article.related) return [];
  return article.related
    .map((id) => getArticleById(id))
    .filter(Boolean);
}

export function searchArticles(query) {
  if (!query || !query.trim()) return [];
  const q = query.toLowerCase().trim();
  const terms = q.split(/\s+/);
  const articles = getAllArticles();
  const scored = [];

  for (const article of articles) {
    const haystack = [
      article.title,
      article.summary,
      article.category,
      ...(article.keywords || []),
      article.howItWorks,
      article.practicalUse,
      ...(article.commonProblems || []),
      ...((article.importantStats || []).flatMap((stat) => [stat.label, stat.value].filter(Boolean))),
      ...((article.specialMechanics || []).flatMap((m) => [m.label, m.value, m.detail, m.condition].filter(Boolean))),
      ...((article.requirementsLimitations || []).flatMap((m) => [m.label, m.value, m.detail].filter(Boolean))),
      ...((article.interactions || []).flatMap((m) => [m.label, m.value, m.detail].filter(Boolean))),
      ...((article.conditionalPerformance || []).flatMap((m) => [m.label, m.value, m.detail].filter(Boolean)))
    ].join(" ").toLowerCase();

    let score = 0;
    for (const term of terms) {
      if (article.title.toLowerCase().includes(term)) score += 10;
      if (haystack.includes(term)) score += 1;
    }
    if (score > 0) scored.push({ article, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.article);
}

export function validateArticles() {
  const errors = [];
  const articles = getAllArticles();
  const ids = new Set();
  const categoryIds = new Set(CATEGORIES.map((c) => c.id));

  for (const article of articles) {
    if (!article.id) errors.push(`Article missing id: ${article.title}`);
    if (ids.has(article.id)) errors.push(`Duplicate article id: ${article.id}`);
    ids.add(article.id);
    if (!article.title) errors.push(`Article missing title: ${article.id}`);
    if (!article.category) errors.push(`Article missing category: ${article.id}`);
    if (!categoryIds.has(article.category)) errors.push(`Article ${article.id} has unknown category: ${article.category}`);
    if (article.related) {
      for (const ref of article.related) {
        if (!ids.has(ref) && !getAllArticles().some((a) => a.id === ref)) {
          errors.push(`Article ${article.id} references unknown article: ${ref}`);
        }
      }
    }
  }

  return errors;
}

