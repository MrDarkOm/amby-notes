// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import "@/lib/i18n"

vi.mock("@/lib/app-updater", () => ({ getCurrentAppVersion: async () => "0.1.9" }))
const openWeb = vi.fn()
vi.mock("../tiptap/external-open", () => ({
  openWebAddressInBrowser: (url: string) => openWeb(url),
}))

import { AboutSettings } from "./settings-about"

afterEach(cleanup)

describe("Settings → About", () => {
  it("shows the version, the license with its source, and the bundled open licenses", async () => {
    render(<AboutSettings />)
    expect((await screen.findByTestId("about-version")).textContent).toBe("0.1.9")
    expect(screen.getByText(/GNU AGPL-3.0/)).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Исходный код" }))
    expect(openWeb).toHaveBeenCalledWith("https://github.com/MrDarkOm/amby-notes")
    const licenses = screen.getByTestId("emoji-licenses")
    expect(licenses.querySelectorAll("details")).toHaveLength(0)
    fireEvent.click(screen.getByRole("button", { name: /Лицензии Google Noto Emoji/ }))
    expect(licenses.querySelectorAll("details").length).toBeGreaterThan(0)
  })
})
