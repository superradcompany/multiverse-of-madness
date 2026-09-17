# uncertainty routing: first measured comparison

2026-09-17, Apple Silicon macOS, Jev service, real microsandbox VMs.
Reproduce with `npm run evaluate:routing`; raw observations and confidence values
are written to `artifacts/routing-evaluation.json`.

Each policy starts from identical engine state in each of three scenarios. The
scenarios are the opening state and two further checkpoints separated by 105
ticks of forward/use. They were fixed before measuring results. Each policy gets
210 game ticks, with a decision every 35 ticks. The uncertainty gate is 0.75;
always-branch tests four actions every round. Execution order rotates by scenario.

| Policy | Final health by scenario | New kills by scenario | Fork batches | Total simulated ticks |
| --- | --- | --- | --- | --- |
| Jev alone | 102, 85, 77 | 1, 0, 0 | 0 | 630 |
| Uncertainty gate | 104, 104, 95 | 0, 1, 0 | 16 | 2,310 |
| Always branch | 104, 104, 95 | 0, 0, 0 | 18 | 2,520 |

Mean measured wall time per run was 2.20 s for Jev alone, 8.03 s with the
uncertainty gate, and 8.26 s with always branching. These exclude initial setup
and include inference, captures, simulation, frames and cleanup.

All nine final runs completed their game-time budget without an error and stayed
alive. The gate avoided two of eighteen possible fork batches, saving about 8%
of simulated ticks versus always branching. It still used about 3.7 times the
simulation work of Jev alone. Simulated ticks are a work proxy, not measured CPU
time or billing. Branching preserved more health here, but did not dominate every
metric: Jev alone killed an enemy in the first scenario while the alternatives did not.

The first attempt encountered service 529 overload errors and its incomplete
outcomes were excluded. The repeated run allows at most two overload retries
after 2/4 seconds and includes any waiting in elapsed wall time. Independent Jev
requests can vary, even from matching starts. This is not a deterministic model
comparison or a statistical claim.

These short 35-tick trials isolate routing behavior; the live demo now explores
six seconds with a fresh Jev decision each second. No claim is made that this
small evaluation validates that longer horizon or establishes 0.75 as optimal.
There are only three opening situations on one map, and all policies survived.
Displacement is not proof of exit progress. More varied encounters and repeated
runs are needed before making an efficacy or threshold-calibration claim.
