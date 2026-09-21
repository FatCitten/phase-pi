import { createHash } from 'node:crypto';
import { repositoryDomainId } from './util.mjs';

function h64(s) {
  const b=createHash('sha256').update(String(s)).digest();
  return b.readBigUInt64BE(0);
}
function add(vec, key, value=1) {
  const n=BigInt(vec.length), x=h64(key); const idx=Number(x%n); const sign=((x>>8n)&1n)===0n?1:-1; vec[idx]+=sign*Number(value);
}
function norm(vec) { const z=Math.sqrt(vec.reduce((s,x)=>s+x*x,0))||1; return vec.map(x=>Number((x/z).toFixed(6))); }

export function encodeAllocationState({ workflow, fiber, runtime = {}, dimensions = 96 }) {
  const v=Array(dimensions).fill(0);
  const repo=repositoryDomainId(workflow.cwd);
  // Multiple repository-specific anchors make unrelated repos deliberately far apart.
  for(let i=0;i<8;i++) add(v,`repo:${repo}:anchor:${i}`,2);
  const agentId=typeof fiber.agent==='string'?fiber.agent:String(fiber.agent?.id??fiber.agent?.adapter??'custom');
  add(v,`fiber:${fiber.id}`,.25); add(v,`agent:${agentId}`,.5);
  for(const t of fiber.tools) add(v,`tool:${t}`,.35);
  for(const dep of fiber.depends_on) add(v,`dep:${dep}`,.2);
  for(const token of `${workflow.objective} ${fiber.objective}`.toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean)) add(v,`lex:${token}`,.12);
  add(v,'progress',Number(runtime.progress??0));
  add(v,'failures',Number(runtime.validation_failures??0)*.5);
  add(v,'context_misses',Number(runtime.context_misses??0)*.5);
  add(v,'attempts',Number(runtime.attempts??0)*.25);
  return { schema:'phase-state-vector-v1', dimensions, repository_id:repo, vector:norm(v) };
}
