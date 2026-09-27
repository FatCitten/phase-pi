/**
 * Phase session — the one repo-based workspace manifest + worker leases.
 *
 * A session is the project being worked on, NOT a pi chat. It is pi-agent-
 * agnostic: it lives in the repo (.phase/) and survives pi session termination.
 * One session per repo; many pi chats (and CLI workers) attach to it over time.
 *
 * Two files, both coordination state (allowed in .phase/ by design):
 *   - session.json  — the manifest: identity, last goal, last ISA, linked pi
 *                     session files (tier-B resume pointers), chat session id.
 *   - workers.json  — live worker leases: pid + ticket + heartbeat, the
 *                     substrate for worker re-attach (resume-D) and the
 *                     deterministic layer of stale-writer conflict resolution.
 *
 * Pure Node stdlib. Fail-soft: every read tolerates a missing/corrupt file.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { canonicalRepositoryPath, nowIso } from './util.mjs';

/** Atomic JSON write: tmp + rename so concurrent readers never see a partial file. */
function writeJsonAtomic(path, obj) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
  try { renameSync(tmp, path); } catch (e) { try { unlinkSync(tmp); } catch { /* already gone */ } throw e; }
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

/** Is a pid alive on THIS host? Deterministic Layer-0 evidence.
 *  kill(pid,0): ESRCH = dead; EPERM = alive (owned by someone else). */
export function pidAlive(pid) {
  const p = Number(pid);
  if (!Number.isInteger(p) || p <= 0) return false;
  try { process.kill(p, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

export class SessionStore {
  /**
   * @param {string} home   phase home (default ./.phase, $PHASE_HOME)
   * @param {string} repo   repo/git root the session coordinates
   */
  constructor({ home = process.env.PHASE_HOME || './.phase', repo = process.cwd() } = {}) {
    this.root = resolve(home);
    this.repo = canonicalRepositoryPath(repo);
    this.sessionPath = join(this.root, 'session.json');
    this.workersPath = join(this.root, 'workers.json');
    this.archiveDir = join(this.root, 'archive');
    // Layer-0 GC on attach: drop leases whose pid is provably dead on this
    // host. Without this, dead workers (killed scheduler, rebooted machine)
    // lease-park in workers.json forever and poison stale-writer detection.
    // Fail-soft: constructor must never throw for coordination to boot.
    try { this.reapStale(); } catch { /* best-effort */ }
  }

  // --- Manifest ---

  /** Load the manifest, or null if this repo has no session yet. */
  load() { return existsSync(this.sessionPath) ? readJson(this.sessionPath) : null; }

  /** Load or create the manifest. Idempotent — safe to call on every attach. */
  ensure({ name, goal = null, isa = null } = {}) {
    let s = this.load();
    if (!s) {
      mkdirSync(this.root, { recursive: true });
      s = {
        schema: 'phase-session-v1',
        id: `sess-${randomUUID().slice(0, 8)}`,
        name: String(name || this.repo.split('/').filter(Boolean).pop() || 'session'),
        repo: this.repo,
        created_at: nowIso(), updated_at: nowIso(),
        goal, isa,
        chat_id: null,
        pi_sessions: [],            // newest-first pointers to pi session files (tier-B resume)
        last_activity: nowIso(),
      };
      writeJsonAtomic(this.sessionPath, s);
    }
    return s;
  }

  /** Merge a patch into the manifest and bump activity. Creates if absent.
   *  Guard: if the existing manifest belongs to a DIFFERENT repo (e.g. a
   *  shared/overridden PHASE_HOME), never mutate it — one session per repo. */
  touch(patch = {}) {
    const existing = this.load();
    if (existing && existing.repo && existing.repo !== this.repo) return existing;
    mkdirSync(this.root, { recursive: true });
    const s = this.ensure();
    const next = { ...s, ...patch };
    next.repo = this.repo;                                  // never drift
    next.updated_at = nowIso();
    next.last_activity = next.updated_at;
    if (patch.pi_session) {
      // Newest-first: a re-linked session is promoted to the front, deduped, bounded.
      next.pi_sessions = [patch.pi_session, ...(s.pi_sessions ?? []).filter((p) => p !== patch.pi_session)].slice(0, 10);
    } else {
      next.pi_sessions = s.pi_sessions ?? [];
    }
    writeJsonAtomic(this.sessionPath, next);
    return next;
  }

  // --- Worker leases ---

  _readWorkers() {
    const w = readJson(this.workersPath);
    return (w && typeof w === 'object' && !Array.isArray(w)) ? w : {};
  }

  /** Register (or refresh) a worker lease. Reaps provably-dead leases first. */
  lease(agent, { pid = process.pid, ticket_id = null, host = hostname() } = {}) {
    mkdirSync(this.root, { recursive: true });
    try { this.reapStale(); } catch { /* best-effort */ }
    const w = this._readWorkers();
    const prev = w[agent];
    w[agent] = { pid: Number(pid) || process.pid, ticket_id, agent, host,
                 started_at: prev?.started_at ?? nowIso(), heartbeat_at: nowIso() };
    writeJsonAtomic(this.workersPath, w);
    return w[agent];
  }

  /** Refresh the heartbeat of a live lease. No-op if the lease is gone. */
  heartbeat(agent) {
    const w = this._readWorkers();
    if (!w[agent]) return null;
    w[agent].heartbeat_at = nowIso();
    writeJsonAtomic(this.workersPath, w);
    return w[agent];
  }

  /** Release a lease (worker finished/died cleanly). */
  release(agent) {
    const w = this._readWorkers();
    if (!w[agent]) return false;
    delete w[agent];
    writeJsonAtomic(this.workersPath, w);
    return true;
  }

  /** All leases, with computed liveness attached. */
  leases() {
    const w = this._readWorkers();
    return Object.entries(w).map(([agent, l]) => ({ agent, ...l, alive: this.isAlive(l) }));
  }

  isAlive(lease) {
    if (!lease) return false;
    if (lease.host && lease.host !== hostname()) return null; // foreign host: ambiguous
    return pidAlive(lease.pid);
  }

  /**
   * Deterministic Layer-0 reaping: drop leases whose pid is provably dead on
   * this host. Returns the reaped agents. Foreign-host and ambiguous leases
   * are NEVER reaped here — that is Jev/human territory.
   */
  reapStale() {
    const w = this._readWorkers();
    const reaped = [];
    for (const [agent, l] of Object.entries(w)) {
      if (l.host && l.host !== hostname()) continue;           // ambiguous: skip
      if (!pidAlive(l.pid)) { reaped.push({ agent, ...l }); delete w[agent]; }
    }
    if (reaped.length) writeJsonAtomic(this.workersPath, w);
    return reaped;
  }

  // --- Archive helpers (records are written by TicketStore; listed here) ---

  listArchive() {
    if (!existsSync(this.archiveDir)) return [];
    return readdirSync(this.archiveDir).filter((f) => f.endsWith('.json')).map((f) => {
      try { return JSON.parse(readFileSync(join(this.archiveDir, f), 'utf8')); } catch { return null; }
    }).filter(Boolean);
  }
}