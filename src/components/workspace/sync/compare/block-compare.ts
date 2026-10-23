import { inspectMarkdownCompatibility } from "../../editor/note-editing-policy"
import { parseMarkdown } from "../../tiptap/markdown-block-source"

// The comparison of a sync conflict in Live mode (docs/sync-plan.md, stage Э4б, К4).
//
// The result is put together from the SOURCE TEXT of the blocks the person chose, as Live Preview
// keeps it (`markdownBlockSource`, and `markdownItemSource` for the items of a list), never written
// again from the drawing. A note is cut into units that tile its text exactly: the whitespace in
// front of a unit, then its source; the same cut is made of both versions, the units are lined up
// by their source, and what does not line up is a difference with a choice. Anything the cut cannot
// tile exactly, or that mixes line endings, is chosen as a whole instead.

export type CompareChoice = "mine" | "other" | "both"

/** One difference: the units each side has between two stretches they share. */
export interface CompareHunk {
  id: number
  /** The properties envelope, or blocks of the text. */
  kind: "blocks" | "properties"
  /** The source of the units of my version (empty when only the other version has something here). */
  mine: string[]
  /** The source of the units of the other version. */
  other: string[]
  /** Whether “both” makes sense; two properties envelopes cannot be put together. */
  bothAllowed: boolean
  /** Only my side can be chosen (a different identity of the note must never be taken over). */
  locked: boolean
}

export type CompareRow = { kind: "same"; blocks: string[] } | { kind: "hunk"; hunk: CompareHunk }

interface Unit {
  /** The whitespace in front of the source. */
  lead: string
  source: string
  /** The unit is an item of a list. */
  item: boolean
}

interface Side {
  bom: string
  eol: "\n" | "\r\n"
  /** The properties envelope, LF only; empty without one. */
  front: string
  units: Unit[]
  /** What follows the last unit. */
  post: string
  /** Whether Live Preview takes this version. */
  live: boolean
}

interface Piece {
  side: "mine" | "other"
  unit: Unit
}

type ComparedRow =
  { kind: "same"; units: Unit[] } | { kind: "hunk"; hunk: CompareHunk; mine: Unit[]; other: Unit[] }

export interface BlockCompare {
  kind: "blocks"
  /** False when a version does not pass the admission of Live Preview: the window shows the source. */
  live: boolean
  hunks: CompareHunk[]
  rows: CompareRow[]
  /** What `assembleCompare` needs; not for the window. */
  readonly detail: { mine: Side; other: Side; rows: ComparedRow[] }
}

export interface WholeCompare {
  kind: "whole"
  reason: "not-markdown" | "not-text" | "line-endings" | "frontmatter" | "untileable"
}

export type ComparePlan = BlockCompare | WholeCompare

const MARKDOWN_PATH = /\.(?:md|markdown)$/iu
const BLANK = /^[ \t\n]*$/u
const FRONT = /^---\n(?:[\s\S]*?\n)?(?:---|\.\.\.)[ \t]*(?:\n|$)/u
/** More than this many pairs of units are not lined up by the table below. */
const LINE_UP_LIMIT = 16_000_000

/** Whether the comparison by blocks is meant for this file; the rest is chosen as a whole. */
export function isBlockComparable(path: string): boolean {
  return MARKDOWN_PATH.test(path)
}

/**
 * Cuts the text of a block list into the units of its items, tiling the source exactly; `null`
 * when the items are not there or do not tile.
 */
function itemUnits(list: { source: string; items: string[] }): Unit[] | null {
  const parts = tile(list.source, list.items, true)
  return parts && parts.post === "" ? parts.units : null
}

/**
 * Cuts `text` by `sources` (found in order) into units; the text between two sources that is
 * not blank becomes a unit of its own, so nothing is hidden in the whitespace.
 */
function tile(
  text: string,
  sources: string[],
  item = false,
): { units: Unit[]; post: string } | null {
  const units: Unit[] = []
  let pending = ""
  let cursor = 0
  const gap = (between: string) => {
    if (BLANK.test(between)) {
      pending += between
      return
    }
    const match = /^([ \t\n]*)([\s\S]*?)([ \t\n]*)$/u.exec(between)
    if (!match) return
    units.push({ lead: pending + match[1], source: match[2], item: false })
    pending = match[3]
  }
  for (const source of sources) {
    const index = text.indexOf(source, cursor)
    if (index < 0) return null
    gap(text.slice(cursor, index))
    units.push({ lead: pending, source, item })
    pending = ""
    cursor = index + source.length
  }
  gap(text.slice(cursor))
  return { units, post: pending }
}

