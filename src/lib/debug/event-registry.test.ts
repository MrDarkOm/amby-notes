// Every event name the frontend logs must be known on both sides of the debug log. An unknown name is
// stored as `diagnostic.invalid_event` and the real one is lost, so a new `logger.*("name")` call fails
// here until the name is added to `event-codes.ts` (the frontend filter) and to `ALLOWED_EVENTS` in
// `src-tauri/src/logging.rs` (the backend filter).
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, expect, it } from "vitest"
import { isKnownDebugEvent } from "./event-codes"

const ROOT = join(__dirname, "..", "..", "..")

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) sourceFiles(path, found)
    else if (/\.(ts|tsx)$/u.test(name) && !/\.(test|spec)\.|test-utils|\.d\.ts$/u.test(name))
      found.push(path)
  }
  return found
}

/** The literal event names of `logger.debug|info|warn|error("name", …)` calls, with where they stand. */
function loggedEvents(): Map<string, string> {
  const call = /\blogger\s*\.\s*(?:debug|info|warn|error)\(\s*"([^"]+)"/gu
  const events = new Map<string, string>()
  for (const file of sourceFiles(join(ROOT, "src"))) {
    for (const match of readFileSync(file, "utf8").matchAll(call)) {
      if (!events.has(match[1]!)) events.set(match[1]!, relative(ROOT, file))
    }
  }
  return events
}

function quoted(block: string): string[] {
  return [...block.matchAll(/"([^"]+)"/gu)].map((match) => match[1]!)
}

/** What `allowed_event` in logging.rs accepts: the listed names, and the operation names (base + suffix). */
function backendFilter(): (event: string) => boolean {
  const source = readFileSync(join(ROOT, "src-tauri", "src", "logging.rs"), "utf8")
  const start = source.indexOf("const ALLOWED_EVENTS")
  const listed = new Set(quoted(source.slice(start, source.indexOf("];", start))))
  const basesAt = source.indexOf("let allowed_base = matches!(", start)
  const bases = new Set(quoted(source.slice(basesAt, source.indexOf(");", basesAt))))
  const suffixesAt = source.indexOf("matches!(suffix,", basesAt)
  const suffixes = new Set(quoted(source.slice(suffixesAt, source.indexOf(")", suffixesAt))))
  expect(listed.size).toBeGreaterThan(100)
  expect(bases.size).toBeGreaterThan(5)
  expect(suffixes.size).toBeGreaterThan(2)
  return (event) => {
    if (listed.has(event)) return true
    const dot = event.lastIndexOf(".")
    return dot > 0 && bases.has(event.slice(0, dot)) && suffixes.has(event.slice(dot + 1))
  }
}

describe("the names of the logged events", () => {
  const events = loggedEvents()

  it("finds the logger calls it checks", () => {
    expect(events.size).toBeGreaterThan(100)
  })

  it("are all known to the frontend filter (event-codes.ts)", () => {
    const missing = [...events].filter(([name]) => !isKnownDebugEvent(name))
    expect(missing.map(([name, file]) => `${name}  (${file})`)).toEqual([])
  })

  it("are all allowed by the backend filter (ALLOWED_EVENTS in logging.rs)", () => {
    const allowed = backendFilter()
    const missing = [...events].filter(([name]) => !allowed(name))
    expect(missing.map(([name, file]) => `${name}  (${file})`)).toEqual([])
  })
})
