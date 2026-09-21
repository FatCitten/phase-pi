#!/usr/bin/env node
/**
 * phase — v1 Pi-native launcher.
 *
 * Run phase -> ensure Pi -> install phase into Pi -> hand off to Pi.
 * Phase works in Pi. That's the only target.
 */
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PHASE_ROOT = resolve(HERE, "..");
const PI_PKG = "@earendil-works/pi-coding-agent";

function has(cmd) {
  try { execFileSync("which", [cmd], { stdio: "ignore" }); return true; }
  catch { return false; }
}
function run(cmd, args) {
  return execFileSync(cmd, args, { stdio: "inherit" });
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
    // npm global bin may not be on this shell's PATH yet.
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

function installIntoPi() {
  try { run("pi", ["install", PHASE_ROOT]); }
  catch (e) { console.warn("phase: pi install hiccup; continuing.", String(e.message)); }
}

ensurePi();
installIntoPi();
console.log("\nphase: installed & ready in Pi. Try: phase_allocate \"add rate limiting\"\n");
run("pi", process.argv.slice(2)); // hand off to Pi -> phase is live
