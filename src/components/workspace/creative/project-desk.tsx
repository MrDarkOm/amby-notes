import * as React from "react"
import { Database, FileText, NotebookPen, Play } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import {
  exportTextFile,
  readNote,
  type DatabaseRow,
  type ProjectSectionSummary,
  type ProjectSummary,
  type TextPageStat,
} from "@/lib/storage"
import { compileManuscript, ManuscriptReadError } from "@/lib/storage/manuscript-compiler"
import { cn } from "@/lib/utils"
import { IconValue } from "../icon-value"
import { useDatabaseStore } from "../database/database-store"
import { resolveGalleryPreview } from "../database/layouts/gallery-preview"
import { formatModified } from "../workspace-tree-utils"
import { useCreativeNavStore } from "./creative-nav-store"
import { useProjectStore } from "./project-store"
import { sectionRoleIcon } from "./section-icons"
import { useTextStats } from "./use-text-stats"
import { PortraitDot } from "./workshop/portrait-dot"
import { useDatabaseRows } from "./workshop/use-database-rows"
import { usePortraitResolvers } from "./workshop/use-portrait-resolvers"
import {
  buildTextTree,
  countNodes,
  pageStatusDotClass,
  resolvePageStatus,
  type TextNode,
} from "./workshop/text-tree-model"
import { initialsOf } from "./workshop/workshop-model"

const CONTINUE_COUNT = 3
/** How many pages of a section its card lists before "all". */
const CARD_ITEMS = 6

interface ProjectDeskProps {
  project: ProjectSummary
  /** Needed to read the pages for the manuscript; without it the button is not offered. */
  vaultPath: string | null
  onOpenNote: (noteId: string) => void
  /** Opens a section as a table: the story's own, or a shared one of its universe. */
  onOpenSection?: (projectId: string, sectionId: string) => void
}

/** A section shown as a card of the desk, with the project whose folder holds it. */
interface DeskSection {
  owner: ProjectSummary
  section: ProjectSectionSummary
}

interface PartProgress {
  node: TextNode
  pages: number
  words: number
}

function wordsOf(node: TextNode, stats: Record<string, TextPageStat>): number {
  return (
    (stats[node.noteId]?.wordCount ?? 0) +
    node.children.reduce((total, child) => total + wordsOf(child, stats), 0)
  )
}

function flatten(nodes: TextNode[]): TextNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children)])
}

/** A file name the platforms accept: what a folder name may not hold is left out. */
function fileNameOf(name: string): string {
  const forbidden = '\\/:*?"<>|'
  const cleaned = Array.from(name, (char) =>
    char.charCodeAt(0) < 32 || forbidden.includes(char) ? " " : char,
  )
    .join("")
    .replace(/\s+/gu, " ")
    .trim()
  return `${cleaned || "manuscript"}.md`
}

type Compile =
  | { status: "idle" }
  | { status: "working" }
  | { status: "done"; pages: number; path: string }
  | { status: "failed"; message: string }

function sectionTitle(section: ProjectSectionSummary): string {
  return section.databaseName?.trim() || section.pathHint.split("/").pop() || section.id
}

/**
 * A story's desk: where to continue, the numbers of the work, the outline of the text and the
 * world beside it, and the manuscript. All of it is read from the databases and the note index;
 * nothing is kept apart, and compiling the manuscript only reads the pages.
 */
