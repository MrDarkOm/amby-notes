"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import { FilePlus2, FilePen, FileText } from "lucide-react"
import { aiProposalAction, ProposalError, type ProposalAction } from "@/lib/ai"
import type { ProposalCard } from "@/lib/bindings"
import { cn } from "@/lib/utils"
import { NoticeLine } from "../notices/notice-line"
import { useDocStore } from "../use-doc-store"
import { toRelativeVaultPath } from "../workspace-tree-utils"
import { unsavedVaultPaths } from "./unsaved-paths"
import { useProposalStore } from "./use-proposal-store"

/** The backend's stable codes that have their own wording; anything else is the general one. */
const KNOWN_ERRORS = new Set([
  "noteHasUnsavedEdits",
  "changedSince",
  "proposalNotFound",
  "proposalNotPending",
  "vaultNotActive",
])

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

function Card({
  card,
  chatId,
  generation,
  vault,
}: {
  card: ProposalCard
  chatId: string
  generation: number
  vault: string | null
}) {
  const { t } = useTranslation()
  const update = useProposalStore((state) => state.update)
  const [busy, setBusy] = React.useState(false)
  const [failure, setFailure] = React.useState<string | null>(null)
  const unsaved = useDocStore((state) => {
    for (const id of state.unsavedFileIds) {
      const path = state.openDocs[id]?.path
      if (path && toRelativeVaultPath(path, vault) === card.path) return true
    }
    return false
  })
  const run = async (action: ProposalAction) => {
    setBusy(true)
    setFailure(null)
    try {
      update(chatId, await aiProposalAction(action, generation, card.id, unsavedVaultPaths(vault)))
    } catch (cause) {
      const code = cause instanceof ProposalError ? cause.code : ""
      setFailure(KNOWN_ERRORS.has(code) ? code : "other")
    } finally {
      setBusy(false)
    }
  }
  const Icon = card.kind === "new" ? FilePlus2 : card.kind === "append" ? FileText : FilePen
  const button =
    "rounded-md border border-border px-2 py-0.5 text-xs hover:bg-accent disabled:opacity-40"
  return (
    <section
      aria-label={t("ai.proposal.title", { path: card.path })}
      className="flex flex-col gap-1.5 rounded-lg border border-border bg-card p-2.5 text-xs"
    >
      <div className="flex items-center gap-1.5">
        <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="truncate font-medium">{card.path}</span>
        <span className="ml-auto shrink-0 text-muted-foreground">
          {t(`ai.proposal.kind.${card.kind}`, { defaultValue: card.kind })}
        </span>
      </div>
      {(card.state === "pending" || card.state === "applied") && <DiffView diff={card.diff} />}
      {card.diffTruncated && (card.state === "pending" || card.state === "applied") && (
        <p className="text-muted-foreground">{t("ai.proposal.truncated")}</p>
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
            <span className="text-muted-foreground">{t("ai.proposal.state.applied")}</span>
            <button
              type="button"
              disabled={busy || unsaved}
              onClick={() => void run("undo")}
              className={button}
            >
              {t("ai.proposal.undo")}
            </button>
          </>
        )}
        {card.state !== "pending" && card.state !== "applied" && (
          <span className="text-muted-foreground">{t(`ai.proposal.state.${card.state}`)}</span>
        )}
      </div>
    </section>
  )
}

/** The changes the AI proposed in this chat, newest last. */
export function ProposalCards({
  chatId,
  generation,
  vault,
}: {
  chatId: string
  generation: number
  vault: string | null
}) {
  const cards = useProposalStore((state) => state.cards[chatId])
  if (!cards?.length) return null
  return (
    <div className="flex flex-col gap-2">
      {cards.map((card) => (
        <Card key={card.id} card={card} chatId={chatId} generation={generation} vault={vault} />
      ))}
    </div>
  )
}
