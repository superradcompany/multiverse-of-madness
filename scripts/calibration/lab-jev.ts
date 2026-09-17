// Frozen exploratory profiles, retained only for reproducing the calibration comparisons.
import { choice, TypeSafeClient } from '@typesafe-ai/sdk';
import { geometryFor } from '../../apps/server/src/doom-geometry.ts';
import { z } from 'zod';
import { groundedState, groundedInstructions, groundedCriteria, spatialInstructions, tacticalState, tacticalInstructions, feedbackState, feedbackInstructions } from '../../apps/server/src/doom-context.ts';
import type { Experience } from '../../apps/server/src/experience.ts';
import type { EntityObservation } from '../../packages/contracts/src/entity.ts';
import type { GameState, Input } from '../../packages/contracts/src/game.ts';

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
export interface Decision {
  action: ActionId;
  probabilities: Record<ActionId, number>;
  confidence: number;
  priority: Priority;
  latencyMs: number;
  model: string;
  experienceUsed?: number;
}
export interface DecisionContext { previousAction?: string }
export interface DecisionMaker {
  decide(state: GameState, objective: string, history: GameState[], signal: AbortSignal, experience?: Experience[], actionTicks?: number, context?: DecisionContext): Promise<Decision>;
}
const probability = z.number().min(0).max(1);
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

export type LabProfile = 'baseline' | 'grounded' | 'spatial' | 'tactical' | 'assisted' | 'feedback' | 'calibrated' | 'calibrated-v2' | 'calibrated-v3' | 'calibrated-v4';
export class LabJev implements DecisionMaker {
  constructor(private readonly profile: LabProfile = 'baseline') {}
  private readonly client = new TypeSafeClient({ timeout: 10_000, retry: { maxRetries: 0 } });
  async decide(state: GameState, objective: string, history: GameState[], signal: AbortSignal, experience?: Experience[], actionTicks = 35, context?: DecisionContext): Promise<Decision> {
    const started = performance.now();
    const calibratedInput = this.profile.startsWith('calibrated') && this.profile !== 'calibrated-v4' ? feedbackState(state, objective, history, await geometryFor(state, this.profile === 'calibrated-v2' || this.profile === 'calibrated-v3', this.profile === 'calibrated-v3'), actionTicks, experience, context?.previousAction) : undefined;
    const input = calibratedInput ?? (this.profile === 'feedback' ? feedbackState(state, objective, history, await geometryFor(state), actionTicks, experience, context?.previousAction) : (this.profile === 'tactical' || this.profile === 'assisted' || this.profile === 'calibrated-v4') ? tacticalState(state, objective, history, await geometryFor(state), actionTicks, experience) : this.profile !== 'baseline' ? groundedState(state, objective, history, experience, actionTicks, this.profile === 'spatial' ? await geometryFor(state) : undefined) : decisionState(state, objective, history, experience, actionTicks));
    const criteria = Object.fromEntries(Object.entries(actions).filter(([id]) => {
      if (!calibratedInput) return true;
      if (id === 'advance' && (calibratedInput.movement.forwardBlocked || (calibratedInput.movementFailed && calibratedInput.previousAction === actions.advance.label))) return false;
      if (id === 'retreat' && calibratedInput.movement.backwardBlocked) return false;
      if (id === 'strafeLeft' && calibratedInput.movement.leftBlocked) return false;
      if (id === 'strafeRight' && calibratedInput.movement.rightBlocked) return false;
      if (id === 'fire' && !calibratedInput.targetsNotBehindSolidWalls.some(e => Math.abs(e.bearing) <= 6 && e.visibility !== 'dynamic-opening-unknown')) return false;
      return true;
    }).map(([id, a]) => [id, `${a.label}. Movement intent; motor control stops turning on a target and only fires while a target is plausibly aligned and not behind a known solid wall.`]));
    const result = await this.client.systemOne({
      state: input,
      questions: {
        action: this.profile === 'calibrated-v4' ? choice(tacticalInstructions, Object.fromEntries(Object.entries(actions).map(([id, a]) => [id, `${a.label}. Firing is automatic only while a plausible target is aligned and not behind a known wall. Movement and turning continue as requested.`]))) : this.profile.startsWith('calibrated') ? choice(feedbackInstructions, criteria) : this.profile !== 'baseline' ? choice(this.profile === 'feedback' ? feedbackInstructions : (this.profile === 'tactical' || this.profile === 'assisted') ? tacticalInstructions : this.profile === 'spatial' ? spatialInstructions : groundedInstructions, (this.profile === 'assisted' || this.profile === 'feedback') ? Object.fromEntries(Object.entries(actions).map(([id, a]) => [id, `${a.label}. Movement intent; motor control stops turning on a target and only fires while a target is plausibly aligned and not behind a known solid wall.`])) : groundedCriteria) : choice('Which available action, held for up to `actionDurationSeconds` of game time, best advances the objective given current observations, recent movement and any relevant observed attempts?', Object.fromEntries(Object.entries(actions).map(([id, value]) => [id, value.label]))),
        priority: choice('Which single priority best matches the user objective?', {
          survival: 'Preserve life and recover health, avoid damage before pursuing other goals',
          exploration: 'Discover new space and reach the level exit while staying alive',
          combat: 'Defeat enemies while staying alive',
        }),
      },
    }, { signal });
    const parsed = answerSchema.parse({ action: result.answers.action.choice, confidence: result.answers.action.confidence, probabilities: Object.fromEntries(actionIds.map(id => [id, result.answers.action.probabilities[id] ?? 0])), priority: result.answers.priority.choice });
    const sum = Object.values(parsed.probabilities).reduce((a, b) => a + b, 0);
    if (Math.abs(sum - 1) > 0.02) throw new Error('Jev returned an invalid probability distribution');
    return { ...parsed, latencyMs: performance.now() - started, model: result.model, experienceUsed: 'relatedAttempts' in input ? input.relatedAttempts.length : 'attempts' in input ? input.attempts.length : input.experience.length };
  }
}
