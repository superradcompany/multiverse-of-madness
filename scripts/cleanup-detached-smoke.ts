import './runtime-env.ts';
import { readFile } from 'node:fs/promises';
const { Sandbox } = await import('microsandbox');
const records = JSON.parse(await readFile('.cache/detached-smoke.json', 'utf8'));
for (const record of records) {
  const h = await Sandbox.get(record.id);
  if (h.id !== record.identity) throw new Error('identity mismatch');
  await h.destroy();
}
