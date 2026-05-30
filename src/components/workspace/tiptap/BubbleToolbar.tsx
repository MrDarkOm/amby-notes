"use client"

import * as React from "react"
import type { Editor } from "@tiptap/react"
import { useTranslation } from "react-i18next"
import {
  Bold,
  CheckSquare,
  Code2,
  Hash,
  Heading,
  Italic,
  Link,
  List,
  ListOrdered,
  Loader2,
  MessageSquare,
  Palette,
  Pilcrow,
  Quote,
  Sparkles,
  Strikethrough,
  Underline,
} from "lucide-react"

import { TextStylePalette } from "../text-style-palette"
import { CALLOUT_DEFAULTS } from "./callout-node"
import { wrapSelectionInCallout } from "./block-insert-items"
import { aiChat, AiUnavailableError } from "@/lib/ai"
import { activeModel, loadSettings, resolveAiConfig } from "../app-config"

type Panel = "heading" | "color" | "list" | "tag" | "link" | "wikilink" | "ai" | null

interface AiAction {
  id: string
  labelKey: string
  /** "replace" overwrites the selection; "after" appends below it. */
  mode: "replace" | "after"
  prompt: (text: string) => string
}

const AI_ACTIONS: AiAction[] = [
  {
    id: "rewrite",
    labelKey: "ai.actions.rewrite",
    mode: "replace",
    prompt: text => `Rewrite the text to be clearer and better, preserving its meaning and language. Return only the result:\n\n${text}`,
  },
  {
    id: "shorten",
    labelKey: "ai.actions.shorten",
    mode: "replace",
    prompt: text => `Shorten the text, preserving its essence and language. Return only the result:\n\n${text}`,
  },
  {
    id: "continue",
    labelKey: "ai.actions.continue",
    mode: "after",
    prompt: text => `Continue the text in the same style and language. Return only the continuation:\n\n${text}`,
  },
  {
    id: "explain",
    labelKey: "ai.actions.explain",
    mode: "after",
    prompt: text => `Explain the following fragment in simple terms, in the same language as the fragment. Return only the explanation:\n\n${text}`,
  },
]

interface BubbleToolbarProps {
  editor: Editor
  left: number
  top: number
}

