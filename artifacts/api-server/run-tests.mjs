/**
 * Zero-dependency test runner: esbuild-bundles each test/*.test.ts file
 * (type-only imports erased, so pure modules stay pure) and runs them with
 * Node's built-in test runner.
 */
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const testDir = path.join(root, "test");
const outDir = path.join(root, "dist-test");

rmSync(outDir, { recursive: true, force: true });

const entries = readdirSync(testDir).filter((f) => f.endsWith(".test.ts")).map((f) => path.join(testDir, f));
if (entries.length === 0) {
  console.error("No test files found in", testDir);
  process.exit(1);
}

await build({
  entryPoints: entries,
  outdir: outDir,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: "inline",
  // pino uses dynamic require("node:os") which can't be bundled into ESM —
  // keep it (and its logging deps) external so Node resolves them normally.
  // This lets tests import logger-backed modules (resilience, observability…).
  external: ["node:*", "pino", "pino-pretty", "pino-http", "thread-stream", "xlsx", "pdf-parse"],
  outExtension: { ".js": ".mjs" },
});

const compiled = readdirSync(outDir).filter((f) => f.endsWith(".test.mjs")).map((f) => path.join(outDir, f));
// NODE_ENV=production disables pino's pino-pretty transport (a worker thread
// that can't be resolved from the bundled test output); LOG_LEVEL=silent keeps
// test output clean. Tests that import logger-backed modules then run fine.
const res = spawnSync(process.execPath, ["--test", ...compiled], {
  stdio: "inherit",
  env: { ...process.env, NODE_ENV: "production", LOG_LEVEL: "silent" },
});
process.exit(res.status ?? 1);
