import * as React from "react"
import { Database } from "lucide-react"
import { useTranslation } from "react-i18next"
import { cn } from "@/lib/utils"
import { IconValue } from "../../icon-value"
import { resolveGalleryPreview } from "../../database/layouts/gallery-preview"
import { sectionRoleIcon } from "../section-icons"
import { Accordion } from "./accordion"
import { treeIndent } from "./tree-indent"
import { EmptyAction } from "./empty-action"
import { InlineCreateRow } from "./inline-create-row"
import { ItemMenu, type PlotMenu } from "./item-menu"
import { LinkAction } from "./link-action"
import { RowError } from "./page-marks"
import { PLOT_DRAG_TYPE, encodePlotDrag, type PlotDrag } from "./plot-model"
import { PortraitDot } from "./portrait-dot"
import { usePortraitResolvers } from "./use-portrait-resolvers"
import {
  groupEntities,
  initialsOf,
  type EntityItem,
  type GroupContext,
  type StoryLabels,
  type WorkshopTab,
} from "./workshop-model"

/** What a row of the world can do as an arc bound to the shown story's text. */
export interface PlotRow {
  /** What dragging the row onto a page binds. */
  drag: PlotDrag
  /** "Unbind from a page" in the row's menu. */
  menu?: PlotMenu
  /** The failure of the last binding of this row. */
  error?: string | null
}

interface WorldSectionProps {
  categories: WorkshopTab[]
  itemsByCategory: Record<string, EntityItem[]>
  /** Pages in no story and named by no text, per category: a group of their own at the end. */
  withoutStoryByCategory?: Record<string, EntityItem[]>
  /** The story names for a page's row (up to two and "+N"); `null` shows none. */
  storyLabelsOf?: ((noteId: string) => StoryLabels) | null
  /** Links a section made before the links existed; `null` offers nothing. */
  onLinkSection?: ((tab: WorkshopTab) => void) | null
  /** The section being linked right now, if any. */
  linkingSectionId?: string | null
  /** Which rows are arcs of the shown story that can be dragged onto its pages; none by default. */
  plotRowOf?: ((tab: WorkshopTab, item: EntityItem) => PlotRow | null) | null
  /** Links the stories to the universes that now exist; `null` offers nothing. */
  onLinkUniverses?: (() => void) | null
  linkError?: string | null
  groupContext: GroupContext
  /** Folding state: keys `world` and `category:<key>`, unfolded unless set. */
  collapsed: Record<string, boolean>
  onToggle: (key: string) => void
  /** Icon of a category's database, if it has one of its own. */
  iconOf: (databaseId: string) => string | null
  /** The vault generation pictures are resolved against. */
  vaultGeneration: number | null
  status: "idle" | "loading" | "ready" | "error"
  truncated: boolean
  onOpen: (noteId: string) => void
  /** The page open in the editor, marked in the lists. */
  activeNoteId: string | null
  /** Starts naming a new page of a category; its row stands at the top of the list. */
  onAddEntity: (categoryKey: string) => void
  /** The category whose new page is being named, if any. */
  draftCategoryKey: string | null
  onCommitDraft: (title: string) => Promise<void>
  onCancelDraft: () => void
}

/**
 * The world under the works parts: categories (characters, locations, etc.),
 * each a folding list of pages grouped by importance.
 */
