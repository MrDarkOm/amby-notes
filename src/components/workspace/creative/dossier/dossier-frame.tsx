import * as React from "react"
import { ChevronDown } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { localeResources } from "@/locales/resources"
import { HeadingHintsContext } from "../../editor/heading-hints-context"
import { DossierAside } from "./dossier-aside"
import { hasPlotSections } from "./dossier-model"
import { DossierHeader } from "./dossier-header"
import { TextPageAside } from "./text-page-aside"
import { usePlotFold } from "./use-plot-fold"
import { NotePlaceContext } from "./use-note-dossier"
import { useWorldNames } from "./use-world-names"
import { EntityCard } from "./entity-card"
import { EntityNamesContext } from "../../editor/entity-names-context"
import type { EntityNames } from "../../tiptap/entity-names"
import { NotePageAboveContext } from "../../editor/note-pages-context"
import { DossierFields } from "./dossier-fields"
import { layoutHints, sectionOfTitle } from "./dossier-layout-model"
import { DossierTemplateDialog } from "./dossier-template-dialog"
import { useDossierTemplate } from "./use-dossier-template"

/** Side by side only where the text keeps a readable column next to the blocks. */
const SIDE_BY_SIDE_MIN_WIDTH = 640

/** The width of the pane this frame is in. The window's width says nothing when sidebars are open. */
function useWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = React.useState(0)
  React.useLayoutEffect(() => {
    const element = ref.current
    if (!element) return undefined
    const update = () => setWidth(element.clientWidth)
    update()
    if (typeof ResizeObserver === "undefined") return undefined
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])
  return width
}

export interface DossierFrameProps {
  noteId: string
  vaultPath?: string
  locked?: boolean
  /** The page's Markdown. */
  content: string
  /** Scrolls the page to its n-th heading. */
  scrollToHeading: (index: number) => void
  /** Headings can be jumped to only where they are on screen (not in the source editor). */
  canJump: boolean
  onOpenNote?: (noteId: string) => void
  /** The editor. It stays in the same place of the tree whether or not the page is a dossier. */
  children: React.ReactNode
}

/**
 * Wraps a note's editor. For a page of a creative world section it adds the dossier header
 * above the text and the blocks beside it (under it on a narrow window); for a page of a story's
 * text, in a workshop that has anchors or arcs, the plot of the page beside it; for any other
 * note it adds nothing visible. The structure is the same either way, so the editor is never
 * remounted when the answer arrives.
 */
