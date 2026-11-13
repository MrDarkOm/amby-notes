// @vitest-environment happy-dom
// A picture that could not be saved, copied or cropped (docs/notices.md, sections 3 and 13): the crop window says
// it under its own button, the other two go to the centre as a warning (nothing is lost, nobody waits for an
// answer). No window of the system, and no text of an error.
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import i18n from "@/lib/i18n"
import { ImageCropDialog } from "./ImageCropDialog"
import { saveNoteImage } from "./image-save"
import { useAppNoticesStore } from "../notices/use-app-notices-store"

const calls = vi.hoisted(() => ({
  saveAttachmentCopy: vi.fn<(note: string, file: string) => Promise<void>>(),
}))
vi.mock("@/lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/storage")>()),
  ...calls,
  isTauri: () => true,
}))
vi.mock("./asset-resolver", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./asset-resolver")>()),
  getAssetContext: () => ({ vaultPath: "/vault", notePath: "/vault/План.md" }),
}))

beforeEach(async () => {
  await i18n.changeLanguage("ru")
  useAppNoticesStore.setState(useAppNoticesStore.getInitialState())
})
afterEach(cleanup)

describe("the crop window", () => {
  it("shows its own failure inside, as an alert, in words", () => {
    render(
      <ImageCropDialog
        src="data:image/png;base64,AAAA"
        error={i18n.t("editorToolbar.imageFailed")}
        onCancel={() => {}}
        onApply={async () => {}}
      />,
    )
    expect(screen.getByRole("alert").textContent).toBe("Не удалось прочитать изображение.")
  })

  it("has no alert while nothing failed", () => {
    render(
      <ImageCropDialog
        src="data:image/png;base64,AAAA"
        error={null}
        onCancel={() => {}}
        onApply={async () => {}}
      />,
    )
    expect(screen.queryByRole("alert")).toBeNull()
  })
})

describe("saving a picture of the vault", () => {
  it("goes to the centre as a warning, in words, when the copy is refused", async () => {
    calls.saveAttachmentCopy.mockRejectedValue(new Error("AttachmentNotFound /vault/x.png"))
    const editor = {} as never
    await saveNoteImage(editor, "assets/x.png", "asset://x.png")
    const [notice] = useAppNoticesStore.getState().notices
    expect(notice.level).toBe("warning")
    expect(i18n.t(notice.titleKey, notice.params)).not.toContain("AttachmentNotFound")
    expect(JSON.stringify(notice)).not.toContain("/vault/x.png")
  })
})
