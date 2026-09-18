import test from 'node:test';
import assert from 'node:assert/strict';
import { localGameSessions, parseGameSessions, sameSessionUrl } from './game-sessions.ts';

const session = { id: 'game-1', game: 'chess', gameLabel: 'Chess', title: 'Learning run', description: 'A saved session', url: 'https://demo.example/sessions/1/' };
test('catalog rejects executable URLs, embedded credentials and ambiguous session identities', () => {
  assert.deepEqual(parseGameSessions([session]), [session]);
  for (const url of ['javascript:alert(1)', 'file:///tmp/state', 'https://user:secret@demo.example/']) assert.throws(() => parseGameSessions([{ ...session, url }]));
  assert.throws(() => parseGameSessions([session, session]), /unique/);
  assert.throws(() => parseGameSessions([session, { ...session, id: 'second' }]), /unique/);
  assert.throws(() => parseGameSessions([{ ...session, token: 'must-not-be-public' }]), /needs/);
});
test('local defaults retain the accessed hostname and active selection preserves session paths and queries', () => {
  const sessions = localGameSessions('http://127.0.0.1:4322/chess.html');
  assert.equal(sessions[2]!.url, 'http://127.0.0.1:4322/');
  assert.equal(sameSessionUrl(sessions[2]!.url, 'http://127.0.0.1:4322/chess.html'), true);
  assert.equal(sameSessionUrl(sessions[1]!.url, sessions[2]!.url), false);
  assert.equal(sameSessionUrl('https://demo.example/sessions/a', 'https://demo.example/sessions/b'), false);
  assert.equal(sameSessionUrl('https://demo.example/?session=a', 'https://demo.example/?session=b'), false);
  assert.deepEqual(localGameSessions('https://demo.example/'), []);
});
