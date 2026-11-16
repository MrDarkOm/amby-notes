// "Show in the file manager" for a file or folder of the vault: the answer is awaited, and when the system could
// not be asked the person is told in words in the notification centre (docs/notices.md, sections 3 and 10) and the
// code goes to the log. The raw text of the error is never shown.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import i18n from "@/lib/i18n"
import { isKnownDebugEvent } from "@/lib/debug/event-codes"
import { useAppNoticesStore } from "./notices/use-app-notices-store"

const open = vi.hoisted(() => vi.fn<(path: string) => Promise<void>>())
vi.mock("@/lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/storage")>()),
  openInExplorer: open,
}))
const warn = vi.hoisted(() => vi.fn())
vi.mock("@/lib/logger", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/logger")>()
  return { ...original, logger: { ...original.logger, warn } }
})

import { showInFileManager } from "./show-in-file-manager"

beforeEach(async () => {
  await i18n.changeLanguage("ru")
})
afterEach(() => {
  vi.clearAllMocks()
  useAppNoticesStore.setState(useAppNoticesStore.getInitialState())
})

describe("showInFileManager", () => {
  it("asks for the path it was given and says nothing when it worked", async () => {
    open.mockResolvedValue()
    await showInFileManager("/vault/Note.md")
    expect(open).toHaveBeenCalledWith("/vault/Note.md")
    expect(useAppNoticesStore.getState().notices).toEqual([])
    expect(warn).not.toHaveBeenCalled()
  })

  it("tells the person in words and logs the code when the system could not be asked", async () => {
    open.mockRejectedValue(new Error("OpenFailed"))
    await showInFileManager("/vault/Note.md")
    const [notice] = useAppNoticesStore.getState().notices
    expect(notice.level).toBe("warning")
    const text = i18n.t(notice.titleKey)
    expect(text).toBe("Не удалось показать файл или папку в проводнике.")
    expect(text).not.toContain("OpenFailed")
    expect(warn).toHaveBeenCalledWith("file.reveal_failed", { errorType: "Error" })
    expect(isKnownDebugEvent("file.reveal_failed")).toBe(true)
  })

  it("does not leave a rejected promise behind", async () => {
    open.mockRejectedValue(new Error("OpenFailed"))
    await expect(showInFileManager("/vault/Note.md")).resolves.toBeUndefined()
  })
})
