#!/usr/bin/env node
/**
 * isa-state — the comprehension snapshot.
 *
 * One compact token block that gives a processor everything structural it
 * needs about a repo: what it is, what it contains, what the last change-set
 * did, and what is uncommitted right now. Built for the session LLM: the
 * smallest vocabulary that reconstructs repo state + diff.
 *
 *   repo isa-pro v0.4.0 files 21 src 3 bin 7 doc 2 test 3 plug 1 cfg 1 sha ad1cd3f dirty 1
 *   base ad1cd3f~1..HEAD +321 -709
 *   f:src/engine.mjs +121 -110 +fn -fn +imp
 *   f:src/allocator.mjs +0 -147 del
 *   f:README.md +12 -4 +doc doc
 *   w:src/engine.mjs M
 *
 * Vocabulary:
 *   repo <name> v<ver> files <n> [cat <n> ...] sha <s> dirty <n>
 *     cat in: src bin doc test plug cfg other (zero categories omitted)
 *   base <ref>..HEAD +<added> -<removed>   the compared change-set
 *   f:<path> +<a> -<d> [tokens]           per-file diff tokens
 *   w:<path> <XY>                          working tree status
 *   tokens: add del +fn -fn +cls -cls +imp -imp +exp -exp +type -type
 *           +doc -doc cfg script doc
 *
 * Pure Node stdlib. Git is the only external dependency, same as the repo.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const SELF = fileURLToPath(import.meta.url);

const CATEGORY_ORDER = ['src', 'bin', 'doc', 'test', 'plug', 'cfg', 'other'];

export function usage() {
  return `isa state — the comprehension snapshot: repo identity, structure, last
change-set, and uncommitted work, as a compact token block

Usage:
  isa state [options]

Options:
  --repo <path>      repo to snapshot            (default: cwd)
  --base <ref>       compare <base>..HEAD        (default: HEAD~1)
  --compact          one line, tokens joined
  --json             print the structured snapshot as JSON
  --help, -h         show this help`;
}

function git(repo, args) {
  try {
    return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  } catch { return null; }
}

function categoryOf(path) {
  if (path === 'package.json' || path === 'package-lock.json' || path === 'tsconfig.json') return 'cfg';
  if (path.startsWith('src/')) return 'src';
  if (path.startsWith('bin/')) return 'bin';
  if (path.startsWith('test/')) return 'test';
  if (path.startsWith('.opencode/')) return 'plug';
  if (path.startsWith('docs/') || /\.(md|markdown)$/.test(path)) return 'doc';
  return 'other';
}

function pkgField(repo, field) {
  try { return JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))[field] ?? null; } catch { return null; }
}

const FN = /^\s*(export\s+)?(default\s+)?(async\s+)?function\b/;
const CLS = /^\s*class\b/;
const IMP = /^\s*import\b/;
const EXP = /^\s*export\b/;
const TYP = /^\s*(interface|type)\b/;
const COM = /^\s*(\/\/|\/\*|\*|#|<!--)/;

/** Highest-level construct a changed line declares. */
function constructToken(body) {
  if (FN.test(body)) return 'fn';
  if (CLS.test(body)) return 'cls';
  if (IMP.test(body)) return 'imp';
  if (EXP.test(body)) return 'exp';
  if (TYP.test(body)) return 'type';
  if (COM.test(body)) return 'doc';
  return null;
}

/** Working tree statuses: XY -> status char, renames resolved. */
function work(repo) {
  const out = git(repo, ['status', '--porcelain', '-z', '--untracked-files=all']) ?? '';
  if (!out) return [];
  const entries = out.split('\0').filter(Boolean);
  const res = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const X = e[0], Y = e[1];
    let status;
    if (X === '?' && Y === '?') status = '?';
    else status = X !== ' ' ? X : (Y !== ' ' ? Y : '?');
    res.push({ path: e.slice(3), status });
    if (status === 'R') i++; // skip the rename's old-name entry
  }
  return res;
}

function baseOf(repo, base) {
  if (base) return base;
  const parent = (git(repo, ['rev-parse', '--verify', 'HEAD~1']) ?? '').trim();
  if (parent) return parent;
  return (git(repo, ['rev-list', '--max-parents=0', 'HEAD']) ?? '').trim() || null;
}

