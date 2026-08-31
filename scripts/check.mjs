// scripts/check.mjs — syntax-check every JS/MJS file in the project.
// Usage: node scripts/check.mjs
import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const dirs = ["lib", "test", "eval", "examples", "scripts"];

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const abs = path.join(dir, entry);
    const stat = statSync(abs);
    if (stat.isDirectory()) out.push(...walk(abs));
    else if (entry.endsWith(".js") || entry.endsWith(".mjs")) out.push(abs);
  }
  return out;
}

const files = [];
for (const dir of dirs) {
  const abs = path.join(root, dir);
  if (!statSync(abs, { throwIfNoEntry: false })) continue;
  files.push(...walk(abs));
}

let failed = 0;
for (const file of files) {
  const res = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" });
  if (res.status !== 0) failed++;
}
console.log("checked " + files.length + " file(s), " + failed + " failed");
process.exit(failed > 0 ? 1 : 0);
