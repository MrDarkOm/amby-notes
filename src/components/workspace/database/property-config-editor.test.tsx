// @vitest-environment happy-dom
import { chooseOption } from "@/lib/test-utils/amby-select"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import "@/lib/i18n"
import type { DatabasePropertySummary } from "@/lib/storage"
import { PropertyConfigEditor } from "./property-config-editor"
import { hasPropertySettings } from "./property-settings"

const property = (
  propertyType: string,
  config: Record<string, unknown>,
  options: DatabasePropertySummary["options"] = [],
): DatabasePropertySummary => ({
  propertyId: "p",
  name: "Prop",
  propertyType,
  configJson: JSON.stringify(config),
  options,
})

const noop = async () => {}

function editor(
  prop: DatabasePropertySummary,
  overrides: Partial<React.ComponentProps<typeof PropertyConfigEditor>> = {},
) {
  const onUpdateConfig = vi.fn(async (_propertyId: string, _patch: Record<string, unknown>) => {})
  const onSaveOptions = vi.fn(
    async (_propertyId: string, _drafts: { id: string | null; name: string }[]) => {},
  )
  render(
    <PropertyConfigEditor
      property={prop}
      databases={[]}
      databaseTitle="Tasks"
      onUpdateConfig={onUpdateConfig}
      onSaveOptions={onSaveOptions}
      onSaveRelation={noop}
      onSaveRollup={noop}
      {...overrides}
    />,
  )
  return { onUpdateConfig, onSaveOptions }
}

describe("hasPropertySettings", () => {
  it("is true for the types with something to set", () => {
    for (const type of ["number", "date", "select", "multiSelect", "status", "formula"]) {
      expect(hasPropertySettings(type)).toBe(true)
    }
    for (const type of ["text", "checkbox", "url", "files"])
      expect(hasPropertySettings(type)).toBe(false)
  })
})

/** Controls are off while a change is being saved; wait for the editor to settle. */
const enabled = (element: HTMLElement) =>
  vi.waitFor(() => expect((element as HTMLButtonElement).disabled).toBe(false))

