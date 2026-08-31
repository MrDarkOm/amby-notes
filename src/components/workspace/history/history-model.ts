import type { SnapshotEntry } from "@/lib/storage"

export function historyReasonKey(reason: string): string {
  const reasons: Record<string, string> = {
    "note-save": "autosave",
    "file-save": "fileSave",
    restore: "beforeRestore",
    "link-refactor": "linksUpdated",
    "id-assignment": "metadataUpdated",
  }
  return `historyPanel.${reasons[reason] ?? "savedVersion"}`
}

export function formatHistorySize(bytes: number, locale: string): string {
  const unit = bytes < 1024 ? "byte" : bytes < 1024 ** 2 ? "kilobyte" : "megabyte"
  const value = bytes / (unit === "byte" ? 1 : unit === "kilobyte" ? 1024 : 1024 ** 2)
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit,
    unitDisplay: "short",
    maximumFractionDigits: unit === "byte" ? 0 : 1,
  }).format(value)
}

export function groupHistoryByDay(entries: SnapshotEntry[]) {
  const groups = new Map<string, { date: Date; entries: SnapshotEntry[] }>()
  for (const entry of [...entries].sort((a, b) => b.createdAtMs - a.createdAtMs)) {
    const date = new Date(entry.createdAtMs)
    const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
    const group = groups.get(key) ?? { date, entries: [] }
    group.entries.push(entry)
    groups.set(key, group)
  }
  return [...groups.values()]
}

export interface HistoryDiffLine {
  kind: "same" | "added" | "removed"
  text: string
  previousLine?: number
  currentLine?: number
}

export function compactHistoryDiff(lines: HistoryDiffLine[]) {
  const rows: (HistoryDiffLine | { kind: "gap"; count: number })[] = []
  let index = 0
  while (index < lines.length) {
    if (lines[index].kind !== "same") {
      rows.push(lines[index++])
      continue
    }
    let end = index
    while (end < lines.length && lines[end].kind === "same") end++
    if (end - index <= 8) rows.push(...lines.slice(index, end))
    else {
      rows.push(...lines.slice(index, index + 3))
      rows.push({ kind: "gap", count: end - index - 6 })
      rows.push(...lines.slice(end - 3, end))
    }
    index = end
  }
  return rows
}

/** Read-only line comparison; retain line endings/BOM in the source strings. */
export function diffHistory(previous: string, current: string) {
  const a = previous.match(/[^\n]*\n|[^\n]+$/g) ?? []
  const b = current.match(/[^\n]*\n|[^\n]+$/g) ?? []
  const lines: HistoryDiffLine[] = []
  let i = 0
  let j = 0
  const push = (kind: HistoryDiffLine["kind"]) => {
    lines.push({
      kind,
      text: kind === "added" ? b[j] : a[i],
      previousLine: kind === "added" ? undefined : i + 1,
      currentLine: kind === "removed" ? undefined : j + 1,
    })
    if (kind !== "added") i++
    if (kind !== "removed") j++
  }
  while (i < a.length && j < b.length && a[i] === b[j]) push("same")
  let endA = a.length
  let endB = b.length
  while (endA > i && endB > j && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const rows = endA - i
  const cols = endB - j
  // Bound both CPU and memory for very large notes. A coarse replacement still
  // represents every original byte; the UI labels it as a simplified diff.
  const simplified = rows * cols > 1_000_000
  if (simplified) {
    while (i < endA) push("removed")
    while (j < endB) push("added")
  } else {
    const startI = i
    const startJ = j
    const width = cols + 1
    const lengths = new Uint32Array((rows + 1) * width)
    for (let r = rows - 1; r >= 0; r--) {
      for (let c = cols - 1; c >= 0; c--) {
        lengths[r * width + c] =
          a[startI + r] === b[startJ + c]
            ? lengths[(r + 1) * width + c + 1] + 1
            : Math.max(lengths[(r + 1) * width + c], lengths[r * width + c + 1])
      }
    }
    while (i < endA || j < endB) {
      if (i < endA && j < endB && a[i] === b[j]) push("same")
      else if (
        j >= endB ||
        (i < endA &&
          lengths[(i - startI + 1) * width + j - startJ] >=
            lengths[(i - startI) * width + j - startJ + 1])
      )
        push("removed")
      else push("added")
    }
  }
  while (i < a.length) push("same")
  return {
    lines,
    simplified,
    added: lines.filter((line) => line.kind === "added").length,
    removed: lines.filter((line) => line.kind === "removed").length,
    identical: previous === current,
  }
}
