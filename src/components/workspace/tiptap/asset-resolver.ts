import type { Editor } from "@tiptap/core"

import { isTauri } from "@/lib/storage"

export interface AssetContext {
  vaultPath: string
  notePath: string
}

const contexts = new WeakMap<Editor, AssetContext>()

export function setAssetContext(editor: Editor, ctx: AssetContext) {
  contexts.set(editor, ctx)
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
  if (!src) return src
  if (isAbsoluteUrl(src)) return src
  const ctx = editor ? getAssetContext(editor) : undefined
  if (!ctx || !ctx.vaultPath) return src
  const dir = noteDir(ctx.notePath) || ctx.vaultPath
  const sep = dir.endsWith("/") || dir.endsWith("\\") ? "" : "/"
  const abs = `${dir}${sep}${src}`
  if (!isTauri()) return abs
  try {
    // Synchronous to keep render simple. convertFileSrc is sync — it just builds a URL.
    // We import it lazily on first use.
    return convert(abs)
  } catch {
    return abs
  }
}

let cachedConvert: ((p: string) => string) | null = null

function convert(abs: string): string {
  if (cachedConvert) return cachedConvert(abs)
  // Synchronous fallback URL for the very first render before the dynamic
  // import resolves; convertFileSrc is just URL building, so we replicate it.
  // The asset:// scheme is exposed under https://asset.localhost on macOS/Win.
  const enc = encodeURIComponent(abs)
  return `https://asset.localhost/${enc}`
}

export async function primeAssetConverter() {
  if (cachedConvert || !isTauri()) return
  const { convertFileSrc } = await import("@tauri-apps/api/core")
  cachedConvert = convertFileSrc
}