/** Per-file diff: numstat counts + construct tokens, deterministic order. */
function fileDiff(repo, base, head, path) {
  const num = (git(repo, ['diff', '--numstat', `${base}..${head}`, '--', path]) ?? '').trim();
  let added = 0, removed = 0;
  if (num) { const [a, b] = num.split('\t'); added = Number(a) || 0; removed = Number(b) || 0; }
  const tokens = [];
  const seen = new Set();
  const text = git(repo, ['diff', '-U0', `${base}..${head}`, '--', path]) ?? '';
  for (const line of text.split('\n')) {
    const sign = line[0];
    if (sign !== '+' && sign !== '-') continue;
    const tok = constructToken(line.slice(1));
    if (tok) { const t = `${sign}${tok}`; if (!seen.has(t)) { seen.add(t); tokens.push(t); } }
  }
  if (removed === 0 && added > 0) tokens.push('add');
  if (added === 0 && removed > 0) tokens.push('del');
  const cat = categoryOf(path);
  if (cat === 'cfg') tokens.push('cfg');
  if (cat === 'bin') tokens.push('script');
  if (cat === 'doc') tokens.push('doc');
  return { path, added, removed, tokens };
}

function diffSummary(repo, base) {
  const head = 'HEAD';
  const num = git(repo, ['diff', '--numstat', `${base}..${head}`]) ?? '';
  let added = 0, removed = 0;
  const paths = [];
  for (const line of num.split('\n')) {
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    added += Number(parts[0]) || 0;
    removed += Number(parts[1]) || 0;
    paths.push(parts.slice(2).join('\t'));
  }
  const files = paths.map((p) => fileDiff(repo, base, head, p));
  return { base, head, added, removed, files };
}

export function snapshot(repo = process.cwd(), base = null) {
  const root = resolve(repo);
  if (!git(root, ['rev-parse', '--git-dir'])) throw new Error(`no git repo at ${root}`);
  const files = (git(root, ['ls-files']) ?? '').split('\n').filter(Boolean);
  const counts = {};
  for (const f of files) { const c = categoryOf(f); counts[c] = (counts[c] ?? 0) + 1; }
  const sha = (git(root, ['rev-parse', '--short', 'HEAD']) ?? '').trim() || null;
  const baseRef = baseOf(root, base);
  const workList = work(root);
  return {
    repo: root,
    name: pkgField(root, 'name'),
    version: pkgField(root, 'version'),
    files: files.length,
    counts,
    sha,
    base: baseRef ? diffSummary(root, baseRef) : null,
    work: workList,
    dirty: workList.length,
  };
}

export function render(s, compact = false) {
  const sep = compact ? ' | ' : '\n';
  const lines = [];
  const counts = CATEGORY_ORDER.map((k) => (s.counts[k] ? `${k} ${s.counts[k]}` : null)).filter(Boolean).join(' ');
  lines.push(`repo ${s.name ?? '?'} v${s.version ?? '?'} files ${s.files} ${counts} sha ${s.sha ?? '-'} dirty ${s.dirty}`);
  if (s.base) {
    lines.push(`base ${s.base.base}..${s.base.head} +${s.base.added} -${s.base.removed}`);
    for (const f of s.base.files) {
      lines.push(`f:${f.path} +${f.added} -${f.removed}${f.tokens.length ? ' ' + f.tokens.join(' ') : ''}`);
    }
  }
  for (const w of s.work) lines.push(`w:${w.path} ${w.status}`);
  return lines.join(sep);
}

export async function main(argv = process.argv.slice(2)) {
  const opt = { repo: process.cwd(), base: null, compact: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { console.log(usage()); return; }
    else if (a === '--repo') opt.repo = argv[++i];
    else if (a === '--base') opt.base = argv[++i];
    else if (a === '--compact') opt.compact = true;
    else if (a === '--json') opt.json = true;
    else { console.error(`isa state: unknown option: ${a}`); process.exit(64); }
  }
  const s = snapshot(opt.repo, opt.base);
  if (opt.json) console.log(JSON.stringify(s, null, 2));
  else console.log(render(s, opt.compact));
}

function invokedDirectly() {
  try { return !!process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(SELF); } catch { return false; }
}

if (invokedDirectly()) main().catch((e) => { console.error(e); process.exit(1); });
