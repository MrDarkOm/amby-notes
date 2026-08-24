import { describe, expect, it } from "vitest"
import { quickOpenItemValue } from "./quick-open-utils"
import type { TreeItem } from "./sidebar-tree"

const file = (id: string, path: string): TreeItem => ({
  id,
  name: "Daily.md",
  path,
  type: "file",
  icon: "file",
})

describe("quickOpenItemValue", () => {
  it("keeps duplicate filenames distinct while retaining searchable names and paths", () => {
    const work = quickOpenItemValue(file("work-id", "/vault/Work/Daily.md"))
    const personal = quickOpenItemValue(file("personal-id", "/vault/Personal/Daily.md"))

    expect(work).not.toBe(personal)
    expect(work).toContain("Daily.md")
    expect(work).toContain("/vault/Work/Daily.md")
    expect(work).toContain("work-id")
  })
})
