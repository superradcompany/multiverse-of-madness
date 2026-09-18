import { acquireDataLease } from '../src/data-lease.ts';

await acquireDataLease(process.argv[2]!);
process.send?.('ready');
// Keep the fixture alive independently of the unreferenced lease socket.
setInterval(() => {}, 1000);
