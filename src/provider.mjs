/**
 * Provider resolution — make Phase talk to the SAME model/provider that powers
 * the calling harness (pi) so the skill is actually usable out of the box.
 *
 * Priority for a given role (SLM brain / LLM brain):
 *   base_url:  PHASE_<ROLE>_BASE_URL
 *            ?? (PI_PROVIDER === 'ollama' ? http://127.0.0.1:11434/v1 : <legacy>:8080/v1)
 *   model:     PHASE_<ROLE>_MODEL
 *            ?? PI_MODEL                      // same LLM as the present chat
 *            ?? fallbackModel
 *
 * Explicit PHASE_* env wins (let users pin a different brain model). Failing
 * that we inherit pi's own provider and PI_MODEL, so phase "just works" with
 * whatever model the chat is running on.
 */

const OLLAMA_OPENAI = 'http://127.0.0.1:11434/v1';
const LEGACY = 'http://127.0.0.1:8080/v1';

export function piBaseUrl() {
  return String(process.env.PI_PROVIDER ?? '').toLowerCase() === 'ollama'
    ? OLLAMA_OPENAI
    : LEGACY;
}

/**
 * Resolve { base_url, model } for a phase role. `prefix` is one of 'SLM'/'LLM'.
 * `fallbackModel` is used only when neither PHASE_<ROLE>_MODEL nor PI_MODEL is set.
 */
export function resolveProvider({ prefix = 'SLM', fallbackModel = 'qwen2.5:1.5b' } = {}) {
  const P = String(prefix).toUpperCase();
  const base_url =
    process.env[`PHASE_${P}_BASE_URL`]
    ?? process.env.PHASE_SLM_BASE_URL
    ?? process.env.PHASE_LLM_BASE_URL
    ?? piBaseUrl();
  const model =
    process.env[`PHASE_${P}_MODEL`]
    ?? process.env.PHASE_SLM_MODEL
    ?? process.env.PHASE_LLM_MODEL
    ?? process.env.PI_MODEL
    ?? fallbackModel;
  return { base_url, model };
}

// Convenience: slm/llm variants for call sites that want one word.
export const slmProvider = (opts) => resolveProvider({ prefix: 'SLM', ...opts });
export const llmProvider = (opts) => resolveProvider({ prefix: 'LLM', ...opts });
