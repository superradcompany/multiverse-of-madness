import { createServer } from 'node:http';
import { DoomEngine } from './engine.ts';
import { stepSchema } from '../../contracts/src/game.ts';

const game = await DoomEngine.load(process.env.DOOM_WASM ?? '/game/wasmdoom.wasm', process.env.DOOM_WAD ?? '/game/freedoom1.wad');
// No timer: the host advances explicit ticks. An idle bridge is a safe fork point.
const server = createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/frame') {
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
      res.end(game.frame());
      return;
    }
    let result;
    if (req.method === 'GET' && req.url === '/state') result = game.state();
    else if (req.method === 'POST' && req.url === '/step') {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 4096) throw new Error('Request too large');
      }
      result = game.step(stepSchema.parse(JSON.parse(body)));
    } else { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/json', 'connection': 'close' });
    res.end(JSON.stringify(result));
  } catch (error) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Game error' }));
  }
});
// Guest-local only; the host reaches it through fresh agent exec requests.
server.listen(8766, '127.0.0.1', () => console.log('game bridge ready'));
