/**
 * Offline validation of the conversational work-specification path
 * (docs/sessions.md step 4): ChatSession intent parsing + the PERMISSION gate
 * in phase-chat headless (propose → ids, no scheduling) + `--drain` pickup.
 *
 * Deterministic: the "brain" is an in-process OpenAI-compatible stub server,
 * so no model endpoint is needed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseIntent, ChatSession } from '../src/chat.mjs';
import { TicketStore } from '../src/bus.mjs';

/** fetch() keep-alive sockets hold the stub open forever — kill them. */
function closeServer(server) {
  server.closeAllConnections?.();
  server.close();
  server.unref();
}

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function stubBrain(reply) {
  return new Promise((resolveStub) => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let prompt = '';
        try { body = JSON.parse(body); } catch { /* not json */ }
        // Echo the last user message back so tests can assert on the prompt too.
        const user = Array.isArray(body?.messages)
          ? body.messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n')
          : '';
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: typeof reply === 'function' ? reply(user) : reply } }],
        }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolveStub(server));
  });
}

function phaseBin(name) { return join(ROOT, 'bin', `phase-${name}.mjs`); }

function runBin(bin, argv, env, cwd, timeoutMs = 30_000) {
  return new Promise((resolveRun, rejectRun) => {
    const p = spawn(process.execPath, [join(ROOT, 'bin', `phase-${bin}.mjs`), ...argv], { env, cwd, timeout: timeoutMs });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => (code === 0 ? resolveRun(out) : rejectRun(new Error(`exit ${code}: ${out}`))));
  });
}

test('parseIntent: bounded instructions only (TICKET/DEPENDS/PERMISSION/QUESTION)', () => {
  const i = parseIntent('TICKET "write the readme"\nTICKET "write the changelog"\nDEPENDS T-1\nPERMISSION\nSTOP');
  assert.equal(intentCount(i.tickets), 2);
  assert.equal(i.permission, true);
  assert.equal(i.question, null);
  assert.deepEqual(i.tickets[1].depends_on, ['T-1']);

  const q = parseIntent('QUESTION "markdown or rst?"');
  assert.equal(q.question, 'markdown or rst?');
  assert.equal(intentCount(q.tickets), 0);
});

test('ChatSession turn: QUESTION round-trips; tickets stay un-created until approved', async () => {
  const server = await stubBrain('QUESTION "which format?"');
  const port = server.address().port;
  const repo = mkdtempSync(join(tmpdir(), 'phase-chatq-'));
  const chat = new ChatSession({ repo, model: 'stub', base_url: `http://127.0.0.1:${port}/v1`, home: join(repo, '.phase') });
  const intent = await chat.turn('add docs', { permissionDefault: true });
  assert.equal(intent.question, 'which format?');
  assert.equal(chat.store.listTickets().length, 0, 'a QUESTION must not create tickets');
  const m = chat.store.session.load();
  assert.equal(m.chat_id, chat.id, 'chat session linked into the repo session manifest');
  closeServer(server);
});

test('headless PERMISSION gate: creates tickets with ids, does not schedule; --drain sees them', async () => {
  const server = await stubBrain('TICKET "write the readme"\nTICKET "write the changelog"\nPERMISSION\nSTOP');
  const port = server.address().port;
  const repo = mkdtempSync(join(tmpdir(), 'phase-chatp-'));
  const home = join(repo, '.phase');
  const env = {
    ...process.env,
    PHASE_LLM_BASE_URL: `http://127.0.0.1:${port}/v1`,
    PHASE_LLM_MODEL: 'stub',
    PHASE_HOME: home,
  };

  const out = await runBin('chat', ['--repo', repo, '--prompt', 'add docs', '--gate', 'permission'], env);
  assert.match(out, /\[gate\] pending 2 ticket\(s\): T-[A-F0-9]+ T-[A-F0-9]+/);
  const ids = /\[gate\] pending 2 ticket\(s\): ([^\n]+)/.exec(out)[1].trim().split(/\s+/);
  for (const id of ids) assert.ok(existsSync(join(home, 'tickets', `${id}.ticket.json`)));

  // The gate held: nothing scheduled, no leases, no archive yet.
  let workers = {};
  try { workers = JSON.parse(readFileSync(join(home, 'workers.json'), 'utf8')); } catch { /* no leases yet: fine */ }
  assert.equal(workers.w1, undefined);

  // Human approves → deterministic drain (dry-run here) picks the pending store up.
  const drain = await runBin('schedule', ['--repo', repo, '--drain', '--dry-run'], env);
  assert.match(drain, /drain: 2 live ticket\(s\)/);

  closeServer(server);
});

function intentCount(t) { return Array.isArray(t) ? t.length : 0; }