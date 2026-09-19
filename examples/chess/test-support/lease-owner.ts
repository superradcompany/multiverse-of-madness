// Ownership fixture only: no game host, model or VM is started.
import { acquireChessDataLease } from '../data-lease.ts';

await acquireChessDataLease(process.argv[2]!);
process.send?.({ ready: true });
setInterval(() => {}, 1000);