export function DossierFrame({
  noteId,
  vaultPath,
  locked,
  content,
  scrollToHeading,
  canJump,
  onOpenNote,
  children,
}: DossierFrameProps) {
  const { t } = useTranslation()
  const place = React.useContext(NotePlaceContext)
  const { folded, toggle } = usePlotFold(vaultPath)
  const dossier = place?.kind === "world" ? place.dossier : null
  const role = dossier?.world.section.role
  const builtInHints = React.useMemo(() => {
    if (role !== "characters" && role !== "locations") return null
    const words = {
      basic: t("creative.dossier.headingHints.basic"),
      traits: t("creative.dossier.headingHints.traits"),
      appearance: t("creative.dossier.headingHints.appearance"),
      biography: t("creative.dossier.headingHints.biography"),
      description: t("creative.dossier.headingHints.description"),
      history: t("creative.dossier.headingHints.history"),
    }
    const keys =
      role === "characters"
        ? (["basic", "traits", "appearance", "biography"] as const)
        : (["description", "history"] as const)
    return new Map(
      Object.values(localeResources).flatMap(({ translation }) =>
        keys.map((key) => [translation.creative.preset.headings[key], words[key]] as const),
      ),
    )
  }, [role, t])
  // The section's template, when it has a dossier layout, decides the hints and the fields shown
  // in each tab; without one the built-in hints of the preset's headings apply.
  const { template, reload } = useDossierTemplate(dossier?.context.databaseId ?? null)
  const layout = dossier ? (template?.dossier ?? null) : null
  const headingHints = React.useMemo(
    () => (layout ? layoutHints(layout) : builtInHints),
    [builtInHints, layout],
  )
  const editable = Boolean(dossier) && !locked && !dossier?.context.locked
  const above = React.useMemo(() => {
    if (!dossier || !layout) return null
    const { context } = dossier
    return (title: string | null) => {
      const section = title === null ? null : sectionOfTitle(layout, title)
      const fields = (section?.fields ?? []).flatMap(
        (id) => context.properties.find((property) => property.propertyId === id) ?? [],
      )
      if (fields.length === 0) return null
      return (
        <div className="mb-4">
          <DossierFields context={context} properties={fields} editable={editable} />
        </div>
      )
    }
  }, [dossier, editable, layout])
  const [templateOpen, setTemplateOpen] = React.useState(false)
  const textPlace =
    place?.kind === "text" && hasPlotSections(place.text.workshop) ? place.text : null
  const framed = dossier !== null || (textPlace !== null && !folded)
  // A page of a story's text marks the names of the world; pointing at one shows its card.
  // Only where the page has its plot aside too: a workshop of an early stage reads nothing.
  const textWorkshop = textPlace?.workshop ?? null
  const world = useWorldNames(textWorkshop)
  const [pointed, setPointed] = React.useState<{ noteId: string; rect: DOMRect } | null>(null)
  const openRef = React.useRef(onOpenNote)
  openRef.current = onOpenNote
  const entityNames = React.useMemo<EntityNames | null>(
    () =>
      textWorkshop && world.entries.length > 0
        ? {
            entries: world.entries,
            onHover: (id, element) =>
              setPointed(
                id && element ? { noteId: id, rect: element.getBoundingClientRect() } : null,
              ),
            onOpen: (id) => openRef.current?.(id),
          }
        : null,
    [textWorkshop, world.entries],
  )
  const pointedEntity = pointed ? world.entityOf(pointed.noteId) : null
  const frameRef = React.useRef<HTMLDivElement>(null)
  const sideBySide = useWidth(frameRef) >= SIDE_BY_SIDE_MIN_WIDTH
  return (
    <div ref={frameRef} className="min-w-0" data-dossier-frame="">
      {dossier ? (
        <DossierHeader
          dossier={dossier}
          locked={locked}
          content={content}
          layout={layout}
          onOpenTemplate={() => setTemplateOpen(true)}
        />
      ) : null}
      {dossier && templateOpen && (
        <DossierTemplateDialog
          open
          databaseId={dossier.context.databaseId}
          expectedGeneration={dossier.context.vaultGeneration}
          properties={dossier.context.properties}
          knownHints={builtInHints ?? new Map()}
          onClose={() => setTemplateOpen(false)}
          onSaved={reload}
        />
      )}
      {textPlace && folded && (
        <Button type="button" size="sm" variant="ghost" onClick={toggle} aria-expanded={false}>
          <ChevronDown aria-hidden="true" className="size-3.5" />
          {t("creative.plot.side.expand")}
        </Button>
      )}
      <div
        className={cn(
          framed ? "flex gap-6" : "contents",
          framed && !sideBySide && "flex-col",
          framed && sideBySide && "items-start",
        )}
      >
        <div className={framed ? "min-w-0 flex-1" : "contents"}>
          <HeadingHintsContext.Provider value={headingHints}>
            <EntityNamesContext.Provider value={entityNames}>
              <NotePageAboveContext.Provider value={above}>
                {children}
              </NotePageAboveContext.Provider>
            </EntityNamesContext.Provider>
          </HeadingHintsContext.Provider>
        </div>
        {dossier ? (
          <DossierAside
            dossier={dossier}
            content={content}
            canJump={canJump}
            onJump={scrollToHeading}
            onOpenNote={onOpenNote}
            sideBySide={sideBySide}
            locked={locked}
          />
        ) : textPlace && !folded ? (
          <TextPageAside
            workshop={textPlace.workshop}
            story={textPlace.story}
            noteId={noteId}
            locked={locked || (place?.kind === "text" && place.context.locked)}
            onFold={vaultPath ? toggle : undefined}
            onOpenNote={onOpenNote}
            sideBySide={sideBySide}
          />
        ) : null}
      </div>
      {pointed && pointedEntity && (
        <EntityCard
          title={pointedEntity.row.title}
          kind={pointedEntity.section.name}
          anchor={pointed.rect}
        />
      )}
    </div>
  )
}
