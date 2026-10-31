// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import * as React from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Popover, PopoverAnchor } from "@/components/ui/popover"
import "@/lib/i18n"
import { ModelPicker, type PickerModel } from "./model-picker"

const models: PickerModel[] = [
  { value: "a", label: "Llama", providerId: "ollama", providerLabel: "Ollama", kind: "local" },
  { value: "b", label: "Mistral", providerId: "ollama", providerLabel: "Ollama", kind: "local" },
  { value: "c", label: "GPT mini", providerId: "openai", providerLabel: "OpenAI", kind: "cloud" },
  { value: "d", label: "GPT big", providerId: "openai", providerLabel: "OpenAI", kind: "cloud" },
]

function show(overrides: Partial<React.ComponentProps<typeof ModelPicker>> = {}) {
  const props = { onModel: vi.fn(), onManage: vi.fn() }
  render(<ModelPicker models={models} activeModelId="c" {...props} {...overrides} />)
  return props
}

const open = () => fireEvent.click(screen.getByRole("combobox", { name: "Активная модель" }))

beforeEach(() => {
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true })
})
afterEach(cleanup)

describe("Model picker", () => {
  it("shows the active model with its provider's mark on the closed control", () => {
    show()
    const closed = screen.getByRole("combobox", { name: "Активная модель" })
    expect(closed.textContent).toContain("GPT mini")
    expect(within(closed).getByRole("img", { name: "OpenAI" })).toBeTruthy()
  })

  it("draws a mark for each provider on the rail, named by its tab", async () => {
    show()
    open()
    const tabs = await screen.findAllByRole("tab")
    for (const tab of tabs) expect(tab.querySelector("svg")).not.toBeNull()
  })

  it("opens on the active model's provider, with the others one click away on a rail", async () => {
    show()
    open()
    const tabs = await screen.findAllByRole("tab")
    expect(tabs.map((tab) => tab.getAttribute("aria-label"))).toEqual(["Ollama", "OpenAI"])
    expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual(["false", "true"])
    const options = screen.getAllByRole("option")
    expect(options.map((option) => option.textContent)).toEqual(["GPT mini⌘1", "GPT big⌘2"])
    fireEvent.click(tabs[0])
    expect(
      screen.getAllByRole("option").map((option) => option.textContent?.replace(/⌘\d/, "")),
    ).toEqual(["Llama", "Mistral"])
  })

  it("has no rail when there is one provider", async () => {
    show({ models: models.slice(0, 2), activeModelId: "a" })
    open()
    await screen.findAllByRole("option")
    expect(screen.queryByRole("tab")).toBeNull()
  })

  it("marks the active model and picks another on click", async () => {
    const props = show()
    open()
    const [active, other] = await screen.findAllByRole("option")
    expect(active.getAttribute("aria-selected")).toBe("true")
    expect(other.getAttribute("aria-selected")).toBe("false")
    fireEvent.click(other)
    expect(props.onModel).toHaveBeenCalledWith("d")
  })

  it("picks the nth model of the open provider with the shortcut shown next to it", async () => {
    const props = show()
    open()
    const list = await screen.findByRole("listbox")
    fireEvent.keyDown(list, { key: "2", metaKey: true })
    expect(props.onModel).toHaveBeenCalledWith("d")
  })

  it("follows the provider on the rail when numbering shortcuts", async () => {
    const props = show()
    open()
    fireEvent.click((await screen.findAllByRole("tab"))[0])
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "1", ctrlKey: true })
    expect(props.onModel).toHaveBeenCalledWith("a")
  })

  it("ignores digits without the modifier and shortcuts beyond the list", async () => {
    const props = show()
    open()
    const list = await screen.findByRole("listbox")
    fireEvent.keyDown(list, { key: "2" })
    fireEvent.keyDown(list, { key: "9", metaKey: true })
    expect(props.onModel).not.toHaveBeenCalled()
  })

  it("leads to the model settings from the foot of the list", async () => {
    const props = show()
    open()
    fireEvent.click(await screen.findByRole("button", { name: "Управлять моделями" }))
    expect(props.onManage).toHaveBeenCalledOnce()
  })

  it("says so when there are no models yet", () => {
    show({ models: [], activeModelId: "" })
    expect(screen.getByRole("combobox", { name: "Активная модель" }).textContent).toContain(
      "Нет моделей",
    )
  })

  it("is as wide as the shared popover's anchor and opens above it", async () => {
    function Host() {
      const [menuOpen, setMenuOpen] = React.useState(false)
      return (
        <Popover open={menuOpen} onOpenChange={setMenuOpen}>
          <PopoverAnchor asChild>
            <div data-testid="anchor">
              <ModelPicker
                models={models}
                activeModelId="c"
                onModel={vi.fn()}
                onManage={vi.fn()}
                menu={{ open: menuOpen, onOpenChange: setMenuOpen }}
              />
            </div>
          </PopoverAnchor>
        </Popover>
      )
    }
    render(<Host />)
    open()
    const list = await screen.findByRole("listbox")
    const content = list.closest("[data-popover-content]")!
    expect(content.className).toContain("w-[var(--radix-popover-trigger-width)]")
    expect(content.className).not.toContain("w-auto")
    expect(content.getAttribute("data-side")).toBe("top")
  })
})
