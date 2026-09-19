# Gameplay harness

A TypeScript harness for trying alternate futures, comparing outcomes, and
continuing from the best result. Jev makes gameplay decisions; an optional
supervisor improves strategies in the background.

One repository contains the harness, Microsandbox executor, supervisor providers,
and two examples: **Doom (Multiverse of Madness)** and **chess**.

## Try it

Requires **Node.js 24+** and a **TypeSafe/Jev API key**. Doom also needs Apple
Silicon macOS or a Linux host with KVM; the demo has been tested on Apple Silicon.

```sh
git clone git@github.com:superradcompany/multiverse-of-madness.git
cd multiverse-of-madness
npm ci
cp .env.example .env
```

Add your key to `.env` as `TYPESAFE_API_KEY=...`, then choose an example:

```sh
npm run demo:doom     # http://localhost:4317
npm run demo:chess    # http://localhost:4321
```

Run each command in its own terminal to try both together. Setup/build steps run
automatically; Doom's first launch downloads the engine assets and VM runtime.
Both start paused. Press **Play/Resume** in the browser. Refreshing preserves the
session; use **Restart/New game** to start over.

Background supervision additionally needs an authenticated Codex or Claude CLI.
See the [Doom guide](examples/doom/README.md) or [chess guide](examples/chess/README.md)
for enabling it, configuration and troubleshooting.

## Inside

- [`harness/`](harness/README.md): reusable experiment and learning core.
- [`packages/executor-microsandbox/`](packages/executor-microsandbox/README.md): isolated code execution.
- `packages/supervisor-*`: Codex and Claude integrations.
- [`examples/doom/`](examples/doom/README.md) and [`examples/chess/`](examples/chess/README.md): game adapters, backends and viewers.

Doom runs inside real VMs. Chess boards use a local engine; its optional learning
code runs in isolated VMs. The examples demonstrate the workflow, not proven
competitive playing strength.

For a new game, start with the [adapter guide](harness/ADAPTERS.md).
See [architecture](docs/ARCHITECTURE.md), [saved sessions](docs/SESSIONS.md) and
[verification](VERIFICATION.md) for current behavior and limitations.
