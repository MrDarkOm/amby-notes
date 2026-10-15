// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ScopeCard, ScopePrompt } from "./scope-card"

const base = {
  label: "Вселенные",
  ariaLabel: "Выбрать вселенную",
  icon: <span data-testid="icon" />,
  name: "Палуверс",
  value: "a",
  options: [{ value: "a", label: "Палуверс" }],
  onValueChange: () => undefined,
  openLabel: "Открыть вселенную",
}

describe("ScopeCard", () => {
  afterEach(cleanup)

  it("puts the arrow in the icon's place and the open button at the right", () => {
    const onOpen = vi.fn()
    const { container } = render(<ScopeCard {...base} onOpen={onOpen} />)
    const card = container.firstElementChild as HTMLElement
    expect(card.className).toContain("border")
    expect(card.className).toContain("group/card")
    const arrows = Array.from(container.querySelectorAll("svg.lucide-chevron-down"))
    // The select's own arrow is hidden; the visible one replaces the icon.
    const own = arrows.find((arrow) => (arrow.getAttribute("class") ?? "").includes("hidden"))
    const swapped = arrows.find((arrow) =>
      (arrow.getAttribute("class") ?? "").includes("group-hover/card:block"),
    )
    expect(own).toBeTruthy()
    expect(swapped).toBeTruthy()
    expect(screen.getByTestId("icon").parentElement?.className).toContain("group-hover/card:hidden")
    const open = screen.getByRole("button", { name: "Открыть вселенную" })
    expect(card.lastElementChild).toBe(open)
    fireEvent.click(open)
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it("does not keep the arrow after a click: only hover, keyboard focus and an open list show it", () => {
    const { container } = render(<ScopeCard {...base} onOpen={() => undefined} />)
    const html = container.innerHTML
    // Plain focus-within would leave the arrow showing after the open button was clicked.
    expect(html).not.toContain("focus-within")
    expect(html).toContain("group-has-[:focus-visible]/card:block")
    expect(html).toContain("group-has-[[aria-expanded=true]]/card:block")
  })

  it("sets the name in a small type and wraps it instead of cutting it", () => {
    render(<ScopeCard {...base} onOpen={() => undefined} />)
    const name = screen.getByText("Палуверс", { selector: "span.break-words" })
    expect(name.className).toContain("text-[13px]")
    expect(name.className).not.toContain("truncate")
  })

  it("shows the note on the caption's line", () => {
    render(<ScopeCard {...base} meta="12 стр." onOpen={() => undefined} />)
    const note = screen.getByText("12 стр.")
    const caption = screen.getByText("Вселенные")
    expect(note.parentElement).toBe(caption.parentElement)
  })

  it("makes the control fill the card and lays the open button over its end", () => {
    const { container } = render(<ScopeCard {...base} onOpen={() => undefined} />)
    const card = container.firstElementChild as HTMLElement
    const control = screen.getByRole("combobox")
    // The list takes the control's width, so the control is the card: no inner box, no anchor.
    expect(control.parentElement).toBe(card)
    expect(control.className).toContain("w-full")
    const open = screen.getByRole("button", { name: "Открыть вселенную" })
    expect(open.className).toContain("absolute")
  })

  it("opens its list from the whole card, as wide as the card", async () => {
    render(<ScopeCard {...base} onOpen={() => undefined} />)
    fireEvent.click(screen.getByRole("combobox"))
    const list = await waitFor(() => screen.getByRole("listbox"))
    const content = list.closest("[data-popover-content]")
    expect(content?.className).toContain("w-[var(--radix-popover-trigger-width)]")
  })
})

describe("ScopePrompt", () => {
  afterEach(cleanup)

  it("is one button in the card's shape that makes the first item", () => {
    const onClick = vi.fn()
    render(
      <ScopePrompt
        label="Истории"
        icon={<span data-testid="plus" />}
        name="Создать первую историю"
        onClick={onClick}
      />,
    )
    expect(screen.queryByRole("combobox")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: /Создать первую историю/ }))
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})
