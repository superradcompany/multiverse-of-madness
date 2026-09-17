# Jev game calibration, 2026-09-17

The game-aware controller reduces blocked firing and stalled movement. It is not a highly accurate level-solving agent yet. No evaluated run completed E1M1. These changes improve the state, choices and controller around Jev; they do not train or fine-tune Jev's weights.

## What changed

- The backend reads the pinned Freedoom WAD. Inputs include nearby static barrier distances and enemy/pickup occlusion through solid map geometry. Fixed floor and ceiling openings contribute to these checks.
- Tagged sectors and sectors behind special lines are conservatively treated as dynamic. Targets across these openings are uncertain, and automatic firing avoids them. This does not read the live positions of moving doors/lifts or implement the engine's complete visibility test.
- The model sees semantic pickup/enemy names, relative bearing and height, the previous action, recent movement, projectiles, resources, and bounded related attempts when experience is enabled.
- Known-obstructed movement choices, repeated failed forward movement, and unsupported stationary firing are excluded from the current Choice. Excluded choices cannot be selected as alternate futures. Raw model confidence is preserved; omitted options have zero preference.
- A TypeScript motor controller checks current state every tick, preserves movement intentions, stops a requested turn on a plausibly aligned target, and fires only with plausible aim through geometry not known blocked or dynamically uncertain. These are explicit controller rules, not model predictions. Human takeover bypasses them.
- New game bridges report the current weapon. Existing detached bridges and recordings remain readable; missing weapon telemetry is explicitly unknown.
- Decision details disclose the map checks and assistance. The existing 75% confidence gate remains experimental, not a measured probability of survival.

## Evaluation protocol

Pinned engine and WAD hashes are in `assets/README.md`. Actual Jev requests used the existing server credential and reported `jev-1.13.0`. All application and evaluation work is TypeScript. No game health/ammo/enemy state was edited.

Development started with 48 reproducible engine checkpoints split by input trajectory, measuring every action from matched states. The existing short-horizon score is only a proxy: it rewards displacement even when that displacement does not help reach the exit. It was not accepted as a high-accuracy metric. Clearer prompt wording alone increased confidence without improving that proxy. Eight alternative profiles were explored on development starts; their code is retained in `scripts/calibration/lab-jev.ts` for reproducibility.

The selected profile was frozen before six held-out opening sequences were run with both the baseline and game-aware controller. Each has a 60-second game-time budget, one Jev decision per second, and no future selection or experience feedback. The evaluator advances the same WASM engine headlessly on the host. It is actual game execution, but **not sandbox execution or a VM performance benchmark**.

An initial harness checked death only at decision boundaries, potentially allowing the held `use` input to restart Doom before the next check. Those results in `artifacts/calibration/` are exploratory and invalid for survival claims. The authoritative protocol-2 runs under `artifacts/calibration/validated/` stop at the exact death tick, with the same frozen profile and starts. Every authoritative recorded input sequence was replayed and reproduced every observed decision-boundary game state exactly.

## Held-out results

Six matched starts per controller; maximum 60 seconds each, stopping immediately on death.

| Measure | Original baseline | Game-aware |
| --- | ---: | ---: |
| Alive at 60 seconds | 6 / 6 | 4 / 6 |
| Level exits | 0 / 6 | 0 / 6 |
| Engine kill-counter increases | 2 | 8 |
| Visited spatial cells, summed across runs | 34 | 158 |
| Movement decisions with less than 8 units of displacement | 305 | 17 |
| Ammunition spent | 85 | 51 |
| Ammo spent with only wall-blocked targets ahead | 54 | 2 |
| Ammo spent without a plausibly aligned enemy | 31 | 2 |

Cells are 128×128 horizontal units and 32 vertical units. They measure coverage, not a route to the exit. Counts are totals, not rates: the game-aware runs had less total game time because two ended in death. The baseline largely stayed stuck and avoided encounters, so survival alone is misleading. The new controller explores more but still makes dangerous decisions. The small set is one map and difficulty, not a statistically strong generalization result.

Ammo metrics come from the tick-by-tick replay audit, not coarse per-decision resource differences. A weapon may discharge after its input was released. Alignment uses a 6-degree horizontal bound and a plausible vertical angle; it does not prove a hit. Static vertical sight uses an approximate target column; it is not engine-exact line of sight. Dynamic doors, weapon spread, other actors and projectile ownership remain limitations.

## Does comparing futures help?

A diagnostic follow-up used the unchanged 75% gate, four candidates, six-second trials, one-second model feedback, and no experience feedback on the two held-out starts where the game-aware controller died alone. Both continued to 62 seconds of selected gameplay, because the last six-second trial crossed the 60-second cutoff:

| Start | Standalone outcome | With future comparison |
| --- | --- | --- |
| Left turn / advance | Died at 27.14 s | Alive, health 102, 0 kills |
| Wait 3 s | Died at 22.29 s | Alive, health 95, 3 kills |

Each diagnostic made 2 direct decisions and 10 uncertainty forks. Neither reached the exit. This follow-up uses real engine execution with deterministic input replay to construct identical experimental starts, not VM cloning. It is a diagnostic on selected failure cases, not another independent held-out accuracy estimate. The separate real-VM smoke checks the production fork/reconnect/promotion path.

## Reproduce

```sh
# Requires assets and the existing TypeSafe server credential in .env.
npm run evaluate:game -- baseline heldout
npm run evaluate:game -- game-aware heldout
npm run audit:game
npm run evaluate:policy
npm run smoke:session
```

Completed evaluation files are reused. Preserve/move the relevant output files before intentionally rerunning a model comparison. Model responses can vary across requests. Raw states, decisions and outcomes are in the ignored `artifacts/calibration/` directory; they contain no API credentials. Exploratory prompt comparisons use `scripts/calibration/evaluate.ts` and `lab-jev.ts`.

`JEV_PROFILE=game-aware` is the server default. `JEV_PROFILE=baseline` explicitly restores the original input/prompt/controller for comparisons; restarting the backend preserves detached worlds and recordings. The new mode does not require clearing a live run. Changing timing, map, skill, model version, action set, experience use or controller requires reevaluation.

## Remaining work for high accuracy

The next substantive gaps are live door/lift geometry, reliable navigation toward the exit, weapon-specific aiming and encounter-level strategy. A static map can conservatively rule out some shots but cannot establish complete current visibility. The short-horizon comparison score still rewards displacement rather than true route progress. Do not label confidence as accuracy or claim the demo reliably finishes the level from these results.
