// @vitest-environment happy-dom
// docs/sync-plan.md, З63 (г): the window that chooses the value of a select or a multi-select, after
// the model of Notion: the chosen values on top as chips with a cross, a field with the hint, the
// list of all options as chips with a handle for the order; a click chooses, a new text creates.
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import "@/lib/i18n"
import { OptionPicker } from "./option-picker"

afterEach(cleanup)

function mount(props: Partial<React.ComponentProps<typeof OptionPicker>> = {}) {
  const onSelect = vi.fn()
  const onOptionsChange = vi.fn()
  render(
    <OptionPicker
      options={["А4", "WebToon"]}
      colors={{ WebToon: "brown" }}
      selected={["WebToon"]}
      multi
      onSelect={onSelect}
      onOptionsChange={onOptionsChange}
      {...props}
    />,
  )
  return { onSelect, onOptionsChange }
}

describe("the window that chooses a value", () => {
  it("shows the chosen values on top with a cross that takes the choice off", () => {
    const { onSelect } = mount()
    fireEvent.click(screen.getByLabelText("Снять «WebToon»"))
    expect(onSelect).toHaveBeenCalledWith([])
  })

  it("has the hint of the model in the field, in the language of the application", () => {
    mount()
    expect(screen.getByPlaceholderText("Выберите вариант или создайте новый")).toBeTruthy()
  })

  it("lists all the options as chips of their colour, one with a handle for the order", () => {
    mount()
    const list = screen.getByTestId("option-list")
    expect(list.querySelector('[data-option="А4"]')?.getAttribute("data-color")).not.toBe("gray")
    expect(list.querySelector('[data-option="WebToon"]')?.getAttribute("data-color")).toBe("brown")
    expect(screen.getByLabelText("Перетащить вариант «А4»")).toBeTruthy()
  })

  it("adds an option to the value of a multi-select, and replaces the value of a select", () => {
    const multi = mount()
    fireEvent.click(screen.getByTestId("option-list").querySelector('[data-option="А4"]')!)
    expect(multi.onSelect).toHaveBeenCalledWith(["WebToon", "А4"])
    cleanup()
    const single = mount({ multi: false })
    fireEvent.click(screen.getByTestId("option-list").querySelector('[data-option="А4"]')!)
    expect(single.onSelect).toHaveBeenCalledWith(["А4"])
  })

  it("creates an option from the text and chooses it", () => {
    const { onSelect, onOptionsChange } = mount()
    const field = screen.getByPlaceholderText("Выберите вариант или создайте новый")
    fireEvent.change(field, { target: { value: "Манга" } })
    fireEvent.keyDown(field, { key: "Enter" })
    expect(onOptionsChange).toHaveBeenCalledWith({
      options: ["А4", "WebToon", "Манга"],
      colors: { WebToon: "brown" },
    })
    expect(onSelect).toHaveBeenCalledWith(["WebToon", "Манга"])
  })

  it("takes an existing option instead of creating a twin, and filters the list while typing", () => {
    const { onSelect, onOptionsChange } = mount()
    const field = screen.getByPlaceholderText("Выберите вариант или создайте новый")
    fireEvent.change(field, { target: { value: "а4" } })
    expect(screen.getByTestId("option-list").querySelector('[data-option="WebToon"]')).toBeNull()
    fireEvent.keyDown(field, { key: "Enter" })
    expect(onOptionsChange).not.toHaveBeenCalled()
    expect(onSelect).toHaveBeenCalledWith(["WebToon", "А4"])
  })

  it("shows a value that is not among the options as a grey chip and does not lose it", () => {
    const { onSelect } = mount({ selected: ["Старое"] })
    const chip = document.querySelector('[data-selected="Старое"]')
    expect(chip?.getAttribute("data-color")).toBe("gray")
    fireEvent.click(screen.getByLabelText("Снять «Старое»"))
    expect(onSelect).toHaveBeenCalledWith([])
  })

  it("chooses the colour of an option and writes it with the options", () => {
    const { onOptionsChange } = mount()
    fireEvent.click(screen.getByLabelText("Цвет варианта «А4»"))
    fireEvent.click(screen.getByLabelText("Красный"))
    expect(onOptionsChange).toHaveBeenCalledWith({
      options: ["А4", "WebToon"],
      colors: { WebToon: "brown", А4: "red" },
    })
  })
})
