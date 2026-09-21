/**
 * Adapters that let existing LLM agent harnesses call Phase as a tool.
 *
 * Phase is a servant tool (Shape A): it turns human intent into a bounded
 * allocation plan. A harness adapter tells a given agent exactly how to invoke
 * `phase` so it "just works" with a repo — no training, no extra harness.
 *
 * Every adapter produces a shell command the agent can run. Pure Node stdlib.
 */

const TOOL = 'phase';

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'"'"'`)}'`;
}

/**
 * Build the canonical `phase` invocation for a task + repo.
 * Reused by every harness adapter; adapters differ in model flag placement
 * and whether they pass the prompt via argv or stdin.
 */
function phaseInvocation({ task, repo, model, policy, isa }) {
  const parts = [TOOL];
  if (isa) parts.push('--isa');
  parts.push('--repo', repo ?? '.');
  if (policy) parts.push('--policy', policy);
  if (model) parts.push('--model', model);
  parts.push('-');                        // read intent from stdin (avoid arg-length limits)
  return { argv: parts, stdin: task };
}

function toShell({ argv, stdin }) {
  const echoStdin = stdin ? `printf %s ${shellQuote(stdin)}` : 'true';
  return `${echoStdin} | ${argv.map(shellQuote).join(' ')}`;
}

export const ADAPTERS = [
  {
    id: 'pi', label: 'Pi (print-mode)',
    detect: ['pi'],
    notes: 'Pi coding agent. Call phase to allocate, then give the plan to Pi as context.',
    // Pi takes the prompt on argv; here we shell the tool call to Pi with the task.
    makeTool(task, { repo, model }) {
      return toShell(phaseInvocation({ task, repo, model, isa: true }));
    }
  },
  {
    id: 'codex', label: 'Codex CLI',
    detect: ['codex'],
    notes: 'Codex exec worker. Phase returns ISA; Codex executes it.',
    makeTool(task, { repo, model }) {
      return toShell(phaseInvocation({ task, repo, model, isa: false }));
    }
  },
  {
    id: 'claude', label: 'Claude Code',
    detect: ['claude'],
    notes: 'Claude Code print mode. Phase provides the allocation; Claude does the work.',
    makeTool(task, { repo, model }) {
      return toShell(phaseInvocation({ task, repo, model, isa: false }));
    }
  },
  {
    id: 'gemini', label: 'Gemini CLI',
    detect: ['gemini'],
    notes: 'Gemini headless. Phase decides budget/routing; Gemini acts on it.',
    makeTool(task, { repo, model }) {
      return toShell(phaseInvocation({ task, repo, model, isa: false }));
    }
  }
];

export function adapterById(id) {
  return ADAPTERS.find((a) => a.id === String(id).toLowerCase());
}

export function resolveAdapter({ repo }) {
  const forced = String(process.env.PHASE_ADAPTER ?? '').trim().toLowerCase();
  if (forced) {
    const a = adapterById(forced);
    if (!a) throw new Error(`unknown adapter: ${forced}; known: ${ADAPTERS.map((x) => x.id).join(', ')}`);
    return a;
  }
  return adapterById('codex') ?? ADAPTERS[0];
}

export function adapterSummary(adapter, { task, repo, model }) {
  return {
    tool: TOOL,
    adapter: adapter.id,
    label: adapter.label,
    invoke: adapter.makeTool(task, { repo, model })
  };
}
