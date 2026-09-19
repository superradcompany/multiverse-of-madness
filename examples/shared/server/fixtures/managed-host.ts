// HTTP lifecycle fixture only. This does not run a game, VM or model.
import { createServer } from 'node:http';
import { sessionControl } from '../session-control.ts';

const port = Number(process.env.PORT), control = sessionControl(port);
const server = createServer((req, res) => { if (!control.handle(req, res)) { res.writeHead(404); res.end(); } });
await new Promise<void>(done => server.listen(port, '127.0.0.1', done));
control.ready(async () => { await new Promise<void>(done => server.close(() => done())); });
