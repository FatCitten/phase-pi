/**
 * Phase coordination bus + ticket store.
 *
 * Two append-only event buses:
 *   - CONTROL  (control.ndjson): lifecycle signals — ticket.created,
 *             ticket.claimed, ticket.started, ticket.done, ticket.failed,
 *             worker.up / worker.down. Small, structured, cheap.
 *   - DATA     (data.ndjson): fresh-context + work output — each entry carries
 *             the repo snapshot, the per-ticket allocation (ISA), and the
 *             produced artifact/result. Heavier, machine-consumed.
 *
 * Tickets are the coordination atom: an SLM worker claims an open ticket,
 * allocates fresh context for it, does the work, and records the outcome.
 * Claiming is atomic across processes via an O_EXCL lock file.
 *
 * Pure Node stdlib. No training, no harness — just coordination.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { canonicalRepositoryPath, repositoryDomainId, gitSnapshot, nowIso } from './util.mjs';

const sha = (x) => createHash('sha256').update(Buffer.isBuffer(x) ? x : String(x)).digest('hex');

export class TicketStore {
  /**
   * @param {string} home   phase home (default ./.phase)
   * @param {string} repo   repo/git root the tickets coordinate on
   */
  constructor({ home = process.env.PHASE_HOME || './.phase', repo = process.cwd() } = {}) {
    this.root = resolve(home);
    this.repo = canonicalRepositoryPath(repo);
    this.busDir = join(this.root, 'bus');
    this.ticketDir = join(this.root, 'tickets');
    this.artifactDir = join(this.root, 'artifacts');
    for (const d of [this.busDir, this.ticketDir, this.artifactDir]) mkdirSync(d, { recursive: true });
    this.controlPath = join(this.busDir, 'control.ndjson');
    this.dataPath = join(this.busDir, 'data.ndjson');
  }

  _append(path, entry) {
    const line = JSON.stringify(entry) + '\n';
    writeFileSync(path, line, { flag: 'a' });
  }

  /** Append a control-bus event. Returns the entry with seq + ts. */
  control(type, fields = {}) {
    const entry = { seq: this._nextSeq(this.controlPath), ts: nowIso(), bus: 'control', type, repo: this.repo, ...fields };
    this._append(this.controlPath, entry);
    return entry;
  }

  /** Append a data-bus (fresh context / output) event. */
  data(type, fields = {}) {
    const entry = { seq: this._nextSeq(this.dataPath), ts: nowIso(), bus: 'data', type, repo: this.repo, ...fields };
    this._append(this.dataPath, entry);
    return entry;
  }

  _nextSeq(path) {
    if (!existsSync(path)) return 1;
    try {
      const lines = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean);
      const last = JSON.parse(lines[lines.length - 1]);
      return (Number(last.seq) ?? 0) + 1;
    } catch { return 1; }
  }

  read(path) {
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }
  readControl() { return this.read(this.controlPath); }
  readData() { return this.read(this.dataPath); }

  // --- Tickets ---

  _ticketFile(id) { return join(this.ticketDir, `${id}.ticket.json`); }
  _lockFile(id) { return join(this.ticketDir, `${id}.lock`); }

  createTicket({ objective, depends_on = [], meta = {} }) {
    const id = `T-${randomUUID().slice(0, 8).toUpperCase()}`;
    const ticket = {
      schema: 'phase-ticket-v1', id, objective: String(objective || '').trim(),
      depends_on: (Array.isArray(depends_on) ? depends_on : [depends_on]).map(String).filter(Boolean),
      repo: this.repo, status: 'open', created_at: nowIso(),
      meta: { ...meta }
    };
    if (!ticket.objective) throw new Error('ticket objective is required');
    writeFileSync(this._ticketFile(id), JSON.stringify(ticket, null, 2));
    this.control('ticket.created', { ticket_id: id, objective: ticket.objective, depends_on: ticket.depends_on });
    this.data('context.initial', { ticket_id: id, repo_snapshot: this.snapshot() });
    return ticket;
  }

  listTickets() {
    if (!existsSync(this.ticketDir)) return [];
    return readdirSync(this.ticketDir).filter((f) => f.endsWith('.ticket.json')).map((f) => {
      try { return JSON.parse(readFileSync(join(this.ticketDir, f), 'utf8')); } catch { return null; }
    }).filter(Boolean);
  }

  getTicket(id) {
    try { return JSON.parse(readFileSync(this._ticketFile(id), 'utf8')); } catch { return null; }
  }

  /**
   * Atomically claim the next claimable open ticket for a worker.
   * A ticket is claimable when it is open AND all its dependencies are done.
   * Uses an O_EXCL lock file so only one process wins; returns the ticket if
   * the caller owns the lock, else null (someone else claimed it / not ready).
   *
   * Deps make this dependency-aware: a ticket whose upstream tickets aren't done
   * is never claimed, so a linear pipeline will NOT run out of order even when
   * many workers are hammering the queue.
   */
  claim({ ticket_id = null, agent }) {
    const open = ticket_id
      ? (this.getTicket(ticket_id)?.status === 'open' ? [this.getTicket(ticket_id)] : [])
      : this.listTickets().filter((t) => t.status === 'open' && t.objective).sort((a, b) => a.created_at.localeCompare(b.created_at));
    for (const t of open) {
      if (!this._depsDone(t)) continue; // not claimable yet
      const lock = this._lockFile(t.id);
      try {
        writeFileSync(lock, `${agent}\n`, { flag: 'wx' });
      } catch { continue; } // already claimed by another process
      // we own the lock; mark in-progress
      t.status = 'in_progress'; t.claimed_by = agent; t.claimed_at = nowIso();
      writeFileSync(this._ticketFile(t.id), JSON.stringify(t, null, 2));
      this.control('ticket.claimed', { ticket_id: t.id, worker: agent, status: 'in_progress', depends_on: t.depends_on });
      return { ticket: t, lock };
    }
    return null;
  }

  /** True when every dependency of t has status 'done'. */
  _depsDone(t) {
    for (const depId of t.depends_on ?? []) {
      const dep = this.getTicket(depId);
      if (!dep || dep.status !== 'done') return false;
    }
    return true;
  }

  /** Claimable-open tickets = open tickets whose deps are all done. */
  claimable() {
    return this.listTickets().filter((t) => t.status === 'open' && t.objective && this._depsDone(t));
  }

  /** Record worker started running a claimed ticket. */
  start(id, agent) {
    const t = this.getTicket(id); if (!t) return null;
    this.control('ticket.started', { ticket_id: id, worker: agent, ts: nowIso() });
    return t;
  }

  /** Record completion/failure on control + data buses and release the lock. */
  finish({ id, agent, passed, result = null, artifact = null, lock = null }) {
    const t = this.getTicket(id); if (!t) return null;
    t.status = passed ? 'done' : 'failed';
    t.finished_at = nowIso(); t.result = result;
    if (artifact) t.artifact = artifact;
    if (lock) { try { renameSync(lock, `${lock}.done`); } catch { /* lock already released externally */ } }
    writeFileSync(this._ticketFile(id), JSON.stringify(t, null, 2));
    this.control(passed ? 'ticket.done' : 'ticket.failed', { ticket_id: id, worker: agent, passed, result, artifact });
    this.data('ticket.output', { ticket_id: id, worker: agent, passed, result, artifact });
    return t;
  }

  /** Fresh-context snapshot for a worker: repo git state + a per-ticket nonce. */
  snapshot() {
    const git = gitSnapshot(this.repo);
    return { repo: this.repo, domain_id: repositoryDomainId(this.repo), commit: git.commit, dirty: git.dirty, nonce: randomUUID() };
  }

  workerUp(agent) { this.control('worker.up', { worker: agent, ts: nowIso() }); }
  workerDown(agent) { this.control('worker.down', { worker: agent, ts: nowIso() }); }

  /**
   * Emit an arbitrary user/agent signal on a bus — the cross-process coordination
   * primitive. Any agent can append a signal other workers react to.
   * Returns the emitted entry.
   */
  emit(bus, type, fields = {}) {
    if (bus !== 'control' && bus !== 'data') throw new Error(`bus must be control or data (got ${bus})`);
    return bus === 'control' ? this.control(`sig.${type}`, fields) : this.data(`sig.${type}`, fields);
  }
}
