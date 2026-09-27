import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, readdirSync, watch, statSync, mkdirSync, writeFileSync, openSync, readSync, closeSync, type FSWatcher } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { homedir, hostname } from "node:os";
import { fileURLToPath } from "node:url";
import { Text, matchesKey, visibleWidth } from "@earendil-works/pi-tui";

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

// Resolve the SAME model/base URL/credential pi is currently streaming.
// ctx.model is the authoritative source. The credential is resolved the same
// way pi resolves it (modelRegistry.getProviderAuth, falling back to pi's
// auth store) and handed to spawned phase CLIs via PHASE_ALLOCATOR_API_KEY —
// without it every brain call 401s and silently degrades to offline fallback.
function resolvedModelId(ctx: any): string {
  return (
    process.env.PHASE_SLM_MODEL ?? process.env.PHASE_LLM_MODEL
    ?? ctx?.model?.id
    ?? process.env.PI_MODEL
    ?? "glm-5.3-flash"
  );
}

function resolvedApiKey(ctx: any): string | undefined {
  const explicit = process.env.PHASE_SLM_API_KEY ?? process.env.PHASE_LLM_API_KEY;
  if (explicit) return explicit;
  try {
    const providerId = ctx?.model?.provider ?? "ollama-cloud";
    const auth = ctx?.modelRegistry?.getProviderAuth?.(providerId);
    const k = auth?.apiKey ?? auth?.key;
    if (k && !String(k).startsWith("$")) return String(k);
  } catch { /* registry unavailable */ }
  try {
    // Last resort: pi's own auth store (same file, same provider key).
    const store = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "auth.json"), "utf8"));
    const v = store?.["ollama-cloud"];
    const k = typeof v === "string" ? v : v?.key;
    if (k && !String(k).startsWith("$")) return String(k);
  } catch { /* no auth store */ }
  return undefined;
}

function resolvedBaseUrl(ctx: any): string {
  const b = process.env.PHASE_SLM_BASE_URL ?? process.env.PHASE_LLM_BASE_URL
    ?? ctx?.model?.baseUrl;
  if (b) return normalizeV1(b); // keep cloud as cloud — we carry the key
  return OLLAMA_OPENAI;
}

async function run(binName: string, argv: string[], repo: string | undefined, ctx: any, timeout = 300_000): Promise<string> {
  const cmd = [CLI(binName), ...argv];
  if (repo) cmd.push("--repo", repo);
  const model = resolvedModelId(ctx);
  const base = resolvedBaseUrl(ctx);
  const key = resolvedApiKey(ctx);
  const { stdout, stderr } = await execFileP(process.execPath, cmd, {
    env: {
      ...process.env,
      PHASE_SLM_MODEL: model,
      PHASE_SLM_BASE_URL: base,
      PHASE_LLM_MODEL: model,
      PHASE_LLM_BASE_URL: base,
      ...(key ? { PHASE_ALLOCATOR_API_KEY: key, PHASE_SLM_API_KEY: key, PHASE_LLM_API_KEY: key } : {}),
    },
    timeout,
  });
  if (stderr) process.stderr.write(stderr);
  return stdout;
}

// ---------- session surface (docs/sessions.md) ----------
// The phase session is the repo-based workspace: .phase/session.json. It is
// pi-agent-agnostic and survives pi session termination; pi chats attach to it.

type PhaseTicket = {
  id: string;
  objective: string;
  status: string;
  claimed_by?: string | null;
  depends_on?: string[];
  created_at?: string;
  result?: string | null;
};
type PhaseLease = { agent: string; ticket_id?: string | null; alive?: boolean | null; heartbeat_at?: string };

type BusEvent = {
  seq?: number;
  type: string;
  ticket_id?: string;
  objective?: string;
  worker?: string;
  passed?: boolean;
  result?: string | null;
  [k: string]: unknown;
};

function phaseHome(cwd: string): string {
  const override = process.env.PHASE_HOME;
  return override ? resolve(override) : join(cwd, ".phase");
}

function readSessionJson(cwd: string): any | null {
  try {
    return JSON.parse(readFileSync(join(phaseHome(cwd), "session.json"), "utf8"));
  } catch {
    return null;
  }
}

