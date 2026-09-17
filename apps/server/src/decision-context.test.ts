import test from 'node:test';
import assert from 'node:assert/strict';
import type { TypeSafeClient } from '@typesafe-ai/sdk';
import { DoomEngine } from '../../../packages/game-bridge/src/engine.ts';
import { decisionStatistics, withDecisionContext } from './decision-context.ts';
import { initialStats } from './run-stats.ts';
import { Jev } from './jev.ts';
import { ExperienceMemory } from './experience.ts';

test('every live question shares the current statistics and primary guide in plans and action modes', async () => {
  const game = await DoomEngine.load('assets/wasmdoom.wasm', 'assets/freedoom1.wad'), state = game.state();
  const skills = [{ id: '4f86d319-f385-4895-90a1-956ebcfb9b99', name: 'Health first', instructions: 'Collect health before fighting.', enabled: true }, { id: '0f86d319-f385-4895-90a1-956ebcfb9b99', name: 'Disabled tactic', instructions: 'Must not reach Jev', enabled: false }];
  const stats = initialStats(state); stats.kills = 9; stats.damage = 18; stats.ticks = 350;
  for (const profile of ['game-aware', 'baseline'] as const) for (const planTicks of [undefined, 210]) {
    let request: any;
    const client = { systemOne: async (body: any) => {
      request = body;
      const answers = Object.fromEntries(Object.entries(body.questions).map(([key, question]: [string, any]) => {
        const ids = Object.keys(question.criteria), choice = ids[0];
        return [key, { choice, confidence: .8, probabilities: Object.fromEntries(ids.map(id => [id, id === choice ? 1 : 0])) }];
      }));
      return { model: 'test', answers };
    } } as unknown as Pick<TypeSafeClient, 'systemOne'>;
    const result = await new Jev(profile, client).decide(state, 'Collect health before combat.', [], new AbortController().signal, [], 35, { skills, planTicks, stats: decisionStatistics(state, stats), visited: stats.visited });
    assert.deepEqual(request.state.skills, skills.filter(s => s.enabled).map(({ enabled, ...s }) => s));
    assert.deepEqual(result.evidence?.skills, request.state.skills);
    for (const q of Object.values(request.questions) as any[]) assert.match(JSON.stringify(q.instructions), /Apply relevant instructions from `skills`/);
    assert.equal(request.state.objective, 'Collect health before combat.');
    assert.deepEqual(request.state.stats.current.ammo, { bullets: 50, shells: 0, cells: 0, rockets: 0 });
    assert.equal(request.state.stats.current.armor, state.armor);
    assert.equal(request.state.stats.route.kills, 9);
    assert.equal(request.state.stats.route.damage, 18);
    for (const q of Object.values(request.questions) as any[]) assert.match(JSON.stringify(q.instructions), /primary user guide/);
    assert.equal(result.evidence?.stats.route.kills, 9);
  }
});

test('memory capacity and retrieval limit are configurable independently', async () => {
  const state = (await DoomEngine.load('assets/wasmdoom.wasm', 'assets/freedoom1.wad')).state();
  const memory = new ExperienceMemory(); memory.setCapacity(16);
  for (let i = 0; i < 40; i++) memory.remember(`w${i}`, 'explore', state, { ...state, tick: state.tick + 35 });
  assert.equal(memory.records.length, 16); assert.equal(memory.relevant(state, 8).length, 8);
  assert.equal(memory.relevant(state, 1).length, 1);
  memory.setCapacity(8); assert.equal(memory.records.length, 8);
  assert.throws(() => memory.setCapacity(0)); assert.throws(() => memory.relevant(state, 9));
  const context = withDecisionContext({}, state, 'guide '.repeat(166), undefined, memory.relevant(state, 8));
  assert.equal(context.experienceUsed, 8);
  assert.ok(JSON.stringify(context.input).length <= 5000);
});
test('Jev gets lock evidence without a mandated key subgoal', async () => {
  const state={...(await DoomEngine.load('assets/wasmdoom.wasm','assets/freedoom1.wad')).state(),map:2,x:1207.98,y:-207.94,z:-8,keys:[],progressEvents:[{kind:'locked' as const,key:'red' as const,tick:35}]};
  let request:any;
  const client={systemOne:async(body:any)=>{
    request=body;
    return {model:'test',answers:Object.fromEntries(Object.entries(body.questions).map(([key,q]:[string,any])=>{
      const ids=Object.keys(q.criteria),choice=ids.find(id=>id.startsWith('explore'))??ids[0];
      return [key,{choice,confidence:.9,probabilities:Object.fromEntries(ids.map(id=>[id,id===choice?1:0]))}];
    }))};
  }} as unknown as Pick<TypeSafeClient,'systemOne'>;
  const result=await new Jev('game-aware',client).decide(state,'Explore other rooms.',[],new AbortController().signal,[],35,{planTicks:210});
  assert.equal(request.state.objective,'Explore other rooms.');
  assert.equal('navigationObjective' in request.state,false);
  assert.deepEqual(request.state.stats.current.keys,[]);
  assert.deepEqual(request.state.stats.current.recentInteractions,state.progressEvents);
  assert.ok(request.state.nearbyLocks.some((l:any)=>l.requiredKey==='red'&&!l.keyOwned));
  assert.doesNotMatch(JSON.stringify(request.questions),/continue that persistent key|key-route|unlock-route/);
  assert.ok(result.plans?.selected.startsWith('explore'));
});
