/**
 * ISA brain resolution — model + OpenAI-compatible endpoint for the ISA
 * assembler. Explicit env wins; defaults to a light local endpoint so the CLI
 * never loads a heavy local model by surprise.
 *
 *   model:     ISA_MODEL      ?? 'glm-5.3-flash'
 *   base_url:  ISA_BASE_URL   ?? 'http://127.0.0.1:11434/v1'
 */
export const DEFAULT_MODEL = 'glm-5.3-flash';
export const DEFAULT_BASE_URL = 'http://127.0.0.1:11434/v1';

export function resolveProvider({ model = process.env.ISA_MODEL ?? DEFAULT_MODEL, base_url = process.env.ISA_BASE_URL ?? DEFAULT_BASE_URL } = {}) {
  return { base_url: String(base_url).replace(/\/+$/, ''), model: String(model) };
}
