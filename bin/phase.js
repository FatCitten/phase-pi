#!/usr/bin/env node
/**
 * phase — v1 Pi-native launcher.
 *
 * Run phase -> ensure Pi -> ensure phase installed -> hand off to Pi.
 * Phase works in Pi. That's the only target.
 *
 * Safety (v2.1.1):
 *  - idempotent: never re-register phase if it's already in Pi
 *  - non-destructive: backs up ~/.pi/agent/settings.json before mutating it
 *  - nested-Pi aware: if run from inside a live Pi session it will NOT spawn a
 *    nested `pi` or reload the running session — those brick Pi. It just stops.
 */
import { execFileSync } from "node:child_process";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { readFileSync, writeFileSync, renameSync, existsSync, copyFileSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PHASE_ROOT = resolve(HERE, "..");
const PI_PKG = "@earendil-works/pi-coding-agent";
const CONFIG = join(homedir(), ".pi", "agent", "settings.json");

function has(cmd) {
  try { execFileSync("which", [cmd], { stdio: "ignore" }); return true; }
  catch { return false; }
}
function run(cmd, args) {
  return execFileSync(cmd, args, { stdio: "inherit" });
}

// True when THIS command is already running inside a Pi session.
function insidePi() {
  return !!process.env.PI_CODING_AGENT || !!process.env.PI_SESSION_FILE;
}

function readSettings() {
  try { return JSON.parse(readFileSync(CONFIG, "utf8")); }
  catch { return null; }
}
function atomicWrite(json) {
  try {
    if (existsSync(CONFIG)) copyFileSync(CONFIG, `${CONFIG}.bak`); // backup first
    writeFileSync(`${CONFIG}.tmp`, JSON.stringify(json, null, 2));
    renameSync(`${CONFIG}.tmp`, CONFIG); // atomic replace — never a half-written file
  } catch (e) {
    console.warn("phase: could not write Pi settings; leaving config untouched.", String(e.message));
    return false;
  }
  return true;
}

// Is phase already registered? Match absolute path, relative path, basename,
// or npm name — so re-runs never re-register.
function phaseRegistered(settings) {
  const pkgs = settings?.packages ?? [];
  const idMatch = /(^|\/)phase(?:-pi)?$/;
  return pkgs.some((p) => {
    if (typeof p !== "string") return false;
    if (p === PHASE_ROOT) return true;
    if (p.includes(PHASE_ROOT)) return true;
    return idMatch.test(p) || p === "phase-pi" || p === "@fatcitten/phase-pi";
  });
}

function ensurePi() {
  if (has("pi")) return;
  if (!has("npm")) {
    console.error("phase: need npm for Pi. Get Node >= 20 first.");
    process.exit(1);
  }
  console.log("phase: Pi missing. Installing ->");
  run("npm", ["install", "-g", "--ignore-scripts", PI_PKG]);
  if (!has("pi")) {
    try {
      const prefix = execFileSync("npm", ["prefix", "-g"], { encoding: "utf8" }).trim();
      process.env.PATH = `${prefix}/bin:${process.env.PATH}`;
    } catch {}
  }
  if (!has("pi")) {
    console.error("phase: Pi installed but not on PATH. Add $(npm prefix -g)/bin.");
    process.exit(1);
  }
}

// Register phase idempotently by writing the package entry directly into Pi's
// settings. Avoids a `pi install` subprocess, which can reload/conflict with a
// running session. Never spawns anything when already inside Pi.
function registerPhase() {
  const settings = readSettings() ?? {};
  if (phaseRegistered(settings)) return "already";
  const pkgs = Array.isArray(settings.packages) ? [...settings.packages] : [];
  pkgs.push(PHASE_ROOT);
  settings.packages = pkgs;
  return atomicWrite(settings) ? "registered" : "failed";
}

ensurePi();
const how = registerPhase();

if (how === "registered") {
  console.log('\nphase: installed & ready in Pi. Try: phase_allocate "add rate limiting"\n');
} else if (how === "already") {
  console.log("\nphase: already installed in Pi — nothing changed.\n");
} else {
  console.log("\nphase: couldn't write Pi settings (left a .bak). Install Pi manually, or re-run.\n");
}

if (insidePi()) {
  // Already in Pi. Spawning a nested `pi` bricks the session -> just stop.
  process.exit(0);
}

// Hand off to a fresh Pi session where phase is already live.
run("pi", process.argv.slice(2));
