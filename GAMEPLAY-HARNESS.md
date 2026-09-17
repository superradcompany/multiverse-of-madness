# Gameplay harness: performance controls

This is the tuning map for Multiverse of Madness and the starting design for a
harness that can support other games. The current implementation is a Doom
adapter, not yet a game-independent engine. **Runtime** below means an existing
session control; **code** means changing a default or policy in TypeScript;
**proposed** means an interface we still need to build.

Implementation order: extract the generic harness first, then add optional
central-model supervision to that extracted harness. Supervision is a planning
requirement here, not a request to add model plumbing or controls to the current
Doom UI. Provider and model selection remain undecided.

The objective is measured gameplay improvement: completing tasks, surviving,
scoring, or learning a reliable route within a compute budget. High model
confidence by itself is not a performance objective.

## The decision loop

1. Observe the world, resources, threats, current route statistics and recent results.
2. Generate feasible candidate plans using the game's mechanics and observations.
3. Ask Jev to select among those candidates, with the user guide and relevant experience.
4. Execute directly or fork alternatives according to the uncertainty/stall policy.
5. Advance each plan using observed conditions and interrupt it when invalidated.
6. Compare observed outcomes after the shared trial budget. Promote one complete world state.
7. Retain its route, recordings and world-local memory. Keep failed-attempt evidence separately.
8. Retry or restore a checkpoint when the recovery policy calls for it.

There are two different choices: Jev chooses a proposed plan; the outcome scorer
chooses the winning tested future. A good prompt cannot compensate for a missing
candidate, and a good candidate cannot compensate for a scorer that rewards the
wrong outcome.

## High-level tuning inventory

Defaults describe fresh sessions, not overrides in an existing saved run. Doom
uses 35 game ticks per second. Game time excludes model/network/snapshot latency.

