import type { Editor } from "@tiptap/core"

import { isTauri } from "@/lib/storage"

export interface AssetContext {
  vaultPath: string
  notePath: string
  /** The note being edited, for blocks that depend on the page they sit on. */
  noteId?: string
}

const contexts = new WeakMap<Editor, AssetContext>()
const converterListeners = new Set<() => void>()
const contextListeners = new WeakMap<Editor, Set<() => void>>()
const contextRevisions = new WeakMap<Editor, number>()
let converterRevision = 0
let converterPromise: Promise<void> | null = null

function notifyConverterChanged() {
  converterRevision += 1
  for (const listener of converterListeners) listener()
}

function notifyContextChanged(editor: Editor) {
  contextRevisions.set(editor, (contextRevisions.get(editor) ?? 0) + 1)
  for (const listener of contextListeners.get(editor) ?? []) listener()
}

export function subscribeAssetResolver(editor: Editor | null, listener: () => void): () => void {
  converterListeners.add(listener)
  const editorListeners = editor ? (contextListeners.get(editor) ?? new Set<() => void>()) : null
  if (editor && editorListeners) {
    editorListeners.add(listener)
    contextListeners.set(editor, editorListeners)
  }
  return () => {
    converterListeners.delete(listener)
    if (editorListeners) editorListeners.delete(listener)
  }
}

export function getAssetResolverRevision(editor: Editor | null): number {
  return converterRevision + (editor ? (contextRevisions.get(editor) ?? 0) : 0)
}

export function setAssetContext(editor: Editor, ctx: AssetContext) {
  const previous = contexts.get(editor)
  contexts.set(editor, ctx)
  // NodeViews are rendered before the editor's effects run on first mount.
  // Notify only this editor's images when the context becomes available so
  // relative sources are resolved without waking hidden cached tabs.
  if (previous?.vaultPath !== ctx.vaultPath || previous.notePath !== ctx.notePath) {
    notifyContextChanged(editor)
  }
}

export function getAssetContext(editor: Editor): AssetContext | undefined {
  return contexts.get(editor)
}

function isAbsoluteUrl(src: string): boolean {
  return (
    src.startsWith("http://") ||
    src.startsWith("https://") ||
    src.startsWith("data:") ||
    src.startsWith("blob:") ||
    src.startsWith("asset://") ||
    src.startsWith("https://asset.localhost") ||
    src.startsWith("file://")
  )
}

function noteDir(notePath: string): string {
  const norm = notePath.replace(/\\/g, "/")
  const idx = norm.lastIndexOf("/")
  return idx === -1 ? "" : norm.slice(0, idx)
}

export function resolveAssetSrc(editor: Editor | null, src: string): string {
  return resolveAssetSrcCandidates(editor, src)[0] ?? src
}

/**
 * Return the URL variants that can represent a vault-relative attachment.
 * Imported assets in bundle notes are note-relative (`bundle/assets/x.png`),
 * while regular notes historically store `assets/x.png` relative to the vault.
 * Trying both keeps old notes readable without touching their Markdown.
 */
export function resolveAssetSrcCandidates(editor: Editor | null, src: string): string[] {
  if (!src) return [src]
  if (isAbsoluteUrl(src)) return [src]
  const ctx = editor ? getAssetContext(editor) : undefined
  if (!ctx || !ctx.vaultPath) return [src]
  const dir = noteDir(ctx.notePath) || ctx.vaultPath
  const sep = dir.endsWith("/") || dir.endsWith("\\") ? "" : "/"
  const abs = `${dir}${sep}${src}`
  const paths = [abs]
  const normalizedSrc = src.replace(/\\/g, "/")
  if (normalizedSrc.startsWith("assets/")) {
    const vaultSep = ctx.vaultPath.endsWith("/") || ctx.vaultPath.endsWith("\\") ? "" : "/"
    const vaultAsset = `${ctx.vaultPath}${vaultSep}${src}`
    if (vaultAsset !== abs) paths.push(vaultAsset)
  }
  if (!isTauri()) return paths
  return paths.map((path) => {
    try {
      // Synchronous to keep render simple. convertFileSrc only builds a URL.
      return convert(path)
    } catch {
      return path
    }
  })
}

/**
 * Candidates for the file named by an Obsidian embed (`![[song.mp3]]`). Amby keeps what it
 * imports in `assets/`; a bare name is looked for there and next to the note.
 */
export function resolveEmbeddedFileCandidates(editor: Editor | null, name: string): string[] {
  const addresses = /[\\/]/u.test(name) ? [name] : [name, `assets/${name}`]
  return [...new Set(addresses.flatMap((src) => resolveAssetSrcCandidates(editor, src)))]
}

/**
 * URL for an absolute path the backend already validated (for example a
 * database asset). Only meaningful in the desktop runtime; `null` elsewhere.
 */
export function assetUrlForAbsolutePath(absolutePath: string): string | null {
  if (!isTauri()) return null
  try {
    return convert(absolutePath)
  } catch {
    return null
  }
}

let cachedConvert: ((p: string) => string) | null = null

function convert(abs: string): string {
  if (cachedConvert) return cachedConvert(abs)
  // The API's converter is synchronous, but the module is loaded lazily. Use
  // the already exposed Tauri bridge for the first render when available so we
  // never briefly point an image at a guessed URL.
  const internals =
    typeof window === "undefined"
      ? undefined
      : (
          window as Window & {
            __TAURI_INTERNALS__?: {
              convertFileSrc?: (filePath: string, protocol?: string) => string
            }
          }
        ).__TAURI_INTERNALS__
  if (typeof internals?.convertFileSrc === "function") {
    return internals.convertFileSrc(abs, "asset")
  }
  // Last-resort fallback for a bridge that is still being initialised. This is
  // the URL shape used by Tauri on Unix; the converter-ready notification
  // below replaces it as soon as the bridge can provide the platform URL.
  const enc = encodeURIComponent(abs)
  return `asset://localhost/${enc}`
}

export async function primeAssetConverter() {
  if (cachedConvert || !isTauri()) return
  if (!converterPromise) {
    converterPromise = import("@tauri-apps/api/core").then(({ convertFileSrc }) => {
      cachedConvert = convertFileSrc
      notifyConverterChanged()
    })
  }
  await converterPromise
}
