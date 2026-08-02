// Authoritative client-side palette for the two team identities.
//
// Player colours remain available for individual fleet accents, but team
// indicators must use these values so their meaning does not depend on which
// player is viewing the match.
export const TEAM_COLORS = Object.freeze({
  blue: "#38d5ff",
  red: "#ff5f7e"
});

export function teamColorFor(team) {
  return TEAM_COLORS[team] || null;
}
