/**
 * ISA-PRO — the engine.
 *
 * The runtime side of the contract: runs, sandboxes, measurement, enforcement.
 * The processor (the session LLM) proposes; the engine disposes.
 *
 *   begin    task + ceilings (+ the LLM's own ISA text) -> validated
 *            allocation, a per-run sandbox dir, and the runs pointer the
 *            harness hook reads.
 *   exec     run a command INSIDE the sandbox. Wall-clock is enforced by the
 *            engine itself: the child gets only the remaining budget and is
 *            killed when it is gone. Measured, never self-reported.
 *   end      the engine measures wall_ms itself, checks every budget line,
 *            and writes the outcome. Exit 0 clean, 2 over-budget.
 *   status   the program counter: budget vs actuals so far.
 *
 * Sandbox: bubblewrap (bwrap) jail when installed — read-only root, write only
 * to the run's sandbox dir, fresh /tmp — else plain confinement (cwd jailed,
 * env stripped, timeout enforced). Never Docker-required.
 *
 * State: .isa/runs/<id>/ (alloc.json, sandbox/, actuals.json, artifact.log)
 * and .isa/runs/current.json — the pointer the harness hook consumes. No
 * daemon, no long-lived process; a killed engine leaves a pointer that `end`
 * or a new `begin` supersedes.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { allocateFromAsm, DEFAULT_BUDGETS, RESOURCES } from './allocator.mjs';
import { BusStore } from './bus.mjs';

const BWRAP_CANDIDATES = ['/usr/bin/bwrap', '/usr/local/bin/bwrap', '/bin/bwrap'];

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
  _allocPath(id) { return join(this._runDir(id), 'alloc.json'); }
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
  readAlloc(id) {
    try { return JSON.parse(readFileSync(this._allocPath(id), 'utf8')); } catch { return null; }
  }

  hasBwrap() {
    if (this._bwrap === null) this._bwrap = bwrapAvailable();
    return this._bwrap;
  }

  /**
   * Start a run. Task shape: { task, asm?, ceilings?, agent?, tools? }.
   * Returns { id, alloc, sandbox, pointer }.
   */
  begin({ task, asm = null, ceilings = null, agent = 'auto', tools = ['read', 'edit', 'test', 'bash'] }) {
    if (!task || !String(task).trim()) throw new Error('a task is required');
    const budget = { ...DEFAULT_BUDGETS };
    if (ceilings && typeof ceilings === 'object') {
      for (const [key, v] of Object.entries(ceilings)) {
        if (budget[key] !== undefined && Number.isFinite(Number(v))) budget[key] = Math.max(0, Math.round(Number(v)));
      }
    }
    const alloc = allocateFromAsm({ objective: String(task), cwd: this.repo, agent, tools, budget }, asm);
    const id = `R-${randomUUID().slice(0, 8).toUpperCase()}`;
    mkdirSync(this.sandboxPath(id), { recursive: true });
    writeFileSync(this._allocPath(id), JSON.stringify(alloc, null, 2));
    const pointer = {
      id,
      task: String(task),
      repo: this.repo,
      started_at: new Date().toISOString(),
      agent: alloc.agent,
      tools: alloc.tools,
      budget: alloc.budget,
      sandbox: this.sandboxPath(id),
    };
    this.writePointer(pointer);
    this.writeActuals(id, { status: 'running', started_at: pointer.started_at, wall_ms: 0, exec_count: 0, tool_calls: null, tokens: null, over: [] });
    this.bus.emit('control', 'run.alloc', { run: id, task: pointer.task, author: alloc.author, agent: alloc.agent, tools: alloc.tools, budget: alloc.budget });
    this.bus.emit('data', 'run.isa', { run: id, isa: alloc.asm });
    return { id, alloc, sandbox: this.sandboxPath(id), pointer };
  }

  remainingWallMs(pointer) {
    const used = Date.now() - Date.parse(pointer.started_at);
    return Math.max(0, Number(pointer.budget.wall_ms) - used);
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
   * Run a command inside the active run's sandbox. Wall-time enforced: the
   * child receives only the remaining budget and is SIGKILLed when it is
   * gone. Output is captured to the run artifact and the data bus.
   * Returns { code, killed, wall_ms, kind, out }.
   */
  async exec({ cmd, timeout = null }) {
    const pointer = this.readPointer();
    if (!pointer) throw new Error('no active run — isa begin first');
    const remaining = this.remainingWallMs(pointer);
    if (remaining <= 0) {
      this.bus.emit('control', 'run.wall.exceeded', { run: pointer.id });
      throw new Error(`wall budget exhausted (${pointer.budget.wall_ms}ms)`);
    }
    const limit = timeout == null ? remaining : Math.min(Number(timeout), remaining);
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
    return { code: killed ? 124 : code, killed, wall_ms: wall, kind, out };
  }

  /**
   * Close the run. The engine measures wall_ms itself and checks every budget
   * line it has real numbers for (wall, and hook-metered tool_calls/tokens
   * when present — never estimated as real). Returns { id, passed, actuals,
   * over, exitCode }.
   */
  end({ passed, result = null, artifact = null }) {
    const pointer = this.readPointer();
    if (!pointer) throw new Error('no active run — isa begin first');
    const actuals = {
      ...this.readActuals(pointer.id),
      wall_ms: Date.now() - Date.parse(pointer.started_at),
      ended_at: new Date().toISOString(),
    };
    const over = [];
    for (const [, key] of RESOURCES) {
      const budget = Number(pointer.budget[key]);
      const used = key === 'wall_ms' ? Number(actuals.wall_ms) : (actuals[key] === null ? null : Number(actuals[key]));
      if (used !== null && Number.isFinite(used) && Number.isFinite(budget) && used > budget) over.push(key);
    }
    actuals.status = passed ? 'done' : 'failed';
    actuals.over = over;
    this.writeActuals(pointer.id, actuals);
    this.clearPointer();
    this.bus.emit('control', passed ? 'run.done' : 'run.failed', {
      run: pointer.id,
      task: pointer.task,
      passed: !!passed,
      result,
      artifact,
      wall_ms: actuals.wall_ms,
      tool_calls: actuals.tool_calls,
      tokens: actuals.tokens,
      over,
    });
    return { id: pointer.id, passed: !!passed, actuals, over, exitCode: passed && over.length === 0 ? 0 : 2 };
  }

  /** The program counter: budget vs actuals so far. */
  status() {
    const pointer = this.readPointer();
    if (!pointer) return { active: false };
    const wall = Date.now() - Date.parse(pointer.started_at);
    const actuals = { ...this.readActuals(pointer.id), wall_ms: wall };
    return {
      active: true,
      id: pointer.id,
      task: pointer.task,
      budget: pointer.budget,
      actuals,
      remaining: Math.max(0, Number(pointer.budget.wall_ms) - wall),
      sandbox: pointer.sandbox,
    };
  }
}
