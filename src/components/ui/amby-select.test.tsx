// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { chooseOption, selectedText } from "@/lib/test-utils/amby-select"
import { AmbySelect } from "./amby-select"

const options = [
  { value: "a", label: "Alpha" },
  { value: "b", label: "Beta", hint: "the second" },
  { value: "c", label: "Gamma", disabled: true },
  { value: "d", label: "Delta" },
]

function mount(value = "b", onValueChange = vi.fn()) {
  render(
    <AmbySelect
      aria-label="Letter"
      value={value}
      options={options}
      onValueChange={onValueChange}
    />,
  )
  return onValueChange
}

describe("AmbySelect", () => {
  afterEach(cleanup)

  it("shows the active choice and opens a list with it first, checked", async () => {
    mount("b")
    expect(selectedText("Letter")).toBe("Beta")
    fireEvent.click(screen.getByRole("combobox", { name: "Letter" }))
    const items = await screen.findAllByRole("option")
    expect(items.map((item) => item.textContent)).toEqual([
      "Betathe second",
      "Alpha",
      "Gamma",
      "Delta",
    ])
    expect(items[0].getAttribute("aria-selected")).toBe("true")
    expect(items.slice(1).every((item) => item.getAttribute("aria-selected") === "false")).toBe(
      true,
    )
  })

  it("picks another choice and closes", async () => {
    const onValueChange = mount("b")
    await chooseOption("Letter", "Delta")
    expect(onValueChange).toHaveBeenCalledWith("d")
    expect(screen.queryByRole("listbox")).toBeNull()
  })

  it("does not report picking the choice that is already active", async () => {
    const onValueChange = mount("b")
    await chooseOption("Letter", /Beta/)
    expect(onValueChange).not.toHaveBeenCalled()
  })

  it("does not pick a disabled choice", async () => {
    const onValueChange = mount("a")
    fireEvent.click(screen.getByRole("combobox", { name: "Letter" }))
    expect((await screen.findByRole("option", { name: "Gamma" })).hasAttribute("disabled")).toBe(
      true,
    )
    expect(onValueChange).not.toHaveBeenCalled()
  })

  it("moves with the arrow keys, focusing the active choice first", async () => {
    mount("b")
    fireEvent.click(screen.getByRole("combobox", { name: "Letter" }))
    const list = await screen.findByRole("listbox")
    const items = screen.getAllByRole("option")
    await vi.waitFor(() => expect(document.activeElement).toBe(items[0]))
    fireEvent.keyDown(list, { key: "ArrowDown" })
    expect(document.activeElement).toBe(items[1])
    fireEvent.keyDown(list, { key: "ArrowDown" })
    // The disabled choice is skipped.
    expect(document.activeElement).toBe(items[3])
    fireEvent.keyDown(list, { key: "ArrowUp" })
    expect(document.activeElement).toBe(items[1])
    fireEvent.keyDown(list, { key: "End" })
    expect(document.activeElement).toBe(items[3])
    fireEvent.keyDown(list, { key: "Home" })
    expect(document.activeElement).toBe(items[0])
  })

  it("shows the placeholder when nothing matches, and cannot open while disabled", () => {
    render(
      <AmbySelect
        aria-label="Empty"
        value=""
        placeholder="Pick one"
        options={options}
        disabled
        onValueChange={() => {}}
      />,
    )
    expect(selectedText("Empty")).toBe("Pick one")
    expect((screen.getByRole("combobox", { name: "Empty" }) as HTMLButtonElement).disabled).toBe(
      true,
    )
  })

  it("lists grouped choices under their headings, after the active one", async () => {
    render(
      <AmbySelect
        aria-label="Model"
        value="x"
        options={[
          { value: "x", label: "Local one", group: "Local" },
          { value: "y", label: "Local two", group: "Local" },
          { value: "z", label: "Cloud one", group: "Cloud" },
        ]}
        onValueChange={() => {}}
      />,
    )
    fireEvent.click(screen.getByRole("combobox", { name: "Model" }))
    await screen.findByRole("listbox")
    expect(screen.getByText("Local")).toBeTruthy()
    expect(screen.getByText("Cloud")).toBeTruthy()
    expect(screen.getAllByRole("option").map((item) => item.textContent)).toEqual([
      "Local one",
      "Local two",
      "Cloud one",
    ])
  })

  it("does not let a click in the list reach the element around it", async () => {
    const onOuterClick = vi.fn()
    render(
      <div onClick={onOuterClick}>
        <AmbySelect aria-label="Letter" value="a" options={options} onValueChange={() => {}} />
      </div>,
    )
    fireEvent.click(screen.getByRole("combobox", { name: "Letter" }))
    fireEvent.click(await screen.findByRole("option", { name: "Delta" }))
    expect(onOuterClick).not.toHaveBeenCalled()
  })
  it("shows the content it is given for the closed control, and still opens as a list", async () => {
    render(
      <AmbySelect
        aria-label="Letter"
        value="a"
        options={options}
        onValueChange={vi.fn()}
        renderValue={(active) => <b data-testid="custom">{active?.label}!</b>}
      />,
    )
    expect(screen.getByTestId("custom").textContent).toBe("Alpha!")
    fireEvent.click(screen.getByRole("combobox", { name: "Letter" }))
    expect((await screen.findAllByRole("option"))[0].textContent).toBe("Alpha")
  })

  it("ends the list with an action that acts instead of choosing a value", async () => {
    const onSelect = vi.fn()
    const onValueChange = vi.fn()
    render(
      <AmbySelect
        aria-label="Letter"
        value="a"
        options={options}
        onValueChange={onValueChange}
        action={{ label: "New letter", onSelect }}
      />,
    )
    fireEvent.click(screen.getByRole("combobox", { name: "Letter" }))
    const items = await screen.findAllByRole("option")
    expect(items[items.length - 1].textContent).toBe("New letter")
    fireEvent.click(items[items.length - 1])
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onValueChange).not.toHaveBeenCalled()
  })
})
