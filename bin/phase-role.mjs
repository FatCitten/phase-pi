#!/usr/bin/env node
/**
 * phase-role — the observation roles: manager and hr.
 *
 *   phase-role manager [--repo R] [--home H] [--apply]
 *       Per-agent performance from the control bus → recommended token budgets.
 *       Deterministic and clamped (see MANAGER_BUDGET). --apply also emits the
 *       `manager.review` control event; it never mutates ticket state.
 *
 *   phase-role hr [--repo R] [--home H] [--apply]
 *       Behavior audit: scope violations, flakiness, retry loops → flags.
 *       HR is read-only by construction; --apply only emits `hr.report`.
 *
 *   phase-role delegate T-XXXX --scope SCOPE [--repo R] [--home H] [--by NAME]
 *       MANAGER-ONLY mutation: the only sanctioned way work crosses scopes.
 *       Closes the ticket and opens a scoped child with the same objective.
 *
 * Roles are guardrails: workers refuse out-of-scope work (scope.violation);
 * delegation is the only path across scopes; HR never mutates anything.
 */
import { TicketStore } from '../src/bus.mjs';
import { managerReview, hrReport, MANAGER_BUDGET } from '../src/roles.mjs';
import { resolve } from 'node:path';

function usage(msg) {
  if (msg) console.error(`error: ${msg}`);
  console.error('usage: phase-role manager|hr [--repo R] [--home H] [--apply]\n' +
    '       phase-role delegate T-XXXX --scope SCOPE [--repo R] [--home H] [--by AGENT]\n');
  process.exit(msg ? 2 : 0);
}

function parseArgs(argv) {
  const opt = { repo: process.cwd(), home: process.env.PHASE_HOME || './.phase', apply: false, cmd: null, ticket: null, scope: null, by: 'manager' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') opt.repo = resolve(argv[++i]);
    else if (a === '--home') opt.home = argv[++i];
    else if (a === '--apply') opt.apply = true;
    else if (a === '--scope') opt.scope = argv[++i];
    else if (a === '--by') opt.by = argv[++i];
    else if (a === 'manager' || a === 'hr' || a === 'delegate') opt.cmd = a;
    else if (a.startsWith('T-') && !opt.ticket) opt.ticket = a;
    else if (a === '--help' || a === '-h') usage();
    else usage(`unknown arg: ${a}`);
  }
  if (!opt.cmd) usage('need a command: manager | hr | delegate');
  if (opt.cmd === 'delegate' && (!opt.ticket || !opt.scope)) usage('delegate needs T-XXXX and --scope SCOPE');
  return opt;
}

function main() {
  const opt = parseArgs(process.argv.slice(2));
  const store = new TicketStore({ home: opt.home, repo: opt.repo });

  if (opt.cmd === 'manager') {
    const review = managerReview(store);
    console.log(`MANAGER REVIEW  (policy: ${review.policy})`);
    console.log(`budget policy: base=${MANAGER_BUDGET.base} floor=${MANAGER_BUDGET.floor} ceiling=${MANAGER_BUDGET.ceiling}`);
    const entries = Object.entries(review.agents);
    if (!entries.length) console.log('  (no agent activity on the control bus yet)');
    for (const [w, a] of entries) {
      console.log(`  ${w.padEnd(16)} done=${a.done} failed=${a.failed} requeues=${a.requeues} violations=${a.violations} success=${(a.success_rate * 100).toFixed(0)}%  -> budget ${a.budget_recommended}`);
    }
    if (opt.apply) {
      store.control('manager.review', { agents: review.agents, policy: review.policy, base: MANAGER_BUDGET.base });
      console.log('emitted: manager.review (recommendation only — the allocator enforces ceilings)');
    } else console.log('(dry-run: rerun with --apply to emit the manager.review event)');
    return;
  }

  if (opt.cmd === 'hr') {
    const report = hrReport(store);
    console.log(`HR REPORT  (read-only; generated ${report.generated_at})`);
    const entries = Object.entries(report.agents);
    if (!entries.length) console.log('no agent behavior recorded yet');
    for (const [w, a] of entries) {
      const flagged = a.flags.length ? ` FLAGS: ${a.flags.join(', ')}` : '';
      console.log(`  ${w.padEnd(16)} violations=${a.scope_violations.length} requeues=${a.requeues} done=${a.done} failed=${a.failed}${flagged}`);
      for (const v of a.scope_violations) console.log(`    ${v.ts} refused ${v.ticket_id} (needs scope "${v.required_scope}")`);
    }
    if (opt.apply) {
      store.control('hr.report', { agents: report.agents });
      console.log('emitted: hr.report');
    } else console.log('(dry-run: rerun with --apply to emit the hr.report event)');
    return;
  }

  if (opt.cmd === 'delegate') {
    const r = store.delegate(opt.ticket, { toScope: opt.scope, by: opt.by });
    if (r.error) { console.error(`error: ${r.error}`); process.exit(2); }
    console.log(`delegated ${opt.ticket} -> scope "${opt.scope}"`);
    console.log(`  child: ${r.child.id}  (objective: ${r.child.objective})`);
    console.log(`  parent: closed as "delegated"; only ${opt.scope}-scoped workers may claim ${r.child.id}`);
    return;
  }
}

main();