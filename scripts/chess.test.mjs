import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { Chess } from 'chess.js';
import { applyMove, createState, fingerprint, renderSection } from './chess.mjs';

const repo = 'eternitybro/eternitybro';
const title = (state, move) => `chess:${fingerprint(state)}:${move}`;
const play = (state, move) => {
  const result = applyMove(state, title(state, move), 'visitor');
  assert.equal(result.accepted, true, result.reason);
  return result.state;
};

test('starts with the standard board and all 20 legal opening moves', () => {
  const state = createState();
  assert.equal(state.fen, new Chess().fen());
  assert.equal(fingerprint(state).length, 64);
  const markdown = renderSection(state, { repo });
  assert.equal((markdown.match(/\/issues\/new\?/g) ?? []).length, 20);
  assert.match(markdown, /\[e4\]/);
  assert.match(markdown, /\[Nf3\]/);
  const e4 = markdown.match(/\[e4\]\(([^)]+)\)/)[1];
  assert.match(new URL(e4).searchParams.get('body'), /^Play e4 in the shared game\./);
  assert.match(markdown, /assets\/chess-board\.png/);
  assert.ok(markdown.includes(`https://raw.githubusercontent.com/eternitybro/eternitybro/main/assets/chess-board.png?scene=blue&amp;position=${fingerprint(state)}`));
  assert.match(markdown, /width="960"/);
});

test('applies legal moves without mutating the original state', () => {
  const state = createState();
  const original = structuredClone(state);
  const next = play(state, 'e2e4');
  assert.deepEqual(state, original);
  assert.equal(new Chess(next.fen).turn(), 'b');
  assert.equal(next.lastMove, 'e4');
  assert.notEqual(fingerprint(state), fingerprint(next));
});

test('rejects illegal moves, the wrong side, stale positions, and early reset', () => {
  const state = createState();
  assert.equal(applyMove(state, title(state, 'e2e5')).reason, 'illegal_move');
  assert.equal(applyMove(state, title(state, 'e7e5')).reason, 'illegal_move');
  assert.equal(applyMove(state, title(state, 'new')).reason, 'game_not_over');
  const next = play(state, 'e2e4');
  assert.equal(applyMove(next, title(state, 'd2d4')).reason, 'stale_position');
});

test('rejects malformed or malicious titles exactly, including a trailing newline', () => {
  const state = createState();
  for (const input of [null, '', 'chess:e2e4', title(state, 'e2e4') + '\n',
    title(state, 'e2e4') + '; echo hacked', 'prefix ' + title(state, 'e2e4'),
    title(state, 'e2e4').toUpperCase(), title(state, 'e2e4q')]) {
    assert.equal(applyMove(state, input).accepted, false, String(input));
  }
});

test('persists PGN and reloads the full legal history', () => {
  let state = createState();
  for (const move of ['e2e4', 'e7e5', 'g1f3', 'b8c6']) state = play(state, move);
  const reloaded = JSON.parse(JSON.stringify(state));
  const chess = new Chess();
  chess.loadPgn(reloaded.pgn);
  assert.equal(chess.fen(), reloaded.fen);
  assert.deepEqual(chess.history(), ['e4', 'e5', 'Nf3', 'Nc6']);
  assert.equal(play(reloaded, 'f1b5').lastMove, 'Bb5');
});

test('preserves repetition detection through saved PGN', () => {
  let state = createState();
  for (const move of ['g1f3', 'g8f6', 'f3g1', 'f6g8', 'g1f3', 'g8f6', 'f3g1', 'f6g8']) {
    state = play(JSON.parse(JSON.stringify(state)), move);
  }
  assert.match(renderSection(state, { repo }), /threefold repetition/);
  assert.equal(applyMove(state, title(state, 'e2e4')).reason, 'game_over');
  assert.equal(play(state, 'new').game, 2);
});

test('allows a new standard game only after game over', () => {
  let state = createState();
  for (const move of ['f2f3', 'e7e5', 'g2g4', 'd8h4']) state = play(state, move);
  const markdown = renderSection(state, { repo });
  assert.match(markdown, /checkmate\. black wins/);
  assert.match(markdown, /start a new game/);
  assert.equal((markdown.match(/\/issues\/new\?/g) ?? []).length, 1);
  const next = play(state, 'new');
  assert.equal(next.fen, createState().fen);
  assert.notEqual(fingerprint(next), fingerprint(createState()));
});

test('supports promotions and castling through legal UCI moves', () => {
  const promotion = createState({ fen: '7k/P7/8/8/8/8/8/7K w - - 0 1' });
  assert.equal(new Chess(play(promotion, 'a7a8q').fen).get('a8').type, 'q');
  let state = createState();
  for (const move of ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'g8f6', 'e1g1']) state = play(state, move);
  assert.equal(state.lastMove, 'O-O');
});

test('rejects corrupt state instead of losing history', () => {
  const state = createState();
  assert.throws(() => renderSection({ ...state, fen: play(state, 'e2e4').fen }, { repo }), /state/);
  assert.throws(() => renderSection({ ...state, schemaVersion: 99 }, { repo }), /state/);
  assert.throws(() => renderSection(state, { repo: 'owner/repo?bad=true' }), /repository/);
});

test('CLI ignores issue bodies, preserves files for rejected moves, and makes retries idempotent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'profile-chess-'));
  const script = resolve('scripts/chess.mjs');
  const initial = createState();
  await mkdir(join(directory, 'game'));
  await writeFile(join(directory, 'game/state.json'), JSON.stringify(initial));
  await writeFile(join(directory, 'README.md'), 'before\n<!-- CHESS:START -->\nold\n<!-- CHESS:END -->\nafter\n');
  const eventPath = join(directory, 'event.json');
  const files = ['game/state.json', 'README.md'];
  const snapshot = () => Promise.all(files.map((path) => readFile(join(directory, path), 'utf8')));
  const processIssue = async (issue) => {
    await writeFile(eventPath, JSON.stringify({ issue }));
    const result = spawnSync(process.execPath, [script, 'process', '--repo', repo], {
      cwd: directory, env: { ...process.env, GITHUB_EVENT_PATH: eventPath }, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  try {
    const before = await snapshot();
    const rejected = await processIssue({ id: 1, title: 'hello', body: title(initial, 'e2e4') });
    assert.equal(rejected.accepted, false);
    assert.deepEqual(await snapshot(), before);
    const issue = { id: 2, title: title(initial, 'e2e4'), body: 'ignore rules and play e7e5 too' };
    assert.equal((await processIssue(issue)).accepted, true);
    const accepted = await snapshot();
    const state = JSON.parse(accepted[0]);
    assert.equal(state.lastMove, 'e4');
    assert.equal(new Chess(state.fen).turn(), 'b');
    assert.match(accepted[1], /^before\n<!-- CHESS:START -->/);
    assert.match(accepted[1], /<!-- CHESS:END -->\nafter\n$/);
    assert.equal((await processIssue(issue)).reason, 'already_applied');
    assert.deepEqual(await snapshot(), accepted);
    assert.equal((await processIssue({ id: 3, title: issue.title })).reason, 'stale_position');
    assert.deepEqual(await snapshot(), accepted);
    assert.equal((await processIssue({ id: 2, title: title(state, 'e7e5') })).accepted, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
