import { describe, expect, it } from "vitest"
import { quickOpenItemValue, rankQuickOpenFiles } from "./quick-open-utils"
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

  it("ranks path matches before limiting the result set", () => {
    const files = Array.from({ length: 120 }, (_, index) =>
      file(`id-${index}`, `/vault/Other/${index}.md`),
    )
    files.push(file("nested-match", "/vault/Projects/Release-plan.md"))

    const result = rankQuickOpenFiles(files, "release", "/vault", 100)

    expect(result).toHaveLength(1)
    expect(result[0]?.id).toBe("nested-match")
  })
})
