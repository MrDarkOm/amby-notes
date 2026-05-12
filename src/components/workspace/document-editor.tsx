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
  Redo2,
  Undo2,
} from "lucide-react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { TagEditor, type TagEditorHandle } from "./tag-editor"

const INLINE_TOKEN_RE = /#(\p{L}[\p{L}\p{N}_-]*)|\[\[([^\]\r\n]+)\]\]/gu

function getWikiLinkParts(raw: string) {
  const [targetPart, aliasPart] = raw.split("|")
  const target = (targetPart ?? "").split("#")[0].trim()
  const label = (aliasPart ?? targetPart ?? "").trim()
  return { target, label: label || target }
}

function processInlineText(text: string, onWikiLinkClick?: (target: string) => void): React.ReactNode {
  const parts: React.ReactNode[] = []
  let last = 0
  INLINE_TOKEN_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = INLINE_TOKEN_RE.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index))
    if (m[1]) {
      parts.push(
        <span key={m.index} className="inline-flex items-center rounded-full bg-violet-500/15 px-1.5 py-0.5 text-[12px] font-medium text-violet-400 leading-[1.1]">
          {m[0]}
        </span>
      )
    } else {
      const { target, label } = getWikiLinkParts(m[2])
      parts.push(
        <button
          key={m.index}
          type="button"
          className="inline-flex items-center rounded bg-sky-500/10 px-1 text-sky-300 underline decoration-sky-500/50 underline-offset-2 transition-colors hover:bg-sky-500/20 hover:text-sky-200"
          onClick={e => { e.preventDefault(); e.stopPropagation(); if (target) onWikiLinkClick?.(target) }}
          title={`Открыть [[${target}]]`}
        >
          {label}
        </button>
      )
    }
    last = m.index + m[0].length
  }
  if (!parts.length) return text
  if (last < text.length) parts.push(text.slice(last))
  return <>{parts}</>
}

function processInlineChildren(children: React.ReactNode, onWikiLinkClick?: (target: string) => void): React.ReactNode {
  if (typeof children === "string") return processInlineText(children, onWikiLinkClick)
  if (Array.isArray(children)) {
    return children.map((c, i) =>
      typeof c === "string"
        ? <React.Fragment key={i}>{processInlineText(c, onWikiLinkClick)}</React.Fragment>
        : c
    )
  }
  return children
}
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
  onTagClick?: (tag: string) => void
  onWikiLinkClick?: (target: string) => void
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
  onTagClick,
  onWikiLinkClick,
}: DocumentEditorProps) {
  const [content, setContent] = React.useState(document?.content ?? "")
  const [previewMode, setPreviewMode] = React.useState(false)
  const [editingTitle, setEditingTitle] = React.useState(false)
  const [titleValue, setTitleValue] = React.useState(document?.title ?? "")
  const textareaRef = React.useRef<HTMLTextAreaElement>(null)
  const editorRef = React.useRef<TagEditorHandle>(null as unknown as TagEditorHandle)
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

  // Auto-resize handled by TagEditor when not in preview mode

  const handleContentChange = (v: string) => {
    setContent(v)
    onContentChange?.(v)
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

  const liveWordCount = content.split(/\s+/).filter(Boolean).length

  return (
    <div className="relative flex h-full flex-1 flex-col bg-background">
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

          <div className="mb-6 h-px bg-zinc-800" />

          {previewMode ? (
            <div className="md-body pb-20">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  p: ({ children }) => <p>{processInlineChildren(children, onWikiLinkClick)}</p>,
                  li: ({ children }) => <li>{processInlineChildren(children, onWikiLinkClick)}</li>,
                  h1: ({ children }) => <h1>{processInlineChildren(children, onWikiLinkClick)}</h1>,
                  h2: ({ children }) => <h2>{processInlineChildren(children, onWikiLinkClick)}</h2>,
                  h3: ({ children }) => <h3>{processInlineChildren(children, onWikiLinkClick)}</h3>,
                  blockquote: ({ children }) => <blockquote>{processInlineChildren(children, onWikiLinkClick)}</blockquote>,
                }}
              >
                {content || "*Пусто*"}
              </ReactMarkdown>
            </div>
          ) : (
            <TagEditor
              key={document.id}
              value={content}
              onChange={handleContentChange}
              onTagClick={onTagClick}
              onWikiLinkClick={onWikiLinkClick}
              textareaRef={textareaRef}
              editorRef={editorRef}
              placeholder="Начни писать..."
            />
          )}
        </div>
      </div>

      {/* Floating stats widget */}
      <div className="pointer-events-none absolute bottom-4 right-4 z-10">
        <div className="pointer-events-auto flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950/90 px-3 py-1.5 shadow-lg backdrop-blur-sm">
          <span className="text-[11px] text-zinc-500">{document.modified}</span>
          <span className="text-zinc-800">·</span>
          <span className="text-[11px] text-zinc-500">{liveWordCount} сл.</span>
          <div className="mx-1 h-3 w-px bg-zinc-800" />
          <button
            title="Отменить (Ctrl+Z)"
            className="flex size-5 items-center justify-center rounded text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-300"
            onMouseDown={e => { e.preventDefault(); editorRef.current?.undo() }}
          >
            <Undo2 className="size-3" />
          </button>
          <button
            title="Повторить (Ctrl+Y)"
            className="flex size-5 items-center justify-center rounded text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-300"
            onMouseDown={e => { e.preventDefault(); editorRef.current?.redo() }}
          >
            <Redo2 className="size-3" />
          </button>
        </div>
      </div>
    </div>
  )
}
