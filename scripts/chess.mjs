import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Chess } from 'chess.js';

const START = '<!-- CHESS:START -->';
const END = '<!-- CHESS:END -->';
const NAMES = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };

function snapshot(chess, game, requests = []) {
  return { schemaVersion: 1, game, fen: chess.fen(), pgn: chess.pgn(),
    lastMove: chess.history().at(-1) ?? null, requests: structuredClone(requests) };
}

export function createState({ game = 1, fen } = {}) {
  if (!Number.isSafeInteger(game) || game < 1) throw new Error('Invalid state game number');
  return snapshot(fen ? new Chess(fen) : new Chess(), game);
}

function load(state) {
  if (!state || state.schemaVersion !== 1 || !Number.isSafeInteger(state.game) || state.game < 1 ||
    typeof state.fen !== 'string' || typeof state.pgn !== 'string' || !Array.isArray(state.requests)) {
    throw new Error('Invalid chess state schema');
  }
  const ids = new Set();
  for (const request of state.requests) {
    if (!Number.isSafeInteger(request.id) || request.id < 1 || typeof request.title !== 'string' || ids.has(request.id)) {
      throw new Error('Invalid chess state requests');
    }
    ids.add(request.id);
  }
  const chess = new Chess();
  try { chess.loadPgn(state.pgn); } catch { throw new Error('Invalid chess state PGN'); }
  if (chess.fen() !== state.fen || (chess.history().at(-1) ?? null) !== state.lastMove) {
    throw new Error('Inconsistent chess state history');
  }
  return chess;
}

export function fingerprint(state) {
  load(state);
  // Request receipts do not change the position. Game and full PGN prevent replay
  // when a board repeats or a new game starts.
  return createHash('sha256').update(JSON.stringify({ schemaVersion: state.schemaVersion,
    game: state.game, fen: state.fen, pgn: state.pgn })).digest('hex');
}

export function applyMove(state, title, _user) {
  const chess = load(state);
  const match = typeof title === 'string' && title.match(/^chess:([a-f0-9]{64}):([a-h][1-8][a-h][1-8][qrbn]?|new)$/u);
  if (!match || match[0] !== title) return { accepted: false, reason: 'invalid_title' };
  if (match[1] !== fingerprint(state)) return { accepted: false, reason: 'stale_position' };
  if (match[2] === 'new') {
    if (!chess.isGameOver()) return { accepted: false, reason: 'game_not_over' };
    const next = createState({ game: state.game + 1 });
    next.requests = structuredClone(state.requests);
    return { accepted: true, reason: 'new_game', state: next };
  }
  if (chess.isGameOver()) return { accepted: false, reason: 'game_over' };
  const legal = chess.moves({ verbose: true }).find((move) => move.lan === match[2]);
  if (!legal) return { accepted: false, reason: 'illegal_move' };
  chess.move({ from: legal.from, to: legal.to, ...(legal.promotion ? { promotion: legal.promotion } : {}) });
  return { accepted: true, reason: 'move_applied', move: legal.san,
    state: snapshot(chess, state.game, state.requests) };
}

function status(chess) {
  const turn = chess.turn() === 'w' ? 'white' : 'black';
  if (chess.isCheckmate()) return `checkmate. ${turn === 'white' ? 'black' : 'white'} wins`;
  if (chess.isStalemate()) return 'draw by stalemate';
  if (chess.isThreefoldRepetition()) return 'draw by threefold repetition';
  if (chess.isInsufficientMaterial()) return 'draw by insufficient material';
  if (chess.isDrawByFiftyMoves()) return 'draw by the fifty-move rule';
  if (chess.isDraw()) return 'draw';
  return `${turn} to move${chess.isCheck() ? ', in check' : ''}`;
}

