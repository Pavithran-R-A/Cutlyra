#!/usr/bin/env node
/**
 * Release gate for licenses in the Rust dependency closure that actually feeds
 * rust/wasm (the committed WebAssembly payload used by the mobile/web editor).
 *
 * This is intentionally narrower than the whole Cargo workspace: desktop-only
 * crates are not part of the Android v0.1 binary. We traverse cargo metadata's
 * resolved graph starting at opencut-wasm and inspect every external package in
 * that closure.
 *
 * The gate is conservative. Missing/opaque license metadata or copyleft/custom
 * licenses do not get silently approved; they require an explicit legal review
 * and an allowlist change with rationale.
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const cargo = spawnSync(
  "cargo",
  [
    "metadata",
    "--format-version",
    "1",
    "--locked",
    "--filter-platform",
    "wasm32-unknown-unknown",
  ],
  {
    cwd: repoRoot,
    encoding: "utf8",
    // cargo metadata for this workspace is several megabytes even though we
    // later traverse only the opencut-wasm closure. Node/Bun spawnSync's
    // default output buffer is too small and reports status=null/ENOBUFS.
    maxBuffer: 64 * 1024 * 1024,
  },
);

if (cargo.error) {
  throw cargo.error;
}
if (cargo.status !== 0) {
  process.stderr.write(cargo.stdout || "");
  process.stderr.write(cargo.stderr || "");
  throw new Error(`cargo metadata failed with exit code ${cargo.status}`);
}

const metadata = JSON.parse(cargo.stdout);
const rootPkg = metadata.packages.find((pkg) => pkg.name === "opencut-wasm");
if (!rootPkg) throw new Error("opencut-wasm package not found in cargo metadata");
if (!metadata.resolve) throw new Error("cargo metadata did not include a resolve graph");

const nodeById = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
const packageById = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
const closure = new Set();
const queue = [rootPkg.id];

while (queue.length) {
  const id = queue.pop();
  if (!id || closure.has(id)) continue;
  closure.add(id);
  const node = nodeById.get(id);
  if (!node) continue;
  for (const dep of node.deps) queue.push(dep.pkg);
}

const external = [...closure]
  .map((id) => packageById.get(id))
  .filter(Boolean)
  .filter((pkg) => pkg.source !== null)
  .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

const missing = [];
const review = [];
const REVIEW_RE = /(?:^|[^A-Z])(?:A?GPL|LGPL|MPL|EPL|CDDL|SSPL|BUSL|POLYFORM|LICENSE ?REF)/i;

for (const pkg of external) {
  const license = (pkg.license || "").trim();
  if (!license) {
    missing.push(`${pkg.name}@${pkg.version}`);
    continue;
  }
  if (REVIEW_RE.test(license)) {
    review.push(`${pkg.name}@${pkg.version}: ${license}`);
  }
}

console.log(
  `WASM license closure: ${closure.size} package(s), ${external.length} external package(s).`,
);
for (const pkg of external) {
  console.log(`  ${pkg.name}@${pkg.version}: ${pkg.license || "<missing>"}`);
}

if (missing.length || review.length) {
  if (missing.length) {
    console.error("\nExternal Rust packages with missing license metadata:");
    for (const item of missing) console.error(`  - ${item}`);
  }
  if (review.length) {
    console.error("\nExternal Rust packages requiring explicit license review:");
    for (const item of review) console.error(`  - ${item}`);
  }
  console.error(
    "\nFailing closed. Review these packages before shipping and document any deliberate allowlist.",
  );
  process.exit(1);
}

console.log("WASM license gate: no missing or review-required external licenses.");
