import { TicketStore } from '../src/bus.mjs';
import { runWorker } from '../bin/phase-worker.mjs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const store = new TicketStore({ repo: process.cwd() });
const found = store.createTicket({ objective: 'write foundation spec' });
const api = store.createTicket({ objective: 'write API schema' });
const auth = store.createTicket({ objective: 'implement auth module', depends_on: [found.id, api.id] });
const bill = store.createTicket({ objective: 'implement billing module', depends_on: [found.id, api.id] });
const test = store.createTicket({ objective: 'write integration tests', depends_on: [auth.id, bill.id] });
console.log(`DAG roots: ${found.id}(found) ${api.id}(api) | mid: ${auth.id}(auth) ${bill.id}(bill) | leaf: ${test.id}(test)`);

const pool = [];
for (let i = 0; i < 5; i++) pool.push((async () => {
  for (;;) {
    const r = await runWorker({ agent: `dagw${process.pid}.${i}`, repo: process.cwd(), policy: 'heuristic', model: 'qwen2.5:0.5b', command: null, store, env: process.env });
    const anyOpen = store.listTickets().some((t) => t.status === 'open');
    const anyRun = store.listTickets().some((t) => t.status === 'in_progress');
    if (!anyOpen && !anyRun) break;
    await sleep(100);
  }
})());
await Promise.all(pool);

const done = store.listTickets().filter((t) => t.status === 'done');
console.log(`\nRESULT: ${done.length}/5 done`);
const byId = {};
for (const e of store.readControl()) if (e.type === 'ticket.done') byId[e.ticket_id] = e.ts;
const order = [...Object.entries(byId)].sort((a, b) => a[1].localeCompare(b[1]));
console.log('COMPLETION ORDER (roots must finish before mid; mid before leaf):');
order.forEach(([tid], i) => console.log(`  #${i + 1} ${tid}`));
const ok = byId[auth.id] >= byId[found.id]
  && byId[bill.id] >= byId[found.id]
  && byId[auth.id] >= byId[api.id]
  && byId[bill.id] >= byId[api.id]
  && byId[test.id] >= byId[auth.id]
  && byId[test.id] >= byId[bill.id]
  && store.getTicket(found.id).status === 'done' && store.getTicket(api.id).status === 'done';
console.log(`\nORDERING-OK: ${ok}`);
process.exit(ok ? 0 : 1);
