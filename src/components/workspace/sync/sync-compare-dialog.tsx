import * as React from "react"
import { useTranslation } from "react-i18next"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { errorType, logger } from "@/lib/logger"
import { syncErrorMessage } from "@/lib/sync/sync-errors"
import type { ConflictChoice, ConflictVersions, SyncPort } from "@/lib/sync/sync-port"
import { markdownToSafeReadonlyHtml } from "../tiptap/markdown"
import {
  assembleCompare,
  planBlockCompare,
  type BlockCompare,
  type CompareChoice,
  type CompareHunk,
  type CompareRow,
} from "./compare/block-compare"
import type { SyncConflict } from "./use-sync-notices-store"

/**
 * The two versions of a conflict side by side (Р7, stage Э4б К4). A note is drawn as a note, read only,
 * with the blocks that differ marked and a choice for each: mine, the other, both. “Done” puts the
 * result together from the source text of the chosen blocks and gives it to the port, so what nobody
 * touched stays byte for byte. A version Live Preview cannot take is shown as source; a file that is not
 * a note is chosen as a whole. The window of the external changes of the editor is tied to an open,
 * edited buffer, so this one only reads the versions through the port and resolves through it.
 */
export function SyncCompareDialog({
  port,
  conflict,
  onClose,
}: {
  port: SyncPort
  conflict: SyncConflict
  vault?: string
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [loaded, setLoaded] = React.useState<ConflictVersions | null>(null)
  const [loadFailed, setLoadFailed] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [choices, setChoices] = React.useState<CompareChoice[]>([])

  React.useEffect(() => {
    let alive = true
    setLoaded(null)
    setLoadFailed(false)
    port
      .readConflictVersions(conflict.id)
      .then((versions) => alive && setLoaded(versions))
      .catch((caught) => {
        logger.warn("sync.compare_read_failed", { errorType: errorType(caught) })
        if (alive) setLoadFailed(true)
      })
    return () => {
      alive = false
    }
  }, [port, conflict.id])

  const plan = React.useMemo(
    () => (loaded ? planBlockCompare(conflict.originalPath, loaded.original, loaded.copy) : null),
    [loaded, conflict.originalPath],
  )
  React.useEffect(() => {
    setChoices(plan?.kind === "blocks" ? plan.hunks.map(() => "mine") : [])
  }, [plan])

  const guard = async (action: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await action()
      onClose()
    } catch (caught) {
      setError(syncErrorMessage(caught, t))
      setBusy(false)
    }
  }
  const resolve = (choice: ConflictChoice) => guard(() => port.resolveConflict(conflict.id, choice))
  const finish = (blocks: BlockCompare) =>
    guard(() => port.resolveConflictWithText(conflict.id, assembleCompare(blocks, choices)))

  const text = (value: string | null | undefined) =>
    value === undefined ? t("sync.notices.loading") : (value ?? t("sync.notices.notText"))
  const whole = (title: string, path: string, value: string | null | undefined) => (
    <section className="flex min-w-0 flex-col rounded-md border">
      <h3 className="border-b px-3 py-2 text-sm font-medium">{title}</h3>
      <p className="break-all border-b px-3 py-1 text-[11px] text-muted-foreground">{path}</p>
      <pre className="max-h-72 min-h-24 flex-1 overflow-auto whitespace-pre-wrap p-3 text-xs">
        {loadFailed ? "" : text(value)}
      </pre>
    </section>
  )

  const blocks = plan?.kind === "blocks" ? plan : null
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogContent
        showCloseButton={!busy}
        className="max-h-[calc(100vh-3rem)] overflow-y-auto sm:max-w-5xl"
      >
        <DialogHeader>
          <DialogTitle>{t("sync.notices.compareTitle")}</DialogTitle>
          <DialogDescription>{t("sync.notices.compareDescription")}</DialogDescription>
        </DialogHeader>

        {blocks ? (
          <BlockView
            plan={blocks}
            conflict={conflict}
            choices={choices}
            disabled={busy}
            onChoose={(id, choice) =>
              setChoices((list) => list.map((item, index) => (index === id ? choice : item)))
            }
          />
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {whole(t("sync.notices.originalVersion"), conflict.originalPath, loaded?.original)}
            {whole(t("sync.notices.copyVersion"), conflict.copyPath, loaded?.copy)}
          </div>
        )}

        {loadFailed && (
          <p role="alert" className="text-sm text-destructive">
            {t("sync.notices.loadFailed")}
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {blocks && (
            <Button type="button" disabled={busy} onClick={() => void finish(blocks)}>
              {t("sync.notices.compareDone")}
            </Button>
          )}
          {(
            [
              ["keepOriginal", "sync.vault.conflicts.keepOriginal"],
              ["keepCopy", "sync.vault.conflicts.keepCopy"],
              ["keepBoth", "sync.vault.conflicts.keepBoth"],
            ] as const
          ).map(([choice, key]) => (
            <Button
              key={choice}
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => void resolve(choice)}
            >
              {t(key)}
            </Button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">{t("sync.vault.conflicts.hint")}</p>
      </DialogContent>
    </Dialog>
  )
}

function BlockView({
  plan,
  conflict,
  choices,
  disabled,
  onChoose,
}: {
  plan: BlockCompare
  conflict: SyncConflict
  choices: CompareChoice[]
  disabled: boolean
  onChoose: (id: number, choice: CompareChoice) => void
}) {
  const { t } = useTranslation()
  return (
    <div data-testid={plan.live ? "compare-live" : "compare-source"} className="space-y-2">
      <p data-testid="compare-hunk-count" className="text-xs text-muted-foreground">
        {plan.hunks.length === 0
          ? t("sync.notices.noDifferences")
          : t("sync.notices.differences", { count: plan.hunks.length })}
        {plan.live ? "" : ` · ${t("sync.notices.sourceView")}`}
      </p>
      <div className="grid grid-cols-2 gap-3 text-sm font-medium">
        <h3>{t("sync.notices.originalVersion")}</h3>
        <h3>{t("sync.notices.copyVersion")}</h3>
      </div>
      <p className="grid grid-cols-2 gap-3 break-all text-[11px] text-muted-foreground">
        <span>{conflict.originalPath}</span>
        <span>{conflict.copyPath}</span>
      </p>
      <div className="max-h-[55vh] space-y-2 overflow-y-auto">
        {plan.rows.map((row, index) => (
          <Row
            key={index}
            row={row}
            live={plan.live}
            choice={row.kind === "hunk" ? choices[row.hunk.id] : undefined}
            disabled={disabled}
            onChoose={onChoose}
          />
        ))}
      </div>
    </div>
  )
}

function Rendered({ blocks, live }: { blocks: string[]; live: boolean }) {
  if (blocks.length === 0) return <p className="text-xs italic text-muted-foreground">—</p>
  if (!live) {
    return <pre className="overflow-auto whitespace-pre-wrap text-xs">{blocks.join("\n\n")}</pre>
  }
  return (
    <div className="amby-tiptap compare-note">
      <div
        className="ProseMirror"
        dangerouslySetInnerHTML={{ __html: markdownToSafeReadonlyHtml(blocks.join("\n\n")) }}
      />
    </div>
  )
}

function Row({
  row,
  live,
  choice,
  disabled,
  onChoose,
}: {
  row: CompareRow
  live: boolean
  choice: CompareChoice | undefined
  disabled: boolean
  onChoose: (id: number, choice: CompareChoice) => void
}) {
  if (row.kind === "same") {
    return (
      <div className="grid grid-cols-2 gap-3 px-2">
        <Rendered blocks={row.blocks} live={live} />
        <Rendered blocks={row.blocks} live={live} />
      </div>
    )
  }
  return (
    <HunkRow
      hunk={row.hunk}
      live={live}
      choice={choice ?? "mine"}
      disabled={disabled}
      onChoose={onChoose}
    />
  )
}

function HunkRow({
  hunk,
  live,
  choice,
  disabled,
  onChoose,
}: {
  hunk: CompareHunk
  live: boolean
  choice: CompareChoice
  disabled: boolean
  onChoose: (id: number, choice: CompareChoice) => void
}) {
  const { t } = useTranslation()
  const options: Array<[CompareChoice, string]> = [
    ["mine", t("sync.notices.choiceMine")],
    ["other", t("sync.notices.choiceOther")],
    ...(hunk.bothAllowed
      ? ([["both", t("sync.notices.choiceBoth")]] as Array<[CompareChoice, string]>)
      : []),
  ]
  return (
    <div data-testid="compare-hunk" className="compare-hunk rounded-md border p-2">
      {hunk.kind === "properties" && (
        <p className="mb-1 text-[11px] font-medium text-muted-foreground">
          {t("sync.notices.propertiesDifference")}
        </p>
      )}
      <div className="grid grid-cols-2 gap-3">
        <div className="compare-hunk-side rounded px-2">
          <Rendered blocks={hunk.mine} live={live && hunk.kind === "blocks"} />
        </div>
        <div className="compare-hunk-side rounded px-2">
          <Rendered blocks={hunk.other} live={live && hunk.kind === "blocks"} />
        </div>
      </div>
      <div
        role="radiogroup"
        aria-label={t("sync.notices.chooseFor")}
        className="mt-2 flex flex-wrap items-center gap-3 text-xs"
      >
        {options.map(([value, label]) => (
          <label key={value} className="flex items-center gap-1.5">
            <input
              type="radio"
              name={`compare-hunk-${hunk.id}`}
              checked={choice === value}
              disabled={disabled || (hunk.locked && value !== "mine")}
              onChange={() => onChoose(hunk.id, value)}
            />
            {label}
          </label>
        ))}
        {hunk.locked && (
          <span className="text-muted-foreground">{t("sync.notices.identityLocked")}</span>
        )}
      </div>
    </div>
  )
}
