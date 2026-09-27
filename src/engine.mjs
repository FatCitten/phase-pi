/**
 * ISA-PRO — the engine.
 *
 * A run is confined, recorded work. No budgets, no allocation, no language,
 * no deny-mode. The engine provides three things only:
 *
 *   begin    task -> a per-run sandbox dir and the runs pointer the harness
 *            hook reads. The run is recorded on the bus; nothing is planned.
 *   exec     run a command INSIDE the sandbox. Wall-clock is bounded by a
 *            hard safety limit (not a budget): the child is killed when the
 *            limit is gone. Measured, never self-reported.
 *   end      the engine measures wall_ms itself, records the outcome, and
 *            clears the pointer. Nothing is checked against anything.
 *   status   the run facts: what is running, for how long, what it has done.
 *
 * Measurement is record-only: wall_ms, exec_count, and (when the harness
 * hook has real numbers) tool_calls and tokens are written to the ledger and
 * the bus as data. They are never enforced.
 *
 * Sandbox: bubblewrap (bwrap) jail when installed — read-only root, write only
 * to the run's sandbox dir, fresh /tmp — else plain confinement (cwd jailed,
 * env stripped, timeout enforced). Never Docker-required.
 *
 * State: .isa/runs/<id>/ (actuals.json, sandbox/, artifact.log) and
 * .isa/runs/current.json — the pointer the harness hook consumes. No daemon,
 * no long-lived process; a killed engine leaves a pointer that `end` or a new
 * `begin` supersedes.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { BusStore } from './bus.mjs';
import { snapshot, render } from '../bin/isa-state.mjs';

const BWRAP_CANDIDATES = ['/usr/bin/bwrap', '/usr/local/bin/bwrap', '/bin/bwrap'];

/** Hard safety limit for a single exec — pure runaway protection, not a budget. */
export const EXEC_TIMEOUT_MS = 15 * 60 * 1000;

