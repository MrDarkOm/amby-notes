#!/usr/bin/env node

/**
 * Build and measure a disposable database fixture. The Rust benchmark opens
 * the same durable files that the desktop projection reads, so this is a
 * database benchmark rather than a plain note-count smoke test.
 *
 * Usage: npm run db:benchmark -- --size 10000
 */
import { spawnSync } from "node:child_process"
import { rm, mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"

const allowedSizes = new Set([10000, 50000, 100000])
const sizeIndex = globalThis.process.argv.indexOf("--size")
const size = Number(sizeIndex >= 0 ? globalThis.process.argv[sizeIndex + 1] : "10000")
if (!allowedSizes.has(size)) throw new Error("--size must be 10000, 50000, or 100000")

const output = await mkdtemp(join(tmpdir(), "amby-db-fixture-benchmark-"))
if (!basename(output).startsWith("amby-db-fixture-") || !output.startsWith(resolve(tmpdir()))) {
  throw new Error("benchmark output must stay below the system temporary directory")
}

try {
  const generated = spawnSync(
    globalThis.process.execPath,
    ["scripts/generate-database-fixture.mjs", "--size", String(size), "--output", output],
    { encoding: "utf8" },
  )
  if (generated.status !== 0) throw new Error(generated.stderr || "fixture generation failed")
  const fixture = JSON.parse(generated.stdout)
  const result = spawnSync(
    "cargo",
    [
      "test",
      "--manifest-path",
      "src-tauri/Cargo.toml",
      "database::projection::tests::database_fixture_benchmark_reports_rebuild_and_query_timings",
      "--",
      "--ignored",
      "--nocapture",
    ],
    {
      encoding: "utf8",
      env: {
        ...globalThis.process.env,
        AMBY_DB_BENCHMARK_ROOT: output,
        AMBY_DB_BENCHMARK_DATABASE_ID: fixture.databaseId,
      },
    },
  )
  if (result.status !== 0) throw new Error(result.stderr || result.stdout)
  const line = result.stdout
    .split("\n")
    .find((candidate) => candidate.startsWith("DB_BENCHMARK_JSON="))
  if (!line) throw new Error("Rust benchmark did not emit a result")
  const metrics = JSON.parse(line.slice("DB_BENCHMARK_JSON=".length))
  globalThis.console.log(JSON.stringify({ fixture, metrics }, null, 2))
} finally {
  await rm(output, { recursive: true, force: true })
}