export function ProjectDesk({ project, vaultPath, onOpenNote, onOpenSection }: ProjectDeskProps) {
  const { t } = useTranslation()
  const text = project.text
  const databaseId = text?.databaseId ?? null
  const dataNonce = useCreativeNavStore((state) => state.dataNonce)
  const catalog = useProjectStore((state) => state.catalog)
  const vaultGeneration = useDatabaseStore((state) => state.vaultGeneration)
  const resolverFor = usePortraitResolvers(vaultGeneration)
  // The cards beside the text: the story's own sections, then the shared ones of its universe.
  const cards = React.useMemo<DeskSection[]>(() => {
    const collection = project.collectionId
      ? (catalog?.projects.find((entry) => entry.projectId === project.collectionId) ?? null)
      : null
    return [project, ...(collection ? [collection] : [])].flatMap((owner) =>
      owner.sections
        .filter((section) => section.state !== "missing" && section.role !== "text")
        .map((section) => ({ owner, section })),
    )
  }, [catalog, project])
  const databaseIds = React.useMemo(
    () => [...(databaseId ? [databaseId] : []), ...cards.map((card) => card.section.databaseId)],
    [cards, databaseId],
  )
  const data = useDatabaseRows(databaseIds, dataNonce)
  const stats = useTextStats(databaseId, dataNonce)
  const [compile, setCompile] = React.useState<Compile>({ status: "idle" })

  const rows: DatabaseRow[] | undefined = databaseId ? data.rows[databaseId] : undefined
  const roots = React.useMemo(
    () => (text && rows ? buildTextTree(rows, text.properties) : []),
    [text, rows],
  )
  const all = React.useMemo(() => flatten(roots), [roots])
  const totalWords = React.useMemo(
    () => roots.reduce((total, node) => total + wordsOf(node, stats), 0),
    [roots, stats],
  )
  const parts = React.useMemo<PartProgress[]>(
    () =>
      roots.map((node) => ({
        node,
        pages: countNodes([node]),
        words: wordsOf(node, stats),
      })),
    [roots, stats],
  )
  const widest = Math.max(1, ...parts.map((part) => part.words))
  const recent = React.useMemo(
    () =>
      all
        .filter((node) => (stats[node.noteId]?.modified ?? 0) > 0)
        .sort((a, b) => (stats[b.noteId]?.modified ?? 0) - (stats[a.noteId]?.modified ?? 0))
        .slice(0, CONTINUE_COUNT),
    [all, stats],
  )
  const levelOf = (node: TextNode) => text?.levels.find((level) => level.id === node.levelId)

  const assemble = async () => {
    if (!vaultPath || compile.status === "working") return
    setCompile({ status: "working" })
    try {
      const result = await compileManuscript({
        roots,
        title: project.name,
        readNoteContent: async (noteId) => (await readNote(vaultPath, noteId)).content,
      })
      if (result.pages === 0) {
        setCompile({ status: "failed", message: t("creative.page.desk.noPages") })
        return
      }
      const path = await exportTextFile(result.markdown, fileNameOf(project.name))
      // No path: the author closed the save dialog, which is not a failure.
      setCompile(path ? { status: "done", pages: result.pages, path } : { status: "idle" })
    } catch (error) {
      const message =
        error instanceof ManuscriptReadError
          ? t("creative.page.desk.readFailed", { title: error.pageTitle })
          : error instanceof Error
            ? error.message
            : String(error)
      setCompile({ status: "failed", message })
    }
  }

  if (!databaseId) return null

  const loading = data.status === "loading" && rows === undefined
  const card = "rounded-2xl border border-border bg-card p-5"
  const heading = "text-sm font-semibold"
  const [latest, ...earlier] = recent
  const latestLevel = latest ? levelOf(latest) : undefined
  const latestWords = latest ? (stats[latest.noteId]?.wordCount ?? 0) : 0
  const countOf = (role: string) =>
    cards
      .filter((entry) => entry.section.role === role)
      .reduce((total, entry) => total + (data.rows[entry.section.databaseId]?.length ?? 0), 0)
  const statusOptions = text?.properties.status ? (text.statusOptions ?? []) : []
  const donePages =
    statusOptions.length > 0
      ? all.filter(
          (node) => resolvePageStatus(statusOptions, node.statusOptionId)?.group === "done",
        ).length
      : null
  const tiles: { label: string; value: number | string }[] = [
    { label: t("creative.page.desk.pages"), value: all.length },
    { label: t("creative.page.desk.words"), value: totalWords },
    ...(donePages !== null
      ? [
          {
            label: t("creative.schema.properties.status"),
            value: t("creative.page.desk.doneOf", { done: donePages, total: all.length }),
          },
        ]
      : []),
    ...(["characters", "locations"] as const)
      .filter((role) => cards.some((entry) => entry.section.role === role))
      .map((role) => ({ label: t(`creative.sections.${role}`), value: countOf(role) })),
  ]

  return (
    <div className="mb-8 flex w-full flex-col gap-5">
      <section
        aria-label={t("creative.page.desk.continue")}
        className={cn(card, "flex flex-col gap-4")}
      >
        <div className="flex flex-wrap items-center gap-4">
          <div className="min-w-0 flex-1">
            <p className="text-xs text-muted-foreground">{t("creative.page.desk.continue")}</p>
            {latest ? (
              <>
                <h2 className="truncate text-xl font-semibold tracking-tight">{latest.title}</h2>
                <p className="truncate text-xs text-muted-foreground">
                  {[
                    latestLevel?.name,
                    formatModified(stats[latest.noteId]?.modified ?? undefined),
                    latestWords > 0 ? t("docEditor.wordCount", { count: latestWords }) : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </>
            ) : (
              <p className="pt-1 text-sm text-muted-foreground">
                {loading ? "" : t("creative.page.desk.continueEmpty")}
              </p>
            )}
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {vaultPath && (
              <Button
                variant="outline"
                size="sm"
                title={t("creative.page.desk.manuscriptHint")}
                disabled={compile.status === "working" || all.length === 0}
                onClick={() => void assemble()}
              >
                <NotebookPen className="size-3.5" />
                {compile.status === "working"
                  ? t("creative.page.desk.compiling")
                  : t("creative.page.desk.compile")}
              </Button>
            )}
            {latest && (
              <Button size="sm" onClick={() => onOpenNote(latest.noteId)}>
                <Play className="size-3.5" />
                {t("creative.page.desk.open", { name: latest.title })}
              </Button>
            )}
          </div>
        </div>
        {earlier.length > 0 && (
          <div className="flex flex-wrap gap-2 border-t border-border pt-3">
            {earlier.map((node) => (
              <button
                key={node.noteId}
                type="button"
                onClick={() => onOpenNote(node.noteId)}
                className="flex max-w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-xs hover:bg-accent"
              >
                <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
                  <IconValue
                    value={levelOf(node)?.icon ?? undefined}
                    fallback={<FileText className="size-4" />}
                    className="size-4"
                  />
                </span>
                <span className="min-w-0 truncate font-medium">{node.title}</span>
                <span className="shrink-0 text-muted-foreground">
                  {formatModified(stats[node.noteId]?.modified ?? undefined)}
                </span>
              </button>
            ))}
          </div>
        )}
        {compile.status === "done" && (
          <p role="status" className="break-words text-xs text-muted-foreground">
            {t("creative.page.desk.compiled", { pages: compile.pages, path: compile.path })}
          </p>
        )}
        {compile.status === "failed" && (
          <p role="alert" className="break-words text-xs text-destructive">
            {t("creative.page.desk.compileFailed", { message: compile.message })}
          </p>
        )}
      </section>

      <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {tiles.map((tile) => (
          <div key={tile.label} className="rounded-2xl bg-accent/50 px-4 py-3">
            <dt className="text-xs text-muted-foreground">{tile.label}</dt>
            <dd className="text-2xl font-semibold tabular-nums tracking-tight">
              {typeof tile.value === "number" ? tile.value.toLocaleString() : tile.value}
            </dd>
          </div>
        ))}
      </dl>

      <div className="grid items-start gap-5 lg:grid-cols-5">
        <section
          aria-label={t("creative.page.desk.progress")}
          className={cn(card, "lg:col-span-3")}
        >
          <h2 className={cn(heading, "mb-3")}>{t("creative.page.desk.progress")}</h2>
          {parts.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {loading ? "" : t("creative.workshop.noPages")}
            </p>
          ) : (
            <ul className="grid gap-1">
              {parts.map((part) => (
                <li key={part.node.noteId}>
                  <button
                    type="button"
                    onClick={() => onOpenNote(part.node.noteId)}
                    className="flex w-full flex-col gap-1.5 rounded-lg px-2 py-1.5 text-left hover:bg-accent"
                  >
                    <span className="flex items-baseline justify-between gap-3 text-sm">
                      <span className="min-w-0 truncate font-medium">{part.node.title}</span>
                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                        {t("creative.page.desk.partTotals", {
                          pages: part.pages,
                          words: part.words,
                        })}
                      </span>
                    </span>
                    {/* A bar compares the parts, so one part alone has none. */}
                    {parts.length > 1 && (
                      <span className="h-1.5 w-full overflow-hidden rounded-full bg-accent">
                        <span
                          className="block h-full rounded-full bg-primary/60"
                          style={{ width: `${Math.round((part.words / widest) * 100)}%` }}
                        />
                      </span>
                    )}
                  </button>
                  {part.node.children.length > 0 && (
                    <ul className="mb-1 ml-2 grid border-l border-border pl-2">
                      {part.node.children.map((child) => {
                        const words = wordsOf(child, stats)
                        const statusOption = resolvePageStatus(statusOptions, child.statusOptionId)
                        return (
                          <li key={child.noteId}>
                            <button
                              type="button"
                              onClick={() => onOpenNote(child.noteId)}
                              className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[13px] hover:bg-accent"
                            >
                              <span
                                aria-hidden="true"
                                title={statusOption?.name}
                                className={cn(
                                  "size-2 shrink-0 rounded-full",
                                  pageStatusDotClass(statusOptions, child.statusOptionId, words),
                                )}
                              />
                              <span className="min-w-0 flex-1 truncate">{child.title}</span>
                              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                                {words.toLocaleString()}
                              </span>
                            </button>
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <div className="grid gap-5 lg:col-span-2">
          {cards.map(({ owner, section }) => {
            const items = data.rows[section.databaseId] ?? []
            const Icon = section.role ? sectionRoleIcon(section.role) : Database
            const people = section.role === "characters"
            const shared = owner.projectId !== project.projectId
            return (
              <section key={section.databaseId} aria-label={sectionTitle(section)} className={card}>
                <div className="mb-2 flex items-center gap-2">
                  <Icon className="size-4 shrink-0 text-muted-foreground" />
                  <h2 className={cn(heading, "min-w-0 truncate")}>{sectionTitle(section)}</h2>
                  <span className="text-xs text-muted-foreground">
                    {[items.length || null, shared ? owner.name : null].filter(Boolean).join(" · ")}
                  </span>
                  {onOpenSection && (
                    <button
                      type="button"
                      onClick={() => onOpenSection(owner.projectId, section.id)}
                      className="ml-auto shrink-0 rounded-md px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                    >
                      {t("creative.page.desk.openSection")}
                    </button>
                  )}
                </div>
                {items.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    {data.status === "loading" ? "" : t("creative.workshop.world.noItems")}
                  </p>
                ) : (
                  <ul className={cn("grid gap-0.5", people && "grid-cols-2")}>
                    {items.slice(0, CARD_ITEMS).map((row) => {
                      const preview = people ? resolveGalleryPreview(row.valuesJson) : null
                      return (
                        <li key={row.noteId} className="min-w-0">
                          <button
                            type="button"
                            onClick={() => onOpenNote(row.noteId)}
                            className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[13px] hover:bg-accent"
                          >
                            {people && (
                              <PortraitDot
                                relativePath={
                                  preview?.kind === "asset" ? preview.relativePath : null
                                }
                                resolver={resolverFor(section.databaseId)}
                                initials={initialsOf(row.title)}
                                className="size-7 text-[10px]"
                              />
                            )}
                            <span className="min-w-0 truncate">{row.title}</span>
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                )}
                {items.length > CARD_ITEMS && (
                  <p className="px-2 pt-1 text-xs text-muted-foreground">
                    {t("creative.page.desk.more", { count: items.length - CARD_ITEMS })}
                  </p>
                )}
              </section>
            )
          })}
        </div>
      </div>
    </div>
  )
}
