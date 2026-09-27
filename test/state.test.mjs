import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render, snapshot } from '../bin/isa-state.mjs';

function git(dir, args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

/** init commit: pkg + src/a.mjs + TEMP.txt. feat commit: +fn in a.mjs,
 *  README.md added, TEMP.txt deleted. Then uncommitted edit + untracked file. */
function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'isa-state-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 't@t.t']);
  git(dir, ['config', 'user.name', 't']);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0' }));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src/a.mjs'), 'export function a() {}\n');
  writeFileSync(join(dir, 'TEMP.txt'), 'temp\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-qm', 'init']);
  writeFileSync(join(dir, 'src/a.mjs'), 'export function a() {}\nexport function b() {}\n');
  writeFileSync(join(dir, 'README.md'), '# demo\n');
  git(dir, ['rm', '-q', 'TEMP.txt']);
  git(dir, ['add', '.']);
  git(dir, ['commit', '-qm', 'feat: b']);
  writeFileSync(join(dir, 'src/a.mjs'), 'export function a() {}\nexport function b() {}\nexport function c() {}\n');
  writeFileSync(join(dir, 'untracked.txt'), 'new\n');
  return dir;
}

test('snapshot: identity + structure counts + sha + dirty', () => {
  const dir = tempRepo();
  const s = snapshot(dir);
  assert.equal(s.name, 'demo');
  assert.equal(s.version, '1.0.0');
  assert.equal(s.files, 3); // package.json, src/a.mjs, README.md
  assert.equal(s.counts.src, 1);
  assert.equal(s.counts.doc, 1);
  assert.equal(s.counts.cfg, 1);
  assert.match(s.sha, /^[0-9a-f]{7,}$/);
  assert.equal(s.dirty, 2);
  rmSync(dir, { recursive: true, force: true });
});

test('snapshot: diff vs HEAD~1 carries add/del/fn/doc tokens', () => {
  const dir = tempRepo();
  const s = snapshot(dir);
  assert.ok(s.base);
  assert.equal(s.base.head, 'HEAD');
  const byPath = Object.fromEntries(s.base.files.map((f) => [f.path, f]));
  assert.ok(byPath['src/a.mjs'].tokens.includes('+fn'));
  assert.ok(byPath['README.md'].tokens.includes('add'));
  assert.ok(byPath['README.md'].tokens.includes('doc'));
  assert.ok(byPath['TEMP.txt'].tokens.includes('del'));
  rmSync(dir, { recursive: true, force: true });
});

test('snapshot: --base picks the compared range', () => {
  const dir = tempRepo();
  const init = git(dir, ['rev-parse', 'HEAD~1']).trim();
  const s = snapshot(dir, init);
  assert.equal(s.base.base, init);
  // same range as the default here: HEAD~1..HEAD
  assert.equal(s.base.files.length, 3);
  rmSync(dir, { recursive: true, force: true });
});

test('snapshot: work list reports modified + untracked', () => {
  const dir = tempRepo();
  const s = snapshot(dir);
  const byPath = Object.fromEntries(s.work.map((w) => [w.path, w.status]));
  assert.equal(byPath['src/a.mjs'], 'M');
  assert.equal(byPath['untracked.txt'], '?');
  rmSync(dir, { recursive: true, force: true });
});

test('render: compact block reconstructs repo + diff in one line', () => {
  const dir = tempRepo();
  const text = render(snapshot(dir), true);
  assert.match(text, /^repo demo v1\.0\.0 files 3 /);
  assert.match(text, /\| base [0-9a-f]+\.\.HEAD \+\d+ -\d+/);
  assert.match(text, /\| f:src\/a\.mjs \+\d+ -\d+ \+fn/);
  assert.match(text, /\| w:src\/a\.mjs M/);
  assert.ok(!text.includes('\n'));
  rmSync(dir, { recursive: true, force: true });
});

test('tier-2: symbol names extracted from diffs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'isa-state-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 't@t.t']);
  git(dir, ['config', 'user.name', 't']);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0' }));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src/a.mjs'), 'export function a() {}\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-qm', 'init']);
  writeFileSync(join(dir, 'src/a.mjs'), 'export function a() {}\nexport function b() {}\nconst C = 1;\nimport { x, y } from "./z";\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-qm', 'feat']);
  const s = snapshot(dir);
  const f = s.base.files.find(x => x.path === 'src/a.mjs');
  assert.ok(f.symbols.some(s => s.sign === '+' && s.kind === 'fn' && s.name === 'b'));
  assert.ok(f.symbols.some(s => s.sign === '+' && s.kind === 'const' && s.name === 'C'));
  assert.ok(f.symbols.some(s => s.sign === '+' && s.kind === 'imp' && s.name === 'x'));
  assert.ok(f.symbols.some(s => s.sign === '+' && s.kind === 'imp' && s.name === 'y'));
  rmSync(dir, { recursive: true, force: true });
});

test('tier-2: render includes symbols in compact form', () => {
  const dir = mkdtempSync(join(tmpdir(), 'isa-state-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 't@t.t']);
  git(dir, ['config', 'user.name', 't']);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0' }));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src/a.mjs'), 'export function a() {}\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-qm', 'init']);
  writeFileSync(join(dir, 'src/a.mjs'), 'export function a() {}\nexport function b() {}\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-qm', 'feat']);
  const text = render(snapshot(dir), true);
  assert.match(text, /\+fn:b/);
  rmSync(dir, { recursive: true, force: true });
});

test('snapshot: no git repo fails closed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'isa-state-'));
  assert.throws(() => snapshot(dir), /no git repo/);
  rmSync(dir, { recursive: true, force: true });
});
