/**
 * Phase chat — the human↔AI coordination brain.
 *
 * A stateful conversation engine. A human (or agent) talks to an LLM through the
 * same provider that powers everything (OpenAI-compatible, e.g. Ollama). The
 * LLM replies in natural language AND emits bounded Phase instructions
 * (TICKET/DEPENDS/CONSTRAINT/QUESTION/PERMISSION/RUN). Each turn is persisted on
 * the data bus, so the whole conversation is a replayable, auditable artifact.
 *
 * Ambiguity → the brain asks a clarifying QUESTION back (optionally consulting a
 * larger planning-LLM first). Confirmed intent → it proposes tickets; the caller
 * decides auto vs permission gate.
 */
import { TicketStore } from './bus.mjs';
import { slmComplete, parsePlan } from './orchestrator.mjs';
import { PHASE_ARCHITECTURE_SEED } from './phase-seeds.mjs';
import { resolveProvider } from './provider.mjs';

const SYSTEM_PROMPT = [
  'You are Phase, a coordination assistant. You help a human/agent turn intent into concrete, bounded work.',
  `Objective: ${PHASE_ARCHITECTURE_SEED.objective}.`,
  'Rules:',
  '- Never invent project facts. Treat everything the user says as intent/constraint, not truth about their code.',
  '- If the request is ambiguous or needs a decision, reply with: QUESTION "<one clarifying question>" and nothing else.',
  '- To plan real work, emit bounded Phase plan lines:',
  '  TICKET "<objective>"   (one per subtask)',
  '  DEPENDS <T-n|T-ID>     (optional per ticket)',
  '  CONSTRAINT "<constraint>"   (a mid-conversation constraint; becomes a ticket)',
  '  PERMISSION            (request human approval before running)',
  '  RUN                   (proceed to schedule and execute)',
  '  STOP                  (no more work)',
  '- Use RUN for auto mode, PERMISSION to gate on the human.',
  '- Keep a plan small; prefer a few independently-verifiable tickets with explicit dependencies.'
].join('\n');

function parseIntent(raw) {
  const intent = { question: null, tickets: [], constraints: [], permission: false, run: false, stop: false };
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    const l = line.replace(/;.*/, '').trim();
    if (!l) continue;
    const [op, ...rest] = l.split(/\s+/);
    const kind = op?.toUpperCase();
    const restStr = rest.join(' ').replace(/^"(.*)"$/s, '$1');
    if (kind === 'QUESTION' && restStr) { intent.question = restStr; continue; }
    if (kind === 'CONSTRAINT' && restStr) { intent.constraints.push(restStr); continue; }
    if (kind === 'PERMISSION') { intent.permission = true; continue; }
    if (kind === 'RUN') { intent.run = true; continue; }
    if (kind === 'STOP') { intent.stop = true; continue; }
  }
  // Pull tickets via the shared parsePlan (supports TICKET "x" DEPENDS T-n).
  const plan = parsePlan(raw);
  intent.tickets = plan.tickets;
  return intent;
}

const CHAT_SYSTEM = SYSTEM_PROMPT;

const PLANNING_ACTION = (goal, repo) =>
  'Use your larger planning model to decompose this goal into a bounded Phase plan (TICKET/DEPENDS). ' +
  `GOAL: ${goal}\nREPO: ${repo}\nEmit only TICKET and DEPENDS lines and STOP.`;

export class ChatSession {
  /**
   * @param {object} opts
   *   repo, model, planning_model, base_url, home, id
   */
  constructor({ repo, model, planning_model = null, base_url = resolveProvider({ prefix: 'LLM' }).base_url, home = process.env.PHASE_HOME || './.phase', id = null }) {
    this.repo = repo;
    this.model = model ?? resolveProvider({ prefix: 'LLM', fallbackModel: 'qwen2.5:1.5b' }).model;
    this.planning_model = planning_model; // larger / different model for decomposition
    this.base_url = base_url;
    this.store = new TicketStore({ home, repo });
    this.id = id || `chat-${Date.now().toString(36)}`;
    this.history = []; // [{role:'user'|'assistant', content, ts}]
  }

  _record(role, content, extra = {}) {
    const entry = { ts: new Date().toISOString(), role, content, ...extra };
    this.history.push(entry);
    // Persist every turn on the DATA bus (replayable/auditable).
    this.store.data(`chat.${role}`, { session: this.id, role, content: String(content ?? '').slice(0, 2000), ...extra });
    return entry;
  }

  get _messages() {
    return this.history.map((h) => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: h.content }));
  }

  /**
   * Run one human turn. Returns the brain's intent (question, tickets,
   * constraints, permission, run). Also records the human turn.
   */
  async turn(userText, { permissionDefault = false } = {}) {
    if (!userText || !userText.trim()) return { question: null, tickets: [], constraints: [], permission: permissionDefault, run: false, stop: false };
    this._record('user', userText);

    const messages = [{ role: 'system', content: CHAT_SYSTEM }, ...this._messages.slice(0, 40)];
    let raw;
    try {
      raw = await slmComplete({ model: this.model, base_url: this.base_url, system: CHAT_SYSTEM, user: messages.at(-1).content, timeoutMs: 30000 });
    } catch (e) {
      // offline fallback: treat as a question so we never invent work silently
      return { question: `(offline) The model endpoint is unavailable. Tell me what to do directly.`, tickets: [], constraint: [], permission: true, run: false, stop: false, model_error: String(e.message || e), fallback: true };
    }

    let intent = parseIntent(raw);
    // If the brain wants to decompose via a larger planning model, call it.
    if (intent.question && this.planning_model && this.planning_model !== this.model) {
      try {
        const planRaw = await slmComplete({ model: this.planning_model, base_url: this.base_url, system: PLANNING_ACTION(userText, this.repo), user: userText });
        const planIntent = parseIntent(planRaw);
        if (planIntent.tickets.length) intent = planIntent;
      } catch { /* keep original */ }
    }
    // Assistant reply for the log: the raw, plus a short summary of the plan.
    this._record('assistant', raw, { tickets: intent.tickets.map((t) => t.objective), question: intent.question });
    return { ...intent, raw, session: this.id };
  }
}

export { parseIntent, CHAT_SYSTEM };
