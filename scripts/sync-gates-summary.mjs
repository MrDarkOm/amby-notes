#!/usr/bin/env node
// Merges the per-shard results of the sync gates (.github/workflows/sync-gates.yml) into one
// Markdown summary. Report only: it fails when a shard is missing or broken, never because a
// mutant survived (the owner examines survivors by hand, docs/sync-plan.md, "Ворота").
//
//   node scripts/sync-gates-summary.mjs mutants <dir> <expected shards> [out.md]
//   node scripts/sync-gates-summary.mjs sim <dir> <expected logs> [out.md]
//
// <dir> holds one sub-directory per downloaded artifact. Mutants: `<dir>/*/outcomes.json` of
// cargo-mutants. Simulation: `<dir>/*/*.log` of `amby-sync-simrun`.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const [mode, dir, expectedText, outFile] = process.argv.slice(2)
const expected = Number(expectedText)
if (!["mutants", "sim"].includes(mode) || !dir || !Number.isInteger(expected)) {
  console.error("usage: sync-gates-summary.mjs mutants|sim <dir> <expected count> [out.md]")
  process.exit(2)
}

const subdirs = existsSync(dir)
  ? readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(dir, entry.name))
      .sort()
  : []

const lines = []
let problems = 0
const say = (text = "") => lines.push(text)

