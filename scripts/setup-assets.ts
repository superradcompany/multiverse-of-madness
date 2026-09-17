import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
const files = [
  ['wasmdoom.wasm', 'https://themagicalkarp.github.io/wasmdoom/wasmdoom.wasm', 'caa3d9152830738325d0b0b2b1448c4cef25edeed1e3a5f979f6c7bbfada1683'],
  ['freedoom1.wad', 'https://raw.githubusercontent.com/theMagicalKarp/wasmdoom/dd321b50b89b5085698cfbf2ff01b2f741da8206/wads/freedoom1.wad', '7323bcc168c5a45ff10749b339960e98314740a734c30d4b9f3337001f9e703d'],
] as const;
await mkdir('assets', { recursive: true });
for (const [name, url, digest] of files) {
  let data = await readFile(`assets/${name}`).catch(() => null);
  if (!data || createHash('sha256').update(data).digest('hex') !== digest) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Download ${name}: HTTP ${response.status}`);
    data = Buffer.from(await response.arrayBuffer());
    if (createHash('sha256').update(data).digest('hex') !== digest) throw new Error(`${name}: checksum mismatch`);
    await writeFile(`assets/${name}`, data);
  }
  console.log(`verified ${name}`);
}
