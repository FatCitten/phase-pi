#!/usr/bin/env node
/**
 * phase-taste — the director's dials, in-session.
 *
 *   phase-taste                     show the current dials (defaults + file, per-dial source)
 *   phase-taste set k=v [k=v ...]   validate + write dials to <repo>/phase.taste.mjs (or $PHASE_TASTE)
 *   phase-taste reset               regenerate the taste file at Phase defaults
 *
 * Dials (dotted): bands.yes, bands.no, retry.maxAttempts, followup.maxPerRound,
 * verify.beforeStop, stop.requireAllDone. Unknown keys / bad values are rejected
 * and the file is never partially written (atomic tmp+rename).
 *
 * Edits take effect on the next review — no restart, no rebuild.
 */
import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { TASTE_DEFAULTS } from '../src/jev.mjs';

function usage(msg) {
  if (msg) console.error(`error: ${msg}`);
  console.error('usage: phase-taste [--repo R] [get|set k=v ...|reset]\n' +
    '  dials: bands.yes bands.no retry.maxAttempts followup.maxPerRound verify.beforeStop stop.requireAllDone\n');
  process.exit(msg ? 2 : 0);
}

const VALIDATORS = {
  'bands.yes': (v) => (typeof v === 'number' && v > 0 && v < 1 ? v : null),
  'bands.no': (v) => (typeof v === 'number' && v > 0 && v < 1 ? v : null),
  'retry.maxAttempts': (v) => (Number.isInteger(v) && v >= 0 ? v : null),
  'followup.maxPerRound': (v) => (Number.isInteger(v) && v >= 1 ? v : null),
  'verify.beforeStop': (v) => (v === 'git-evidence' || v === 'trust-exit-code' ? v : null),
  'stop.requireAllDone': (v) => (typeof v === 'boolean' ? v : null),
};

function tastePath(repo) {
  return process.env.PHASE_TASTE || resolve(repo, 'phase.taste.mjs');
}

async function readTaste(file) {
  if (!existsSync(file)) return {};
  try {
    const m = await import(pathToFileURL(file).href);
    return m.TASTE ?? m.default ?? {};
  } catch (e) {
    console.error(`error: existing taste file does not parse (${String(e.message || e).slice(0, 120)})`);
    process.exit(2);
  }
}

// Flatten defaults + file into { dial: { value, source } }.
function flatten(taste, defaults = TASTE_DEFAULTS, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(defaults)) {
    const dial = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      flatten(taste?.[k] ?? {}, v, dial, out);
    } else {
      const fileVal = prefix ? (taste?.[prefix]?.[k] ?? undefined) : (taste?.[k] ?? undefined);
      out[dial] = { value: fileVal ?? v, source: fileVal !== undefined ? 'file' : 'default' };
    }
  }
  return out;
}

// Set a dotted dial into a plain nested object.
function setDial(obj, dial, value) {
  const parts = dial.split('.');
  let cur = obj;
  for (const p of parts.slice(0, -1)) { cur[p] = cur[p] ?? {}; cur = cur[p]; }
  cur[parts.at(-1)] = value;
}

function renderFile(taste) {
  return `/**
 * phase.taste.mjs — THE DIRECTOR'S DIALS (managed by \`phase-taste\`).
 * ${new Date().toISOString()}
 *
 * Opinionated, tasteful parts of the project; everything else runs hands-off.
 * Every line below takes effect on the NEXT review — no rebuild.
 */
export const TASTE = ${JSON.stringify(taste, null, 2)};
`;
}

async function main() {
  const argv = process.argv.slice(2);
  let repo = process.cwd();
  let cmd = 'get';
  const sets = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') repo = resolve(argv[++i]);
    else if (a === 'get' || a === 'set' || a === 'reset') cmd = a;
    else if (a === '--help' || a === '-h') usage();
    else if (a.startsWith('--')) usage(`unknown option: ${a}`);
    else sets.push(a);
  }
  if (cmd === 'set' && !sets.length) usage('set needs k=v assignments');

  const file = tastePath(repo);
  const current = await readTaste(file);

  if (cmd === 'get') {
    const flat = flatten(current);
    console.log(`taste file: ${file}${existsSync(file) ? '' : '  (absent — Phase defaults)'}`);
    for (const [dial, { value, source }] of Object.entries(flat)) {
      console.log(`${dial.padEnd(22)} ${String(JSON.stringify(value)).padEnd(10)} [${source}]`);
    }
    return;
  }

  if (cmd === 'reset') {
    writeAtomic(file, renderFile({}));
    console.log(`reset: ${file} now carries only Phase defaults`);
    return;
  }

  // set: validate every assignment before touching the file.
  const next = structuredClone(current);
  for (const s of sets) {
    const eq = s.indexOf('=');
    if (eq <= 0) usage(`bad assignment (want dial=value): ${s}`);
    const dial = s.slice(0, eq);
    const raw = s.slice(eq + 1);
    if (!VALIDATORS[dial]) usage(`unknown dial: ${dial} (valid: ${Object.keys(VALIDATORS).join(', ')})`);
    const parsed = raw === 'true' || raw === 'false' ? raw === 'true' : (isNaN(Number(raw)) || raw === '' ? raw : Number(raw));
    const value = VALIDATORS[dial](parsed);
    if (value === null) usage(`bad value for ${dial}: ${raw}`);
    setDial(next, dial, value);
  }
  const by = flatten(current).bands ?? {};
  if (next.bands && next.bands.yes <= (next.bands.no ?? by.no?.value ?? TASTE_DEFAULTS.bands.no)) {
    usage(`bands.yes (${next.bands.yes}) must be greater than bands.no (${next.bands.no ?? TASTE_DEFAULTS.bands.no})`);
  }
  writeAtomic(file, renderFile(next));
  console.log(`set ${sets.length} dial(s) in ${file} — effective on the next review`);
  for (const s of sets) console.log(`  ${s}`);
}

function writeAtomic(file, content) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, content);
  renameSync(tmp, file); // atomic; never a half-written taste
}

main().catch((e) => { console.error(String(e?.message || e)); process.exit(1); });