/** Find the most recently active phase session near the launch directory.
 *  Phase used to bind ONLY to cwd — launching pi from ~ (how humans actually
 *  launch) silently bound nothing and the session started blind. Now, when
 *  cwd has no session, we scan one level DOWN (~/ABYSS, ~/roblox-fps ...) and
 *  one level SIDEWAYS (siblings), and surface the newest active session.
 *  Bounded: depth 1 in both directions, no recursion, stat-only until a
 *  session.json is found. */
function findActiveSession(cwd: string): { repo: string; session: any } | null {
  const local = readSessionJson(cwd);
  if (local) return { repo: cwd, session: local };
  const candidates: string[] = [];
  const push = (dir: string) => {
    try {
      for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) candidates.push(join(dir, e.name));
    } catch { /* unreadable dir: skip */ }
  };
  push(cwd);                  // children: repos under the launch dir (~/ABYSS)
  push(dirname(cwd));         // siblings: repos beside the launch dir
  const found: { repo: string; session: any }[] = [];
  for (const repo of candidates) {
    const s = readSessionJson(repo);
    if (s && (s.last_activity ?? s.updated_at)) found.push({ repo, session: s });
  }
  found.sort((a, b) => String(b.session.last_activity ?? "").localeCompare(String(a.session.last_activity ?? "")));
  return found[0] ?? null;
}

function readTickets(cwd: string): PhaseTicket[] {
  const dir = join(phaseHome(cwd), "tickets");
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".ticket.json")).map((f) => {
      try { return JSON.parse(readFileSync(join(dir, f), "utf8")) as PhaseTicket; } catch { return null; }
    }).filter(Boolean) as PhaseTicket[];
  } catch {
    return [];
  }
}

function readWorkers(cwd: string): Record<string, any> {
  try {
    return JSON.parse(readFileSync(join(phaseHome(cwd), "workers.json"), "utf8")) ?? {};
  } catch {
    return {};
  }
}

const STATUS_RANK: Record<string, number> = { in_progress: 0, failed: 1, open: 2, done: 3 };
function statusRank(status: string): number { return STATUS_RANK[status] ?? 4; }

/** Liveness computed in-process (deterministic pid check, read-only). */
function pidAliveLocal(pid: unknown): boolean | null {
  const p = Number(pid);
  if (!Number.isInteger(p) || p <= 0) return false;
  try { process.kill(p, 0); return true; } catch (e: any) { return e?.code === "EPERM" ? true : false; }
}

function readWorkersAlive(cwd: string): PhaseLease[] {
  const raw = readWorkers(cwd);
  return Object.entries(raw).map(([agent, l]: [string, any]) => ({
    agent, ticket_id: l?.ticket_id ?? null, heartbeat_at: l?.heartbeat_at,
    alive: l?.host && l?.host !== hostname() ? null : pidAliveLocal(l?.pid),
  }));
}

