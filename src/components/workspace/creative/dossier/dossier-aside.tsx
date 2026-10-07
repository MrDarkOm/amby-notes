import { ArrowLeft, ArrowRight } from "lucide-react"
import { useTranslation } from "react-i18next"
import type { NoteReference } from "@/lib/storage"
import { cn } from "@/lib/utils"
import { extractToc, splitReferences } from "./dossier-model"
import type { NoteDossier } from "./use-note-dossier"

interface DossierAsideProps {
  dossier: NoteDossier
  /** The page's Markdown, whose headings are the dossier's sections. */
  content: string
  /** The source editor has no headings on screen to jump to. */
  canJump: boolean
  onJump: (index: number) => void
  onOpenNote?: (noteId: string) => void
  /** Beside the text (a fixed column) or under it (the full width). */
  sideBySide: boolean
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  )
}

function PageLink({
  reference,
  onOpenNote,
}: {
  reference: NoteReference
  onOpenNote?: (noteId: string) => void
}) {
  const { t } = useTranslation()
  if (reference.title === null) {
    return (
      <span className="px-2 py-1 text-xs text-muted-foreground">
        {t("creative.dossier.missingPage")}
      </span>
    )
  }
  return (
    <button
      type="button"
      className="truncate rounded-md px-2 py-1 text-left text-xs hover:bg-accent/50"
      title={reference.databaseName ?? undefined}
      onClick={() => onOpenNote?.(reference.noteId)}
    >
      {reference.title}
    </button>
  )
}

/**
 * The blocks beside a dossier's text: its sections as a table of contents, where it appears in
 * the story's text, and its other connections. The last two are computed on request.
 */
export function DossierAside({
  dossier,
  content,
  canJump,
  onJump,
  onOpenNote,
  sideBySide,
}: DossierAsideProps) {
  const { t } = useTranslation()
  const toc = canJump ? extractToc(content).filter((entry) => entry.level <= 3) : []
  const split = splitReferences(dossier.references, dossier.world.project.text?.databaseId ?? null)
  const hasText = Boolean(dossier.world.project.text?.databaseId)

  return (
    <aside
      aria-label={t("creative.dossier.aside")}
      className={cn("flex shrink-0 flex-col gap-5", sideBySide ? "sticky top-2 w-60" : "w-full")}
    >
      {toc.length > 1 && (
        <Block title={t("creative.dossier.toc")}>
          <nav className="flex flex-col">
            {toc.map((entry) => (
              <button
                key={entry.index}
                type="button"
                className={cn(
                  "truncate rounded-md px-2 py-1 text-left text-xs hover:bg-accent/50",
                  entry.level === 1 && "font-medium",
                )}
                style={{ paddingLeft: `${0.5 + (entry.level - 1) * 0.75}rem` }}
                onClick={() => onJump(entry.index)}
              >
                {entry.title}
              </button>
            ))}
          </nav>
        </Block>
      )}

      {hasText && (
        <Block title={t("creative.dossier.appearsIn")}>
          {split.appearsIn.length === 0 ? (
            <p className="px-2 text-xs text-muted-foreground">
              {t("creative.dossier.appearsInEmpty")}
            </p>
          ) : (
            <div className="flex flex-col">
              {split.appearsIn.map((reference) => (
                <PageLink
                  key={`${reference.propertyId}:${reference.noteId}`}
                  reference={reference}
                  onOpenNote={onOpenNote}
                />
              ))}
            </div>
          )}
        </Block>
      )}

      <Block title={t("creative.dossier.connections")}>
        {split.connections.length === 0 ? (
          <p className="px-2 text-xs text-muted-foreground">
            {t("creative.dossier.connectionsEmpty")}
          </p>
        ) : (
          split.connections.map((group) => (
            <div key={group.key} className="flex flex-col">
              <span className="flex items-center gap-1 px-2 pt-1 text-[11px] text-muted-foreground">
                {group.direction === "in" ? (
                  <ArrowLeft className="size-3" aria-label={t("creative.dossier.incoming")} />
                ) : (
                  <ArrowRight className="size-3" aria-label={t("creative.dossier.outgoing")} />
                )}
                {group.label}
              </span>
              {group.items.map((reference) => (
                <PageLink
                  key={`${group.key}:${reference.noteId}`}
                  reference={reference}
                  onOpenNote={onOpenNote}
                />
              ))}
            </div>
          ))
        )}
      </Block>
    </aside>
  )
}
