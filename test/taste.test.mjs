/**
 * phase-taste — the director's dials, in-session. View/validate/atomic-write.
 * Deterministic: spawns the CLI against a temp repo. No LLM, no orchestration.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HERE = new URL('..', import.meta.url).pathname;
const BIN = join(HERE, 'bin', 'phase-taste.mjs');

function sandbox() {
  const repo = mkdtempSync(join(tmpdir(), 'phase-taste-'));
  return { repo, file: join(repo, 'phase.taste.mjs'), cleanup: () => rmSync(repo, { recursive: true, force: true }) };
}

function taste({ repo }, ...args) {
  return execFileSync(process.execPath, [BIN, ...args], { encoding: 'utf8', cwd: repo });
}

test('get with no file: all dials at Phase defaults, sourced [default]', () => {
  const { repo, cleanup } = sandbox();
  try {
    const out = taste({ repo });
    assert.match(out, /bands\.yes\s+0\.72\s+\[default\]/);
    assert.match(out, /verify\.beforeStop\s+"git-evidence"\s+\[default\]/);
    assert.match(out, /absent — Phase defaults/);
  } finally { cleanup(); }
});

test('set validates, writes atomically, and takes effect on the next review', async () => {
  const { repo, file, cleanup } = sandbox();
  try {
    taste({ repo }, 'set', 'bands.yes=0.9', 'retry.maxAttempts=3', 'stop.requireAllDone=false');
    assert.ok(existsSync(file));
    const src = readFileSync(file, 'utf8');
    assert.match(src, /"yes": 0\.9/);
    assert.match(src, /"maxAttempts": 3/);
    // The written file parses and loadTaste (per decideNext) picks it up.
    const m = await import(file);
    assert.equal(m.TASTE.bands.yes, 0.9);
    assert.equal(m.TASTE.stop.requireAllDone, false);
  } finally { cleanup(); }
});

test('set rejects unknown dials, bad values, and yes<=no — file never touched', () => {
  const { repo, file, cleanup } = sandbox();
  try {
    assert.throws(() => taste({ repo }, 'set', 'not.a.dial=1'), /unknown dial/);
    assert.throws(() => taste({ repo }, 'set', 'bands.yes=2'), /bad value/);
    assert.throws(() => taste({ repo }, 'set', 'bands.yes=0.2'), /must be greater/);
    assert.throws(() => taste({ repo }, 'set', 'verify.beforeStop=bogus'), /bad value/);
    assert.ok(!existsSync(file), 'no file written on rejection');
  } finally { cleanup(); }
});

test('set is incremental: existing dials survive a new edit', async () => {
  const { repo, file, cleanup } = sandbox();
  try {
    taste({ repo }, 'set', 'bands.yes=0.8');
    taste({ repo }, 'set', 'followup.maxPerRound=5');
    const m = await import(file);
    assert.equal(m.TASTE.bands.yes, 0.8);     // earlier edit preserved
    assert.equal(m.TASTE.followup.maxPerRound, 5);
  } finally { cleanup(); }
});

test('reset returns every dial to Phase defaults', () => {
  const { repo, file, cleanup } = sandbox();
  try {
    taste({ repo }, 'set', 'bands.yes=0.95');
    taste({ repo }, 'reset');
    const out = taste({ repo });
    assert.match(out, /bands\.yes\s+0\.72\s+\[default\]/);
    assert.match(readFileSync(file, 'utf8'), /TASTE = \{\}/);
  } finally { cleanup(); }
});