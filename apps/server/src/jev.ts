import type { PreviousPlanFeedback } from './plan-feedback.ts';
import { jevGuidance, learnedInstructions, learnedState, type JevLearning } from './jev-learning.ts';
import { activeSkills, type AiSkill } from '../../../packages/contracts/src/skills.ts';
import type { PickupMemory } from './doom-pickup-memory.ts';
import { decisionStatistics, withDecisionContext, guideInstructions, type DecisionStatistics } from './decision-context.ts';
import { bearingTo, candidatePlans, type RankedPlan, type GamePlan } from './doom-plans.ts';
import type { VersionRef } from '@multiverse/gameplay-harness';
import { choice, TypeSafeClient, type SystemOneRequest, type ChoiceQuestion } from '@typesafe-ai/sdk';
import { geometryFor } from './doom-geometry.ts';
import { z } from 'zod';
import { feedbackState, feedbackInstructions } from './doom-context.ts';
import type { Experience } from './experience.ts';
import type { EntityObservation } from '../../../packages/contracts/src/entity.ts';
import type { GameState, Input } from '../../../packages/contracts/src/game.ts';
import type { DoomPolicy } from './doom-policy.ts';

export const actions = {
  advance: { label: 'push forward', inputs: ['forward', 'use'] },
  left: { label: 'turn left and move', inputs: ['left', 'forward'] },
  right: { label: 'turn right and move', inputs: ['right', 'forward'] },
  retreat: { label: 'retreat and fire', inputs: ['backward', 'fire'] },
  strafeLeft: { label: 'strafe left and fire', inputs: ['strafeLeft', 'fire'] },
  strafeRight: { label: 'strafe right and fire', inputs: ['strafeRight', 'fire'] },
  fire: { label: 'hold position and fire', inputs: ['fire'] },
  wait: { label: 'wait briefly', inputs: [] },
} satisfies Record<string, { label: string; inputs: Input[] }>;
export type ActionId = keyof typeof actions;
export type Priority = 'survival' | 'exploration' | 'combat';
/** Latest consumed request only, retained server-side for supervisor diagnosis. */
export interface JevDecisionTrace {
  tick: number; episode: number; map: number;
  request: SystemOneRequest<Record<string, ChoiceQuestion>>;
  model: string; selected: string; confidence: number; priority: Priority;
  probabilities: Record<string, number>;
  plans?: GamePlan[];
}
export interface Decision {
  jevTrace?: JevDecisionTrace;
  selectedExperience?: Experience[];
  preparation?: { revision: VersionRef; historyIndices: number[]; experienceIndices: number[]; features: Record<string, string | number | boolean>; planIds: string[] };
  usage?: { inputTokens: number; outputTokens: number };
  evidence?: { planningAhead?: DecisionContext['planningAhead']; workingGuide?: string; previousPlan?: PreviousPlanFeedback; skills?: Array<Omit<AiSkill, "enabled">>; objective: string; stats: DecisionStatistics; experienceUsed: number };
  plans?: { selected: string; candidates: RankedPlan[] };
  action: ActionId;
  probabilities: Record<ActionId, number>;
  confidence: number;
  priority: Priority;
  latencyMs: number;
  waitMs?: number;
  prefetched?: boolean;
  model: string;
  experienceUsed?: number;
  perception?: { profile: 'game-aware'; blockedEnemies: number; uncertainTargets: number; forwardBarrier: number; movementFailed: boolean; excludedActions: ActionId[] };
}
export interface DecisionContext { previousPlan?: PreviousPlanFeedback; policy?: DoomPolicy; skills?: AiSkill[]; previousAction?: string; planTicks?: number; stats?: DecisionStatistics; visited?: string[]; pickups?: PickupMemory;
  experiencePool?: Experience[];
  /** An observed current plan, not a predicted future game state. */
  planningAhead?: { plan: string; target: GamePlan['steps'][number]['target']; remainingTicks: number };
  /** Only host-validated preparation output; browser/model responses cannot populate this directly. */
  prepared?: { revision: VersionRef; plans?: GamePlan[]; features: Record<string, string | number | boolean> };
}
const preparationContext = <T extends object>(base: T, context?: DecisionContext) => ({
  ...base,
  ...(context?.planningAhead ? { planningAhead: context.planningAhead } : {}),
  ...(context?.previousPlan ? { previousPlan: structuredClone(context.previousPlan) } : {}),
  ...(context?.prepared ? { prepared: { revision: context.prepared.revision, features: context.prepared.features,
    scope: 'Derived suggestions from versioned learning code, not observed facts. Current state, stats, objective and user skills remain authoritative.' } } : {}),
});
export interface DecisionMaker {
  decide(state: GameState, objective: string, history: GameState[], signal: AbortSignal, experience?: Experience[], actionTicks?: number, context?: DecisionContext): Promise<Decision>;
}
const probability = z.number().min(0).max(1);
const tokenUsage = z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() })
  .transform(value => ({ inputTokens: value.input_tokens, outputTokens: value.output_tokens }));
