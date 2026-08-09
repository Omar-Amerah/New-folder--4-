# Data Links balance verification

The Data Links reference fixtures exercise the player-facing mechanic directly:
one source to one weapon, one source split across four weapons, multiple sources
stacking on a weapon, redundant source coverage, and isolated links.

The runtime checks use the production component Power and Heat lifecycle. They
verify that an inactive, destroyed, or overheated source loses its contribution
without changing the saved link list, and that deterministic repeated runs keep
the same effective weapon profiles.

The designer checks use the same explicit link pairs and confirm that each
weapon receives its allocated share rather than the source's unsplit budget.

Generate the deterministic report with:

```sh
npm run balance:data-support
```
