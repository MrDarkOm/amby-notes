import type { Editor } from "@tiptap/core"

import i18n from "@/lib/i18n"
import { isTauri, saveAttachmentCopy, showErrorMessage } from "@/lib/storage"
import { getAssetContext } from "./asset-resolver"
import { attachmentFilePath, openErrorMessage } from "./external-open"
import {
  imageSaveFormat,
  imageSaveName,
  imageSourceBlob,
  isVaultImage,
  saveBlobAs,
} from "./image-actions"

/**
 * Saves a picture of the note as a file. A file of the vault is copied byte for byte through the
 * backend, which asks where to put it; any other picture is redrawn from `shownSrc` (the address
 * it is drawn from) and handed over as a download.
 */
export async function saveNoteImage(editor: Editor, src: string, shownSrc: string): Promise<void> {
  const context = getAssetContext(editor)
  if (isTauri() && isVaultImage(src) && context?.notePath) {
    try {
      await saveAttachmentCopy(context.notePath, attachmentFilePath(src))
    } catch (error) {
      void showErrorMessage(openErrorMessage(error))
    }
    return
  }
  try {
    const format = imageSaveFormat(src)
    saveBlobAs(await imageSourceBlob(shownSrc, format), imageSaveName(src, format))
  } catch {
    void showErrorMessage(i18n.t("editorToolbar.imageFailed"))
  }
}