const xml = (value) => String(value).replace(/[&<>"']/g, (character) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]);

function validateRepo(repo) {
  if (typeof repo !== 'string' || !/^[a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*$/i.test(repo)) {
    throw new Error('Provide a GitHub repository as owner/name');
  }
}

export function renderSection(state, { repo }) {
  validateRepo(repo);
  const chess = load(state);
  const position = fingerprint(state);
  const link = (move, label) => {
    const url = new URL(`https://github.com/${repo}/issues/new`);
    url.searchParams.set('title', `chess:${position}:${move}`);
    const action = move === 'new' ? 'Start a new shared game.' : `Play ${label} in the shared game.`;
    url.searchParams.set('body', `${action}\n\nSubmit this issue to play. Closed as Completed means your move was played. Closed as Not planned means it was not played, usually because the board changed.\n\nRefresh [the profile](https://github.com/${repo.split('/')[0]}) to choose a current move.`);
    return url.href;
  };
  const modelUrl = `https://github.com/${repo}/blob/main/assets/chess-board.stl`;
  const lines = ['## your move', '', `<a href="${modelUrl}"><img src="assets/chess-board.png?position=${position}" width="960" alt="3D Man Ray-inspired chess set. game ${state.game}: ${xml(status(chess))}. Click to rotate the set."></a>`, '',
    `[rotate the set](${modelUrl})`, '',
    `**${status(chess)}.** game ${state.game}${state.lastMove ? `. last move: ${state.lastMove}` : ''}.`, ''];
  if (chess.isGameOver()) {
    lines.push(`[start a new game](${link('new')})`);
  } else {
    lines.push('Choose a move below, then submit the issue. The board updates after GitHub runs it.', '', '<details>', '<summary>play a move</summary>', '');
    const groups = new Map();
    for (const move of chess.moves({ verbose: true })) {
      const key = `${NAMES[move.piece]} ${move.from}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(`[${move.san}](${link(move.lan, move.san)})`);
    }
    for (const [piece, moves] of groups) lines.push(`- **${piece}**: ${moves.join(' · ')}`);
    lines.push('', '</details>');
  }
  return lines.join('\n') + '\n';
}

function updateSection(readme, section) {
  const start = readme.indexOf(START);
  const end = readme.indexOf(END);
  if (start < 0 || end < start || readme.indexOf(START, start + START.length) !== -1 || readme.indexOf(END, end + END.length) !== -1) {
    throw new Error('README must contain one ordered CHESS:START and CHESS:END block');
  }
  return readme.slice(0, start + START.length) + '\n\n' + section + '\n' + readme.slice(end);
}

async function writeFiles(files) {
  // Stage every complete file before replacing any. The workflow commits all
  // the state and README with the separately rendered PNG, so a failed run
  // cannot publish a partial board update.
  const staged = [];
  try {
    for (const [path, content] of files) {
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, content, { flag: 'wx' });
      staged.push([temporary, path]);
    }
    for (const [temporary, path] of staged) await rename(temporary, path);
  } finally {
    await Promise.all(staged.map(([temporary]) => rm(temporary, { force: true })));
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  let repo = process.env.GITHUB_REPOSITORY;
  let write = false;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--repo') repo = args[++index];
    else if (args[index] === '--write') write = true;
    else throw new Error(`Unknown argument: ${args[index]}`);
  }
  validateRepo(repo);
  const state = JSON.parse(await readFile('game/state.json', 'utf8'));
  load(state);
  if (command === 'render') {
    const section = renderSection(state, { repo });
    const files = [];
    if (write) files.push(['README.md', updateSection(await readFile('README.md', 'utf8'), section)]);
    await writeFiles(files);
    process.stdout.write(section);
    return;
  }
  if (command !== 'process') throw new Error('Usage: chess.mjs render|process --repo owner/name [--write]');
  if (!process.env.GITHUB_EVENT_PATH) throw new Error('GITHUB_EVENT_PATH is required');
  const { issue } = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
  if (!issue || !Number.isSafeInteger(issue.id) || issue.id < 1) {
    console.log(JSON.stringify({ accepted: false, reason: 'invalid_issue' }));
    return;
  }
  const previous = state.requests.find((request) => request.id === issue.id);
  if (previous) {
    console.log(JSON.stringify({ accepted: previous.title === issue.title,
      reason: previous.title === issue.title ? 'already_applied' : 'issue_already_used' }));
    return;
  }
  const result = applyMove(state, issue.title);
  if (result.accepted) {
    result.state.requests.push({ id: issue.id, title: issue.title });
    const section = renderSection(result.state, { repo });
    const readme = updateSection(await readFile('README.md', 'utf8'), section);
    await writeFiles([['game/state.json', JSON.stringify(result.state, null, 2) + '\n'],
      ['README.md', readme]]);
  }
  console.log(JSON.stringify({ accepted: result.accepted, reason: result.reason,
    ...(result.accepted ? { game: result.state.game, move: result.move ?? null } : {}) }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