function bwrapAvailable() {
  if (BWRAP_CANDIDATES.some((p) => existsSync(p))) return true;
  try { spawnSync('bwrap', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

export class Engine {
  constructor({ home = process.env.ISA_HOME || './.isa', repo = process.cwd() } = {}) {
    this.home = resolve(home);
    this.repo = resolve(repo);
    this.runsDir = join(this.home, 'runs');
    this.pointerPath = join(this.runsDir, 'current.json');
    this.bus = new BusStore({ home: this.home, repo: this.repo });
    this._bwrap = null;
  }

  _runDir(id) { return join(this.runsDir, id); }
  _actualsPath(id) { return join(this._runDir(id), 'actuals.json'); }
  _artifactPath(id) { return join(this._runDir(id), 'artifact.log'); }
  sandboxPath(id) { return join(this._runDir(id), 'sandbox'); }

  readPointer() {
    try { return JSON.parse(readFileSync(this.pointerPath, 'utf8')); } catch { return null; }
  }
  writePointer(pointer) {
    mkdirSync(this.runsDir, { recursive: true });
    writeFileSync(this.pointerPath, JSON.stringify(pointer, null, 2));
  }
  clearPointer() {
    try { rmSync(this.pointerPath, { force: true }); } catch { /* already gone */ }
  }
  readActuals(id) {
    try { return JSON.parse(readFileSync(this._actualsPath(id), 'utf8')); } catch { return {}; }
  }
  writeActuals(id, actuals) {
    mkdirSync(this._runDir(id), { recursive: true });
    writeFileSync(this._actualsPath(id), JSON.stringify(actuals, null, 2));
  }

  hasBwrap() {
    if (this._bwrap === null) this._bwrap = bwrapAvailable();
    return this._bwrap;
  }

  /**
   * Start a run. Nothing is planned: no budget, no grants, no scope. The run
   * is a sandbox plus a record. Returns { id, sandbox, pointer }.
   */
  begin({ task }) {
    if (!task || !String(task).trim()) throw new Error('a task is required');
    const id = `R-${randomUUID().slice(0, 8).toUpperCase()}`;
    mkdirSync(this.sandboxPath(id), { recursive: true });
    const pointer = {
      id,
      task: String(task),
      repo: this.repo,
      started_at: new Date().toISOString(),
      sandbox: this.sandboxPath(id),
    };
    this.writePointer(pointer);
    this.writeActuals(id, { status: 'running', started_at: pointer.started_at, wall_ms: 0, exec_count: 0, tool_calls: null, tokens: null });
    this.bus.emit('control', 'run.begin', { run: id, task: pointer.task });

    // Emit the repo snapshot at run start — the comprehension record
    try {
      const s = snapshot(this.repo);
      this.bus.emit('data', 'run.snapshot', { run: id, snapshot: render(s, true) });
    } catch { /* snapshot best-effort; never fails the run */ }

    return { id, sandbox: this.sandboxPath(id), pointer };
  }

  /**
   * Build the jailed spawn. bwrap: read-only root (including /tmp), write only
   * to the sandbox, /proc and /dev from the host, chdir into the sandbox,
   * TMPDIR pointed at a scratch dir inside it. Fallback: cwd jailed to the
   * sandbox, env stripped. Both are engine-enforced; the harness hook adds
   * deny-rules on top.
   */
  _jailSpawn(cmd, cwd) {
    const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/', TERM: 'dumb' };
    if (this.hasBwrap()) {
      const tmp = join(cwd, 'tmp');
      try { mkdirSync(tmp, { recursive: true }); } catch { /* sandbox scratch best-effort */ }
      const args = [
        '--die-with-parent',
        '--ro-bind', '/', '/', // everything read-only, incl. /tmp — writes fail closed
        '--bind', cwd, cwd,    // the run's sandbox is the only writable place
        '--proc', '/proc',
        '--dev', '/dev',
        '--chdir', cwd,
        '--',
        'sh', '-c', cmd,
      ];
      return { child: spawn('bwrap', args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...env, TMPDIR: tmp } }), kind: 'bwrap' };
    }
    return { child: spawn('sh', ['-c', cmd], { cwd, stdio: ['ignore', 'pipe', 'pipe'], env }), kind: 'confinement' };
  }

  /**
   * Run a command inside the active run's sandbox. Wall-time bounded by a
   * hard safety limit: the child gets at most `timeout` (default
   * EXEC_TIMEOUT_MS) and is SIGKILLed when it is gone. Output is captured to
   * the run artifact and the data bus. Returns { code, killed, wall_ms,
   * kind, out }.
   */
  async exec({ cmd, timeout = null }) {
    const pointer = this.readPointer();
    if (!pointer) throw new Error('no active run — isa begin first');
    const limit = Math.min(Number(timeout) || EXEC_TIMEOUT_MS, EXEC_TIMEOUT_MS);
    const started = Date.now();
    const { child, kind } = this._jailSpawn(cmd, pointer.sandbox);
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });

    let killed = false;
    const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, limit);

    const code = await new Promise((resolveCode) => {
      child.on('error', () => { clearTimeout(timer); resolveCode(126); });
      child.on('close', (c) => { clearTimeout(timer); resolveCode(c ?? 1); });
    });
    const wall = Date.now() - started;
    const actuals = this.readActuals(pointer.id);
    actuals.exec_count = (actuals.exec_count ?? 0) + 1;
    actuals.wall_ms = Date.now() - Date.parse(pointer.started_at);
    if (actuals.tool_calls === null) actuals.tool_calls = 0;
    this.writeActuals(pointer.id, actuals);
    try { appendFileSync(this._artifactPath(pointer.id), `$ ${cmd}\n${out}${out.endsWith('\n') ? '' : '\n'}\n`); } catch { /* artifact best-effort */ }
    this.bus.emit('data', 'run.exec', { run: pointer.id, cmd, kind, code: killed ? null : code, killed, wall_ms: wall, out_len: out.length });
    if (killed) this.bus.emit('control', 'run.killed', { run: pointer.id, limit_ms: limit });
    return { code: killed ? 124 : code, killed, wall_ms: wall, kind, out };
  }

  /**
   * Close the run. The engine measures wall_ms itself and records the
   * outcome; nothing is checked against anything. Returns { id, passed,
   * actuals }.
   */
  end({ passed, result = null, artifact = null }) {
    const pointer = this.readPointer();
    if (!pointer) throw new Error('no active run — isa begin first');
    const actuals = {
      ...this.readActuals(pointer.id),
      wall_ms: Date.now() - Date.parse(pointer.started_at),
      ended_at: new Date().toISOString(),
    };
    actuals.status = passed ? 'done' : 'failed';
    this.writeActuals(pointer.id, actuals);
    this.clearPointer();
    this.bus.emit('control', passed ? 'run.done' : 'run.failed', {
      run: pointer.id,
      task: pointer.task,
      passed: !!passed,
      result,
      artifact,
      wall_ms: actuals.wall_ms,
      exec_count: actuals.exec_count,
      tool_calls: actuals.tool_calls,
      tokens: actuals.tokens,
    });
    return { id: pointer.id, passed: !!passed, actuals };
  }

  /** The run facts: what is running, for how long, what it has done. */
  status() {
    const pointer = this.readPointer();
    if (!pointer) return { active: false };
    const wall = Date.now() - Date.parse(pointer.started_at);
    const actuals = { ...this.readActuals(pointer.id), wall_ms: wall };
    return {
      active: true,
      id: pointer.id,
      task: pointer.task,
      started_at: pointer.started_at,
      actuals,
      sandbox: pointer.sandbox,
    };
  }
}
