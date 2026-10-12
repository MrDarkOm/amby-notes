import * as React from "react"
import { Database } from "lucide-react"
import { useTranslation } from "react-i18next"
import type { ProjectSummary } from "@/lib/storage"
import { cn } from "@/lib/utils"
import { IconValue } from "../../icon-value"
import { resolveGalleryPreview } from "../../database/layouts/gallery-preview"
import { sectionRoleIcon } from "../section-icons"
import { Accordion } from "./accordion"
import { treeIndent } from "./tree-indent"
import { EmptyAction } from "./empty-action"
import { InlineCreateRow } from "./inline-create-row"
import { ItemMenu } from "./item-menu"
import { PortraitDot } from "./portrait-dot"
import { usePortraitResolvers } from "./use-portrait-resolvers"
import {
  groupEntities,
  initialsOf,
  inStory,
  isUnplaced,
  storiesOfEntity,
  type EntityItem,
  type GroupContext,
  type TextReferences,
  type WorkshopTab,
  type WorldScope,
} from "./workshop-model"

const MAX_CHIPS = 2

interface WorldSectionProps {
  categories: WorkshopTab[]
  itemsByCategory: Record<string, EntityItem[]>
  /** The stories of the scope; the selected one is what "this story" means. */
  stories: ProjectSummary[]
  selectedStoryId: string | null
  references: TextReferences
  groupContext: GroupContext
  /** Whether there is a shared world at all (a collection); without it the switch is not offered. */
  hasUniverse: boolean
  /** The collection whose sections are the shared world; a page of it no text names is "not in the text". */
  sharedProjectId: string | null
  worldScope: WorldScope
  onWorldScope: (scope: WorldScope) => void
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

function Chips({ stories }: { stories: ProjectSummary[] }) {
  if (stories.length === 0) return null
  const shown = stories.slice(0, MAX_CHIPS)
  const rest = stories.length - shown.length
  return (
    <span className="ml-2 flex shrink-0 items-center gap-1">
      {shown.map((story) => (
        <span
          key={story.projectId}
          className="max-w-20 truncate rounded-full bg-accent px-1.5 py-0.5 text-[10px] text-muted-foreground"
          title={story.name}
        >
          {story.name}
        </span>
      ))}
      {rest > 0 && <span className="text-[10px] text-muted-foreground">+{rest}</span>}
    </span>
  )
}

/** The switch in the "World" heading: only this story's pages, or the whole universe's. */
function ScopeSwitch({
  value,
  onChange,
}: {
  value: WorldScope
  onChange: (scope: WorldScope) => void
}) {
  const { t } = useTranslation()
  const option = (scope: WorldScope, label: string, title: string) => (
    <button
      key={scope}
      type="button"
      aria-pressed={value === scope}
      title={title}
      onClick={() => onChange(scope)}
      className={cn(
        "rounded px-2 py-0.5 text-[11px] font-medium outline-none focus-visible:ring-1 focus-visible:ring-ring",
        value === scope
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </button>
  )
  return (
    <div
      role="group"
      aria-label={t("creative.workshop.world.scope")}
      className="inline-flex items-center gap-0.5 rounded-md border border-border/60 p-0.5"
    >
      {option(
        "story",
        t("creative.workshop.world.thisStory"),
        t("creative.workshop.world.thisStoryHint"),
      )}
      {option(
        "universe",
        t("creative.workshop.world.universe"),
        t("creative.workshop.world.universeHint"),
      )}
    </div>
  )
}

/**
 * The world under the story's parts: its categories (characters, locations and the author's
 * own), each a folding list of pages grouped by importance. The switch in the heading narrows
 * every list to the chosen story or widens it to the whole universe.
 */
export function WorldSection({
  categories,
  itemsByCategory,
  stories,
  selectedStoryId,
  references,
  groupContext,
  hasUniverse,
  sharedProjectId,
  worldScope,
  onWorldScope,
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
  // Without a shared world the lists can only be a story's own.
  const wholeUniverse = hasUniverse && worldScope === "universe"
  const showChips = wholeUniverse && stories.length > 1

  // The first picture of each page, found once per read of the data and not at every render. A
  // category where no page has one shows no round faces at all.
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

  // The story's world is its own pages and those its text names. A shared page no story names yet
  // (one just made, say) stays in view: it is listed with the others and marked "not in the text".
  const visible = (key: string): EntityItem[] => {
    const items = itemsByCategory[key] ?? []
    if (wholeUniverse || !selectedStoryId) return items
    return items.filter(
      (item) =>
        inStory(item, selectedStoryId, references) || isUnplaced(item, sharedProjectId, references),
    )
  }

  return (
    <section aria-label={t("creative.workshop.world.title")} className="mt-3">
      <div className="flex items-center justify-between gap-2 pb-1 pl-3.5 pr-2">
        <h3 className="text-[11px] text-muted-foreground">{t("creative.groups.world")}</h3>
        {hasUniverse && <ScopeSwitch value={worldScope} onChange={onWorldScope} />}
      </div>
      {categories.length === 0 && (
        <p className="px-2 py-1.5 text-[11px] text-muted-foreground">
          {t("creative.workshop.world.noCategories")}
        </p>
      )}
      {categories.map((tab) => {
        const items = visible(tab.key)
        const Fallback = tab.role ? sectionRoleIcon(tab.role) : Database
        const icon = iconOf(tab.sources[0].section.databaseId)
        const groups = groupEntities(items, "importance", groupContext)
        const writable = tab.sources.some((source) => !source.project.readOnly)
        const faces = pictures[tab.key] ?? { any: false, byNote: {} }
        // People always have a face (their initials until a portrait is set); other sections
        // only once some page of theirs has a picture.
        const showFaces = tab.role === "characters" || faces.any
        const renderItem = (item: EntityItem) => {
          const notInText = isUnplaced(item, sharedProjectId, references)
          const chips = showChips ? storiesOfEntity(item, stories, references) : []
          return (
            <ItemMenu key={item.noteId} noteId={item.noteId} title={item.title}>
              <button
                type="button"
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
                {chips.length > 0 ? (
                  <Chips stories={chips} />
                ) : (
                  notInText && (
                    <span
                      className="ml-2 shrink-0 text-[11px] text-muted-foreground"
                      title={t("creative.workshop.world.unplacedHint")}
                    >
                      {t("creative.workshop.world.unplaced")}
                    </span>
                  )
                )}
              </button>
            </ItemMenu>
          )
        }
        return (
          <Accordion
            key={tab.key}
            icon={Fallback}
            label={tab.name}
            count={items.length}
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
              draftCategoryKey !== tab.key &&
              (status === "loading" ? null : writable ? (
                <EmptyAction
                  label={t("creative.workshop.addFirstPage")}
                  onClick={() => onAddEntity(tab.key)}
                />
              ) : (
                <p
                  className="py-1 pr-3 text-xs text-muted-foreground"
                  style={{ paddingLeft: treeIndent(1) }}
                >
                  {t("creative.workshop.world.noItems")}
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
          </Accordion>
        )
      })}
      {truncated && (
        <p className="px-2 py-1.5 text-[11px] text-muted-foreground">
          {t("creative.workshop.truncated")}
        </p>
      )}
    </section>
  )
}
