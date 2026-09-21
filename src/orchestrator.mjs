/**
 * Phase orchestrator — an SLM drives the whole coordination loop.
 *
 * The SLM (small language model) is the "brain": it decomposes a human goal into
 * a ticket pipeline (TICKET ... / DEPENDS ...), the drain-loop scheduler runs it,
 * then the SLM reviews outcomes and decides RETRY / ADD / STOP for the next round.
 *
 * Everything an agent needs is coordinated from one seed + prompt; no training.
 * If the SLM endpoint is down, a deterministic fallback decomposes into simple
 * subtasks so the loop still "just works" offline.
 */
import { seedSystemPrompt, PHASE_ARCHITECTURE_SEED } from './phase-seeds.mjs';
import { TicketStore } from './bus.mjs';
import { sha256 } from './util.mjs';
import { resolveProvider } from './provider.mjs';

// --- minimal OpenAI-compatible chat call, reuseable for any orchestrator prompt ---
export async function slmComplete({ model, base_url, system, user, onToken = null, timeoutMs = 30000 }) {
  const provider = resolveProvider({ prefix: 'SLM', fallbackModel: 'qwen2.5:1.5b' });
  const url = `${String(base_url ?? provider.base_url).replace(/\/$/, '')}/chat/completions`;
  const body = { model: String(model ?? provider.model), temperature: 0, max_tokens: 2048, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), Number(timeoutMs ?? 30000));
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.PHASE_ALLOCATOR_API_KEY ?? 'no-key'}` },
      body: JSON.stringify(body), signal: ctl.signal
    });
    if (!r.ok) throw new Error(`model ${r.status}: ${await r.text()}`);
    const p = await r.json();
    const text = p?.choices?.[0]?.message?.content ?? '';
    if (onToken) onToken(text);
    return text.trim();
  } finally {
    clearTimeout(timer);
  }
}

// --- bounded orchestrator-plan parsing: TICKET / DEPENDS / RETRY / ADD / STOP ---
export function parsePlan(raw) {
  const plan = { tickets: [], retries: [], adds: [], stop: false };
  let last = null;
  const attachLast = (depId) => { if (last) last.depends_on.push(depId); };
  for (const rawLine of String(raw ?? '').split(/\r?\n/)) {
    const line = rawLine.replace(/;.*/, '').trim();
    if (!line) continue;
    const [op, ...rest] = line.split(/\s+/);
    const kind = op?.toUpperCase();
    const restStr = rest.join(' ').replace(/^"|"$/g, '');
    if (kind === 'STOP') { plan.stop = true; continue; }
    if (kind === 'RETRY' && rest[0]) { plan.retries.push(rest[0].replace(/[,"']/g, '')); continue; }
    if (kind === 'ADD' && restStr) { plan.adds.push({ objective: restStr, depends_on: [] }); last = null; /* adds don't join ticket deps */ continue; }
    if (kind === 'TICKET' && restStr) {
      // Support inline deps: TICKET "obj" DEPENDS T-A T-B
      const depIdx = restStr.search(/\bDEPENDS\b/i);
      const objective = (depIdx >= 0 ? restStr.slice(0, depIdx) : restStr).replace(/\s+$/, '').replace(/"+$/, '').replace(/^"+/, '');
      const t = { objective, depends_on: [] };
      if (depIdx >= 0) {
        const depPart = restStr.slice(depIdx);
        for (const m of depPart.matchAll(/T-[A-Z0-9]+/gi)) t.depends_on.push(m[0].toUpperCase());
      }
      plan.tickets.push(t); last = t;
      continue;
    }
    if (kind === 'DEPENDS') {
      for (const tok of rest) {
        const id = tok.replace(/[,"']/g, '');
        if (/^T-[A-Z0-9]+$/i.test(id)) attachLast(id.toUpperCase());
      }
      continue;
    }
  }
  // Lenient fallback: if the model answered in prose/markdown (bullet lists,
  // "**Objective 1:** ...", "### Phase 2: ...") instead of strict TICKET lines —
  // which real instruct models frequently do — still surface a usable plan.
  if (plan.tickets.length === 0) {
    for (const rawLine of String(raw ?? '').split(/\r?\n/)) {
      const line = rawLine.replace(/;.*/, '').trim();
      if (!line) continue;
      let obj = line
        .replace(/^[-*+\s]+/, '')
        .replace(/^#+\s*/, '')
        .replace(/^\*\*(Objective|Phase|Task|Step)\s*\d*\s*\*\*\s*[:.]?\s*/i, '')
        .replace(/^(Objective|Phase|Task|Step)\s*\d*\s*[:.]\s*/i, '')
        .replace(/^\d+[.:)]\s*/, '')
        .replace(/^\*\*|\*\*$/g, '')
        .trim();
      if (obj.length < 4) continue;
      if (obj.endsWith(':')) continue; // skip "Here is the plan:" headers
      if (/^(TICKET|RETRY|ADD|STOP|DEPENDS)\b/i.test(obj)) continue;
      plan.tickets.push({ objective: obj, depends_on: [] });
    }
  }
  return plan;
}

/**
 * Decompose a human goal into a ticket plan using the SLM (or fallback).
 * @returns {{tickets:Array<{objective,depends_on}>}}
 */
export async function decomposeGoal({ goal, repo, model, base_url, fallback = true }) {
  const system = seedSystemPrompt(PHASE_ARCHITECTURE_SEED);
  const user = `HUMAN GOAL (coordinate this in repo ${repo}):\n${goal}\n\n` +
    'Emit a bounded Phase ticket plan. Split the goal into a few independent, ' +
    'verifiable subtasks. Use one line per ticket: TICKET "<objective>"\n' +
    'For dependent subtasks, add afterward: DEPENDS <previous ticket-id>\n' +
    'If the goal is already small enough to do directly, emit exactly one TICKET "<goal>".\n' +
    'Use STOP when the plan is complete. Only emit TICKET, DEPENDS, and STOP.';
  try {
    const raw = await slmComplete({ model, base_url, system, user });
    return parsePlan(raw);
  } catch (e) {
    if (!fallback) throw e;
    // Deterministic fallback: split by sentence/period into a few subtasks.
    const parts = String(goal).split(/(?<=[.!?])\s+/).filter((x) => x.trim()).slice(0, 3);
    const tickets = parts.length > 1
      ? parts.map((o) => ({ objective: o.trim(), depends_on: [] }))
      : [{ objective: String(goal).trim(), depends_on: [] }];
    return { tickets, fallback: true, model_error: String(e.message || e) };
  }
}

/**
 * Decide the next round after a schedule run: which failed tickets to retry,
 * which follow-ups to add, or STOP when the pool goal is done.
 */
export async function decideNext({ goal, outcomes, repo, model, base_url, fallback = true }) {
  const done = outcomes.filter((o) => o.passed);
  const failed = outcomes.filter((o) => !o.passed);
  const system = seedSystemPrompt(PHASE_ARCHITECTURE_SEED);
  const user = `GOAL: ${goal}\n\nOUTCOMES this round (repo ${repo}):\n${JSON.stringify(outcomes.map(({ ticket_id, objective, passed, result }) => ({ ticket_id, objective, passed, result })))}\n\n` +
    'Decide next round. Emit bounded Phase instructions only:\n' +
    (failed.length ? '- RETRY <ticket-id> for each failed ticket you want rerun\n' : '') +
    (done.length ? '- ADD "<follow-up objective>" for any needed follow-up, or STOP\n' : '') +
    '- STOP if the goal is satisfied.\nOnly emit RETRY, ADD, and STOP.';
  try {
    const raw = await slmComplete({ model, base_url, system, user });
    const plan = parsePlan(raw);
    // Only allow retrying tickets that actually failed.
    plan.retries = plan.retries.filter((id) => failed.some((o) => o.ticket_id === id));
    return plan;
  } catch (e) {
    if (!fallback) throw e;
    return { retries: failed.slice(0, 1).map((o) => o.ticket_id).filter(Boolean), adds: [], stop: failed.length === 0, fallback: true, model_error: String(e.message || e) };
  }
}

export { PHASE_ARCHITECTURE_SEED, sha256 };
