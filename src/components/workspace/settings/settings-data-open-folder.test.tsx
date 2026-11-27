// @vitest-environment happy-dom
// "Open folder" in the data settings shows the app's own data folder, and when that fails the person is told under
// the button, in words, and the code goes to the log (docs/notices.md, sections 8 and 10).
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import i18n from "@/lib/i18n"
import { DataTab } from "./settings-data"

const reveal = vi.hoisted(() => vi.fn<() => Promise<void>>())
const warn = vi.hoisted(() => vi.fn())

vi.mock("@/lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/storage")>()),
  isTauri: () => true,
  revealAppDataFolder: reveal,
}))
vi.mock("@tauri-apps/api/path", () => ({ localDataDir: async () => "/data" }))
vi.mock("@/lib/logger", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/logger")>()
  return { ...original, logger: { ...original.logger, warn } }
})

beforeEach(async () => {
  await i18n.changeLanguage("ru")
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

async function pressOpenFolder() {
  const button = await screen.findByRole("button", { name: "Открыть папку" })
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(button)
}

describe("Open folder in the data settings", () => {
  it("asks for the data folder without sending a path", async () => {
    reveal.mockResolvedValue()
    render(<DataTab vault={null} />)
    await pressOpenFolder()
    await waitFor(() => expect(reveal).toHaveBeenCalledWith())
    expect(screen.queryByTestId("notice-line")).toBeNull()
  })

  it("tells the person under the button when it fails, and logs the code", async () => {
    reveal.mockRejectedValue(new Error("OpenFailed"))
    render(<DataTab vault={null} />)
    await pressOpenFolder()
    const line = await screen.findByTestId("notice-line")
    expect(line.textContent).not.toContain("OpenFailed")
    expect(warn).toHaveBeenCalledWith("vault.reveal_failed", { errorType: "Error" })
  })
})
