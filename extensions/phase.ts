import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const execFileP = promisify(execFile);

// Resolve the phase runtime root portably:
//   1. PHASE_ROOT env override (e.g. a custom checkout)
//   2. otherwise, relative to THIS extension file, so the package can live
//      anywhere pi install puts it (~/.pi/agent/git|npm/<...>) and still work.
const HERE = dirname(fileURLToPath(import.meta.url));
export const PHASE_ROOT = resolve(
  process.env.PHASE_ROOT ?? resolve(HERE, ".."),
).replace(/\/$/, "");
const OLLAMA_OPENAI = "http://127.0.0.1:11434/v1";

const CLI = (name: string) => resolve(PHASE_ROOT, `bin/phase-${name}.mjs`);

// Ensure a provider base ends in an OpenAI-compatible /v1 path (phase appends
// /chat/completions to it).
function normalizeV1(base: string): string {
  const s = String(base).replace(/\/+$/, "");
  return /\/v1$/i.test(s) ? s : `${s}/v1`;
}

// Resolve the SAME model/base URL pi is currently streaming. ctx.model is the
// authoritative source; fall back to explicit env, then $PI_MODEL, then a safe
// local default. Phase drives the same LLM as the chat — never a hardcoded one.
function resolvedModelId(ctx: any): string {
  return (
    process.env.PHASE_SLM_MODEL ?? process.env.PHASE_LLM_MODEL
    ?? ctx?.model?.id
    ?? process.env.PI_MODEL
    ?? "qwen2.5:1.5b"
  );
}
function resolvedBaseUrl(ctx: any): string {
  const b = process.env.PHASE_SLM_BASE_URL ?? process.env.PHASE_LLM_BASE_URL
    ?? ctx?.model?.baseUrl;
  return b ? normalizeV1(b) : OLLAMA_OPENAI;
}

async function run(binName: string, argv: string[], repo: string | undefined, ctx: any, timeout = 300_000): Promise<string> {
  const cmd = [CLI(binName), ...argv];
  if (repo) cmd.push("--repo", repo);
  const model = resolvedModelId(ctx);
  const base = resolvedBaseUrl(ctx);
  const { stdout, stderr } = await execFileP(process.execPath, cmd, {
    env: {
      ...process.env,
      PHASE_SLM_MODEL: model,
      PHASE_SLM_BASE_URL: base,
      PHASE_SLM_POLICY: "model",
      PHASE_LLM_MODEL: model,
      PHASE_LLM_BASE_URL: base,
    },
    timeout,
  });
  if (stderr) process.stderr.write(stderr);
  return stdout;
}

