import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Build a source snapshot without local node_modules/dist, then consume its real
// tarball outside the checkout. This must not resolve imports through the app.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const temporary = await mkdtemp(join(tmpdir(), 'gameplay-harness-package-'));
const source = join(temporary, 'source'), consumer = join(temporary, 'consumer');
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run this check with npm run check:package');
const npm = (args: string[], cwd: string, capture = false) => run(process.execPath, [npmCli, ...args], cwd, capture);

async function run(command: string, args: string[], cwd: string, capture = false): Promise<string> {
  console.log(`package check: ${command} ${args.join(' ')}`);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', capture ? 'pipe' : 'inherit', 'inherit'] });
    let output = '';
    child.stdout?.on('data', chunk => { output += String(chunk); });
    child.once('error', reject);
    child.once('close', (code, signal) => code === 0 ? resolve(output) : reject(new Error(`${command} failed (${signal ?? code})`)));
  });
}

try {
  await mkdir(source); await mkdir(consumer);
  for (const path of ['src', 'test', 'scripts', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json', 'README.md', 'ADAPTERS.md']) {
    await cp(join(root, path), join(source, path), { recursive: true });
  }
  await npm(['ci', '--no-audit', '--no-fund'], source);
  await npm(['run', 'check'], source);
  const packed = JSON.parse(await npm(['pack', '--json', '--silent'], source, true)) as Array<{ filename: string; files: Array<{ path: string }> }>;
  assert.equal(packed.length, 1);
  const archive = packed[0]!;
  for (const entry of ['dist/index.js', 'dist/index.d.ts', 'dist/node/index.js', 'dist/node/index.d.ts', 'ADAPTERS.md']) {
    assert.ok(archive.files.some(file => file.path === entry), `Archive is missing ${entry}`);
  }
  assert.ok(archive.files.every(file => !file.path.startsWith('node_modules/') && !file.path.startsWith('src/')), 'Archive must use compiled exports');
  const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8')) as { devDependencies: Record<string, string> };
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module',
    dependencies: { '@multiverse/gameplay-harness': `file:${join(source, archive.filename)}` },
    devDependencies: { typescript: manifest.devDependencies.typescript, '@types/node': manifest.devDependencies['@types/node'] },
  }));
  await cp(join(root, 'scripts/package-consumer.ts'), join(consumer, 'consumer.ts'));
  await writeFile(join(consumer, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true,
    noUncheckedIndexedAccess: true, skipLibCheck: false, types: ['node'], outDir: 'compiled',
  }, include: ['consumer.ts'] }));
  await npm(['install', '--ignore-scripts', '--no-audit', '--no-fund'], consumer);
  await run(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'], consumer);
  await run(process.execPath, ['compiled/consumer.js'], consumer);
  console.log('Package check passed: clean install, core checks, packed declarations, and external ESM execution.');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
