"use client"

import * as React from "react"
import {
  Bold,
  Code2,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Link,
  List,
  ListOrdered,
  Palette,
  Pilcrow,
  Quote,
  Strikethrough,
} from "lucide-react"
import type { TagEditorHandle } from "./tag-editor"

const INLINE_TOKEN_SOURCE = String.raw`#(\p{L}[\p{L}\p{N}_-]*)|\[\[([^\]\r\n]+)\]\]|<span\s+style=["']color:\s*(#[0-9a-fA-F]{6})["']>(.*?)<\/span>`
const PAIRS: Record<string, string> = { '"': '"', "'": "'", "(": ")", "[": "]", "{": "}", "`": "`" }
const CLOSERS = new Set(Object.values(PAIRS))
const COLORS = ["#f87171", "#fb923c", "#facc15", "#4ade80", "#38bdf8", "#a78bfa", "#f472b6", "#e5e7eb"]

interface LiveMarkdownEditorProps {
  value: string
  onChange: (v: string) => void
  onTagClick?: (tag: string) => void
  onWikiLinkClick?: (target: string) => void
  editorRef?: React.RefObject<TagEditorHandle>
  placeholder?: string
}

interface LineMeta {
  inFence: boolean
  fenceLine: boolean
}

interface SelectionRange {
  start: number
  end: number
}

function splitLines(value: string): string[] {
  return value.length ? value.split("\n") : [""]
}

function lineStartOffsets(lines: string[]): number[] {
  const offsets: number[] = []
  let next = 0
  for (const line of lines) {
    offsets.push(next)
    next += line.length + 1
  }
  return offsets
}

function getLineAtOffset(offsets: number[], offset: number): number {
  let low = 0
  let high = offsets.length - 1
  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    if (offsets[mid] <= offset) low = mid + 1
    else high = mid - 1
  }
  return Math.max(0, high)
}

function replaceRange(value: string, start: number, end: number, insert: string) {
  return value.slice(0, start) + insert + value.slice(end)
}

function getWikiLinkParts(raw: string) {
  const [targetPart, aliasPart] = raw.split("|")
  const target = (targetPart ?? "").split("#")[0].trim()
  const label = (aliasPart ?? targetPart ?? "").trim()
  return { target, label: label || target }
}

