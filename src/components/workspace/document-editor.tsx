"use client"

import * as React from "react"
import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
  FilePlus,
  FolderOpen,
  Maximize2,
  Minimize2,
  MoreVertical,
  Pencil,
} from "lucide-react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { Button } from "@/components/ui/button"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { isTauri } from "@/lib/storage"

interface Document {
  id: string
  title: string
  content: string
  modified: string
  wordCount: number
  path: string
}

interface DocumentEditorProps {
  document: Document | null
  onContentChange?: (content: string) => void
  onBack?: () => void
  onForward?: () => void
  canGoBack?: boolean
  canGoForward?: boolean
  onRenameTitle?: (newName: string) => void
  vault?: string
  isFocusMode?: boolean
  onToggleFocusMode?: () => void
  fileIcon?: string
  onNewFile?: () => void
  onOpenVault?: () => void
}

function getRelativePath(vault: string | undefined, filePath: string): string {
  if (!vault || !filePath) return ""
  const norm = (p: string) => p.replace(/\\/g, "/")
  const rel = norm(filePath).startsWith(norm(vault) + "/")
    ? norm(filePath).slice(norm(vault).length + 1)
    : norm(filePath).split("/").pop() ?? norm(filePath)
  return rel.split("/").join(" › ")
}

function handleDragStart(e: React.MouseEvent) {
  if (e.button !== 0) return
  if (isTauri()) {
    e.preventDefault()
    getCurrentWindow().startDragging().catch(() => {})
  }
}