const actionIds = Object.keys(actions) as [ActionId, ...ActionId[]];
const answerSchema = z.object({
  action: z.enum(actionIds), confidence: probability,
  probabilities: z.record(z.enum(actionIds), probability),
  priority: z.enum(['survival', 'exploration', 'combat']),
});

export function decisionState(state: GameState, objective: string, history: GameState[], experience: Experience[] = [], actionTicks = 35) {
  const round = (n: number) => Math.round(n * 10) / 10;
  const player = (s: GameState) => ({ tick: s.tick, health: s.health, armor: s.armor, ammo: s.ammo, kills: s.kills, items: s.items, position: [round(s.x), round(s.y), round(s.z)], heading: round(s.angle) });
  const entity = (e: EntityObservation) => ({ type: e.engineType, health: e.health, distance: round(e.distance), bearing: round(e.relativeBearing), heading: round(e.heading), towardPlayer: round(e.towardPlayerAlignment), z: round(e.position.z) });
  const input = {
    objective,
    actionDurationSeconds: actionTicks / 35,
    player: player(state),
    velocity: Object.fromEntries(Object.entries(state.velocity).map(([k, n]) => [k, round(n)])),
    enemies: state.enemies.slice(0, 6).map(entity),
    projectiles: state.projectiles.slice(0, 8).map(entity),
    pickups: state.pickups.slice(0, 6).map(entity),
    omitted: { enemies: Math.max(0, state.enemies.length - 6), projectiles: Math.max(0, state.projectiles.length - 8), pickups: Math.max(0, state.pickups.length - 6) },
    relatedAttempts: experience.slice(0, 3).map(e => ({
      action: e.action, start: { position: [round(e.start.x), round(e.start.y), round(e.start.z)], heading: round(e.start.angle), health: e.start.health, ammoAvailable: e.start.ammo },
      observed: e.result,
    })),
    experienceContext: experience.length ? 'Observed attempts from nearby states, including discarded futures. These are evidence, not rules: geometry, enemies, timing and resources may differ. Health/kills/ammo are changes over the stated tick duration. No movement alone does not prove an action is always blocked.' : '',
    recentPlayerStates: history.slice(-4).map(player),
    mechanics: 'Freedoom, 35 ticks/sec. Each action lasts actionDurationSeconds of game time. Positive bearing means left. Distances/headings are from engine state. towardPlayer is heading alignment (+1 toward, -1 away), not predicted collision; ownership, walls, height and homing may matter. Proximity is not visibility. Units: world units, degrees, velocity per tick. Unchanged position suggests obstruction.',
  };
  while (JSON.stringify(input).length > 5000 && input.relatedAttempts.length) input.relatedAttempts.pop();
  return input;
}

