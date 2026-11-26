import * as React from "react"
import { ArrowDown, ArrowUp, Plus, Trash2, X } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { NoticeLine } from "@/components/workspace/notices/notice-line"
import {
  createDatabaseProperty,
  getDossierTemplate,
  updateDossierTemplate,
  type DatabasePropertySummary,
  type DossierLayout,
  type DossierTemplate,
} from "@/lib/storage"
import { isEnterKey } from "@/lib/keyboard"
import { projectErrorText } from "@/lib/operation-errors"
import {
  addField,
  addSection,
  layoutFromBody,
  layoutProblem,
  moveSection,
  removeField,
  removeSection,
  updateSection,
} from "./dossier-layout-model"

/** Properties a dossier tab can show as a field: not pictures (the portrait) nor links. */
function fieldable(property: DatabasePropertySummary): boolean {
  return property.propertyType !== "files" && property.propertyType !== "relation"
}

function NewFieldInput({ onCreate }: { onCreate: (name: string) => Promise<void> }) {
  const { t } = useTranslation()
  const [name, setName] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  return (
    <input
      type="text"
      value={name}
      disabled={busy}
      aria-label={t("creative.template.newField")}
      placeholder={t("creative.template.newFieldHint")}
      className="h-7 min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1.5 text-xs outline-none hover:border-border focus:border-ring"
      onChange={(event) => setName(event.target.value)}
      onKeyDown={(event) => {
        if (!isEnterKey(event) || !name.trim()) return
        event.preventDefault()
        setBusy(true)
        void onCreate(name.trim())
          .then(() => setName(""))
          .finally(() => setBusy(false))
      }}
    />
  )
}

/**
 * The editor of a section's dossier template: its sections (order, title, the hint shown while
 * one is empty) and the fields each shows. A template without a layout opens as its headings with
 * the hints the module knows. A new field is a text property of the section, made at once; the
 * layout is saved whole over the manifest revision it was read at. Pages already written do not
 * change.
 */