function listArchive(cwd: string): any[] {
  const dir = join(phaseHome(cwd), "archive");
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => {
      try { return JSON.parse(readFileSync(join(dir, f), "utf8")); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

function ticketTable(tickets: PhaseTicket[]): string {
  if (!tickets.length) return "(no live tickets — done tickets are archived)";
  const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n));
  const rows = [
    `${"ID".padEnd(12)} ${"STATUS".padEnd(12)} ${"WORKER".padEnd(14)} DEPS  OBJECTIVE`,
  ];
  for (const t of tickets.sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")))) {
    rows.push(
      `${t.id.padEnd(12)} ${t.status.padEnd(12)} ${(t.claimed_by ?? "—").padEnd(14)} ` +
      `${(t.depends_on ?? []).join(",") || "-"}  ${pad(t.objective, 60)}`,
    );
  }
  return rows.join("\n");
}

// [gate] pending N ticket(s): T-XXX T-YYY — printed by phase-chat headless
// after the human PERMISSION gate created (but did not schedule) tickets.
const GATE_PENDING = /\[gate\] pending (\d+) ticket\(s\): ([^\n]*)/;

async function drainTickets(repo: string, ctx: any): Promise<string> {
  return run("schedule", ["--drain"], repo, ctx, 900_000);
}

export default function (pi: ExtensionAPI) {
  const bins = {
    alloc: CLI("alloc"),
    orchestrate: CLI("orchestrate"),
    schedule: CLI("schedule"),
    bus: CLI("bus"),
    reconcile: CLI("reconcile"),
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

  // ---- phase_reconcile : evidence-based, audited ticket-store reconciliation.
  // Safe by default: dry-run unless --apply; every state change is logged to the
  // control bus with the git commit + keyword that justified it. Never fabricates
  // completion — a ticket is only closed when matching evidence exists.
  pi.registerTool({
    name: "phase_reconcile",
    label: "Phase Reconcile",
    description:
      "Reconcile a repo's phase ticket store against repository evidence (git history). DRY-RUN by default — only mark OPEN tickets done when matching evidence exists, and only if --apply. Every change is written as auditable ticket.reconcile + ticket.done events on the phase control bus. Use to correct drift between the ticket store and actual git completion.",
    parameters: Type.Object({
      repo: Type.Optional(Type.String({ description: "Absolute repo/git root to reconcile. Defaults to the phase project." })),
      apply: Type.Optional(Type.Boolean({ description: "Actually mark reconciled tickets done (default false = dry-run)." })),
      all: Type.Optional(Type.Boolean({ description: "Also report reverse-drift on already-done tickets (default false)." })),
      tickets: Type.Optional(Type.Array(Type.String())),
      map: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "ID -> git keyword used as completion evidence for that ticket." })),
      verbose: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, p: any, _signal, _onUpdate, ctx: any) {
      const argv: string[] = [];
      if (p.apply) argv.push("--apply");
      if (p.all) argv.push("--all");
      if (p.verbose) argv.push("--verbose");
      for (const id of p.tickets ?? []) argv.push("--ticket", id);
      for (const [k, v] of Object.entries(p.map ?? {})) argv.push("--map", `${k}=${v}`);
      const text = await run("reconcile", argv, p.repo, ctx);
      return { content: [{ type: "text", text }], details: {} };
    },
  });

  // ---------- session surface: state, watchers, widget ----------
  let watcher: FSWatcher | null = null;
  let tailOffset = 0;
  let draining = false;
  let boundCwd: string | null = null;

  const EVENT_GLYPH: Record<string, string> = {
    "ticket.created": ",",
    "ticket.claimed": "~",
    "ticket.started": ">",
    "ticket.done": "OK",
    "ticket.failed": "!!",
    "ticket.archived": "box",
    "ticket.reconcile": "=",
    "pool.start": "||",
    "worker.up": "+",
    "worker.down": "-",
  };

  function describeEvent(ev: BusEvent): string {
    const g = EVENT_GLYPH[ev.type] ?? "*";
    const id = ev.ticket_id ?? "";
    const w = ev.worker ? ` by ${ev.worker}` : "";
    switch (ev.type) {
      case "ticket.created":
        return `${g} ${id} created — ${ev.objective ?? ""}`;
      case "ticket.claimed":
      case "ticket.started":
        return `${g} ${id}${w}`;
      case "ticket.done":
        return `${g} ${id}${w} — ${(ev.result ?? "ok").toString().slice(0, 60)}`;
      case "ticket.failed":
        return `${g} ${id}${w} — ${(ev.result ?? "failed").toString().slice(0, 60)}`;
      case "ticket.archived":
        return `${g} ${id} compacted to archive`;
      default:
        return `${g} ${ev.type}${id ? ` ${id}` : ""}`;
    }
  }

  pi.registerEntryRenderer("phase-event", (entry: any, _opts: any, theme: any) => {
    const ev = (entry.data ?? {}) as BusEvent;
    const line = describeEvent(ev);
    let color: string | null = null;
    if (ev.type === "ticket.done" || ev.type === "ticket.archived") color = "success";
    else if (ev.type === "ticket.failed") color = "error";
    else if (ev.type === "ticket.created") color = "accent";
    return new Text(color ? theme.fg(color, line) : theme.fg("dim", line));
  });

  pi.registerEntryRenderer("phase-session", (entry: any, _opts: any, theme: any) => {
    const d = entry.data ?? {};
    const line = `phase session ${d.name ?? "?"} (${d.id ?? "?"})${d.goal ? ` — ${String(d.goal).slice(0, 60)}` : ""}`;
    return new Text(theme.fg("accent", theme.bold(line)));
  });

  function updateWidget(ctx: any): void {
    if (!ctx?.hasUI || !boundCwd) return;
    try {
      const sess = readSessionJson(boundCwd);
      if (!sess) return;
      const tickets = readTickets(boundCwd);
      const open = tickets.filter((t) => t.status === "open").length;
      const running = tickets.filter((t) => t.status === "in_progress").length;
      const failed = tickets.filter((t) => t.status === "failed").length;
      const archived = listArchive(boundCwd).length;
      const leases: PhaseLease[] = Object.values(readWorkers(boundCwd));
      const leaseLine = leases.length
        ? leases.map((l) => `${l.agent}${l.alive === false ? "(dead)" : ""} → ${l.ticket_id ?? "-"}`).join(" · ")
        : "no live workers";
      ctx.ui.setWidget("phase", [
        `phase ${sess.name ?? ""} · ${sess.id ?? ""}${sess.goal ? ` · ${String(sess.goal).slice(0, 48)}` : ""}`,
        `open ${open} · running ${running} · failed ${failed} · archived ${archived}`,
        leaseLine,
      ]);
    } catch {
      // widget is best-effort; never break the session on render errors
    }
  }

  function drainTail(ctx: any): void {
    if (!boundCwd || draining) return;
    draining = true;
    try {
      const ctl = join(phaseHome(boundCwd), "bus", "control.ndjson");
      if (!existsSync(ctl)) { draining = false; return; }
      const size = statSync(ctl).size;
      if (size < tailOffset) tailOffset = 0; // file was recreated — start over
      if (size === tailOffset) { draining = false; return; }
      const buf = Buffer.alloc(size - tailOffset);
      const fd = openSync(ctl, "r");
      try {
        const read = readSync(fd, buf, 0, buf.length, tailOffset);
        tailOffset += read;
      } finally {
        closeSync(fd);
      }
      const lines = buf.toString("utf8").split("\n").filter(Boolean);
      const events: BusEvent[] = [];
      for (const l of lines) {
        try { events.push(JSON.parse(l)); } catch { /* partial line; next drain continues */ }
      }
      for (const ev of events) pi.appendEntry("phase-event", ev);
      updateWidget(ctx);
    } catch {
      // tail is best-effort
    } finally {
      draining = false;
    }
  }

  function startWatcher(ctx: any, cwd: string): void {
    stopWatcher();
    boundCwd = cwd;
    const ctl = join(phaseHome(cwd), "bus", "control.ndjson");
    try {
      mkdirSync(dirname(ctl), { recursive: true });
      if (!existsSync(ctl)) writeFileSync(ctl, "", { flag: "a" });
      tailOffset = statSync(ctl).size;
      watcher = watch(ctl, { persistent: false }, () => drainTail(ctx));
    } catch {
      watcher = null; // no bus yet — created lazily when tickets appear
    }
  }

  function stopWatcher(): void {
    if (watcher) { try { watcher.close(); } catch { /* already closed */ } watcher = null; }
  }

  // ---------- the phase console: the text box, replaced ----------
  // A full interactive overlay: live ticket board + worker leases, keyboard
  // actions. Hands-off for the human (no typing needed to steer phase) and
  // usable by the agent (same state, same deterministic ops underneath).

  class PhaseConsole {
    private tui: any;
    private done: (v: string | null) => void;
    private ctx: any;
    private cwd: string;
    private timer: ReturnType<typeof setInterval> | null = null;
    private sel = 0;
    private view: "board" | "archive" = "board";
    private detail = false;
    private status = "";
    private busy = false;
    tickets: PhaseTicket[] = [];
    leases: PhaseLease[] = [];
    sess: any = null;
    archive: any[] = [];

    constructor(tui: any, done: (v: string | null) => void, ctx: any, cwd: string) {
      this.tui = tui;
      this.done = done;
      this.ctx = ctx;
      this.cwd = cwd;
      this.refresh();
      this.timer = setInterval(() => this.refresh(), 2000);
    }

    dispose(): void {
      if (this.timer) { clearInterval(this.timer); this.timer = null; }
    }

    refresh(): void {
      try {
        this.sess = readSessionJson(this.cwd);
        this.tickets = readTickets(this.cwd).sort((a, b) =>
          statusRank(a.status) - statusRank(b.status) || String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")));
        this.leases = readWorkersAlive(this.cwd);
        this.archive = listArchive(this.cwd);
      } catch { /* best-effort */ }
      if (this.sel >= this.visible().length) this.sel = Math.max(0, this.visible().length - 1);
      this.tui.requestRender();
    }

    visible(): PhaseTicket[] {
      return this.view === "board" ? this.tickets : [];
    }

    private setStatus(msg: string): void {
      this.status = msg;
      this.tui.requestRender();
    }

    handleInput(data: string): void {
      if (this.busy) return;
      const items = this.visible();
      if (matchesKey(data, "escape") || data === "q" || data === "Q") { this.dispose(); this.done(null); return; }
      if (matchesKey(data, "up") || data === "k") { if (this.sel > 0) this.sel--; }
      else if (matchesKey(data, "down") || data === "j") { if (this.sel < items.length - 1) this.sel++; }
      else if (data === "g") { this.sel = 0; }
      else if (data === "G") { this.sel = Math.max(0, items.length - 1); }
      else if (data === "a" || data === "A") { this.view = this.view === "board" ? "archive" : "board"; this.sel = 0; this.setStatus(""); }
      else if (data === "enter") { this.detail = !this.detail; }
      else if (data === "R") { this.refresh(); this.setStatus("refreshed"); }
      else if (data === "r" || data === "s" || data === "d" || data === "n") { void this.act(data); }
      this.tui.requestRender();
    }

    private selected(): PhaseTicket | null { return this.visible()[this.sel] ?? null; }

    /** Runtime ops go through src/ (deterministic transitions only — the
     *  console requests; TicketStore disposes). */
    private async getStore(): Promise<any | null> {
      try {
        const busPath = "../src/bus.mjs";
        const mod = (await import(/* @vite-ignore */ busPath)) as any;
        return new mod.TicketStore({ repo: this.cwd });
      } catch {
        this.setStatus("runtime unavailable (src/ not importable here)");
        return null;
      }
    }

    private async act(kind: string): Promise<void> {
      if (kind === "n") { this.dispose(); this.done("chat"); return; }
      if (kind === "d") {
        try {
          const child = spawn(process.execPath, [CLI("schedule"), "--drain", "--repo", this.cwd], {
            detached: true, stdio: "ignore",
            env: { ...process.env, PHASE_SLM_MODEL: resolvedModelId(this.ctx), PHASE_SLM_BASE_URL: resolvedBaseUrl(this.ctx), PHASE_LLM_MODEL: resolvedModelId(this.ctx), PHASE_LLM_BASE_URL: resolvedBaseUrl(this.ctx) },
          });
          child.unref();
          this.setStatus("drain started in background (workers claim open tickets)");
        } catch (e: any) {
          this.setStatus(`drain failed: ${String(e?.message ?? e).slice(0, 80)}`);
        }
        return;
      }
      const t = this.selected();
      if (!t) { this.setStatus("nothing selected"); return; }
      this.busy = true;
      const store = await this.getStore();
      this.busy = false;
      if (kind === "r") {
        const r = store?.retryTicket?.(t.id, { agent: "console" });
        this.setStatus(r ? `${t.id} → open (retry #${r.retries}) — press d to drain` : `${t.id}: only failed tickets can be retried`);
      } else if (kind === "s") {
        const r = store?.stealTicket?.(t.id, { agent: "console" });
        this.setStatus(!r ? `${t.id}: not in progress`
          : r.stolen ? `${t.id} stolen → open — press d to drain`
          : `${t.id}: ${r.reason} (never steals a live or foreign worker)`);
      }
      this.refresh();
    }

    render(width: number): string[] {
      const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
      const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
      const color = (c: string, s: string) => `\x1b[${c}m${s}\x1b[0m`;
      const lines: string[] = [];
      const pad = (s: string) => s + " ".repeat(Math.max(0, width - visibleWidth(s)));

      const open = this.tickets.filter((t) => t.status === "open").length;
      const run = this.tickets.filter((t) => t.status === "in_progress").length;
      const fail = this.tickets.filter((t) => t.status === "failed").length;
      const name = this.sess?.name ?? "?";
      const goal = this.sess?.goal ? ` · ${String(this.sess.goal).slice(0, Math.max(0, width - 30))}` : "";
      lines.push(pad(`${bold(color("36", `phase console — ${name}`))}${dim(goal)}`));
      lines.push(pad(dim(`open ${open} · running ${run} · failed ${fail} · archived ${this.archive.length} · ${this.leases.length} lease(s)`)));
      lines.push(pad(""));

      if (this.view === "archive") {
        const shown = this.archive.slice(-15);
        for (const r of shown) lines.push(pad(`  ${r.ticket?.id ?? "?"}  ${(r.digest?.objective ?? "").slice(0, 50)}  → ${(r.digest?.result ?? "").toString().slice(0, 30)}`));
        if (!shown.length) lines.push(pad(dim("(archive empty)")));
        lines.push(pad(dim("(a: back to board)")));
      } else if (!this.tickets.length) {
        lines.push(pad(dim("no live tickets — done work is archived (a to browse)")));
      } else {
        const glyph: Record<string, string> = { in_progress: "▸", open: "·", failed: "✗", done: "✔" };
        const col: Record<string, string> = { in_progress: "36", open: "37", failed: "31", done: "32" };
        this.tickets.forEach((t, i) => {
          const sel = i === this.sel ? bold(color("36", "❯ ")) : "  ";
          const lease = this.leases.find((l) => l.ticket_id === t.id);
          const who = t.claimed_by ?? (lease ? lease.agent : "—");
          const aliveMark = lease ? (lease.alive === false ? color("31", "(dead)") : lease.alive === null ? color("33", "(foreign)") : "") : "";
          let row = `${sel}${glyph[t.status] ?? "?"} ${t.id.padEnd(12)} ${color(col[t.status] ?? "0", t.status.padEnd(12))} ${String(who).slice(0, 14).padEnd(14)} ${aliveMark} ${(t.objective || "").slice(0, Math.max(10, width - 52))}`;
          lines.push(pad(row));
          if (i === this.sel && this.detail) {
            if (t.depends_on?.length) lines.push(pad(`      deps: ${t.depends_on.join(", ")}`));
            if (t.result) lines.push(pad(`      result: ${String(t.result).slice(0, width - 14)}`));
          }
        });
      }

      lines.push(pad(""));
      if (this.status) lines.push(pad(color("33", `» ${this.status}`)));
      const keys = this.view === "board"
        ? "j/k move · enter detail · r retry failed · s steal stale · d drain open · a archive · n new work · q close"
        : "a back to board · q close";
      lines.push(pad(dim(keys)));
      return lines;
    }
  }

  async function sessionPicker(ctx: any, cwd: string): Promise<void> {
    const sess = readSessionJson(cwd);
    const tickets = readTickets(cwd);
    const open = tickets.filter((t) => t.status === "open").length;
    const running = tickets.filter((t) => t.status === "in_progress").length;
    if (!ctx.hasUI) { ctx.ui.notify(ticketTable(tickets), "info"); return; }
    const name = sess?.name ?? "this repo";
    if (open + running === 0 && !sess) {
      ctx.ui.notify("No phase session in this repo. It is created automatically on the first ticket.", "info");
      return;
    }
    const choices = [
      `Continue where you left off — ${open} open / ${running} running`,
      "Ticket board",
      "Archive (compacted done tickets)",
      "Chat — specify new work",
      "Dismiss",
    ];
    const choice = await ctx.ui.select(`phase: ${name}${sess?.goal ? ` — ${String(sess.goal).slice(0, 48)}` : ""}`, choices);
    if (!choice || choice === "Dismiss") return;
    if (choice.startsWith("Continue")) {
      ctx.ui.notify(`Bound to phase session ${sess.id}. Ticket events will stream into the transcript.`, "info");
      updateWidget(ctx);
    } else if (choice.startsWith("Ticket board")) {
      ctx.ui.notify(ticketTable(tickets), "info");
    } else if (choice.startsWith("Archive")) {
      const arc = listArchive(cwd);
      ctx.ui.notify(arc.length ? arc.map((r) => `${r.ticket?.id ?? "?"}  ${(r.digest?.objective ?? "").slice(0, 60)}  → ${(r.digest?.result ?? "").toString().slice(0, 40)}`).join("\n") || "(empty)" : "(archive empty)", "info");
    } else if (choice.startsWith("Chat")) {
      await chatFlow(ctx, cwd);
    }
  }

  async function chatFlow(ctx: any, cwd: string): Promise<void> {
    if (!ctx.hasUI) {
      ctx.ui.notify("Interactive chat needs a TUI; use the phase_chat tool instead.", "info");
      return;
    }
    let msg = await ctx.ui.input("phase chat — describe the work (empty cancels):", "");
    let rounds = 0;
    while (msg && rounds < 4) {
      rounds++;
      let out: string;
      try {
        out = await run("chat", ["--prompt", msg, "--gate", "permission", "--chat"], cwd, ctx, 180_000);
      } catch (e: any) {
        ctx.ui.notify(`phase chat failed: ${String(e?.message ?? e).slice(0, 120)}`, "error");
        return;
      }
      const pending = GATE_PENDING.exec(out);
      if (pending) {
        const ok = await ctx.ui.confirm("phase", `Schedule ${pending[1]} ticket(s) now?`);
        if (ok) {
          ctx.ui.notify("Running tickets…", "info");
          const drain = await drainTickets(cwd, ctx);
          ctx.ui.notify(drain.trim().split("\n").slice(-3).join("\n") || "done", "info");
        } else {
          ctx.ui.notify(`Tickets stay open (${pending[2].trim()}). Run later with /phase.`, "info");
        }
        return;
      }
      const brain = /^brain> ([\s\S]*)$/.exec(out)?.[1]?.trim() ?? "(no reply)";
      ctx.ui.notify(`brain> ${brain.slice(0, 220)}`, "info");
      if (/\?\s*$/.test(brain)) {
        msg = await ctx.ui.input("phase chat — your answer (empty cancels):", "");
      } else {
        return;
      }
    }
  }

  // ---------- /phase command surface ----------
  // ---------- the console opener ----------
  async function openConsole(ctx: any, cwd: string): Promise<void> {
    if (ctx.mode !== "tui" || !ctx.hasUI) {
      // Non-TUI: fall back to the picker's plain-text surface.
      await sessionPicker(ctx, cwd);
      return;
    }
    for (;;) {
      const act: string | null = await (ctx.ui.custom as any)(
        (tui: any, _theme: any, _kb: any, done: (v: string | null) => void) => new PhaseConsole(tui, done, ctx, cwd),
        { overlay: true, overlayOptions: { width: "94%", maxHeight: "85%", anchor: "center" } },
      );
      if (act === "chat") { await chatFlow(ctx, cwd); continue; }
      return;
    }
  }

  pi.registerCommand("phase", {
    description:
      "Phase console: live ticket board with keyboard actions (retry/steal/drain/archive/chat). /phase chat, /phase tickets [panel|on|off], /phase archive also available. The session is ./.phase/session.json — repo-based, survives pi restarts.",
    handler: async (args, ctx) => {
      const cwd = ctx.cwd;
      const verb = String(args ?? "").trim();
      const sub = verb.split(/\s+/)[0] || "";

      if (!sub) { await openConsole(ctx, cwd); return; }

      if (sub === "chat") { await chatFlow(ctx, cwd); return; }

      if (sub === "tickets") {
        const arg = verb.split(/\s+/).slice(1).join(" ");
        if (arg === "panel" || arg === "on" || arg === "off") {
          const on = arg !== "off";
          if (!on) { ctx.ui.setWidget("phase", undefined); ctx.ui.notify("phase panel off", "info"); }
          else { updateWidget(ctx); ctx.ui.notify("phase panel on", "info"); }
          return;
        }
        ctx.ui.notify(ticketTable(readTickets(cwd)), "info");
        return;
      }

      if (sub === "archive") {
        const arc = listArchive(cwd);
        ctx.ui.notify(arc.length
          ? arc.map((r) => `${r.ticket?.id ?? "?"}  ${(r.digest?.objective ?? "").slice(0, 60)}  → ${(r.digest?.result ?? "").toString().slice(0, 40)}`).join("\n")
          : "(archive empty)", "info");
        return;
      }

      if (sub === "picker" || sub === "resume") { await sessionPicker(ctx, cwd); return; }

      if (sub === "taste") {
        const argv = verb.split(/\s+/).slice(1).filter((w) => w !== "get" || true);
        const cmd = argv[0] && ["set", "reset"].includes(argv[0]) ? argv[0] : "get";
        const text = await run("taste", [cmd, ...argv.slice(cmd === "set" ? 1 : 0)], undefined, ctx, 60_000);
        ctx.ui.notify("phase taste:\n" + text, "info");
        return;
      }

      ctx.ui.notify("usage: /phase [chat|tickets|archive|picker|taste]", "info");
    },
  });

  // ---- phase_taste : view/retune the director's dials in-session.
  // Edits validate, write atomically, and take effect on the NEXT review.
  pi.registerTool({
    name: "phase_taste",
    label: "Phase Taste",
    description:
      "View or retune the phase director's dials (bands, retry budget, follow-up cap, verification, stop rule) without touching files. Edits validate, write atomically to <repo>/phase.taste.mjs, and take effect on the next review.",
    parameters: Type.Object({
      repo: Type.Optional(Type.String({ description: "Absolute repo/git root. Defaults to the phase project." })),
      action: Type.Optional(Type.Union([Type.Literal("get"), Type.Literal("set"), Type.Literal("reset")], { description: "Default get." })),
      set: Type.Optional(Type.Array(Type.String(), { description: "Dial=value assignments, e.g. bands.yes=0.9 retry.maxAttempts=3" })),
    }),
    async execute(_id, p: any, _signal, _onUpdate, ctx: any) {
      const argv: string[] = [p.action ?? "get"];
      for (const s of p.set ?? []) argv.push(s);
      const text = await run("taste", argv, p.repo, ctx, 60_000);
      return { content: [{ type: "text", text }], details: { tool: "phase_taste" } };
    },
  });

  // ---------- phase_chat : the conversational work-specification tool ----------
  // The driving agent converses with the HUMAN in the main chat, then calls
  // phase_chat with the human's message. The phase brain (src/chat.mjs) replies
  // in bounded instructions: QUESTION (agent relays back), tickets with a
  // PERMISSION gate (human confirms via dialog; approved → deterministic drain),
  // or plain prose. State transitions stay in the deterministic runtime.
  pi.registerTool({
    name: "phase_chat",
    label: "Phase Chat",
    description:
      "Talk to the Phase coordination brain to specify work. Pass the human's message; the brain either asks a clarifying QUESTION (relay it to the human, then call again with the answer), proposes tickets behind a PERMISSION gate (human confirms; on approval tickets are scheduled), or plans directly. The repo session (.phase/session.json) persists across pi sessions.",
    promptSnippet: "Use phase_chat to converse with the phase brain and turn human intent into tickets.",
    promptGuidelines: [
      "Use phase_chat when the human describes new work for the repo: pass their message verbatim; relay any QUESTION to the human and call again with the answer.",
    ],
    parameters: Type.Object({
      message: Type.String({ description: "The human's message / answer to a clarifying question." }),
      repo: Type.Optional(Type.String({ description: "Absolute repo/git root. Defaults to the phase project." })),
      autoRun: Type.Optional(Type.Boolean({ description: "After the PERMISSION gate, ask the human to confirm and schedule (default true)." })),
    }),
    async execute(_id, p: { message: string; repo?: string; autoRun?: boolean }, _signal, _onUpdate, ctx: any) {
      const repo = p.repo ?? ctx.cwd;
      const out = await run("chat", ["--prompt", p.message, "--gate", "permission", "--chat"], repo, ctx, 180_000);
      const pending = GATE_PENDING.exec(out);
      let text = out;
      if (pending) {
        text = `proposed ${pending[1]} ticket(s): ${pending[2].trim()}`;
        if (p.autoRun !== false && ctx.hasUI) {
          const ok = await ctx.ui.confirm("phase", `Schedule ${pending[1]} ticket(s) now?`);
          if (ok) {
            const drain = await drainTickets(repo, ctx);
            text += `\n${drain.trim().split("\n").slice(-4).join("\n")}`;
          } else {
            text += "\n(human declined — tickets stay open; runnable later via /phase)";
          }
        }
      }
      return { content: [{ type: "text", text }], details: {} };
    },
  });

  // ---------- startup: point every pi session at session.json ----------
  pi.on("session_start", async (_event, ctx) => {
    const cwd = ctx.cwd;
    // Bind the session from cwd, or — launching from ~ — from the most
    // recently active phase repo among cwd's siblings (portfolio autodetect).
    const found = findActiveSession(cwd);
    if (!found) return; // no phase work anywhere nearby: stay silent, bind nothing
    const sess = found.session;
    const repo = found.repo;

    pi.appendEntry("phase-session", { id: sess.id, name: sess.name, goal: sess.goal, cwd, repo });

    if (ctx.hasUI) {
      updateWidget(ctx);
      if (process.env.PHASE_NO_AUTODETECT !== "1") {
        const tickets = readTickets(repo);
        const open = tickets.filter((t) => t.status === "open").length;
        const running = tickets.filter((t) => t.status === "in_progress").length;
        const away = repo !== cwd ? ` (${repo})` : "";
        if (open + running > 0) {
          const choice = await ctx.ui.select(
            `Continue where you left off? (phase ${sess.name ?? ""}${away}: ${open} open / ${running} running)`,
            ["Resume", "Ticket board", "Dismiss"],
          );
          if (choice === "Ticket board") ctx.ui.notify(ticketTable(tickets), "info");
          else if (choice === "Resume") await openConsole(ctx, repo);
        }
      }
    }

    startWatcher(ctx, repo);
  });

  pi.on("session_shutdown", async () => {
    stopWatcher();
  });
}
