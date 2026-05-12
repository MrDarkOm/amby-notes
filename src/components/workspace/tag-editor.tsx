"use client"

import * as React from "react"

// Unicode-aware: matches #тег, #tag, #タグ etc.
const TAG_RE = /#(\p{L}[\p{L}\p{N}_-]*)/gu

export interface TagEditorHandle {
  undo: () => void
  redo: () => void
}

interface TagEditorProps {
  value: string
  onChange: (v: string) => void
  onTagClick?: (tag: string) => void
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  editorRef?: React.RefObject<TagEditorHandle>
  placeholder?: string
}

export function TagEditor({ value, onChange, onTagClick, textareaRef, editorRef, placeholder }: TagEditorProps) {
  // ── Index-based undo/redo ──────────────────────────────────────────
  // history.stack[history.index] always reflects the current content.
  // Typing within BATCH_MS updates the current slot (no new entry).
  // After a pause, the next character creates a new entry (new batch).
  // Enter/Space/Backspace force a new batch on the *next* keystroke.
  const historyRef = React.useRef<{ stack: string[]; index: number }>({
    stack: [value],
    index: 0,
  })
  const lastEditTimeRef = React.useRef(0)
  const BATCH_MS = 400

  function recordHistory(newValue: string) {
    const h = historyRef.current
    const now = Date.now()
    if (now - lastEditTimeRef.current < BATCH_MS) {
      // Same batch — update current slot
      h.stack[h.index] = newValue
    } else {
      // New batch — truncate forward history and append
      h.stack = h.stack.slice(0, h.index + 1)
      h.stack.push(newValue)
      if (h.stack.length > 300) h.stack.shift()
      h.index = h.stack.length - 1
    }
    lastEditTimeRef.current = now
  }

  function applyUndo() {
    const h = historyRef.current
    if (h.index <= 0) return
    // Flush any unsaved current state into the stack
    if (h.stack[h.index] !== value) {
      h.stack[h.index] = value
    }
    h.index--
    lastEditTimeRef.current = 0 // next edit starts a fresh batch
    onChange(h.stack[h.index])
  }

  function applyRedo() {
    const h = historyRef.current
    if (h.index >= h.stack.length - 1) return
    h.index++
    lastEditTimeRef.current = 0
    onChange(h.stack[h.index])
  }

  // Expose undo/redo to parent (for floating widget buttons)
  React.useEffect(() => {
    if (!editorRef) return
    ;(editorRef as React.MutableRefObject<TagEditorHandle>).current = { undo: applyUndo, redo: applyRedo }
  })

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    recordHistory(e.target.value)
    onChange(e.target.value)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    const ctrl = e.ctrlKey || e.metaKey
    if (ctrl && !e.shiftKey && e.key === 'z') { e.preventDefault(); applyUndo(); return }
    if (ctrl && (e.key === 'y' || (e.shiftKey && e.key === 'z'))) { e.preventDefault(); applyRedo(); return }
    // Force new batch at natural word/line boundaries
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Backspace' || e.key === 'Delete') {
      lastEditTimeRef.current = 0
    }
  }

  // Auto-resize
  React.useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [value, textareaRef])

  // ── Backdrop nodes: transparent text + violet backgrounds on tags ──
  const backdropContent = React.useMemo(() => {
    const parts: React.ReactNode[] = []
    let last = 0
    TAG_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = TAG_RE.exec(value)) !== null) {
      if (m.index > last) {
        parts.push(
          <span key={`t${last}`} style={{ color: 'transparent', whiteSpace: 'pre-wrap' }}>
            {value.slice(last, m.index)}
          </span>
        )
      }
      const tagName = m[1]
      const tagFull = m[0]
      parts.push(
        <mark
          key={`m${m.index}`}
          title={`Тег: #${tagName}`}
          onClick={e => { e.stopPropagation(); onTagClick?.(tagName) }}
          style={{
            color: 'transparent',
            background: 'rgba(139,92,246,0.22)',
            borderRadius: '3px',
            cursor: 'pointer',
            pointerEvents: 'auto',
          }}
        >
          {tagFull}
        </mark>
      )
      last = m.index + m[0].length
    }
    if (last < value.length) {
      parts.push(
        <span key={`te${last}`} style={{ color: 'transparent', whiteSpace: 'pre-wrap' }}>
          {value.slice(last)}
        </span>
      )
    }
    parts.push(<span key="nl" style={{ color: 'transparent' }}>{'\n'}</span>)
    return parts
  }, [value, onTagClick])

  return (
    <div className="relative">
      {/* Backdrop — z-index above textarea, pointer-events none except tag marks */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-[2] break-words font-mono text-sm leading-relaxed"
        style={{ whiteSpace: 'pre-wrap', overflowWrap: 'break-word', paddingBottom: '5rem' }}
      >
        {backdropContent}
      </div>

      {/* Textarea — actual editing, background transparent so backdrop shows through */}
      <textarea
        ref={textareaRef as React.RefObject<HTMLTextAreaElement>}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        rows={1}
        className="relative z-[1] w-full resize-none overflow-hidden bg-transparent pb-20 font-mono text-sm leading-relaxed text-zinc-300 placeholder:text-zinc-600 focus:outline-none"
      />
    </div>
  )
}
