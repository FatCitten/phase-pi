import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";

export function sha256(value) {
  return createHash("sha256").update(Buffer.isBuffer(value) ? value : String(value)).digest("hex");
}

export function nowIso() {
  return new Date().toISOString();
}

function git(cwd, args) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

export function canonicalRepositoryPath(cwd) {
  const absolute = resolve(cwd);
  const root = git(absolute, ["rev-parse", "--show-toplevel"]) || absolute;
  try { return realpathSync(root); } catch { return resolve(root); }
}

export function repositoryDomainId(cwd) {
  return `R${sha256(canonicalRepositoryPath(cwd)).slice(0, 24).toUpperCase()}`;
}

export function gitSnapshot(cwd) {
  const root = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!root) return { root: null, commit: null, dirty: false, statusHash: null };
  const commit = git(root, ["rev-parse", "HEAD"]);
  const status = git(root, ["status", "--porcelain=v1", "--untracked-files=all"]) ?? "";
  return { root, commit, dirty: status.length > 0, statusHash: sha256(status) };
}