| Control | Current behavior and access | Performance effect / what to inspect |
| --- | --- | --- |
| User guide / objective | **Runtime:** Guide the AI, default `survive and reach the exit`; request text capped at 1,000 characters. Applied to all live decision questions. | State a goal and tradeoffs. Contradictory requirements such as rapid progress and zero exposure can encourage avoidance. The guide is an instruction, not an enforced guarantee. |
| Observation coverage | **Code:** bridge reports health, armor, ammo, equipped weapon, map counters, position, nearby entities; static WAD geometry supplements them. | Missing walls, inventory, affordances or visibility can make sensible choices impossible. Inspect the exact observations before tuning prompts. |
| Candidate plan library | **Code:** `doom-plans.ts`, `doom-tactics.ts`; feasibility filters and bounded execution steps. | Determines what the model can attempt. Missing interaction or resupply strategies cannot be fixed by changing confidence. |
| Candidate menu size / variety | **Code:** `doomPlanPolicy.maxCandidates = 10`; one per available goal family before extra variants. | More coverage can help, but redundant choices consume context and split probabilities. This cap is separate from future count. |
| Decision style | **Runtime:** plans (default) or single actions. | Plans carry a goal through conditional steps; action mode reasks after a fixed input interval. Compare them under the same budget. |
| Confidence threshold | **Runtime:** default 0.75, range 0–1; fork below the threshold. Manual comparisons and stalled-progress comparisons can also fork. | Higher thresholds generally spend more simulation work. Measure quality versus cost; confidence is distribution concentration, not survival probability. |
| Number of futures | **Code:** Session constructor `branches = 4`; up to four available ranked plans, with fewer when fewer are available. Retry offsets rotate candidates. | Breadth versus latency/VM budget. The count is not proportional to confidence. Candidate-menu variety does not guarantee diverse top-ranked futures. |
| Trial / comparison duration | **Runtime:** default 6 game seconds, range 1–60. Captured at batch start. | Longer trials expose delayed consequences but cost more and slow feedback. Short trials can undervalue turning, opening doors or collecting equipment. |
| Fixed action interval | **Runtime:** default 1 game second, range 0.2–6, for single-action mode. | Long holds overshoot and miss events. **This is not a periodic Jev timer in plan mode.** Plans reask on completion/interruption, within the remaining trial horizon. |
| Plan completion and interruption | **Code:** alignment, arrival, target outcome/loss, ammo exhaustion, death/map change, damage of 8 health, nearby new threat, obstruction and step deadlines. | Too eager: repeated judgments and abandoned goals. Too slow: unsafe commitment or wall-sticking. Measure interrupt reasons and useful completed plans. |
| Motor assistance | **Code:** per-tick aiming/fire checks and collision recovery in `doom-controls.ts` / `doom-navigation.ts`; human inputs bypass it. | Separates mechanical control failures from strategic decisions. It can alter the requested inputs; record interventions when evaluating the model. |
| Outcome score and hard rejection rules | **Code:** `outcomeScore` in `session.ts`; **runtime:** recovery settings below. | Defines what “best” means. A guide alone does not rewrite score weights. Use outcome objectives that agree with the guide. |
| Experience enabled | **Runtime:** off by default; enable learn from attempts. | Previous failed and successful trials can inform future judgments; this supplies context, not model weight training. |
| Stored attempts / supplied attempts | **Runtime:** defaults 128 stored and 2 per decision; ranges 8–1,024 and 1–8. Input budget may reduce supplied count. | Storage, retrieval relevance and prompt size are distinct controls. Increasing capacity does not imply more relevant evidence is sent. |
| Memory matching and aging | **Code:** `experience.ts` uses map, position, height, heading, health, ammo availability and enemy context. | Narrow matching loses relevant experience; broad matching applies advice to different situations. Experience is shared; physical world observations are not. |
| Exploration memory | **Code:** selected route's visited 128×128×32 cells; bounded static search to new space. | Reduces repeated-room wandering. A new cell is a proxy for progress, not proof of discovering a useful route. |
| Pickup memory | **Code:** per-world, 64 locations, 60-game-second age limit; map changes/reliable absence invalidate records. | Supports returning toward resources. Old locations are hints requiring re-observation. Forks and rollback restore the corresponding world's memory. |
| Stalled-progress comparison | **Code:** force alternatives after 10 game seconds without recorded progress, even at high confidence. | Escape confident loops. Different games need their own definition and duration of stalled progress. |
| Retry / rollback | **Runtime:** opt-in; defaults two retries, health-loss threshold 15, no-progress threshold 15 seconds. Retry range 0–10, health loss 1–100, stall 5–120 seconds. | Trades discarded simulation for avoiding a poor selected route. Counts batches, not individual model calls. After exhausting retries, rollback pauses for review. |
| Checkpoint cadence / retention | **Code:** when recovery enabled, initial checkpoint, then healthy progress at least 30 selected game seconds apart; retain three selectable points. Manual capture/restore also available. | Too sparse loses useful recovery opportunities; too frequent costs snapshot time/storage. Ancestor artifacts remain while retained descendants need them. |
| Playback / pacing | **Runtime:** winner review delay defaults to 0, range 0–60 wall-clock seconds. **Code:** pace approximately 35 ticks/second. | Presentation latency differs from strategy horizon. Viewer changes should not change simulated outcomes. |
| Model and request budget | **Environment:** `TYPESAFE_DEFAULT_MODEL`; **code:** request construction, 10-second timeout, no SDK retries, bounded evidence. | Measure full state + instructions + candidate criteria, latency, token usage, invalid outputs and service errors. The state-size guard alone is not a full request token budget. |
| Central supervisor | **Proposed, after harness extraction:** independently configurable model/provider, review triggers, evidence window, intervention scope, cooldown and cost budget. | Detect strategic loops and missing prerequisites that the fast decision model does not resolve. Evaluate whether interventions produce sustained progress, not just different actions. |
| Recordings and VM cleanup | **Environment:** discarded recordings default to 1,024 MiB / 24 hours / 200 worlds. Selected ancestry retained until explicit restart. **Code:** root-layer compaction at 64 layers. | Sustained operation and replay completeness. Selected footage can exceed the discarded-cache budget; GC must preserve checkpoints/ancestry still in use. |

Source locations: [session loop](apps/server/src/session.ts),
[decision envelope](apps/server/src/decision-context.ts), [Jev questions](apps/server/src/jev.ts),
[attempt memory](apps/server/src/experience.ts), [game bridge](packages/game-bridge/src/engine.ts),
[run statistics](apps/server/src/run-stats.ts), [recordings](apps/server/src/recordings.ts).

## Plan library and adapter tuning

