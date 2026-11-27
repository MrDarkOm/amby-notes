import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

// IPC-10: every pass-through in a repository and in index.ts is one more file to edit for each
// new storage command. The budget only goes down. A new capability is a port in the style of
// database-port.ts / project-port.ts, not another forwarder (see MAP.md).
const REPOSITORY_FORWARDERS_BASE = 78
const INDEX_FORWARDERS_BASE = 80

const dir = dirname(fileURLToPath(import.meta.url))

function countRepositoryForwarders(): number {
  const files = readdirSync(dir).filter(
    (name) => name.endsWith("-repository.ts") && !name.endsWith(".test.ts"),
  )
  let total = 0
  for (const name of files) {
    const source = readFileSync(join(dir, name), "utf8")
    total += source.match(/return this\.port\(\)\.\w+\(/g)?.length ?? 0
  }
  return total
}

function countIndexForwarders(): number {
  const source = readFileSync(join(dir, "index.ts"), "utf8")
  return source.match(/\b\w+Repository\.\w+\(/g)?.length ?? 0
}

function check(kind: string, actual: number, base: number, constant: string) {
  expect(
    actual,
    `${kind}: ${actual} forwarders, budget ${base}. Do not add a forwarder: give the new capability its own port ` +
      "(see database-port.ts, project-port.ts and MAP.md).",
  ).toBeLessThanOrEqual(base)
  expect(
    actual,
    `${kind}: forwarders dropped to ${actual}; lower ${constant} to ${actual} in forwarding-budget.test.ts.`,
  ).toBeGreaterThanOrEqual(base)
}

describe("storage forwarding budget (IPC-10)", () => {
  it("repositories keep no more one-line port forwarders than the base", () => {
    check(
      "repositories",
      countRepositoryForwarders(),
      REPOSITORY_FORWARDERS_BASE,
      "REPOSITORY_FORWARDERS_BASE",
    )
  })

  it("index.ts keeps no more repository wrappers than the base", () => {
    check("index.ts", countIndexForwarders(), INDEX_FORWARDERS_BASE, "INDEX_FORWARDERS_BASE")
  })
})
