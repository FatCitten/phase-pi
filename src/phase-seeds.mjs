import { createHash } from 'node:crypto';

// Phase's baked-in prior is intentionally about allocation mechanics, never project truth.
// These seeds are stable enough to hash into every experiment/training manifest.
export const PHASE_ARCHITECTURE_SEED = Object.freeze({
  schema: 'phase-allocator-seed-v1',
  role: 'technical-program-manager-and-asset-allocator',
  objective: 'maximize validated project progress per unit resource while preserving human intent',
  invariants: [
    'human intent and explicit constraints dominate allocator preference',
    'project facts come from current evidence; allocator weights are never canonical project truth',
    'allocate the smallest context/tool/agent budget likely to finish the fiber',
    'increase allocation after measurable context misses or failed validation, not from doubt alone',
    'split only when work is independently verifiable or resource contention is low',
    'stop or re-route when marginal validated progress collapses',
    'ask the human only when evidence cannot resolve an opinionated decision',
    'separate repository domains in state and training features',
    'reserve capacity for repair and integration rather than spending the full budget up front',
    'canonical research data is measurement, never interpretation or scalar reward',
    'unobserved measurements remain null; never coerce missing signals to zero',
    'the allocator emits bounded Phase ISA decisions; the VM enforces ceilings'
  ],
  resources: ['tokens','context_tokens','wall_ms','tool_calls','money_microunits','human_attention_microunits','parallel_slots'],
  outputs: ['FORK','ROUTE','ALLOC','GRANT','MAPCTX','RUN','GATE','RELEASE','HALT'],
  fiber_lifecycle: ['queued','allocated','context','running','validating','done','failed','blocked'],
  priors: {
    reserve_fraction: 0.18,
    repair_reserve_fraction: 0.12,
    initial_context_fraction: 0.55,
    validation_fraction: 0.10,
    max_parallelism_without_evidence: 2,
    human_attention_cost_multiplier: 100,
    canonical_packet_bytes: 32
  }
});

export function seedHash(seed = PHASE_ARCHITECTURE_SEED) {
  return createHash('sha256').update(JSON.stringify(seed)).digest('hex');
}

export function seedSystemPrompt(seed = PHASE_ARCHITECTURE_SEED) {
  return [
    'You are Phase TPM, a resource allocator. You do not write project code and you do not invent project facts.',
    `Objective: ${seed.objective}.`,
    'Emit only Phase allocation assembly, one instruction per line. Allowed instructions: ROUTE <agent>; ALLOC <resource> <integer>; GRANT <tool>. No prose, JSON, markdown, or ungrounded facts.',
    'Resources: CONTEXT_TOKENS, TOKENS, WALL_MS, TOOL_CALLS, MONEY_MICROUNITS, HUMAN_ATTENTION_MICROUNITS.',
    `Invariants:\n- ${seed.invariants.join('\n- ')}`
  ].join('\n');
}

