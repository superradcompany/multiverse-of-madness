import test from 'node:test';
import assert from 'node:assert/strict';
import { DoomEngine } from '../../../packages/game-bridge/src/engine.ts';
import { geometryFor, DoomMap } from './doom-geometry.ts';
import { reachableRoute } from './doom-route.ts';
import { candidatePlans, startPlan, planInputs } from './doom-plans.ts';
const initial = async () => ({ ...(await DoomEngine.load('assets/wasmdoom.wasm','assets/freedoom1.wad')).state(),x:0,y:0,z:0,angle:0,enemies:[],pickups:[],keyPickups:[],keys:[] });
test('E1M2 lock remains a factual barrier without creating a key objective',async()=>{
 const s={...await initial(),map:2,x:1207.9837646484375,y:-207.9403839111328,z:-8};
 const locked=await geometryFor(s,true,true),unlocked=await geometryFor({...s,keys:['red']},true,true);
 assert.equal(locked.clearance(s,0,128),0);assert.ok(unlocked.clearance(s,0,128)>32);
 assert.ok(locked.observe(s).nearbyLocks.some(l=>l.requiredKey==='red'&&l.keyOwned===false));
 assert.ok(candidatePlans(s,locked).every(p=>p.id!=='key-route'&&p.id!=='unlock-route'));
 const path=reachableRoute(s,locked,p=>p.y < -1100);
 assert.ok(path.length);assert.ok(path.some(p=>p.z>s.z));assert.ok(path[0]!.x<=s.x);
});
test('ordinary open-then-cross plans still advance after the use interval',async()=>{
 const s=await initial(),target={kind:'point' as const,x:40,y:0,z:0};
 const run=startPlan({id:'use-cross',label:'open and cross',steps:[{kind:'use',target,label:'open',maxTicks:35},{kind:'move',target:{...target,x:120},label:'cross',maxTicks:140}]},s,210);
 assert.deepEqual(planInputs(run,s,[],new DoomMap([])),['use']);
 assert.deepEqual(planInputs(run,{...s,tick:s.tick+35},[],new DoomMap([])),['forward','use']);
 assert.equal(run.step,1);
});
