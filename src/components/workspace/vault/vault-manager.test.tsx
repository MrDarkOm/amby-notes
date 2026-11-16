// @vitest-environment happy-dom
// "Show in Finder" for a known vault works for any vault of the list, and when it does not work the person is told
// under the vault, in words, and the code goes to the log (docs/notices.md, sections 8 and 10).
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import i18n from "@/lib/i18n"
import { isKnownDebugEvent } from "@/lib/debug/event-codes"
import { VaultManager } from "./vault-manager"

const warn = vi.hoisted(() => vi.fn())
vi.mock("@/lib/logger", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/logger")>()
  return { ...original, logger: { ...original.logger, warn } }
})

const VAULTS = [
  { id: "v1", name: "Первое", path: "/vaults/one" },
  { id: "v2", name: "Второе", path: "/vaults/two" },
]

function renderManager(reveal: (id: string) => Promise<void>) {
  const noop = () => {}
  render(
    <VaultManager
      vaults={VAULTS}
      currentPath="/vaults/one"
      onSelect={noop}
      onOpenVault={noop}
      onRename={noop}
      onDelete={noop}
      onMove={noop}
      onRevealVault={reveal}
    />,
  )
}

async function chooseShowInFinder(vaultName: string) {
  const row = screen.getByText(vaultName).closest("li") as HTMLElement
  const trigger = row.querySelector("button[aria-haspopup='menu']") as HTMLElement
  fireEvent.keyDown(trigger, { key: "Enter" })
  fireEvent.click(await screen.findByText("Открыть в проводнике"))
}

beforeEach(async () => {
  await i18n.changeLanguage("ru")
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("Show in Finder in the vault manager", () => {
  it("asks for the folder of the chosen vault by its id, even when it is not the open one", async () => {
    const reveal = vi.fn<(id: string) => Promise<void>>().mockResolvedValue()
    renderManager(reveal)
    await chooseShowInFinder("Второе")
    await waitFor(() => expect(reveal).toHaveBeenCalledWith("v2"))
  })

  it("tells the person under the vault when the folder cannot be shown, and logs the code", async () => {
    const reveal = vi
      .fn<(id: string) => Promise<void>>()
      .mockRejectedValue(new Error("VaultFolderMissing"))
    renderManager(reveal)
    await chooseShowInFinder("Второе")
    const line = await screen.findByTestId("notice-line")
    expect(line.closest("li")?.textContent).toContain("Второе")
    expect(line.textContent).not.toContain("VaultFolderMissing")
    expect(line.textContent?.length).toBeGreaterThan(10)
    expect(warn).toHaveBeenCalledWith("vault.reveal_failed", { errorType: "Error" })
    expect(isKnownDebugEvent("vault.reveal_failed")).toBe(true)
  })

  it("shows nothing when the folder was shown", async () => {
    renderManager(vi.fn<(id: string) => Promise<void>>().mockResolvedValue())
    await chooseShowInFinder("Первое")
    await waitFor(() => expect(screen.queryByTestId("notice-line")).toBeNull())
  })
})
