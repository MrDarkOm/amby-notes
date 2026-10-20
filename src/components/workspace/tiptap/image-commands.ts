import type { Editor } from "@tiptap/core"
import type { Node as PMNode } from "@tiptap/pm/model"

import i18n from "@/lib/i18n"
import { importAsset, isTauri, pickAssetFile, showErrorMessage } from "@/lib/storage"
import { getAssetContext } from "./asset-resolver"
import { copyImageToClipboard } from "./image-actions"
import { updateImageNode } from "./image-edit"
import { saveNoteImage } from "./image-save"
import type { CropRequest } from "./ImageCropDialog"

/**
 * What can be done with a picture of the note, by its position. The floating toolbar of a
 * selected picture and the block menu of the line it is on use the same commands. The viewer
 * and the crop dialog belong to the editor, which listens for these events on its own DOM.
 */
export const OPEN_IMAGE_VIEWER_EVENT = "amby:open-image-viewer"
export const CROP_IMAGE_EVENT = "amby:crop-image"

export function imageNodeAt(editor: Editor, pos: number): PMNode | null {
  const { doc } = editor.state
  const node = pos >= 0 && pos < doc.content.size ? doc.nodeAt(pos) : null
  return node?.type.name === "image" ? node : null
}

/** The element that shows the picture at `pos`. */
export function shownImageAt(editor: Editor, pos: number): HTMLImageElement | null {
  const dom = editor.view.nodeDOM(pos)
  return dom instanceof HTMLElement ? dom.querySelector("img") : null
}

/** Whether pictures can be replaced and cropped: they are written as files of the note. */
export function canEditImageFiles(editor: Editor): boolean {
  const context = getAssetContext(editor)
  return isTauri() && Boolean(context?.vaultPath && context.notePath)
}

export function requestImageViewer(editor: Editor, pos: number): void {
  editor.view.dom.dispatchEvent(new CustomEvent(OPEN_IMAGE_VIEWER_EVENT, { detail: { pos } }))
}

export function requestImageCrop(editor: Editor, pos: number, src: string): void {
  const image = shownImageAt(editor, pos)
  if (!image) return
  const request: CropRequest = { pos, src, shownSrc: image.currentSrc || image.src }
  editor.view.dom.dispatchEvent(new CustomEvent(CROP_IMAGE_EVENT, { detail: request }))
}

function reportFailure() {
  void showErrorMessage(i18n.t("editorToolbar.imageFailed"))
}

/** Puts the picture on the clipboard; whether it worked. */
export async function copyImageAt(editor: Editor, pos: number): Promise<boolean> {
  const image = shownImageAt(editor, pos)
  if (!image) return false
  try {
    await copyImageToClipboard(image)
    return true
  } catch {
    reportFailure()
    return false
  }
}

export async function saveImageAt(editor: Editor, pos: number, src: string): Promise<void> {
  const image = shownImageAt(editor, pos)
  if (!image) return
  await saveNoteImage(editor, src, image.currentSrc || image.src)
}

/** Asks for a picture file and makes the picture at `pos` show it. */
export async function replaceImageAt(editor: Editor, pos: number, src: string): Promise<void> {
  const context = getAssetContext(editor)
  if (!context?.vaultPath || !context.notePath) return
  try {
    const picked = await pickAssetFile(true)
    if (!picked) return
    const asset = await importAsset(context.vaultPath, context.notePath, picked)
    if (!asset) throw new Error("The picture was not imported")
    updateImageNode(editor, pos, src, { src: asset.relPath, height: null })
  } catch {
    reportFailure()
  }
}
