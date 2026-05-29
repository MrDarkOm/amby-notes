"use client"

import * as React from "react"
import { ArrowLeft, FileText, Send, Settings2, Sparkles } from "lucide-react"

import { cn } from "@/lib/utils"
import { ScrollArea } from "@/components/ui/scroll-area"
import { aiChat, AiUnavailableError, type AiMessage } from "@/lib/ai"
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

function buildSystemPrompt(title: string | null, content: string | null): string {
  if (!content || !content.trim()) {
    return "Ты — ассистент внутри редактора заметок Amby. Отвечай на русском, кратко и по делу."
  }
  const clipped = content.length > MAX_CONTEXT_CHARS ? content.slice(0, MAX_CONTEXT_CHARS) + "\n…" : content
  return [
    "Ты — ассистент внутри редактора заметок Amby. Тебе доступен ТОЛЬКО текст текущей заметки",
    "пользователя (ниже). Отвечай на его вопросы, опираясь на неё. На русском, кратко и по делу.",
    "",
    `# ${title ?? "Заметка"}`,
    clipped,
  ].join("\n")
}

export function AiPanel({ currentDocId }: PanelRenderProps) {
  const openDocs = useDocStore(s => s.openDocs)
  const currentDoc = currentDocId ? openDocs[currentDocId] ?? null : null

  const [ai, setAi] = React.useState<AiSettings>(DEFAULT_AI)
  const [showSettings, setShowSettings] = React.useState(false)
  const [messages, setMessages] = React.useState<AiMessage[]>([])
  const [input, setInput] = React.useState("")
  const [loading, setLoading] = React.useState(false)
  const [streaming, setStreaming] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const scrollRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    loadSettings().then(s => setAi(s.ai))
  }, [])

  React.useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages, streaming])

  const updateAi = React.useCallback((next: AiSettings) => {
    setAi(next)
    void saveSettingsPatch({ ai: next })
  }, [])

  const send = React.useCallback(async () => {
    const text = input.trim()
    if (!text || loading) return
    const model = activeModel(ai)
    if (!model) {
      setError("Не настроена ни одна модель — откройте настройки (шестерёнка).")
      return
    }
    setError(null)
    const next = [...messages, { role: "user" as const, content: text }]
    setMessages(next)
    setInput("")
    setLoading(true)
    setStreaming("")
    try {
      const reply = await aiChat(resolveAiConfig(model), next, {
        system: buildSystemPrompt(currentDoc?.title ?? null, currentDoc?.content ?? null),
        onToken: delta => setStreaming(s => (s ?? "") + delta),
      })
      setMessages(prev => [...prev, { role: "assistant", content: reply }])
    } catch (e) {
      setError(e instanceof AiUnavailableError ? e.message : String(e))
    } finally {
      setStreaming(null)
      setLoading(false)
    }
  }, [ai, currentDoc, input, loading, messages])

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#0A0A0A]">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-b border-zinc-800 px-3 py-2">
        <div className="flex items-center gap-2 text-[13px] font-medium text-zinc-200">
          {showSettings ? (
            <button
              type="button"
              title="Назад к чату"
              onClick={() => setShowSettings(false)}
              className="-ml-1 rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
            >
              <ArrowLeft className="size-4" />
            </button>
          ) : (
            <Sparkles className="size-4 text-sky-400" />
          )}
          {showSettings ? "Модели" : "AI"}
        </div>
        {!showSettings && (
          <button
            type="button"
            title="Модели и провайдеры"
            onClick={() => setShowSettings(true)}
            className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
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
          <div className="flex shrink-0 items-center gap-1.5 border-b border-zinc-900 px-3 py-1.5 text-[11px] text-zinc-500">
            <FileText className="size-3 shrink-0" />
            <span className="truncate">
              {currentDoc ? (
                <>Контекст: <span className="text-zinc-400">{currentDoc.title || "без названия"}</span></>
              ) : (
                <>Контекст: нет открытой заметки</>
              )}
            </span>
          </div>

          {/* Messages */}
          <ScrollArea className="min-h-0 flex-1">
            <div ref={scrollRef} className="flex flex-col gap-3 p-3">
              {messages.length === 0 && !loading && (
                <p className="px-1 py-6 text-center text-[12px] text-zinc-600">
                  Спросите что-нибудь о текущей заметке.
                </p>
              )}
              {messages.map((m, i) => (
                <div
                  key={i}
                  className={cn(
                    "max-w-[92%] whitespace-pre-wrap break-words rounded-lg px-3 py-2 text-[13px] leading-relaxed",
                    m.role === "user"
                      ? "self-end bg-sky-600/20 text-zinc-100"
                      : "self-start bg-zinc-900 text-zinc-200",
                  )}
                >
                  {m.content}
                </div>
              ))}
              {streaming !== null && (
                <div className="max-w-[92%] self-start whitespace-pre-wrap break-words rounded-lg bg-zinc-900 px-3 py-2 text-[13px] leading-relaxed text-zinc-200">
                  {streaming || <span className="text-zinc-500">Думаю…</span>}
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
          <div className="flex shrink-0 flex-col gap-2 border-t border-zinc-800 p-2">
            <div className="flex items-end gap-2">
              <textarea
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault()
                    void send()
                  }
                }}
                rows={2}
                placeholder="Сообщение…"
                className="min-h-[2.25rem] min-w-0 flex-1 resize-none rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-[13px] text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-zinc-700"
              />
              <button
                type="button"
                onClick={() => void send()}
                disabled={loading || !input.trim()}
                title="Отправить"
                className="flex size-8 shrink-0 items-center justify-center rounded-md bg-sky-600 text-white transition-opacity hover:bg-sky-500 disabled:opacity-40"
              >
                <Send className="size-4" />
              </button>
            </div>
            <select
              value={ai.activeModelId ?? ""}
              onChange={e => updateAi({ ...ai, activeModelId: e.target.value })}
              title="Активная модель"
              className="h-6 w-full rounded border border-zinc-800 bg-zinc-900 px-1.5 text-[11px] text-zinc-400 outline-none focus:border-zinc-700"
            >
              {ai.models.length === 0 && <option value="">Нет моделей — откройте настройки</option>}
              {ai.models.map(m => (
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
