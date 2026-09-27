/**
 * ISA-PRO — the agent bridge.
 *
 * Registers the two ISA tools only:
 *   isa_allocate  — task -> ISA allocation (heuristic | model), clamped, logged
 *   isa_bus       — emit / read signals on the buses
 *
 * This file is deliberately thin. Enforcement and the agent-integration shape
 * are open design-period questions (docs/isa.md §7); the bridge exists so the
 * pairing — LLM as processor, runtime as clamp — is usable today.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const execFileP = promisify(execFile);

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..").replace(/\/$/, "");
const CLI = (name: string): string => resolve(ROOT, `bin/isa-${name}.mjs`);

function resolvedModelId(ctx: any): string {
  return process.env.ISA_MODEL ?? ctx?.model?.id ?? process.env.PI_MODEL ?? "glm-5.3-flash";
}

function resolvedBaseUrl(ctx: any): string {
  const b = process.env.ISA_BASE_URL ?? ctx?.model?.baseUrl ?? "http://127.0.0.1:11434/v1";
  return String(b).replace(/\/+$/, "");
}

function resolvedApiKey(ctx: any): string | undefined {
  const explicit = process.env.ISA_API_KEY;
  if (explicit) return explicit;
  try {
    const providerId = ctx?.model?.provider ?? "ollama-cloud";
    const auth = ctx?.modelRegistry?.getProviderAuth?.(providerId);
    const k = auth?.apiKey ?? auth?.key;
    if (k && !String(k).startsWith("$")) return String(k);
  } catch {
    /* registry unavailable */
  }
  return undefined;
}

async function run(bin: string, argv: string[], ctx: any, timeout = 300_000): Promise<string> {
  const model = resolvedModelId(ctx);
  const base = resolvedBaseUrl(ctx);
  const key = resolvedApiKey(ctx);
  const { stdout, stderr } = await execFileP(process.execPath, [CLI(bin), ...argv], {
    env: {
      ...process.env,
      ISA_MODEL: model,
      ISA_BASE_URL: base,
      ...(key ? { ISA_API_KEY: key } : {}),
    },
    timeout,
  });
  if (stderr) process.stderr.write(stderr);
  return stdout;
}

export default function (pi: ExtensionAPI): void {
  const bins = { alloc: CLI("alloc"), bus: CLI("bus") };
  // Absent runtime -> absent tools. Never break session startup.
  if (!Object.values(bins).some(existsSync)) return;

  pi.registerTool({
    name: "isa_allocate",
    label: "ISA Allocate",
    description:
      "Turn a task into an ISA allocation (ROUTE / GRANT / ALLOC) using a deterministic heuristic or the live model. Emitted values are clamped to ceilings; the decision and the ISA text are logged to the ISA bus.",
    promptSnippet: "Use isa_allocate to assemble the ISA for a task before doing the work.",
    promptGuidelines: [
      "Call isa_allocate with the task to allocate before starting work.",
      "Pass repo when working outside the current project.",
    ],
    parameters: Type.Object({
      task: Type.String({ description: "Task / objective to allocate for." }),
      repo: Type.Optional(Type.String({ description: "Working dir. Defaults to the current project." })),
      policy: Type.Optional(Type.String({ description: "heuristic (default) or model." })),
    }),
    async execute(_id: string, params: { task: string; repo?: string; policy?: string }, _signal: unknown, _onUpdate: unknown, ctx: any) {
      const argv = [params.task];
      if (params.repo) argv.push("--repo", params.repo);
      if (params.policy) argv.push("--policy", params.policy);
      const text = await run("alloc", argv, ctx, 120_000);
      return { content: [{ type: "text", text }], details: { tool: "isa_allocate" } };
    },
  });

  pi.registerTool({
    name: "isa_bus",
    label: "ISA Bus",
    description:
      "Read or emit signals on the ISA buses (control / data). The bus is the log of record: emit sig.* events or read the tail — no state machine.",
    parameters: Type.Object({
      emitType: Type.Optional(Type.String({ description: "Signal type to emit (e.g. note)." })),
      fields: Type.Optional(Type.Array(Type.String(), { description: "key=value fields for the signal." })),
      bus: Type.Optional(Type.String({ description: "control (default) or data." })),
      tail: Type.Optional(Type.Number({ description: "Events to read when not emitting (default 40)." })),
      repo: Type.Optional(Type.String({ description: "Working dir. Defaults to the current project." })),
    }),
    async execute(_id: string, p: any, _signal: unknown, _onUpdate: unknown, ctx: any) {
      const argv: string[] = [];
      if (p.emitType) argv.push("emit", p.emitType, ...(p.fields ?? []));
      if (p.bus) argv.push("--bus", p.bus);
      if (p.tail != null) argv.push("--tail", String(p.tail));
      if (p.repo) argv.push("--repo", p.repo);
      const text = await run("bus", argv, ctx, 60_000);
      return { content: [{ type: "text", text }], details: { tool: "isa_bus" } };
    },
  });
}
