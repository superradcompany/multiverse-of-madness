import { build } from 'esbuild';
await build({ entryPoints: ['packages/game-bridge/src/server.ts'], outfile: 'dist/bridge.mjs', bundle: true, platform: 'node', format: 'esm', target: 'node24', banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });

await build({ entryPoints: ['packages/game-bridge/src/engine.ts'], outfile: 'dist/engine.mjs', bundle: true, platform: 'node', format: 'esm', target: 'node24', banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });
