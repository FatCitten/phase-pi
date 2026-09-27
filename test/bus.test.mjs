import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BusStore } from '../src/bus.mjs';

function tempHome() {
  return mkdtempSync(join(tmpdir(), 'isa-test-'));
}

test('emit/read roundtrip on both buses, separate sequences', () => {
  const home = tempHome();
  const store = new BusStore({ home, repo: '/repo' });
  const c = store.emit('control', 'alloc.decision', { objective: 'x' });
  const d = store.emit('data', 'alloc.isa', { isa: 'ROUTE exec' });
  assert.equal(c.type, 'sig.alloc.decision');
  assert.equal(c.seq, 1);
  assert.equal(d.seq, 1); // each bus sequences independently
  assert.equal(store.readControl().length, 1);
  assert.equal(store.readData().length, 1);
  assert.equal(store.readControl()[0].objective, 'x');
  assert.equal(store.readData()[0].isa, 'ROUTE exec');
  rmSync(home, { recursive: true, force: true });
});

test('seq is monotonic and assigned by tail', () => {
  const home = tempHome();
  const store = new BusStore({ home, repo: '/r' });
  const seqs = Array.from({ length: 120 }, (_, i) => store.emit('control', 'ping', { i }).seq);
  assert.deepEqual(seqs, Array.from({ length: 120 }, (_, i) => i + 1));
  rmSync(home, { recursive: true, force: true });
});

test('invalid bus throws; missing bus reads empty', () => {
  const home = tempHome();
  const store = new BusStore({ home, repo: '/r' });
  assert.throws(() => store.emit('sidechannel', 'x'), /control or data/);
  assert.deepEqual(store.read('data'), []);
  assert.deepEqual(store.readControl(), []);
  rmSync(home, { recursive: true, force: true });
});

test('tail returns last n, oldest first', () => {
  const home = tempHome();
  const store = new BusStore({ home, repo: '/r' });
  for (let i = 0; i < 10; i++) store.emit('control', 'tick', { i });
  const t = store.tail('control', 3);
  assert.equal(t.length, 3);
  assert.equal(t[0].i, 7);
  assert.equal(t[2].i, 9);
  rmSync(home, { recursive: true, force: true });
});

test('envelope carries seq/ts/bus/type/repo', () => {
  const home = tempHome();
  const store = new BusStore({ home, repo: '/repo-x' });
  const e = store.emit('control', 'hello');
  for (const k of ['seq', 'ts', 'bus', 'type', 'repo']) assert.ok(k in e, `missing ${k}`);
  assert.equal(e.repo, '/repo-x');
  assert.ok(!Number.isNaN(Date.parse(e.ts)));
  rmSync(home, { recursive: true, force: true });
});

test('appends are one ndjson line each', () => {
  const home = tempHome();
  const store = new BusStore({ home, repo: '/r' });
  store.emit('control', 'a');
  store.emit('control', 'b');
  const lines = readFileSync(join(home, 'bus', 'control.ndjson'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  for (const l of lines) JSON.parse(l); // each line parses standalone
  rmSync(home, { recursive: true, force: true });
});