Jev ranks code-built plans. It does not generate new mechanics or arbitrary routes.
Each plan has two or three bounded conditional steps. A route may be a prefix;
finishing it triggers another observation/decision within the same trial budget.

| Plan family | Generated when | Completion / limitation |
| --- | --- | --- |
| Engage an enemy | Plausible unblocked target, usable equipped weapon | Face, approach if needed, attack; target tracking is approximate without stable actor IDs. |
| Attack while strafing | Ranged weapon, target at least 64 units away, lateral clearance | Keep moving and correct aim; fire only when aligned. Stop if side clearance disappears or ammo runs out. |
| Recover health | Useful observed pickup with a plausible direct route | Face and collect; do not assume nearby means reachable. |
| Resupply / equipment | Useful observed ammo, armor, recovery powerup, or weapon upgrade from basic equipment | Uses resource thresholds. Full weapon ownership is unknown, so upgrade selection is conservative. |
| Collect a key | An observed key with a plausible direct route | Collects an observed key as an ordinary candidate. Inventory and nearby lock requirements are supplied as facts; no mandatory key subgoal is assigned. |
| Interact with a door/switch | Supported static use-line, approachable from its front side | Approach, face and pulse use, then re-observe. Static geometry cannot confirm an already activated switch. Locks without the required key, and dangerous/unsupported specials, are excluded. |
| Try the exit | Nearby supported normal/secret use-exit line | Approach and use; actual phase/map transition establishes success. This is not a global key/exit solver and does not cover every walk-over exit. |
| Explore / leave explored space | Local openings or a bounded route toward unvisited cells | Follow waypoints; dynamic doors, floors and actors may invalidate static route hints. |
| Withdraw / move toward cover | Escape clearance or a route toward a point occluded from an enemy | A route prefix is not yet cover; cover from one enemy is not safety from all threats. |
| Approach from another angle | Nearby wall-occluded enemy and a static route toward a possible firing angle | Navigate, then re-observe before attacking. No firing through the obstruction. |
| Return toward a known pickup | Useful remembered resource, valid age/map, navigable progress toward it | Recheck availability on arrival; never insert a remembered pickup into live telemetry. |

[`doom-plan-policy.ts`](apps/server/src/doom-plan-policy.ts) groups the new adapter
knobs: menu cap 10; direct pickup/interaction radius 384; use distance 48; use
attempt budget 35 ticks; strafe clearance 64 and duration 70 ticks; tactical search
radius 384, step 64, expansion limit 128, at most two waypoints; low-ammo targets
100 bullets / 25 shells / 150 cells / 25 rockets. Pickup-memory bounds live in
[`doom-pickup-memory.ts`](apps/server/src/doom-pickup-memory.ts).

Other existing code knobs remain in `doom-plans.ts`: 7-degree aim tolerance,
105-tick face deadline, 140-tick movement/attack deadline, 8-health damage
interrupt, 160-unit new-threat distance, and conservative entity matching.
The frontier search has its own 640-unit radius and 160-node budget. These values
are Doom-specific; they should become adapter profile fields before claiming
cross-game configurability. These are defaults to evaluate, not calibrated optima.

Pickup observations are capped at 16. A missing record is invalidated within the
observation radius only when the list is not full; otherwise absence is ambiguous.
Memory is copied on fork, persisted with the session, restored with checkpoints,
and bounded by capacity and age. Older saved sessions initialize it from current
observations; they cannot recover pickup locations that were never recorded.

## What currently wins a comparison

Current score, for a living future:

- Level exit: +100,000; death: fixed −1,000,000.
- Health delta: ×30 for survival priority, otherwise ×10.
- Kills: ×150 for combat priority, otherwise ×40.
- New cells: ×12 for exploration priority, otherwise ×3.
- Item-counter gains: ×10; secrets: ×100; net ammo-count change: ×0.1.

Recovery, when enabled, ranks acceptable outcomes before unacceptable ones.
Movement through known space alone earns no score. The current score does not
explicitly value armor gain, key possession, weapon upgrades or successful switch
activation. Some pickups do not increment Doom's item counter. Net resource deltas
also hide simultaneous gains and expenditures. **These are important scoring gaps
when evaluating the expanded plans**, not evidence that Jev chose badly.