export function DocumentEditor({
  document,
  onContentChange,
  onBack,
  onForward,
  canGoBack = false,
  canGoForward = false,
  onRenameTitle,
  vault,
  isFocusMode = false,
  onToggleFocusMode,
  fileIcon,
  onNewFile,
  onOpenVault,
}: DocumentEditorProps) {
  const [content, setContent] = React.useState(document?.content ?? "")
  const [previewMode, setPreviewMode] = React.useState(false)
  const [editingTitle, setEditingTitle] = React.useState(false)
  const [titleValue, setTitleValue] = React.useState(document?.title ?? "")
  const textareaRef = React.useRef<HTMLTextAreaElement>(null)
  const titleInputRef = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    setContent(document?.content ?? "")
    setTitleValue(document?.title ?? "")
    setEditingTitle(false)
  }, [document?.id])

  React.useEffect(() => {
    if (editingTitle) setTimeout(() => { titleInputRef.current?.select(); titleInputRef.current?.focus() }, 0)
  }, [editingTitle])

  function commitTitleRename() {
    const trimmed = titleValue.trim()
    if (trimmed && trimmed !== document?.title) onRenameTitle?.(trimmed)
    setEditingTitle(false)
  }

  function handleTitleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") commitTitleRename()
    if (e.key === "Escape") { setTitleValue(document?.title ?? ""); setEditingTitle(false) }
  }

  React.useEffect(() => {
    const el = textareaRef.current
    if (!el || previewMode) return
    el.style.height = "auto"
    el.style.height = `${el.scrollHeight}px`
  }, [content, previewMode])

  const handleContentChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setContent(e.target.value)
    onContentChange?.(e.target.value)
  }

  const relPath = document ? getRelativePath(vault, document.path) : ""

  const navBar = (
    <div className={`flex h-9 shrink-0 items-center justify-between border-b border-zinc-800 px-2 ${isFocusMode ? "bg-[#0A0A0A]/80 backdrop-blur-sm" : "bg-[#0A0A0A]"}`}>
      {/* Left: back/forward + drag zone for focus mode */}
      <div className="flex items-center gap-0.5">
        {isFocusMode && (
          <div className="w-6 h-9 cursor-default" onMouseDown={handleDragStart} />
        )}
        <Button
          variant="ghost" size="icon"
          className="size-7 text-zinc-500 hover:bg-zinc-800 hover:text-white disabled:opacity-30"
          onClick={onBack}
          disabled={!canGoBack}
        >
          <ChevronLeft className="size-4" />
        </Button>
        <Button
          variant="ghost" size="icon"
          className="size-7 text-zinc-500 hover:bg-zinc-800 hover:text-white disabled:opacity-30"
          onClick={onForward}
          disabled={!canGoForward}
        >
          <ChevronRight className="size-4" />
        </Button>
      </div>

      {/* Center: path */}
      <div className="flex flex-1 items-center justify-center gap-1.5 overflow-hidden px-2 text-xs">
        {relPath ? (
          <span className="truncate text-zinc-500">{relPath}</span>
        ) : document ? (
          <span className="text-zinc-400">{document.title}</span>
        ) : null}
      </div>

      {/* Right: mode + focus + more */}
      <div className="flex items-center gap-0.5">
        <Button
          variant="ghost" size="icon"
          className={`size-7 hover:bg-zinc-800 ${previewMode ? "text-zinc-200" : "text-zinc-500 hover:text-white"}`}
          onClick={() => setPreviewMode(v => !v)}
          title={previewMode ? "Режим редактирования" : "Режим чтения"}
        >
          {previewMode ? <Pencil className="size-4" /> : <BookOpen className="size-4" />}
        </Button>
        <Button
          variant="ghost" size="icon"
          className={`size-7 hover:bg-zinc-800 ${isFocusMode ? "text-zinc-200" : "text-zinc-500 hover:text-white"}`}
          onClick={onToggleFocusMode}
          title={isFocusMode ? "Выйти из фокуса" : "Режим фокуса"}
        >
          {isFocusMode ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
        </Button>
        <Button variant="ghost" size="icon" className="size-7 text-zinc-500 hover:bg-zinc-800 hover:text-white">
          <MoreVertical className="size-4" />
        </Button>
      </div>
    </div>
  )

  if (!document) {
    return (
      <div className="flex h-full flex-1 flex-col bg-background">
        {navBar}
        <div className="flex flex-1 flex-col items-center justify-center gap-6">
          <div className="text-center">
            <p className="text-lg font-medium text-zinc-300">Нет открытых заметок</p>
            <p className="mt-1 text-sm text-zinc-600">Создай новую или открой существующую</p>
          </div>
          <div className="flex gap-3">
            <button
              onClick={onNewFile}
              className="flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2.5 text-sm text-zinc-200 transition-colors hover:bg-zinc-800 hover:border-zinc-500"
            >
              <FilePlus className="size-4 text-zinc-400" />
              Создать заметку
            </button>
            <button
              onClick={onOpenVault}
              className="flex items-center gap-2 rounded-lg border border-zinc-800 px-4 py-2.5 text-sm text-zinc-500 transition-colors hover:bg-zinc-900 hover:text-zinc-300"
            >
              <FolderOpen className="size-4" />
              Открыть хранилище
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-1 flex-col bg-background">
      {navBar}

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-10 py-8">
          {/* Title */}
          <div className="mb-4 flex items-center gap-3">
            {fileIcon && !/^(folder|file|workspace|canvas|draft|brain)$/.test(fileIcon) && (
              <span className="text-3xl leading-none shrink-0">{fileIcon}</span>
            )}
            {editingTitle ? (
              <input
                ref={titleInputRef}
                value={titleValue}
                onChange={e => setTitleValue(e.target.value)}
                onBlur={commitTitleRename}
                onKeyDown={handleTitleKeyDown}
                className="flex-1 bg-transparent text-3xl font-semibold tracking-tight text-zinc-100 outline-none border-b border-zinc-600 focus:border-zinc-400"
              />
            ) : (
              <h1
                className="text-3xl font-semibold tracking-tight text-zinc-100 cursor-text hover:text-white"
                onClick={() => { setTitleValue(document.title); setEditingTitle(true) }}
                title="Нажми чтобы переименовать"
              >
                {document.title}
              </h1>
            )}
          </div>

          {/* Metadata */}
          <div className="mb-6 flex items-center gap-3 text-[11px] uppercase tracking-wider text-zinc-500">
            <span className="font-medium">Изменено</span>
            <span>{document.modified}</span>
            <span className="text-zinc-700">·</span>
            <span>{document.wordCount} слов</span>
          </div>

          <div className="mb-6 h-px bg-zinc-800" />

          {previewMode ? (
            <div className="md-body pb-16">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {content || "*Пусто*"}
              </ReactMarkdown>
            </div>
          ) : (
            <textarea
              ref={textareaRef}
              value={content}
              onChange={handleContentChange}
              placeholder="Начни писать..."
              rows={1}
              className="w-full resize-none overflow-hidden bg-transparent pb-16 font-mono text-sm leading-relaxed text-zinc-300 placeholder:text-zinc-600 focus:outline-none"
            />
          )}
        </div>
      </div>
    </div>
  )
}
