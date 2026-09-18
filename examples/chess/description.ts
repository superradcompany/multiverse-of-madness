import { validateGameDescription, type GameDescription, type GameFieldDescription, type GameCapabilities, type VersionRef } from '@multiverse/gameplay-harness';

const field = (path: string, type: GameFieldDescription['type'], meaning: string): GameFieldDescription => ({ path, type, meaning, availability: 'always' });
/** Rules and observable mechanics only; no opening repertoire or tactical strategy is supplied. */
export function describeChess(adapter: VersionRef, capabilities: GameCapabilities, player: 'w' | 'b' = 'w'): GameDescription {
  const side = player === 'w' ? 'White' : 'Black';
  const description: GameDescription = {
    format: 1, adapter, name: 'Chess (chess.js rules)',
    observations: [
      field('/initialFen', 'string', 'FEN position from which this game history begins.'),
      field('/fen', 'string', 'Current FEN: piece placement, side to move, castling rights, en-passant square, halfmove clock and fullmove number. Uppercase pieces are White; lowercase are Black.'),
      field('/turn', 'string', 'Side to move: w is White, b is Black.'),
      field('/ply', 'number', 'Number of executed half-moves since initialFen; one ply is one move by either side.'),
      field('/moves', 'array', 'Complete chronological SAN move history from initialFen; preserves repetition and draw semantics.'),
      field('/legalMoves', 'array', 'Engine-validated legal SAN move strings for the current side; empty when no legal move exists.'),
      field('/status', 'string', 'ongoing, checkmate or draw. In checkmate, the side to move has lost. Draw includes chess.js draw conditions.'),
    ],
    controls: [{ id: 'move', meaning: 'Play one legal chess move for the current side.',
      fields: [field('/san', 'string', 'Exactly one string from state.legalMoves. SAN uses x for capture, + for check and # for checkmate.')],
      legalChoices: '/legalMoves', preconditions: 'The game is ongoing and san is in the current legalMoves list.',
      effects: 'Updates board, turn, complete move history, legal moves and terminal status; advances exactly one ply.' }],
    timing: { unit: 'turns', sequence: '/ply', commandDuration: 'A command takes one ply. Model latency is not game time.', waiting: 'The board does not advance while choosing or waiting; there is no chess clock in this adapter.' },
    planning: { payload: [field('/san', 'string', 'A single legal SAN move; host candidate id is the SAN string.')],
      execution: 'Each plan executes one move, then completes. Opponent turns require separate competitive decisions. A trial may contain multiple plans/plies.',
      validation: 'The host enumerates all legal moves with chess.js. Select a supplied candidate ID. Host legality and actual outcome measurement cannot be changed by generated code.' },
    outcomes: { success: `${side} delivers checkmate.`, failure: `${side} is checkmated or the game is drawn; draws currently count as non-success.`,
      metrics: [{ id: 'value', meaning: `${side} material minus opponent material: pawn 1, knight/bishop 3, rook 5, queen 9, king 0. Checkmate is +10000 for a win or -10000 for a loss; draw is 0.`, direction: 'higher' },
        { id: 'plies', meaning: 'Moves on the selected path, separate from total attempted trial plies.', direction: 'diagnostic' },
        { id: 'captures', meaning: 'Number of captures in the complete move history; includes both sides.', direction: 'diagnostic' } ] },
    capabilities,
    limitations: ['Game worlds are local file-backed copies of initialFen and full move history, not VMs.',
      'Detached means durable reconnection after host exit; play requires an active host.',
      'Frames are recorded board positions, not continuous video.',
      'Material balance is a basic host evaluator, not a proof of forced victory or playing strength.',
      'No external chess engine, tablebase, hidden opponent state or clock is exposed.',
      'Private acceptance scenarios are not included in this description.'],
  };
  validateGameDescription(description, { adapter, capabilities });
  return description;
}