For a generic harness, the adapter should emit meaningful outcome events and
metrics (e.g. key acquired, obstacle opened, objective stage completed). The
profile should select weights and hard constraints independently of the prompt.
Score changes require matched evaluation; increasing a reward can encourage farming
that metric at the expense of finishing the game.

## Proposed generic harness boundary

Keep orchestration generic and mechanics in a versioned game adapter:

- **Harness:** budgets, uncertainty routing, trial orchestration, cancellation,
  promotion, recovery, persistence, experience retrieval and replay retention.
- **Game adapter:** observe, generate candidates, execute/check plan steps,
  translate actions, detect progress/terminal outcomes, measure outcomes and expose
  snapshot/restore capabilities. State which observations are known, inferred,
  stale or unavailable.
- **Policy profile:** objective and constraints; allowed plan families; observation
  budget; model/question version; confidence policy; trial breadth/duration;
  outcome weights; memory matching/capacity; interruption and recovery thresholds.
- **Optional supervisor, added after extraction:** a separately configurable
  reasoning model that reviews progress across decisions and trials, diagnoses
  failure, and proposes bounded strategy changes through harness interfaces.

A future `PlanDefinition` should declare stable ID/version, required capabilities,
eligibility, parameters, executor, success/failure conditions, interrupt conditions,
max game duration and side effects. Each candidate should include its concrete
target, evidence age and expected measurable benefit. Every adapter must include a
bounded fallback when no goal is feasible; it must not invent a successful route.

Use seconds/events at the generic boundary; each adapter maps to its own ticks or
turns. A turn-based game may fork at a move; an action game may execute per frame.
Games without clonable state must declare that limitation rather than pretending
an input replay is an exact snapshot.

Proposed configuration precedence: harness defaults → adapter defaults → named
experiment profile → session overrides. Validate overrides on the backend; save
the resolved profile and its version with decisions/checkpoints/replays. Log which
settings take effect immediately versus at the next decision or batch. This
configuration system is a design target, not an implemented API.

## Extraction sequence and later supervision

Current boundary: the adapter reports key inventory, nearby lock requirements and
failed interactions. It does not automatically set a find-key goal, reserve a
comparison slot for that goal, or award a special route-following bonus. The user
guide remains the objective. Strategic diagnosis and temporary subgoals belong
to the configurable supervisor described below, which is not yet implemented.

**Phase 1: extract the generic harness.** Separate lifecycle, branching,
comparison, recovery, memory, replay and policy configuration from Doom mechanics.
Define adapter contracts for observations, capabilities, plans, progress and
outcomes. Keep Jev behind a replaceable decision-model interface. Preserve the
current Doom behavior as a baseline; verify that the core can run against a
minimal non-Doom test adapter without importing Doom types or assuming 35 ticks
per second. Reserve review/intervention events in the design, without connecting
an LLM yet.

**Phase 2: add central-model supervision to the extracted harness.** Introduce a
separate supervisor-model interface, then provider integrations and policy
configuration. The fast decision model handles local choices; the supervisor
checks whether the overall strategy is working. Model selection for these two
roles must be independent. No provider, model or numerical threshold is selected
by this plan.

**Phase 3: evaluate the combined system.** Compare the same adapter and scenarios
with supervision off and on under matched total budgets. Add presentation controls
only when the consuming application needs them; the harness must work without a
UI. Extraction, supervisor plumbing and UI work are distinct deliverables.

### What the supervisor needs to diagnose

The motivating failure is repeatedly trying a locked door without recognizing
that acquiring a key is a prerequisite. Repeatedly forking the same ineffective
approach does not fix that. The supervisor should be able to distinguish:

- An execution problem: the chosen action did not run as intended.
- A strategic problem: the action ran but cannot advance the objective yet.
- An observation gap: inventory, lock requirements or interaction results are
  unavailable, so the cause cannot be established.
- A capability gap: the needed strategy or action is absent from the adapter.

For the door example, it could identify the prerequisite, establish a temporary
subgoal to obtain the matching key, and check that the agent returns to the door
after acquisition. If the harness cannot observe or execute those steps, it
should surface that limitation. An LLM cannot compensate for missing adapter
capabilities merely by giving better advice.

### Supervisor configuration points

All entries below are proposed controls for the extracted harness.

