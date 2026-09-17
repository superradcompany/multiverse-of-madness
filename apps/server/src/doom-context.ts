import type { GameState } from '../../../packages/contracts/src/game.ts';
import type { EntityObservation } from '../../../packages/contracts/src/entity.ts';
import type { DoomMap } from './doom-geometry.ts';
import type { Experience } from './experience.ts';

// Engine enum identities, not visual classifications. wasmdoom dd321b50
// info.h/info.c and d_items.c; Freedoom replaces artwork, not these mechanics.
const pickups: Record<number, string> = {
  43: 'green armor', 44: 'blue armor', 45: 'health bonus', 46: 'armor bonus',
  47: 'blue key', 48: 'red key', 49: 'yellow key', 50: 'yellow skull key', 51: 'red skull key', 52: 'blue skull key',
  53: 'health +10 (up to 100)', 54: 'health +25 (up to 100)', 55: 'health +100 (up to 200)',
  56: 'invulnerability', 57: 'berserk and health recovery', 58: 'partial invisibility', 59: 'radiation suit',
  60: 'map', 61: 'light amplification', 62: 'health and armor to 200',
  63: 'bullets', 64: 'box of bullets', 65: 'rocket', 66: 'box of rockets', 67: 'cells', 68: 'cell pack',
  69: 'shells', 70: 'box of shells', 71: 'backpack and ammo', 72: 'BFG', 73: 'chaingun', 74: 'chainsaw',
  75: 'rocket launcher', 76: 'plasma gun', 77: 'shotgun', 78: 'double shotgun',
};
const enemyKinds: Record<number, string> = {
  1: 'bullet shooter', 2: 'shotgun shooter', 3: 'arch-vile', 5: 'revenant', 8: 'mancubus',
  10: 'chaingun shooter', 11: 'imp', 12: 'melee demon', 13: 'melee spectre', 14: 'cacodemon',
  15: 'baron', 17: 'hell knight', 18: 'charging skull', 19: 'spider mastermind', 20: 'arachnotron', 21: 'cyberdemon',
};
const round = (n: number) => Math.round(n * 10) / 10;

export function groundedState(state: GameState, objective: string, history: GameState[], experience: Experience[] = [], actionTicks = 35, map?: DoomMap) {
  const earlier = history.find(s => s.tick < state.tick && s.map === state.map && s.episode === state.episode);
  const entity = (e: EntityObservation) => ({
    kind: e.kind === 'pickup' ? pickups[e.engineType] ?? `pickup type ${e.engineType}` : e.kind === 'enemy' ? enemyKinds[e.engineType] ?? `enemy type ${e.engineType}` : `projectile type ${e.engineType}`,
    sight: map?.sight(state, e.position) ?? 'unknown',
    distance: round(e.distance), leftDegrees: round(e.relativeBearing), heightDifference: round(e.position.z - state.z),
    ...(e.kind === 'enemy' ? { health: e.health } : {}),
    ...(e.kind === 'projectile' ? { headingTowardPlayer: round(e.towardPlayerAlignment) } : {}),
  });
  const input = {
    objective: objective.slice(0, 1000), secondsHoldingAction: round(actionTicks / 35),
    player: { health: state.health, armor: state.armor, weapon: state.weapon ?? 'unknown',
      ammo: { bullets: state.ammo[0] ?? null, shells: state.ammo[1] ?? null, cells: state.ammo[2] ?? null, rockets: state.ammo[3] ?? null },
      kills: state.kills, position: [round(state.x), round(state.y), round(state.z)], heading: round(state.angle) },
    recent: earlier ? { seconds: round((state.tick - earlier.tick) / 35), moved: round(Math.hypot(state.x - earlier.x, state.y - earlier.y)), healthChange: state.health - earlier.health, kills: state.kills - earlier.kills } : null,
    geometry: map?.observe(state) ?? null,
    enemies: state.enemies.slice(0, 6).map(entity),
    projectiles: state.projectiles.slice(0, 6).map(entity),
    pickups: state.pickups.slice(0, 6).map(entity),
    attempts: experience.slice(0, 3).map(e => ({ action: e.action, result: e.result })),
    limits: 'Nearby engine observations, NOT line of sight or reachable paths. Walls, floors and doors can separate objects. Positive leftDegrees means left; negative means right; 0 means ahead; +/-180 behind. Shooting fires ahead without turning; turning does not shoot. Strafing moves sideways without changing aim. Projectiles heading toward you may miss or hit walls. Unknown weapon is not evidence of usable ammo. Attempts are nearby past outcomes, not guarantees.',
  };
  while (JSON.stringify(input).length > 4800 && input.attempts.length) input.attempts.pop();
  return input;
}

export const groundedInstructions = {
  question: 'Which action should the player hold for `secondsHoldingAction` to advance `objective` from the observed state?',
  guidance: 'Preserve life while making useful progress. Aim toward an enemy before shooting; do not shoot just because an enemy is nearby. Use forward to collect useful pickups ahead or open a door. Turn toward targets to the left/right. If recent movement is blocked, change direction. Strafe to evade while preserving aim. Consider height and unknown walls. Choose wait only when deliberate inaction has a clear benefit. Do not assume proximity proves visibility or a route to the exit.',
};
export const groundedCriteria = {
  advance: 'Move straight forward and use/open doors. No shooting or turning.',
  left: 'Turn aim left while moving forward. No shooting. Can overshoot a small angle during a long hold.',
  right: 'Turn aim right while moving forward. No shooting. Can overshoot a small angle during a long hold.',
  retreat: 'Move backward while firing straight ahead. Does not turn toward enemies behind or beside you.',
  strafeLeft: 'Move left sideways while firing ahead. Aim stays fixed.',
  strafeRight: 'Move right sideways while firing ahead. Aim stays fixed.',
  fire: 'Stand still and shoot straight ahead. Aim stays fixed; exposed to incoming damage.',
  wait: 'Stand still without shooting or turning. Only useful when waiting is intentional.',
};