export function DossierTemplateDialog({
  open,
  databaseId,
  expectedGeneration,
  properties,
  knownHints,
  onClose,
  onSaved,
}: {
  open: boolean
  databaseId: string
  expectedGeneration: number
  properties: DatabasePropertySummary[]
  knownHints: ReadonlyMap<string, string>
  onClose: () => void
  onSaved: () => void
}) {
  const { t } = useTranslation()
  const [template, setTemplate] = React.useState<DossierTemplate | null>(null)
  const [draft, setDraft] = React.useState<DossierLayout | null>(null)
  const [revision, setRevision] = React.useState<string | null>(null)
  const [created, setCreated] = React.useState<DatabasePropertySummary[]>([])
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const hintsRef = React.useRef(knownHints)
  hintsRef.current = knownHints

  React.useEffect(() => {
    if (!open) return undefined
    let cancelled = false
    setError(null)
    setCreated([])
    getDossierTemplate(databaseId)
      .then((read) => {
        if (cancelled) return
        setTemplate(read)
        setRevision(read.manifestRevision)
        setDraft(
          read.dossier ??
            layoutFromBody(read.body, hintsRef.current, t("creative.template.firstSection")),
        )
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(projectErrorText(t, caught))
      })
    return () => {
      cancelled = true
    }
  }, [databaseId, open, t])

  const all = React.useMemo(() => [...properties, ...created], [created, properties])
  const nameOf = (id: string) => all.find((property) => property.propertyId === id)?.name ?? id
  const problem = draft ? layoutProblem(draft) : null

  const createField = async (sectionId: string, name: string) => {
    if (!revision) return
    setError(null)
    try {
      const made = await createDatabaseProperty({
        expectedGeneration,
        databaseId,
        expectedManifestRevision: revision,
        name,
        propertyType: "text",
        beforePropertyId: null,
      })
      setRevision(made.manifestRevision)
      setCreated((previous) => [
        ...previous,
        {
          propertyId: made.propertyId,
          name: made.name,
          propertyType: made.propertyType,
          configJson: "{}",
          options: [],
        } as unknown as DatabasePropertySummary,
      ])
      setDraft((previous) => (previous ? addField(previous, sectionId, made.propertyId) : previous))
    } catch (caught) {
      setError(projectErrorText(t, caught))
    }
  }

  const save = async () => {
    if (!template || !draft || !revision || problem) return
    setBusy(true)
    setError(null)
    try {
      await updateDossierTemplate({
        expectedGeneration,
        databaseId,
        templateId: template.templateId,
        expectedManifestRevision: revision,
        dossier: draft,
      })
      onSaved()
      onClose()
    } catch (caught) {
      setError(projectErrorText(t, caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("creative.template.title")}</DialogTitle>
          <DialogDescription>{t("creative.template.description")}</DialogDescription>
        </DialogHeader>
        {draft && (
          <div className="flex flex-col gap-3">
            {draft.sections.map((section, index) => {
              const free = all.filter(
                (property) => fieldable(property) && !section.fields.includes(property.propertyId),
              )
              return (
                <div
                  key={section.id}
                  role="group"
                  aria-label={t("creative.template.section", { number: index + 1 })}
                  className="flex flex-col gap-2 rounded-lg border border-border/60 p-3"
                >
                  <div className="flex items-center gap-1">
                    <input
                      type="text"
                      value={section.title}
                      aria-label={t("creative.template.sectionTitle")}
                      className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-sm font-medium outline-none focus:border-ring"
                      onChange={(event) =>
                        setDraft(updateSection(draft, section.id, { title: event.target.value }))
                      }
                    />
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      aria-label={t("creative.template.up")}
                      title={t("creative.template.up")}
                      disabled={index === 0}
                      onClick={() => setDraft(moveSection(draft, index, -1))}
                    >
                      <ArrowUp aria-hidden="true" className="size-3.5" />
                    </Button>
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      aria-label={t("creative.template.down")}
                      title={t("creative.template.down")}
                      disabled={index === draft.sections.length - 1}
                      onClick={() => setDraft(moveSection(draft, index, 1))}
                    >
                      <ArrowDown aria-hidden="true" className="size-3.5" />
                    </Button>
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      aria-label={t("creative.template.removeSection", { name: section.title })}
                      title={t("creative.template.removeSection", { name: section.title })}
                      disabled={draft.sections.length === 1}
                      onClick={() => setDraft(removeSection(draft, section.id))}
                    >
                      <Trash2 aria-hidden="true" className="size-3.5" />
                    </Button>
                  </div>
                  <input
                    type="text"
                    value={section.hint}
                    aria-label={t("creative.template.hint")}
                    placeholder={t("creative.template.hintPlaceholder")}
                    className="h-7 min-w-0 rounded-md border border-transparent bg-muted/40 px-2 text-xs outline-none focus:border-ring"
                    onChange={(event) =>
                      setDraft(updateSection(draft, section.id, { hint: event.target.value }))
                    }
                  />
                  <div className="flex flex-wrap items-center gap-1">
                    <span className="text-[11px] text-muted-foreground">
                      {t("creative.template.fields")}
                    </span>
                    {section.fields.map((field) => (
                      <span
                        key={field}
                        className="inline-flex items-center gap-0.5 rounded-full bg-accent px-2 py-0.5 text-xs"
                      >
                        {nameOf(field)}
                        <button
                          type="button"
                          aria-label={t("creative.scene.remove", { name: nameOf(field) })}
                          className="-mr-1 rounded-full p-0.5 text-muted-foreground hover:text-foreground"
                          onClick={() => setDraft(removeField(draft, section.id, field))}
                        >
                          <X aria-hidden="true" className="size-3" />
                        </button>
                      </span>
                    ))}
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          type="button"
                          size="icon-sm"
                          variant="ghost"
                          className="size-6"
                          aria-label={t("creative.template.addField")}
                          title={t("creative.template.addField")}
                        >
                          <Plus aria-hidden="true" className="size-3.5" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent className="max-h-64 w-52 overflow-y-auto">
                        {free.length === 0 ? (
                          <DropdownMenuItem disabled>{t("creative.scene.nobody")}</DropdownMenuItem>
                        ) : (
                          free.map((property) => (
                            <DropdownMenuItem
                              key={property.propertyId}
                              onSelect={() =>
                                setDraft(addField(draft, section.id, property.propertyId))
                              }
                            >
                              <span className="truncate">{property.name}</span>
                            </DropdownMenuItem>
                          ))
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                    <NewFieldInput onCreate={(name) => createField(section.id, name)} />
                  </div>
                </div>
              )
            })}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="w-fit"
              onClick={() => setDraft(addSection(draft, ""))}
            >
              <Plus aria-hidden="true" className="size-3.5" />
              {t("creative.template.addSection")}
            </Button>
          </div>
        )}
        {problem && (
          <p className="text-xs text-muted-foreground">
            {t(`creative.template.problem.${problem}`)}
          </p>
        )}
        {error && <NoticeLine text={error} role="status" />}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            disabled={!draft || busy || problem !== null}
            onClick={() => void save()}
          >
            {t("creative.template.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
