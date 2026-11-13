"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import { ArrowLeft, History, Settings2, SquarePen } from "lucide-react"
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
  AI_SETTINGS_CHANGED_EVENT,
  DEFAULT_AI,
  findProvider,
  isClaudeCodeModel,
  isCliAgentModel,
  isLocalAiModel,
  loadSettings,
  modelSupportsTools,
  resolveAiConfig,
  saveSettingsPatch,
  type AiSettings,
} from "./app-config"
import { useDocStore } from "./use-doc-store"
import { useVaultStore } from "./use-vault-store"
import type { PanelRenderProps } from "./panel-registry"
import { PanelHeader } from "./panels/panel-header"
import { toRelativeVaultPath } from "./workspace-tree-utils"
import { allContextItems, buildAttachedContext, currentContext } from "./ai/context"
import { Composer } from "./ai/composer"
import { EmptyChat } from "./ai/empty-chat"
import { AssistantAnswer, LiveAnswer, UserMessage } from "./ai/message-view"
import { ChatList } from "./ai/chat-list"
import { newChatModelId } from "./ai/connections"
import { useAiChatStore } from "./ai/use-ai-chat-store"
import { OPEN_SETTINGS_REQUEST_EVENT } from "./settings-navigation"
import {
  searchNotes,
  type Chat,
  type ChatMessage,
  type ChatSource,
  type ChatStep,
  type TreeItem,
} from "@/lib/storage"

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
  const [screen, setScreen] = React.useState<"chat" | "list">("chat")
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
  const model = chat
    ? (ai.models.find((item) => item.id === chat.modelId) ?? null)
    : (ai.models.find((item) => item.id === newChatModelId(ai)) ?? null)
  const tools = model ? modelSupportsTools(model) : false
  const context = chat?.context

  const finalize = React.useCallback(
    (run: RunningTurn, result?: { content: string; steps: ChatStep[]; sources: ChatSource[] }) => {
      if (run.finalized) return
      run.finalized = true
      const content = result?.content ?? run.partial
      const steps = result?.steps ?? run.steps
      const sources = result?.sources ?? run.sources
      const store = useAiChatStore.getState()
      const current = store.chat?.id === run.chat.id ? store.chat : run.chat
      const messages = [...current.messages]
      if (content || steps.length) messages.push({ role: "assistant", content, steps, sources })
      const snapshot = { ...current, messages, updatedAt: new Date().toISOString() }
      if (store.generation === run.generation && store.chat?.id === run.chat.id) {
        store.replace(snapshot)
        // `save` of the chat store sets its `error` state and the panel shows it; this only stops
        // the rejection.
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
    const refresh = () => {
      void loadSettings()
        .then((settings) => {
          if (live) {
            setAi(settings.ai)
            setSettingsLoaded(true)
          }
        })
        .catch(() => {
          if (live) setError(t("aiConnections.loadError"))
        })
    }
    refresh()
    window.addEventListener(AI_SETTINGS_CHANGED_EVENT, refresh)
    window.addEventListener("focus", refresh)
    return () => {
      live = false
      window.removeEventListener(AI_SETTINGS_CHANGED_EVENT, refresh)
      window.removeEventListener("focus", refresh)
      const run = runRef.current
      if (run) {
        run.controller.abort()
        finalize(run)
        runRef.current = null
      }
    }
  }, [finalize, t])

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
    useAiChatStore.getState().create(newChatModelId(ai), currentDocId ?? null)
  }, [ai, backendGeneration, chat, currentDocId, readOnly, screen, settingsLoaded, switching])

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
        // `save` of the chat store sets its `error` state and the panel shows it; this only stops
        // the rejection.
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
    // `save` of the chat store sets its `error` state and the panel shows it; this only stops the
    // rejection.
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
      checkingRef.current = true
      let latest: AiSettings
      try {
        latest = (await loadSettings()).ai
        if (
          useAiChatStore.getState().generation !== generation ||
          useAiChatStore.getState().chat?.id !== state.chat.id ||
          useAiChatStore.getState().chat?.modelId !== state.chat.modelId
        )
          return
        setAi(latest)
      } catch {
        setError(t("aiConnections.loadError"))
        return
      } finally {
        checkingRef.current = false
      }
      const selected = latest.models.find((candidate) => candidate.id === state.chat?.modelId)
      if (!selected) {
        setError(t(latest.models.length ? "ai.selectModel" : "ai.noModelConfigured"))
        return
      }
      const codex = isCliAgentModel(selected)
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
            setError(t(isClaudeCodeModel(selected) ? "ai.claudeDenied" : "ai.codexDenied"))
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
    [loading, perform, switching, t],
  )

  const decideConsent = React.useCallback(
    async (allowed: boolean) => {
      if (!consent || consentBusy) return
      setConsentBusy(true)
      try {
        const latest = (await loadSettings()).ai.models.find(
          (model) => model.id === consent.model.id,
        )
        const chat = useAiChatStore.getState().chat
        if (
          !latest ||
          JSON.stringify(resolveAiConfig(latest)) !==
            JSON.stringify(resolveAiConfig(consent.model)) ||
          chat?.id !== consent.chatId ||
          chat.modelId !== consent.model.id ||
          useAiChatStore.getState().generation !== consent.generation
        ) {
          setConsent(null)
          setError(t("ai.selectModel"))
          return
        }
        await aiSetSearchConsent(consent.generation, resolveAiConfig(consent.model), allowed)
        setConsent(null)
        if (!allowed && isCliAgentModel(consent.model)) {
          setError(t(isClaudeCodeModel(consent.model) ? "ai.claudeDenied" : "ai.codexDenied"))
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

  /** Providers and models are managed in Settings, in the AI module's section. */
  const openAiSettings = () =>
    window.dispatchEvent(
      new CustomEvent(OPEN_SETTINGS_REQUEST_EVENT, {
        detail: { section: "modules", moduleId: "ai" },
      }),
    )

  const updateAi = (next: AiSettings) => {
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
        title={screen === "list" ? t("ai.chatList") : chat?.title || t("ai.unnamedChat")}
        actions={
          <div className="flex items-center gap-0.5">
            {screen === "chat" && (
              <button
                type="button"
                title={t("ai.chatList")}
                aria-label={t("ai.chatList")}
                onClick={() => {
                  stop()
                  void useAiChatStore.getState().refresh()
                  setScreen("list")
                }}
                className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <History className="size-4" />
              </button>
            )}
            <button
              type="button"
              title={t("ai.newChat")}
              aria-label={t("ai.newChat")}
              onClick={() => {
                stop()
                useAiChatStore.getState().create(newChatModelId(ai), currentDocId ?? null)
                setError(null)
                setInput("")
                setScreen("chat")
              }}
              className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <SquarePen className="size-4" />
            </button>
            <button
              type="button"
              title={t("ai.settings")}
              aria-label={t("ai.settings")}
              onClick={openAiSettings}
              className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <Settings2 className="size-4" />
            </button>
          </div>
        }
      />
      {screen === "list" ? (
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
          {/* The scroll area sizes its content like a table, so a long line would widen the whole chat past the panel. */}
          <ScrollArea className="min-h-0 flex-1 [&_[data-radix-scroll-area-viewport]>div]:!block">
            <div className="flex flex-col gap-4 px-3 py-3">
              {(!chat || chat.messages.length === 0) && !loading && (
                <EmptyChat
                  hasModel={!!model}
                  searchOn={!!chat?.searchEnabled && tools}
                  onOpenModels={openAiSettings}
                  onPick={setInput}
                />
              )}
              {chat?.messages.map((message, index) =>
                message.role === "user" ? (
                  <UserMessage key={index} text={message.content} />
                ) : (
                  <AssistantAnswer
                    key={index}
                    message={message}
                    items={flat}
                    vault={vault}
                    onSelect={onSelect}
                    copied={copied === index}
                    busy={loading}
                    onCopy={() => {
                      void navigator.clipboard
                        .writeText(message.content)
                        .then(() => setCopied(index))
                        .catch(() => setError(t("ai.chatSaveFailed")))
                    }}
                    onRetry={() => {
                      const question = chat.messages
                        .slice(0, index)
                        .reverse()
                        .find((entry) => entry.role === "user")
                      if (question) void requestSend(question.content, false)
                    }}
                    onSaveAsNote={
                      onCreateNoteFromText
                        ? () => void onCreateNoteFromText(message.content)
                        : undefined
                    }
                  />
                ),
              )}
              {loading && (
                <LiveAnswer
                  steps={liveSteps}
                  status={liveStatus}
                  streaming={streaming}
                  items={flat}
                  vault={vault}
                  onSelect={onSelect}
                />
              )}
              {(error || storageError) && (
                <div
                  role="alert"
                  className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs leading-relaxed text-destructive"
                >
                  {error || t("ai.chatSaveFailed")}
                </div>
              )}
              <div ref={scrollEndRef} />
            </div>
          </ScrollArea>
          <Composer
            chat={chat}
            flat={flat}
            openDocs={openDocs}
            truncated={truncated}
            vault={vault}
            currentDoc={currentDoc}
            input={input}
            loading={loading}
            switching={switching}
            tools={tools}
            mentionOpen={!!mention}
            choices={choices}
            models={ai.models.map((item) => ({
              value: item.id,
              label: item.label,
              providerId: item.provider,
              modelId: item.model,
              groupId: item.connectionId,
              providerLabel:
                item.connectionLabel ?? findProvider(item.provider)?.label ?? item.provider,
              kind: isLocalAiModel(item) ? ("local" as const) : ("cloud" as const),
            }))}
            activeModelId={model?.id ?? ""}
            onChangeChat={changeChat}
            onAddCurrent={() => {
              if (!chat) return
              changeChat({
                ...chat,
                autoCurrent: true,
                context: currentContext(chat.context, currentDocId ?? null, true),
              })
            }}
            onInput={setInput}
            onSend={() => void requestSend(input, true)}
            onStop={stop}
            onPickMention={addItem}
            onModel={(next) => updateAi({ ...ai, activeModelId: next })}
            onManage={openAiSettings}
          />
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
            {consent && isCliAgentModel(consent.model)
              ? t(`ai.${isClaudeCodeModel(consent.model) ? "claude" : "codex"}ConsentTitle`)
              : t("ai.consentTitle")}
          </DialogTitle>
          <DialogDescription>
            {consent && isCliAgentModel(consent.model)
              ? t(`ai.${isClaudeCodeModel(consent.model) ? "claude" : "codex"}ConsentMessage`)
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
              {consent && isCliAgentModel(consent.model)
                ? t(`ai.${isClaudeCodeModel(consent.model) ? "claude" : "codex"}ConsentDeny`)
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
