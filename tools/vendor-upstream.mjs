#!/usr/bin/env node
// Fetch the CISA sources SCuBAAnywhere builds on, at the pinned commits in
// tools/upstream.json. Nothing from vendor/ is committed: upstream stays the
// source of truth for both the Rego policies and the baseline text.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const upstream = JSON.parse(readFileSync(join(root, "tools/upstream.json"), "utf8"));
const vendorDir = join(root, "vendor");

function run(cmd, args, cwd) {
  execFileSync(cmd, args, { cwd, stdio: "inherit", env: { ...process.env, GIT_LFS_SKIP_SMUDGE: "1" } });
}

function checkout(name, spec) {
  const dest = join(vendorDir, name);
  if (existsSync(dest)) {
    const head = execFileSync("git", ["-C", dest, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    if (head === spec.commit) {
      console.log(`${name}: already at ${spec.ref} (${spec.commit.slice(0, 8)})`);
      return;
    }
    console.log(`${name}: checkout is at ${head.slice(0, 8)}, replacing with ${spec.ref}`);
    rmSync(dest, { recursive: true, force: true });
  }
  // Fetch the pinned commit itself rather than a tag or branch tip. Tags move,
  // and these files decide what every assessment reports.
  mkdirSync(dest, { recursive: true });
  console.log(`${name}: fetching ${spec.repo} at ${spec.commit.slice(0, 8)} (${spec.ref})`);
  run("git", ["init", "-q"], dest);
  run("git", ["remote", "add", "origin", spec.repo], dest);
  run("git", ["fetch", "--depth", "1", "origin", spec.commit], dest);
  run("git", ["checkout", "-q", "FETCH_HEAD"], dest);

  const head = execFileSync("git", ["-C", dest, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (head !== spec.commit) {
    rmSync(dest, { recursive: true, force: true });
    throw new Error(`${name}: checked out ${head}, expected ${spec.commit}`);
  }
  console.log(`${name}: verified ${spec.commit.slice(0, 8)}`);
}

mkdirSync(vendorDir, { recursive: true });
checkout("scubagear", upstream.scubagear);
checkout("scubagoggles", upstream.scubagoggles);

for (const [name, spec] of [["scubagear", upstream.scubagear], ["scubagoggles", upstream.scubagoggles]]) {
  for (const [label, rel] of Object.entries(spec.paths)) {
    const path = join(vendorDir, name, rel);
    if (!existsSync(path)) throw new Error(`${name}: expected ${label} at ${rel}, which is missing`);
  }
}
console.log("vendor/ is ready");
