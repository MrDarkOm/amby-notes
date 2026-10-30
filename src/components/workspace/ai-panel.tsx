"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import {
  ArrowLeft,
  Copy,
  FilePlus2,
  FileText,
  Folder,
  History,
  Plus,
  RotateCcw,
  Send,
  Settings2,
  Square,
  X,
} from "lucide-react"
import { AmbySelect } from "@/components/ui/amby-select"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  aiErrorMessage,
  aiRunTurn,
  aiSearchConsent,
  aiSetSearchConsent,
  type AiTurnEvent,
} from "@/lib/ai"
import type { AiModel } from "./app-config"
import {
  DEFAULT_AI,
  findProvider,
  isCodexModel,
  isLocalAiModel,
  loadSettings,
  modelSupportsTools,
  resolveAiConfig,
  saveSettingsPatch,
  type AiSettings,
} from "./app-config"
import { useDocStore } from "./use-doc-store"
import { useVaultStore } from "./use-vault-store"
import { ModelsManager } from "./models-manager"
import type { PanelRenderProps } from "./panel-registry"
import { PanelHeader } from "./panels/panel-header"
import { openWebAddressInBrowser } from "./tiptap/external-open"
import { toRelativeVaultPath } from "./workspace-tree-utils"
import {
  allContextItems,
  buildAttachedContext,
  currentContext,
  MAX_ATTACHED_CHARS,
} from "./ai/context"
import { renderChatMarkdown } from "./ai/chat-markdown"
import { ChatList } from "./ai/chat-list"
import { useAiChatStore } from "./ai/use-ai-chat-store"
import {
  searchNotes,
  type Chat,
  type ChatMessage,
  type ChatSource,
  type ChatStep,
  type TreeItem,
} from "@/lib/storage"
import { cn } from "@/lib/utils"

interface RunningTurn {
  controller: AbortController
  generation: number
  chat: Chat
  partial: string
  steps: ChatStep[]
  sources: ChatSource[]
  finalized: boolean
}
interface ConsentPrompt {
  text: string
  model: AiModel
  chatId: string
  generation: number
  fromInput: boolean
}

