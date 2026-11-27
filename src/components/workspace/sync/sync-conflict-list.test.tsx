// @vitest-environment happy-dom
// The line of a conflict in the list (docs/notices.md, section 10): a title with the name of the note,
// one line saying the data is safe, one button. No paths, no legend, no choice here — the choice is made
// in the comparison, where both versions are seen. A conflict of the app's own data keeps its two choices.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import i18n from "@/lib/i18n"
import { ConflictList } from "./sync-vault-parts"
import { useSyncNoticesStore } from "./use-sync-notices-store"

const conflict = {
  id: "0123456789ab",
  kind: "bothEdited",
  originalPath: "Заметки/идея.md",
  copyPath: ".amby/conflicts/0123456789ab/other.md",
  createdMs: 1_760_000_000_000,
}

function show(items = [conflict], props: Partial<React.ComponentProps<typeof ConflictList>> = {}) {
  const onResolve = vi.fn()
  const onCompare = vi.fn()
  render(
    <ConflictList
      items={items}
      busyId={null}
      onResolve={onResolve}
      onCompare={onCompare}
      {...props}
    />,
  )
  return { onResolve, onCompare, row: () => within(screen.getAllByRole("listitem")[0]!) }
}

beforeEach(async () => {
  await i18n.changeLanguage("ru")
  useSyncNoticesStore.setState(useSyncNoticesStore.getInitialState())
})
afterEach(cleanup)

describe("the line of a conflict of a note", () => {
  it("has a title with the name of the note, one line that the data is safe, and one button", () => {
    const { row } = show()
    expect(row().getByText("Заметка «идея» изменена на двух компьютерах")).toBeTruthy()
    expect(row().getByText("Обе версии целы")).toBeTruthy()
    expect(row().getAllByRole("button")).toHaveLength(1)
    expect(row().getByRole("button", { name: "Сравнить" })).toBeTruthy()
  })

  it("says nothing about paths, extensions, copies or the main file, and has no legend", () => {
    show([{ ...conflict, copyPath: "Заметки/идея.0123456789ab-conflict.md" }])
    const text = screen.getByTestId("sync-conflicts").textContent ?? ""
    expect(text).not.toMatch(/\.md|Заметки\/|\.amby|conflict/)
    expect(text).not.toMatch(/основн|копи|идентификатор|корзин/i)
    // the title and one line, the button: no third paragraph for a legend
    expect(screen.getByTestId("sync-conflicts").querySelectorAll("li p")).toHaveLength(2)
  })

  it("words a conflict of two creations differently", () => {
    const { row } = show([{ ...conflict, kind: "bothCreated" }])
    expect(row().getByText("Заметка «идея» создана на двух компьютерах")).toBeTruthy()
  })

  it("opens the comparison and chooses nothing by itself", () => {
    const { row, onCompare, onResolve } = show()
    fireEvent.click(row().getByRole("button", { name: "Сравнить" }))
    expect(onCompare).toHaveBeenCalledWith("0123456789ab")
    expect(onResolve).not.toHaveBeenCalled()
  })

  it("names a note by its file name without the folder and the extension", () => {
    const { row } = show([{ ...conflict, originalPath: "Работа/Планы/Годовой план.md" }])
    expect(row().getByText("Заметка «Годовой план» изменена на двух компьютерах")).toBeTruthy()
  })
})

describe("a conflict of the data Amby keeps for itself", () => {
  const graph = { ...conflict, originalPath: ".amby/graph-layout.json" }
  const other = { ...conflict, originalPath: ".amby/something.json" }

  it("keeps its two choices and names no path", () => {
    const { row, onResolve } = show([graph])
    expect(row().queryByRole("button", { name: "Сравнить" })).toBeNull()
    expect(row().getAllByRole("button")).toHaveLength(2)
    fireEvent.click(row().getByRole("button", { name: "Взять с другого компьютера" }))
    expect(onResolve).toHaveBeenCalledWith("0123456789ab", "keepCopy")
    fireEvent.click(row().getByRole("button", { name: "Оставить с этого компьютера" }))
    expect(onResolve).toHaveBeenCalledWith("0123456789ab", "keepOriginal")
    expect(screen.getByTestId("sync-conflicts").textContent).not.toMatch(/\.amby|\.json/)
  })

  it("does not show the path of an unknown service file", () => {
    show([other])
    expect(screen.getByTestId("sync-conflicts").textContent).not.toMatch(/\.amby|something|\.json/)
    expect(screen.getByTestId("sync-conflicts").textContent).not.toMatch(/копи|файл/i)
  })
})

describe("what was done after a choice", () => {
  it("is not said in the list: that is the business of the journal of the notification centre", () => {
    useSyncNoticesStore.setState({
      outcomes: [
        {
          conflictId: "0123456789ab",
          path: "Заметки/идея.md",
          name: "идея",
          choice: "keepOriginal",
        },
      ],
    })
    const view = render(
      <ConflictList items={[]} busyId={null} onResolve={vi.fn()} onCompare={vi.fn()} />,
    )
    expect(view.container.textContent).toBe("")
    expect(screen.queryByTestId("sync-conflict-outcome")).toBeNull()
  })
})
