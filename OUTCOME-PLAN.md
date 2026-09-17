# Improving Doom outcomes

Current evidence is in CALIBRATION.md: the game-aware controller reduced wall firing and increased exploration/kills in six matched 60-game-second starts, but reached zero exits and survived four of six. This remains inadequate for a claim that it reliably completes a level. Snapshot retry/rollback is a recovery mechanism; no new accuracy or win-rate claim follows from implementing it.

## Highest-value next experiments

1. **Persistent navigation:** select an explicit reachable frontier, pickup, door or exit waypoint, then keep it until reached or invalidated. Local movement and raw displacement reward revisiting corridors. Spatial novelty helps detect loops but is not a navigation graph. Evaluate completion rate and time-to-exit, not only survival.
2. **Live engine visibility and weapon control:** export current dynamic door/lift openings and the engine's target trace, and expose usable weapon/ammunition information. Static WAD geometry is conservative around dynamic openings. Test shots that hit and damage per ammunition spent; distinguish a model choosing badly from an impossible action or motor-controller mistake.
3. **Event-driven feedback:** shorten the action when a threat appears, a shot fails, the player takes damage or movement stalls; lengthen safe traversal. Compare equal simulated-time and model-call budgets, including latency. Faster sampling everywhere can merely add inference pauses.
4. **Encounter-level futures:** test meaningful plans such as taking cover, reaching a medkit or clearing a room, rather than only rotating the first button combination. Keep progress/health budgets explicit and carry failed attempts back as observed evidence. Longer horizons cost more and should be evaluated, not assumed better.
5. **Matched evaluation:** freeze map/WAD, engine, skill, initial state, action set, model version, game-time limit, candidate budget and score. Compare the baseline, current controller, future selection, then recovery, on held-out starts. Report exits, deaths, main-timeline kills, health, ammo efficiency, unique coverage, rollbacks, all-world simulated time and wall-clock/model cost. Do not count discarded-future kills as success or reset the evaluation clock after a rollback.

The current app keeps cumulative attempt time even after rollback; a future recovery benchmark must cap that total as well as the selected timeline. Otherwise unlimited retries can make eventual survival appear deceptively strong. Recovery thresholds are configurable and currently uncalibrated.

## Why an online Doom score may not match

[ViZDoom's official scenarios](https://vizdoom.farama.org/environments/default/) define different maps, action spaces, rewards and time limits. Basic is a one-monster aiming task; Deathmatch rewards combat in an arena; Deadly Corridor rewards approaching an objective. Their scores are not a universal Doom rating. Our demo uses a Freedoom campaign map and seeks its exit, with structured engine observations and explicit motor assistance.

[Arnold](https://github.com/glample/Arnold) is a trained deep-reinforcement-learning Doom agent with training/evaluation maps and game-feature prediction. [Direct Future Prediction](https://github.com/isl-org/DirectFuturePrediction) trains policies for specified scenarios and optimizes predicted measurements. These differ from a general typed-judgment model asked to choose among eight actions at runtime. They show that much stronger gameplay is possible, but do not establish a like-for-like numerical comparison without matching the environment and compute/training budget.
