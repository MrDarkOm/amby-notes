"use client"

import type { ReactNode } from "react"
import { useTranslation } from "react-i18next"
import {
  Check,
  Copy,
  FilePen,
  FilePlus2,
  FileText,
  FolderOpen,
  Link2,
  RotateCcw,
  Search,
} from "lucide-react"
import { MotionPulse } from "@/lib/motion"
import { cn } from "@/lib/utils"
import type { ChatMessage, ChatStep, TreeItem } from "@/lib/storage"
import { openWebAddressInBrowser } from "../tiptap/external-open"
import { toRelativeVaultPath } from "../workspace-tree-utils"
import { renderChatMarkdown } from "./chat-markdown"

export function AiMarkdown({
  content,
  items,
  vault,
  onSelect,
}: {
  content: string
  items: TreeItem[]
  vault: string | null
  onSelect: (id: string) => void
}) {
  return (
    <div
      className="ai-chat-markdown"
      onClick={(event) => {
        const target = event.target
        if (!(target instanceof Element)) return
        const link = target.closest("a")
        if (!link) return
        event.preventDefault()
        const href = link.getAttribute("href") ?? ""
        if (/^https?:\/\//i.test(href)) {
          void openWebAddressInBrowser(href)
          return
        }
        let address: string
        try {
          address = decodeURIComponent(href).split("#")[0]
        } catch {
          return
        }
        const match = items.find(
          (item) =>
            item.type === "file" &&
            (toRelativeVaultPath(item.path, vault) === address ||
              item.name === address ||
              item.name.replace(/\.md$/i, "") === address.replace(/\.md$/i, "")),
        )
        if (match) onSelect(match.id)
      }}
      dangerouslySetInnerHTML={{ __html: renderChatMarkdown(content) }}
    />
  )
}

/** The question: a thin plate on the right, not a speech bubble. */
export function UserMessage({ text }: { text: string }) {
  return (
    <div className="max-w-[88%] select-text self-end whitespace-pre-wrap break-words rounded-xl bg-muted px-3 py-1.5 text-[13px] leading-relaxed text-foreground">
      {text}
    </div>
  )
}

/** Tools that propose a change; their step says a change was prepared, the card says the rest. */
const PROPOSING_TOOLS = new Set([
  "new_note",
  "append_note",
  "edit_note",
  "set_property",
  "delete_property",
  "rename_property",
  "create_database_row",
  "set_database_value",
  "move_item",
  "rename_item",
  "archive_item",
  "delete_item",
])

const STEP_KEYS: Record<string, string> = {
  search_notes: "searching",
  read_note: "reading",
  list_folder: "listing",
  get_links: "linking",
  get_outline: "outlining",
  read_section: "readingSection",
  get_properties: "readingProperties",
  get_note_info: "readingInfo",
  list_versions: "readingHistory",
  read_version: "readingVersion",
  list_tags: "listingTags",
  list_databases: "listingDatabases",
  read_database: "readingDatabase",
  query_database: "readingDatabase",
  ...Object.fromEntries([...PROPOSING_TOOLS].map((tool) => [tool, "proposing"])),
}

/** A note path or file name as a title: the last segment without the Markdown extension. */
function stepLabel(query: string): string {
  const name = query.split("/").filter(Boolean).pop() ?? query
  return name.replace(/\.md$/i, "")
}

function StepIcon({ tool }: { tool: string }) {
  const className = "size-3.5 shrink-0"
  if (tool === "search_notes") return <Search className={className} aria-hidden="true" />
  if (tool === "list_folder") return <FolderOpen className={className} aria-hidden="true" />
  if (tool === "get_links") return <Link2 className={className} aria-hidden="true" />
  if (PROPOSING_TOOLS.has(tool)) return <FilePen className={className} aria-hidden="true" />
  return <FileText className={className} aria-hidden="true" />
}

/** One quiet line per tool step; the notes it touched open on expand. */
/** Failures that have their own wording; every other one is the general line. */
const STEP_ERROR_KEYS: Record<string, string> = {
  indexTooLarge: "ai.indexTooLarge",
  // The notes the AI may read are the ones in the context, or all of them with search on.
  accessDenied: "ai.toolOutsideContext",
  notFound: "ai.toolNotFound",
}

