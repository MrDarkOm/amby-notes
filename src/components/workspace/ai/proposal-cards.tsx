"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import { Archive, FilePlus2, FilePen, FileText, FolderInput, Pencil, Trash2 } from "lucide-react"
import { aiProposalAction, ProposalError, type ProposalAction } from "@/lib/ai"
import { cn } from "@/lib/utils"
import { NoticeLine } from "../notices/notice-line"
import { useDocStore } from "../use-doc-store"
import { toRelativeVaultPath } from "../workspace-tree-utils"
import { isAffected, unsavedVaultPaths } from "./unsaved-paths"
import { isStructuralKind, useProposalStore, type PlacedCard } from "./use-proposal-store"

/** The backend's stable codes that have their own wording; anything else is the general one. */
const KNOWN_ERRORS = new Set([
  "noteHasUnsavedEdits",
  "changedSince",
  "proposalNotFound",
  "proposalNotPending",
  "vaultNotActive",
  "propertiesNotMigrated",
  "revisionConflict",
  "moduleDisabled",
  "invalidValue",
  "databaseLocked",
  "mutationConflict",
  "vaultBusy",
  "trashUnavailable",
  "undoUnavailable",
  "operationTooLarge",
  "recoveryRequired",
])

/** Backend codes that share the wording of another. */
const ALIAS: Record<string, string> = {
  readOnly: "databaseLocked",
  locked: "databaseLocked",
  unsupportedProperty: "invalidValue",
}

/** The card names its file as the tree does: the last part of the path, without `.md`. */
function fileName(path: string) {
  return (path.split("/").pop() || path).replace(/\.md$/i, "")
}

function DiffView({ diff }: { diff: string }) {
  const lines = diff
    .split("\n")
    .filter(
      (line) =>
        !line.startsWith("---") && !line.startsWith("+++") && !line.startsWith("\\ No newline"),
    )
  return (
    <pre className="max-h-48 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-[11px] leading-snug">
      {lines.map((line, index) => (
        <div
          key={index}
          className={cn(
            "whitespace-pre-wrap break-words",
            line.startsWith("+") && "bg-[color:var(--notice-success-bg)]",
            line.startsWith("-") && "bg-[color:var(--notice-danger-bg)]",
            line.startsWith("@@") && "text-muted-foreground",
          )}
        >
          {line || " "}
        </div>
      ))}
    </pre>
  )
}

/** The files a structural change touches, as a plain list under the diff. */
function AffectedList({ card }: { card: PlacedCard }) {
  const { t } = useTranslation()
  if (!card.affected.length) return null
  return (
    <>
      <ul
        aria-label={t("ai.proposal.affected")}
        className="max-h-32 list-none overflow-auto rounded-md bg-muted/30 p-2 font-mono text-[11px] leading-snug"
      >
        {card.affected.map((path) => (
          <li key={path} className="break-all">
            {path}
          </li>
        ))}
      </ul>
      {card.affectedTruncated && (
        <p className="text-muted-foreground">{t("ai.proposal.affectedMore")}</p>
      )}
    </>
  )
}

