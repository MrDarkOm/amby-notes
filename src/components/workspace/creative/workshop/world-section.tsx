import { Database } from "lucide-react"
import { useTranslation } from "react-i18next"
import type { ProjectSummary } from "@/lib/storage"
import { cn } from "@/lib/utils"
import { IconValue } from "../../icon-value"
import { sectionRoleIcon } from "../section-icons"
import { Accordion } from "./accordion"
import { ItemMenu } from "./item-menu"
import {
  groupEntities,
  inStory,
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
  worldScope: WorldScope
  onWorldScope: (scope: WorldScope) => void
  /** Folding state: keys `world` and `category:<key>`, unfolded unless set. */
  collapsed: Record<string, boolean>
  onToggle: (key: string) => void
  /** Icon of a category's database, if it has one of its own. */
  iconOf: (databaseId: string) => string | null
  status: "idle" | "loading" | "ready" | "error"
  truncated: boolean
  onOpen: (noteId: string) => void
  /** Adds a page to a category. */
  onAddEntity: (categoryKey: string) => void
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

/** The switch to the right of "World": only this story's pages, or the whole universe's. */
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
        "flex-1 rounded-md px-3 py-1.5 text-xs font-medium",
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
      className="flex w-full items-center gap-0.5 rounded-lg border border-border/60 p-0.5"
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
 * own), each a folding list of pages. The switch narrows every list to the chosen story or
 * widens it to the whole universe.
 */
export function WorldSection({
  categories,
  itemsByCategory,
  stories,
  selectedStoryId,
  references,
  groupContext,
  hasUniverse,
  worldScope,
  onWorldScope,
  collapsed,
  onToggle,
  iconOf,
  status,
  truncated,
  onOpen,
  onAddEntity,
}: WorldSectionProps) {
  const { t } = useTranslation()
  // Without a shared world the lists can only be a story's own.
  const wholeUniverse = hasUniverse && worldScope === "universe"
  const showChips = wholeUniverse && stories.length > 1

  const visible = (key: string): EntityItem[] => {
    const items = itemsByCategory[key] ?? []
    if (wholeUniverse || !selectedStoryId) return items
    return items.filter((item) => inStory(item, selectedStoryId, references))
  }

  return (
    <section aria-label={t("creative.workshop.world.title")} className="mt-3">
      {/* The world has no visible name: it is the part under the story's own. It is still named
          for screen readers by the section's label. */}
      {hasUniverse && (
        <div className="px-1.5 pb-2">
          <ScopeSwitch value={worldScope} onChange={onWorldScope} />
        </div>
      )}
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
            {items.length === 0 ? (
              <p className="px-2 py-1.5 text-[11px] text-muted-foreground">
                {status === "loading" ? "" : t("creative.workshop.world.noItems")}
              </p>
            ) : (
              groups.map((group) => (
                <div key={group.key} className="mb-1">
                  {group.label && (
                    <h4 className="flex items-center gap-1.5 px-2 pb-0.5 pt-1.5 text-[11px] font-medium text-muted-foreground">
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
                  {group.items.map((item) => (
                    <ItemMenu key={item.noteId} noteId={item.noteId} title={item.title}>
                      <button
                        type="button"
                        onClick={() => onOpen(item.noteId)}
                        className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent/50"
                      >
                        <span className="min-w-0 flex-1 truncate">{item.title}</span>
                        {showChips && (
                          <Chips stories={storiesOfEntity(item, stories, references)} />
                        )}
                      </button>
                    </ItemMenu>
                  ))}
                </div>
              ))
            )}
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