export function StepLine({
  step,
  items,
  onSelect,
  running = false,
}: {
  step: ChatStep
  items: TreeItem[]
  onSelect: (id: string) => void
  running?: boolean
}) {
  const { t } = useTranslation()
  const label = items.find((item) => item.id === step.query)?.name ?? stepLabel(step.query)
  const key = STEP_KEYS[step.tool] ?? "toolOther"
  return (
    <details className="group/step text-xs text-muted-foreground">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 py-0.5 hover:text-foreground [&::-webkit-details-marker]:hidden">
        <StepIcon tool={step.tool} />
        <span className="min-w-0 truncate">
          {step.error
            ? t(STEP_ERROR_KEYS[step.error] ?? "ai.toolFailed", { query: label })
            : t(`ai.${key}`, { query: label, count: step.noteIds.length, tool: step.tool })}
        </span>
        {running && (
          <MotionPulse className="ml-1 size-1.5 shrink-0 rounded-full bg-muted-foreground" />
        )}
      </summary>
      <div className="flex flex-wrap gap-1 pb-1 pl-5 pt-0.5">
        {step.noteIds.map((id) => {
          const item = items.find((candidate) => candidate.id === id && candidate.type === "file")
          return (
            <button
              key={id}
              type="button"
              disabled={!item}
              onClick={() => onSelect(id)}
              className="rounded-full border border-border px-2 py-0.5 text-[11px] hover:bg-accent disabled:opacity-50"
            >
              {item?.name ?? id}
            </button>
          )
        })}
      </div>
    </details>
  )
}

/** The answer: plain text across the whole width, sources and quiet actions under it. */
export function AssistantAnswer({
  message,
  items,
  vault,
  onSelect,
  copied,
  busy,
  onCopy,
  onRetry,
  onSaveAsNote,
  children,
}: {
  message: ChatMessage
  items: TreeItem[]
  vault: string | null
  onSelect: (id: string) => void
  copied: boolean
  busy: boolean
  onCopy: () => void
  onRetry: () => void
  onSaveAsNote?: () => void
  /** What belongs under this answer, such as the changes it proposed. */
  children?: ReactNode
}) {
  const { t } = useTranslation()
  const action =
    "rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
  return (
    <div className="select-text break-words text-[14px] leading-[1.65] text-foreground">
      {message.steps.length > 0 && (
        <div className="mb-2 flex flex-col">
          {message.steps.map((step, index) => (
            <StepLine key={index} step={step} items={items} onSelect={onSelect} />
          ))}
        </div>
      )}
      <AiMarkdown content={message.content} items={items} vault={vault} onSelect={onSelect} />
      {message.sources.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {message.sources.map((source, index) => (
            <button
              key={source.id}
              type="button"
              disabled={!items.some((item) => item.id === source.id && item.type === "file")}
              onClick={() => onSelect(source.id)}
              className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border px-2.5 py-0.5 text-xs hover:bg-accent disabled:opacity-50"
            >
              <span className="text-primary">{index + 1}</span>
              <span className="truncate">{source.title}</span>
            </button>
          ))}
        </div>
      )}
      {children}
      <div className="-ml-1 mt-1.5 flex gap-0.5">
        <button
          type="button"
          title={copied ? t("ai.copied") : t("ai.copy")}
          aria-label={t("ai.copy")}
          onClick={onCopy}
          className={action}
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        </button>
        <button
          type="button"
          title={t("ai.retry")}
          aria-label={t("ai.retry")}
          disabled={busy}
          onClick={onRetry}
          className={action}
        >
          <RotateCcw className="size-3.5" />
        </button>
        {onSaveAsNote && (
          <button
            type="button"
            title={t("ai.saveAsNote")}
            aria-label={t("ai.saveAsNote")}
            onClick={onSaveAsNote}
            className={action}
          >
            <FilePlus2 className="size-3.5" />
          </button>
        )}
      </div>
    </div>
  )
}

/** The answer while it is still being written. */
export function LiveAnswer({
  steps,
  status,
  streaming,
  items,
  vault,
  onSelect,
}: {
  steps: ChatStep[]
  status: string
  streaming: string
  items: TreeItem[]
  vault: string | null
  onSelect: (id: string) => void
}) {
  const { t } = useTranslation()
  return (
    <div className={cn("select-text break-words text-[14px] leading-[1.65] text-foreground")}>
      {(steps.length > 0 || status) && (
        <div className="mb-2 flex flex-col">
          {steps.map((step, index) => (
            <StepLine key={index} step={step} items={items} onSelect={onSelect} />
          ))}
          {status && (
            <p className="flex items-center gap-1.5 py-0.5 text-xs text-muted-foreground">
              <MotionPulse className="size-1.5 rounded-full bg-muted-foreground" />
              {t("ai.toolOther", { tool: status })}
            </p>
          )}
        </div>
      )}
      {streaming ? (
        <AiMarkdown content={streaming} items={items} vault={vault} onSelect={onSelect} />
      ) : (
        <span className="inline-flex items-center gap-2 text-muted-foreground">
          <MotionPulse className="size-1.5 rounded-full bg-muted-foreground" />
          {t("ai.thinking")}
        </span>
      )}
    </div>
  )
}
