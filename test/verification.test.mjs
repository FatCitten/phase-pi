/**
 * Verification-layer proof: geometry is exact over the outcome BITS, and
 * phase-reconcile interrogates REAL signals (git evidence) to distinguish a
 * real completion from an exit-code lie. Together: phase can verify its work.
 *
 * Fully deterministic — no LLM, no SLM, no orchestration run.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { geometricJudgment, applyJevPolicy, TASTE_DEFAULTS } from '../src/jev.mjs';
import { TicketStore } from '../src/bus.mjs';

const HERE = new URL('..', import.meta.url).pathname;
const BIN = join(HERE, 'bin', 'phase-reconcile.mjs');
const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });

function sandbox() {
  const repo = mkdtempSync(join(tmpdir(), 'phase-verify-'));
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 'p@x');
  git(repo, 'config', 'user.name', 'p');
  const home = join(repo, '.phase');
  return { repo, home, cleanup: () => rmSync(repo, { recursive: true, force: true }) };
}

function reconcile({ repo, home }, args = []) {
  return execFileSync(process.execPath, [BIN, '--repo', repo, '--home', home, '--all', ...args],
    { encoding: 'utf8', env: { ...process.env, PHASE_HOME: home } });
}

test('bits are not verification: geometry is exact over an exit-code lie', () => {
  // A worker that exits 0 without doing the work records `passed: true`.
  // Geometry reads the bit — exact, and by design blind to content.
  const outcomes = [{ ticket_id: 'T-LIE', objective: 'write the quarterly report', passed: true, result: 'exit 0' }];
  const j = geometricJudgment(outcomes, { taste: TASTE_DEFAULTS });
  assert.equal(j.geometry.alignment, 1);
  assert.equal(applyJevPolicy(j, { outcomes, taste: TASTE_DEFAULTS }).action, 'STOP');
});

test('reconcile catches the lie: done ticket with no evidence -> unverified', () => {
  const { repo, home, cleanup } = sandbox();
  try {
    const store = new TicketStore({ home, repo });
    const t = store.createTicket({ objective: 'write the quarterly report' });
    store.finish({ id: t.id, agent: 'w', passed: true, result: 'exit 0' }); // the lie
    const out = reconcile({ repo, home });
    assert.match(out, /unverified/);          // the real signal says: nothing was done
    assert.doesNotMatch(out, /drift-ok/);
  } finally { cleanup(); }
});

test('reconcile confirms truth: done ticket with matching evidence -> drift-ok', () => {
  const { repo, home, cleanup } = sandbox();
  try {
    const store = new TicketStore({ home, repo });
    const t = store.createTicket({ objective: 'write the quarterly report' });
    store.finish({ id: t.id, agent: 'w', passed: true, result: 'exit 0' });
    execFileSync('bash', ['-c', 'echo report > report.txt && git add -A && git commit -qm "write the quarterly report"'], { cwd: repo });
    const out = reconcile({ repo, home }, ['--map', `${t.id}=write the quarterly report`]);
    assert.match(out, /drift-ok/);
    assert.match(out, /[0-9a-f]{7}/);         // evidence: the commit sha
  } finally { cleanup(); }
});

test('reconcile never fabricates: open ticket without evidence stays open', () => {
  const { repo, home, cleanup } = sandbox();
  try {
    const store = new TicketStore({ home, repo });
    const t = store.createTicket({ objective: 'do something verifiable' });
    const out = reconcile({ repo, home });
    assert.match(out, /unverified/);
    assert.equal(store.getTicket(t.id).status, 'open'); // not fabricated
  } finally { cleanup(); }
});

test('evidence-based completion: open ticket + matching commit -> reconcile verdict', () => {
  const { repo, home, cleanup } = sandbox();
  try {
    const store = new TicketStore({ home, repo });
    const t = store.createTicket({ objective: 'write the quarterly report' });
    execFileSync('bash', ['-c', 'echo x > f.txt && git add -A && git commit -qm "write the quarterly report"'], { cwd: repo });
    // NOTE: the auto-keyword drops stop-words ("write quarterly report"), which
    // fails to match a commit message containing the FULL objective — a known
    // matcher brittleness; --map is the designed precise-evidence path.
    const out = reconcile({ repo, home }, ['--map', `${t.id}=write the quarterly report`]);
    assert.match(out, /reconcile/);           // evidence exists: safe to close
    assert.doesNotMatch(out, /unverified/);
  } finally { cleanup(); }
});
// ---- in-loop interrogation: verify dial re-derives geometry from real signals ----
import { verifyOutcomes, objectiveKeyword, commitMatches, isGitRepo } from '../src/verify.mjs';
import { decideNext } from '../src/orchestrator.mjs';

test('in-loop verify: exit-0 lie flips to failed -> geometry says RETRY, never STOP', async () => {
  const { repo, home, cleanup } = sandbox();
  try {
    // No commits: an exit-0 pass has no evidence.
    const outcomes = [{ ticket_id: 'T-LIE', objective: 'write the quarterly report', passed: true, result: 'exit 0' }];
    const r = await decideNext({
      goal: 'g', outcomes, repo, model: 'm', base_url: 'http://127.0.0.1:1',
      attempts: {}, taste: TASTE_DEFAULTS,
    });
    assert.equal(r.jev.verification.dial, 'git-evidence');
    assert.deepEqual(r.jev.verification.unverified, ['T-LIE']);
    assert.equal(r.stop, false);
    assert.equal(r.action ?? r.jev.decision.action, 'RETRY'); // the lie is interrogated, not shipped
  } finally { cleanup(); }
});

test('in-loop verify: real evidence -> STOP honored', async () => {
  const { repo, home, cleanup } = sandbox();
  try {
    execFileSync('bash', ['-c', 'echo x > w.txt && git add -A && git commit -qm "write the quarterly report"'], { cwd: repo });
    const outcomes = [{ ticket_id: 'T-TRUE', objective: 'write the quarterly report', passed: true, result: 'exit 0' }];
    const r = await decideNext({
      goal: 'g', outcomes, repo, model: 'm', base_url: 'http://127.0.0.1:1',
      attempts: {}, taste: TASTE_DEFAULTS,
    });
    assert.equal(r.jev.verification.unverified.length, 0);
    assert.equal(r.stop, true);
  } finally { cleanup(); }
});

test('in-loop verify: non-git repo is trusted automatically (never a stall)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phase-nogit-'));
  try {
    const outcomes = [{ ticket_id: 'T-X', objective: 'anything', passed: true, result: 'ok' }];
    const v = verifyOutcomes(outcomes, { repo: dir });
    assert.equal(v.available, false);
    assert.deepEqual(v.unverified, []);
    const r = await decideNext({ goal: 'g', outcomes, repo: dir, model: 'm', base_url: 'http://127.0.0.1:1', taste: TASTE_DEFAULTS });
    assert.equal(r.stop, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('matcher: auto-keyword matches full-objective commit messages (>=1 of 2 natural phrasings)', () => {
  const { repo, cleanup } = sandbox(); // repo var is inside sandbox; re-scope
  try {
    const repoDir = repo;
    execFileSync('bash', ['-c', 'echo a > a.txt && git add -A && git commit -qm "write the quarterly report"'], { cwd: repoDir });
    assert.match(objectiveKeyword('write the quarterly report'), /write.*quarterly.*report/);
    assert.ok(commitMatches(repoDir, 'write the quarterly report').sha, 'natural message 1 matched');
    // a second, differently-phrased commit message containing the objective
    execFileSync('bash', ['-c', 'echo b > b.txt && git add -A && git commit -qm "Finalize: write, review, and ship the quarterly report today"'], { cwd: repoDir });
    assert.ok(commitMatches(repoDir, 'write the quarterly report').sha, 'natural message 2 also matched');
  } finally { cleanup(); }
});

test('unarchive restores a done ticket for evidence interrogation (attempts persist)', () => {
  const { repo, home, cleanup } = sandbox();
  try {
    const store = new TicketStore({ home, repo });
    const t = store.createTicket({ objective: 'write the quarterly report' });
    t.attempts = 1; // already re-run once
    execFileSync('node', ['-e', `const fs=require('fs');fs.writeFileSync(${JSON.stringify(join(home, 'tickets', t.id + '.ticket.json'))}, JSON.stringify({...${JSON.stringify(t)}, attempts:1},null,2))`], { cwd: repo });
    store.finish({ id: t.id, agent: 'w', passed: true, result: 'exit 0' });
    assert.equal(store.getTicket(t.id), null);            // archived
    const restored = store.unarchive(t.id);               // interrogation path
    assert.equal(restored.id, t.id);
    assert.equal(restored.attempts, 1);                   // budget survived the archive
    assert.ok(store.getTicket(t.id), 'back in the live store');
  } finally { cleanup(); }
});
