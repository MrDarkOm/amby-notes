// Checks that every requirement of docs/sync-plan.md (promises О, decisions Р, failures С) is
// mentioned in at least one test under sync/ (plan, section 6, step 4). Р12 and Р14 are about
// the layout of the code and the future, so no test can cover them.
//
// The letters of the identifiers are Cyrillic (О, Р, С), the same as in the plan; a Latin
// look-alike in a test comment does not count on purpose.
import { existsSync, readFileSync, readdirSync } from "node:fs"
import console from "node:console"
import path from "node:path"
import process from "node:process"
import { fileURLToPath, URL } from "node:url"

const root = fileURLToPath(new URL("../", import.meta.url))
const planPath = path.join(root, "docs", "sync-plan.md")
const exempt = new Set(["Р12", "Р14"])
const skipped = new Set([
  "target",
  ".venv",
  "node_modules",
  "__pycache__",
  ".git",
  "artifacts",
  "corpus",
])
const testExtensions = new Set([".rs", ".py"])

if (!existsSync(planPath)) {
  console.log("Sync requirements: docs/sync-plan.md is not in this checkout, nothing to check.")
  process.exit(0)
}

const plan = readFileSync(planPath, "utf8")
const required = new Set()
for (const match of plan.matchAll(/^- \*\*(О\d+)\./gm)) required.add(match[1])
for (const match of plan.matchAll(/^### (Р\d+)\./gm)) required.add(match[1])
for (const match of plan.matchAll(/^\| (С\d+) /gm)) required.add(match[1])
for (const id of exempt) required.delete(id)

// A test file is any Rust or Python file in a `tests` directory, in the conformance crate, or
// named test_*.py / *_test.rs anywhere under sync/.
function isTestFile(relative) {
  const parts = relative.split("/")
  const name = parts[parts.length - 1]
  if (!testExtensions.has(path.extname(name))) return false
  return (
    parts.includes("tests") ||
    parts.includes("fuzz_targets") ||
    parts[1] === "conformance" ||
    /^test_.*\.py$/.test(name) ||
    /_test\.rs$/.test(name)
  )
}

const testFiles = []
function walk(directory) {
  for (const entry of readdirSync(path.join(root, directory), { withFileTypes: true })) {
    const relative = path.posix.join(directory, entry.name)
    if (entry.isDirectory() && !skipped.has(entry.name)) walk(relative)
    if (entry.isFile() && isTestFile(relative)) testFiles.push(relative)
  }
}
if (existsSync(path.join(root, "sync"))) walk("sync")

const covered = new Map()
for (const file of testFiles) {
  const text = readFileSync(path.join(root, file), "utf8")
  for (const match of text.matchAll(/(?<![\p{L}\d])([ОРС]\d{1,2})(?!\d)/gu)) {
    if (!required.has(match[1])) continue
    covered.set(match[1], (covered.get(match[1]) ?? 0) + 1)
  }
}

const order = (id) =>
  [...id.slice(1)].reduce((n, c) => n * 10 + Number(c), 0) +
  (id[0] === "О" ? 0 : id[0] === "Р" ? 1000 : 2000)
const sorted = [...required].sort((a, b) => order(a) - order(b))
const missing = sorted.filter((id) => !covered.has(id))

console.log(
  `Sync requirements: ${sorted.length - missing.length} of ${sorted.length} mentioned in ${testFiles.length} test file(s) under sync/.`,
)
for (const id of sorted) console.log(`  ${id}: ${covered.get(id) ?? 0}`)
if (missing.length) {
  console.log(`Not covered yet: ${missing.join(", ")}`)
  process.exit(1)
}
