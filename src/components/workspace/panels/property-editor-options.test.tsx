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

  it("has no «Содержимое» field for a select or a multi-select: the value is the default option", () => {
    mount({ ...base, settings: '{"options":["А","Б"]}' })
    expect(screen.queryByText("Содержимое")).toBeNull()
    cleanup()
    mount({ ...base, propertyType: "list", settings: '{"options":["А","Б"]}' })
    expect(screen.queryByText("Содержимое")).toBeNull()
  })
})

describe("the first option is the default at once (new property)", () => {
  async function typeOptions(onSave: ReturnType<typeof mount>, ...options: string[]) {
    for (const [index, option] of options.entries()) {
      if (index > 0) fireEvent.click(screen.getByText("Добавить вариант"))
      await waitFor(() => expect(fields()).toHaveLength(index + 1))
      fireEvent.change(fields()[index], { target: { value: option } })
    }
    return onSave
  }

  it("a select saves its first option as the value without a click on the star", async () => {
    const onSave = mount(base)
    await typeOptions(onSave, "А", "Б")
    expect(screen.getAllByTitle("Стандартный")[0].getAttribute("aria-pressed")).toBe("true")
    fireEvent.click(screen.getByText("Сохранить"))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const saved = onSave.mock.calls[0][0] as CustomProperty
    expect(saved.value).toBe("А")
    expect(JSON.parse(saved.settings)).toEqual({ options: ["А", "Б"], default: "А" })
  })

  it("a multi-select saves a list of its first option", async () => {
    const onSave = mount({ ...base, propertyType: "list" })
    await typeOptions(onSave, "А", "Б")
    fireEvent.click(screen.getByText("Сохранить"))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    expect((onSave.mock.calls[0][0] as CustomProperty).value).toBe('["А"]')
  })

  it("the star can be taken off: the value is then empty and stays so when more is typed", async () => {
    const onSave = mount(base)
    await typeOptions(onSave, "А")
    fireEvent.click(screen.getAllByTitle("Стандартный")[0])
    expect(screen.getAllByTitle("Стандартный")[0].getAttribute("aria-pressed")).toBe("false")
    await typeOptions(onSave, "А", "Б")
    fireEvent.click(screen.getByText("Сохранить"))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const saved = onSave.mock.calls[0][0] as CustomProperty
    expect(saved.value).toBe("")
    expect(JSON.parse(saved.settings)).toEqual({ options: ["А", "Б"] })
  })

  it("an existing property does not get a default by itself", async () => {
    const onSave = mount({ ...base, id: "Статус", settings: '{"options":["А"]}', value: "А" })
    fireEvent.change(fields()[0], { target: { value: "Ж" } })
    expect(screen.getAllByTitle("Стандартный")[0].getAttribute("aria-pressed")).toBe("false")
    fireEvent.click(screen.getByText("Сохранить"))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    expect(JSON.parse((onSave.mock.calls[0][0] as CustomProperty).settings)).toEqual({
      options: ["Ж"],
    })
  })
})

describe("a new property without a name", () => {
  it("says why it cannot be saved and puts the cursor into the name", () => {
    mount({ ...base, name: "" })
    expect(screen.getByText("Введите название свойства")).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByPlaceholderText("Название свойства"))
  })

  it("shows no hint once a name is typed", () => {
    mount(base)
    expect(screen.queryByText("Введите название свойства")).toBeNull()
  })
})

describe("the colours of the options in the editor (З63)", () => {
  const coloured = '{"options":["А","Б"],"colors":{"А":"red","Б":"blue"}}'

  it("moves the colour with a renamed option and drops it with a removed one", async () => {
    const onSave = mount({ ...base, id: "x", settings: coloured })
    fireEvent.change(fields()[0], { target: { value: "В" } })
    fireEvent.click(screen.getAllByTitle("Удалить вариант")[1])
    await waitFor(() => expect(fields()).toHaveLength(1))
    fireEvent.click(screen.getByText("Сохранить"))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    expect((onSave.mock.calls[0][0] as CustomProperty).settings).toBe(
      '{"options":["В"],"colors":{"В":"red"}}',
    )
  })

  it("keeps the colours of a new property that is saved with its default", async () => {
    const onSave = mount({ ...base, settings: '{"options":["А"],"colors":{"А":"green"}}' })
    fireEvent.change(fields()[0], { target: { value: "Ы" } })
    fireEvent.click(screen.getByText("Сохранить"))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    expect(JSON.parse((onSave.mock.calls[0][0] as CustomProperty).settings)).toEqual({
      options: ["Ы"],
      default: "Ы",
      colors: { Ы: "green" },
    })
  })
})
