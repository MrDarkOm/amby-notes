"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import { ArrowLeft, FileText, Send, Settings2, Sparkles, Square } from "lucide-react"

import i18n from "@/lib/i18n"

import { cn } from "@/lib/utils"
import { ScrollArea } from "@/components/ui/scroll-area"
import { aiChat, aiErrorMessage, type AiMessage } from "@/lib/ai"
import { useDocStore } from "./use-doc-store"
import {
  DEFAULT_AI,
  activeModel,
  loadSettings,
  resolveAiConfig,
  saveSettingsPatch,
  type AiSettings,
} from "./app-config"
import { ModelsManager } from "./models-manager"
import type { PanelRenderProps } from "./panel-registry"

const MAX_CONTEXT_CHARS = 12000

/** Maps the UI language to the language the model should answer in. */
const RESPONSE_LANG: Record<string, string> = { ru: "Russian", en: "English" }
function responseLang(): string {
  return RESPONSE_LANG[i18n.language] ?? "the user's language"
}

function buildSystemPrompt(title: string | null, content: string | null): string {
  const lang = responseLang()
  if (!content || !content.trim()) {
    return `You are an assistant inside the Amby notes editor. Respond in ${lang}, concisely and to the point.`
  }
  const clipped =
    content.length > MAX_CONTEXT_CHARS ? content.slice(0, MAX_CONTEXT_CHARS) + "\n…" : content
  return [
    "You are an assistant inside the Amby notes editor. You have access to ONLY the text of the",
    `user's current note (below). Answer their questions based on it. Respond in ${lang}, concisely.`,
    "",
    `# ${title ?? i18n.t("ai.noteFallback")}`,
    clipped,
  ].join("\n")
}

