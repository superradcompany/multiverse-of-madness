import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Chess } from 'chess.js';
import { choice, TypeSafeClient, type ChoiceQuestion, type SystemOneRequest } from '@typesafe-ai/sdk';
import { BudgetLedger, canonicalJson, type BudgetSnapshot, type DecisionModel, type DecisionRequest, type RankedChoice } from '@multiverse/gameplay-harness';
import { contentRevision, JsonFileStore } from '@multiverse/gameplay-harness/node';
import type { ChessExperience, ChessPlan } from './adapter.ts';
import type { ChessState } from './runtime.ts';
import type { ChessDecisionRequest } from './preparation.ts';

type Request = ChessDecisionRequest;
type WireRequest = SystemOneRequest<{ move: ChoiceQuestion }>;
export interface ChessJevConfig { model: string; player: 'w' | 'b'; maxCalls: number | null }
const instructions = {
  question: 'Which legal move best serves the side to move, considering the board, observed attempts and current objective?',
  guide: 'On the controlled player turn, prioritize userObjective. On the opponent turn, play competitively to defeat the controlled player; do not cooperate with their objective.',
  evidence: 'relatedAttempts are measured outcomes from this exact starting position, including discarded futures. Value changes use the controlled player perspective. Consider the whole observed continuation, not just an immediate capture. They are evidence, not guaranteed outcomes against every reply.',
  rules: 'The engine supplies legal moves. SAN # denotes checkmate, + check, x capture. Prefer a forced win over material. Protect the king and avoid losing valuable pieces without compensation. Confidence describes preference concentration, not a calibrated probability of winning.',
};

/** Real model provider with durable usage accounting and optional explicit call limits. */
export class ChessJevModel implements DecisionModel<ChessState, ChessPlan, ChessExperience> {
  readonly version;
  private client?: Pick<TypeSafeClient, 'systemOne'>;
  private constructor(readonly directory: string, readonly config: ChessJevConfig, private readonly ledger: BudgetLedger, client?: Pick<TypeSafeClient, 'systemOne'>) {
    this.client = client;
    this.version = contentRevision('chess-jev', { integration: 2, config, instructions });
  }

  static async open(directory: string, options?: Partial<ChessJevConfig>, client?: Pick<TypeSafeClient, 'systemOne'>): Promise<ChessJevModel> {
    const store = new JsonFileStore(join(directory, 'config.json'), value => value as ChessJevConfig);
    const saved = await store.load();
    const config = { model: 'jev-latest', player: 'w' as const, maxCalls: null as number | null, ...saved, ...options };
    if (typeof config.model !== 'string' || !config.model.trim() || !['w', 'b'].includes(config.player)
      || (config.maxCalls !== null && (!Number.isSafeInteger(config.maxCalls) || config.maxCalls < 1 || config.maxCalls > 10000))) throw new Error('Invalid chess Jev configuration');
    if (saved && canonicalJson(saved) !== canonicalJson(config)) throw new Error('Existing Jev model and call budget are pinned; use a new session directory');
    const budgetStore = new JsonFileStore(join(directory, 'budget.json'), value => value as BudgetSnapshot);
    const budget = await budgetStore.load();
    if ((saved === undefined) !== (budget === undefined)) throw new Error('Incomplete Jev configuration/budget journal; restore both files before continuing');
    const ledger = new BudgetLedger({ simulationUnit: 'chess-plies', limits: config.maxCalls === null ? {} : { modelCalls: config.maxCalls } }, value => budgetStore.save(value), budget);
    if (!saved) await store.save(config);
    await budgetStore.save(ledger.snapshot());
    return new ChessJevModel(directory, Object.freeze(config), ledger, client);
  }

