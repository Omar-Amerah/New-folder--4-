// Fleet Ledger public facade. Existing callers continue importing this module.
// Authoritative value resolution lives in content/resolvedContentValues.js
// (including shared repairRules), while componentArticles.js uses the shared
// weaponPresentationRules for generated weapon rows.

import {
  CATEGORIES,
  LEDGER_RULE_CONTRACTS,
  SPECIAL_MECHANICS_COMPONENTS,
  getAllArticles,
  getArticleById,
  getArticlesByCategory,
  getRelatedArticles,
  searchArticles,
  validateArticles
} from "./content/index.js";

export {
  CATEGORIES,
  LEDGER_RULE_CONTRACTS,
  SPECIAL_MECHANICS_COMPONENTS,
  getAllArticles,
  getArticleById,
  getArticlesByCategory,
  getRelatedArticles,
  searchArticles,
  validateArticles
};
