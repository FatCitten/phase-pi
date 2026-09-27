/**
 * ISA-PRO — the harness hook.
 *
 * The LLM in this session is the processor. This plugin is the jailer: while
 * a run is active, it meters the processor's real tool calls and real token
 * usage, confines work to the run's sandbox, and physically stops work when a
 * budget line is exceeded.
 *
 *   isa_begin (native tool)    activate: the engine validates + clamps the
 *                              allocation and opens the sandbox
 *   tool.execute.before        count work-tool calls -> actuals; over TOOL_CALLS
 *                              -> deny-mode
 *   shell.create.before        force cwd into the sandbox; clamp timeout to the
 *                              remaining WALL_MS
 *   permission.evaluate        deny writes outside sandbox + ledger; deny-mode
 *                              denies all work actions
 *   session http.response      parse real provider usage -> token actuals; over
 *                              TOKENS -> deny-mode
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

const MUTATE_ACTIONS = new Set(["edit", "write", "bash", "shell", "patch"]);
const WORK_TOOLS = new Set(["edit", "write", "bash", "shell", "patch"]);

interface Actuals {
  status: string;
  wall_ms: number;
  exec_count: number;
  tool_calls: number | null;
  tokens: number | null;
  over: string[];
}
interface Pointer {
  id: string;
  task: string;
  repo: string;
  started_at: string;
  budget: Record<string, number>;
  sandbox: string;
}

let active: { home: string; pointer: Pointer; actuals: Actuals; denied: boolean } | null = null;

const bin = (name: string): string => join(BIN, `isa-${name}.mjs`);

async function cli(name: string, args: string[], timeout = 300_000): Promise<string> {
  const { stdout, stderr } = await execFileP(process.execPath, [bin(name), ...args], {
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

function remainingWallMs(): number {
  if (!active) return 0;
  return Math.max(0, Number(active.pointer.budget.wall_ms ?? 0) - (Date.now() - Date.parse(active.pointer.started_at)));
}

function insideSandbox(path: string): boolean {
  if (!active) return false;
  const s = resolve(active.pointer.sandbox);
  const ledger = resolve(active.home);
  const p = resolve(path);
  return p === s || p.startsWith(s + "/") || p === ledger || p.startsWith(ledger + "/");
}

async function signalExceeded(resource: string, used: number, budget: number): Promise<void> {
  if (!active || active.denied) return; // the wall stands; signal once
  active.denied = true;
  try {
    await cli("bus", [
      "emit", "run.budget.exceeded",
      `resource=${resource}`, `used=${used}`, `budget=${budget}`, `run=${active.pointer.id}`,
      "--home", active.home, "--repo", active.pointer.repo,
    ], 30_000);
  } catch { /* ledger emit best-effort */ }
}

function bumpToolCalls(): void {
  if (!active) return;
  active.actuals.tool_calls = (active.actuals.tool_calls ?? 0) + 1;
  flushActuals();
  const budget = Number(active.pointer.budget.tool_calls);
  if (Number.isFinite(budget) && budget >= 0 && (active.actuals.tool_calls ?? 0) > budget) {
    void signalExceeded("tool_calls", active.actuals.tool_calls ?? 0, budget);
  }
}

