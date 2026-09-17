import './runtime-env.ts';
import { Sandbox } from 'microsandbox';
import { upgradeBridge } from '../apps/server/src/bridge-upgrade.ts';
import { SandboxGame } from '../apps/server/src/sandbox-game.ts';
const name=process.argv[2];if(!name)throw new Error('sandbox name required');
const sandbox=await(await Sandbox.get(name)).connect();
await upgradeBridge(sandbox);
const game=new SandboxGame(sandbox);const state=await game.state();console.log(JSON.stringify({tick:state.tick,keys:state.keys,events:state.progressEvents}));await game.close();