describe("PropertyConfigEditor", () => {
  afterEach(cleanup)

  it("renders nothing for a property without settings", () => {
    const { container } = render(
      <PropertyConfigEditor
        property={property("text", {})}
        databases={[]}
        databaseTitle="Tasks"
        onUpdateConfig={noop}
        onSaveOptions={noop}
        onSaveRelation={noop}
        onSaveRollup={noop}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it("changes a number's format, asking for a currency code when it becomes money", async () => {
    const { onUpdateConfig } = editor(property("number", { format: "number", currency: null }))
    fireEvent.click(screen.getByRole("radio", { name: "Процент" }))
    await vi.waitFor(() =>
      expect(onUpdateConfig).toHaveBeenCalledWith("p", { numberFormat: "percent" }),
    )
    await enabled(screen.getByRole("radio", { name: "Валюта" }))
    fireEvent.click(screen.getByRole("radio", { name: "Валюта" }))
    await vi.waitFor(() =>
      expect(onUpdateConfig).toHaveBeenLastCalledWith("p", {
        numberFormat: "currency",
        currency: "USD",
      }),
    )
  })

  it("edits the currency code of a money number", async () => {
    const { onUpdateConfig } = editor(property("number", { format: "currency", currency: "USD" }))
    const input = screen.getByLabelText("Код валюты (например USD)") as HTMLInputElement
    fireEvent.change(input, { target: { value: "eur" } })
    fireEvent.blur(input)
    await vi.waitFor(() => expect(onUpdateConfig).toHaveBeenCalledWith("p", { currency: "eur" }))
  })

  it("sets the date format, the time and its format", async () => {
    const { onUpdateConfig } = editor(property("date", { includeTime: true, timeFormat: "24h" }))
    await chooseOption("Формат даты", "ДД/ММ/ГГГГ")
    await vi.waitFor(() =>
      expect(onUpdateConfig).toHaveBeenCalledWith("p", { dateFormat: "dayMonthYear" }),
    )
    await enabled(screen.getByRole("radio", { name: "12 часов" }))
    fireEvent.click(screen.getByRole("radio", { name: "12 часов" }))
    await vi.waitFor(() =>
      expect(onUpdateConfig).toHaveBeenLastCalledWith("p", { timeFormat: "12h" }),
    )
    await enabled(screen.getByRole("switch", { name: "Хранить время" }))
    fireEvent.click(screen.getByRole("switch", { name: "Хранить время" }))
    await vi.waitFor(() =>
      expect(onUpdateConfig).toHaveBeenLastCalledWith("p", { includeTime: false }),
    )
  })

  it("hides the time format while the date keeps no time", () => {
    editor(property("date", { includeTime: false }))
    expect(screen.queryByRole("radiogroup", { name: "Формат времени" })).toBeNull()
  })

  it("shows why a change was refused", async () => {
    editor(property("date", { includeTime: false }), {
      onUpdateConfig: async () => {
        throw new Error(
          "Date time and range settings can only change after the existing values are cleared",
        )
      },
    })
    fireEvent.click(screen.getByRole("switch", { name: "Хранить время" }))
    expect((await screen.findByRole("alert")).textContent).toContain("existing values are cleared")
  })

  it("edits a formula and does not save it unchanged", async () => {
    const { onUpdateConfig } = editor(property("formula", { expression: "1 + 1" }))
    const input = screen.getByLabelText("Формула") as HTMLInputElement
    fireEvent.blur(input)
    expect(onUpdateConfig).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: "2 * 3" } })
    fireEvent.blur(input)
    await vi.waitFor(() =>
      expect(onUpdateConfig).toHaveBeenCalledWith("p", { formulaExpression: "2 * 3" }),
    )
  })

  describe("options", () => {
    const options = [
      { optionId: "a", name: "Todo", color: "#94a3b8" },
      { optionId: "b", name: "Done", color: "#22c55e" },
    ]
    const select = () => property("select", { options: [] }, options)

    it("adds an option at once with Enter", async () => {
      const { onSaveOptions } = editor(select())
      const input = screen.getByLabelText("Новый вариант")
      fireEvent.change(input, { target: { value: "  Blocked " } })
      fireEvent.keyDown(input, { key: "Enter" })
      await vi.waitFor(() => expect(onSaveOptions).toHaveBeenCalled())
      const [propertyId, drafts] = onSaveOptions.mock.calls[0]
      expect(propertyId).toBe("p")
      expect(drafts.map((d) => [d.id, d.name])).toEqual([
        ["a", "Todo"],
        ["b", "Done"],
        [null, "Blocked"],
      ])
    })

    it("renames, removes and reorders options, each saved at once", async () => {
      const { onSaveOptions } = editor(select())
      const name = screen.getAllByLabelText("Название варианта")[0]
      fireEvent.change(name, { target: { value: "To do" } })
      fireEvent.blur(name)
      await vi.waitFor(() => expect(onSaveOptions).toHaveBeenCalledTimes(1))
      await enabled(screen.getAllByRole("button", { name: "Удалить вариант" })[1])
      fireEvent.click(screen.getAllByRole("button", { name: "Удалить вариант" })[1])
      await vi.waitFor(() => expect(onSaveOptions).toHaveBeenCalledTimes(2))
      const afterDelete = onSaveOptions.mock.calls[1][1]
      expect(afterDelete.map((d) => d.name)).toEqual(["Todo"])
      const handle = screen.getAllByRole("button", { name: /Перетащить вариант/ })[0]
      await enabled(handle)
      fireEvent.keyDown(handle, { key: "ArrowDown" })
      await vi.waitFor(() => expect(onSaveOptions).toHaveBeenCalledTimes(3))
      const reordered = onSaveOptions.mock.calls[2][1]
      expect(reordered.map((d) => d.name)).toEqual(["Done", "Todo"])
    })

    it("does not save a repeated name and says so", async () => {
      const { onSaveOptions } = editor(select())
      const name = screen.getAllByLabelText("Название варианта")[0]
      fireEvent.change(name, { target: { value: "done" } })
      fireEvent.blur(name)
      expect((await screen.findByRole("alert")).textContent).toContain("повторяться")
      expect(onSaveOptions).not.toHaveBeenCalled()
    })

    it("offers a group for status options only", () => {
      const { unmount } = render(
        <PropertyConfigEditor
          property={select()}
          databases={[]}
          databaseTitle="Tasks"
          onUpdateConfig={noop}
          onSaveOptions={noop}
          onSaveRelation={noop}
          onSaveRollup={noop}
        />,
      )
      expect(screen.queryAllByLabelText("Группа статуса")).toHaveLength(0)
      unmount()
      render(
        <PropertyConfigEditor
          property={property("status", { options: [] }, options)}
          databases={[]}
          databaseTitle="Tasks"
          onUpdateConfig={noop}
          onSaveOptions={noop}
          onSaveRelation={noop}
          onSaveRollup={noop}
        />,
      )
      expect(screen.getAllByLabelText("Группа статуса")).toHaveLength(2)
    })

    it("disables everything for a locked database", () => {
      editor(select(), { disabled: true })
      expect((screen.getByLabelText("Новый вариант") as HTMLInputElement).disabled).toBe(true)
      expect(
        screen
          .getAllByRole("button", { name: "Удалить вариант" })
          .every((b) => (b as HTMLButtonElement).disabled),
      ).toBe(true)
    })
  })
})
