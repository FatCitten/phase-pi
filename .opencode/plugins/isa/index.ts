/**
 * ISA-PRO — the harness hook.
 *
 * A run is confined, recorded work. While a run is active, this hook:
 *
 *   - confines work to the run's sandbox (shell cwd jail + write denies)
 *   - meters tool calls and tokens as RECORD ONLY — never enforced
 *   - leaves the engine to bound wall-time on exec (hard safety limit)
 *
 * There is no budget, no deny-mode, no allocation. Measurement is data on
 * the ledger and the bus; the sandbox is the only boundary with teeth.
 *
 *   isa_begin (native tool)   activate: open the sandbox, start the record
 *   tool.execute.before       count work-tool calls -> actuals (record only)
 *   shell.create.before       force cwd into the sandbox; clamp timeout to a
 *                             flat safety ceiling
 *   permission.evaluate       deny writes outside sandbox + ledger
 *   session http.response     parse real provider usage -> token actuals
 *                             (record only)
 *
 * Inert when no run is active. Activation flows through the native isa_begin
 * tool; the engine's pointer file (.isa/runs/current.json) stays the ledger of
 * record for the CLI.
 */
import { Plugin } from "@opencode/plugin";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = (() => {
  const candidates = [
    process.env.ISA_ROOT ? join(resolve(process.env.ISA_ROOT), "bin") : null,
    resolve(HERE, "../../../bin"),
  ].filter(Boolean) as string[];
  return candidates.find((d) => existsSync(join(d, "isa-begin.mjs"))) ?? candidates[0];
})();

// Inside the OpenCode host, process.execPath is the compiled opencode binary —
// not a JS runtime. Spawning it with `isa-*.mjs --flags` makes the opencode CLI
// try to parse our flags and die. Use a real Node runtime: $NODE, else `node`
// from PATH.
const NODE = process.env.NODE || "node";

const MUTATE_ACTIONS = new Set(["edit", "write", "bash", "shell", "patch"]);
const WORK_TOOLS = new Set(["edit", "write", "bash", "shell", "patch"]);

/** Flat safety ceiling for shell timeouts — runaway protection, not a budget. */
const SHELL_TIMEOUT_MS = 15 * 60 * 1000;

interface Actuals {
  status: string;
  wall_ms: number;
  exec_count: number;
  tool_calls: number | null;
  tokens: number | null;
}
interface Pointer {
  id: string;
  task: string;
  repo: string;
  started_at: string;
  sandbox: string;
}

let active: { home: string; pointer: Pointer; actuals: Actuals } | null = null;

const bin = (name: string): string => join(BIN, `isa-${name}.mjs`);

async function cli(name: string, args: string[], timeout = 300_000): Promise<string> {
  const { stdout, stderr } = await execFileP(NODE, [bin(name), ...args], {
    timeout,
    env: { ...process.env },
    maxBuffer: 10 * 1024 * 1024,
  });
  if (stderr) console.error(stderr);
  return stdout;
}

function readJson<T>(path: string): T | null {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return null; }
}

function actualsPath(): string | null {
  if (!active) return null;
  return join(active.home, "runs", active.pointer.id, "actuals.json");
}

function flushActuals(): void {
  const p = actualsPath();
  if (!p || !active) return;
  try { writeFileSync(p, JSON.stringify(active.actuals, null, 2)); } catch { /* ledger write best-effort */ }
}

function insideSandbox(path: string): boolean {
  if (!active) return false;
  const s = resolve(active.pointer.sandbox);
  const ledger = resolve(active.home);
  const p = resolve(path);
  return p === s || p.startsWith(s + "/") || p === ledger || p.startsWith(ledger + "/");
}

function bumpToolCalls(): void {
  if (!active) return;
  active.actuals.tool_calls = (active.actuals.tool_calls ?? 0) + 1;
  flushActuals();
}

function bumpTokens(n: number): void {
  if (!active || !Number.isFinite(n) || n <= 0) return;
  active.actuals.tokens = (active.actuals.tokens ?? 0) + n;
  flushActuals();
}