function parseSide(text: string): Side | WholeCompare {
  const bom = text.startsWith("﻿") ? "﻿" : ""
  const rest = text.slice(bom.length)
  const crlf = rest.includes("\r\n")
  const loneLf = /(?:^|[^\r])\n/u.test(rest)
  if (/\r(?!\n)/u.test(rest) || (crlf && loneLf)) return { kind: "whole", reason: "line-endings" }
  const normalized = crlf ? rest.replace(/\r\n/gu, "\n") : rest

  const front = FRONT.exec(normalized)?.[0] ?? ""
  if (!front && /^---[ \t]*(?:\n|$)/u.test(normalized) && normalized.includes("\n"))
    return { kind: "whole", reason: "frontmatter" }
  const body = normalized.slice(front.length)

  let doc
  try {
    doc = parseMarkdown(body)
  } catch {
    return { kind: "whole", reason: "untileable" }
  }
  const sources: string[] = []
  const itemsOf: Array<string[] | null> = []
  doc.forEach((child) => {
    const source = child.attrs.markdownBlockSource
    if (typeof source !== "string" || source === "") return
    sources.push(source)
    const items: string[] = []
    if (child.type.name.endsWith("List")) {
      child.forEach((entry) => {
        if (typeof entry.attrs.markdownItemSource === "string")
          items.push(entry.attrs.markdownItemSource)
      })
    }
    itemsOf.push(items.length === child.childCount && items.length > 0 ? items : null)
  })
  const tiled = tile(body, sources)
  if (!tiled) return { kind: "whole", reason: "untileable" }

  // A list is cut further into its items. The units of the tile that are blocks come in the order of
  // `sources`; the residue units (text the editor does not keep as a block) are skipped over.
  const units: Unit[] = []
  let block = 0
  for (const unit of tiled.units) {
    if (sources[block] !== unit.source) {
      units.push(unit)
      continue
    }
    const items = itemsOf[block]
    block += 1
    const cut = items ? itemUnits({ source: unit.source, items }) : null
    if (cut && cut.length > 0) {
      cut[0] = { ...cut[0]!, lead: unit.lead + cut[0]!.lead }
      units.push(...cut)
    } else units.push(unit)
  }
  if (units.map((unit) => unit.lead + unit.source).join("") + tiled.post !== body)
    return { kind: "whole", reason: "untileable" }

  const eol = crlf ? "\r\n" : "\n"
  return {
    bom,
    eol,
    front,
    units,
    post: tiled.post,
    live: inspectMarkdownCompatibility(body, text).ok,
  }
}

type Operation =
  | { kind: "equal"; a: number; b: number }
  | { kind: "delete"; a: number }
  | { kind: "insert"; b: number }

/** Lines up two lists of strings by their longest common subsequence. */
function lineUp(a: string[], b: string[]): Operation[] | null {
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1
    endB -= 1
  }
  const width = endB - start
  const height = endA - start
  if (width * height > LINE_UP_LIMIT) return null
  // lengths[i][j]: the common subsequence of a[start+i..] and b[start+j..]
  const lengths: Uint32Array[] = []
  for (let i = 0; i <= height; i += 1) lengths.push(new Uint32Array(width + 1))
  for (let i = height - 1; i >= 0; i -= 1) {
    for (let j = width - 1; j >= 0; j -= 1) {
      lengths[i]![j] =
        a[start + i] === b[start + j]
          ? lengths[i + 1]![j + 1]! + 1
          : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!)
    }
  }
  const operations: Operation[] = []
  for (let i = 0; i < start; i += 1) operations.push({ kind: "equal", a: i, b: i })
  let i = 0
  let j = 0
  while (i < height || j < width) {
    if (i < height && j < width && a[start + i] === b[start + j]) {
      operations.push({ kind: "equal", a: start + i, b: start + j })
      i += 1
      j += 1
    } else if (j < width && (i === height || lengths[i]![j + 1]! >= lengths[i + 1]![j]!)) {
      operations.push({ kind: "insert", b: start + j })
      j += 1
    } else {
      operations.push({ kind: "delete", a: start + i })
      i += 1
    }
  }
  for (let k = 0; k < a.length - endA; k += 1)
    operations.push({ kind: "equal", a: endA + k, b: endB + k })
  return operations
}

const identity = (envelope: string) => /^amby-id:[ \t]*(\S+)/mu.exec(envelope)?.[1] ?? null