export function AiPanel({ currentDocId }: PanelRenderProps) {
  const { t } = useTranslation()
  const openDocs = useDocStore((s) => s.openDocs)
  const currentDoc = currentDocId ? (openDocs[currentDocId] ?? null) : null

  const [ai, setAi] = React.useState<AiSettings>(DEFAULT_AI)
  const [showSettings, setShowSettings] = React.useState(false)
  const [messages, setMessages] = React.useState<AiMessage[]>([])
  const [input, setInput] = React.useState("")
  const [loading, setLoading] = React.useState(false)
  const [streaming, setStreaming] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const abortControllerRef = React.useRef<AbortController | null>(null)

  React.useEffect(() => {
    loadSettings().then((s) => setAi(s.ai))
    return () => {
      abortControllerRef.current?.abort()
    }
  }, [])

  React.useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages, streaming])

  const stop = React.useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
      abortControllerRef.current = null
    }
    setLoading(false)
    setStreaming(null)
  }, [])

  const updateAi = React.useCallback(
    (next: AiSettings) => {
      if (next.activeModelId !== ai.activeModelId) {
        abortControllerRef.current?.abort()
      }
      setAi(next)
      void saveSettingsPatch({ ai: next }).catch(() => {})
    },
    [ai.activeModelId],
  )

  const send = React.useCallback(async () => {
    const text = input.trim()
    if (!text || loading) return
    const model = activeModel(ai)
    if (!model) {
      setError(t("ai.noModelConfigured"))
      return
    }
    setError(null)
    const next = [...messages, { role: "user" as const, content: text }]
    setMessages(next)
    setInput("")
    setLoading(true)
    setStreaming("")

    const controller = new AbortController()
    abortControllerRef.current = controller

    try {
      const reply = await aiChat(resolveAiConfig(model), next, {
        system: buildSystemPrompt(currentDoc?.title ?? null, currentDoc?.content ?? null),
        onToken: (delta) => setStreaming((s) => (s ?? "") + delta),
        signal: controller.signal,
      })
      setMessages((prev) => [...prev, { role: "assistant", content: reply }])
    } catch (e) {
      if (controller.signal.aborted) {
        setError(t("ai.cancelled"))
      } else {
        setError(aiErrorMessage(e))
      }
    } finally {
      abortControllerRef.current = null
      setStreaming(null)
      setLoading(false)
    }
  }, [ai, currentDoc, input, loading, messages, t])

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-2">
        <div className="flex items-center gap-2 text-[13px] font-medium text-foreground">
          {showSettings ? (
            <button
              type="button"
              title={t("ai.backToChat")}
              onClick={() => setShowSettings(false)}
              className="-ml-1 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <ArrowLeft className="size-4" />
            </button>
          ) : (
            <Sparkles className="size-4 text-primary" />
          )}
          {showSettings ? t("ai.models") : t("settings.modules.ai")}
        </div>
        {!showSettings && (
          <button
            type="button"
            title={t("ai.modelsAndProviders")}
            onClick={() => setShowSettings(true)}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Settings2 className="size-4" />
          </button>
        )}
      </div>

      {showSettings ? (
        <ModelsManager ai={ai} onChange={updateAi} />
      ) : (
        <>
          {/* Context scope chip */}
          <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-3 py-1.5 text-[11px] text-muted-foreground">
            <FileText className="size-3 shrink-0" />
            <span className="truncate">
              {currentDoc ? (
                <>
                  {t("ai.contextPrefix")}{" "}
                  <span className="text-muted-foreground">
                    {currentDoc.title || t("ai.untitled")}
                  </span>
                </>
              ) : (
                <>
                  {t("ai.contextPrefix")} {t("ai.noNote")}
                </>
              )}
            </span>
          </div>

          {/* Messages */}
          <ScrollArea className="min-h-0 flex-1">
            <div ref={scrollRef} className="flex flex-col gap-3 p-3">
              {messages.length === 0 && !loading && (
                <p className="px-1 py-6 text-center text-[12px] text-muted-foreground">
                  {t("ai.askAboutNote")}
                </p>
              )}
              {messages.map((m, i) => (
                <div
                  key={i}
                  className={cn(
                    "max-w-[92%] whitespace-pre-wrap break-words rounded-lg px-3 py-2 text-[13px] leading-relaxed",
                    m.role === "user"
                      ? "self-end bg-sky-600/20 text-foreground"
                      : "self-start bg-card text-foreground",
                  )}
                >
                  {m.content}
                </div>
              ))}
              {streaming !== null && (
                <div className="max-w-[92%] self-start whitespace-pre-wrap break-words rounded-lg bg-card px-3 py-2 text-[13px] leading-relaxed text-foreground">
                  {streaming || <span className="text-muted-foreground">{t("ai.thinking")}</span>}
                </div>
              )}
              {error && (
                <div className="self-start whitespace-pre-wrap break-words rounded-lg border border-red-900/50 bg-red-950/30 px-3 py-2 text-[12px] text-red-300">
                  {error}
                </div>
              )}
            </div>
          </ScrollArea>

          {/* Input + model picker */}
          <div className="flex shrink-0 flex-col gap-2 border-t border-border p-2">
            <div className="flex items-end gap-2">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault()
                    void send()
                  }
                }}
                rows={2}
                placeholder={t("ai.messagePlaceholder")}
                className="min-h-[2.25rem] min-w-0 flex-1 resize-none rounded-md border border-border bg-card px-2 py-1.5 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus:border-border"
              />
              {loading ? (
                <button
                  type="button"
                  onClick={stop}
                  title={t("ai.stop")}
                  className="flex size-8 shrink-0 items-center justify-center rounded-md bg-red-600/80 text-white transition-colors hover:bg-red-600"
                >
                  <Square className="size-3.5 fill-current" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void send()}
                  disabled={!input.trim()}
                  title={t("ai.send")}
                  className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-40"
                >
                  <Send className="size-4" />
                </button>
              )}
            </div>
            <select
              value={ai.activeModelId ?? ""}
              onChange={(e) => updateAi({ ...ai, activeModelId: e.target.value })}
              title={t("ai.activeModel")}
              className="h-6 w-full rounded border border-border bg-card px-1.5 text-[11px] text-muted-foreground outline-none focus:border-border"
            >
              {ai.models.length === 0 && <option value="">{t("ai.noModelsOpenSettings")}</option>}
              {ai.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
        </>
      )}
    </div>
  )
}
