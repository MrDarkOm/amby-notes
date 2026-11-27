// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import "@/lib/i18n"

const port = vi.hoisted(() => ({
  propertyStorageStatus: vi.fn(),
  getPropertyPanel: vi.fn(),
  restoreDormantProperty: vi.fn(),
  purgeDormantProperty: vi.fn(),
}))
vi.mock("@/lib/properties/property-groups-port", () => port)

import { PropertyDormantList } from "./property-dormant-list"

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const withDormant = {
  unreadable: false,
  active: [],
  dormant: [{ name: "Заказчик", icon: "📌", propertyType: "text", settings: "" }],
  renameHint: null,
  warnings: [],
}

describe("PropertyDormantList", () => {
  it("shows nothing in the browser", async () => {
    port.propertyStorageStatus.mockResolvedValue(null)
    const { container } = render(<PropertyDormantList noteId="N1" />)
    await waitFor(() => expect(port.propertyStorageStatus).toHaveBeenCalled())
    expect(container.innerHTML).toBe("")
  })

  it("lists a record without a key and brings it back or deletes it on request", async () => {
    port.propertyStorageStatus.mockResolvedValue({ mode: "groups", oldVersionWarning: null })
    port.getPropertyPanel.mockResolvedValue(withDormant)
    port.restoreDormantProperty.mockResolvedValue(undefined)
    port.purgeDormantProperty.mockResolvedValue(undefined)
    render(<PropertyDormantList noteId="N1" />)
    fireEvent.click(await screen.findByText("Вернуть"))
    await waitFor(() => expect(port.restoreDormantProperty).toHaveBeenCalledWith("N1", "Заказчик"))
    fireEvent.click(screen.getByText("Удалить окончательно"))
    await waitFor(() => expect(port.purgeDormantProperty).toHaveBeenCalledWith("N1", "Заказчик"))
  })
})
