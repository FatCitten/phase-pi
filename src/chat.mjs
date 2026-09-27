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
  '- Prefer proposing work. When the request names concrete, doable work, emit TICKET lines — do not ask questions you could answer by doing the work in the named repo.',
  '- Ask at most ONE clarifying QUESTION, and only when the request is truly blocking (missing decision you cannot default, e.g. a choice among incompatible outcomes). Never re-ask what a previous turn already answered — use the conversation history.',
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
  const opLines = [];
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    const l = line.replace(/;.*/, '').trim();
    opLines.push(l);
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
  // Pull tickets via the shared parsePlan, but ONLY from non-op lines — a
  // QUESTION/PERMISSION/RUN line must never become a ticket objective
  // (the lenient prose fallback would otherwise turn a question into work).
  const plan = parsePlan(opLines.filter((l) => !/^(QUESTION|PERMISSION|RUN|CONSTRAINT|STOP)\b/i.test(l)).join('\n'));
  intent.tickets = plan.tickets;
  // A clarifying question is the turn's entire output: no plan alongside it.
  if (intent.question) intent.tickets = [];
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
  constructor({ repo, model, planning_model = null, base_url = resolveProvider({ prefix: 'LLM' }).base_url, home = process.env.PHASE_HOME || './.phase', id = null, resume = false }) {
    this.repo = repo;
    this.model = model ?? resolveProvider({ prefix: 'LLM', fallbackModel: 'qwen2.5:1.5b' }).model;
    this.planning_model = planning_model; // larger / different model for decomposition
    this.base_url = base_url;
    this.store = new TicketStore({ home, repo });
    const manifest = this.store.session.load();
    this.id = id || (resume && manifest?.chat_id) || `chat-${Date.now().toString(36)}`;
    this.history = []; // [{role:'user'|'assistant', content, ts}]
    // Resume: replay this conversation's turns from the data bus so the brain
    // keeps context across process spawns (the pi extension calls phase-chat
    // headless per message — without replay every turn would be amnesiac).
    if (resume) {
      try {
        for (const e of this.store.readData()) {
          if ((e.type === 'chat.user' || e.type === 'chat.assistant') && e.session === this.id) {
            this.history.push({ ts: e.ts, role: e.role, content: e.content });
          }
        }
        this.history = this.history.slice(-20);
      } catch { /* amnesia is better than a crash */ }
    }
    // Bind this chat to the repo session manifest (pi-agnostic session):
    // the chat session id is recorded so a resumed pi chat can find the
    // conversation's data-bus transcript again.
    try { this.store.session?.touch({ chat_id: this.id }); } catch { /* best-effort */ }
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
