import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../src/engine.mjs';
import { execFileSync } from 'node:child_process';

function tempHome() {
  return mkdtempSync(join(tmpdir(), 'isa-engine-'));
}

function makeEngine(home) {
  return new Engine({ home, repo: home });
}

test('begin: creates pointer + sandbox, logs sig.run.begin + sig.run.snapshot', () => {
  const home = tempHome();
  // init git so snapshot works
  execFileSync('git', ['init', '-q'], { cwd: home, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: home, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: home, stdio: 'ignore' });
  const engine = makeEngine(home);
  const { id, sandbox, pointer } = engine.begin({ task: 'add rate limiting' });
  assert.match(id, /^R-/);
  assert.equal(pointer.task, 'add rate limiting');
  assert.ok(existsSync(sandbox));
  const control = engine.bus.readControl();
  const data = engine.bus.readData();
  assert.equal(control[0].type, 'sig.run.begin');
  assert.equal(control[0].task, 'add rate limiting');
  assert.equal(data.length, 1);
  assert.equal(data[0].type, 'sig.run.snapshot');
  assert.ok(data[0].snapshot.startsWith('repo '));
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

test('exec: wall safety limit kills a runaway child', async () => {
  const home = tempHome();
  const engine = makeEngine(home);
  engine.begin({ task: 'wall limit' });
  const r = await engine.exec({ cmd: 'sleep 30', timeout: 1500 });
  assert.equal(r.killed, true);
  assert.equal(r.code, 124);
  assert.ok(r.wall_ms < 3000);
  const control = engine.bus.readControl();
  assert.equal(control[control.length - 1].type, 'sig.run.killed');
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

test('end: engine-measured, recorded, pointer cleared', () => {
  const home = tempHome();
  const engine = makeEngine(home);
  const { id } = engine.begin({ task: 'close clean' });
  const r = engine.end({ passed: true, result: 'done' });
  assert.equal(r.passed, true);
  assert.ok(r.actuals.wall_ms >= 0);
  assert.ok(!('over' in r.actuals));
  assert.equal(engine.readPointer(), null);
  const control = engine.bus.readControl();
  assert.equal(control[control.length - 1].type, 'sig.run.done');
  assert.equal(control[control.length - 1].result, 'done');
  rmSync(home, { recursive: true, force: true });
});

test('end: failed run records sig.run.failed', () => {
  const home = tempHome();
  const engine = makeEngine(home);
  engine.begin({ task: 'fail clean' });
  const r = engine.end({ passed: false });
  assert.equal(r.passed, false);
  const control = engine.bus.readControl();
  assert.equal(control[control.length - 1].type, 'sig.run.failed');
  rmSync(home, { recursive: true, force: true });
});

test('status: inactive without a run, active with run facts', () => {
  const home = tempHome();
  const engine = makeEngine(home);
  assert.equal(engine.status().active, false);
  engine.begin({ task: 'counter' });
  const s = engine.status();
  assert.equal(s.active, true);
  assert.equal(s.task, 'counter');
  assert.equal(s.id, engine.readPointer().id);
  assert.ok(s.started_at);
  assert.equal(s.actuals.exec_count, 0);
  assert.ok(!('budget' in s));
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

test('exec records measured facts on the data bus, never enforced', async () => {
  const home = tempHome();
  const engine = makeEngine(home);
  const { id } = engine.begin({ task: 'metering' });
  await engine.exec({ cmd: 'echo hi' });
  const data = engine.bus.readData();
  assert.equal(data[data.length - 1].type, 'sig.run.exec');
  assert.equal(data[data.length - 1].run, id);
  assert.equal(data[data.length - 1].killed, false);
  assert.ok(data[data.length - 1].wall_ms >= 0);
  const s = engine.status();
  assert.equal(s.actuals.exec_count, 1);
  rmSync(home, { recursive: true, force: true });
});