export default Plugin.define({
  id: "isa",

  async setup(ctx: any) {
    const location: string = ctx?.location?.directory ?? process.cwd();

    // ---- native tools ----------------------------------------------------
    await ctx.tool.transform((editor: any) => {
      editor.add({
        name: "isa_begin",
        description:
          "Start an ISA-PRO run: the engine opens a per-run sandbox and the record begins. While a run is active, work is confined to the sandbox. Nothing is budgeted or planned.",
        input: {
          type: "object",
          properties: {
            task: { type: "string", description: "Task to execute under the ISA." },
            repo: { type: "string", description: `Working dir the run coordinates. Default: ${location}` },
          },
          required: ["task"],
          additionalProperties: false,
        },
        options: { namespace: "isa" },
        execute: async (input: any) => {
          const repo = resolve(input.repo ?? location);
          const home = process.env.ISA_HOME ?? join(repo, ".isa");
          const args = [input.task, "--repo", repo, "--home", home, "--json"];
          const out = await cli("begin", args, 120_000);
          const pointer = readJson<Pointer>(join(home, "runs", "current.json"));
          if (!pointer) return { content: out, metadata: { active: false } };
          active = {
            home,
            pointer,
            actuals: readJson<Actuals>(join(home, "runs", pointer.id, "actuals.json")) ?? {
              status: "running", wall_ms: 0, exec_count: 0, tool_calls: null, tokens: null,
            },
          };
          return { content: out, metadata: { active: true, run: pointer.id } };
        },
      });

      editor.add({
        name: "isa_exec",
        description:
          "Run a command inside the active run's sandbox. The engine bounds wall-time with a hard safety limit; output is captured to the run artifact and the data bus.",
        input: {
          type: "object",
          properties: { cmd: { type: "string", description: "The command to run inside the sandbox." } },
          required: ["cmd"],
          additionalProperties: false,
        },
        options: { namespace: "isa" },
        execute: async (input: any) => {
          const repo = active?.pointer.repo ?? location;
          const home = active?.home ?? join(location, ".isa");
          return { content: await cli("exec", ["--repo", repo, "--home", home, input.cmd], 900_000) };
        },
      });

      editor.add({
        name: "isa_end",
        description:
          "Close the active run. The engine measures wall-time itself and records the outcome. Pass passed=true on success.",
        input: {
          type: "object",
          properties: {
            passed: { type: "boolean", description: "The work passed (default false)." },
            result: { type: "string" },
            artifact: { type: "string" },
          },
          additionalProperties: false,
        },
        options: { namespace: "isa" },
        execute: async (input: any) => {
          const repo = active?.pointer.repo ?? location;
          const home = active?.home ?? join(location, ".isa");
          const args: string[] = ["--repo", repo, "--home", home];
          if (input.passed) args.push("--passed");
          if (input.result) args.push("--result", input.result);
          if (input.artifact) args.push("--artifact", input.artifact);
          const out = await cli("end", args, 120_000);
          active = null;
          return { content: out };
        },
      });

      editor.add({
        name: "isa_status",
        description: "The run facts: what is running, for how long, what it has done, sandbox path.",
        input: { type: "object", properties: { repo: { type: "string" } }, additionalProperties: false },
        options: { namespace: "isa" },
        execute: async (input: any) => {
          const repo = input.repo ?? active?.pointer.repo ?? location;
          const home = active?.home ?? join(resolve(repo), ".isa");
          return { content: await cli("status", ["--repo", resolve(repo), "--home", home, "--json"], 60_000) };
        },
      });

      editor.add({
        name: "isa_state",
        description:
          "Repo comprehension snapshot: identity, structure counts, the last change-set per file, and uncommitted work — as a compact token block. The cheapest way to read environment state.",
        input: {
          type: "object",
          properties: {
            repo: { type: "string", description: `Repo to snapshot. Default: ${location}` },
            base: { type: "string", description: "Compare <base>..HEAD. Default: HEAD~1." },
          },
          additionalProperties: false,
        },
        options: { namespace: "isa" },
        execute: async (input: any) => {
          const repo = input.repo ?? location;
          const args = ["--repo", resolve(repo)];
          if (input.base) args.push("--base", input.base);
          return { content: await cli("state", args, 60_000) };
        },
      });

      editor.add({
        name: "isa_emit",
        description: "Append a signal to the ISA bus (control or data). The bus is the log of record.",
        input: {
          type: "object",
          properties: {
            bus: { type: "string", description: "control (default) or data" },
            type: { type: "string", description: "Signal type, e.g. note" },
            fields: { type: "array", items: { type: "string" }, description: "key=value fields" },
          },
          required: ["type"],
          additionalProperties: false,
        },
        options: { namespace: "isa" },
        execute: async (input: any) => {
          const repo = active?.pointer.repo ?? location;
          const home = active?.home ?? join(location, ".isa");
          const args = ["emit", input.type, "--home", home, "--repo", repo];
          if (input.bus) args.push("--bus", input.bus);
          for (const f of input.fields ?? []) args.push(String(f));
          return { content: await cli("bus", args, 60_000) };
        },
      });
    });

    // ---- confinement + record hooks ---------------------------------------

    await ctx.tool.hook("execute.before", (event: any) => {
      if (!active) return;
      const name = String(event?.tool ?? "");
      if (name.startsWith("isa_")) return; // ledger tools are free
      if (WORK_TOOLS.has(name)) bumpToolCalls();
    });

    await ctx.shell.hook("create.before", (event: any) => {
      if (!active) return;
      event.cwd = active.pointer.sandbox; // confine every shell command to the sandbox
      event.timeout = Math.min(Number(event.timeout) || SHELL_TIMEOUT_MS, SHELL_TIMEOUT_MS);
      if (event.timeout <= 0) event.timeout = 1;
    });

    await ctx.permission.hook("evaluate", (event: any) => {
      if (!active) return;
      const action = String(event?.action ?? "");
      if (!MUTATE_ACTIONS.has(action)) return;
      if (action === "bash" || action === "shell") return; // cwd + timeout jailed by the shell hook
      const resources: string[] = Array.isArray(event?.resources) ? event.resources.map(String) : [];
      if (resources.length && resources.every((r) => insideSandbox(r))) return;
      event.effect = "deny";
      event.message = `isa: run ${active.pointer.id} active — writes confined to the sandbox (${active.pointer.sandbox}).`;
    });

    await ctx.session.hook("http.response", async (event: any) => {
      if (!active) return;
      if (event?.kind && event.kind !== "primary") return;
      try {
        const clone = event.response?.clone?.();
        if (!clone) return;
        const text = await clone.text();
        const usage = JSON.parse(text)?.usage ?? {};
        const prompt = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0);
        const completion = Number(usage.completion_tokens ?? usage.output_tokens ?? 0);
        bumpTokens(prompt + completion);
      } catch { /* non-JSON or streamed body — no real number, nothing faked */ }
    });
  },
});