export type JevProfile = 'baseline' | 'game-aware';
export class Jev implements DecisionMaker {
  private readonly learning?: JevLearning;
  constructor(private readonly profile: JevProfile = 'game-aware', private readonly client: Pick<TypeSafeClient, 'systemOne'> = new TypeSafeClient({ timeout: 10_000, retry: { maxRetries: 0 } }), learning?: JevLearning) {
    if (learning) {
      if (!learning.model.trim() || learning.model.length > 128) throw new Error('Invalid Jev model identity');
      this.learning = { model: learning.model, guidance: jevGuidance(learning.guidance) };
    }
  }
  async decide(state: GameState, objective: string, history: GameState[], signal: AbortSignal, experience?: Experience[], actionTicks = 35, context?: DecisionContext): Promise<Decision> {
    const started = performance.now();
    const map = this.profile === 'game-aware' ? await geometryFor(state, true, true) : undefined;
    const aware = map ? feedbackState(state, objective, history, map, actionTicks, experience, context?.previousAction) : undefined;
    if (aware && map && context?.planTicks && state.phase === 'level') return this.decidePlan(state, aware, map, context.planTicks, signal, started, context, experience ?? []);
    const { input, experienceUsed } = withDecisionContext(preparationContext(aware ?? decisionState(state, objective, history, [], actionTicks), context), state, objective, context?.stats, experience ?? [], context?.skills);
    const criteria = aware ? feasibleActions(aware) : Object.fromEntries(Object.entries(actions).map(([id, a]) => [id, a.label]));
    const request = {
      ...(this.learning ? { model: this.learning.model } : {}),
      state: learnedState(input, this.learning?.guidance),
      questions: {
        action: choice(learnedInstructions({ ...feedbackInstructions, guide: guideInstructions }, 'action', this.learning?.guidance), criteria),
        priority: choice(learnedInstructions(`${guideInstructions} Which single priority best advances the user guide from these current statistics?`, 'priority', this.learning?.guidance), {
          survival: 'Preserve life and recover health, avoid damage before pursuing other goals',
          exploration: 'Discover new space and reach the level exit while staying alive',
          combat: 'Defeat enemies while staying alive',
        }),
      },
    };
    const capturedRequest = structuredClone(request);
    const result = await this.client.systemOne(request, { signal });
    const parsed = answerSchema.parse({ action: result.answers.action.choice, confidence: result.answers.action.confidence,
      probabilities: Object.fromEntries(actionIds.map(id => [id, result.answers.action.probabilities[id] ?? 0])), priority: result.answers.priority.choice });
    if (!(parsed.action in criteria)) throw new Error('Jev selected an unavailable action');
    const sum = Object.values(parsed.probabilities).reduce((a, b) => a + b, 0);
    if (Math.abs(sum - 1) > 0.02) throw new Error('Jev returned an invalid probability distribution');
    return { ...parsed, jevTrace: { tick: state.tick, episode: state.episode, map: state.map, request: capturedRequest,
      model: result.model, selected: parsed.action, confidence: parsed.confidence, priority: parsed.priority, probabilities: { ...parsed.probabilities } }, usage: tokenUsage.parse(result.usage), latencyMs: performance.now() - started, model: result.model,
      experienceUsed, evidence: { planningAhead: context?.planningAhead, workingGuide: this.learning?.guidance.prompts.guide, previousPlan: context?.previousPlan, skills: activeSkills(context?.skills ?? []), objective, stats: context?.stats ?? decisionStatistics(state), experienceUsed },
      perception: aware ? { profile: 'game-aware', blockedEnemies: aware.blockedEnemyCount,
        uncertainTargets: aware.targetsNotBehindSolidWalls.filter(e => e.visibility === 'dynamic-opening-unknown').length,
        forwardBarrier: aware.movement.barrierDistances.ahead, movementFailed: aware.movementFailed,
        excludedActions: actionIds.filter(id => !(id in criteria)) } : undefined };
  }
  private async decidePlan(state: GameState, input: ReturnType<typeof feedbackState>, map: Awaited<ReturnType<typeof geometryFor>>, ticks: number, signal: AbortSignal, started: number, context: DecisionContext, experience: Experience[]): Promise<Decision> {
    const plans = context.prepared?.plans ?? candidatePlans(state, map, context.visited, context.pickups);
    const criteria = Object.fromEntries(plans.map(p => [p.id, `${p.label}${p.evidence ? ` (${p.evidence})` : ''}: ${p.steps.map(s => `${s.label} (at most ${s.maxTicks / 35}s)`).join(' → ')}. ${p.novelty === undefined ? '' : p.novelty > 0 ? 'Leads toward unvisited space. ' : 'Returns to already visited space. '}Target ${Math.round(Math.hypot(p.steps[0]!.target.x - state.x, p.steps[0]!.target.y - state.y))} units away, bearing ${Math.round(bearingTo(state, p.steps[0]!.target))} degrees (+left, -right).`]));
    const envelope = withDecisionContext(preparationContext({ ...input, trialSeconds: ticks / 35 }, context), state, input.objective, context.stats, experience, context.skills);
    const request = { ...(this.learning ? { model: this.learning.model } : {}), state: learnedState(envelope.input, this.learning?.guidance), questions: {
      plan: choice(learnedInstructions(`${guideInstructions} Which available conditional plan best advances the objective within trialSeconds? Steps end on observed conditions. Code handles immediate collision recovery and aiming. The plan is interrupted on significant damage, a new nearby threat, lost target, or a time limit. Prefer feasible useful progress; map clearance does not guarantee reachability.`, 'plan', this.learning?.guidance), criteria),
      priority: choice(learnedInstructions(`${guideInstructions} Which priority best advances the user guide from these current statistics?`, 'priority', this.learning?.guidance), { survival: 'Preserve life and recover health', exploration: 'Explore and reach the exit', combat: 'Defeat enemies while surviving' }),
    } };
    const capturedRequest = structuredClone(request);
    const result = await this.client.systemOne(request, { signal });
    const selected = result.answers.plan.choice;
    if (!plans.some(p => p.id === selected)) throw new Error('Jev selected an unavailable plan');
    const candidates = plans.map(p => ({ ...p, probability: probability.parse(result.answers.plan.probabilities[p.id] ?? 0) }));
    if (Math.abs(candidates.reduce((n, p) => n + p.probability, 0) - 1) > .02) throw new Error('Jev returned an invalid plan distribution');
    // Legacy action fields project the opening turn; plan probabilities remain
    // authoritative and are what the session displays and branches on.
    const opening = (p: RankedPlan): ActionId => { const angle = bearingTo(state, p.steps[0]!.target); return angle > 7 ? 'left' : angle < -7 ? 'right' : 'advance'; };
    const probabilities = Object.fromEntries(actionIds.map(id => [id, candidates.filter(p => opening(p) === id).reduce((n, p) => n + p.probability, 0)])) as Record<ActionId, number>;
    return { action: opening(candidates.find(p => p.id === selected)!), probabilities,
      jevTrace: { tick: state.tick, episode: state.episode, map: state.map, request: capturedRequest, model: result.model,
        selected, confidence: probability.parse(result.answers.plan.confidence), priority: z.enum(['survival', 'exploration', 'combat']).parse(result.answers.priority.choice),
        probabilities: Object.fromEntries(candidates.map(plan => [plan.id, plan.probability])), plans: structuredClone(plans) }, usage: tokenUsage.parse(result.usage),
      plans: { selected, candidates }, confidence: probability.parse(result.answers.plan.confidence), priority: z.enum(['survival', 'exploration', 'combat']).parse(result.answers.priority.choice),
      latencyMs: performance.now() - started, model: result.model, experienceUsed: envelope.experienceUsed, evidence: { planningAhead: context?.planningAhead, workingGuide: this.learning?.guidance.prompts.guide, previousPlan: context.previousPlan, skills: activeSkills(context.skills ?? []), objective: input.objective, stats: context.stats ?? decisionStatistics(state), experienceUsed: envelope.experienceUsed } };
  }

}

export function feasibleActions(input: ReturnType<typeof feedbackState>) {
  return Object.fromEntries(Object.entries(actions).filter(([id]) => {
    if (id === 'advance' && (input.movement.forwardBlocked || (input.movementFailed && input.previousAction === actions.advance.label))) return false;
    if (id === 'wait' && input.movementFailed) return false;
    if (id === 'retreat' && input.movement.backwardBlocked) return false;
    if (id === 'strafeLeft' && input.movement.leftBlocked) return false;
    if (id === 'strafeRight' && input.movement.rightBlocked) return false;
    if (id === 'fire' && !input.targetsNotBehindSolidWalls.some(e => Math.abs(e.bearing) <= 6 && e.visibility !== 'dynamic-opening-unknown')) return false;
    return true;
  }).map(([id, a]) => [id, `${a.label}. Movement intent; motor control steers around blocked movement, stops aiming turns on a target, and only fires while a target is plausibly aligned and not behind a known solid wall.`]));
}
