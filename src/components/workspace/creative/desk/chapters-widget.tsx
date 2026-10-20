import * as React from "react"
import {
  Anchor,
  ChevronRight,
  FileText,
  Link2,
  MoreHorizontal,
  Plus,
  type LucideIcon,
} from "lucide-react"
import { ArrowDown, ArrowUp, IndentDecrease, IndentIncrease } from "lucide-react"
import { useTranslation } from "react-i18next"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { DatabaseRow, TextLevelSummary, TextPageStat } from "@/lib/storage"
import { cn } from "@/lib/utils"
import { IconValue } from "../../icon-value"
import { useCreativeNavStore } from "../creative-nav-store"
import { projectErrorText } from "../project-error"
import { PageMarksView } from "../workshop/page-marks"
import {
  PLOT_DRAG_TYPE,
  decodePlotDrag,
  encodePlotDrag,
  pageMarks,
  type PageBinding,
  type PlotKind,
} from "../workshop/plot-model"
import { InlineCreateRow } from "../workshop/inline-create-row"
import { QuickCreate } from "../workshop/quick-create"
import {
  canHaveChildPage,
  pageMoves,
  pageStatusDotClass,
  resolvePageStatus,
  startLevelId,
  type ArrangeKey,
  type MovePlan,
  type TextNode,
} from "../workshop/text-tree-model"
import type { PlotBinding } from "../workshop/use-plot-binding"

const MOVE_ITEMS: Array<{ key: ArrangeKey; icon: LucideIcon }> = [
  { key: "up", icon: ArrowUp },
  { key: "down", icon: ArrowDown },
  { key: "indent", icon: IndentIncrease },
  { key: "outdent", icon: IndentDecrease },
]

interface ChaptersWidgetProps {
  roots: TextNode[]
  levels: TextLevelSummary[]
  statusOptions: { id: string; name: string; color: string; group: string }[]
  stats: Record<string, TextPageStat>
  /** The text's pages in tree order, for the menu that binds an anchor to a page. */
  pageOrder: readonly string[]
  pageTitleOf: (noteId: string) => string
  bindings: ReadonlyMap<string, PageBinding>
  plotTitleOf: (kind: PlotKind, id: string) => string | undefined
  /** The story's anchors bound to no page of its text, in the author's order. */
  ahead: readonly DatabaseRow[]
  /** The workshop has an anchors base: the "Ahead" strip is shown. */
  hasAnchors: boolean
  binding: PlotBinding | null
  canWrite: boolean
  onOpenNote: (noteId: string) => void
  /** Makes a page under `parent` (the top of the text for `null`), named by the author. */
  onCreatePage: (parent: TextNode | null, title: string) => Promise<void>
  onMovePage: (pageId: string, plan: MovePlan) => void
  /** Makes an anchor of the story; `null` where one cannot be made. */
  onCreateAnchor: ((title: string) => Promise<void>) | null
  /** The failure of the last move or status change. */
  moveError: string | null
  loading: boolean
}

function wordsOf(node: TextNode, stats: Record<string, TextPageStat>): number {
  return (
    (stats[node.noteId]?.wordCount ?? 0) +
    node.children.reduce((total, child) => total + wordsOf(child, stats), 0)
  )
}

/**
 * The story's text as an outline: a status dot, the page's name, its anchors and arcs, its words.
 * A page opens on a click; its menu moves it (the panel's own moves, `pageMoves`) or makes a page
 * inside it. Under the list stand the anchors that no page holds yet, "Ahead": drag one onto a
 * page, or use its menu, to bind it.
 */