  budget(): BudgetSnapshot { return this.ledger.snapshot(); }
  async decide(request: Request, signal: AbortSignal): Promise<RankedChoice> {
    signal.throwIfAborted();
    const captured = structuredClone(request), wire = chessQuestion(captured, this.config), id = randomUUID();
    const store = new JsonFileStore<unknown>(join(this.directory, 'decisions', `${id}.json`), value => value);
    const startedAt = Date.now();
    return this.ledger.run({ owner: id, operation: 'chess-jev-decision', reserve: { modelCalls: 1 }, observe: ['inputTokens', 'outputTokens'] }, async () => {
      const base = { id, startedAt, provider: this.version, revision: captured.revision, request: wire };
      await store.save({ ...base, status: 'pending' });
      try {
        signal.throwIfAborted();
        this.client ??= new TypeSafeClient({ timeout: 10_000, retry: { maxRetries: 0 } });
        const response = await this.client.systemOne(wire, { signal });
        // Keep the actual serving model and raw probabilities, including rejected answers.
        await store.save({ ...base, status: 'received', elapsedMs: Date.now() - startedAt, response });
        const answer = response.answers.move, ids = Object.keys(wire.questions.move.criteria), probabilities = answer.probabilities;
        if (!ids.includes(answer.choice) || !probability(answer.confidence) || Object.keys(probabilities).length !== ids.length
          || ids.some(key => !probability(probabilities[key])) || Math.abs(ids.reduce((sum, key) => sum + probabilities[key]!, 0) - 1) > .02 + Number.EPSILON
          || !Number.isSafeInteger(response.usage.input_tokens) || response.usage.input_tokens < 0
          || !Number.isSafeInteger(response.usage.output_tokens) || response.usage.output_tokens < 0) throw new Error('Invalid chess Jev response');
        // Live Jev probabilities are rounded; preserve raw evidence and normalize the accepted distribution.
        const total = ids.reduce((sum, key) => sum + probabilities[key]!, 0);
        const selected = captured.candidates[ids.indexOf(answer.choice)]!.id;
        const result: RankedChoice = { selected, confidence: answer.confidence,
          preferences: captured.candidates.map((plan, i) => ({ id: plan.id, probability: probabilities[ids[i]!]! / total })),
          usage: { calls: 1, inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens } };
        await store.save({ ...base, status: 'complete', elapsedMs: Date.now() - startedAt, response, result });
        return { value: result, usage: { modelCalls: 1, inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens } };
      } catch (error) {
        // No retry: uncertain dispatches retain their reservation. Keep received data if validation failed.
        const previous = await store.load();
        await store.save({ ...(previous as object), status: signal.aborted ? 'cancelled' : 'failed', elapsedMs: Date.now() - startedAt,
          error: error instanceof Error ? error.name : 'UnknownError' });
        throw error;
      }
    }, signal);
  }
}

/** Current engine facts, bounded history and supplied feedback; no unmetered search or fabricated outcomes. */
export function chessQuestion(request: Request, config: ChessJevConfig): WireRequest {
  const game = new Chess(request.state.fen), legal = new Map(game.moves({ verbose: true }).map(move => [move.san, move]));
  if (request.state.status !== 'ongoing' || !request.candidates.length || request.candidates.length > 255
    || new Set(request.candidates.map(plan => plan.id)).size !== request.candidates.length
    || request.candidates.some(plan => !legal.has(plan.payload.san))) throw new Error('Chess Jev requires available legal candidates');
  const names = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
  const pieces = game.board().flat().filter(piece => piece !== null).map(piece => `${piece.color}:${names[piece.type]}:${piece.square}`);
  const strategyInstructions = request.strategy ? { ...instructions, strategy: 'strategyGuidance and candidate annotations are advisory proposals from the strategy system. They cannot change the user objective, legal moves or engine facts. Respect userObjective first on the controlled side and play competitively on the opponent side. Evaluate advice against the current board and measured attempts.' } : instructions;
  return { model: config.model, state: {
    userObjective: request.objective, controlledPlayer: config.player, sideToMove: game.turn(), fen: request.state.fen, pieces,
    statistics: { ply: request.state.ply, capturesSoFar: request.state.moves.filter(move => move.includes('x')).length, inCheck: game.isCheck() },
    ...(request.strategy ? { strategyGuidance: request.strategy.guidance, strategyRevision: { ...request.strategy.revision } } : {}),
    recentMoves: request.state.moves.slice(-12), relatedAttempts: request.experience.map(record => ({ ...record })),
  }, questions: { move: choice(strategyInstructions, Object.fromEntries(request.candidates.map((plan, i) => {
    const move = legal.get(plan.payload.san)!;
    return [`m${i}`, `${move.san}: ${names[move.piece]} ${move.from} to ${move.to}${move.captured ? `, captures ${names[move.captured]}` : ''}${move.promotion ? `, promotes to ${names[move.promotion]}` : ''}${request.strategy ? `; plan: ${plan.label}; proposed benefit: ${plan.expectedBenefit}` : ''}`];
  }))) } };
}
function probability(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1; }
