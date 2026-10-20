// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import "@/lib/i18n"
import { WorkspacePicker } from "./workspace-picker"

const vaults = [
  { id: "1", name: "Amby", path: "/Users/me/Documents/Amby" },
  { id: "2", name: "Work", path: "/Users/me/Work" },
]

function renderPicker(handlers: { onAdd?: () => void; onManage?: () => void } = {}) {
  const onSelect = vi.fn()
  render(
    <WorkspacePicker
      vaults={vaults}
      currentPath="/Users/me/Documents/Amby"
      onSelect={onSelect}
      onAdd={handlers.onAdd ?? (() => {})}
      onManage={handlers.onManage ?? (() => {})}
    >
      <button>open</button>
    </WorkspacePicker>,
  )
  fireEvent.click(screen.getByText("open"))
  return { onSelect }
}

describe("WorkspacePicker", () => {
  afterEach(cleanup)

  it("lists vault names without their paths", () => {
    renderPicker()
    expect(screen.getByText("Amby")).toBeTruthy()
    expect(screen.getByText("Work")).toBeTruthy()
    expect(screen.queryByText("/Users/me/Work")).toBeNull()
  })

  it("selects a vault, chooses a new one and opens the manager", () => {
    const onAdd = vi.fn()
    const onManage = vi.fn()
    const { onSelect } = renderPicker({ onAdd, onManage })

    fireEvent.click(screen.getByText("Work"))
    expect(onSelect).toHaveBeenCalledWith("/Users/me/Work")

    fireEvent.click(screen.getByText("open"))
    fireEvent.click(screen.getByText(/Выбрать хранилище|Choose vault/))
    expect(onAdd).toHaveBeenCalledOnce()

    fireEvent.click(screen.getByText("open"))
    fireEvent.click(screen.getByText(/Управление хранилищем|Manage vault/))
    expect(onManage).toHaveBeenCalledOnce()
  })
})