export function ChaptersWidget({
  roots,
  levels,
  statusOptions,
  stats,
  pageOrder,
  pageTitleOf,
  bindings,
  plotTitleOf,
  ahead,
  hasAnchors,
  binding,
  canWrite,
  onOpenNote,
  onCreatePage,
  onMovePage,
  onCreateAnchor,
  moveError,
  loading,
}: ChaptersWidgetProps) {
  const { t } = useTranslation()
  const collapsed = useCreativeNavStore((state) => state.collapsed)
  const toggle = useCreativeNavStore((state) => state.toggleCollapsed)
  const [draft, setDraft] = React.useState<{ parentId: string | null } | null>(null)
  const [over, setOver] = React.useState<string | null>(null)

  const firstLevelId = startLevelId(levels, null)
  const firstLevelName = levels.find((level) => level.id === firstLevelId)?.name ?? null
  const canBind = canWrite && binding !== null

  const draftRow = (parent: TextNode | null, depth: number) => (
    <InlineCreateRow
      depth={depth}
      icon={<FileText className="size-3.5" />}
      placeholder={t("creative.workshop.newPagePlaceholder")}
      onSubmit={async (title) => {
        await onCreatePage(parent, title)
        setDraft(null)
      }}
      onCancel={() => setDraft(null)}
    />
  )

  const renderRows = (nodes: TextNode[], depth: number): React.ReactNode =>
    nodes.map((node) => {
      const open = !collapsed[`page:${node.noteId}`]
      const level = levels.find((entry) => entry.id === node.levelId)
      const words = wordsOf(node, stats)
      const status = resolvePageStatus(statusOptions, node.statusOptionId)
      const marks = pageMarks(bindings.get(node.noteId), plotTitleOf)
      const moves = pageMoves(roots, levels, node.noteId)
      const canNest = canWrite && canHaveChildPage(levels, node)
      return (
        <React.Fragment key={node.noteId}>
          <div
            data-text-page={node.noteId}
            onDragOver={(event) => {
              if (!canBind || !Array.from(event.dataTransfer.types ?? []).includes(PLOT_DRAG_TYPE))
                return
              event.preventDefault()
              event.dataTransfer.dropEffect = "link"
              setOver(node.noteId)
            }}
            onDragLeave={() => setOver((current) => (current === node.noteId ? null : current))}
            onDrop={(event) => {
              setOver(null)
              const drag = decodePlotDrag(event.dataTransfer.getData(PLOT_DRAG_TYPE))
              if (!drag || !binding) return
              event.preventDefault()
              void binding.bind(node.noteId, drag.kind, drag.id)
            }}
            className={cn(
              "group flex min-h-9 items-center gap-2 rounded-lg pr-1 hover:bg-accent/50",
              over === node.noteId && "bg-primary/10 ring-1 ring-primary",
            )}
            style={{ paddingLeft: 4 + depth * 18 }}
          >
            {node.children.length > 0 ? (
              <button
                type="button"
                aria-label={open ? t("creative.panel.collapse") : t("creative.panel.expand")}
                aria-expanded={open}
                onClick={() => toggle(`page:${node.noteId}`)}
                className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
              >
                <ChevronRight className={cn("size-3.5", open && "rotate-90")} />
              </button>
            ) : (
              <span className="size-5 shrink-0" aria-hidden="true" />
            )}
            <span
              role="img"
              aria-label={status?.name ?? t("creative.desk.noStatus")}
              title={status?.name}
              className={cn(
                "size-2.5 shrink-0 rounded-full",
                pageStatusDotClass(statusOptions, node.statusOptionId, words),
              )}
            />
            <span
              aria-hidden="true"
              title={level?.name ?? undefined}
              className="flex size-4 shrink-0 items-center justify-center text-muted-foreground"
            >
              <IconValue
                value={level?.icon ?? undefined}
                fallback={<FileText className="size-3.5" />}
                className="size-4"
              />
            </span>
            <button
              type="button"
              onClick={() => onOpenNote(node.noteId)}
              className="min-w-0 flex-1 break-words py-1.5 text-left text-sm font-medium outline-none focus-visible:underline"
            >
              {node.title}
            </button>
            {marks && <PageMarksView marks={marks} />}
            <span
              className={cn(
                "min-w-10 shrink-0 text-right text-xs tabular-nums text-muted-foreground",
                words === 0 && "opacity-60",
              )}
              title={t("docEditor.wordCount", { count: words })}
            >
              {words.toLocaleString()}
            </span>
            {canWrite && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label={t("creative.desk.pageActions", { name: node.title })}
                    className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <MoreHorizontal className="size-4" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-60">
                  {MOVE_ITEMS.map(({ key, icon: Icon }) => (
                    <DropdownMenuItem
                      key={key}
                      disabled={moves[key] === null}
                      className="gap-2 text-[13px]"
                      onSelect={() => {
                        const plan = moves[key]
                        if (plan) onMovePage(node.noteId, plan)
                      }}
                    >
                      <Icon className="size-3.5 text-muted-foreground" />
                      {t(`creative.arrange.${key}`)}
                    </DropdownMenuItem>
                  ))}
                  {canNest && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        className="gap-2 text-[13px]"
                        onSelect={() => setDraft({ parentId: node.noteId })}
                      >
                        <Plus className="size-3.5 text-muted-foreground" />
                        {t("creative.workshop.addChildPage")}
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
          {open && (node.children.length > 0 || draft?.parentId === node.noteId) && (
            <>
              {renderRows(node.children, depth + 1)}
              {draft?.parentId === node.noteId && draftRow(node, depth + 1)}
            </>
          )}
        </React.Fragment>
      )
    })

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        {roots.length === 0 && (
          <p className="text-sm text-muted-foreground">
            {loading ? "" : t("creative.workshop.noPages")}
          </p>
        )}
        {renderRows(roots, 0)}
        {draft?.parentId === null && draftRow(null, 0)}
        {canWrite && firstLevelName && draft === null && (
          <button
            type="button"
            onClick={() => setDraft({ parentId: null })}
            className="mt-1 inline-flex min-h-8 w-fit items-center gap-1.5 rounded-md px-2 text-[13px] text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
          >
            <Plus className="size-3.5" />
            {firstLevelName}
          </button>
        )}
      </div>
      {moveError && (
        <p role="alert" className="break-words text-xs text-destructive">
          {moveError}
        </p>
      )}
      {hasAnchors && (
        <div className="flex flex-col gap-2 rounded-xl bg-accent/40 px-3 py-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold text-muted-foreground">
              {t("creative.plot.ahead")}
            </span>
            {ahead.map((anchor) => (
              <span
                key={anchor.noteId}
                draggable={canBind}
                onDragStart={(event) => {
                  event.dataTransfer.setData(
                    PLOT_DRAG_TYPE,
                    encodePlotDrag({ kind: "anchor", id: anchor.noteId }),
                  )
                  event.dataTransfer.effectAllowed = "link"
                }}
                className="inline-flex max-w-full items-center rounded-lg border border-border bg-background text-[13px]"
              >
                <button
                  type="button"
                  onClick={() => onOpenNote(anchor.noteId)}
                  className="inline-flex min-h-7 min-w-0 items-center gap-1.5 rounded-l-lg px-2.5 outline-none hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring"
                >
                  <Anchor aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 truncate">{anchor.title}</span>
                </button>
                {canBind && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        aria-label={t("creative.desk.bindTo", { name: anchor.title })}
                        title={t("creative.desk.bindTo", { name: anchor.title })}
                        className="flex size-7 shrink-0 items-center justify-center rounded-r-lg text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
                      >
                        <Link2 className="size-3.5" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="max-h-72 w-60 overflow-y-auto">
                      {pageOrder.map((pageId) => (
                        <DropdownMenuItem
                          key={pageId}
                          className="text-[13px]"
                          onSelect={() => void binding?.bind(pageId, "anchor", anchor.noteId)}
                        >
                          {pageTitleOf(pageId)}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </span>
            ))}
            {ahead.length === 0 && !loading && (
              <span className="text-xs text-muted-foreground">{t("creative.desk.aheadEmpty")}</span>
            )}
            {onCreateAnchor && (
              <QuickCreate
                label={t("creative.plot.ribbon.create")}
                placeholder={t("creative.plot.ribbon.creating")}
                failed={(message) => t("creative.plot.ribbon.failed", { message })}
                onCreate={onCreateAnchor}
                describe={(caught) => projectErrorText(t, caught)}
              />
            )}
          </div>
          {ahead.length > 0 && canBind && (
            <p className="text-xs text-muted-foreground">{t("creative.desk.aheadHint")}</p>
          )}
          {binding?.error && (
            <p role="alert" className="break-words text-xs text-destructive">
              {binding.error.message}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
