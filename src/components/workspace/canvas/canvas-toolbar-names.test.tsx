// @vitest-environment happy-dom
// UI-10: the colour buttons of the canvas toolbar are drawn as bare circles; a screen reader needs a name for each.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import i18n from "@/lib/i18n"
import { CanvasSelectionBar, ColorSwatches } from "./canvas-toolbar"

beforeEach(async () => {
  await i18n.changeLanguage("ru")
})
afterEach(cleanup)

describe("canvas colour buttons (UI-10)", () => {
  it("gives every swatch an accessible name, and all of them different", () => {
    render(<ColorSwatches onPick={vi.fn()} />)
    const buttons = screen.getAllByRole("button")
    expect(buttons).toHaveLength(7)
    const names = buttons.map((button) => button.getAttribute("aria-label") ?? "")
    expect(names.every((name) => name.trim() !== "")).toBe(true)
    expect(new Set(names).size).toBe(names.length)
  })

  it("names the colour button of the selection bar", () => {
    const noop = vi.fn()
    render(
      <CanvasSelectionBar
        selectedNodeCount={1}
        selectedEdgeCount={0}
        onSetColor={noop}
        onGroupSelection={noop}
        onAlign={noop}
        onDistribute={noop}
        onDuplicate={noop}
        onBringToFront={noop}
        onSendToBack={noop}
        onDelete={noop}
      />,
    )
    for (const button of screen.getAllByRole("button")) {
      expect(
        (button.getAttribute("aria-label") ?? button.getAttribute("title") ?? "").trim(),
        button.outerHTML.slice(0, 120),
      ).not.toBe("")
    }
  })
})
