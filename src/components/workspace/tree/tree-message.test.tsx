// @vitest-environment happy-dom
// A line under the tree (docs/notices.md, sections 3 and 8): the answer to something done in the tree (a move,
// a deletion, a drop of files) is said where the person did it, at the level it has, and it never shows the
// text of an error. One line at a time; the person closes it, or the next answer replaces it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import i18n from "@/lib/i18n"
import { TreeMessage } from "./tree-message"
import { useTreeMessageStore } from "./use-tree-message-store"
import { reportImportFailure, reportImportOutcome } from "./use-tree-file-drop"

beforeEach(async () => {
  await i18n.changeLanguage("ru")
  useTreeMessageStore.getState().dismiss()
})
afterEach(cleanup)

const show = () =>
  act(() =>
    useTreeMessageStore.getState().show({
      id: "move-failed",
      level: "warning",
      titleKey: "notices.tree.moveFailed",
      params: { name: "Идея" },
    }),
  )

describe("the line", () => {
  it("is not there while the tree has nothing to say", () => {
    render(<TreeMessage />)
    expect(screen.queryByTestId("tree-message")).toBeNull()
  })

  it("says what happened to the named note, at its level, as a status", () => {
    render(<TreeMessage />)
    show()
    const line = screen.getByTestId("tree-message")
    expect(line.getAttribute("data-level")).toBe("warning")
    expect(line.getAttribute("role")).toBe("status")
    expect(line.textContent).toContain("Идея")
  })

  it("is an alert for danger", () => {
    render(<TreeMessage />)
    act(() =>
      useTreeMessageStore.getState().show({
        id: "x",
        level: "danger",
        titleKey: "notices.tree.moveFailed",
        params: { name: "Идея" },
      }),
    )
    expect(screen.getByTestId("tree-message").getAttribute("role")).toBe("alert")
  })

  it("offers to try again, and the press runs it and closes the line", () => {
    const run = vi.fn()
    render(<TreeMessage />)
    act(() =>
      useTreeMessageStore.getState().show({
        id: "properties-kept:n1",
        level: "warning",
        titleKey: "notices.tree.propertiesKept",
        params: { name: "Идея" },
        action: { labelKey: "notices.tree.propertiesRetry", run },
      }),
    )
    fireEvent.click(screen.getByRole("button", { name: "Перенести" }))
    expect(run).toHaveBeenCalledOnce()
    expect(screen.queryByTestId("tree-message")).toBeNull()
  })

  it("is closed by the person", () => {
    render(<TreeMessage />)
    show()
    fireEvent.click(screen.getByRole("button", { name: "Закрыть" }))
    expect(screen.queryByTestId("tree-message")).toBeNull()
  })

  it("is replaced by the next answer, never stacked", () => {
    render(<TreeMessage />)
    show()
    act(() =>
      useTreeMessageStore.getState().show({
        id: "import-failed",
        level: "warning",
        titleKey: "notices.tree.importFailed",
      }),
    )
    expect(screen.getAllByTestId("tree-message")).toHaveLength(1)
    expect(screen.getByTestId("tree-message").textContent).not.toContain("Идея")
  })
})

describe("the answers to a drop of files from the system", () => {
  it("names the files that were skipped and why, at the level of a warning", () => {
    reportImportOutcome({
      imported: ["a.md"],
      skipped: [
        { name: "b.bin", reason: "too_large" },
        { name: ".hidden", reason: "hidden" },
      ],
    } as never)
    const message = useTreeMessageStore.getState().message
    expect(message?.level).toBe("warning")
    const text = i18n.t(message!.titleKey, message!.params)
    expect(text).toContain("b.bin")
    expect(text).toContain(".hidden")
  })

  it("says nothing when nothing was skipped", () => {
    reportImportOutcome({ imported: ["a.md"], skipped: [] } as never)
    expect(useTreeMessageStore.getState().message).toBeNull()
  })

  it("says that nothing was copied, without the text of the error", () => {
    reportImportFailure(new Error("EPERM: /Users/me/Private"))
    const message = useTreeMessageStore.getState().message
    expect(message?.level).toBe("warning")
    expect(JSON.stringify(message)).not.toContain("EPERM")
    expect(i18n.t(message!.titleKey, message!.params)).toBe(
      "Не удалось скопировать файлы в хранилище.",
    )
  })
})
