// @vitest-environment happy-dom
// A wiki link that could not be opened says so in the notification centre, in words; the reason is in the log (audit UI-02).
import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { logger } from "@/lib/logger"
import { useAppNoticesStore } from "../notices/use-app-notices-store"
import { useWikiNavigation } from "./use-wiki-navigation"

vi.mock("@/lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/storage")>()),
  createNote: vi.fn().mockRejectedValue(new Error("EACCES /Users/me/secret")),
}))

beforeEach(() => useAppNoticesStore.setState({ notices: [] }))
afterEach(cleanup)

describe("a wiki link that cannot be opened", () => {
  it("posts a warning with words and logs the code, not the console", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => null)
    const { result } = renderHook(() =>
      useWikiNavigation({
        vault: "/v",
        treeItems: [],
        handleApplyMutation: vi.fn(),
        handleSelect: vi.fn(),
        releaseUnusedDocumentBuffers: vi.fn(),
      } as never),
    )
    await act(() => result.current.handleWikiLinkClick("Нет такой"))
    const [notice] = useAppNoticesStore.getState().notices
    expect(notice.level).toBe("warning")
    expect(notice.titleKey).toBe("notices.app.wikiLinkFailed.title")
    expect(JSON.stringify(notice)).not.toContain("EACCES")
    expect(warn).toHaveBeenCalledWith("file.wiki_link_open_failed", expect.anything())
    expect(consoleError).not.toHaveBeenCalled()
    consoleError.mockRestore()
    warn.mockRestore()
  })
})
