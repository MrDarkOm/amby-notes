import MarkdownIt from "markdown-it"
import { wsPathStem, toRelativeVaultPath } from "../workspace-tree-utils"

const md = new MarkdownIt({ html: false, linkify: true, breaks: true })

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

/** Render basic markdown preview for note cards in Canvas and Sketches. */
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
      `${pre}<span class="inline-flex items-center px-1.5 py-0.5 rounded-md bg-accent/60 text-accent-foreground text-xs font-medium my-0.5">#${escapeHtml(tag)}</span>`,
  )
  return html
}

export const pathStem = wsPathStem

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

export { toRelativeVaultPath }
