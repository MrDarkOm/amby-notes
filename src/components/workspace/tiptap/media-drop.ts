import { Extension } from "@tiptap/core"
import { Plugin, PluginKey } from "@tiptap/pm/state"
import type { EditorView } from "@tiptap/pm/view"

import { getAssetContext } from "./asset-resolver"
import { importAsset, importAssetBytes, isTauri, type ImportedAsset } from "@/lib/storage"

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|avif)$/i
const mediaDropSessions = new WeakMap<EditorView, AbortController>()

function extFromMime(mime: string): string {
  if (mime === "image/jpeg") return "jpg"
  if (mime === "image/svg+xml") return "svg"
  if (mime.startsWith("image/")) return mime.slice("image/".length)
  return "png"
}

function createImageNode(view: EditorView, src: string) {
  const node = view.state.schema.nodes.image
  if (!node) return null
  return node.create({ src })
}

/** Insert a completed media batch into exactly one current editor transaction. */
export function insertImportedAssets(
  view: EditorView,
  requestedPos: number,
  assets: ImportedAsset[],
  signal?: AbortSignal,
): boolean {
  if (signal?.aborted || assets.length === 0) return false
  const { state } = view
  const tr = state.tr
  let insertPos = Math.max(0, Math.min(requestedPos, state.doc.content.size))
  for (const asset of assets) {
    if (signal?.aborted) return false
    if (asset.kind === "image") {
      const image = createImageNode(view, asset.relPath)
      if (!image) continue
      tr.insert(insertPos, image)
    } else {
      const text = asset.fileName
      tr.insertText(text, insertPos)
      const link = state.schema.marks.link
      if (link) tr.addMark(insertPos, insertPos + text.length, link.create({ href: asset.relPath }))
    }
    // Mapping accounts for image nodeSize=1 and the actual UTF-16 text length
    // of a file link without hand-maintained position arithmetic.
    insertPos = tr.mapping.map(insertPos, 1)
  }
  if (signal?.aborted || !tr.docChanged) return false
  view.dispatch(tr)
  return true
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

async function importFiles(
  ctx: ImportCtx,
  files: Iterable<File>,
  signal?: AbortSignal,
): Promise<ImportedAsset[]> {
  const imported: ImportedAsset[] = []
  for (const file of files) {
    if (signal?.aborted) return []
    const buf = new Uint8Array(await file.arrayBuffer())
    if (signal?.aborted) return []
    const ext = file.name.includes(".")
      ? (file.name.split(".").pop() ?? "")
      : extFromMime(file.type)
    const result = await importAssetBytes(ctx.vaultPath, ctx.notePath, buf, ext)
    if (signal?.aborted) return []
    if (result) imported.push(result)
  }
  return imported
}

async function handleFileList(
  view: EditorView,
  files: FileList,
  dropPos: number,
  signal?: AbortSignal,
) {
  const ctx = getImportContextForView(view)
  if (!ctx || !isTauri()) return false
  const imported = await importFiles(ctx, Array.from(files), signal)
  return insertImportedAssets(view, dropPos, imported, signal)
}

function sessionSignal(view: EditorView): AbortSignal {
  let controller = mediaDropSessions.get(view)
  if (!controller) {
    controller = new AbortController()
    mediaDropSessions.set(view, controller)
  }
  return controller.signal
}

export const MediaDrop = Extension.create({
  name: "ambyMediaDrop",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("ambyMediaDrop"),
        view(view) {
          const controller = new AbortController()
          mediaDropSessions.set(view, controller)
          return {
            destroy() {
              controller.abort()
              mediaDropSessions.delete(view)
            },
          }
        },
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
            void handleFileList(view, dt.files, coords.pos, sessionSignal(view))
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
              const signal = sessionSignal(view)
              void (async () => {
                const files = imageItems.flatMap((item) => {
                  const file = item.getAsFile()
                  return file ? [file] : []
                })
                const imported = await importFiles(ctx, files, signal)
                insertImportedAssets(view, view.state.selection.from, imported, signal)
              })()
              return true
            }
            const text = cd.getData("text/plain").trim()
            if (text && /^https?:\/\//i.test(text) && !text.includes("\n")) {
              if (IMAGE_EXT_RE.test(text)) {
                event.preventDefault()
                const image = createImageNode(view, text)
                if (image) view.dispatch(view.state.tr.insert(view.state.selection.from, image))
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
  signal?: AbortSignal,
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
    if (signal?.aborted) return
    const ctx = getImportContextForView(view)
    if (!ctx) return
    // Tauri reports a PhysicalPosition while posAtCoords expects CSS pixels.
    const scale = window.devicePixelRatio || 1
    const pos = payload.position
      ? getDropPos(payload.position.x / scale, payload.position.y / scale)
      : view.state.selection.from
    if (pos == null) return
    const imported: ImportedAsset[] = []
    for (const src of payload.paths) {
      if (signal?.aborted) return
      const result = await importAsset(ctx.vaultPath, ctx.notePath, src)
      if (signal?.aborted) return
      if (result) imported.push(result)
    }
    insertImportedAssets(view, pos, imported, signal)
  })
  return () => {
    void unlisten()
  }
}
