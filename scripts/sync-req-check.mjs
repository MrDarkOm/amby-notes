// Checks that every requirement of docs/sync-plan.md (promises О, decisions Р, failures С, and the
// decisions Г of appendix Г, and the decisions П50…П62, Д73…Д78 and У1…У5 of appendix Е) is
// mentioned in at least one test under sync/ (plan, section 6, step 4). Р12 and Р14 are about
// the layout of the code and the future, so no test can cover them.
//
// The letters of the identifiers are Cyrillic (О, Р, С, Г), the same as in the plan; a Latin
// look-alike in a test comment does not count on purpose. The Cyrillic Г is the decisions of
// appendix Г.
import { existsSync, readFileSync, readdirSync } from "node:fs"
import console from "node:console"
import path from "node:path"
import process from "node:process"
import { fileURLToPath, URL } from "node:url"

const root = fileURLToPath(new URL("../", import.meta.url))
const planPath = path.join(root, "docs", "sync-plan.md")
// Г1 is words, Г3 a statement about where the merge lives in the code, Г36 the names of commands
// that another session writes: no test of this stage can cover them.
const exempt = new Set(["Р12", "Р14", "Г1", "Г3", "Г36"])
const skipped = new Set([
  "target",
  ".venv",
  "node_modules",
  "__pycache__",
  ".git",
  "artifacts",
  "corpus",
])
const testExtensions = new Set([".rs", ".py", ".ts", ".tsx"])

if (!existsSync(planPath)) {
  console.log("Sync requirements: docs/sync-plan.md is not in this checkout, nothing to check.")
  process.exit(0)
}

const plan = readFileSync(planPath, "utf8")
const required = new Set()
for (const match of plan.matchAll(/^- \*\*(О\d+)\./gm)) required.add(match[1])
for (const match of plan.matchAll(/^### (Р\d+)\./gm)) required.add(match[1])
for (const match of plan.matchAll(/^\| (С\d+) /gm)) required.add(match[1])
// Appendix Г (stage Э4б, conflicts v2): every decision Г2…Г35 is named in a test.
for (const match of plan.matchAll(/^- \*\*(Г\d+)\./gm)) required.add(match[1])
// Appendix Е (tariffs and limits): the decisions of its tables, П50…П62, Д73…Д78, У1…У5.
const appendixE = plan.indexOf("## Приложение Е.")
if (appendixE >= 0) {
  for (const match of plan.slice(appendixE).matchAll(/^\| ([ПДУ]\d{1,2})\s+\|/gmu)) {
    required.add(match[1])
  }
}
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
    /_tests?\.rs$/.test(name) ||
    /\.test\.tsx?$/.test(name)
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
// The tests of the engine inside the application (stage Э4 and later) are `*_tests.rs` next to it.
if (existsSync(path.join(root, "src-tauri/src/sync"))) walk("src-tauri/src/sync")
// The tests of the interface (appendix Е, У1…У5) are `*.test.ts(x)` next to the screens.
for (const directory of ["src/components/workspace/sync", "src/lib/sync"]) {
  if (existsSync(path.join(root, directory))) walk(directory)
}

const covered = new Map()
for (const file of testFiles) {
  const text = readFileSync(path.join(root, file), "utf8")
  for (const match of text.matchAll(/(?<![\p{L}\d])([ОРСГПДУ]\d{1,2})(?!\d)/gu)) {
    if (!required.has(match[1])) continue
    covered.set(match[1], (covered.get(match[1]) ?? 0) + 1)
  }
}

const order = (id) =>
  [...id.slice(1)].reduce((n, c) => n * 10 + Number(c), 0) +
  { О: 0, Р: 1000, С: 2000, Г: 3000, П: 4000, Д: 5000, У: 6000 }[id[0]]
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