function AiMarkdown({
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

function StepView({
  step,
  items,
  onSelect,
}: {
  step: ChatStep
  items: TreeItem[]
  onSelect: (id: string) => void
}) {
  const { t } = useTranslation()
  const label = items.find((item) => item.id === step.query)?.name ?? step.query
  const key =
    step.tool === "search_notes"
      ? "searching"
      : step.tool === "read_note"
        ? "reading"
        : step.tool === "list_folder"
          ? "listing"
          : step.tool === "get_links"
            ? "linking"
            : "toolOther"
  return (
    <details className="text-[11px] text-muted-foreground">
      <summary className="cursor-pointer">
        {step.error
          ? t(step.error === "indexTooLarge" ? "ai.indexTooLarge" : "ai.toolFailed")
          : t(`ai.${key}`, { query: label, count: step.noteIds.length, tool: step.tool })}
      </summary>
      <div className="flex flex-wrap gap-1 py-1">
        {step.noteIds.map((id) => {
          const item = items.find((candidate) => candidate.id === id && candidate.type === "file")
          return (
            <button
              key={id}
              type="button"
              disabled={!item}
              onClick={() => onSelect(id)}
              className="rounded bg-muted px-1.5 py-0.5 disabled:opacity-50"
            >
              {item?.name ?? id}
            </button>
          )
        })}
      </div>
    </details>
  )
}

export function AiPanel({
  currentDocId,
  treeItems,
  vault,
  onSelect,
  onCreateNoteFromText,
}: PanelRenderProps) {
  const { t, i18n } = useTranslation()
  const backendGeneration = useVaultStore((state) => state.backendGeneration)
  const switching = useVaultStore((state) => state.switching)
  const openDocs = useDocStore((state) => state.openDocs)
  const currentDoc = currentDocId ? (openDocs[currentDocId] ?? null) : null
  const chat = useAiChatStore((state) => state.chat)
  const readOnly = useAiChatStore((state) => state.readOnly)
  const revision = useAiChatStore((state) => state.revision)
  const storageError = useAiChatStore((state) => state.error)
  const [ai, setAi] = React.useState<AiSettings>(DEFAULT_AI)
  const [settingsLoaded, setSettingsLoaded] = React.useState(false)
  const [screen, setScreen] = React.useState<"chat" | "list" | "models">("chat")
  const [input, setInput] = React.useState("")
  const [loading, setLoading] = React.useState(false)
  const [streaming, setStreaming] = React.useState("")
  const [liveSteps, setLiveSteps] = React.useState<ChatStep[]>([])
  const [liveStatus, setLiveStatus] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)
  const [truncated, setTruncated] = React.useState<string[]>([])
  const [consent, setConsent] = React.useState<ConsentPrompt | null>(null)
  const [consentBusy, setConsentBusy] = React.useState(false)
  const [copied, setCopied] = React.useState<number | null>(null)
  const [mentionMatches, setMentionMatches] = React.useState<string[]>([])
  const runRef = React.useRef<RunningTurn | null>(null)
  const scrollEndRef = React.useRef<HTMLDivElement>(null)
  const checkingRef = React.useRef(false)
  const flat = React.useMemo(() => allContextItems(treeItems), [treeItems])
  const model =
    ai.models.find((item) => item.id === chat?.modelId) ??
    ai.models.find((item) => item.id === ai.activeModelId) ??
    null
  const tools = model ? modelSupportsTools(model) : false
  const context = chat?.context

  const finalize = React.useCallback(
    (run: RunningTurn, result?: { content: string; steps: ChatStep[]; sources: ChatSource[] }) => {
      if (run.finalized) return
      run.finalized = true
      const content = result?.content ?? run.partial
      const steps = result?.steps ?? run.steps
      const sources = result?.sources ?? run.sources
      const messages = [...run.chat.messages]
      if (content || steps.length) messages.push({ role: "assistant", content, steps, sources })
      const snapshot = { ...run.chat, messages, updatedAt: new Date().toISOString() }
      const store = useAiChatStore.getState()
      if (store.generation === run.generation) {
        store.replace(snapshot)
        void store.save(snapshot, run.generation).catch(() => {})
      }
    },
    [],
  )

  const stop = React.useCallback(() => {
    const run = runRef.current
    if (!run) return
    run.controller.abort()
    finalize(run)
    runRef.current = null
    setLoading(false)
    setStreaming("")
    setLiveStatus("")
    setLiveSteps([])
  }, [finalize])

  React.useEffect(() => {
    let live = true
    void loadSettings().then((settings) => {
      if (live) {
        setAi(settings.ai)
        setSettingsLoaded(true)
      }
    })
    return () => {
      live = false
      const run = runRef.current
      if (run) {
        run.controller.abort()
        finalize(run)
        runRef.current = null
      }
    }
  }, [finalize])

  React.useEffect(() => {
    stop()
    useAiChatStore.getState().beginVault(backendGeneration)
    if (backendGeneration !== null) void useAiChatStore.getState().refresh()
    setScreen("chat")
    setConsent(null)
  }, [backendGeneration, stop])

  React.useEffect(() => {
    if (switching) stop()
  }, [switching, stop])
  React.useEffect(() => {
    if (
      !settingsLoaded ||
      backendGeneration === null ||
      switching ||
      screen !== "chat" ||
      chat ||
      readOnly
    )
      return
    useAiChatStore.getState().create(ai.activeModelId ?? "", currentDocId ?? null)
  }, [
    ai.activeModelId,
    backendGeneration,
    chat,
    currentDocId,
    readOnly,
    screen,
    settingsLoaded,
    switching,
  ])

  React.useEffect(() => {
    if (!chat || !chat.autoCurrent || loading) return
    const next = currentContext(chat.context, currentDocId ?? null, true)
    if (JSON.stringify(next) === JSON.stringify(chat.context)) return
    const updated = { ...chat, context: next }
    useAiChatStore.getState().replace(updated)
    if (revision)
      void useAiChatStore
        .getState()
        .save(updated)
        .catch(() => {})
  }, [chat, currentDocId, loading, revision])

  React.useEffect(() => {
    if (!context || !vault || backendGeneration === null || switching || loading) return
    let active = true
    const timer = window.setTimeout(() => {
      void buildAttachedContext({
        context,
        items: treeItems,
        openDocs,
        vault,
        generation: backendGeneration,
        language: i18n.language === "ru" ? "Russian" : "English",
      })
        .then((result) => {
          if (active) setTruncated(result.truncated)
        })
        .catch(() => {
          if (active) setTruncated([])
        })
    }, 200)
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [backendGeneration, context, i18n.language, loading, openDocs, switching, treeItems, vault])

  React.useEffect(() => {
    scrollEndRef.current?.scrollIntoView?.({ block: "end" })
  }, [chat?.messages.length, streaming, liveSteps])

  const changeChat = React.useCallback((updated: Chat) => {
    const state = useAiChatStore.getState()
    state.replace(updated)
    if (state.revision) void state.save(updated).catch(() => {})
  }, [])

  const perform = React.useCallback(
    async (
      text: string,
      selected: AiModel,
      chatId: string,
      generation: number,
      searchEnabled: boolean,
      fromInput: boolean,
    ) => {
      const state = useAiChatStore.getState()
      if (
        state.generation !== generation ||
        state.chat?.id !== chatId ||
        !vault ||
        useVaultStore.getState().switching ||
        runRef.current
      )
        return
      const base = state.chat
      const now = new Date().toISOString()
      const user: ChatMessage = { role: "user", content: text, steps: [], sources: [] }
      const next: Chat = {
        ...base,
        modelId: selected.id,
        searchEnabled,
        title: base.title || text.trim().replace(/\s+/g, " ").slice(0, 64),
        updatedAt: now,
        messages: [...base.messages, user],
      }
      state.replace(next)
      if (fromInput) setInput("")
      setError(null)
      setLoading(true)
      setStreaming("")
      setLiveSteps([])
      setLiveStatus("")
      const run: RunningTurn = {
        controller: new AbortController(),
        generation,
        chat: next,
        partial: "",
        steps: [],
        sources: [],
        finalized: false,
      }
      runRef.current = run
      try {
        const attached = await buildAttachedContext({
          context: next.context,
          items: treeItems,
          openDocs: useDocStore.getState().openDocs,
          vault,
          generation,
          language: i18n.language === "ru" ? "Russian" : "English",
        })
        if (run.controller.signal.aborted || run.finalized) return
        run.sources = attached.sources
        setTruncated(attached.truncated)
        const messages = next.messages
          .filter(
            (message): message is ChatMessage & { role: "user" | "assistant" } =>
              message.role === "user" || message.role === "assistant",
          )
          .map(({ role, content }) => ({ role, content }))
        const result = await aiRunTurn(resolveAiConfig(selected), messages, {
          generation,
          system: attached.system,
          noteIds: attached.noteIds,
          folders: attached.folders,
          initialSources: attached.sources,
          supportsTools: modelSupportsTools(selected),
          searchEnabled,
          signal: run.controller.signal,
          onToken: (delta) => {
            if (!run.finalized) {
              run.partial += delta
              setStreaming(run.partial)
            }
          },
          onEvent: (event: AiTurnEvent) => {
            if (run.finalized) return
            const payload = event.payload
            if (event.kind === "toolStart") setLiveStatus(payload.tool ?? "")
            if (event.kind === "toolEnd") {
              const step = {
                tool: payload.tool ?? "",
                query: payload.query ?? "",
                noteIds: payload.noteIds ?? [],
                error: typeof payload.error === "string" ? payload.error : null,
              }
              run.steps.push(step)
              if (payload.source && !run.sources.some((source) => source.id === payload.source?.id))
                run.sources.push(payload.source)
              setLiveSteps([...run.steps])
              setLiveStatus("")
            }
          },
        })
        finalize(run, result)
      } catch (cause) {
        if (!run.controller.signal.aborted && !run.finalized) setError(aiErrorMessage(cause))
        finalize(run)
      } finally {
        if (runRef.current === run) {
          runRef.current = null
          setLoading(false)
          setStreaming("")
          setLiveSteps([])
          setLiveStatus("")
        }
      }
    },
    [finalize, i18n.language, treeItems, vault],
  )

  const requestSend = React.useCallback(
    async (text: string, fromInput: boolean) => {
      const value = text.trim()
      const state = useAiChatStore.getState()
      const generation = state.generation
      if (
        !value ||
        loading ||
        checkingRef.current ||
        !state.chat ||
        generation === null ||
        switching
      )
        return
      const selected =
        ai.models.find((candidate) => candidate.id === state.chat?.modelId) ??
        ai.models.find((candidate) => candidate.id === ai.activeModelId)
      if (!selected) {
        setError(t("ai.noModelConfigured"))
        return
      }
      const codex = isCodexModel(selected)
      let searchEnabled = state.chat.searchEnabled && modelSupportsTools(selected)
      // Codex gets the whole conversation, so it needs consent whether or not search is on.
      if (searchEnabled || codex) {
        checkingRef.current = true
        try {
          const status = await aiSearchConsent(generation, resolveAiConfig(selected))
          if (
            useAiChatStore.getState().generation !== generation ||
            useAiChatStore.getState().chat?.id !== state.chat.id
          )
            return
          if (status === "unknown") {
            setConsent({
              text: value,
              model: selected,
              chatId: state.chat.id,
              generation,
              fromInput,
            })
            return
          }
          if (status === "denied" && codex) {
            setError(t("ai.codexDenied"))
            return
          }
          if (status === "denied") searchEnabled = false
          else if (status !== "allowed" && status !== "local")
            throw new Error("Consent unavailable")
        } catch {
          setError(t("ai.chatSaveFailed"))
          return
        } finally {
          checkingRef.current = false
        }
      }
      await perform(value, selected, state.chat.id, generation, searchEnabled, fromInput)
    },
    [ai, loading, perform, switching, t],
  )

  const decideConsent = React.useCallback(
    async (allowed: boolean) => {
      if (!consent || consentBusy) return
      setConsentBusy(true)
      try {
        await aiSetSearchConsent(consent.generation, resolveAiConfig(consent.model), allowed)
        setConsent(null)
        if (!allowed && isCodexModel(consent.model)) {
          setError(t("ai.codexDenied"))
          return
        }
        await perform(
          consent.text,
          consent.model,
          consent.chatId,
          consent.generation,
          allowed,
          consent.fromInput,
        )
      } catch {
        setError(t("ai.chatSaveFailed"))
      } finally {
        setConsentBusy(false)
      }
    },
    [consent, consentBusy, perform, t],
  )

  const mention = input.match(/(?:^|\s)@([^\s@]*)$/u)
  const mentionQuery = mention?.[1] ?? ""
  React.useEffect(() => {
    let active = true
    if (!mentionQuery || switching) {
      setMentionMatches([])
      return
    }
    void searchNotes(mentionQuery)
      .then((results) => {
        if (active) setMentionMatches(results.map((result) => result.note.id))
      })
      .catch(() => {
        if (active) setMentionMatches([])
      })
    return () => {
      active = false
    }
  }, [backendGeneration, mentionQuery, switching])
  const choices = mention
    ? flat
        .filter(
          (item) =>
            (item.type === "file" || item.type === "folder") &&
            (item.name.toLocaleLowerCase().includes(mention[1].toLocaleLowerCase()) ||
              mentionMatches.includes(item.id)),
        )
        .slice(0, 12)
    : []
  const addItem = (item: TreeItem) => {
    if (!chat || !mention || !vault || loading) return
    const kind = item.type === "folder" ? "folder" : "note"
    const id = kind === "folder" ? toRelativeVaultPath(item.path, vault) : item.id
    if (!chat.context.some((entry) => entry.id === id))
      changeChat({ ...chat, context: [...chat.context, { kind, id }] })
    setInput(
      input.slice(0, input.length - mention[0].length) + (mention[0].startsWith(" ") ? " " : ""),
    )
  }

  const updateAi = (next: AiSettings) => {
    if (next.activeModelId !== ai.activeModelId) stop()
    setAi(next)
    void saveSettingsPatch({ ai: next }).catch(() => setError(t("ai.chatSaveFailed")))
    const current = useAiChatStore.getState().chat
    if (current && next.activeModelId && next.activeModelId !== current.modelId)
      changeChat({ ...current, modelId: next.activeModelId })
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelHeader
        leading={
          screen !== "chat" ? (
            <button
              type="button"
              title={t("ai.backToChat")}
              onClick={() => setScreen("chat")}
              className="-ml-1 rounded p-1 text-muted-foreground hover:bg-accent"
            >
              <ArrowLeft className="size-4" />
            </button>
          ) : undefined
        }
        title={
          screen === "models"
            ? t("ai.models")
            : screen === "list"
              ? t("ai.chatList")
              : chat?.title || t("ai.unnamedChat")
        }
        actions={
          screen === "chat" && (
            <div className="flex items-center gap-1">
              <button
                type="button"
                title={t("ai.chatList")}
                aria-label={t("ai.chatList")}
                onClick={() => {
                  stop()
                  void useAiChatStore.getState().refresh()
                  setScreen("list")
                }}
                className="rounded p-1 text-muted-foreground hover:bg-accent"
              >
                <History className="size-4" />
              </button>
              <button
                type="button"
                title={t("ai.newChat")}
                aria-label={t("ai.newChat")}
                onClick={() => {
                  stop()
                  useAiChatStore.getState().create(ai.activeModelId ?? "", currentDocId ?? null)
                  setError(null)
                  setInput("")
                }}
                className="rounded p-1 text-muted-foreground hover:bg-accent"
              >
                <Plus className="size-4" />
              </button>
              <button
                type="button"
                title={t("ai.modelsAndProviders")}
                aria-label={t("ai.modelsAndProviders")}
                onClick={() => setScreen("models")}
                className="rounded p-1 text-muted-foreground hover:bg-accent"
              >
                <Settings2 className="size-4" />
              </button>
            </div>
          )
        }
      />
      {screen === "models" ? (
        <ModelsManager ai={ai} onChange={updateAi} />
      ) : screen === "list" ? (
        <ChatList onOpen={() => setScreen("chat")} />
      ) : readOnly ? (
        <ScrollArea className="min-h-0 flex-1 p-3">
          <p className="text-xs text-muted-foreground">
            {t(readOnly.status === "corrupt" ? "ai.chatUnavailable" : "ai.chatReadOnly")}
          </p>
          {readOnly.raw && (
            <pre className="whitespace-pre-wrap break-all text-xs">
              {JSON.stringify(readOnly.raw, null, 2)}
            </pre>
          )}
        </ScrollArea>
      ) : (
        <>
          <div className="flex shrink-0 flex-wrap items-center gap-1 px-3 py-1.5 text-[11px] text-muted-foreground">
            <FileText className="size-3" />
            <span>{t("ai.contextPrefix")}</span>
            {chat?.context.map((entry) => {
              const item =
                entry.kind === "folder"
                  ? flat.find(
                      (candidate) =>
                        candidate.type === "folder" &&
                        toRelativeVaultPath(candidate.path, vault) === entry.id,
                    )
                  : flat.find((candidate) => candidate.id === entry.id)
              const doc = openDocs[entry.id]
              const clipped =
                truncated.includes(entry.id) ||
                (entry.kind === "current" &&
                  !!doc &&
                  Array.from(doc.content).length > MAX_ATTACHED_CHARS)
              return (
                <span
                  key={`${entry.kind}:${entry.id}`}
                  className="flex max-w-full items-center gap-1 rounded bg-muted px-1.5 py-0.5"
                >
                  <span className="truncate">
                    {doc?.title || item?.name || entry.id}
                    {clipped ? ` · ${t("ai.contextTruncated")}` : ""}
                  </span>
                  <button
                    type="button"
                    disabled={loading}
                    aria-label={t("ai.removeContext")}
                    title={t("ai.removeContext")}
                    onClick={() =>
                      changeChat({
                        ...chat,
                        autoCurrent: entry.kind === "current" ? false : chat.autoCurrent,
                        context: chat.context.filter((candidate) => candidate !== entry),
                      })
                    }
                  >
                    <X className="size-3" />
                  </button>
                </span>
              )
            })}
            {chat && !chat.autoCurrent && currentDoc && (
              <button
                type="button"
                disabled={loading}
                className="underline"
                onClick={() =>
                  changeChat({
                    ...chat,
                    autoCurrent: true,
                    context: currentContext(chat.context, currentDocId ?? null, true),
                  })
                }
              >
                {t("ai.addContext")}
              </button>
            )}
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-3 p-3">
              {(!chat || chat.messages.length === 0) && !loading && (
                <p className="px-1 py-6 text-center text-[12px] text-muted-foreground">
                  {t("ai.askAboutNote")}
                  <br />
                  {t("ai.examples")}
                  {!model && (
                    <button
                      type="button"
                      className="mt-2 block w-full underline"
                      onClick={() => setScreen("models")}
                    >
                      {t("ai.noModelsOpenSettings")}
                    </button>
                  )}
                </p>
              )}
              {chat?.messages.map((message, index) => (
                <div
                  key={index}
                  className={cn(
                    "max-w-[96%] select-text break-words rounded-lg px-3 py-2 text-[13px] leading-relaxed",
                    message.role === "user"
                      ? "self-end whitespace-pre-wrap bg-sky-600/20"
                      : "self-start bg-card",
                  )}
                >
                  {message.role === "assistant" ? (
                    <>
                      {message.steps.map((step, stepIndex) => (
                        <StepView key={stepIndex} step={step} items={flat} onSelect={onSelect} />
                      ))}
                      <AiMarkdown
                        content={message.content}
                        items={flat}
                        vault={vault}
                        onSelect={onSelect}
                      />
                      {message.sources.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1">
                          {message.sources.map((source, sourceIndex) => (
                            <button
                              key={source.id}
                              type="button"
                              disabled={
                                !flat.some((item) => item.id === source.id && item.type === "file")
                              }
                              onClick={() => onSelect(source.id)}
                              className="rounded bg-muted px-1.5 py-0.5 text-[11px] disabled:opacity-50"
                            >
                              [{sourceIndex + 1}] {source.title}
                            </button>
                          ))}
                        </div>
                      )}
                      <div className="mt-2 flex gap-2 text-muted-foreground">
                        <button
                          type="button"
                          title={copied === index ? t("ai.copied") : t("ai.copy")}
                          aria-label={t("ai.copy")}
                          onClick={() => {
                            void navigator.clipboard
                              .writeText(message.content)
                              .then(() => setCopied(index))
                              .catch(() => setError(t("ai.chatSaveFailed")))
                          }}
                        >
                          <Copy className="size-3.5" />
                        </button>
                        <button
                          type="button"
                          title={t("ai.retry")}
                          aria-label={t("ai.retry")}
                          disabled={loading}
                          onClick={() => {
                            const question = chat.messages
                              .slice(0, index)
                              .reverse()
                              .find((entry) => entry.role === "user")
                            if (question) void requestSend(question.content, false)
                          }}
                        >
                          <RotateCcw className="size-3.5" />
                        </button>
                        {onCreateNoteFromText && (
                          <button
                            type="button"
                            title={t("ai.saveAsNote")}
                            aria-label={t("ai.saveAsNote")}
                            onClick={() => void onCreateNoteFromText(message.content)}
                          >
                            <FilePlus2 className="size-3.5" />
                          </button>
                        )}
                      </div>
                    </>
                  ) : (
                    message.content
                  )}
                </div>
              ))}
              {loading && (
                <div className="max-w-[96%] self-start rounded-lg bg-card px-3 py-2 text-[13px]">
                  {liveSteps.map((step, index) => (
                    <StepView key={index} step={step} items={flat} onSelect={onSelect} />
                  ))}
                  {liveStatus && (
                    <p className="text-xs text-muted-foreground">
                      {t("ai.toolOther", { tool: liveStatus })}
                    </p>
                  )}
                  {streaming ? (
                    <AiMarkdown
                      content={streaming}
                      items={flat}
                      vault={vault}
                      onSelect={onSelect}
                    />
                  ) : (
                    <span className="text-muted-foreground">{t("ai.thinking")}</span>
                  )}
                </div>
              )}
              {(error || storageError) && (
                <div
                  role="alert"
                  className="self-start rounded-lg border border-destructive/50 px-3 py-2 text-xs text-destructive"
                >
                  {error || t("ai.chatSaveFailed")}
                </div>
              )}
              <div ref={scrollEndRef} />
            </div>
          </ScrollArea>
          <div className="relative flex shrink-0 flex-col gap-2 border-t border-border p-2">
            {mention && !loading && (
              <div
                role="listbox"
                aria-label={t("ai.addMention")}
                className="absolute bottom-full left-2 right-2 max-h-48 overflow-auto rounded border border-border bg-popover p-1 shadow-lg"
              >
                {choices.length ? (
                  choices.map((item) => (
                    <button
                      type="button"
                      role="option"
                      aria-selected="false"
                      key={item.id}
                      onClick={() => addItem(item)}
                      className="block w-full truncate rounded px-2 py-1 text-left text-xs hover:bg-accent"
                    >
                      {item.type === "folder" ? (
                        <Folder className="mr-1 inline size-3" />
                      ) : (
                        <FileText className="mr-1 inline size-3" />
                      )}
                      {item.name}
                    </button>
                  ))
                ) : (
                  <p className="p-2 text-xs text-muted-foreground">{t("ai.noMentions")}</p>
                )}
              </div>
            )}
            <label
              className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
              title={!tools ? t("ai.toolsDisabled") : undefined}
            >
              <input
                type="checkbox"
                disabled={!tools || loading || !chat}
                checked={!!chat?.searchEnabled && tools}
                onChange={(event) => {
                  if (chat) changeChat({ ...chat, searchEnabled: event.target.checked })
                }}
              />
              {t("ai.searchVault")}
              {!tools && <span> · {t("ai.toolsDisabled")}</span>}
            </label>
            <div className="flex items-end gap-2">
              <textarea
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey && !mention) {
                    event.preventDefault()
                    void requestSend(input, true)
                  }
                }}
                rows={2}
                placeholder={t("ai.messagePlaceholder")}
                className="min-h-[2.25rem] min-w-0 flex-1 resize-none rounded-md border border-border bg-card px-2 py-1.5 text-[13px] outline-none"
              />
              {loading ? (
                <button
                  type="button"
                  onClick={stop}
                  title={t("ai.stop")}
                  aria-label={t("ai.stop")}
                  className="flex size-8 items-center justify-center rounded-md bg-red-600 text-white"
                >
                  <Square className="size-3.5 fill-current" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void requestSend(input, true)}
                  disabled={!input.trim() || switching || !chat}
                  title={t("ai.send")}
                  aria-label={t("ai.send")}
                  className="flex size-8 items-center justify-center rounded-md bg-primary text-primary-foreground disabled:opacity-40"
                >
                  <Send className="size-4" />
                </button>
              )}
            </div>
            <div className="flex items-center gap-2">
              <AmbySelect
                size="sm"
                className="min-w-0 flex-1 text-[11px] text-muted-foreground"
                value={model?.id ?? ""}
                title={t("ai.activeModel")}
                aria-label={t("ai.activeModel")}
                placeholder={t("ai.noModelsOpenSettings")}
                options={ai.models.map((item) => ({ value: item.id, label: item.label }))}
                onValueChange={(next) => updateAi({ ...ai, activeModelId: next })}
              />
              {model && (
                <span className="text-[10px] text-muted-foreground">
                  {t(isLocalAiModel(model) ? "ai.localModel" : "ai.cloudModel")}
                </span>
              )}
            </div>
          </div>
        </>
      )}
      <Dialog
        open={!!consent}
        onOpenChange={(open) => {
          if (!open && !consentBusy) setConsent(null)
        }}
      >
        <DialogContent>
          <DialogTitle>
            {consent && isCodexModel(consent.model)
              ? t("ai.codexConsentTitle")
              : t("ai.consentTitle")}
          </DialogTitle>
          <DialogDescription>
            {consent && isCodexModel(consent.model)
              ? t("ai.codexConsentMessage")
              : t("ai.consentMessage", {
                  provider: consent
                    ? (findProvider(consent.model.provider)?.label ?? consent.model.provider)
                    : "",
                })}
          </DialogDescription>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              disabled={consentBusy}
              onClick={() => void decideConsent(false)}
              className="rounded border border-border px-3 py-1.5 text-sm"
            >
              {consent && isCodexModel(consent.model)
                ? t("ai.codexConsentDeny")
                : t("ai.consentDeny")}
            </button>
            <button
              type="button"
              disabled={consentBusy}
              onClick={() => void decideConsent(true)}
              className="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground"
            >
              {t("ai.consentAllow")}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
