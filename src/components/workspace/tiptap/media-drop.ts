import { Extension } from "@tiptap/core"
import { Plugin, PluginKey, Selection } from "@tiptap/pm/state"
import type { EditorView } from "@tiptap/pm/view"

import { getAssetContext } from "./asset-resolver"
import { importAsset, importAssetBytes, isTauri, type ImportedAsset } from "@/lib/storage"
import { errorType, logger } from "@/lib/logger"

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

function inlineInsertionPos(view: EditorView, requestedPos: number): number | null {
  const { doc } = view.state
  const clamped = Math.max(0, Math.min(requestedPos, doc.content.size))
  const $requested = doc.resolve(clamped)
  if ($requested.parent.inlineContent) return clamped

  // A drop in the empty area below the final block resolves to the document
  // boundary, where inline images and link text are invalid. Move to the
  // nearest text cursor instead of copying files and then losing their links.
  const preferredDirection = clamped === 0 ? 1 : -1
  const preferred = Selection.findFrom($requested, preferredDirection, true)
  const fallback = Selection.findFrom($requested, -preferredDirection, true)
  return preferred?.from ?? fallback?.from ?? null
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
  let insertPos = inlineInsertionPos(view, requestedPos)
  if (insertPos == null) return false
  const insertionAnchor = insertPos
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
    // Always remap the original anchor through every completed step. Remapping
    // an already-mapped position compounds earlier offsets and eventually
    // produces an out-of-range position for batches of three or more items.
    insertPos = tr.mapping.map(insertionAnchor, 1)
  }
  if (signal?.aborted || !tr.docChanged) return false
  view.dispatch(tr)
  return true
}

export interface ImportCtx {
  vaultPath: string
  notePath: string
}

type DroppedAssetImporter = (
  vaultPath: string,
  notePath: string,
  sourcePath: string,
) => Promise<ImportedAsset | null>

/** Import a dropped batch sequentially so its visible order matches the OS payload. */
export async function importDroppedPaths(
  ctx: ImportCtx,
  paths: string[],
  signal?: AbortSignal,
  importer: DroppedAssetImporter = importAsset,
): Promise<ImportedAsset[]> {
  const imported: ImportedAsset[] = []
  for (const sourcePath of paths) {
    if (signal?.aborted) return []
    try {
      const result = await importer(ctx.vaultPath, ctx.notePath, sourcePath)
      if (signal?.aborted) return []
      if (result) imported.push(result)
    } catch (error) {
      // One unreadable/oversized item must not orphan all assets imported
      // before it. Do not log paths because they can contain private data.
      logger.warn("media_drop.import_failed", { errorType: errorType(error) })
    }
  }
  return imported
}

/**
 * Wry reports client coordinates on macOS/Linux but native physical pixels on
 * Windows even though Tauri wraps every payload as `PhysicalPosition`.
 */
export function tauriDropClientPosition(
  position: { x: number; y: number },
  scale: number,
  platform: string,
): { x: number; y: number } {
  const divisor = /^win/i.test(platform) && Number.isFinite(scale) && scale > 0 ? scale : 1
  return { x: position.x / divisor, y: position.y / divisor }
}

/** Resolve drops against the editor container, including its empty tail below ProseMirror. */
export function getTauriDropPosForView(
  view: EditorView,
  clientX: number,
  clientY: number,
): number | null {
  const contentRect = view.dom.getBoundingClientRect()
  const containerRect = view.dom.closest(".amby-tiptap")?.getBoundingClientRect() ?? contentRect
  if (
    clientX < containerRect.left ||
    clientX > containerRect.right ||
    clientY < containerRect.top ||
    clientY > containerRect.bottom
  ) {
    return null
  }
  if (clientY < contentRect.top) return 0
  if (clientY > contentRect.bottom) return view.state.doc.content.size
  return view.posAtCoords({ left: clientX, top: clientY })?.pos ?? null
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
    const scale = window.devicePixelRatio || 1
    const clientPosition = payload.position
      ? tauriDropClientPosition(payload.position, scale, navigator.platform)
      : null
    const pos = payload.position
      ? getDropPos(clientPosition!.x, clientPosition!.y)
      : view.state.selection.from
    if (pos == null) return
    const imported = await importDroppedPaths(ctx, payload.paths, signal)
    insertImportedAssets(view, pos, imported, signal)
  })
  return () => {
    void unlisten()
  }
}
