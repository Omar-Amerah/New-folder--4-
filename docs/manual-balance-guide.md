# Manual balance guide

`component-balance.json` at the repository root is the only authoritative gameplay balance source. The Netlify build validates it and copies it to `public/component-balance.json`; do not manually edit the generated public copy.

## Sections

- `components`: direct component cost, mass, hull, power, shield, thrust, turning, repair, utility and weapon values; generic component heat is intentionally unsupported.
- `shipPricing`: inputs for the ship-price and per-design fleet-count formulas. The formulas remain in code so future edits change inputs, not implementation.
- `economy`: starting money, income, maximum money, kill/capture rewards and ship cap.
- `rewards`: post-match reward inputs.
- `match`: match score and control-point score values.
- `movement`, `power`, `heat`, `projectiles`, `missileGuidance`, `combatStyles`, `fleetLimits`, `capture`, and `repair`: gameplay inputs used by their named systems when present.

Units are documented in the JSON notes: currency `$`, mass tonnes, hull HP, shield points, seconds, metres, metres/second, radians/second, damage, shots/second, energy, percentages as `0..1` fractions, and multipliers as direct factors.

## Direct values vs formulas

Component entries are direct per-part values. Ship price, fleet count, movement scaling, stacked shield regeneration, stacked repair, and missile turn behaviour still use code formulas with adjustable inputs from `component-balance.json`.

## Validating an edit

Run `npm run balance:check` after editing. Run `npm run build` to refresh the generated frontend copy.

## Readable summary

Run `npm run balance:summary` for a neutral component/economy/reward summary. It prints theoretical weapon DPS as `damage * fireRate`; this is not expected applied damage.

## Comparing changes

Before and after a manual balance edit, run the unit/integration checks and compare representative ship designs in the designer. Missile base damage, tracking strength, projectile speed, firing arc, accuracy and hit rate should be assessed separately because better tracking does not directly equal higher theoretical DPS.

Balance changes should be made through playtesting and review rather than generated automatically: automated outputs cannot judge pacing, readability, counterplay or player intent.
