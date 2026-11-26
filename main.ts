// main.ts — Canyon Courier's hand-in program (Node 22, standard library only).
//
// It copies the game and its screenshots from beside this file to the output directory and writes
// the dossier the judge reads, using the vendored make.fun library. Nothing is built, nothing is
// fetched: game/ is the playable game as static files and screenshots/ holds four real renders of
// it. The program is deterministic — two runs over the same tree write the same bytes — because
// every byte it writes comes from buildDossier over a directory it copies verbatim.
//
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
//
// MAKEFUN_OUTPUT_DIR stands in for /output outside the grader.

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-game.ts';

/** Where the repository's own files live: this program's directory. */
const here = fileURLToPath(new URL('.', import.meta.url));

/** The output root: /output in the grader, MAKEFUN_OUTPUT_DIR outside it. */
const out = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The screenshots' name pattern and the caps the dossier enforces, in one place for the checks. */
const SHOT_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** Fail loudly rather than hand in a half-copied tree. */
function must(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`main.ts: ${message}`);
}

/** Start from an empty game/ and screenshots/ in the output, so a stale file never rides along. */
function cleanOutput(): void {
  for (const dir of ['game', 'screenshots']) {
    const target = join(out, dir);
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
  }
  const dossier = join(out, 'dossier.json');
  if (existsSync(dossier)) rmSync(dossier, { force: true });
}

/** Check the repository's own inputs before copying them: the game's page and four screenshots. */
function checkInputs(): void {
  must(existsSync(join(here, 'game', 'index.html')), 'game/index.html is missing');
  must(existsSync(join(here, 'game', 'vendor', 'three.min.js')), 'game/vendor/three.min.js is missing (the vendored renderer)');
  const shotsDir = join(here, 'screenshots');
  must(existsSync(shotsDir), 'screenshots/ is missing');
  const shots = readdirSync(shotsDir).filter((name) => !name.startsWith('.'));
  must(shots.length >= 3 && shots.length <= 4, `screenshots/ holds ${shots.length} files, and the gate wants 3 or 4`);
  for (const name of shots) {
    must(SHOT_NAME.test(name), `screenshots/${name}: a name is letters, digits and . _ -`);
    const bytes = statSync(join(shotsDir, name)).size;
    must(bytes <= 262144, `screenshots/${name} is ${bytes} bytes, over the 256 KiB cap`);
  }
}

cleanOutput();
checkInputs();

mkdirSync(out, { recursive: true });
cpSync(join(here, 'game'), join(out, 'game'), { recursive: true });
mkdirSync(join(out, 'screenshots'), { recursive: true });
cpSync(join(here, 'screenshots'), join(out, 'screenshots'), { recursive: true });

// The caps are the bounty's own (reference/gate.json): only text_max_bytes shapes the bytes; the
// rest refuse exactly what the scorer would refuse, so a bad entry fails here rather than there.
writeFileSync(
  join(out, 'dossier.json'),
  buildDossier(out, {
    text_max_bytes: 163840,
    screenshots: { max: 4, max_bytes: 262144 },
    game_max_files: 993,
    game_max_bytes: 50331648,
    game_path_max_bytes: 1000,
  }),
);

console.log(`Canyon Courier handed in to ${out}: game/, screenshots/ and dossier.json`);
