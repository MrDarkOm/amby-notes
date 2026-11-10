/** What the model needs of a row: the old trash gave `deletedAtMs`, the archive `archivedAtMs` (К8). */
export type ArchiveRow = { id: string; name: string; originalPath: string } & (
  { archivedAtMs: number } | { deletedAtMs: number }
)

const rowTime = (entry: ArchiveRow): number =>
  "archivedAtMs" in entry ? entry.archivedAtMs : entry.deletedAtMs

export type ArchiveGroupKey = "today" | "yesterday" | "earlier"

/** Use calendar boundaries, including days with a daylight-saving time change. */
export function groupArchiveEntries<T extends ArchiveRow>(entries: T[], now: Date) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime()
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime()
  const groups: Record<ArchiveGroupKey, T[]> = { today: [], yesterday: [], earlier: [] }
  const timestamp = (entry: T) => (Number.isFinite(rowTime(entry)) ? rowTime(entry) : -Infinity)
  for (const entry of [...entries].sort((a, b) => timestamp(b) - timestamp(a))) {
    const time = rowTime(entry)
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

export function archiveEntryLabel(entry: Pick<ArchiveRow, "name" | "originalPath">) {
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

/**
 * A path inside the service folder `.amby/` of the vault (conflict sets, property group files,
 * layout…). It is never shown in the archive (docs/sync-plan.md, И10а); the backend filters too,
 * this is the second guard for what the panel is handed. Case-insensitive like the disk.
 */
export function isServicePath(path: string): boolean {
  const first = path.replace(/\\/g, "/").replace(/^\/+/, "").split("/")[0]
  return first.toLowerCase() === ".amby"
}
