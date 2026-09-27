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
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync, renameSync, unlinkSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { canonicalRepositoryPath, repositoryDomainId, gitSnapshot, nowIso } from './util.mjs';
import { scopeAllowed } from './roles.mjs';
import { SessionStore } from './session.mjs';

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
    this.archiveDir = join(this.root, 'archive');
    for (const d of [this.busDir, this.ticketDir, this.artifactDir, this.archiveDir]) mkdirSync(d, { recursive: true });
    this._archiveCache = null;   // listArchive memoization (see listArchive)
    this._archiveCacheKey = null;
    this.controlPath = join(this.busDir, 'control.ndjson');
    this.dataPath = join(this.busDir, 'data.ndjson');
    // The session manifest is the repo-based workspace: auto-created on the
    // first ticket-store use, updated on lifecycle events. One session per repo.
    this.session = new SessionStore({ home: this.root, repo: this.repo });
    this.session.ensure();
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
    // Read ONLY the file tail: seq lives in the last line. Reading the whole
    // file per append made every event O(bus-filesize) — on a 13MB bus that
    // is a 13MB disk read per event, which compounded the worker-flap flood
    // (each spam event made all future events slower). Tail keeps O(1).
    try {
      const size = statSync(path).size;
      const len = Math.min(size, 4096);
      const buf = Buffer.alloc(len);
      const fd = openSync(path, 'r');
      try { readSync(fd, buf, 0, len, size - len); } finally { closeSync(fd); }
      const lines = buf.toString('utf8').split('\n').filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        try { const last = JSON.parse(lines[i]); if (last && last.seq != null) return (Number(last.seq) || 0) + 1; } catch { /* truncated tail line — fall back to earlier */ }
      }
      return 1;
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
    try { this.session.touch({ goal: ticket.objective }); } catch { /* session is best-effort */ }
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
   * A ticket is claimable when it is open AND all its dependencies are done AND
   * (when the worker declared scopes) the ticket's scope is granted.
   * Uses an O_EXCL lock file so only one process wins; returns the ticket if
   * the caller owns the lock, else null (someone else claimed it / not ready).
   *
   * Scope guardrail: a direct request for an out-of-scope ticket is REFUSED and
   * recorded as a `scope.violation`; pool scans silently filter (a violation is
   * only logged when the agent insisted). The only path across scopes is
   * manager delegation.
   *
   * Deps make this dependency-aware: a ticket whose upstream tickets aren't done
   * is never claimed, so a linear pipeline will NOT run out of order even when
   * many workers are hammering the queue.
   */
  claim({ ticket_id = null, agent, scopes = null }) {
    const open = ticket_id
      ? (this.getTicket(ticket_id)?.status === 'open' ? [this.getTicket(ticket_id)] : [])
      : this.listTickets().filter((t) => t.status === 'open' && t.objective).sort((a, b) => a.created_at.localeCompare(b.created_at));
    for (const t of open) {
      if (!t) continue;
      if (!scopeAllowed(t, scopes)) {
        if (ticket_id) this.control('scope.violation', { ticket_id: t.id, worker: agent, required_scope: t.meta?.scope ?? null });
        continue;
      }
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

  /**
   * DELEGATION — the only sanctioned path for work to cross scopes.
   * The manager closes the out-of-scope ticket and opens a scoped child with
   * the same objective; the child is claimed by workers granted that scope.
   * Deterministic: statuses and events only, no judgment.
   */
  delegate(id, { toScope, by = 'manager' } = {}) {
    const t = this.getTicket(id);
    if (!t) return { error: `no ticket ${id}` };
    if (t.status !== 'open') return { error: `ticket ${id} is ${t.status}; only open tickets can be delegated` };
    const child = this.createTicket({
      objective: t.objective,
      depends_on: [],
      meta: { ...t.meta, scope: toScope, delegatedFrom: id },
    });
    t.status = 'delegated';
    t.finished_at = nowIso();
    t.result = `delegated to scope "${toScope}" via ${child.id}`;
    writeFileSync(this._ticketFile(id), JSON.stringify(t, null, 2));
    this.control('ticket.delegated', { ticket_id: id, child: child.id, to_scope: toScope, by });
    return { child, parent: t };
  }

  /** True when every dependency of t has status 'done'.
   *  Dep tokens that are not ticket IDs fall back to objective substring
   *  matching (e.g. depends_on: ["011"] matches a ticket whose objective
   *  contains "011"), so hand-written DAGs can use human task numbers.
   *  Matching also covers ARCHIVED tickets: a dependency that ran and was
   *  compacted to .phase/archive before a dependent was created must still
   *  count as done — otherwise the dependent is blocked forever (a drain
   *  loop would spin on it). Both archive shapes are tolerated:
   *  { schema: 'phase-archive-v1', ticket: {...} } and legacy bare tickets. */
  _depsDone(t) {
    for (const depId of t.depends_on ?? []) {
      let dep = this.getTicket(depId);
      if (!dep) {
        const needle = String(depId);
        dep = this.listTickets().find((d) => d.id !== t.id && (d.objective ?? '').includes(needle));
        if (!dep) dep = this._archivedDone(depId, needle);
      }
      if (!dep || dep.status !== 'done') return false;
    }
    return true;
  }

  /** Find a DONE archived ticket by id or objective substring. Tolerates both
   *  archive record shapes; ignores unreadable/foreign files. */
  _archivedDone(idOrNeedle, objectiveNeedle = null) {
    for (const rec of this.listArchive()) {
      const t = rec?.ticket ?? rec; // phase-archive-v1 wrapper or legacy bare ticket
      if (!t || typeof t !== 'object' || t.status !== 'done') continue;
      if (idOrNeedle && t.id === idOrNeedle) return t;
      if (objectiveNeedle && (t.objective ?? '').includes(objectiveNeedle)) return t;
    }
    return null;
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

  /** Record completion/failure on control + data buses and release the lock.
   *  Done (passed) tickets are compacted to the archive (§8 of docs/sessions.md):
   *  the digest retains essential context (result, artifact, worker); the bulk
   *  ticket file is removed so the live store and views stay small. */
  finish({ id, agent, passed, result = null, artifact = null, lock = null }) {
    const t = this.getTicket(id); if (!t) return null;
    t.status = passed ? 'done' : 'failed';
    t.finished_at = nowIso(); t.result = result;
    if (artifact) t.artifact = artifact;
    if (lock) { try { renameSync(lock, `${lock}.done`); } catch { /* lock already released externally */ } }
    writeFileSync(this._ticketFile(id), JSON.stringify(t, null, 2));
    this.control(passed ? 'ticket.done' : 'ticket.failed', { ticket_id: id, worker: agent, passed, result, artifact });
    this.data('ticket.output', { ticket_id: id, worker: agent, passed, result, artifact });
    try { this.session.touch({}); } catch { /* session is best-effort */ }
    if (passed) this.archiveTicket(id, { worker: agent });
    return t;
  }

  /** Compact a done ticket into .phase/archive/<id>.json and remove it from
   *  the live store. Never archives failed/open tickets. Fail-soft: an archive
   *  error must not fail the worker's finish path. */
  archiveTicket(id, { worker = null } = {}) {
    const t = this.getTicket(id);
    if (!t || t.status !== 'done') return null;
    const record = {
      schema: 'phase-archive-v1', archived_at: nowIso(),
      ticket: t,
      digest: {
        objective: t.objective, result: t.result ?? null, artifact: t.artifact ?? null,
        worker: worker ?? t.claimed_by ?? null, finished_at: t.finished_at ?? null,
      },
    };
    try {
      writeFileSync(join(this.archiveDir, `${id}.json`), JSON.stringify(record, null, 2));
      this.control('ticket.archived', { ticket_id: id, worker, archive: join(this.archiveDir, `${id}.json`) });
    } catch { /* archive is best-effort; the ticket file stays */ return record; }
    try { unlinkSync(this._ticketFile(id)); } catch { /* already gone */ }
    for (const l of [this._lockFile(id), `${this._lockFile(id)}.done`]) { try { unlinkSync(l); } catch { /* gone */ } }
    return record;
  }

  /** Restore an archived done ticket to the live store (evidence interrogation:
   *  a done ticket whose completion lacked evidence may be re-run). Fail-soft. */
  unarchive(id) {
    const p = join(this.archiveDir, `${id}.json`);
    try {
      const r = JSON.parse(readFileSync(p, 'utf8'));
      const t = r.ticket ?? r;
      writeFileSync(this._ticketFile(id), JSON.stringify(t, null, 2));
      unlinkSync(p);
      this.control('ticket.unarchived', { ticket_id: id });
      return t;
    } catch { return null; }
  }

  /** All archived (compacted done) ticket records, oldest first.
   *  Memoized by archive-dir mtime: claimable() consults the archive on every
   *  dep check (see _depsDone), and re-reading + re-parsing every archived
   *  file per check measured 3.59ms/call vs 0.081ms live-scan (44x). The
   *  mtime key invalidates on every archive write/delete. */
  listArchive() {
    let mtime = 0;
    try { mtime = statSync(this.archiveDir).mtimeMs; } catch { return []; }
    if (this._archiveCache && this._archiveCacheKey === mtime) return this._archiveCache;
    const recs = readdirSync(this.archiveDir).filter((f) => f.endsWith('.json')).map((f) => {
      try { return JSON.parse(readFileSync(join(this.archiveDir, f), 'utf8')); } catch { return null; }
    }).filter(Boolean);
    this._archiveCache = recs;
    this._archiveCacheKey = mtime;
    return recs;
  }

  /** Retry a failed ticket: back to open, claim cleared, re-claimable by the
   *  next drain. Deterministic runtime op — the console/agent may REQUEST a
   *  retry, but the transition happens here. Returns the ticket or null. */
  retryTicket(id, { agent = 'human' } = {}) {
    const t = this.getTicket(id);
    if (!t || t.status !== 'failed') return null;
    t.status = 'open'; t.claimed_by = null; delete t.finished_at;
    t.retries = (t.retries ?? 0) + 1;
    writeFileSync(this._ticketFile(id), JSON.stringify(t, null, 2));
    // Defensive: clear any stale claim lock from the failed attempt, else the
    // retried ticket would be un-claimable forever.
    for (const f of [this._lockFile(id), `${this._lockFile(id)}.done`]) { try { unlinkSync(f); } catch { /* gone */ } }
    this.control('ticket.retry', { ticket_id: id, agent, retries: t.retries });
    try { this.session.touch({}); } catch { /* best-effort */ }
    return t;
  }

  /** Steal an in_progress ticket whose lease is deterministically dead
   *  (Layer-0 only: provable via the worker lease table). Never steals a
   *  live or foreign-host lease — that is Jev/human territory. */
  stealTicket(id, { agent = 'human', lease = null } = {}) {
    const t = this.getTicket(id);
    if (!t || t.status !== 'in_progress') return null;
    const l = lease ?? (this.session.leases().find((x) => x.ticket_id === id) ?? null);
    if (l && (l.alive === true || l.alive === null)) return { stolen: false, reason: 'lease alive or ambiguous' };
    t.status = 'open'; t.claimed_by = null; delete t.claimed_at;
    writeFileSync(this._ticketFile(id), JSON.stringify(t, null, 2));
    for (const f of [this._lockFile(id), `${this._lockFile(id)}.done`]) { try { unlinkSync(f); } catch { /* gone */ } }
    this.control('sig.steal', { ticket_id: id, agent, prior_worker: l?.agent ?? null, lease_dead: l ? l.alive === false : null });
    try { this.session.touch({}); } catch { /* best-effort */ }
    return { stolen: true, ticket: t };
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