export const spatialInstructions = {
  question: 'Which action offers the best useful progress toward `objective` over `secondsHoldingAction`, accounting for walls and targets?',
  guidance: 'Do not fire at solid-wall-blocked enemies. A wall-blocked pickup is not immediately reachable. Prefer changing heading over pushing into a nearby static barrier. Only fire when an enemy is plausibly in the forward firing direction and not known blocked. Do not confuse nearby enemies with targets in sight. Turning while moving does not shoot. Moving sideways or backward preserves heading. Continue exploring when enemies are occluded; deliberately wait only if helpful. Avoid damage while pursuing the objective.',
};

export function tacticalState(state: GameState, objective: string, history: GameState[], map: DoomMap, actionTicks: number, experience: Experience[] = []) {
  const previous = history.find(s => s.tick < state.tick && s.map === state.map && s.episode === state.episode);
  const candidates = state.enemies.filter(e => map.sight(state, e.position) !== 'solid-wall-blocked');
  const target = (e: EntityObservation) => ({ ...(map.dynamicUncertain ? { visibility: map.sight(state, e.position) } : {}), kind: e.kind === 'pickup' ? pickups[e.engineType] ?? 'pickup' : enemyKinds[e.engineType] ?? 'enemy', ...(e.kind === 'enemy' ? { health: e.health } : {}), distance: Math.round(e.distance), bearing: Math.round(e.relativeBearing), heightDifference: Math.round(e.position.z - state.z) });
  const geometry = map.observe(state);
  const rays = geometry.staticBarrierDistance;
  const clearance = Object.fromEntries(Object.entries({ ahead: 0, behind: 180, left: 90, right: -90 }).map(([key, angle]) => [key, map.clearance(state, state.angle + angle)])) as Record<'ahead' | 'behind' | 'left' | 'right', number>;
  return {
    objective: objective.slice(0, 1000), actionSeconds: round(actionTicks / 35),
    health: state.health, bullets: state.ammo[0] ?? 0, weapon: state.weapon ?? 'unknown',
    nearbyLocks: geometry.nearbyLocks,
    movement: { barrierDistances: rays, playerClearance: clearance, forwardBlocked: clearance.ahead <= 20, backwardBlocked: clearance.behind <= 20, leftBlocked: clearance.left <= 20, rightBlocked: clearance.right <= 20 },
    recentMovement: previous ? Math.round(Math.hypot(state.x - previous.x, state.y - previous.y)) : null,
    targetsNotBehindSolidWalls: candidates.slice(0, 2).map(target),
    blockedEnemyCount: state.enemies.length - candidates.length,
    nearbyPickups: state.pickups.filter(e => map.sight(state, e.position) !== 'solid-wall-blocked' && Math.abs(e.position.z - state.z) <= 24).slice(0, 3).map(target),
    experience: experience.slice(0, 2).map(e => ({ action: e.action, result: e.result })),
    units: 'World units and degrees. Bearing 0 ahead, +90 left, -90 right, +/-180 behind. Player radius 16. Static walls block shots. Door/floor openings and actor collisions unknown. Barrier distance caps at 512. Only consider unblocked targets. Ray clearance does not guarantee movement.',
  };
}
export const tacticalInstructions = {
  question: 'Choose the most useful feasible action for this Doom player now.',
  movement: 'If forwardBlocked, escape using a direction with more clearance, not advance into the wall. When there is no enemy ahead to shoot, explore open space or collect useful reachable pickups. Backward and sideways movement can escape a corner; they do not change facing. Health pickups capped at 100 are useless when health is already 100 or more.',
  combat: 'Shooting aims forward only. Turn toward unblocked enemies before firing. Enemy behind a solid wall is not a target. Unknown doors/floors can still obstruct. Preserve life and do not stand firing at walls. Prefer the user objective when several feasible actions exist.',
};

export function feedbackState(state: GameState, objective: string, history: GameState[], map: DoomMap, actionTicks: number, experience: Experience[] = [], previousAction?: string) {
  const input = tacticalState(state, objective, history, map, actionTicks, experience);
  return { ...input, previousAction: previousAction ?? 'none yet',
    movementFailed: previousAction !== undefined && input.recentMovement !== null && input.recentMovement < 4 && /move|forward|retreat|strafe|turn/.test(previousAction),
    projectiles: state.projectiles.slice(0, 3).map(e => ({ ...(e.kind === 'enemy' ? { health: e.health } : {}), distance: Math.round(e.distance), bearing: Math.round(e.relativeBearing), towardPlayer: round(e.towardPlayerAlignment), heightDifference: Math.round(e.position.z - state.z), blocked: map.sight(state, e.position) === 'solid-wall-blocked' })),
  };
}
export const feedbackInstructions = {
  question: 'Which next action will make useful progress toward the objective, considering the result of the previous action?',
  obstruction: 'If movementFailed is true, the previous movement did not work. Try a DIFFERENT direction instead of repeating it, even if the map ray looks clear. Floors, lifts and doors can obstruct movement. A useful pickup or enemy at bearing +90 needs a left turn, -90 needs a right turn. Close pickups ahead can be collected by moving forward.',
  combat: 'Motor control handles firing at aligned targets, stops aiming turns once aligned, and temporarily steers around blocked movement; choose the movement or aiming intent. When an unblocked enemy is nearby, face it or evade it. Never pursue a solid-wall-blocked enemy as if visible. Incoming projectiles may favor sideways movement. Keep progressing; do not wait or stay shooting indefinitely.',
};
