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

  const segmentOf = () => screen.getByRole("combobox").parentElement as HTMLElement
  const frameOf = () => segmentOf().parentElement as HTMLElement
  const reveal = () =>
    screen.getByRole("button", { name: "Открыть вселенную" }).parentElement as HTMLElement

  it("is a split button: the choice and the arrow in one frame, the arrow behind a divider", () => {
    const onOpen = vi.fn()
    const { container } = render(<ScopeCard {...base} onOpen={onOpen} />)
    const frame = frameOf()
    expect(frame.className).toContain("border")
    expect(frame.className).toContain("group/card")
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
    expect(frame.contains(open)).toBe(true)
    expect(segmentOf().contains(open)).toBe(false)
    expect(open.className).toContain("border-l")
    // Neutral, not the accent: the second action does not outshout the choice.
    expect(open.className).not.toMatch(/primary/u)
    expect(container.querySelector("svg.lucide-arrow-right")).toBeTruthy()
    fireEvent.click(open)
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it("slides the open button out while hovered and back when the pointer leaves", () => {
    const { container } = render(<ScopeCard {...base} onOpen={() => undefined} />)
    const row = container.firstElementChild as HTMLElement
    expect(reveal().dataset.shown).toBe("false")
    fireEvent.pointerEnter(row)
    expect(reveal().dataset.shown).toBe("true")
    fireEvent.pointerLeave(row)
    expect(reveal().dataset.shown).toBe("false")
  })

  it("keeps the button out while the list is open, so the list keeps the card's width", async () => {
    const { container } = render(<ScopeCard {...base} onOpen={() => undefined} />)
    const row = container.firstElementChild as HTMLElement
    fireEvent.pointerEnter(row)
    fireEvent.click(screen.getByRole("combobox"))
    await waitFor(() => screen.getByRole("listbox"))
    // The pointer goes down into the list, which lies outside the card.
    fireEvent.pointerLeave(row)
    expect(reveal().dataset.shown).toBe("true")
  })

  it("does not keep the arrow after a click: only hover, keyboard focus and an open list show it", () => {
    const { container } = render(<ScopeCard {...base} onOpen={() => undefined} />)
    const html = container.innerHTML
    expect(html).not.toContain("focus-within")
    expect(html).toContain("group-has-[:focus-visible]/card:block")
    expect(html).toContain("group-has-[[aria-expanded=true]]/card:block")
  })

  it("turns the arrow over while the list is open", () => {
    const { container } = render(<ScopeCard {...base} onOpen={() => undefined} />)
    expect(container.innerHTML).toContain("group-has-[[aria-expanded=true]]/card:rotate-180")
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

  it("makes the control fill its segment, so the list opens from the frame's left edge", async () => {
    render(<ScopeCard {...base} onOpen={() => undefined} />)
    const control = screen.getByRole("combobox")
    expect(control.parentElement).toBe(segmentOf())
    expect(control.className).toContain("w-full")
    fireEvent.click(control)
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
