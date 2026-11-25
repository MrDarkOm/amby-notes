import * as React from "react"
import { useTranslation } from "react-i18next"
import type { TextLevelSummary, TextPageStat } from "@/lib/storage"
import { isEnterKey } from "@/lib/keyboard"
import { cn } from "@/lib/utils"
import { pageStatusDotClass, type MovePlan, type TextNode } from "../workshop/text-tree-model"
import { boardColumns, boardDropPlan } from "./board-model"

/** What a dragged card carries: its page ID. */
const BOARD_DRAG_TYPE = "application/x-amby-board-page"
/** Synopses are read a few pages at a time, so a long text does not flood the disk. */
const READ_AT_ONCE = 4

interface StoryBoardProps {
  roots: TextNode[]
  levels: TextLevelSummary[]
  statusOptions: { id: string; name: string; color: string; group: string }[]
  stats: Record<string, TextPageStat>
  /** Quiet words of a card's scene: its point of view, its story time. */
  hintsOf: (noteId: string) => string[]
  /** The first paragraph of a page (read only, never written). */
  loadSynopsis: (noteId: string) => Promise<string>
  canWrite: boolean
  onOpenNote: (noteId: string) => void
  onMovePage: (pageId: string, plan: MovePlan) => void
}

function useSynopses(cards: TextNode[], load: (noteId: string) => Promise<string>) {
  const [synopses, setSynopses] = React.useState<Record<string, string>>({})
  const read = React.useRef(new Map<string, string>())
  const key = cards.map((card) => `${card.noteId}@${card.revision}`).join("|")
  React.useEffect(() => {
    let cancelled = false
    const wanted = key
      ? key.split("|").filter((entry) => !read.current.has(entry))
      : ([] as string[])
    void (async () => {
      for (let index = 0; index < wanted.length; index += READ_AT_ONCE) {
        const batch = wanted.slice(index, index + READ_AT_ONCE)
        const results = await Promise.all(
          batch.map(async (entry) => {
            const noteId = entry.slice(0, entry.lastIndexOf("@"))
            try {
              return [entry, noteId, await load(noteId)] as const
            } catch {
              // A page that cannot be read shows no synopsis; the card itself still works.
              return [entry, noteId, ""] as const
            }
          }),
        )
        if (cancelled) return
        for (const [entry, , text] of results) read.current.set(entry, text)
        setSynopses((previous) => {
          const next = { ...previous }
          for (const [, noteId, text] of results) next[noteId] = text
          return next
        })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [key, load])
  return synopses
}

function wordsOf(node: TextNode, stats: Record<string, TextPageStat>): number {
  return (
    (stats[node.noteId]?.wordCount ?? 0) +
    node.children.reduce((total, child) => total + wordsOf(child, stats), 0)
  )
}

/**
 * The text of a story as cards: a column per part (a top page with pages inside), a card per
 * page with its first paragraph and its scene. A card opens its page; dragging it onto another
 * card puts it before that card, onto a column puts it at the column's end. A move the levels
 * forbid is refused before anything is written, and the board says why.
 */
export function StoryBoard({
  roots,
  levels,
  statusOptions,
  stats,
  hintsOf,
  loadSynopsis,
  canWrite,
  onOpenNote,
  onMovePage,
}: StoryBoardProps) {
  const { t } = useTranslation()
  const columns = React.useMemo(() => boardColumns(roots), [roots])
  const cards = React.useMemo(() => columns.flatMap((column) => column.cards), [columns])
  const synopses = useSynopses(cards, loadSynopsis)
  const [refusal, setRefusal] = React.useState<string | null>(null)
  const [over, setOver] = React.useState<string | null>(null)

  const drop = (
    event: React.DragEvent,
    target: { card: string } | { column: string | null },
    marker: string,
  ) => {
    const dragged = event.dataTransfer.getData(BOARD_DRAG_TYPE)
    if (!dragged || !canWrite) return
    event.preventDefault()
    event.stopPropagation()
    setOver((current) => (current === marker ? null : current))
    const result = boardDropPlan(roots, levels, dragged, target)
    if ("reason" in result) {
      setRefusal(t(`creative.workshop.dropRefusal.${result.reason}`))
      return
    }
    setRefusal(null)
    onMovePage(dragged, result.plan)
  }
  const allowDrop = (event: React.DragEvent, marker: string) => {
    if (!canWrite || !Array.from(event.dataTransfer.types ?? []).includes(BOARD_DRAG_TYPE)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = "move"
    setOver(marker)
  }

  if (columns.length === 0) {
    return <p className="px-1 text-xs text-muted-foreground">{t("creative.workshop.noPages")}</p>
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-3 overflow-x-auto pb-2">
        {columns.map((column) => {
          const marker = `column:${column.id ?? ""}`
          const title = column.title ?? t("creative.board.loose")
          return (
            <div
              key={column.id ?? "loose"}
              role="group"
              aria-label={title}
              onDragOver={(event) => allowDrop(event, marker)}
              onDragLeave={() => setOver((current) => (current === marker ? null : current))}
              onDrop={(event) => drop(event, { column: column.id }, marker)}
              className={cn(
                "flex w-56 shrink-0 flex-col gap-2 rounded-xl bg-muted/40 p-2",
                over === marker && "ring-1 ring-primary",
              )}
            >
              <div className="flex items-baseline justify-between gap-2 px-1">
                <span className="truncate text-xs font-medium">{title}</span>
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {column.cards.length}
                </span>
              </div>
              {column.cards.map((card) => {
                const cardMarker = `card:${card.noteId}`
                const hints = hintsOf(card.noteId)
                const synopsis = synopses[card.noteId]
                const words = wordsOf(card, stats)
                return (
                  <div
                    key={card.noteId}
                    role="button"
                    tabIndex={0}
                    data-board-card={card.noteId}
                    draggable={canWrite || undefined}
                    onDragStart={(event) => {
                      event.dataTransfer.setData(BOARD_DRAG_TYPE, card.noteId)
                      event.dataTransfer.effectAllowed = "move"
                      setRefusal(null)
                    }}
                    onDragOver={(event) => allowDrop(event, cardMarker)}
                    onDragLeave={() =>
                      setOver((current) => (current === cardMarker ? null : current))
                    }
                    onDrop={(event) => drop(event, { card: card.noteId }, cardMarker)}
                    onClick={() => onOpenNote(card.noteId)}
                    onKeyDown={(event) => {
                      if (isEnterKey(event)) onOpenNote(card.noteId)
                    }}
                    className={cn(
                      "flex cursor-pointer flex-col gap-1 rounded-lg border border-border/60 bg-background p-2 text-left outline-none hover:border-border focus-visible:ring-1 focus-visible:ring-ring",
                      over === cardMarker && "border-t-2 border-t-primary",
                    )}
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span
                        aria-hidden="true"
                        className={cn(
                          "size-2 shrink-0 rounded-full",
                          pageStatusDotClass(statusOptions, card.statusOptionId, words),
                        )}
                      />
                      <span className="truncate text-xs font-medium">{card.title}</span>
                    </span>
                    {synopsis && (
                      <span className="line-clamp-3 text-[11px] text-muted-foreground">
                        {synopsis}
                      </span>
                    )}
                    {(hints.length > 0 || card.children.length > 0 || words > 0) && (
                      <span className="flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground">
                        {hints.map((hint) => (
                          <span key={hint} className="rounded-full bg-accent px-1.5 py-px">
                            {hint}
                          </span>
                        ))}
                        {card.children.length > 0 && (
                          <span>{t("creative.board.inside", { count: card.children.length })}</span>
                        )}
                        {words > 0 && (
                          <span className="ml-auto">
                            {t("creative.board.words", { count: words })}
                          </span>
                        )}
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>
      {refusal && (
        <p role="status" className="px-1 text-xs text-muted-foreground">
          {refusal}
        </p>
      )}
    </div>
  )
}
