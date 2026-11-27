// @vitest-environment happy-dom
// The window that asks before a delete speaks of the thing by its kind and not of a "file", short, and
// says what happens to it (docs/notices.md, sections 9 and 10).
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import i18n from "@/lib/i18n"
import { DeleteConfirmationDialog } from "./delete-confirmation-dialog"

const noop = () => {}

describe.each(["ru", "en"])("the delete window in %s", (language) => {
  beforeEach(async () => {
    await i18n.changeLanguage(language)
  })
  afterEach(cleanup)

  const ask = (props: Partial<React.ComponentProps<typeof DeleteConfirmationDialog>>) =>
    render(<DeleteConfirmationDialog name="Идеи" onCancel={noop} onConfirm={noop} {...props} />)
  const text = () => document.body.textContent ?? ""

  it.each(["file", "folder", "canvas", "sketch", "database"] as const)(
    "never says 'file' when asked about a %s, and names it",
    (kind) => {
      ask({ kind })
      expect(text()).toContain("Идеи")
      expect(text()).not.toMatch(/файл|\bfiles?\b/iu)
      expect(screen.getByRole("dialog").textContent).toMatch(/\?/u)
    },
  )

  it("asks about the note by kind in Russian", async () => {
    await i18n.changeLanguage("ru")
    ask({ kind: "folder" })
    expect(screen.getByRole("heading").textContent).toBe("Удалить папку «Идеи»?")
  })

  it("keeps the sentence under the title to one short line", () => {
    ask({ kind: "file" })
    const line = document.querySelector("[data-slot='dialog-description']")?.textContent ?? ""
    expect(line.length).toBeGreaterThan(0)
    expect(line.length).toBeLessThanOrEqual(70)
  })

  it("does not say 'file' for several items or for unsaved changes", () => {
    ask({ count: 3 })
    expect(text()).not.toMatch(/файл|\bfiles?\b/iu)
    cleanup()
    ask({ isDirtyOrConflicted: true, kind: "file" })
    expect(text()).not.toMatch(/файл|\bfiles?\b/iu)
    cleanup()
    ask({ isDirtyOrConflicted: true, count: 3 })
    expect(text()).not.toMatch(/файл|\bfiles?\b/iu)
  })
})
