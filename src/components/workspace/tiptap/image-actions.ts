/**
 * Actions on a picture in a note: its bytes are read back from the image element that shows
 * it (the page may not `fetch` the desktop asset protocol, but a CORS-enabled image can be
 * drawn on a canvas), so they work for vault files, web addresses and inline data alike.
 */

import type { CropRect } from "./image-crop"

export type ImageFormat = "png" | "jpeg"

/** The format a picture is saved in: JPEG stays JPEG, anything else is written as PNG. */
export function imageSaveFormat(address: string): ImageFormat {
  const path = address.split(/[?#]/u, 1)[0] ?? ""
  return /\.jpe?g$/iu.test(path) || /^data:image\/jpe?g/iu.test(address) ? "jpeg" : "png"
}

/** A file name for a saved picture: the picture's own name, with the extension it is saved in. */
export function imageSaveName(address: string, format: ImageFormat): string {
  const path = decodeURIComponent((address.split(/[?#]/u, 1)[0] ?? "").replace(/^data:.*/u, ""))
  const base = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1)
  const stem = base.replace(/\.[^.]*$/u, "").replace(/[/\\?%*:|"<>]/gu, "-") || "image"
  return `${stem}.${format === "jpeg" ? "jpg" : "png"}`
}

/** The picture at an address as a file of the given format, or a part of it. */
export async function imageSourceBlob(
  source: string,
  format: ImageFormat,
  /** The part to keep, in the picture's own pixels; the whole picture when absent. */
  crop?: CropRect,
  /** Keep only the ellipse inside that part; what is outside it is transparent (PNG). */
  circle = false,
): Promise<Blob> {
  // Load the address again with CORS, so that the canvas is not tainted.
  const copy = new Image()
  copy.crossOrigin = "anonymous"
  await new Promise<void>((resolve, reject) => {
    copy.onload = () => resolve()
    copy.onerror = () => reject(new Error("The picture could not be read"))
    copy.src = source
  })
  const part = crop ?? { x: 0, y: 0, width: copy.naturalWidth, height: copy.naturalHeight }
  const canvas = document.createElement("canvas")
  canvas.width = part.width
  canvas.height = part.height
  const context = canvas.getContext("2d")
  if (!context) throw new Error("The picture could not be read")
  if (format === "jpeg") {
    context.fillStyle = "white"
    context.fillRect(0, 0, canvas.width, canvas.height)
  }
  if (circle) {
    context.beginPath()
    context.ellipse(
      part.width / 2,
      part.height / 2,
      part.width / 2,
      part.height / 2,
      0,
      0,
      Math.PI * 2,
    )
    context.clip()
  }
  context.drawImage(copy, part.x, part.y, part.width, part.height, 0, 0, part.width, part.height)
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("The picture could not be read"))),
      format === "jpeg" ? "image/jpeg" : "image/png",
      0.95,
    )
  })
}

/** The picture shown by an image element, as a file of the given format. */
export function imageElementBlob(image: HTMLImageElement, format: ImageFormat): Promise<Blob> {
  return imageSourceBlob(image.currentSrc || image.src, format)
}

/** Puts the picture on the clipboard (always as PNG, the one image type every app takes). */
export async function copyImageToClipboard(image: HTMLImageElement): Promise<void> {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
    throw new Error("The clipboard does not take pictures")
  }
  // Safari only accepts the promise form, which keeps the write inside the user's click.
  await navigator.clipboard.write([
    new ClipboardItem({ "image/png": imageElementBlob(image, "png") }),
  ])
}

/** Hands the picture to the user as a file download. */
export function saveBlobAs(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = name
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Whether a picture's address is a file of the vault (not a web or inline address). */
export function isVaultImage(address: string): boolean {
  return Boolean(address) && !/^[a-z][a-z0-9+.-]+:/iu.test(address) && !address.startsWith("//")
}

/** The bytes of a Blob, for the backend. */
export async function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer())
}