function bumpTokens(n: number): void {
  if (!active || !Number.isFinite(n) || n <= 0) return;
  active.actuals.tokens = (active.actuals.tokens ?? 0) + n;
  flushActuals();
  const budget = Number(active.pointer.budget.tokens);
  if (Number.isFinite(budget) && budget >= 0 && (active.actuals.tokens ?? 0) > budget) {
    void signalExceeded("tokens", active.actuals.tokens ?? 0, budget);
  }
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
          "Start an ISA-PRO run: the engine validates and clamps the allocation, opens a per-run sandbox, and the harness begins metering. While a run is active, work is confined to the sandbox and budgets are enforced.",
        input: {
          type: "object",
          properties: {
            task: { type: "string", description: "Task to execute under the ISA." },
            repo: { type: "string", description: `Working dir the run coordinates. Default: ${location}` },
            asm: { type: "string", description: "Your own ISA assembly (ROUTE/GRANT/ALLOC). Default: ceilings." },
            ceilings: { type: "object", description: "Ceiling overrides, e.g. {\"tokens\": 8000, \"wall_ms\": 60000}." },
            tools: { type: "array", items: { type: "string" }, description: "Granted tools. Default read/edit/test/bash." },
          },
          required: ["task"],
          additionalProperties: false,
        },
        options: { namespace: "isa" },
        execute: async (input: any) => {
          const repo = resolve(input.repo ?? location);
          const home = process.env.ISA_HOME ?? join(repo, ".isa");
          const args = [input.task, "--repo", repo, "--home", home, "--json"];
          if (input.asm) args.push("--asm", input.asm);
          if (input.ceilings) {
            for (const [k, v] of Object.entries(input.ceilings)) args.push("--ceil", `${String(k).toUpperCase()}=${v}`);
          }
          for (const t of input.tools ?? ["read", "edit", "test", "bash"]) args.push("--tool", String(t));
          const out = await cli("begin", args, 120_000);
          const pointer = readJson<Pointer>(join(home, "runs", "current.json"));
          if (!pointer) return { content: out, metadata: { active: false } };
          active = {
            home,
            pointer,
            denied: false,
            actuals: readJson<Actuals>(join(home, "runs", pointer.id, "actuals.json")) ?? {
              status: "running", wall_ms: 0, exec_count: 0, tool_calls: null, tokens: null, over: [],
            },
          };
          return { content: out, metadata: { active: true, run: pointer.id } };
        },
      });

      editor.add({
        name: "isa_exec",
        description:
          "Run a command inside the active run's sandbox. The engine enforces wall-time and confinement; output is captured to the run artifact and the data bus. Refused in deny-mode.",
        input: {
          type: "object",
          properties: { cmd: { type: "string", description: "The command to run inside the sandbox." } },
          required: ["cmd"],
          additionalProperties: false,
        },
        options: { namespace: "isa" },
        execute: async (input: any) => {
          if (active?.denied) return { content: "isa: run over budget — work denied; call isa_end." };
          const repo = active?.pointer.repo ?? location;
          const home = active?.home ?? join(location, ".isa");
          return { content: await cli("exec", ["--repo", repo, "--home", home, input.cmd], 900_000) };
        },
      });

      editor.add({
        name: "isa_end",
        description:
          "Close the active run. The engine measures wall-time itself and checks every budget line it has real numbers for. Pass passed=true on success.",
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
        description: "The program counter: budget vs actuals, wall remaining, sandbox path.",
        input: { type: "object", properties: { repo: { type: "string" } }, additionalProperties: false },
        options: { namespace: "isa" },
        execute: async (input: any) => {
          const repo = input.repo ?? active?.pointer.repo ?? location;
          const home = active?.home ?? join(resolve(repo), ".isa");
          return { content: await cli("status", ["--repo", resolve(repo), "--home", home, "--json"], 60_000) };
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

    // ---- enforcement hooks -------------------------------------------------

    await ctx.tool.hook("execute.before", (event: any) => {
      if (!active) return;
      const name = String(event?.tool ?? "");
      if (name.startsWith("isa_")) return; // ledger tools are free
      if (WORK_TOOLS.has(name)) bumpToolCalls();
    });

    await ctx.shell.hook("create.before", (event: any) => {
      if (!active) return;
      event.cwd = active.pointer.sandbox; // confine every shell command to the sandbox
      event.timeout = Math.min(Number(event.timeout) || 300_000, remainingWallMs());
      if (event.timeout <= 0) event.timeout = 1;
    });

    await ctx.permission.hook("evaluate", (event: any) => {
      if (!active) return;
      const action = String(event?.action ?? "");
      if (!MUTATE_ACTIONS.has(action)) return;
      if (active.denied) {
        event.effect = "deny";
        event.message = `isa: run ${active.pointer.id} over budget — work denied; call isa_end.`;
        return;
      }
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