function getLineMetadata(lines: string[]): LineMeta[] {
  let inFence = false
  return lines.map(line => {
    const fenceLine = /^```/.test(line.trimStart())
    const meta = { inFence, fenceLine }
    if (fenceLine) inFence = !inFence
    return meta
  })
}

function getContinuation(line: string): string {
  const ordered = /^(\s*)\d+\.\s+/.exec(line)
  if (ordered) return `${ordered[1]}1. `
  const unordered = /^(\s*)[-*+]\s+/.exec(line)
  if (unordered) return `${unordered[1]}- `
  const quote = /^(>\s*)/.exec(line)
  if (quote) return quote[1]
  return ""
}

function sanitizeColor(color: string) {
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color : "#e5e7eb"
}

function renderInline(
  text: string,
  onTagClick?: (tag: string) => void,
  onWikiLinkClick?: (target: string) => void
): React.ReactNode {
  const parts: React.ReactNode[] = []
  let last = 0
  const tokenRe = new RegExp(INLINE_TOKEN_SOURCE, "gu")
  let match: RegExpExecArray | null

  while ((match = tokenRe.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index))
    if (match[1]) {
      const tag = match[1]
      parts.push(
        <span
          key={match.index}
          data-tag-target={tag}
          className="inline-flex rounded-full bg-violet-500/15 px-1.5 py-0.5 text-[0.82em] font-medium leading-[1.1] text-violet-300"
          onMouseDown={e => {
            if (!e.metaKey && !e.ctrlKey) return
            e.preventDefault()
            e.stopPropagation()
            onTagClick?.(tag)
          }}
        >
          #{tag}
        </span>
      )
    } else if (match[2]) {
      const { target, label } = getWikiLinkParts(match[2])
      parts.push(
        <span
          key={match.index}
          data-wiki-target={target}
          className="inline-flex rounded bg-sky-500/10 px-1 text-sky-300 underline decoration-sky-500/50 underline-offset-2"
          onMouseDown={e => {
            if (!e.metaKey && !e.ctrlKey) return
            e.preventDefault()
            e.stopPropagation()
            if (target) onWikiLinkClick?.(target)
          }}
        >
          {label}
        </span>
      )
    } else {
      const color = sanitizeColor(match[3] ?? "")
      parts.push(
        <span key={match.index} style={{ color }}>
          {renderInline(match[4] ?? "", onTagClick, onWikiLinkClick)}
        </span>
      )
    }
    last = match.index + match[0].length
  }

  if (last < text.length) parts.push(text.slice(last))
  return parts.length ? <>{parts}</> : text
}

function PreviewLine({
  line,
  meta,
  active,
  onTagClick,
  onWikiLinkClick,
}: {
  line: string
  meta: LineMeta
  active: boolean
  onTagClick?: (tag: string) => void
  onWikiLinkClick?: (target: string) => void
}) {
  if (active) {
    return (
      <div className="min-h-7 whitespace-pre-wrap break-words font-mono text-sm leading-7 text-zinc-300">
        {line || <br />}
      </div>
    )
  }

  if (meta.fenceLine) {
    const label = line.replace(/^```\s*/, "").trim()
    return (
      <div className="min-h-7 rounded border border-zinc-800 bg-zinc-950 px-3 py-1 font-mono text-xs text-zinc-500">
        {label || "code"}
      </div>
    )
  }

  if (meta.inFence) {
    return (
      <pre className="min-h-7 whitespace-pre-wrap rounded bg-zinc-950 px-3 py-1 font-mono text-sm leading-6 text-zinc-300">
        {line || " "}
      </pre>
    )
  }

  const heading = /^(#{1,6})\s+(.*)$/u.exec(line)
  if (heading) {
    const level = heading[1].length
    const size = level === 1 ? "text-3xl" : level === 2 ? "text-2xl" : level === 3 ? "text-xl" : "text-lg"
    return (
      <div className={`min-h-8 whitespace-pre-wrap break-words font-semibold leading-snug text-zinc-100 ${size}`}>
        {renderInline(heading[2] || " ", onTagClick, onWikiLinkClick)}
      </div>
    )
  }

  const quote = /^>\s?(.*)$/u.exec(line)
  if (quote) {
    return (
      <div className="min-h-7 whitespace-pre-wrap break-words border-l-2 border-zinc-700 pl-3 italic leading-7 text-zinc-300">
        {renderInline(quote[1] || " ", onTagClick, onWikiLinkClick)}
      </div>
    )
  }

  const list = /^(\s*)([-*+]|\d+\.)(\s+)(.*)$/u.exec(line)
  if (list) {
    const ordered = /^\d+\.$/.test(list[2])
    const marker = ordered ? list[2] : "•"
    return (
      <div className="flex min-h-7 gap-2 whitespace-pre-wrap break-words leading-7 text-zinc-300">
        <span className="w-5 shrink-0 select-none text-right text-zinc-500">{marker}</span>
        <span className="min-w-0 flex-1">{renderInline(list[4] || " ", onTagClick, onWikiLinkClick)}</span>
      </div>
    )
  }

  return (
    <div className="min-h-7 whitespace-pre-wrap break-words text-[15px] leading-7 text-zinc-300">
      {line ? renderInline(line, onTagClick, onWikiLinkClick) : <br />}
    </div>
  )
}

function getLineSelection(value: string, range: SelectionRange) {
  const start = Math.max(0, value.lastIndexOf("\n", Math.max(0, range.start - 1)) + 1)
  const nextBreak = value.indexOf("\n", range.end)
  const end = nextBreak === -1 ? value.length : nextBreak
  return { start, end }
}

function setHeadingOnLines(value: string, range: SelectionRange, level: number) {
  const lines = getLineSelection(value, range)
  const prefix = level > 0 ? `${"#".repeat(level)} ` : ""
  const block = value
    .slice(lines.start, lines.end)
    .split("\n")
    .map(line => `${prefix}${line.replace(/^\s{0,3}#{1,6}\s+/, "")}`)
    .join("\n")
  return { next: replaceRange(value, lines.start, lines.end, block), range: lines }
}

function prefixLines(value: string, range: SelectionRange, prefix: string, ordered = false) {
  const lines = getLineSelection(value, range)
  const block = value
    .slice(lines.start, lines.end)
    .split("\n")
    .map((line, index) => {
      const clean = line.replace(/^\s*(?:>\s*|[-*+]\s+|\d+\.\s+)/, "")
      return `${ordered ? `${index + 1}. ` : prefix}${clean}`
    })
    .join("\n")
  return { next: replaceRange(value, lines.start, lines.end, block), range: lines }
}

function findWikiAtOffset(value: string, offset: number) {
  const wikiRe = /\[\[([^\]\r\n]+)\]\]/g
  let match: RegExpExecArray | null
  while ((match = wikiRe.exec(value)) !== null) {
    if (offset >= match.index && offset <= match.index + match[0].length) {
      return getWikiLinkParts(match[1]).target
    }
  }
  return ""
}

