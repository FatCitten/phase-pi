/**
 * Provider resolution — phase's generative brain.
 *
 * Default model is a light CLOUD model (glm-5.3-flash:cloud): fast, and no
 * local model ever loads (heavy local chat models are too slow on a laptop).
 * Explicit PHASE_* env still wins; the pi extension pins the chat's own model
 * via env when a tool run wants to follow the chat.
 *
 * Priority for a given role (SLM brain / LLM brain):
 *   base_url:  PHASE_<ROLE>_BASE_URL
 *            ?? (PI_PROVIDER ollama* ? http://127.0.0.1:11434/v1 : <legacy>:8080/v1)
 *   model:     PHASE_<ROLE>_MODEL
 *            ?? 'glm-5.3-flash:cloud'         // light default; local off
 *            ?? PI_MODEL                      // chat model (may be heavy/retired)
 *            ?? fallbackModel                 // last-resort offline (light local)
 */

const OLLAMA_OPENAI = 'http://127.0.0.1:11434/v1';
const LEGACY = 'http://127.0.0.1:8080/v1';

export function piBaseUrl() {
  const p = String(process.env.PI_PROVIDER ?? '').toLowerCase();
  return p.startsWith('ollama') ? OLLAMA_OPENAI : LEGACY; // 'ollama' and 'ollama-cloud' both route to local Ollama (cloud models are served via the local proxy)
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
  // DEFAULT_MODEL is a light CLOUD model: fast, and no local model ever loads
  // (heavy local chat models are too slow for a laptop). PI_MODEL is inherited
  // only when explicitly preferred via env; local weights are never default.
  const model =
    process.env[`PHASE_${P}_MODEL`]
    ?? process.env.PHASE_SLM_MODEL
    ?? process.env.PHASE_LLM_MODEL
    ?? DEFAULT_MODEL
    ?? process.env.PI_MODEL
    ?? fallbackModel;
  return { base_url, model };
}

// Light cloud default brain — zero local model load.
export const DEFAULT_MODEL = 'glm-5.3-flash:cloud';

// SLM variant for call sites (the LLM side is Pi's live model, not a provider
// resolved here — dead convenience wrapper removed in the stale-code sweep).
export const slmProvider = (opts) => resolveProvider({ prefix: 'SLM', ...opts });
