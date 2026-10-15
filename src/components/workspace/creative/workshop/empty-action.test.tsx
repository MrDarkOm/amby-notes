// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { EmptyAction } from "./empty-action"

describe("EmptyAction in a narrow panel", () => {
  afterEach(cleanup)

  it("wraps a long label instead of cutting it with an ellipsis", () => {
    render(
      <EmptyAction label="Добавить первую страницу в самую длинную схему" onClick={() => {}} />,
    )
    const button = screen.getByRole("button")
    const label = screen.getByText("Добавить первую страницу в самую длинную схему")
    // `truncate` would make the label end in "…" at 320 px, and a row that cannot shrink would
    // push the list sideways; neither class is there.
    for (const element of [button, label]) {
      expect(element.className).not.toMatch(/\btruncate\b/u)
      expect(element.className).not.toMatch(/\bwhitespace-nowrap\b/u)
      expect(element.className).not.toMatch(/\btext-ellipsis\b/u)
    }
    expect(label.className).toContain("break-words")
    expect(button.className).toContain("min-w-0")
  })
})
