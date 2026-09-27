/**
 * Real-signal interrogation: does the repository actually contain evidence that
 * a ticket's objective was done? This is the layer that makes outcome BITS
 * trustworthy — geometry is exact over the bits; this module interrogates the
 * bits against git history before the geometry reads them.
 *
 * An exit code is not evidence. A commit matching the objective is.
 */
import { execFileSync } from 'node:child_process';

// Words that carry no identifying signal for commit matching.
const STOP = new Set([
  'the', 'and', 'for', 'with', 'from', 'first', 'task', 'your', 'that', 'this',
  'then', 'into', 'add', 'update', 'some', 'all', 'new', 'use', 'using',
]);

/**
 * Objective → git-log grep keyword (a basic regex). Significant words are
 * joined with '.*' so stop-word removal never breaks the phrase: the keyword
 * for "write the quarterly report" matches a commit subject that is the full
 * objective ("write the quarterly report"), not just a compressed one.
 */
export function objectiveKeyword(objective) {
  const words = String(objective || '')
    .split(/[^A-Za-z0-9-_]+/)
    .filter((w) => w.length > 3 && !STOP.has(w.toLowerCase()));
  const kw = words.slice(0, 3).join('.*');
  return kw || String(objective || '').trim().slice(0, 32);
}

export function isGitRepo(repo) {
  if (!repo) return false;
  try {
    execFileSync('git', ['-C', repo, 'rev-parse', '--is-inside-work-tree'], { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

/** First commit whose message matches the objective keyword. Returns {available, sha, keyword}. */
export function commitMatches(repo, objective, keyword = null) {
  if (!isGitRepo(repo)) return { available: false, sha: null, keyword: keyword ?? objectiveKeyword(objective) };
  const kw = keyword ?? objectiveKeyword(objective);
  try {
    const out = execFileSync('git', ['-C', repo, 'log', '--all', '--oneline', '--grep', kw, '-i', '-n', '1'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const line = out.trim();
    return { available: true, sha: line ? line.split(' ')[0] : null, keyword: kw };
  } catch {
    return { available: true, sha: null, keyword: kw };
  }
}

/**
 * Interrogate every currently-passed outcome against real signals. A pass with
 * no evidence flips to failed — the geometry then reads TRUTH, not exit codes.
 *
 * Graceful: a non-git repo has nothing to interrogate → bits are trusted
 * (surfaced as available:false), never a stall.
 *
 * @returns {{outcomes, unverified:string[], available:boolean|null, checked:number}}
 */
export function verifyOutcomes(outcomes = [], { repo = null, map = {} } = {}) {
  const latest = new Map();
  for (const o of outcomes) latest.set(o.ticket_id, o);
  const verified = [];
  const unverified = [];
  let available = null;
  let checked = 0;
  for (const o of latest.values()) {
    if (!o.passed) { verified.push(o); continue; }
    if (available === null) available = isGitRepo(repo);
    if (!available) { verified.push(o); continue; } // no signals to interrogate
    checked += 1;
    const r = commitMatches(repo, o.objective, map[o.ticket_id]);
    if (r.sha) verified.push(o);
    else {
      unverified.push(o.ticket_id);
      verified.push({ ...o, passed: false, result: `unverified: no git evidence for "${o.objective}"` });
    }
  }
  return { outcomes: verified, unverified, available, checked };
}