function ToolbarButton({
  title,
  active,
  children,
  onClick,
}: {
  title: string
  active?: boolean
  children: React.ReactNode
  onClick: () => void
}) {
  return (
    <button
      type="button"
      title={title}
      className={`flex size-7 items-center justify-center rounded transition-colors ${
        active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground"
      }`}
      onMouseDown={e => e.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

const HEADINGS: Array<{ label: string; level: 1 | 2 | 3 | 4 | 5 | null; Icon?: React.ElementType }> = [
  { label: "P", level: null, Icon: Pilcrow },
  { label: "H1", level: 1 },
  { label: "H2", level: 2 },
  { label: "H3", level: 3 },
  { label: "H4", level: 4 },
  { label: "H5", level: 5 },
]

export function BubbleToolbar({ editor, left, top }: BubbleToolbarProps) {
  const { t } = useTranslation()
  const [panel, setPanel] = React.useState<Panel>(null)
  const [inputValue, setInputValue] = React.useState("")
  const [linkLabel, setLinkLabel] = React.useState("")
  // Track whether selection was empty when the link panel was opened.
  const [linkHasSelection, setLinkHasSelection] = React.useState(false)
  const [aiBusy, setAiBusy] = React.useState(false)
  const [aiError, setAiError] = React.useState<string | null>(null)
  const mountedRef = React.useRef(true)
  React.useEffect(() => () => { mountedRef.current = false }, [])

  async function runAiAction(action: AiAction) {
    if (aiBusy) return
    const { from, to } = editor.state.selection
    const selected = editor.state.doc.textBetween(from, to, " ").trim()
    if (!selected) return
    setAiBusy(true)
    setAiError(null)
    try {
      const settings = await loadSettings()
      const model = activeModel(settings.ai)
      if (!model) {
        if (mountedRef.current) setAiError(t("ai.noModelShort"))
        return
      }
      const result = (
        await aiChat(resolveAiConfig(model), [{ role: "user", content: action.prompt(selected) }])
      ).trim()
      if (!result) return
      if (action.mode === "after") {
        editor.chain().focus().insertContentAt(to, `\n\n${result}`).run()
      } else {
        editor.chain().focus().insertContentAt({ from, to }, result).run()
      }
      if (mountedRef.current) setPanel(null)
    } catch (e) {
      if (mountedRef.current) {
        setAiError(e instanceof AiUnavailableError ? e.message : String(e))
      }
    } finally {
      if (mountedRef.current) setAiBusy(false)
    }
  }

  function openPanel(next: Exclude<Panel, null>) {
    setInputValue("")
    setLinkLabel("")
    setPanel(prev => (prev === next ? null : next))
  }

  function closePanel() {
    setPanel(null)
    setInputValue("")
    setLinkLabel("")
  }

  function setHeading(level: 1 | 2 | 3 | 4 | 5 | null) {
    if (level === null) editor.chain().focus().setParagraph().run()
    else editor.chain().focus().setHeading({ level }).run()
    closePanel()
  }

  function applyTextColor(color: string | null) {
    editor.chain().focus().setAmbyTextStyle({ color }).run()
  }

  function applyBackgroundColor(color: string | null) {
    editor.chain().focus().setAmbyTextStyle({ backgroundColor: color }).run()
  }

  // ── Tag panel ──────────────────────────────────────────────────────────────
  function openTagPanel() {
    const { from, to } = editor.state.selection
    if (from !== to) {
      // Selection exists: wrap immediately without opening the input panel
      const selected = editor.state.doc.textBetween(from, to, " ").trim()
      const slug = selected.replace(/\s+/g, "-").replace(/[^\p{L}\p{N}_\-/]/gu, "")
      if (slug) {
        editor.chain().focus().insertContentAt({ from, to }, `#${slug} `).run()
        return
      }
    }
    setInputValue("")
    setPanel("tag")
  }

  function applyTag() {
    const tag = inputValue.replace(/^#/, "").trim()
    if (!tag) return
    editor.chain().focus().insertContent(`#${tag} `).run()
  }

  // ── Link panel ─────────────────────────────────────────────────────────────
  function openLinkPanel() {
    const isEmpty = editor.state.selection.empty
    setLinkHasSelection(!isEmpty)
    setInputValue("")
    setLinkLabel("")
    setPanel("link")
  }

  function applyLink() {
    const url = inputValue.trim()
    if (!url) return
    if (!linkHasSelection) {
      const label = linkLabel.trim() || url
      editor.chain().focus().insertContent(`[${label}](${url})`).run()
    } else {
      editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run()
    }
  }

  // ── Wikilink panel ─────────────────────────────────────────────────────────
  function openWikilinkPanel() {
    const { from, to } = editor.state.selection
    const selected = editor.state.doc.textBetween(from, to, " ").trim()
    if (from !== to && selected) {
      // Selection exists: wrap immediately as [[selected text]]
      editor.chain().focus().insertContentAt({ from, to }, `[[${selected}]]`).run()
      return
    }
    setInputValue(selected)
    setPanel("wikilink")
  }

  function applyWikilink() {
    const target = inputValue.trim()
    if (!target) return
    editor.chain().focus().insertContent(`[[${target}]]`).run()
  }

  // ── Callout ────────────────────────────────────────────────────────────────
  function insertCallout() {
    const { from, to } = editor.state.selection
    if (from !== to) {
      // Selection exists: wrap the selected block(s) in a callout
      wrapSelectionInCallout(editor)
      return
    }
    editor.chain().focus().insertContent({
      type: "callout",
      attrs: { calloutType: "NOTE", emoji: CALLOUT_DEFAULTS.NOTE },
      content: [{ type: "paragraph" }],
    }).run()
  }

  // Shared input key handler
  function handleInputKey(
    e: React.KeyboardEvent<HTMLInputElement>,
    onEnter: () => void
  ) {
    if (e.key === "Enter") {
      e.preventDefault()
      onEnter()
      closePanel()
    }
    if (e.key === "Escape") closePanel()
  }

  return (
    <div
      className="amby-floating-menu fixed z-50 flex items-center gap-1 rounded-md border border-border bg-popover p-1 shadow-xl backdrop-blur"
      style={{ left, top }}
      onMouseDown={e => {
        // Prevent editor blur when clicking toolbar buttons; allow it for
        // <input> elements so they can receive focus naturally.
        if (!(e.target instanceof HTMLInputElement)) e.preventDefault()
      }}
    >
      <ToolbarButton title={t("editor.heading")} active={panel === "heading"} onClick={() => openPanel("heading")}>
        <Heading className="size-3.5" />
      </ToolbarButton>
      <ToolbarButton
        title="Bold"
        active={editor.isActive("bold")}
        onClick={() => editor.chain().focus().toggleBold().run()}
      >
        <Bold className="size-3.5" />
      </ToolbarButton>
      <ToolbarButton
        title="Italic"
        active={editor.isActive("italic")}
        onClick={() => editor.chain().focus().toggleItalic().run()}
      >
        <Italic className="size-3.5" />
      </ToolbarButton>
      <ToolbarButton
        title="Underline"
        active={editor.isActive("ambyUnderline")}
        onClick={() => editor.chain().focus().toggleAmbyUnderline().run()}
      >
        <Underline className="size-3.5" />
      </ToolbarButton>
      <ToolbarButton
        title="Strike"
        active={editor.isActive("strike")}
        onClick={() => editor.chain().focus().toggleStrike().run()}
      >
        <Strikethrough className="size-3.5" />
      </ToolbarButton>
      <ToolbarButton
        title="Code"
        active={editor.isActive("code")}
        onClick={() => editor.chain().focus().toggleCode().run()}
      >
        <Code2 className="size-3.5" />
      </ToolbarButton>

      <ToolbarButton title="List" active={panel === "list"} onClick={() => openPanel("list")}>
        <List className="size-3.5" />
      </ToolbarButton>
      <ToolbarButton
        title="Quote"
        active={editor.isActive("blockquote")}
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
      >
        <Quote className="size-3.5" />
      </ToolbarButton>
      <ToolbarButton title="Callout" onClick={insertCallout}>
        <MessageSquare className="size-3.5" />
      </ToolbarButton>

      <div className="mx-1 h-5 w-px bg-accent" />

      <ToolbarButton title={t("editor.tag")} active={panel === "tag"} onClick={openTagPanel}>
        <Hash className="size-3.5" />
      </ToolbarButton>
      <ToolbarButton title="Backlink" active={panel === "wikilink"} onClick={openWikilinkPanel}>
        <span className="text-[10px] font-semibold">[[</span>
      </ToolbarButton>
      <ToolbarButton title="URL link" active={panel === "link"} onClick={openLinkPanel}>
        <Link className="size-3.5" />
      </ToolbarButton>

      <div className="mx-1 h-5 w-px bg-accent" />

      <ToolbarButton title={t("editor.color")} active={panel === "color"} onClick={() => openPanel("color")}>
        <Palette className="size-3.5" />
      </ToolbarButton>

      <div className="mx-1 h-5 w-px bg-accent" />

      <ToolbarButton title="AI" active={panel === "ai"} onClick={() => openPanel("ai")}>
        <Sparkles className="size-3.5 text-sky-400" />
      </ToolbarButton>

      {panel && (
        <div className="absolute left-0 top-[calc(100%+6px)] rounded-md border border-border bg-popover p-1 shadow-xl">
          {/* ── Heading picker ─────────────────────────────────────────────── */}
          {panel === "heading" && (
            <div className="grid grid-cols-3 gap-1">
              {HEADINGS.map(({ label, level, Icon }) => (
                <button
                  key={label}
                  type="button"
                  className="flex h-8 min-w-10 items-center justify-center rounded px-2 text-xs font-semibold text-foreground hover:bg-accent hover:text-white"
                  onMouseDown={e => e.preventDefault()}
                  onClick={() => setHeading(level)}
                >
                  {Icon ? <Icon className="size-3.5" /> : label}
                </button>
              ))}
            </div>
          )}

          {/* ── Color palette ───────────────────────────────────────────────── */}
          {panel === "color" && (
            <TextStylePalette
              onTextColor={color => applyTextColor(color)}
              onBackgroundColor={color => applyBackgroundColor(color)}
              onClearTextColor={() => applyTextColor(null)}
              onClearBackgroundColor={() => applyBackgroundColor(null)}
            />
          )}

          {/* ── List type picker ────────────────────────────────────────────── */}
          {panel === "list" && (
            <div className="flex items-center gap-1">
              <ToolbarButton
                title="Bullet list"
                onClick={() => {
                  editor.chain().focus().toggleBulletList().run()
                  closePanel()
                }}
              >
                <List className="size-3.5" />
              </ToolbarButton>
              <ToolbarButton
                title="Ordered list"
                onClick={() => {
                  editor.chain().focus().toggleOrderedList().run()
                  closePanel()
                }}
              >
                <ListOrdered className="size-3.5" />
              </ToolbarButton>
              <ToolbarButton
                title="Task list"
                onClick={() => {
                  editor.chain().focus().toggleTaskList().run()
                  closePanel()
                }}
              >
                <CheckSquare className="size-3.5" />
              </ToolbarButton>
            </div>
          )}

          {/* ── Tag input ───────────────────────────────────────────────────── */}
          {panel === "tag" && (
            <div className="flex items-center gap-1.5 px-1.5 py-1">
              <span className="text-xs text-muted-foreground">#</span>
              <input
                autoFocus
                type="text"
                className="w-40 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
                placeholder="tagname"
                value={inputValue}
                onChange={e => setInputValue(e.target.value)}
                onKeyDown={e => handleInputKey(e, applyTag)}
                onMouseDown={e => e.stopPropagation() /* let focus transfer; outer guard handles blur */}
              />
            </div>
          )}

          {/* ── Link input ──────────────────────────────────────────────────── */}
          {panel === "link" && (
            <div className="flex flex-col gap-1 px-1.5 py-1">
              <div className="flex items-center gap-1.5">
                <span className="w-8 shrink-0 text-[10px] text-muted-foreground">URL</span>
                <input
                  autoFocus
                  type="url"
                  className="w-48 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
                  placeholder="https://..."
                  value={inputValue}
                  onChange={e => setInputValue(e.target.value)}
                  onKeyDown={e => handleInputKey(e, applyLink)}
                  onMouseDown={e => e.stopPropagation() /* let focus transfer; outer guard handles blur */}
                />
              </div>
              {!linkHasSelection && (
                <div className="flex items-center gap-1.5">
                  <span className="w-8 shrink-0 text-[10px] text-muted-foreground">Text</span>
                  <input
                    type="text"
                    className="w-48 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
                    placeholder="Link label"
                    value={linkLabel}
                    onChange={e => setLinkLabel(e.target.value)}
                    onKeyDown={e => handleInputKey(e, applyLink)}
                    onMouseDown={e => e.stopPropagation() /* let focus transfer; outer guard handles blur */}
                  />
                </div>
              )}
              <p className="text-[10px] text-muted-foreground">Enter to confirm · Esc to cancel</p>
            </div>
          )}

          {/* ── AI actions ──────────────────────────────────────────────────── */}
          {panel === "ai" && (
            <div className="flex w-44 flex-col gap-0.5 p-0.5">
              {AI_ACTIONS.map(action => (
                <button
                  key={action.id}
                  type="button"
                  disabled={aiBusy}
                  className="flex items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] text-foreground hover:bg-accent hover:text-white disabled:opacity-50"
                  onMouseDown={e => e.preventDefault()}
                  onClick={() => void runAiAction(action)}
                >
                  <Sparkles className="size-3.5 text-sky-400" />
                  {t(action.labelKey)}
                </button>
              ))}
              {aiBusy && (
                <div className="flex items-center gap-2 px-2 py-1.5 text-[12px] text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" />
                  {t("ai.generating")}
                </div>
              )}
              {aiError && (
                <div className="px-2 py-1.5 text-[11px] text-red-400">{aiError}</div>
              )}
            </div>
          )}

          {/* ── Wikilink input ──────────────────────────────────────────────── */}
          {panel === "wikilink" && (
            <div className="flex items-center gap-1.5 px-1.5 py-1">
              <span className="text-[10px] text-muted-foreground">[[</span>
              <input
                autoFocus
                type="text"
                className="w-44 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
                placeholder="Note name"
                value={inputValue}
                onChange={e => setInputValue(e.target.value)}
                onKeyDown={e => handleInputKey(e, applyWikilink)}
                onMouseDown={e => e.stopPropagation() /* let focus transfer; outer guard handles blur */}
              />
              <span className="text-[10px] text-muted-foreground">]]</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
