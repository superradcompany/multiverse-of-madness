# multiverse of madness

This is a standalone TypeScript application, separate from the microsandbox repository.

- Use `.agents/skills/typesafe-ai/SKILL.md` for TypeSafe/Jev work. Read its live documentation before changing integration contracts.
- Keep credentials server-side, out of logs, browser bundles, and sandbox snapshots.
- The backend owns world roles, lifecycle, controller ownership, and input arbitration.
- Do not present simulated tests or replayed frames as real sandbox execution.
- Preserve `design/` as the reviewed reference while implementing the real application.
- Run type checking and relevant tests. Real branching changes also require the VM smoke test.