function Card({
  card,
  chatId,
  generation,
  vault,
  archiveDeletes,
}: {
  card: PlacedCard
  chatId: string
  generation: number
  vault: string | null
  archiveDeletes: boolean
}) {
  const { t } = useTranslation()
  const update = useProposalStore((state) => state.update)
  const [busy, setBusy] = React.useState(false)
  const [failure, setFailure] = React.useState<string | null>(null)
  const unsaved = useDocStore((state) => {
    for (const id of state.unsavedFileIds) {
      const path = state.openDocs[id]?.path
      if (!path) continue
      const relative = toRelativeVaultPath(path, vault)
      // A move, rename or deletion also covers what is inside the item and the notes whose
      // links it rewrites.
      if (relative === card.path || isAffected(relative, card.affected)) return true
    }
    return false
  })
  const structural = isStructuralKind(card.kind)
  const run = async (action: ProposalAction) => {
    setBusy(true)
    setFailure(null)
    try {
      const paths = unsavedVaultPaths(vault)
      // A deletion follows the deletion setting (the system trash, or the archive; never for good).
      update(
        chatId,
        action === "apply" && card.kind === "delete"
          ? await aiProposalAction(
              action,
              generation,
              card.id,
              paths,
              archiveDeletes ? "archive" : "system",
            )
          : await aiProposalAction(action, generation, card.id, paths),
      )
    } catch (cause) {
      const code = cause instanceof ProposalError ? cause.code : ""
      const known = ALIAS[code] ?? code
      const shown = known === "changedSince" && structural ? "changedSinceStructural" : known
      setFailure(KNOWN_ERRORS.has(known) ? shown : "other")
    } finally {
      setBusy(false)
    }
  }
  // A card made under Automatic or Without stops applies as soon as its note has no unsaved edits.
  const attempted = React.useRef(false)
  React.useEffect(() => {
    if (card.auto && card.state === "pending" && !unsaved && !attempted.current) {
      attempted.current = true
      void run("apply")
    }
    // `run` only closes over the card and the vault, which this effect already follows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card.auto, card.state, unsaved])
  const Icon =
    card.kind === "new"
      ? FilePlus2
      : card.kind === "append"
        ? FileText
        : card.kind === "move"
          ? FolderInput
          : card.kind === "rename"
            ? Pencil
            : card.kind === "archive"
              ? Archive
              : card.kind === "delete"
                ? Trash2
                : FilePen
  const button =
    "rounded-md border border-border px-2 py-0.5 text-xs hover:bg-accent disabled:opacity-40"
  return (
    <section
      aria-label={t("ai.proposal.title", { path: card.path })}
      className="flex flex-col gap-1.5 rounded-lg border border-border bg-card p-2.5 text-xs"
    >
      <div className="flex items-center gap-1.5">
        <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span title={card.path} className="truncate font-medium">
          {fileName(card.path)}
        </span>
        <span className="ml-auto shrink-0 text-muted-foreground">
          {t(`ai.proposal.kind.${card.kind}`, { defaultValue: card.kind })}
        </span>
      </div>
      {(card.state === "pending" || card.state === "applied") && <DiffView diff={card.diff} />}
      {card.diffTruncated && (card.state === "pending" || card.state === "applied") && (
        <p className="text-muted-foreground">{t("ai.proposal.truncated")}</p>
      )}
      {(card.state === "pending" || card.state === "applied") && <AffectedList card={card} />}
      {card.state === "pending" && card.kind === "delete" && (
        <p role="note" className="text-muted-foreground">
          {t(archiveDeletes ? "ai.proposal.deleteWarningArchive" : "ai.proposal.deleteWarning")}
        </p>
      )}
      {card.state === "pending" && unsaved && (
        <p role="status" className="text-muted-foreground">
          {t("ai.proposal.waitForSave")}
        </p>
      )}
      {failure && <NoticeLine role="alert" text={t(`ai.proposal.error.${failure}`)} />}
      <div className="flex items-center gap-1.5">
        {card.state === "pending" && (
          <>
            <button
              type="button"
              disabled={busy || unsaved}
              onClick={() => void run("apply")}
              className={cn(button, "bg-primary text-primary-foreground hover:bg-primary/90")}
            >
              {t("ai.proposal.apply")}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void run("reject")}
              className={button}
            >
              {t("ai.proposal.reject")}
            </button>
          </>
        )}
        {card.state === "applied" && (
          <>
            <span className="text-muted-foreground">
              {t(
                card.kind === "delete" && !card.canUndo
                  ? "ai.proposal.state.appliedDelete"
                  : card.kind === "createDatabaseRow"
                    ? "ai.proposal.state.appliedRow"
                    : card.kind === "setDatabaseValue"
                      ? "ai.proposal.state.appliedCell"
                      : structural
                        ? "ai.proposal.state.appliedStructural"
                        : "ai.proposal.state.applied",
              )}
            </span>
            {card.canUndo && (
              <button
                type="button"
                disabled={busy || unsaved}
                onClick={() => void run("undo")}
                className={button}
              >
                {t("ai.proposal.undo")}
              </button>
            )}
          </>
        )}
        {card.state !== "pending" && card.state !== "applied" && (
          <span className="text-muted-foreground">
            {t(
              card.state === "outdated" && structural
                ? "ai.proposal.state.outdatedStructural"
                : `ai.proposal.state.${card.state}`,
            )}
          </span>
        )}
      </div>
    </section>
  )
}

/** The changes the AI proposed in this chat that `show` selects, in the order they were made. */
export function ProposalCards({
  chatId,
  generation,
  vault,
  show,
  archiveDeletes = false,
}: {
  chatId: string
  generation: number
  vault: string | null
  show: (at: number) => boolean
  /** The deletion setting is the archive (a deletion can be undone), not the system trash. */
  archiveDeletes?: boolean
}) {
  const cards = useProposalStore((state) => state.cards[chatId])
  const mine = cards?.filter((card) => show(card.at))
  if (!mine?.length) return null
  return (
    <div className="mt-2 flex flex-col gap-2">
      {mine.map((card) => (
        <Card
          key={card.id}
          card={card}
          chatId={chatId}
          generation={generation}
          vault={vault}
          archiveDeletes={archiveDeletes}
        />
      ))}
    </div>
  )
}
