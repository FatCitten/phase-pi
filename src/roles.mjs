/**
 * Roles & guardrails — deterministic scope enforcement for phase.
 *
 * Architecture: the runtime disposes. Scope is enforced in TicketStore.claim —
 * never by an agent's judgment. An agent outside its scope cannot DO the work;
 * the only path across scopes is DELEGATION by the manager role.
 *
 * Roles:
 *   worker  — claims tickets within its granted scopes. Refuses the rest
 *             (direct requests record a `scope.violation`; pool scans silently
 *             filter so a violation is only logged when the agent insisted).
 *   manager — observes performance (control bus) and recommends resource/budget
 *             adjustments; the ONLY role that mutates work across scopes, and
 *             only via delegation (a scoped child ticket, never re-scope in place).
 *   hr      — observes behavior (violations, flakiness) and reports. HR is
 *             read-only by construction: no hr function mutates any ticket.
 */
import { nowIso } from './util.mjs';

export const MANAGER_BUDGET = Object.freeze({
  base: 24000,      // tokens at neutral performance (matches the worker default)
  floor: 8000,      // a flagged agent is never starved below this
  ceiling: 48000,   // the allocator's hard ceiling; the VM enforces it
});

/** Is this ticket inside the worker's granted scopes? Unscoped = general pool. */
export function scopeAllowed(ticket, scopes = null) {
  const scope = ticket?.meta?.scope;
  if (!scope) return true;
  if (scopes === null || scopes === undefined) return true; // enforcement not engaged
  return (Array.isArray(scopes) ? scopes : [scopes]).includes(scope);
}

/**
 * Manager review: per-agent performance from the control bus → recommended
 * token budget. Deterministic, documented, clamped:
 *
 *   success_rate = done / (done + failed)
 *   scale        = 0.6 + 0.4 * success_rate            (0.6 … 1.0)
 *   penalty      = min(0.3, 0.1 * scope_violations)
 *   budget       = clamp(base * (scale - penalty), floor, ceiling)
 *
 * The manager RECOMMENDS; the allocator enforces ceilings (seed invariant).
 */
export function managerReview(store, { base = MANAGER_BUDGET.base, floor = MANAGER_BUDGET.floor, ceiling = MANAGER_BUDGET.ceiling } = {}) {
  const events = store.readControl();
  const agg = {};
  const agent = (w) => (agg[w] ??= { done: 0, failed: 0, requeues: 0, violations: 0 });
  for (const ev of events) {
    if (ev.type === 'ticket.done' && ev.worker) agent(ev.worker).done += 1;
    else if (ev.type === 'ticket.failed' && ev.worker) agent(ev.worker).failed += 1;
    else if (ev.type === 'ticket.requeued' && ev.worker) agent(ev.worker).requeues += 1;
    else if (ev.type === 'scope.violation' && ev.worker) agent(ev.worker).violations += 1;
  }
  const agents = {};
  for (const [w, a] of Object.entries(agg)) {
    const total = a.done + a.failed;
    const successRate = total ? a.done / total : 1;
    const scale = 0.6 + 0.4 * successRate;
    const penalty = Math.min(0.3, 0.1 * a.violations);
    const budget = Math.round(Math.min(ceiling, Math.max(floor, base * (scale - penalty))));
    agents[w] = { ...a, success_rate: Number(successRate.toFixed(3)), budget_recommended: budget };
  }
  return { agents, policy: 'scale = 0.6 + 0.4*success; penalty = min(0.3, 0.1*violations); clamp(floor, ceiling)' };
}

/**
 * HR report: behavior audit from the control bus. READ-ONLY — no hr function
 * may mutate ticket state; HR observes and flags, the human decides.
 */
export function hrReport(store) {
  const events = store.readControl();
  const rep = {};
  const agent = (w) => (rep[w] ??= { scope_violations: [], requeues: 0, failed: 0, done: 0, flags: [] });
  for (const ev of events) {
    if (ev.type === 'scope.violation' && ev.worker) {
      agent(ev.worker).scope_violations.push({ ticket_id: ev.ticket_id, required_scope: ev.required_scope, ts: ev.ts });
    } else if (ev.type === 'ticket.requeued' && ev.worker) {
      agent(ev.worker).requeues += 1;
    } else if (ev.type === 'ticket.failed' && ev.worker) {
      agent(ev.worker).failed += 1;
    } else if (ev.type === 'ticket.done' && ev.worker) {
      agent(ev.worker).done += 1;
    }
  }
  for (const [w, a] of Object.entries(rep)) {
    if (a.scope_violations.length >= 1) a.flags.push('scope-discipline');
    const total = a.done + a.failed;
    if (total >= 2 && a.failed / total > 0.5) a.flags.push('flaky');
    if (a.requeues >= 3) a.flags.push('retry-loop');
  }
  return { agents: rep, generated_at: nowIso(), note: 'HR is read-only; flags inform the manager (budget) and the human (attention)' };
}