| Parameter | What it controls |
| --- | --- |
| Enabled, provider, model and model settings | Which reasoning model supervises; independent of the fast decision model. |
| Review triggers | Lack of progress, repeated failed approaches, repeated prerequisite failures, poor trial outcomes, periodic checks and explicit review requests. |
| Time and repetition thresholds | When to escalate; distinguish game time, wall time and decision/attempt counts. A loop can persist while little game time advances. |
| Evidence and history budget | Current objective, capabilities, resources/inventory, recent actions, failed trials, interaction feedback, score components and earlier interventions. |
| Coordination scope | Session-wide strategy versus advice for one branch; whether review happens before a batch, after comparison or at an interruptible execution boundary. |
| Intervention authority | Temporary subgoals, preference or exclusion of feasible strategies, requests for further exploration or observations, and escalation to a human. Any recovery authority must be explicit. |
| Advice lifetime and invalidation | When a subgoal ends, expires or becomes stale after a guide change, map transition, rollback, takeover or contradictory observation. |
| Cost and latency limits | Review cadence, cooldown, concurrency, token/call budgets, timeouts and retry policy. |
| Failure policy | What happens when the supervisor is unavailable, uncertain, contradicts the objective or repeatedly fails to improve progress. |
| Audit and evaluation | Model/configuration version, evidence considered, diagnosis, proposed/applied intervention, and subsequent measured outcome. |

The user objective remains authoritative. Supervisor advice should be recorded
separately, applied through validated adapter capabilities, and checked against
actual progress. Preserve prerequisite subgoals across trials until their success
or invalidation conditions are met. Share lessons from failed futures while
keeping physical facts branch-local: a key acquired in a discarded future is not
owned by the main session.

The core should support this supervision contract for any game. Doom-specific
concepts such as key colors and door types belong in its adapter's facts and
capabilities, not in the central orchestration logic.

## How to evaluate a change

1. Freeze game build, map/scenario, starting checkpoint, model version, candidate
   library version, guide, resolved settings and randomness where controllable.
2. Use separate tuning and held-out scenarios: combat, scarce resources, blocked
   routes, interaction puzzles and level completion. Include several starting states.
3. Compare one policy change at a time with matched game-time **and** compute
   budgets. Count all simulated futures and rollbacks, not just the selected run.
4. Measure completion rate, task score, deaths, damage, kills, resources, useful
   progress rate, repeated-area time, wall-stall time and time to finish. Also record
   model calls/tokens/latency, fork cost, total simulated seconds and storage use.
5. Inspect exact candidates, exclusions, selected plans, probability distributions,
   interrupt reasons, controller overrides, score components and supplied experience.
6. Report variability and failures. Recalibrate confidence routing when the menu,
   model, observations or guide changes. Several good alternatives can produce low
   confidence. A threshold is not a correctness guarantee.

Baseline comparisons: direct model play; current fixed actions; conditional plans;
forking without experience; forking with experience; then rollback. This separates
what the model, controller, search and memory each contribute.

## Validation and limitations

Focused tests cover conditional execution, interaction front sides and use pulses,
resource eligibility, moving combat, occluded routes, bounded menus and pickup
memory invalidation. `npm run typecheck` and `npm test` check the application.

`node --import tsx scripts/tactical-plans-smoke.ts` creates isolated real VMs,
executes two 70-tick plan futures and checks source isolation and saved pickup
memory, using deterministic candidate selection. It does not call Jev or establish
higher win rates. The live user's session is not used by this check. It also steers one child
independently and verifies the source and sibling remain unchanged.

`node --env-file=.env --import tsx scripts/plan-jev-smoke.ts` checks one live
model request on a separate local engine, without modifying the running session.

Validation on 2026-09-17: typecheck and all 84 tests passed; the isolated two-VM
check passed; a live plan request succeeded with `jev-1.13.0`. These are functional
checks, not gameplay-quality benchmarks.

Performance qualification remains separate: new strategies are available, but
there is no held-out evidence yet that this expanded library improves completion
or score. The current observation contract still lacks stable actor IDs, exact
line of sight, complete inventory and live switch/door state.

Design references: TypeSafe's [Choice](https://docs.typesafe.ai/primitives/choice)
and [confidence](https://docs.typesafe.ai/confidence) contracts;
classic Doom [use-line behavior](https://github.com/id-Software/DOOM/blob/master/linuxdoom-1.10/p_switch.c).