function findTagAtOffset(value: string, offset: number) {
  const tagRe = /#(\p{L}[\p{L}\p{N}_-]*)/gu
  let match: RegExpExecArray | null
  while ((match = tagRe.exec(value)) !== null) {
    if (offset >= match.index && offset <= match.index + match[0].length) return match[1]
  }
  return ""
}

export function LiveMarkdownEditor({
  value,
  onChange,
  onTagClick,
  onWikiLinkClick,
  editorRef,
  placeholder,
}: LiveMarkdownEditorProps) {
  const lines = React.useMemo(() => splitLines(value), [value])
  const offsets = React.useMemo(() => lineStartOffsets(lines), [lines])
  const lineMeta = React.useMemo(() => getLineMetadata(lines), [lines])
  const [selection, setSelection] = React.useState<SelectionRange>({ start: 0, end: 0 })
  const [pendingSelection, setPendingSelection] = React.useState<SelectionRange | null>(null)
  const [toolbarOpen, setToolbarOpen] = React.useState(false)
  const [toolbarPos, setToolbarPos] = React.useState({ left: 16, top: 0 })
  const textareaRef = React.useRef<HTMLTextAreaElement>(null)
  const historyRef = React.useRef<{ stack: string[]; index: number }>({ stack: [value], index: 0 })
  const lastEditTimeRef = React.useRef(0)
  const lastEmittedRef = React.useRef(value)
  const composingRef = React.useRef(false)
  const toolbarTimerRef = React.useRef<number | null>(null)
  const activeLine = getLineAtOffset(offsets, selection.start)
  const BATCH_MS = 400

  React.useEffect(() => {
    if (value === lastEmittedRef.current) return
    historyRef.current = { stack: [value], index: 0 }
    setSelection(current => ({
      start: Math.min(current.start, value.length),
      end: Math.min(current.end, value.length),
    }))
  }, [value])

  React.useEffect(() => {
    return () => {
      if (toolbarTimerRef.current) window.clearTimeout(toolbarTimerRef.current)
    }
  }, [])

  React.useLayoutEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = "auto"
    textarea.style.height = `${Math.max(320, textarea.scrollHeight)}px`
    if (pendingSelection) {
      textarea.focus()
      textarea.setSelectionRange(pendingSelection.start, pendingSelection.end)
      setSelection(pendingSelection)
      setPendingSelection(null)
    }
  }, [value, pendingSelection])

  function recordHistory(next: string, force = false) {
    const h = historyRef.current
    const now = Date.now()
    if (!force && now - lastEditTimeRef.current < BATCH_MS) {
      h.stack[h.index] = next
    } else {
      h.stack = h.stack.slice(0, h.index + 1)
      h.stack.push(next)
      if (h.stack.length > 300) h.stack.shift()
      h.index = h.stack.length - 1
    }
    lastEditTimeRef.current = now
  }

  function emitValue(next: string, nextSelection?: SelectionRange, forceHistory = false) {
    recordHistory(next, forceHistory)
    lastEmittedRef.current = next
    setToolbarOpen(false)
    if (nextSelection) setPendingSelection(nextSelection)
    onChange(next)
  }

  function syncSelection(delayToolbar = true) {
    const textarea = textareaRef.current
    if (!textarea) return
    const next = { start: textarea.selectionStart, end: textarea.selectionEnd }
    setSelection(next)
    if (toolbarTimerRef.current) window.clearTimeout(toolbarTimerRef.current)
    if (!delayToolbar || next.start === next.end) {
      setToolbarOpen(false)
      return
    }
    toolbarTimerRef.current = window.setTimeout(() => {
      const line = getLineAtOffset(offsets, next.start)
      setToolbarPos({ left: 16, top: Math.max(0, line * 28 - 44) })
      setToolbarOpen(true)
    }, 1000)
  }

  function applyUndo() {
    const h = historyRef.current
    if (h.index <= 0) return
    h.index--
    lastEditTimeRef.current = 0
    const next = h.stack[h.index]
    lastEmittedRef.current = next
    setToolbarOpen(false)
    setPendingSelection({ start: Math.min(selection.start, next.length), end: Math.min(selection.start, next.length) })
    onChange(next)
  }

  function applyRedo() {
    const h = historyRef.current
    if (h.index >= h.stack.length - 1) return
    h.index++
    lastEditTimeRef.current = 0
    const next = h.stack[h.index]
    lastEmittedRef.current = next
    setToolbarOpen(false)
    setPendingSelection({ start: Math.min(selection.start, next.length), end: Math.min(selection.start, next.length) })
    onChange(next)
  }

  React.useEffect(() => {
    if (!editorRef) return
    ;(editorRef as React.MutableRefObject<TagEditorHandle>).current = { undo: applyUndo, redo: applyRedo }
  })

  function wrapSelection(before: string, after = before, fallback = "") {
    const textarea = textareaRef.current
    if (!textarea) return
    const start = textarea.selectionStart
    const end = textarea.selectionEnd
    const selected = value.slice(start, end) || fallback
    const insert = `${before}${selected}${after}`
    const caretStart = selected ? start + insert.length : start + before.length
    const next = replaceRange(value, start, end, insert)
    emitValue(next, { start: caretStart, end: caretStart }, true)
  }

  function applyColor(color: string) {
    const textarea = textareaRef.current
    if (!textarea || textarea.selectionStart === textarea.selectionEnd) return
    wrapSelection(`<span style="color:${sanitizeColor(color)}">`, "</span>")
  }

  function applyLineTransform(kind: "p" | "h1" | "h2" | "h3" | "quote" | "ul" | "ol") {
    const textarea = textareaRef.current
    if (!textarea) return
    const range = { start: textarea.selectionStart, end: textarea.selectionEnd }
    const result =
      kind === "p" ? setHeadingOnLines(value, range, 0)
      : kind === "h1" ? setHeadingOnLines(value, range, 1)
      : kind === "h2" ? setHeadingOnLines(value, range, 2)
      : kind === "h3" ? setHeadingOnLines(value, range, 3)
      : kind === "quote" ? prefixLines(value, range, "> ")
      : kind === "ol" ? prefixLines(value, range, "", true)
      : prefixLines(value, range, "- ")
    emitValue(result.next, result.range, true)
  }

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const next = e.target.value
    lastEmittedRef.current = next
    recordHistory(next)
    setToolbarOpen(false)
    setSelection({ start: e.target.selectionStart, end: e.target.selectionEnd })
    onChange(next)
  }

  function handleClick(e: React.MouseEvent<HTMLTextAreaElement>) {
    if (!e.metaKey && !e.ctrlKey) return
    const offset = e.currentTarget.selectionStart
    const wiki = findWikiAtOffset(value, offset)
    if (wiki) {
      e.preventDefault()
      onWikiLinkClick?.(wiki)
      return
    }
    const tag = findTagAtOffset(value, offset)
    if (tag) {
      e.preventDefault()
      onTagClick?.(tag)
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    const textarea = e.currentTarget
    const ctrl = e.ctrlKey || e.metaKey
    if (ctrl && !e.shiftKey && e.key === "z") {
      e.preventDefault()
      applyUndo()
      return
    }
    if (ctrl && (e.key === "y" || (e.shiftKey && e.key === "z"))) {
      e.preventDefault()
      applyRedo()
      return
    }
    if (e.key === "Escape") {
      setToolbarOpen(false)
      return
    }
    if (composingRef.current || ctrl || e.altKey) return

    const start = textarea.selectionStart
    const end = textarea.selectionEnd
    const selected = value.slice(start, end)

    if (e.key === "Enter") {
      e.preventDefault()
      const line = lines[getLineAtOffset(offsets, start)] ?? ""
      const continuation = getContinuation(line)
      const insert = `\n${continuation}`
      const next = replaceRange(value, start, end, insert)
      const caret = start + insert.length
      emitValue(next, { start: caret, end: caret }, true)
      return
    }

    if (e.key === "Backspace" && start === end && start > 0 && PAIRS[value[start - 1]] === value[start]) {
      e.preventDefault()
      const next = replaceRange(value, start - 1, start + 1, "")
      emitValue(next, { start: start - 1, end: start - 1 }, true)
      return
    }

    if (CLOSERS.has(e.key) && start === end && value[start] === e.key) {
      e.preventDefault()
      emitValue(value, { start: start + 1, end: start + 1 }, true)
      return
    }

    if (e.key === "[" && start === end && value[start - 1] === "[" && value[start] === "]") {
      e.preventDefault()
      const next = replaceRange(value, start, start, "[]")
      emitValue(next, { start: start + 1, end: start + 1 }, true)
      return
    }

    if (PAIRS[e.key]) {
      e.preventDefault()
      const close = PAIRS[e.key]
      const insert = `${e.key}${selected}${close}`
      const caret = selected ? start + insert.length : start + 1
      const next = replaceRange(value, start, end, insert)
      emitValue(next, { start: caret, end: caret }, true)
    }
  }

  return (
    <div className="relative min-h-[320px] pb-24">
      {toolbarOpen ? (
        <div
          className="absolute z-20 flex items-center gap-0.5 rounded-md border border-zinc-700 bg-zinc-950/95 p-1 shadow-xl backdrop-blur"
          style={{ left: toolbarPos.left, top: toolbarPos.top }}
          onMouseDown={e => e.preventDefault()}
        >
          {[
            { title: "Paragraph", icon: Pilcrow, action: () => applyLineTransform("p") },
            { title: "Heading 1", icon: Heading1, action: () => applyLineTransform("h1") },
            { title: "Heading 2", icon: Heading2, action: () => applyLineTransform("h2") },
            { title: "Heading 3", icon: Heading3, action: () => applyLineTransform("h3") },
            { title: "Bold", icon: Bold, action: () => wrapSelection("**") },
            { title: "Italic", icon: Italic, action: () => wrapSelection("*") },
            { title: "Strike", icon: Strikethrough, action: () => wrapSelection("~~") },
            { title: "Code", icon: Code2, action: () => wrapSelection("`") },
            { title: "Quote", icon: Quote, action: () => applyLineTransform("quote") },
            { title: "Bullet list", icon: List, action: () => applyLineTransform("ul") },
            { title: "Numbered list", icon: ListOrdered, action: () => applyLineTransform("ol") },
            { title: "Wiki link", icon: Link, action: () => wrapSelection("[[", "]]", "Note") },
            { title: "Markdown link", icon: Link, action: () => wrapSelection("[", "](url)") },
          ].map(item => (
            <button
              key={item.title}
              type="button"
              title={item.title}
              className="flex size-7 items-center justify-center rounded text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
              onClick={item.action}
            >
              <item.icon className="size-3.5" />
            </button>
          ))}
          <div className="mx-1 h-5 w-px bg-zinc-800" />
          <Palette className="mx-1 size-3.5 text-zinc-500" />
          {COLORS.map(color => (
            <button
              key={color}
              type="button"
              title={color}
              className="size-5 rounded border border-zinc-700 transition-transform hover:scale-110"
              style={{ backgroundColor: color }}
              onClick={() => applyColor(color)}
            />
          ))}
        </div>
      ) : null}

      {!value && placeholder ? (
        <div className="pointer-events-none absolute left-0 top-0 text-[15px] leading-7 text-zinc-600">
          {placeholder}
        </div>
      ) : null}

      <div className="pointer-events-none absolute inset-x-0 top-0">
        {lines.map((line, index) => (
          <PreviewLine
            key={index}
            line={line}
            meta={lineMeta[index]}
            active={index === activeLine}
            onTagClick={onTagClick}
            onWikiLinkClick={onWikiLinkClick}
          />
        ))}
      </div>

      <textarea
        ref={textareaRef}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onSelect={() => syncSelection(true)}
        onKeyUp={() => syncSelection(true)}
        onClick={handleClick}
        onMouseUp={() => syncSelection(true)}
        onBlur={() => window.setTimeout(() => setToolbarOpen(false), 120)}
        onCompositionStart={() => { composingRef.current = true }}
        onCompositionEnd={() => { composingRef.current = false }}
        rows={1}
        spellCheck
        className="relative z-10 block min-h-[320px] w-full resize-none overflow-hidden bg-transparent pb-24 font-mono text-sm leading-7 text-transparent caret-zinc-100 selection:bg-sky-500/35 placeholder:text-zinc-600 focus:outline-none"
        placeholder={placeholder}
      />
    </div>
  )
}
