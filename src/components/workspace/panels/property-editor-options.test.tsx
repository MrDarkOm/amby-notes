// @vitest-environment happy-dom
// docs/sync-plan.md, З61, З62: the icon of the type in the editor, options as fields with a default
// and a rule that a select needs one, no empty option «—», the new type «Мультивыбор».
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import "@/lib/i18n"
import type { CustomProperty } from "@/lib/storage"
import { PropertyEditor } from "./property-editor"

afterEach(cleanup)

const base: CustomProperty = {
  id: "",
  name: "Статус",
  icon: "",
  propertyType: "select",
  value: "",
  settings: "",
}

function mount(property: CustomProperty, onSave = vi.fn().mockResolvedValue(undefined)) {
  render(
    <PropertyEditor
      property={property}
      open
      onOpenChange={() => {}}
      onSave={onSave}
      onDelete={async () => {}}
    />,
  )
  return onSave
}

const fields = () => screen.queryAllByLabelText("Вариант")

describe("the icon of the type", () => {
  it("is the one of the common mapping: a text is align-justify, not a letter", () => {
    mount({ ...base, propertyType: "text" })
    expect(document.querySelector(".lucide-align-justify")).not.toBeNull()
    expect(document.querySelector(".lucide-type")).toBeNull()
  })
})

describe("the options as fields", () => {
  it("a select without an option is not saved and the field says why", async () => {
    const onSave = mount(base)
    fireEvent.click(screen.getByText("Сохранить"))
    expect(await screen.findByText("Добавьте хотя бы один вариант")).toBeTruthy()
    expect(onSave).not.toHaveBeenCalled()
  })

  it("has no empty option «—» in the value list", () => {
    mount({ ...base, settings: '{"options":["А","Б"]}' })
    expect(screen.queryByText("—")).toBeNull()
  })

  it("adds and removes fields, marks the default and writes it as the value of a new select", async () => {
    const onSave = mount({ ...base, settings: '{"options":["А"]}' })
    fireEvent.click(screen.getByText("Добавить вариант"))
    await waitFor(() => expect(fields()).toHaveLength(2))
    fireEvent.change(fields()[1], { target: { value: "Б" } })
    fireEvent.click(screen.getAllByTitle("Стандартный")[1])
    fireEvent.click(screen.getByText("Сохранить"))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const saved = onSave.mock.calls[0][0] as CustomProperty
    expect(JSON.parse(saved.settings)).toEqual({ options: ["А", "Б"], default: "Б" })
    expect(saved.value).toBe("Б")
    fireEvent.click(screen.getAllByTitle("Удалить вариант")[0])
    await waitFor(() => expect(fields()).toHaveLength(1))
  })

  it("a select without a default is created with an empty value", async () => {
    const onSave = mount({ ...base, settings: '{"options":["А","Б"]}' })
    fireEvent.click(screen.getByText("Сохранить"))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    expect((onSave.mock.calls[0][0] as CustomProperty).value).toBe("")
  })

  it("a multi-select is the type «list»: the default becomes a list of one, and it also needs an option", async () => {
    const onSave = mount({
      ...base,
      propertyType: "list",
      settings: '{"options":["А","Б"],"default":"А"}',
    })
    expect(screen.getByText("Мультивыбор")).toBeTruthy()
    fireEvent.click(screen.getByText("Сохранить"))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    expect((onSave.mock.calls[0][0] as CustomProperty).value).toBe('["А"]')
    cleanup()
    const refused = mount({ ...base, propertyType: "list", settings: "" })
    fireEvent.click(screen.getByText("Сохранить"))
    expect(await screen.findByText("Добавьте хотя бы один вариант")).toBeTruthy()
    expect(refused).not.toHaveBeenCalled()
  })

  it("the value of a multi-select is chosen with the same chips as in the row", async () => {
    const onSave = mount({
      ...base,
      propertyType: "list",
      settings: '{"options":["А, Б","В"]}',
    })
    fireEvent.click(screen.getByRole("button", { name: "А, Б" }))
    fireEvent.click(screen.getByText("Сохранить"))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    expect((onSave.mock.calls[0][0] as CustomProperty).value).toBe('["А, Б"]')
  })
})
