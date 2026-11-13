// @vitest-environment happy-dom
// docs/sync-plan.md, З62, З63 in the row of a property: the value of a select or a multi-select
// shows as chips and is chosen in a window (the picker); the options are read from either form of
// `settings`, and the YAML list is written as items.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import "@/lib/i18n"
import { FrontmatterPropertyRow } from "./info-frontmatter-rows"

afterEach(cleanup)

const option = (name: string) =>
  screen.getByTestId("option-list").querySelector(`[data-option="${name}"]`) as HTMLElement

const openPicker = () => fireEvent.click(screen.getByTestId("option-trigger"))

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
    const trigger = screen.getByTestId("option-trigger")
    expect(trigger.textContent).toContain("Фэнтези, тёмное")
    expect(trigger.textContent).toContain("Детектив")
    expect(trigger.textContent).not.toContain("Драма")
    openPicker()
    fireEvent.click(option("Детектив"))
    await waitFor(() => expect(onSaveList).toHaveBeenCalledWith(["Фэнтези, тёмное"]))
    expect(onSave).not.toHaveBeenCalled()
  })
})

describe("a multi-select in its row", () => {
  it("adds an option of the list and writes the list", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(
      <FrontmatterPropertyRow
        property={{ key: "Теги", value: "А", valueKind: "list" }}
        propertyType="list"
        settings='{"options":["А","Б, В","Г"]}'
        onSave={onSave}
      />,
    )
    openPicker()
    fireEvent.click(option("Б, В"))
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('["А","Б, В"]'))
  })

  it("a value outside the options is a grey chip and stays", () => {
    render(
      <FrontmatterPropertyRow
        property={{ key: "Теги", value: "Чужое", valueKind: "list" }}
        propertyType="list"
        settings="А,Б"
      />,
    )
    const chip = screen.getByTestId("option-trigger").querySelector('[data-color="gray"]')
    expect(chip?.textContent).toBe("Чужое")
  })

  it("a new option is written with the options and chosen", async () => {
    const onChangeSettings = vi.fn().mockResolvedValue(undefined)
    const onSaveList = vi.fn().mockResolvedValue(undefined)
    render(
      <FrontmatterPropertyRow
        property={{ key: "Теги", value: "А", valueKind: "list", items: ["А"] }}
        propertyType="list"
        settings='{"options":["А"]}'
        onChangeSettings={onChangeSettings}
        onSaveList={onSaveList}
      />,
    )
    openPicker()
    const field = screen.getByPlaceholderText("Выберите вариант или создайте новый")
    fireEvent.change(field, { target: { value: "Новый" } })
    fireEvent.keyDown(field, { key: "Enter" })
    await waitFor(() => expect(onChangeSettings).toHaveBeenCalledWith('{"options":["А","Новый"]}'))
    await waitFor(() => expect(onSaveList).toHaveBeenCalledWith(["А", "Новый"]))
  })
})

describe("a select in its row", () => {
  it("replaces the value with the option that was clicked", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(
      <FrontmatterPropertyRow
        property={{ key: "Статус", value: "Идея", valueKind: "text" }}
        propertyType="select"
        settings="Идея,В работе,Готово"
        onSave={onSave}
      />,
    )
    openPicker()
    fireEvent.click(option("Готово"))
    await waitFor(() => expect(onSave).toHaveBeenCalledWith("Готово"))
  })
})
