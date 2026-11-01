import type { TrashEntry } from "@/lib/storage"

export type ArchiveGroupKey = "today" | "yesterday" | "earlier"

/** Use calendar boundaries, including days with a daylight-saving time change. */
export function groupArchiveEntries(entries: TrashEntry[], now: Date) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime()
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime()
  const groups: Record<ArchiveGroupKey, TrashEntry[]> = { today: [], yesterday: [], earlier: [] }
  const timestamp = (entry: TrashEntry) =>
    Number.isFinite(entry.deletedAtMs) ? entry.deletedAtMs : -Infinity
  for (const entry of [...entries].sort((a, b) => timestamp(b) - timestamp(a))) {
    const time = entry.deletedAtMs
    const key =
      time >= today && time < tomorrow
        ? "today"
        : time >= yesterday && time < today
          ? "yesterday"
          : "earlier"
    groups[key].push(entry)
  }
  return (Object.keys(groups) as ArchiveGroupKey[])
    .filter((key) => groups[key].length > 0)
    .map((key) => ({ key, entries: groups[key] }))
}

export function archiveEntryLabel(entry: TrashEntry) {
  const path = entry.originalPath.replace(/\\/g, "/").replace(/\/+$/, "")
  const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ""
  const title = entry.name.replace(/\.(md|canvas|excalidraw)$/i, "") || entry.name
  const extension = /\.([^.]+)$/u.exec(entry.name)?.[1].toLowerCase()
  const icon =
    extension === "md"
      ? "file"
      : extension === "canvas"
        ? "canvas"
        : extension === "excalidraw"
          ? "sketch"
          : null
  return { title, parent: parent.split("/").filter(Boolean).join(" / "), icon }
}
