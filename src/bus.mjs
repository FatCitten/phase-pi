/**
 * ISA-PRO — the bus.
 *
 * Two append-only ndjson logs, one machine truth:
 *   control.ndjson — decisions and signals (alloc.decision, any sig.*)
 *   data.ndjson    — payloads (emitted ISA text, actuals)
 *
 * The bus is a log, not a state machine. No lifecycle types, no ticket
 * semantics, no judgment. Anything may emit; everything emitted is kept.
 * Replay the log and you have the full record.
 *
 * seq is assigned by tail-read, so appends stay O(1) regardless of bus size.
 * Pure Node stdlib.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { nowIso } from './util.mjs';

export class BusStore {
  /**
   * @param {string} home  ISA home (default $ISA_HOME or ./.isa)
   * @param {string} repo  working dir recorded on every event
   */
  constructor({ home = process.env.ISA_HOME || './.isa', repo = process.cwd() } = {}) {
    this.root = resolve(home);
    this.repo = resolve(repo);
    this.busDir = join(this.root, 'bus');
    this.controlPath = join(this.busDir, 'control.ndjson');
    this.dataPath = join(this.busDir, 'data.ndjson');
  }

  _path(bus) {
    if (bus === 'control') return this.controlPath;
    if (bus === 'data') return this.dataPath;
    throw new Error(`bus must be control or data (got ${bus})`);
  }

  _append(path, entry) {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, JSON.stringify(entry) + '\n', { flag: 'a' });
  }

  /**
   * O(1) sequence assignment: read only the file tail, where the last seq
   * lives. Whole-file reads made every append O(bus size).
   */
  _nextSeq(path) {
    if (!existsSync(path)) return 1;
    try {
      const size = statSync(path).size;
      const len = Math.min(size, 4096);
      const buf = Buffer.alloc(len);
      const fd = openSync(path, 'r');
      try { readSync(fd, buf, 0, len, size - len); } finally { closeSync(fd); }
      const lines = buf.toString('utf8').split('\n').filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const last = JSON.parse(lines[i]);
          if (last && last.seq != null) return (Number(last.seq) || 0) + 1;
        } catch { /* truncated tail line — fall back to an earlier one */ }
      }
      return 1;
    } catch { return 1; }
  }

  /** Append a signal to a bus. Returns the full event. */
  emit(bus, type, fields = {}) {
    const path = this._path(bus);
    const entry = { seq: this._nextSeq(path), ts: nowIso(), bus, type: `sig.${type}`, repo: this.repo, ...fields };
    this._append(path, entry);
    return entry;
  }

  /** All events of a bus, oldest first. Missing bus reads as empty. */
  read(bus) {
    const path = this._path(bus);
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }

  readControl() { return this.read('control'); }
  readData() { return this.read('data'); }

  /** Last n events of a bus, oldest first. */
  tail(bus, n = 40) {
    return this.read(bus).slice(-Math.max(0, Number(n) || 0));
  }
}
