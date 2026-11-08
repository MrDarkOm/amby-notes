import { describe, expect, it } from "vitest"

const sources = import.meta.glob("../components/**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>

/**
 * The places where raw error text used to reach the screen (docs/notices.md §10, step 4): a person
 * sees a text chosen by the error's code (`operationErrorText`), never what Rust, the OS or a
 * library said. Step 6 widens this to every component.
 */
const GUARDED = [
  "../components/workspace/database/",
  "../components/workspace/creative/",
  "../components/workspace/orchestration/use-property-actions.ts",
  "../components/workspace/panels/property-dormant-list.tsx",
  "../components/workspace/note-notices/property-notices.tsx",
]

/** `error.message`, `x instanceof Error ? x.message : …`, `String(error)` and their kin. */
const RAW_ERROR_TEXT =
  /\b(?:error|failure|caught|reason|loadError|reloadFailure|cause|err|e)\.message\b|\binstanceof Error \? \w+\.message\b|\bString\((?:error|failure|caught|reason|loadError|reloadFailure|cause|err|e)\)/

/** Parsing a sentence to find out what happened: the code says it. */
const PARSED_ERROR_TEXT =
  /(?:message|text|reason)\.(?:includes|startsWith|match)\(|\/[^/\n]+\/[a-z]*\.test\((?:error|failure|caught|\w+)\.message\)/

function offenders(pattern: RegExp): string[] {
  const failures: string[] = []
  for (const [file, source] of Object.entries(sources)) {
    if (file.includes(".test.") || !GUARDED.some((prefix) => file.startsWith(prefix))) continue
    source.split("\n").forEach((line, index) => {
      if (line.trimStart().startsWith("//")) return
      if (pattern.test(line)) failures.push(`${file}:${index + 1} ${line.trim()}`)
    })
  }
  return failures
}

describe("error text boundary", () => {
  it("guards the files it names", () => {
    const guarded = Object.keys(sources).filter(
      (file) => !file.includes(".test.") && GUARDED.some((prefix) => file.startsWith(prefix)),
    )
    expect(guarded.length).toBeGreaterThan(40)
  })

  it("keeps raw error text out of the guarded components", () => {
    expect(offenders(RAW_ERROR_TEXT)).toEqual([])
  })

  it("keeps sentence parsing out of the guarded components", () => {
    expect(offenders(PARSED_ERROR_TEXT)).toEqual([])
  })
})
