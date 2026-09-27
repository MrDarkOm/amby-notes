export {
  escapeHtml,
  renderCardHtml,
  pathStem,
  resolveVaultFilePath,
  toRelativeVaultPath,
} from "../common/card-markdown"

export const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp|avif)$/i

export function extFromMime(mime: string): string {
  if (mime === "image/jpeg") return "jpg"
  if (mime.startsWith("image/")) return mime.slice(6)
  return "png"
}
