// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import i18n from "@/lib/i18n"
import { ApprovalModeButton } from "./approval-mode"

describe("approval mode button", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en")
  })
  afterEach(async () => {
    cleanup()
    await i18n.changeLanguage("ru")
  })

  it("names the current mode and offers the three modes", async () => {
    const onChange = vi.fn()
    render(<ApprovalModeButton mode="manual" onChange={onChange} />)
    const trigger = screen.getByRole("button", { name: "How the AI's changes are applied" })
    expect(trigger.getAttribute("title")).toBe("Manual approval")
    await act(async () => fireEvent.click(trigger))
    const items = screen.getAllByRole("menuitemradio")
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining("Manual approval"),
      expect.stringContaining("Automatic"),
      expect.stringContaining("Without stops"),
    ])
    expect(items[0].getAttribute("aria-checked")).toBe("true")
    await act(async () => fireEvent.click(items[1]))
    expect(onChange).toHaveBeenCalledWith("auto")
  })

  it("shows a different icon title for each mode and can be disabled", () => {
    const { rerender } = render(<ApprovalModeButton mode="auto" onChange={vi.fn()} />)
    expect(screen.getByRole("button").getAttribute("title")).toBe("Automatic")
    rerender(<ApprovalModeButton mode="turbo" onChange={vi.fn()} disabled />)
    expect(screen.getByRole("button").getAttribute("title")).toBe("Without stops")
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true)
  })
})
