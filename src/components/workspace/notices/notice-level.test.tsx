// @vitest-environment happy-dom
// One component draws the level of a notice (docs/notices.md, sections 2.1 and 11, step 1 of the
// transition): the icon, the role and the colours come from the level alone, and the colours are
// theme tokens, never `amber-*` classes. Behaviour only; how it looks is checked in a native window.
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import { NoticeLevelIcon, NoticeShell, type NoticeLevel } from "./notice-level"

const LEVELS: Array<[NoticeLevel, string, "alert" | "status"]> = [
  ["danger", "lucide-octagon-alert", "alert"],
  ["decision", "lucide-triangle-alert", "status"],
  ["warning", "lucide-circle-alert", "status"],
  ["info", "lucide-info", "status"],
  ["success", "lucide-circle-check", "status"],
]

afterEach(cleanup)

describe("the icon of a level", () => {
  it.each(LEVELS)("%s has its own Lucide icon", (level, iconClass) => {
    const { container } = render(<NoticeLevelIcon level={level} />)
    const svg = container.querySelector("svg")
    expect(svg).not.toBeNull()
    expect(svg!.classList.contains(iconClass)).toBe(true)
    // decoration: the level is said by the role and the text, not by the picture
    expect(svg!.getAttribute("aria-hidden")).toBe("true")
  })

  it("never gives a good piece of news the triangle", () => {
    const { container } = render(<NoticeLevelIcon level="info" />)
    expect(container.querySelector("svg")).not.toBeNull()
    expect(container.querySelector("svg.lucide-triangle-alert")).toBeNull()
    cleanup()
    const success = render(<NoticeLevelIcon level="success" />)
    expect(success.container.querySelector("svg")).not.toBeNull()
    expect(success.container.querySelector("svg.lucide-triangle-alert")).toBeNull()
  })

  it.each(LEVELS)("%s takes its colour from the token of the level", (level) => {
    const { container } = render(<NoticeLevelIcon level={level} className="size-4" />)
    const svg = container.querySelector("svg")!
    expect(svg.getAttribute("class")).toContain(`--notice-${level}-fg`)
    expect(svg.getAttribute("class")).toContain("size-4")
    expect(svg.getAttribute("class")).not.toMatch(/amber/)
  })
})

describe("the frame of a level", () => {
  it.each(LEVELS)("%s has the role, the level and the classes of its tokens", (level, _i, role) => {
    render(
      <NoticeShell level={level} data-testid="shell" className="extra">
        text
      </NoticeShell>,
    )
    const shell = screen.getByTestId("shell")
    expect(shell.getAttribute("data-level")).toBe(level)
    expect(shell.getAttribute("role")).toBe(role)
    const classes = shell.getAttribute("class") ?? ""
    expect(classes).toContain(`--notice-${level}-bg`)
    expect(classes).toContain(`--notice-${level}-border`)
    expect(classes).toContain("extra")
    expect(classes).not.toMatch(/amber/)
    expect(shell.textContent).toBe("text")
  })

  it("only danger is announced as an alert", () => {
    render(
      <>
        {LEVELS.map(([level]) => (
          <NoticeShell key={level} level={level}>
            {level}
          </NoticeShell>
        ))}
      </>,
    )
    expect(screen.getAllByRole("alert")).toHaveLength(1)
    expect(screen.getAllByRole("status")).toHaveLength(4)
  })
})
