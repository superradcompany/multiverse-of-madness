/** Trusted transport only. Domain output validation and outcome measurement stay outside the guest. */
export const executorRunner = `
import { pathToFileURL } from 'node:url';
let input = '';
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
const module = await import(pathToFileURL('/revision/' + process.argv[2]).href);
if (typeof module.default !== 'function') throw new Error('Executor must export a default function');
const value = await module.default(request);
const output = JSON.stringify(value);
if (output === undefined) throw new Error('Executor returned no JSON value');
process.stdout.write(output);
`;
