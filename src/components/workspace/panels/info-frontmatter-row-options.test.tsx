// @vitest-environment happy-dom
// docs/sync-plan.md, З62 in the row of a property: a multi-select shows its options as chips that
// toggle a value of the YAML list; the options are read from either form of `settings`.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import "@/lib/i18n"
import { FrontmatterPropertyRow } from "./info-frontmatter-rows"

afterEach(cleanup)

describe("a multi-select whose option holds a comma", () => {
  it("shows the items the backend gives and writes the list of items, never glued", async () => {
    const onSaveList = vi.fn().mockResolvedValue(undefined)
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(
      <FrontmatterPropertyRow
        property={{
          key: "Жанр",
          value: "Фэнтези, тёмное, Детектив",
          valueKind: "list",
          items: ["Фэнтези, тёмное", "Детектив"],
        }}
        propertyType="list"
        settings='{"options":["Фэнтези, тёмное","Детектив","Драма"]}'
        onSave={onSave}
        onSaveList={onSaveList}
      />,
    )
    const pressed = (name: string) =>
      screen.getByRole("button", { name }).getAttribute("aria-pressed")
    expect(pressed("Фэнтези, тёмное")).toBe("true")
    expect(pressed("Драма")).toBe("false")
    fireEvent.click(screen.getByRole("button", { name: "Детектив" }))
    await waitFor(() => expect(onSaveList).toHaveBeenCalledWith(["Фэнтези, тёмное"]))
    expect(onSave).not.toHaveBeenCalled()
  })
})

describe("a multi-select in its row", () => {
  it("toggles an option of the list and writes the list", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(
      <FrontmatterPropertyRow
        property={{ key: "Теги", value: "А", valueKind: "list" }}
        propertyType="list"
        settings='{"options":["А","Б, В","Г"]}'
        onSave={onSave}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "Б, В" }))
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('["А","Б, В"]'))
    fireEvent.click(screen.getByRole("button", { name: "А" }))
    await waitFor(() => expect(onSave).toHaveBeenLastCalledWith('["Б, В"]'))
  })

  it("a value outside the options is shown as it is, with the options", () => {
    render(
      <FrontmatterPropertyRow
        property={{ key: "Теги", value: "Чужое", valueKind: "list" }}
        propertyType="list"
        settings="А,Б"
      />,
    )
    expect(screen.getByRole("button", { name: "Чужое" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "А" })).toBeTruthy()
  })
})
