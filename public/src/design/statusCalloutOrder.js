// Shared deterministic ordering for Blueprint Designer status/callout stacks.
// Keep severity separate from optional within-severity priority so every panel
// follows the same green -> yellow -> red -> neutral information hierarchy.

const SEVERITY_RANK = Object.freeze({
  good: 0,
  ok: 0,
  green: 0,
  warning: 1,
  yellow: 1,
  bad: 2,
  critical: 2,
  red: 2,
  neutral: 3
});

export function calloutSeverityRank(callout) {
  const severity = String(callout?.level || callout?.severity || callout?.tone || "neutral").toLowerCase();
  return SEVERITY_RANK[severity] ?? SEVERITY_RANK.neutral;
}

export function sortStatusCallouts(callouts) {
  return (Array.isArray(callouts) ? callouts : [])
    .map((callout, sourceIndex) => ({ callout, sourceIndex }))
    .sort((left, right) => {
      const severityDifference = calloutSeverityRank(left.callout) - calloutSeverityRank(right.callout);
      if (severityDifference) return severityDifference;
      const priorityDifference = Number(left.callout?.priority || 0) - Number(right.callout?.priority || 0);
      return priorityDifference || left.sourceIndex - right.sourceIndex;
    })
    .map(({ callout }) => callout);
}

const COMPONENT_CATEGORY_RANK = Object.freeze({
  capability: 0,
  condition: 1,
  cost: 2,
  role: 3,
  severe: 4
});

// Component inspectors communicate a richer hierarchy than the Ship Summary:
// useful output, requirements/limits, operating cost, strategic role, danger.
export function sortComponentCallouts(callouts) {
  return (Array.isArray(callouts) ? callouts : [])
    .map((callout, sourceIndex) => ({ callout, sourceIndex }))
    .sort((left, right) => {
      const leftRank = COMPONENT_CATEGORY_RANK[left.callout?.category] ?? COMPONENT_CATEGORY_RANK.role;
      const rightRank = COMPONENT_CATEGORY_RANK[right.callout?.category] ?? COMPONENT_CATEGORY_RANK.role;
      const categoryDifference = leftRank - rightRank;
      if (categoryDifference) return categoryDifference;
      const priorityDifference = Number(left.callout?.priority || 0) - Number(right.callout?.priority || 0);
      return priorityDifference || left.sourceIndex - right.sourceIndex;
    })
    .map(({ callout }) => callout);
}
