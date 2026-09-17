import MarkdownIt from "markdown-it"

const md = new MarkdownIt({ html: false, linkify: true, breaks: true })

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

export function renderCardHtml(text: string): string {
  if (!text || !text.trim()) return ""
  let html = md.render(text)
  // [[target|alias]] → clickable wikilink
  html = html.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, target: string, alias?: string) => {
    const t = target.trim()
    const label = (alias ?? target).trim()
    return `<span class="canvas-wikilink cursor-pointer text-sky-600 dark:text-sky-400 hover:underline" data-wikilink="${escapeHtml(t)}">${escapeHtml(label)}</span>`
  })
  // #tag → styled span
  html = html.replace(
    /(^|\s)#([\p{L}\d/_-]+)/gu,
    (_m, pre: string, tag: string) =>
      `${pre}<span class="text-amber-600 dark:text-amber-400">#${escapeHtml(tag)}</span>`,
  )
  return html
}

export function pathStem(path: string): string {
  const base = path.replace(/\\/g, "/").split("/").pop() ?? path
  return base.replace(/\.[^.]+$/u, "")
}

export const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp|avif)$/i

export function extFromMime(mime: string): string {
  if (mime === "image/jpeg") return "jpg"
  if (mime.startsWith("image/")) return mime.slice(6)
  return "png"
}

export function resolveVaultFilePath(file: string, vault?: string | null): string {
  if (!file) return ""
  if (!vault) return file
  const normFile = file.replace(/\\/g, "/")
  const normVault = vault.replace(/\\/g, "/").replace(/\/+$/, "")
  if (normFile === normVault || normFile.startsWith(`${normVault}/`)) {
    return normFile
  }
  if (normFile.startsWith("/") || /^[a-zA-Z]:[/\\]/.test(normFile)) {
    return normFile
  }
  return `${normVault}/${normFile}`
}

export function toRelativeVaultPath(path: string, vault?: string | null): string {
  if (!path) return ""
  const normPath = path.replace(/\\/g, "/")
  const normVault = vault?.replace(/\\/g, "/").replace(/\/+$/, "")
  if (normVault && (normPath === normVault || normPath.startsWith(`${normVault}/`))) {
    return normPath.slice(normVault.length + 1)
  }
  return normPath
}
