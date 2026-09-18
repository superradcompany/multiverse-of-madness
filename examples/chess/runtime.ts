import { randomUUID } from 'node:crypto';
import { Chess, DEFAULT_POSITION } from 'chess.js';
import type { WorldRuntime } from '@multiverse/gameplay-harness';

export interface ChessSave { initialFen: string; moves: string[] }
export interface ChessState extends ChessSave {
  fen: string;
  turn: 'w' | 'b';
  ply: number;
  legalMoves: string[];
  status: 'ongoing' | 'checkmate' | 'draw';
}

/** Existing chess.js rules engine. Full move history preserves repetition and draw semantics across clones. */
export class ChessWorld implements WorldRuntime<ChessState, { san: string }, string> {
  private readonly game: Chess;
  private readonly initialFen: string;
  private closed = false;
  constructor(readonly id: string, saved: ChessSave = { initialFen: DEFAULT_POSITION, moves: [] }, readonly identity: string = randomUUID()) {
    this.initialFen = saved.initialFen;
    this.game = new Chess(saved.initialFen);
    for (const san of saved.moves) this.game.move(san, { strict: true });
  }
  async state(): Promise<ChessState> {
    this.open();
    const moves = this.game.history();
    return { initialFen: this.initialFen, moves, fen: this.game.fen(), turn: this.game.turn(), ply: moves.length,
      legalMoves: this.game.moves().sort(), status: this.game.isCheckmate() ? 'checkmate' : this.game.isDraw() ? 'draw' : 'ongoing' };
  }
  async step(command: { san: string }): Promise<ChessState> {
    this.open();
    if (this.game.isGameOver()) throw new Error('Cannot step a terminal chess world');
    this.game.move(command.san, { strict: true });
    return this.state();
  }
  async frame(): Promise<string> { this.open(); return this.game.ascii(); }
  async branch(ids: string[]): Promise<ChessWorld[]> {
    this.open();
    if (new Set(ids).size !== ids.length || ids.some(id => !id.trim() || id === this.id)) throw new Error('Invalid child world identities');
    const { initialFen, moves } = await this.state();
    return ids.map(id => new ChessWorld(id, { initialFen, moves }));
  }
  async destroy(): Promise<void> { this.closed = true; }
  private open(): void { if (this.closed) throw new Error('Chess world is closed'); }
}
