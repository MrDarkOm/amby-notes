import * as React from "react"
import { Camera } from "lucide-react"
import { useTranslation } from "react-i18next"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { NoticeLine } from "@/components/workspace/notices/notice-line"
import {
  applyDatabaseValueBatch,
  importDatabaseAsset,
  pickAssetFile,
  type DatabaseNoteContext,
} from "@/lib/storage"
import { projectErrorText } from "@/lib/operation-errors"
import { cn } from "@/lib/utils"
import type { CoverResolver } from "../../database/layouts/cover-resolver"
import { GalleryCover } from "../../database/layouts/gallery-cover"
import type { GalleryPreview } from "../../database/layouts/gallery-preview"
import { PortraitDot } from "../workshop/portrait-dot"
import { initialsOf } from "../workshop/workshop-model"

/**
 * The picture of a dossier: a character's round portrait, or another page's cover. With a files
 * property and a page that can be edited, a click picks an image (copied next to the note by the
 * database's own import) and writes it as the property's value with the row's revision; the menu
 * of a set picture changes or removes it. Removing clears the value only: the picture file stays.
 */
export function PortraitControl({
  context,
  preview,
  resolver,
  round,
  locked,
}: {
  context: DatabaseNoteContext
  preview: GalleryPreview
  resolver: CoverResolver
  /** A character's face (a circle with initials) rather than a cover. */
  round: boolean
  locked?: boolean
}) {
  const { t } = useTranslation()
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const property = context.properties.find((candidate) => candidate.propertyType === "files")
  const editable = Boolean(property) && !locked && !context.locked
  const hasPicture = preview.kind === "asset"
  const word = round ? "portrait" : "image"

  const write = async (valueJson: string | undefined) => {
    if (!property) return
    await applyDatabaseValueBatch({
      expectedGeneration: context.vaultGeneration,
      databaseId: context.databaseId,
      operationId: `portrait-${crypto.randomUUID()}`,
      cells: [
        {
          noteId: context.row.noteId,
          propertyId: property.propertyId,
          expectedRevision: context.row.rowRevision,
          ...(valueJson === undefined ? {} : { valueJson }),
        },
      ],
    })
  }
  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (caught) {
      setError(projectErrorText(t, caught))
    } finally {
      setBusy(false)
    }
  }
  const choose = () =>
    run(async () => {
      const sourcePath = await pickAssetFile(true)
      if (!sourcePath) return
      const asset = await importDatabaseAsset({
        expectedGeneration: context.vaultGeneration,
        databaseId: context.databaseId,
        noteId: context.row.noteId,
        sourcePath,
      })
      await write(
        JSON.stringify({
          type: "files",
          items: [
            {
              assetId: asset.assetId,
              kind: "asset",
              relativePath: asset.relativePath,
              name: asset.name,
              mimeType: asset.mimeType,
              sizeBytes: asset.sizeBytes,
            },
          ],
        }),
      )
    })
  const remove = () => run(() => write(undefined))

  const picture = round ? (
    <PortraitDot
      relativePath={hasPicture ? preview.relativePath : null}
      resolver={resolver}
      initials={initialsOf(context.row.title)}
      className="size-24 text-2xl"
    />
  ) : hasPicture ? (
    <div className="w-full overflow-hidden rounded-xl border border-border/60 sm:w-48">
      <GalleryCover preview={preview} resolver={resolver} size="large" />
    </div>
  ) : null

  const badge = (
    <span
      aria-hidden="true"
      className="absolute bottom-0 right-0 flex size-7 items-center justify-center rounded-full border border-border bg-background text-muted-foreground opacity-0 shadow-sm group-hover:opacity-100 group-focus-visible:opacity-100"
    >
      <Camera className="size-3.5" />
    </span>
  )

  let control: React.ReactNode = picture
  if (editable && !hasPicture) {
    control = round ? (
      <button
        type="button"
        disabled={busy}
        aria-label={t(`creative.dossier.${word}.add`)}
        title={t(`creative.dossier.${word}.add`)}
        onClick={() => void choose()}
        className="group relative shrink-0 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {picture}
        {badge}
      </button>
    ) : (
      <button
        type="button"
        disabled={busy}
        onClick={() => void choose()}
        className="flex h-24 w-full shrink-0 items-center justify-center gap-2 rounded-xl border border-dashed border-border text-xs text-muted-foreground outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring sm:w-48"
      >
        <Camera aria-hidden="true" className="size-4" />
        {t(`creative.dossier.${word}.add`)}
      </button>
    )
  } else if (editable && hasPicture) {
    control = (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={busy}
            aria-label={t(`creative.dossier.${word}.label`)}
            className={cn(
              "group relative shrink-0 outline-none focus-visible:ring-2 focus-visible:ring-ring",
              round ? "rounded-full" : "w-full rounded-xl sm:w-48",
            )}
          >
            {picture}
            {badge}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onSelect={() => void choose()}>
            {t(`creative.dossier.${word}.change`)}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void remove()}>
            {t(`creative.dossier.${word}.remove`)}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    )
  }

  if (!control) return null
  return (
    <div className="flex shrink-0 flex-col gap-1">
      {control}
      {error && <NoticeLine text={error} role="status" />}
    </div>
  )
}
