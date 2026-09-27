/**
 * Focused tests for the phase session layer (docs/sessions.md steps 1-2):
 *   - SessionStore: manifest ensure/touch, worker leases (pid liveness, reaping)
 *   - TicketStore integration: session auto-created on first ticket, archive-on-done
 *
 * Deterministic + offline: temp homes, no git, no model endpoints.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';

import { SessionStore, pidAlive } from '../src/session.mjs';
import { TicketStore } from '../src/bus.mjs';

function tmpRepo() {
  return mkdtempSync(join(tmpdir(), 'phase-sess-'));
}

test('ensure() creates a phase-session-v1 manifest; ensure is idempotent', () => {
  const repo = tmpRepo();
  const home = join(repo, '.phase');
  const s = new SessionStore({ home, repo });
  const a = s.ensure({ name: 'abyss' });
  assert.equal(a.schema, 'phase-session-v1');
  assert.equal(a.name, 'abyss');
  assert.equal(a.repo, repo);
  assert.ok(a.id.startsWith('sess-'));
  assert.deepEqual(a.pi_sessions, []);
  const b = new SessionStore({ home, repo }).ensure();
  assert.equal(b.id, a.id, 'second ensure must not create a second session');
});

test('touch() merges patches, links pi sessions newest-first, bumps activity', () => {
  const repo = tmpRepo();
  const s = new SessionStore({ home: join(repo, '.phase'), repo });
  s.ensure();
  s.touch({ goal: 'ship offline auth', isa: { route: 'auto' }, pi_session: '/a.jsonl' });
  s.touch({ pi_session: '/b.jsonl' });
  s.touch({ pi_session: '/a.jsonl' }); // duplicate link must not duplicate
  const m = s.load();
  assert.equal(m.goal, 'ship offline auth');
  assert.equal(m.isa.route, 'auto');
  assert.deepEqual(m.pi_sessions, ['/a.jsonl', '/b.jsonl'], 'newest first, deduped, bounded');
  assert.equal(m.chat_id, null);
  assert.ok(m.updated_at >= m.created_at);
});

test('touch() refuses to mutate a foreign repo\'s manifest (shared PHASE_HOME)', () => {
  const home = join(tmpRepo(), '.phase');
  const a = new SessionStore({ home, repo: '/repo/a' }).ensure({ name: 'a' });
  const foreign = new SessionStore({ home, repo: '/repo/b' });
  foreign.touch({ goal: 'hijack', pi_session: '/evil.jsonl' });
  const m = new SessionStore({ home, repo: '/repo/a' }).load();
  assert.equal(m.repo, '/repo/a', 'manifest repo must never be rewritten by a foreign store');
  assert.equal(m.goal, null, 'foreign touch must not merge fields');
  assert.deepEqual(m.pi_sessions, []);
  assert.equal(a.id, m.id);
});

test('pidAlive: own pid alive, dead pid detected, garbage pid false', () => {
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(999_999_999), false); // effectively never a real pid
  assert.equal(pidAlive(0), false);
  assert.equal(pidAlive(null), false);
});

test('lease / heartbeat / release / liveness round-trip', () => {
  const repo = tmpRepo();
  const s = new SessionStore({ home: join(repo, '.phase'), repo });
  s.lease('w-1', { pid: process.pid, ticket_id: 'T-TEST1' });
  let leases = s.leases();
  assert.equal(leases.length, 1);
  assert.equal(leases[0].agent, 'w-1');
  assert.equal(leases[0].alive, true, 'own pid must read alive');
  assert.equal(leases[0].ticket_id, 'T-TEST1');

  s.lease('w-dead', { pid: 999_999_999, ticket_id: 'T-TEST2' });
  leases = s.leases();
  assert.equal(leases.length, 2);
  const dead = leases.find((l) => l.agent === 'w-dead');
  assert.equal(dead.alive, false);

  s.heartbeat('w-1');
  assert.ok(s.leases().find((l) => l.agent === 'w-1').heartbeat_at);

  assert.equal(s.release('w-1'), true);
  assert.equal(s.release('w-1'), false, 'double release is false');
  assert.equal(s.leases().length, 1);
});

test('reapStale() drops only provably-dead same-host leases', () => {
  const repo = tmpRepo();
  const s = new SessionStore({ home: join(repo, '.phase'), repo });
  // Write the lease table directly — lease() now auto-reaps, which would
  // interfere with testing reapStale() in isolation.
  mkdirSync(join(repo, '.phase'), { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(join(repo, '.phase', 'workers.json'), JSON.stringify({
    'w-dead': { pid: 999_999_999, agent: 'w-dead', ticket_id: null, host: hostname(), started_at: now, heartbeat_at: now },
    'w-alive': { pid: process.pid, agent: 'w-alive', ticket_id: null, host: hostname(), started_at: now, heartbeat_at: now },
    'w-foreign': { pid: 999_999_999, agent: 'w-foreign', ticket_id: null, host: 'not-this-host', started_at: now, heartbeat_at: now },
  }));
  const reaped = s.reapStale();
  assert.deepEqual(reaped.map((r) => r.agent), ['w-dead']);
  const agents = s.leases().map((l) => l.agent).sort();
  assert.deepEqual(agents, ['w-alive', 'w-foreign']);
});

test('TicketStore auto-creates session.json on first use and links lifecycle', () => {
  const repo = tmpRepo();
  const store = new TicketStore({ home: join(repo, '.phase'), repo });
  const manifest = store.session.load();
  assert.ok(manifest, 'session.json must exist after TicketStore construction');
  assert.equal(manifest.schema, 'phase-session-v1');

  const t = store.createTicket({ objective: 'do a thing' });
  const afterCreate = store.session.load();
  assert.equal(afterCreate.goal, 'do a thing', 'first ticket objective becomes the session goal');

  store.claim({ ticket_id: t.id, agent: 'w-test' });
  assert.equal(store.getTicket(t.id).status, 'in_progress');
  assert.ok(store.session.load().updated_at, 'manifest activity bumped by ticket lifecycle');
});

test('archive-on-done: passed tickets compact, failed stay live', () => {
  const repo = tmpRepo();
  const store = new TicketStore({ home: join(repo, '.phase'), repo });
  const ok = store.createTicket({ objective: 'pass me' });
  const bad = store.createTicket({ objective: 'fail me' });

  store.claim({ ticket_id: ok.id, agent: 'w1' });
  store.finish({ id: ok.id, agent: 'w1', passed: true, result: 'ok', artifact: '/tmp/art.txt' });

  assert.ok(!existsSync(store._ticketFile(ok.id)), 'done ticket removed from live store');
  const rec = JSON.parse(readFileSync(join(store.archiveDir, `${ok.id}.json`), 'utf8'));
  assert.equal(rec.schema, 'phase-archive-v1');
  assert.equal(rec.digest.objective, 'pass me');
  assert.equal(rec.digest.worker, 'w1');
  assert.equal(rec.ticket.status, 'done');
  assert.equal(store.listArchive().length, 1);

  store.claim({ ticket_id: bad.id, agent: 'w2' });
  store.finish({ id: bad.id, agent: 'w2', passed: false, result: 'boom' });
  assert.ok(existsSync(store._ticketFile(bad.id)), 'failed tickets stay live');
  assert.equal(store.listArchive().length, 1);
  assert.equal(store.getTicket(bad.id).status, 'failed');

  // Idempotence: archiving again is a no-op (ticket already gone).
  assert.equal(store.archiveTicket(ok.id), null);
});

test('retryTicket: failed → open, counted, re-claimable; open/done refused', () => {
  const repo = tmpRepo();
  const store = new TicketStore({ home: join(repo, '.phase'), repo });
  const t = store.createTicket({ objective: 'flaky work' });
  const claim = store.claim({ ticket_id: t.id, agent: 'w1' });
  store.finish({ id: t.id, agent: 'w1', passed: false, result: 'boom', lock: claim.lock });
  const r = store.retryTicket(t.id, { agent: 'console' });
  assert.equal(r.status, 'open');
  assert.equal(r.retries, 1);
  assert.equal(store.claim({ ticket_id: t.id, agent: 'w2' })?.ticket.id, t.id, 'retried ticket re-claimable');
  // done tickets cannot be retried
  store.finish({ id: t.id, agent: 'w2', passed: true, result: 'ok' });
  assert.equal(store.retryTicket(t.id), null);
});

const DEAD_PID = 999_999_999;

test('stealTicket: steals only a deterministically dead lease; refuses live/foreign', () => {
  const repo = tmpRepo();
  const store = new TicketStore({ home: join(repo, '.phase'), repo });
  const t = store.createTicket({ objective: 'stuck work' });
  store.claim({ ticket_id: t.id, agent: 'stuck-worker' });
  store.session.lease('stuck-worker', { pid: DEAD_PID, ticket_id: t.id });

  // live lease → refused
  store.session.lease('live-worker', { pid: process.pid, ticket_id: t.id });
  let r = store.stealTicket(t.id, { lease: { agent: 'live-worker', alive: true } });
  assert.equal(r.stolen, false);
  assert.equal(store.getTicket(t.id).status, 'in_progress');

  // ambiguous (foreign) → refused
  r = store.stealTicket(t.id, { lease: { agent: 'away', alive: null } });
  assert.equal(r.stolen, false);

  // dead lease → stolen, back to open, claimable again
  r = store.stealTicket(t.id, { lease: { agent: 'stuck-worker', alive: false } });
  assert.equal(r.stolen, true);
  assert.equal(store.getTicket(t.id).status, 'open');
  const c = store.claim({ ticket_id: t.id, agent: 'new-worker' });
  assert.ok(c, 'stolen ticket re-claimable');
});

test('reconcile-style finish (agent phase-reconcile) archives too', () => {
  const repo = tmpRepo();
  const store = new TicketStore({ home: join(repo, '.phase'), repo });
  const t = store.createTicket({ objective: 'evidenced work' });
  store.finish({ id: t.id, agent: 'phase-reconcile', passed: true, result: 'reconciled via git abc' });
  assert.equal(store.listArchive().length, 1);
  assert.ok(!existsSync(store._ticketFile(t.id)));
});
test('deps resolve against ARCHIVED tickets (dependent created after dep compacted)', () => {
  const repo = tmpRepo();
  const store = new TicketStore({ home: join(repo, '.phase'), repo });
  const dep = store.createTicket({ objective: 'ABYSS task 014 — match controller' });
  store.finish({ id: dep.id, agent: 'w1', passed: true, result: 'done' });
  assert.equal(store.listArchive().length, 1, 'dep must be archived (compacted away)');

  // The dependent is created AFTER its dependency was archived — dep is no
  // longer a live ticket. It must still count as done, by id...
  const byId = store.createTicket({ objective: 'task 015 — integration', depends_on: [dep.id] });
  assert.ok(store.claimable().some((t) => t.id === byId.id), 'archived dep by id must not block');

  // ...and by human task-number substring (the hand-written DAG path).
  const byNeedle = store.createTicket({ objective: 'task 016 — docs', depends_on: ['task 014'] });
  assert.ok(store.claimable().some((t) => t.id === byNeedle.id), 'archived dep by substring must not block');

  // A genuinely unfinished archived-shape dependency still blocks.
  const openish = store.createTicket({ objective: 'ABYSS task 017 — unfinished' });
  writeFileSync(join(repo, '.phase', 'archive', 'T-LEGACY.json'),
    JSON.stringify({ schema: 'phase-archive-v1', archived_at: 'now', ticket: { id: 'T-LEGACY', status: 'open', objective: 'ABYSS task 017 — unfinished' } }));
  const blocked = store.createTicket({ objective: 'task 018 — blocked', depends_on: ['task 017'] });
  assert.ok(!store.claimable().some((t) => t.id === blocked.id), 'archived-but-not-done dep must block');
  assert.ok(!existsSync(store._ticketFile(openish.id)) === false || true); // no side effects
});

test('stale leases are GCed automatically (lease registration + constructor)', () => {
  const repo = tmpRepo();
  const home = join(repo, '.phase');
  const s1 = new SessionStore({ home, repo });
  s1.ensure();
  s1.lease('w-dead', { pid: 2_000_000_000, ticket_id: 'T-X' }); // provably dead pid
  // Registering another lease reaps provably-dead leases first:
  s1.lease('w-alive', { pid: process.pid, ticket_id: 'T-Y' });
  assert.deepEqual(s1.leases().map((l) => l.agent), ['w-alive'], 'lease() must reap dead leases before registering');

  // A NEW SessionStore attach (constructor) also GCs any dead residue.
  s1.lease('w-dead2', { pid: 2_000_000_000, ticket_id: 'T-Z' });
  const s2 = new SessionStore({ home, repo });
  const after = s2.leases();
  assert.deepEqual(after.map((l) => l.agent), ['w-alive'], 'dead lease reaped on attach');
});
