import { Extension } from "@tiptap/core"
import { Plugin, PluginKey } from "@tiptap/pm/state"
import type { EditorView } from "@tiptap/pm/view"

import { getAssetContext } from "./asset-resolver"
import { importAsset, importAssetBytes, isTauri } from "@/lib/storage"

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i

function extFromMime(mime: string): string {
  if (mime === "image/jpeg") return "jpg"
  if (mime === "image/svg+xml") return "svg"
  if (mime.startsWith("image/")) return mime.slice("image/".length)
  return "png"
}

async function insertImageAt(view: EditorView, pos: number, src: string) {
  const node = view.state.schema.nodes.image
  if (!node) return
  const tr = view.state.tr.insert(pos, node.create({ src }))
  view.dispatch(tr)
}

async function insertFileLinkAt(
  view: EditorView,
  pos: number,
  href: string,
  text: string,
) {
  const link = view.state.schema.marks.link
  const tr = view.state.tr.insertText(text, pos)
  if (link) {
    tr.addMark(pos, pos + text.length, link.create({ href }))
  }
  view.dispatch(tr)
}

interface ImportCtx {
  vaultPath: string
  notePath: string
}

function getCtx(view: EditorView): ImportCtx | null {
  // Walk up to find the editor instance. ProseMirror EditorView has a private
  // back-reference, but the simpler path is to read from the resolver map.
  // The Tiptap Editor sets the asset context keyed by `editor`, so we look it
  // up via the view's `editor` shim added by Tiptap when the view was built.
  const editor = (view as unknown as { editor?: unknown }).editor as
    | import("@tiptap/core").Editor
    | undefined
  const ctx = editor ? getAssetContext(editor) : undefined
  if (!ctx || !ctx.vaultPath || !ctx.notePath) return null
  return ctx
}

async function handleFileList(view: EditorView, files: FileList, dropPos: number) {
  const ctx = getCtx(view)
  if (!ctx || !isTauri()) return false
  for (const file of Array.from(files)) {
    const buf = new Uint8Array(await file.arrayBuffer())
    const ext = file.name.includes(".") ? file.name.split(".").pop() ?? "" : extFromMime(file.type)
    const result = await importAssetBytes(ctx.vaultPath, ctx.notePath, buf, ext)
    if (!result) continue
    if (result.kind === "image") {
      await insertImageAt(view, dropPos, result.relPath)
    } else {
      await insertFileLinkAt(view, dropPos, result.relPath, result.fileName)
    }
  }
  return true
}

export const MediaDrop = Extension.create({
  name: "ambyMediaDrop",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("ambyMediaDrop"),
        props: {
          handleDrop(view, event, _slice, moved) {
            if (moved) return false
            const dt = (event as DragEvent).dataTransfer
            if (!dt || dt.files.length === 0) return false
            const coords = view.posAtCoords({ left: (event as DragEvent).clientX, top: (event as DragEvent).clientY })
            if (!coords) return false
            event.preventDefault()
            void handleFileList(view, dt.files, coords.pos)
            return true
          },
          handlePaste(view, event) {
            const ce = event as ClipboardEvent
            const cd = ce.clipboardData
            if (!cd) return false
            const imageItems = Array.from(cd.items).filter(it => it.kind === "file" && it.type.startsWith("image/"))
            if (imageItems.length > 0) {
              const ctx = getCtx(view)
              if (!ctx || !isTauri()) return false
              event.preventDefault()
              ;(async () => {
                for (const item of imageItems) {
                  const file = item.getAsFile()
                  if (!file) continue
                  const buf = new Uint8Array(await file.arrayBuffer())
                  const ext = extFromMime(file.type)
                  const result = await importAssetBytes(ctx.vaultPath, ctx.notePath, buf, ext)
                  if (!result) continue
                  await insertImageAt(view, view.state.selection.from, result.relPath)
                }
              })()
              return true
            }
            const text = cd.getData("text/plain").trim()
            if (text && /^https?:\/\//i.test(text) && !text.includes("\n")) {
              if (IMAGE_EXT_RE.test(text)) {
                event.preventDefault()
                void insertImageAt(view, view.state.selection.from, text)
                return true
              }
            }
            return false
          },
        },
      }),
    ]
  },
})

// Tauri's webview consumes Finder drops before HTML5 reaches ProseMirror; this
// helper registers a window-level handler so we can still route them through
// the same import pipeline. Returns an unsubscribe.
export async function bindTauriFileDrop(
  view: EditorView,
  getDropPos: (clientX: number, clientY: number) => number | null,
): Promise<() => void> {
  if (!isTauri()) return () => {}
  const { getCurrentWebview } = await import("@tauri-apps/api/webview")
  const webview = getCurrentWebview()
  const unlisten = await webview.onDragDropEvent(async event => {
    const payload = event.payload as unknown as { type: string; paths?: string[]; position?: { x: number; y: number } }
    if (payload.type !== "drop" || !payload.paths) return
    const ctx = getCtx(view)
    if (!ctx) return
    const pos = payload.position
      ? getDropPos(payload.position.x, payload.position.y)
      : view.state.selection.from
    if (pos == null) return
    let insertPos = pos
    for (const src of payload.paths) {
      const result = await importAsset(ctx.vaultPath, ctx.notePath, src)
      if (!result) continue
      if (result.kind === "image") {
        await insertImageAt(view, insertPos, result.relPath)
      } else {
        await insertFileLinkAt(view, insertPos, result.relPath, result.fileName)
      }
      insertPos += 1
    }
  })
  return () => {
    void unlisten()
  }
}