/**
 * Lines up the two versions of a file and finds what differs. A file that is not a note, or that
 * the cut cannot tile exactly, comes back as `whole`: the person chooses a version of it.
 */
export function planBlockCompare(
  path: string,
  mineText: string | null,
  otherText: string | null,
): ComparePlan {
  if (!isBlockComparable(path)) return { kind: "whole", reason: "not-markdown" }
  if (mineText === null || otherText === null) return { kind: "whole", reason: "not-text" }
  const mine = parseSide(mineText)
  if ("kind" in mine) return mine
  const other = parseSide(otherText)
  if ("kind" in other) return other

  const operations = lineUp(
    mine.units.map((unit) => unit.source),
    other.units.map((unit) => unit.source),
  )
  if (!operations) return { kind: "whole", reason: "untileable" }

  const hunks: CompareHunk[] = []
  const rows: CompareRow[] = []
  const compared: ComparedRow[] = []
  const addHunk = (
    kind: CompareHunk["kind"],
    mineUnits: Unit[],
    otherUnits: Unit[],
    locked: boolean,
  ) => {
    const hunk: CompareHunk = {
      id: hunks.length,
      kind,
      mine: mineUnits.map((unit) => unit.source),
      other: otherUnits.map((unit) => unit.source),
      bothAllowed: kind === "blocks",
      locked,
    }
    hunks.push(hunk)
    rows.push({ kind: "hunk", hunk })
    compared.push({ kind: "hunk", hunk, mine: mineUnits, other: otherUnits })
  }

  if (mine.front !== other.front) {
    const ids = [identity(mine.front), identity(other.front)]
    const envelope = (text: string): Unit[] =>
      text ? [{ lead: "", source: text, item: false }] : []
    addHunk("properties", envelope(mine.front), envelope(other.front), ids[0] !== ids[1])
  }

  let same: Unit[] = []
  const flushSame = () => {
    if (same.length === 0) return
    rows.push({ kind: "same", blocks: same.map((unit) => unit.source) })
    compared.push({ kind: "same", units: same })
    same = []
  }
  let removed: Unit[] = []
  let added: Unit[] = []
  const flushHunk = () => {
    if (removed.length === 0 && added.length === 0) return
    flushSame()
    // As many blocks changed as were there: each is a replacement of its own, to be chosen on its own.
    if (removed.length === added.length) {
      removed.forEach((unit, index) => addHunk("blocks", [unit], [added[index]!], false))
    } else addHunk("blocks", removed, added, false)
    removed = []
    added = []
  }
  for (const operation of operations) {
    if (operation.kind === "equal") {
      flushHunk()
      same.push(mine.units[operation.a]!)
    } else if (operation.kind === "delete") removed.push(mine.units[operation.a]!)
    else added.push(other.units[operation.b]!)
  }
  flushHunk()
  flushSame()

  return {
    kind: "blocks",
    live: mine.live && other.live,
    hunks,
    rows,
    detail: { mine, other, rows: compared },
  }
}

/**
 * The text of the result: the units each choice names, with the whitespace they had, in the line
 * endings and with the BOM of my file. Whitespace between units that both versions share comes from
 * mine. A unit that joins one of the other side gets a line break when it would have none.
 */
export function assembleCompare(plan: BlockCompare, choices: CompareChoice[]): string {
  const { mine, other, rows } = plan.detail
  const pieces: Piece[] = []
  let front = mine.front
  let frontFrom: "mine" | "other" = "mine"
  for (const row of rows) {
    if (row.kind === "same") {
      for (const unit of row.units) pieces.push({ side: "mine", unit })
      continue
    }
    const choice = row.hunk.locked ? "mine" : (choices[row.hunk.id] ?? "mine")
    if (row.hunk.kind === "properties") {
      if (choice === "other") {
        front = other.front
        frontFrom = "other"
      }
      continue
    }
    if (choice !== "other") for (const unit of row.mine) pieces.push({ side: "mine", unit })
    if (choice !== "mine") for (const unit of row.other) pieces.push({ side: "other", unit })
  }

  let body = ""
  let previous: Piece | null = null
  for (const piece of pieces) {
    let lead = piece.unit.lead
    if (previous && previous.side !== piece.side && !lead.includes("\n"))
      lead = previous.unit.item && piece.unit.item ? "\n" : "\n\n"
    body += lead + piece.unit.source
    previous = piece
  }
  const last = previous?.side ?? frontFrom
  const post = (last === "other" ? other : mine).post
  return `${mine.bom}${(front + body + post).replace(/\n/gu, mine.eol)}`
}
