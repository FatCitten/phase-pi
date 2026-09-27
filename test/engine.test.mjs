import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../src/engine.mjs';

function tempHome(repo) {
  return mkdtempSync(join(tmpdir(), 'isa-engine-'));
}

function makeEngine(home) {
  return new Engine({ home, repo: home });
}

test('begin: creates pointer, sandbox, alloc; logs run.alloc + run.isa', () => {
  const home = tempHome();
  const engine = makeEngine(home);
  const { id, alloc, sandbox, pointer } = engine.begin({ task: 'add rate limiting' });
  assert.match(id, /^R-/);
  assert.equal(pointer.task, 'add rate limiting');
  assert.ok(existsSync(sandbox));
  assert.ok(existsSync(join(home, 'runs', id, 'alloc.json')));
  assert.equal(alloc.author, 'defaults');
  assert.equal(alloc.budget.context_tokens, alloc.budget.tokens / 2);
  const control = engine.bus.readControl();
  const data = engine.bus.readData();
  assert.equal(control[0].type, 'sig.run.alloc');
  assert.equal(data[0].type, 'sig.run.isa');
  rmSync(home, { recursive: true, force: true });
});

test('begin with --asm style asm: session-authored, clamped', () => {
  const home = tempHome();
  const engine = makeEngine(home);
  const { alloc } = engine.begin({
    task: 'x',
    asm: 'ROUTE auto\nALLOC TOKENS 5000\nGRANT read\nGRANT test\n',
    ceilings: { tokens: 8000 },
  });
  assert.equal(alloc.author, 'session');
  assert.equal(alloc.budget.tokens, 5000);
  assert.deepEqual(alloc.tools, ['read', 'test']);
  rmSync(home, { recursive: true, force: true });
});

test('exec: runs inside the sandbox, writes stay there', async () => {
  const home = tempHome();
  const engine = makeEngine(home);
  const { sandbox } = engine.begin({ task: 'sandbox write' });
  const r = await engine.exec({ cmd: 'node -e "require(\'fs\').writeFileSync(process.cwd()+\'/x.txt\',\'hi\')"' });
  assert.equal(r.code, 0);
  assert.ok(existsSync(join(sandbox, 'x.txt')));
  assert.ok(!existsSync(join(home, 'x.txt')));
  assert.ok(existsSync(join(home, 'runs', engine.readPointer().id, 'artifact.log')));
  rmSync(home, { recursive: true, force: true });
});

test('exec: wall budget enforced — long child is killed', async () => {
  const home = tempHome();
  const engine = makeEngine(home);
  engine.begin({ task: 'wall enforcement', ceilings: { wall_ms: 1500 } });
  const r = await engine.exec({ cmd: 'sleep 30' });
  assert.equal(r.killed, true);
  assert.equal(r.code, 124);
  assert.ok(r.wall_ms < 3000);
  rmSync(home, { recursive: true, force: true });
});

test('exec: bwrap jail makes the root read-only (when bwrap present)', async (t) => {
  const home = tempHome();
  const engine = makeEngine(home);
  if (!engine.hasBwrap()) { t.skip('bwrap not installed'); return; }
  engine.begin({ task: 'ro root' });
  const r = await engine.exec({ cmd: 'node -e "try{require(\'fs\').writeFileSync(\'/etc/isa-escape.txt\',\'x\');process.exit(1)}catch(e){process.exit(0)}"' });
  assert.equal(r.code, 0); // the write must have thrown inside the jail
  assert.equal(engine.hasBwrap(), true);
  rmSync(home, { recursive: true, force: true });
});

test('end: engine-measured, budget-checked, pointer cleared', () => {
  const home = tempHome();
  const engine = makeEngine(home);
  const { id } = engine.begin({ task: 'close clean', ceilings: { wall_ms: 60000 } });
  const r = engine.end({ passed: true, result: 'done' });
  assert.equal(r.passed, true);
  assert.equal(r.exitCode, 0);
  assert.deepEqual(r.over, []);
  assert.ok(r.actuals.wall_ms >= 0);
  assert.equal(engine.readPointer(), null);
  const control = engine.bus.readControl();
  assert.equal(control[control.length - 1].type, 'sig.run.done');
  rmSync(home, { recursive: true, force: true });
});

test('end: over-budget wall reports over and exits 2', async () => {
  const home = tempHome();
  const engine = makeEngine(home);
  engine.begin({ task: 'wall overrun', ceilings: { wall_ms: 400 } });
  await engine.exec({ cmd: 'sleep 2' }); // killed by wall at ~400ms
  await new Promise((r) => setTimeout(r, 300)); // a genuine overrun, past the boundary
  const r = engine.end({ passed: true });
  assert.deepEqual(r.over, ['wall_ms']);
  assert.equal(r.exitCode, 2);
  const control = engine.bus.readControl();
  assert.equal(control[control.length - 1].type, 'sig.run.done');
  assert.ok(control[control.length - 1].over.includes('wall_ms'));
  rmSync(home, { recursive: true, force: true });
});

test('status: inactive without a run, active with one', () => {
  const home = tempHome();
  const engine = makeEngine(home);
  assert.equal(engine.status().active, false);
  engine.begin({ task: 'counter' });
  const s = engine.status();
  assert.equal(s.active, true);
  assert.equal(s.task, 'counter');
  assert.ok(s.remaining > 0);
  rmSync(home, { recursive: true, force: true });
});

test('a new begin supersedes the pointer', () => {
  const home = tempHome();
  const engine = makeEngine(home);
  const a = engine.begin({ task: 'first' });
  const b = engine.begin({ task: 'second' });
  assert.notEqual(a.id, b.id);
  assert.equal(engine.readPointer().id, b.id);
  rmSync(home, { recursive: true, force: true });
});

test('exec with no run fails closed', async () => {
  const home = tempHome();
  const engine = makeEngine(home);
  await assert.rejects(() => engine.exec({ cmd: 'echo hi' }), /no active run/);
  assert.throws(() => engine.end({ passed: true }), /no active run/);
  rmSync(home, { recursive: true, force: true });
});

test('exec output lands in the run artifact verbatim', async () => {
  const home = tempHome();
  const engine = makeEngine(home);
  const { id } = engine.begin({ task: 'artifact' });
  await engine.exec({ cmd: 'echo sandboxed-ok' });
  const artifact = readFileSync(join(home, 'runs', id, 'artifact.log'), 'utf8');
  assert.match(artifact, /sandboxed-ok/);
  rmSync(home, { recursive: true, force: true });
});
