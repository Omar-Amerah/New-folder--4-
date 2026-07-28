# Five-commit correctness audit

Audited range: `d38f49d6c6cf89232abe6aadb46acfb00973e909..52e58b40bc1fb02eaa7cb81e43fddf8cd2f2fc5e`.

## Change-to-presentation matrix

| State change | Authoritative invalidation | Required presentation |
| --- | --- | --- |
| Phase | `phaseChanged` | deployment controls, lobby, side controls, match status |
| Current player Ready | `currentPlayerReadyChanged` | deployment controls, player/economy status |
| Money/income | `economyChanged` | economy HUD, purchase availability |
| Relay ownership | `relaysChanged` | relay HUD, economy HUD/income, match status |
| Ship membership/death | `fleetChanged` | fleet HUD, groups, selection |
| Shield | `selectedShipShieldChanged` / renderer snapshot | selected vitals, ship renderer |
| Component HP | `selectedShipDamageChanged` | damage overlay, hull renderer |
| Heat | `selectedShipHeatChanged` | Heat HUD, selected Heat overlay |
| Power | `selectedShipPowerChanged` | selected Power overlay |
| Wiring/protection | `selectedShipWiringChanged` / `selectedShipProtectionChanged` | selected Power wiring/protection overlay |
| Team/name/connection | `playersChanged` / `currentPlayerTeamChanged` | lobby/player status, team HUD, deployment controls |
| Winner | `winnerChanged` | match status, end screen |
| Latency | `pong` | latency HUD only |

DOM writes remain diffed. Catalogue/design analysis remains cached; deployment validation uses the shared blueprint-analysis cache.

## Regression attribution

- `36596d0` activated `movementCore.js` in production and introduced the selective snapshot/UI invalidation, template prebuild, and Power metadata reuse boundaries.
- The stale `maxShield`/`rechargeRate` Shield adapter existed at the baseline but became runtime-active only when `36596d0` delegated production movement to `movementCore.js`.
- `36596d0` mixed a new `Float64Array` activity cache with the older `Array.isArray` validity test and treated an empty consumer-index cache as missing.
- `afd6c77` added phase diagnostics; its caller-side increment caused double counting.
- `fd1a8d4` hardened compact phase fallback but did not add deployment-control invalidation.

## Preserved optimizations

Selective presentation, diffed DOM writes, blueprint analysis caching, prebuilt ship templates, Power-demand coalescing, partial spatial-index rebuilds, renderer identity caches, and movement/path caches remain in place.
