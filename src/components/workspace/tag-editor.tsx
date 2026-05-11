"use client"

import * as React from "react"

const TAG_RE = /#([a-zA-Z][a-zA-Z0-9_-]*)/g

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
  // Custom undo/redo stack — batched by typing pauses and word boundaries
  const undoStack = React.useRef<string[]>([value])
  const redoStack = React.useRef<string[]>([])
  const lastEditTime = React.useRef(0)
  const BATCH_MS = 1200

  function pushCheckpoint() {
    const now = Date.now()
    if (now - lastEditTime.current > BATCH_MS) {
      undoStack.current.push(value)
      if (undoStack.current.length > 300) undoStack.current.shift()
      redoStack.current = []
    }
    lastEditTime.current = now
  }

  function applyUndo() {
    if (undoStack.current.length <= 1) return
    // flush current state first if needed
    const last = undoStack.current[undoStack.current.length - 1]
    if (last !== value) {
      redoStack.current.push(value)
      const prev = undoStack.current[undoStack.current.length - 1]
      onChange(prev)
    } else {
      undoStack.current.pop()
      redoStack.current.push(value)
      const prev = undoStack.current[undoStack.current.length - 1]
      onChange(prev)
    }
    lastEditTime.current = 0
  }

  function applyRedo() {
    if (!redoStack.current.length) return
    const next = redoStack.current.pop()!
    undoStack.current.push(value)
    onChange(next)
    lastEditTime.current = 0
  }

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    pushCheckpoint()
    onChange(e.target.value)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    const ctrl = e.ctrlKey || e.metaKey
    if (ctrl && !e.shiftKey && e.key === 'z') {
      e.preventDefault()
      applyUndo()
      return
    }
    if (ctrl && (e.key === 'y' || (e.shiftKey && e.key === 'z'))) {
      e.preventDefault()
      applyRedo()
      return
    }
    // Force new batch at word/line boundaries
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Backspace' || e.key === 'Delete') {
      lastEditTime.current = 0
    }
  }

  // Expose undo/redo to parent
  React.useEffect(() => {
    if (!editorRef) return
    ;(editorRef as React.MutableRefObject<TagEditorHandle>).current = {
      undo: applyUndo,
      redo: applyRedo,
    }
  })

  // Auto-resize textarea
  React.useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${el.scrollHeight}px`
  }, [value, textareaRef])

  // Backdrop nodes: same text but transparent, with violet background on tags
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
          title={`#${tagName}`}
          onClick={(e) => { e.stopPropagation(); onTagClick?.(tagName) }}
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
    // Trailing char prevents last-line height collapse
    parts.push(<span key="nl" style={{ color: 'transparent' }}>{'\n'}</span>)
    return parts
  }, [value, onTagClick])

  return (
    <div className="relative">
      {/* Backdrop — absolute overlay with tag highlights, pointer-events pass-through except on marks */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-[2] break-words font-mono text-sm leading-relaxed"
        style={{
          whiteSpace: 'pre-wrap',
          overflowWrap: 'break-word',
          paddingBottom: '5rem',
          // No background — transparent, textarea text shows through
        }}
      >
        {backdropContent}
      </div>

      {/* Actual editing textarea */}
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
