// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import "@/lib/i18n"

const calls = vi.hoisted(() => ({
  openAttachment: vi.fn<(note: string, attachment: string) => Promise<void>>(),
  openWebAddress: vi.fn<(address: string) => Promise<void>>(),
  showErrorMessage: vi.fn<(message: string) => Promise<void>>(),
}))

vi.mock("@/lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/storage")>()),
  ...calls,
}))

import { AttachmentPlayer } from "./attachment-view"
import {
  attachmentFilePath,
  openAttachmentWithSystem,
  openErrorMessage,
  openWebAddressInBrowser,
} from "./external-open"

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("the Open button of an attachment card", () => {
  it("hands the system the note and the file as the note wrote it, without an anchor", async () => {
    calls.openAttachment.mockResolvedValue()
    render(
      <AttachmentPlayer
        kind="pdf"
        candidates={["a"]}
        name="report.pdf"
        open={{ notePath: "/vault/Note.md", address: "assets/report.pdf#page=3" }}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "Открыть" }))
    await waitFor(() =>
      expect(calls.openAttachment).toHaveBeenCalledWith("/vault/Note.md", "assets/report.pdf"),
    )
    expect(calls.showErrorMessage).not.toHaveBeenCalled()
  })

  it("has no button for an address outside the vault, nor where nothing can be opened", () => {
    const { rerender } = render(
      <AttachmentPlayer
        kind="pdf"
        candidates={[]}
        name="x.pdf"
        remote
        open={{ notePath: "/vault/Note.md", address: "https://example.com/x.pdf" }}
      />,
    )
    expect(screen.queryByRole("button")).toBeNull()
    rerender(<AttachmentPlayer kind="pdf" candidates={["a"]} name="x.pdf" open={null} />)
    expect(screen.queryByRole("button")).toBeNull()
  })
})

describe("a refusal", () => {
  it("is explained to the person in words, not shown as a code or a path", async () => {
    calls.openAttachment.mockRejectedValue(new Error("AttachmentTypeNotAllowed"))
    calls.showErrorMessage.mockResolvedValue()
    await openAttachmentWithSystem("/vault/Note.md", "assets/tool.command")
    expect(calls.showErrorMessage).toHaveBeenCalledTimes(1)
    const message = calls.showErrorMessage.mock.calls[0][0]
    expect(message).toMatch(/программа или скрипт/u)
    expect(message).not.toContain("AttachmentTypeNotAllowed")
  })

  it("covers every code the backend can answer with", () => {
    const texts = [
      "AttachmentNotFound",
      "AttachmentOutsideAssets",
      "AttachmentTypeNotAllowed",
      "AddressNotAllowed",
      "OpenFailed",
      "something else",
    ].map((code) => openErrorMessage(new Error(`x ${code}`)))
    expect(new Set(texts).size).toBe(texts.length - 1)
    for (const text of texts) expect(text).not.toMatch(/Attachment|Address|OpenFailed/u)
  })

  it("is reported for a web address too, and never rejects", async () => {
    calls.openWebAddress.mockRejectedValue(new Error("AddressNotAllowed"))
    calls.showErrorMessage.mockResolvedValue()
    await expect(openWebAddressInBrowser("javascript:alert(1)")).resolves.toBeUndefined()
    expect(calls.showErrorMessage).toHaveBeenCalledTimes(1)
  })
})

describe("attachmentFilePath", () => {
  it("drops an anchor or a query after the file name", () => {
    expect(attachmentFilePath("assets/a.pdf#page=2")).toBe("assets/a.pdf")
    expect(attachmentFilePath("assets/a.mp4?t=5")).toBe("assets/a.mp4")
    expect(attachmentFilePath("assets/a.pdf")).toBe("assets/a.pdf")
  })
})
