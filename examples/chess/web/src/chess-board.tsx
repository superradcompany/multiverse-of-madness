import type { ChessState } from '../../runtime.ts';

const glyphs: Record<string, string> = { K: '♔', Q: '♕', R: '♖', B: '♗', N: '♘', P: '♙', k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };
export function Board({ state }: { state: ChessState }) {
  const squares = state.fen.split(' ')[0]!.split('/').flatMap(row => [...row].flatMap(piece => /[1-8]/.test(piece) ? Array.from({ length: Number(piece) }, () => '') : [piece]));
  return <div className="board" role="img" aria-label={`Chess board after ${state.ply} plies. ${state.turn === 'w' ? 'White' : 'Black'} to move. FEN ${state.fen}`}>
    {squares.map((piece, index) => <div key={index} className={`square ${(Math.floor(index / 8) + index) % 2 ? 'dark' : 'light'}`}>
      {index % 8 === 0 && <small className="rank">{8 - Math.floor(index / 8)}</small>}
      {index >= 56 && <small className="file">{'abcdefgh'[index % 8]}</small>}
      <span className={piece === piece.toUpperCase() ? 'white-piece' : 'black-piece'}>{glyphs[piece] ?? ''}</span>
    </div>)}
  </div>;
}
export function MoveList({ moves }: { moves: string[] }) {
  const start = Math.max(0, moves.length - 8);
  return <div className="moves" aria-label="Recent moves">{moves.length ? moves.slice(start).map((move, i) => <span key={start + i}>
    {(start + i) % 2 === 0 && <small>{Math.floor((start + i) / 2) + 1}.</small>}{move}
  </span>) : <span className="muted">Starting position</span>}</div>;
}
