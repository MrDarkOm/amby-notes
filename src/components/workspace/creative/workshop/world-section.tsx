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
import { ItemMenu } from "./item-menu"
import { PortraitDot } from "./portrait-dot"
import { usePortraitResolvers } from "./use-portrait-resolvers"
import {
  groupEntities,
  initialsOf,
  type EntityItem,
  type GroupContext,
  type WorkshopTab,
} from "./workshop-model"

interface WorldSectionProps {
  categories: WorkshopTab[]
  itemsByCategory: Record<string, EntityItem[]>
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
      {categories.length === 0 && (
        <p className="px-2 py-1.5 text-[11px] text-muted-foreground">
          {t("creative.workshop.world.noCategories", "Нет разделов мира")}
        </p>
      )}
      {categories.map((tab) => {
        const items = itemsByCategory[tab.key] ?? []
        const Fallback = tab.role ? sectionRoleIcon(tab.role) : Database
        const icon = iconOf(tab.databaseId)
        const groups = groupEntities(items, "importance", groupContext)
        const writable = !tab.readOnly
        const faces = pictures[tab.key] ?? { any: false, byNote: {} }
        const showFaces = tab.role === "characters" || faces.any

        const renderItem = (item: EntityItem) => (
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
            </button>
          </ItemMenu>
        )

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
