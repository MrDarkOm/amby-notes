// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import "@/lib/i18n"
import type { DatabasePropertySummary } from "@/lib/storage"
import { BoardGroupPrompt } from "./board-group-prompt"

const status: DatabasePropertySummary = {
  propertyId: "s",
  name: "Status",
  propertyType: "status",
  configJson: "{}",
  options: [],
}

describe("BoardGroupPrompt", () => {
  afterEach(cleanup)

  it("offers each candidate property and reports the pick", () => {
    const onPick = vi.fn()
    render(<BoardGroupPrompt candidates={[status]} onPick={onPick} />)
    fireEvent.click(screen.getByRole("button", { name: "Status" }))
    expect(onPick).toHaveBeenCalledWith("s")
  })

  it("explains what to add when no property can split the board", () => {
    render(<BoardGroupPrompt candidates={[]} onPick={() => {}} />)
    expect(screen.queryByRole("button")).toBeNull()
    expect(screen.getByRole("region").textContent).toContain("Status")
  })
})