export default function (pi: ExtensionAPI) {
  const bins = {
    alloc: CLI("alloc"),
    orchestrate: CLI("orchestrate"),
    schedule: CLI("schedule"),
    bus: CLI("bus"),
  };
  // If the phase runtime isn't present for this install, keep tools absent
  // rather than breaking session startup. PHASE_ROOT can point at a real
  // checkout to re-enable them.
  if (!Object.values(bins).some(existsSync)) return;

  // ---- phase_allocate : one task + repo -> bounded allocation plan/ISA.
  pi.registerTool({
    name: "phase_allocate",
    label: "Phase Allocate",
    description:
      "Turn human intent into a bounded Phase allocation plan (agent route, granted tools, budget) using the same LLM that's driving this chat. Call this before executing a task so you work within the right budget and tool set. Returns a JSON plan plus the human-readable Phase ISA.",
    promptSnippet:
      "Use phase_allocate to let the SLM allocate budget, tools, and routing for a task before doing the work.",
    promptGuidelines: [
      "Call phase_allocate with the task to allocate before starting work.",
      "Pass the repo path when working outside the phase project.",
    ],
    parameters: Type.Object({
      task: Type.String({ description: "Human intent / objective to allocate for." }),
      repo: Type.Optional(Type.String({ description: "Absolute repo/git root to coordinate. Defaults to the phase project." })),
      policy: Type.Optional(Type.String({ description: "model (SLM) or heuristic. Default model." })),
      model: Type.Optional(Type.String({ description: "Model id override; defaults to the model currently driving the chat." })),
    }),
    async execute(_id, params: { task: string; repo?: string; policy?: string; model?: string }, _signal, _onUpdate, ctx: any) {
      const argv = [params.task, "--json"];
      if (params.repo) argv.push("--repo", params.repo);
      if (params.policy) argv.push("--policy", params.policy);
      if (params.model) argv.push("--model", params.model);
      const text = await run("alloc", argv, undefined, ctx, 120_000);
      return { content: [{ type: "text", text }], details: { tool: "phase_allocate" } };
    },
  });

  // ---- phase_orchestrate : SLM/LLM brain decomposes a goal -> schedules
  // ----                tickets -> reviews outcomes -> RETRY / ADD / STOP.
  pi.registerTool({
    name: "phase_orchestrate",
    label: "Phase Orchestrate",
    description:
      "Drive the Phase process runtime: the LLM brain decomposes a goal into dependency-aware tickets, a drain-loop scheduler runs them across concurrent workers, and the LLM reviews outcomes to RETRY / ADD / STOP. Uses the same model that's driving this chat. Offline fallback decomposes simply. Use for multi-part tasks.",
    parameters: Type.Object({
      goal: Type.String({ description: "The human objective to decompose and coordinate." }),
      repo: Type.Optional(Type.String({ description: "Absolute repo/git root to coordinate. Defaults to the phase project." })),
      rounds: Type.Optional(Type.Number({ description: "Max orchestration loops (default 3)." })),
      count: Type.Optional(Type.Number({ description: "Concurrent workers per round (default CPUs-1)." })),
      exec: Type.Optional(Type.String({ description: "Run this command per ticket instead of the built-in demo job." })),
      dryRun: Type.Optional(Type.Boolean({ description: "Decompose + report only; don't run workers." })),
    }),
    async execute(_id, p: any, _signal, _onUpdate, ctx: any) {
      const argv = [p.goal];
      if (p.rounds) argv.push("--rounds", String(p.rounds));
      if (p.count) argv.push("--count", String(p.count));
      if (p.exec) argv.push("--exec", p.exec);
      if (p.dryRun) argv.push("--dry-run");
      const text = await run("orchestrate", argv, p.repo, ctx);
      return { content: [{ type: "text", text }], details: {} };
    },
  });

  // ---- phase_schedule : tickets in, concurrency out (independent / pipeline / dag).
  pi.registerTool({
    name: "phase_schedule",
    label: "Phase Schedule",
    description:
      "Lay out tickets and run them through the Phase drain-loop scheduler with a concurrent worker pool. Independent objectives, a linear --pipeline chain, or a --dag graph. Each ticket claims fresh context from its own allocation (using the chat's model).",
    parameters: Type.Object({
      objectives: Type.Optional(Type.Array(Type.String())),
      pipeline: Type.Optional(Type.Boolean({ description: "Treat positional objectives as a linear dependent chain." })),
      dag: Type.Optional(Type.String({ description: "Path to a JSON graph [{objective, depends_on:[...]}]." })),
      repo: Type.Optional(Type.String()),
      count: Type.Optional(Type.Number()),
      exec: Type.Optional(Type.String()),
      dryRun: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, p: any, _signal, _onUpdate, ctx: any) {
      const argv: string[] = [];
      for (const o of p.objectives ?? []) argv.push(o);
      if (p.pipeline) argv.push("--pipeline");
      if (p.dag) argv.push("--dag", p.dag);
      if (p.count) argv.push("--count", String(p.count));
      if (p.exec) argv.push("--exec", p.exec);
      if (p.dryRun) argv.push("--dry-run");
      const text = await run("schedule", argv.length ? argv : ["--help"], p.repo, ctx);
      return { content: [{ type: "text", text }], details: {} };
    },
  });

  // ---- phase_bus_tickets : live status of a repo's ticket store.
  pi.registerTool({
    name: "phase_bus_tickets",
    label: "Phase Bus - Tickets",
    description:
      "List the current ticket store for a repo (open / done / worker / objective / deps). Use to check the progress of scheduled or orchestrated work.",
    parameters: Type.Object({
      repo: Type.Optional(Type.String({ description: "Absolute repo/git root to inspect. Defaults to the phase project." })),
    }),
    async execute(_id, p: any, _signal, _onUpdate, ctx: any) {
      const text = await run("bus", ["tickets"], p.repo, ctx);
      return { content: [{ type: "text", text }], details: {} };
    },
  });

  // Surface the phase CLI commands in the Pi command palette too.
  pi.registerCommand("phase", {
    description:
      "List phase commands / usage. phase is bundled as extensions here; run CLI binaries directly for full control.",
    handler: async (_args, ctx) => {
      ctx.ui.notify("phase installed: phase_allocate, phase_orchestrate, phase_schedule, phase_bus_tickets.", "info");
    },
  });
}
