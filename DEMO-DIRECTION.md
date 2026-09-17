# demo direction: outcome memory and suspense

Brainstormed with Claude Code on 2026-09-17. This is a proposal, not a
payload migration. The existing Doom demo remains intact.

## Current constraint and shortlist

The user requires an existing game. Building a custom encounter or game is ruled
out; the earlier encounter sketch below describes desired properties only.
After another Claude discussion, the shortlist is:

- **Into the Breach:** strongest conceptual fit for visible tactical decisions.
  Subset Games confirms that enemy attacks are telegraphed. State/control access
  and sandbox execution have not been verified.
- **Brogue CE:** first open-source candidate to investigate. Upstream confirms
  that graphical tiles ship with the game. Readable telemetry and controllable
  stepping remain unverified; C source does not automatically imply a ready WASM
  port or compatibility with the Doom adapter.

Sources: https://www.subsetgames.com/itb.html and https://github.com/tmewett/BrogueCE.
No game migration has started. The TypeScript application and microsandbox
orchestration will be reused around whichever existing engine is qualified.

## Earlier encounter sketch (not a custom-game proposal)

A small, tile-rendered tactical encounter is the strongest next candidate.
Claude initially proposed a full roguelike; after discussion of visual density
and integration cost, it narrowed the recommendation to a single encounter.

Imagine a room with two approach routes, three visibly different enemies, a
limited turn budget, and three consumables: fire, freeze, and teleport. Several
plans are plausible. Some enemy properties are initially unknown to the agent,
but observable from the results of its actions. Keep the map, starting resources
and world rules fixed within a comparison.

The suspense comes from not knowing which plan works, not from secretly changing
the world between attempts. A failed future might show low fire damage against
one enemy or reveal that spending teleport early leaves no escape. Record those
measurements as evidence; one low damage roll does not prove fire resistance.

Checkpoint before the decision, try real alternatives, retain their measured
outcomes outside the game, restore, and show whether the next choices change.
No successful outcome should be scripted or promised. An honest clip can show
that memory did not help. Matched memory-on/off comparisons are still required
before claiming improved performance.

## Alternatives and objections

- **Train dispatch:** Claude's runner-up. Junction decisions and looming
  collisions are legible; the memory story may reduce to schedule optimization.
- **Platformer:** readable and familiar, but a fixed obstacle can look like
  memorized jump timing. Multiple paths and resource trade-offs would help.
- **Real service recovery:** the strongest developer/product demonstration.
  Fork a broken stateful service, try bounded repairs under load, preserve
  outcomes, and restore. The visual hook needs deliberate design.
- **Doom:** existing infrastructure works, but aiming, hidden geometry and
  short-lived action feedback make its behavior difficult to read.

Two cautions from reviewing Claude's suggestions: determinism is useful but not
required for valid experiments, and snapshots do not imply a game lacks its own
save system. Identical inputs from identical captured RNG state can legitimately
produce identical outcomes. Different actions, not injected luck, should explain
the divergence shown in the demo.

Before choosing an engine, verify structured telemetry, bounded stepping,
licensing, readable rendering and restoration of live process state. The current requirement is to reuse a pre-existing game. Present the general
execution capability honestly rather than claiming an existing game cannot
serialize its own state.

## What is implemented now

The optional **learn from attempts** mode in Doom supplies bounded, context-matched
observed action outcomes to Jev. Outcomes include discarded worlds and persist
outside the VMs. This is input context, not model-weight training. The UI exposes
the observations supplied to the main decision. Retained executable checkpoint
trees and long-range backtracking are not implemented by this option.
