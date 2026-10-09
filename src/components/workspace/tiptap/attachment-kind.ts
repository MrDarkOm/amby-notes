export type AttachmentKind = "audio" | "video" | "pdf"

// What an attachment is shown as is decided by its file extension alone, so a note keeps
// the plain Markdown it was written with (`![name](assets/file.mp3)`, `![[file.mp3]]`).
// Only formats the desktop webviews can play are listed; anything else stays an ordinary
// image or link rather than a player that cannot play.
const KIND_BY_EXTENSION: Record<string, AttachmentKind> = {
  mp3: "audio",
  m4a: "audio",
  wav: "audio",
  ogg: "audio",
  oga: "audio",
  opus: "audio",
  flac: "audio",
  aac: "audio",
  mp4: "video",
  m4v: "video",
  mov: "video",
  webm: "video",
  ogv: "video",
  pdf: "pdf",
}

/** The kind of attachment an address points to, or `null` when it is not one of them. */
export function attachmentKind(address: string | null | undefined): AttachmentKind | null {
  if (!address) return null
  const path = address.split(/[?#]/u, 1)[0] ?? ""
  const name = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1)
  const dot = name.lastIndexOf(".")
  if (dot < 1) return null
  return KIND_BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? null
}

/**
 * An address that is not a path inside the vault: a web address, an inline or temporary
 * one, or any other scheme (`C:\files` is a Windows path, not a scheme).
 */
export function isRemoteAddress(address: string): boolean {
  return /^[a-z][a-z0-9+.-]+:/iu.test(address) || address.startsWith("//")
}
