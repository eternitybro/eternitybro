import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fingerprint } from './chess.mjs';

// Validate the same canonical position that produces the legal move links.
fingerprint(JSON.parse(readFileSync('game/state.json', 'utf8')));

const macBlender = '/Applications/Blender.app/Contents/MacOS/Blender';
const executable = process.env.BLENDER_EXECUTABLE || (existsSync(macBlender) ? macBlender : 'blender');
const result = spawnSync(executable, [
  '--background', '--factory-startup', '--python-exit-code', '1',
  '--python', 'scripts/render-board.py', '--',
  '--state', 'game/state.json', '--output', 'assets/chess-board.png',
  '--stl', 'assets/chess-board.stl',
], { stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);