export function WorldSection({
  categories,
  itemsByCategory,
  withoutStoryByCategory = {},
  storyLabelsOf = null,
  plotRowOf = null,
  onLinkSection = null,
  linkingSectionId = null,
  onLinkUniverses = null,
  linkError = null,
  groupContext,
  collapsed,
  onToggle,
  iconOf,
  vaultGeneration,
  status,
  truncated,
  onOpen,
  activeNoteId,
  onAddEntity,
  draftCategoryKey,
  onCommitDraft,
  onCancelDraft,
}: WorldSectionProps) {
  const { t } = useTranslation()
  const resolverFor = usePortraitResolvers(vaultGeneration)

  // The first picture of each page, found once per read of the data and not at every render.
  const pictures = React.useMemo(() => {
    const result: Record<string, { any: boolean; byNote: Record<string, string> }> = {}
    for (const [key, items] of Object.entries(itemsByCategory)) {
      const byNote: Record<string, string> = {}
      for (const item of items) {
        const preview = resolveGalleryPreview(item.valuesJson)
        if (preview.kind === "asset") byNote[item.noteId] = preview.relativePath
      }
      result[key] = { any: Object.keys(byNote).length > 0, byNote }
    }
    return result
  }, [itemsByCategory])

  return (
    <section aria-label={t("creative.workshop.world.title", "Мир")} className="mt-3">
      <div className="flex items-center justify-between gap-2 pb-1 pl-3.5 pr-2">
        <h3 className="text-[11px] text-muted-foreground">{t("creative.groups.world", "Мир")}</h3>
      </div>
      {onLinkUniverses && (
        <LinkAction
          indent={0}
          label={t("creative.workshop.link.universes")}
          title={t("creative.workshop.link.universesHint")}
          onClick={onLinkUniverses}
        />
      )}
      {linkError && (
        <p role="alert" className="px-2 py-1 text-[11px] text-destructive">
          {linkError}
        </p>
      )}
      {categories.length === 0 && (
        <p className="px-2 py-1.5 text-[11px] text-muted-foreground">
          {t("creative.workshop.world.noCategories", "Нет разделов мира")}
        </p>
      )}
      {categories.map((tab) => {
        const items = itemsByCategory[tab.key] ?? []
        const withoutStory = withoutStoryByCategory[tab.key] ?? []
        const Fallback = tab.role ? sectionRoleIcon(tab.role) : Database
        const icon = iconOf(tab.databaseId)
        const groups = groupEntities(items, "importance", groupContext)
        const writable = !tab.readOnly
        const faces = pictures[tab.key] ?? { any: false, byNote: {} }
        const showFaces = tab.role === "characters" || faces.any

        const renderItem = (item: EntityItem) => {
          const plot = plotRowOf?.(tab, item) ?? null
          return (
            <React.Fragment key={item.noteId}>
              <ItemMenu noteId={item.noteId} title={item.title} plot={plot?.menu}>
                <button
                  type="button"
                  draggable={plot !== null}
                  onDragStart={
                    plot
                      ? (event) => {
                          event.dataTransfer.setData("text/plain", item.noteId)
                          event.dataTransfer.setData(PLOT_DRAG_TYPE, encodePlotDrag(plot.drag))
                          event.dataTransfer.effectAllowed = "linkMove"
                        }
                      : undefined
                  }
                  aria-current={activeNoteId === item.noteId ? "true" : undefined}
                  onClick={() => onOpen(item.noteId)}
                  style={{ paddingLeft: treeIndent(1) }}
                  className={cn(
                    "amby-tree-row flex w-full items-center gap-1.5 rounded py-1 pr-3 text-left text-[13px] hover:bg-accent",
                    activeNoteId === item.noteId && "bg-accent",
                  )}
                >
                  {showFaces && (
                    <PortraitDot
                      relativePath={faces.byNote[item.noteId] ?? null}
                      resolver={resolverFor(item.databaseId)}
                      initials={initialsOf(item.title)}
                    />
                  )}
                  <span className="min-w-0 flex-1 truncate">{item.title}</span>
                  {storyLabelsOf && <RowStories labels={storyLabelsOf(item.noteId)} />}
                </button>
              </ItemMenu>
              {plot?.error && <RowError message={plot.error} indent={treeIndent(1)} />}
            </React.Fragment>
          )
        }

        return (
          <Accordion
            key={tab.key}
            icon={Fallback}
            label={tab.name}
            count={items.length + withoutStory.length}
            open={!collapsed[`category:${tab.key}`]}
            onToggle={() => onToggle(`category:${tab.key}`)}
            onAdd={writable ? () => onAddEntity(tab.key) : null}
            addLabel={t("creative.workshop.world.addEntity", { name: tab.name })}
            iconNode={
              icon ? (
                <IconValue
                  value={icon}
                  fallback={<Fallback className="size-4" />}
                  className="size-4"
                />
              ) : undefined
            }
          >
            {writable && !tab.storiesPropertyId && tab.role !== "universes" && onLinkSection && (
              <LinkAction
                label={t("creative.workshop.link.stories")}
                title={t("creative.workshop.link.storiesHint")}
                pending={linkingSectionId === tab.sectionId}
                onClick={() => onLinkSection(tab)}
              />
            )}
            {draftCategoryKey === tab.key && (
              <InlineCreateRow
                depth={0}
                icon={<Fallback className="size-3.5" />}
                placeholder={t("creative.workshop.newEntityPlaceholder", { name: tab.name })}
                onSubmit={onCommitDraft}
                onCancel={onCancelDraft}
              />
            )}
            {items.length === 0 &&
              withoutStory.length === 0 &&
              draftCategoryKey !== tab.key &&
              (status === "loading" ? null : writable ? (
                <EmptyAction
                  label={t("creative.workshop.addFirstPage", "Добавить первую страницу")}
                  onClick={() => onAddEntity(tab.key)}
                />
              ) : (
                <p
                  className="py-1 pr-3 text-xs text-muted-foreground"
                  style={{ paddingLeft: treeIndent(1) }}
                >
                  {t("creative.workshop.world.noItems", "Нет записей")}
                </p>
              ))}
            {groups.map((group) => (
              <div key={group.key}>
                {group.label && (
                  <h4
                    className="flex items-center gap-1.5 pb-0.5 pr-3 pt-1 text-[11px] text-muted-foreground"
                    style={{ paddingLeft: treeIndent(1) }}
                  >
                    {group.color && (
                      <span
                        aria-hidden="true"
                        className="size-2 shrink-0 rounded-full"
                        style={{ backgroundColor: group.color }}
                      />
                    )}
                    <span className="truncate">{group.label}</span>
                    <span className="opacity-60">{group.items.length}</span>
                  </h4>
                )}
                {group.items.map(renderItem)}
              </div>
            ))}
            {withoutStory.length > 0 && (
              <div data-testid={`without-story:${tab.key}`}>
                <h4
                  className="flex items-center gap-1.5 pb-0.5 pr-3 pt-1 text-[11px] text-muted-foreground"
                  style={{ paddingLeft: treeIndent(1) }}
                >
                  <span className="truncate">{t("creative.workshop.noStory")}</span>
                  <span className="opacity-60">{withoutStory.length}</span>
                </h4>
                {[...withoutStory]
                  .sort((a, b) =>
                    a.title.localeCompare(b.title, undefined, { sensitivity: "base" }),
                  )
                  .map(renderItem)}
              </div>
            )}
          </Accordion>
        )
      })}
      {truncated && (
        <p className="px-2 py-1.5 text-[11px] text-muted-foreground">
          {t("creative.workshop.truncated", "Список обрезан")}
        </p>
      )}
    </section>
  )
}

/** Up to two story names of a page and "+N" for the rest, quiet at the end of its row. */
function RowStories({ labels }: { labels: StoryLabels }) {
  if (labels.names.length === 0) return null
  return (
    <span
      className="ml-auto max-w-[45%] shrink-0 truncate pl-2 text-[11px] text-muted-foreground"
      title={labels.names.join(", ")}
    >
      {labels.names.join(", ")}
      {labels.more > 0 ? ` +${labels.more}` : ""}
    </span>
  )
}
