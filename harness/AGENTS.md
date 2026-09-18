# Gameplay harness

- Keep the core independent of games, model providers, VM runtimes and UIs.
- Use TypeScript with explicit interfaces. Domain observations, commands and
  experience features remain typed adapter parameters, not optional Doom fields.
- Node filesystem/media implementations belong under `src/node`; the core uses
  ports. Public exports live in the entrypoints; avoid circular runtime imports.
- Preserve persisted artifacts. Version formats and qualify old artifacts before
  changing them. Never disguise replay as an exact execution checkpoint.
- Every long-running operation needs cancellation, a budget and an owner for
  cleanup. Preserve the source world until a replacement is durably selected.
- Keep independent acceptance metrics outside supervisor-editable revisions.
- Run `npm run check`; integration and game-quality claims need separate evidence.
- Do not publish or push without explicit user instruction.
