/**
 * Roles & guardrails: workers refuse out-of-scope tickets (direct request logs
 * a scope.violation; pool scans filter silently); delegation is the ONLY path
 * across scopes (manager closes + opens a scoped child); the manager's budget
 * recommendation is deterministic; HR is read-only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TicketStore } from '../src/bus.mjs';
import { scopeAllowed, managerReview, hrReport, MANAGER_BUDGET } from '../src/roles.mjs';

const HERE = new URL('..', import.meta.url).pathname;
const BIN = join(HERE, 'bin', 'phase-role.mjs');

function sandbox() {
  const repo = mkdtempSync(join(tmpdir(), 'phase-roles-'));
  const home = join(repo, '.phase');
  const store = new TicketStore({ home, repo });
  return { repo, home, store, cleanup: () => rmSync(repo, { recursive: true, force: true }) };
}

test('scope: unscoped tickets are the general pool; scoped tickets need the grant', () => {
  assert.equal(scopeAllowed({ meta: {} }, []), true);
  assert.equal(scopeAllowed({ meta: { scope: 'game' } }, ['game']), true);
  assert.equal(scopeAllowed({ meta: { scope: 'game' } }, ['infra']), false);
  assert.equal(scopeAllowed({ meta: { scope: 'game' } }, null), true, 'guardrail not engaged without declared scopes');
});

test('guardrail: direct request for out-of-scope ticket is REFUSED and recorded', () => {
  const { store, cleanup } = sandbox();
  try {
    const t = store.createTicket({ objective: 'game work', meta: { scope: 'game' } });
    const claim = store.claim({ ticket_id: t.id, agent: 'infra-worker', scopes: ['infra'] });
    assert.equal(claim, null); // refused
    const ev = store.readControl().find((e) => e.type === 'scope.violation');
    assert.ok(ev, 'violation recorded');
    assert.equal(ev.worker, 'infra-worker');
    assert.equal(ev.required_scope, 'game');
    assert.equal(store.getTicket(t.id).status, 'open'); // untouched
  } finally { cleanup(); }
});

test('guardrail: pool scan silently filters out-of-scope tickets (no violation spam)', () => {
  const { store, cleanup } = sandbox();
  try {
    store.createTicket({ objective: 'game work', meta: { scope: 'game' } });
    store.createTicket({ objective: 'infra work', meta: { scope: 'infra' } });
    const claim = store.claim({ agent: 'game-worker', scopes: ['game'] });
    assert.ok(claim, 'in-scope ticket claimed');
    assert.equal(claim.ticket.meta.scope, 'game');
    assert.equal(store.readControl().filter((e) => e.type === 'scope.violation').length, 0);
  } finally { cleanup(); }
});

test('delegation: manager closes the out-of-scope ticket and opens a scoped child', () => {
  const { store, cleanup } = sandbox();
  try {
    const parent = store.createTicket({ objective: 'build the tracer effect', meta: { scope: 'game' } });
    const r = store.delegate(parent.id, { toScope: 'vfx', by: 'manager' });
    assert.ok(r.child);
    assert.equal(r.child.meta.scope, 'vfx');
    assert.equal(r.child.meta.delegatedFrom, parent.id);
    assert.equal(r.child.objective, 'build the tracer effect');
    assert.equal(store.getTicket(parent.id).status, 'delegated');
    const ev = store.readControl().find((e) => e.type === 'ticket.delegated');
    assert.equal(ev.to_scope, 'vfx');
    // Only vfx-scoped workers can claim the child; game workers are refused.
    const refused = store.claim({ ticket_id: r.child.id, agent: 'game-worker', scopes: ['game'] });
    assert.equal(refused, null);
    const ok = store.claim({ ticket_id: r.child.id, agent: 'vfx-worker', scopes: ['vfx'] });
    assert.equal(ok.ticket.id, r.child.id);
  } finally { cleanup(); }
});

test('delegate refuses non-open tickets (runtime disposes, no judgment)', () => {
  const { store, cleanup } = sandbox();
  try {
    const t = store.createTicket({ objective: 'x' });
    store.finish({ id: t.id, agent: 'w', passed: false, result: 'boom' }); // failed tickets stay live
    const r = store.delegate(t.id, { toScope: 'other' });
    assert.match(r.error, /failed/);
  } finally { cleanup(); }
});

test('manager: performance → clamped budget recommendation (deterministic)', () => {
  const { store, cleanup } = sandbox();
  try {
    const a = store.createTicket({ objective: 'a' });
    const b = store.createTicket({ objective: 'b' });
    store.finish({ id: a.id, agent: 'star', passed: true, result: 'ok' });
    store.finish({ id: b.id, agent: 'wreck', passed: false, result: 'boom' });
    store.control('scope.violation', { ticket_id: a.id, worker: 'wreck', required_scope: 'x' });
    const r = managerReview(store);
    const good = r.agents['star'];
    const bad = r.agents['wreck'];
    assert.equal(good.budget_recommended, MANAGER_BUDGET.base);          // 100% success → scale 1.0
    assert.equal(bad.budget_recommended, Math.round(MANAGER_BUDGET.base * 0.6 - 0.1 * MANAGER_BUDGET.base));
    assert.ok(bad.budget_recommended >= MANAGER_BUDGET.floor);
    assert.ok(bad.budget_recommended < good.budget_recommended);
    // clamp: a disaster agent never drops below the floor
    const c = store.createTicket({ objective: 'c' });
    store.finish({ id: c.id, agent: 'disaster', passed: false, result: 'x' });
    for (let i = 0; i < 5; i++) store.control('scope.violation', { ticket_id: c.id, worker: 'disaster' });
    const r2 = managerReview(store);
    assert.equal(r2.agents['disaster'].budget_recommended, MANAGER_BUDGET.floor);
  } finally { cleanup(); }
});

test('hr: flags scope violations and is READ-ONLY (never mutates tickets)', () => {
  const { store, cleanup } = sandbox();
  try {
    const t = store.createTicket({ objective: 'game work', meta: { scope: 'game' } });
    store.claim({ ticket_id: t.id, agent: 'infra-worker', scopes: ['infra'] }); // violation
    const statusesBefore = store.listTickets().map((x) => x.status).join(',');
    const r = hrReport(store);
    const a = r.agents['infra-worker'];
    assert.equal(a.scope_violations.length, 1);
    assert.ok(a.flags.includes('scope-discipline'));
    assert.equal(store.listTickets().map((x) => x.status).join(','), statusesBefore, 'HR mutated nothing');
  } finally { cleanup(); }
});

test('CLI: manager/hr emit observability events; delegate is the only cross-scope mutation', () => {
  const { repo, home, store, cleanup } = sandbox();
  try {
    const t = store.createTicket({ objective: 'cross-scope work', meta: { scope: 'game' } });
    const run = (...args) => execFileSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env: { ...process.env, PHASE_HOME: home } });
    run('manager', '--repo', repo, '--apply');
    run('hr', '--repo', repo, '--apply');
    run('delegate', t.id, '--scope', 'vfx', '--repo', repo);
    const types = store.readControl().map((e) => e.type);
    assert.ok(types.includes('manager.review'));
    assert.ok(types.includes('hr.report'));
    assert.ok(types.includes('ticket.delegated'));
    assert.equal(store.getTicket(t.id).status, 'delegated');
  } finally { cleanup(); }
});