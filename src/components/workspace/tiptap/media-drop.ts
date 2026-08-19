import { Extension } from "@tiptap/core"
import { Plugin, PluginKey } from "@tiptap/pm/state"
import type { EditorView } from "@tiptap/pm/view"

import { getAssetContext } from "./asset-resolver"
import { importAsset, importAssetBytes, isTauri } from "@/lib/storage"

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|avif)$/i

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

async function insertFileLinkAt(view: EditorView, pos: number, href: string, text: string) {
  const link = view.state.schema.marks.link
  const tr = view.state.tr.insertText(text, pos)
  if (link) {
    tr.addMark(pos, pos + text.length, link.create({ href }))
  }
  view.dispatch(tr)
}

export interface ImportCtx {
  vaultPath: string
  notePath: string
}

export function getImportContextForView(view: EditorView): ImportCtx | null {
  // Tiptap stores its Editor back-reference on the editable DOM element, not
  // on ProseMirror's EditorView. Reading it from the view made clipboard and
  // external-drop imports silently miss their vault/note context.
  const editor = (view.dom as HTMLElement & { editor?: import("@tiptap/core").Editor }).editor
  const ctx = editor ? getAssetContext(editor) : undefined
  if (!ctx || !ctx.vaultPath || !ctx.notePath) return null
  return ctx
}

export async function importImageFromClipboard(ctx?: Partial<ImportCtx>): Promise<string | null> {
  if (
    !ctx?.vaultPath ||
    !ctx.notePath ||
    !isTauri() ||
    typeof navigator === "undefined" ||
    !navigator.clipboard?.read
  ) {
    return null
  }
  try {
    const clipboardItems = await navigator.clipboard.read()
    for (const item of clipboardItems) {
      const mime = item.types.find((type) => type.startsWith("image/"))
      if (!mime) continue
      const blob = await item.getType(mime)
      const bytes = new Uint8Array(await blob.arrayBuffer())
      const result = await importAssetBytes(ctx.vaultPath, ctx.notePath, bytes, extFromMime(mime))
      if (result?.kind === "image") return result.relPath
    }
  } catch {
    // Clipboard access can be denied by the OS/webview. The ordinary paste
    // event remains available and uses clipboardData without extra permission.
  }
  return null
}

async function handleFileList(view: EditorView, files: FileList, dropPos: number) {
  const ctx = getImportContextForView(view)
  if (!ctx || !isTauri()) return false
  let insertPos = dropPos
  for (const file of Array.from(files)) {
    const buf = new Uint8Array(await file.arrayBuffer())
    const ext = file.name.includes(".")
      ? (file.name.split(".").pop() ?? "")
      : extFromMime(file.type)
    const result = await importAssetBytes(ctx.vaultPath, ctx.notePath, buf, ext)
    if (!result) continue
    if (result.kind === "image") {
      await insertImageAt(view, insertPos, result.relPath)
    } else {
      await insertFileLinkAt(view, insertPos, result.relPath, result.fileName)
    }
    insertPos += 1
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
            const coords = view.posAtCoords({
              left: (event as DragEvent).clientX,
              top: (event as DragEvent).clientY,
            })
            if (!coords) return false
            event.preventDefault()
            void handleFileList(view, dt.files, coords.pos)
            return true
          },
          handlePaste(view, event) {
            const ce = event as ClipboardEvent
            const cd = ce.clipboardData
            if (!cd) return false
            const imageItems = Array.from(cd.items).filter(
              (it) => it.kind === "file" && it.type.startsWith("image/"),
            )
            if (imageItems.length > 0) {
              const ctx = getImportContextForView(view)
              if (!ctx || !isTauri()) return false
              event.preventDefault()
              ;(async () => {
                let insertPos = view.state.selection.from
                for (const item of imageItems) {
                  const file = item.getAsFile()
                  if (!file) continue
                  const buf = new Uint8Array(await file.arrayBuffer())
                  const ext = extFromMime(file.type)
                  const result = await importAssetBytes(ctx.vaultPath, ctx.notePath, buf, ext)
                  if (!result) continue
                  await insertImageAt(view, insertPos, result.relPath)
                  insertPos += 1
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
  const unlisten = await webview.onDragDropEvent(async (event) => {
    const payload = event.payload as unknown as {
      type: string
      paths?: string[]
      position?: { x: number; y: number }
    }
    if (payload.type !== "drop" || !payload.paths) return
    const ctx = getImportContextForView(view)
    if (!ctx) return
    // Tauri reports a PhysicalPosition while posAtCoords expects CSS pixels.
    const scale = window.devicePixelRatio || 1
    const pos = payload.position
      ? getDropPos(payload.position.x / scale, payload.position.y / scale)
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