if (mode === "mutants") {
  const counts = { total: 0, caught: 0, missed: 0, timeout: 0, unviable: 0, other: 0 }
  const missed = []
  const timeouts = []
  let shards = 0
  let wallSeconds = 0
  for (const shard of subdirs) {
    const file = join(shard, "outcomes.json")
    if (!existsSync(file)) continue
    shards += 1
    const data = JSON.parse(readFileSync(file, "utf8"))
    wallSeconds += (Date.parse(data.end_time) - Date.parse(data.start_time)) / 1000 || 0
    for (const outcome of data.outcomes) {
      const mutant = outcome.scenario?.Mutant
      if (!mutant) {
        if (outcome.summary !== "Success") {
          problems += 1
          say(`**Baseline of ${shard} failed (${outcome.summary}); its mutants did not count.**`)
        }
        continue
      }
      counts.total += 1
      const where = `${mutant.file}:${mutant.span.start.line}`
      const row = { where, name: mutant.name, replacement: mutant.replacement, genre: mutant.genre }
      switch (outcome.summary) {
        case "CaughtMutant":
          counts.caught += 1
          break
        case "MissedMutant":
          counts.missed += 1
          missed.push(row)
          break
        case "Timeout":
          counts.timeout += 1
          timeouts.push(row)
          break
        case "Unviable":
          counts.unviable += 1
          break
        default:
          counts.other += 1
      }
    }
  }
  if (shards !== expected) {
    problems += 1
    say(
      `**Only ${shards} of ${expected} shards delivered results; the totals below are incomplete.**`,
    )
    say()
  }
  say("## Mutation testing of the sync core")
  say()
  say("| Caught | Missed | Timeout | Unviable | Other | Total | Shards |")
  say("| ---: | ---: | ---: | ---: | ---: | ---: | ---: |")
  say(
    `| ${counts.caught} | ${counts.missed} | ${counts.timeout} | ${counts.unviable} | ${counts.other} | ${counts.total} | ${shards}/${expected} |`,
  )
  say()
  const testable = counts.caught + counts.missed + counts.timeout
  if (testable > 0) {
    const killed = counts.caught + counts.timeout
    say(
      `Caught or timed out: ${killed} of ${testable} viable mutants (${((100 * killed) / testable).toFixed(1)} %). ` +
        `Timeouts count as caught (an endless loop is a visible failure). Total shard time ${(wallSeconds / 3600).toFixed(1)} h.`,
    )
    say()
  }
  if (missed.length === 0) {
    say("No mutant survived.")
  } else {
    say(`### Missed mutants to examine (${missed.length})`)
    say()
    say(
      "Each one needs either a new test (red on this mutant first, separate commit) or a written reason it is harmless.",
    )
    say()
    say("| Where | Mutation |")
    say("| --- | --- |")
    for (const row of missed.sort((a, b) =>
      a.where.localeCompare(b.where, "en", { numeric: true }),
    )) {
      say(
        `| \`${row.where}\` | ${row.name.split(": ").slice(1).join(": ").replaceAll("|", "\\|")} |`,
      )
    }
  }
  if (timeouts.length > 0) {
    say()
    say(
      `### Timeouts (${timeouts.length}, counted as caught; check they are loops, not a slow runner)`,
    )
    say()
    for (const row of timeouts)
      say(`- \`${row.where}\` ${row.name.split(": ").slice(1).join(": ")}`)
  }
  if (counts.other > 0) {
    problems += 1
    say()
    say(
      `**${counts.other} mutants ended in an unexpected state (the baseline failed or the run was cut).**`,
    )
  }
} else {
  const done =
    /^mode=(\S+) seeds (\d+)\.\.(\d+) done in ([\d.]+) s: (\d+) passed, (\d+) failed, (\d+) repeated/
  let jobs = 0
  let passed = 0
  let failed = 0
  let repeated = 0
  let seconds = 0
  const failures = []
  const infra = []
  const byMode = new Map()
  for (const shard of subdirs) {
    for (const name of readdirSync(shard).filter((f) => f.endsWith(".log"))) {
      const text = readFileSync(join(shard, name), "utf8")
      const lastLine = text.trim().split("\n").at(-1) ?? ""
      const match = done.exec(lastLine)
      if (!match) {
        problems += 1
        say(`**${name} did not finish (no closing line): the runner was cut or crashed.**`)
        continue
      }
      jobs += 1
      const [, runMode, from, to, secs, ok, bad, again] = match
      passed += Number(ok)
      failed += Number(bad)
      repeated += Number(again)
      seconds += Number(secs)
      const total = byMode.get(runMode) ?? { scenarios: 0, from: Infinity, to: 0 }
      total.scenarios += Number(to) - Number(from)
      total.from = Math.min(total.from, Number(from))
      total.to = Math.max(total.to, Number(to))
      byMode.set(runMode, total)
      for (const line of text.split("\n")) {
        const fail = /^(FAIL mode=(\S+) seed=(\d+)|PANIC seed=(\d+))/.exec(line)
        if (fail) {
          const seed = fail[3] ?? fail[4]
          failures.push({ mode: fail[2] ?? runMode, seed, line: line.slice(0, 200) })
        }
        if (line.startsWith("INFRA")) infra.push(line)
      }
    }
  }
  if (jobs !== expected) {
    problems += 1
    say(`**Only ${jobs} of ${expected} runner logs delivered results.**`)
    say()
  }
  say("## Long simulation of the real engine")
  say()
  say("| Mode | Seeds | Scenarios |")
  say("| --- | --- | ---: |")
  for (const [runMode, total] of byMode) {
    say(`| ${runMode} | ${total.from}..${total.to} | ${total.scenarios} |`)
  }
  say()
  say(
    `${passed} passed, ${failed} failed, ${repeated} repeated after a transport failure of the test client, ${infra.length} gave up on the transport. Total runner time ${(seconds / 3600).toFixed(1)} h.`,
  )
  if (infra.length > 0) {
    problems += 1
    say()
    say(
      "### Seeds where the test transport failed twice (the machine, not the engine; run them again)",
    )
    say()
    for (const line of infra) say(`- \`${line}\``)
  }
  if (failures.length > 0) {
    say()
    say(`### Failing seeds (${failures.length})`)
    say()
    say("Reproduce one locally (the full violation and trace are in the artifact `sim-logs-*`):")
    say()
    say("```sh")
    say(
      "cargo run --release --manifest-path sync/Cargo.toml -p amby-sync-simrun -- <seed> 1 <quick|folders>",
    )
    say("```")
    say()
    for (const f of failures) say(`- mode \`${f.mode}\`, seed \`${f.seed}\``)
  } else if (jobs === expected) {
    say()
    say("No scenario failed.")
  }
}

const text = `${lines.join("\n")}\n`
if (outFile) writeFileSync(outFile, text)
process.stdout.write(text)
process.exit(problems > 0 ? 1 : 0)
