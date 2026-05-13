"use client"

import * as React from "react"
import { Crepe } from "@milkdown/crepe"
import "@milkdown/crepe/theme/common/style.css"
import "@milkdown/crepe/theme/frame-dark.css"
import type { Ctx } from "@milkdown/kit/ctx"
import { commandsCtx, editorViewCtx } from "@milkdown/kit/core"
import {
  headingSchema,
  paragraphSchema,
  setBlockTypeCommand,
  toggleEmphasisCommand,
  toggleInlineCodeCommand,
  toggleLinkCommand,
  toggleStrongCommand,
  wrapInBlockquoteCommand,
  wrapInBulletListCommand,
  wrapInOrderedListCommand,
} from "@milkdown/kit/preset/commonmark"
import { toggleStrikethroughCommand } from "@milkdown/kit/preset/gfm"
import type { MarkType } from "@milkdown/kit/prose/model"
import { redo, undo } from "@milkdown/kit/prose/history"
import { Plugin, PluginKey } from "@milkdown/kit/prose/state"
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view"
import { $mark, $node, $prose, insert } from "@milkdown/kit/utils"
import {
  Bold,
  CheckSquare,
  Code2,
  Heading,
  Hash,
  Italic,
  Link,
  List,
  ListOrdered,
  MessageSquare,
  Palette,
  Pilcrow,
  Quote,
  Smile,
  Strikethrough,
  Underline,
} from "lucide-react"

import type { TagEditorHandle } from "./tag-editor"
import { TextStylePalette } from "./text-style-palette"

interface MilkdownMarkdownEditorProps {
  value: string
  onChange: (v: string) => void
  editorRef?: React.RefObject<TagEditorHandle>
  placeholder?: string
  documentId?: string
}

interface MenuState {
  open: boolean
  left: number
  top: number
}

type Panel = "heading" | "color" | "list" | "emoji" | null
type BlockCommand = "paragraph" | "h1" | "h2" | "h3" | "h4" | "h5"
type InlineCommand = "bold" | "italic" | "strike" | "code" | "underline"
type ListCommand = "bullet" | "ordered" | "task"

const HEX_RE = /^#[0-9a-fA-F]{6}$/
const INLINE_TOKEN_RE = /#(\p{L}[\p{L}\p{N}_-]*)|\[\[([^\]\r\n]+)\]\]/gu
const SAFE_SPAN_RE = /^<span\s+style=["']([^"']*)["']>(.*?)<\/span>$/is
const SAFE_UNDERLINE_RE = /^<u>(.*?)<\/u>$/is
const EMOJIS = ["✨", "✅", "🔥", "💡", "📌", "⭐", "❤️", "🚀", "🧠", "🎯", "⚠️", "📝"]

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

function escapeHtml(text: string) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

function unescapeHtml(text: string) {
  const template = document.createElement("template")
  template.innerHTML = text
  return template.content.textContent ?? text
}

function parseSafeStyle(style: string): { color?: string; backgroundColor?: string } {
  const result: { color?: string; backgroundColor?: string } = {}
  for (const part of style.split(";")) {
    const [rawKey, rawValue] = part.split(":")
    const key = rawKey?.trim().toLowerCase()
    const value = rawValue?.trim()
    if (!value || !HEX_RE.test(value)) continue
    if (key === "color") result.color = value
    if (key === "background-color") result.backgroundColor = value
  }
  return result
}

function styleAttrsToCss(attrs: { color?: string | null; backgroundColor?: string | null }) {
  const parts: string[] = []
  if (attrs.color && HEX_RE.test(attrs.color)) parts.push(`color:${attrs.color}`)
  if (attrs.backgroundColor && HEX_RE.test(attrs.backgroundColor)) parts.push(`background-color:${attrs.backgroundColor}`)
  return parts.join(";")
}

const textStyleMark = $mark("amby_text_style", () => ({
  priority: 80,
  attrs: {
    color: { default: null, validate: "string|null" },
    backgroundColor: { default: null, validate: "string|null" },
  },
  parseDOM: [
    {
      tag: "span[style]",
      getAttrs: dom => {
        if (!(dom instanceof HTMLElement)) return false
        const attrs = parseSafeStyle(dom.getAttribute("style") ?? "")
        return attrs.color || attrs.backgroundColor ? attrs : false
      },
    },
  ],
  toDOM: mark => ["span", { style: styleAttrsToCss(mark.attrs) }, 0],
  parseMarkdown: {
    match: () => false,
    runner: () => {},
  },
  toMarkdown: {
    match: mark => mark.type.name === "amby_text_style",
    runner: (state, mark, node) => {
      const style = styleAttrsToCss(mark.attrs)
      if (!style || !node.isText) return false
      const text = escapeHtml(node.text ?? "")
      const hasUnderline = node.marks.some(item => item.type.name === "amby_underline")
      state.addNode("html", undefined, `<span style="${style}">${hasUnderline ? `<u>${text}</u>` : text}</span>`)
      return true
    },
  },
}))

const underlineMark = $mark("amby_underline", () => ({
  priority: 90,
  parseDOM: [
    { tag: "u" },
    {
      style: "text-decoration",
      getAttrs: value => String(value).includes("underline") && null,
    },
  ],
  toDOM: () => ["u", 0],
  parseMarkdown: {
    match: () => false,
    runner: () => {},
  },
  toMarkdown: {
    match: mark => mark.type.name === "amby_underline",
    runner: (state, _mark, node) => {
      if (node.marks.some(item => item.type.name === "amby_text_style")) return false
      if (!node.isText) return false
      state.addNode("html", undefined, `<u>${escapeHtml(node.text ?? "")}</u>`)
      return true
    },
  },
}))

const safeHtmlNode = $node("html", ctx => ({
  atom: true,
  group: "inline",
  inline: true,
  attrs: {
    value: { default: "", validate: "string" },
  },
  toDOM: node => {
    const span = document.createElement("span")
    span.textContent = node.attrs.value
    return ["span", { "data-type": "html", "data-value": node.attrs.value }, node.attrs.value]
  },
  parseDOM: [
    {
      tag: "span[data-type='html']",
      getAttrs: dom => ({ value: dom instanceof HTMLElement ? dom.dataset.value ?? "" : "" }),
    },
  ],
  parseMarkdown: {
    match: node => node.type === "html",
    runner: (state, node, type) => {
      const raw = String(node.value ?? "")
      const spanMatch = raw.match(SAFE_SPAN_RE)
      if (spanMatch) {
        const attrs = parseSafeStyle(spanMatch[1])
        if (attrs.color || attrs.backgroundColor) {
          const nestedUnderline = spanMatch[2].match(SAFE_UNDERLINE_RE)
          state.openMark(textStyleMark.type(ctx), attrs)
          if (nestedUnderline) state.openMark(underlineMark.type(ctx))
          state.addText(unescapeHtml(nestedUnderline ? nestedUnderline[1] : spanMatch[2]))
          if (nestedUnderline) state.closeMark(underlineMark.type(ctx))
          state.closeMark(textStyleMark.type(ctx))
          return
        }
      }

      const underlineMatch = raw.match(SAFE_UNDERLINE_RE)
      if (underlineMatch) {
        state.openMark(underlineMark.type(ctx))
        state.addText(unescapeHtml(underlineMatch[1]))
        state.closeMark(underlineMark.type(ctx))
        return
      }

      state.addNode(type, { value: raw })
    },
  },
  toMarkdown: {
    match: node => node.type.name === "html",
    runner: (state, node) => {
      state.addNode("html", undefined, node.attrs.value)
    },
  },
}))

const inlineTokenDecorations = $prose(() => {
  return new Plugin({
    key: new PluginKey("amby-inline-token-decorations"),
    props: {
      decorations(state) {
        const decorations: Decoration[] = []
        state.doc.descendants((node, pos) => {
          if (!node.isText || !node.text) return
          INLINE_TOKEN_RE.lastIndex = 0
          let match: RegExpExecArray | null
          while ((match = INLINE_TOKEN_RE.exec(node.text)) !== null) {
            decorations.push(
              Decoration.inline(pos + match.index, pos + match.index + match[0].length, {
                class: match[1] ? "amby-live-tag" : "amby-live-wikilink",
              })
            )
          }
        })
        return DecorationSet.create(state.doc, decorations)
      },
    },
  })
})

function MenuButton({
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
        active ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
      }`}
      onMouseDown={e => e.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

export function MilkdownMarkdownEditor({
  value,
  onChange,
  editorRef,
  placeholder = "Начни писать...",
  documentId,
}: MilkdownMarkdownEditorProps) {
  const rootRef = React.useRef<HTMLDivElement>(null)
  const crepeRef = React.useRef<Crepe | null>(null)
  const instanceRef = React.useRef(0)
  const valueRef = React.useRef(value)
  const onChangeRef = React.useRef(onChange)
  const selectionRef = React.useRef<{ from: number; to: number } | null>(null)
  const [panel, setPanel] = React.useState<Panel>(null)
  const [menu, setMenu] = React.useState<MenuState>({ open: false, left: 16, top: 0 })

  React.useEffect(() => {
    valueRef.current = value
  }, [value])

  React.useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  React.useEffect(() => {
    selectionRef.current = null
    setPanel(null)
    setMenu(prev => prev.open ? { ...prev, open: false } : prev)
  }, [documentId])

  React.useEffect(() => {
    const root = rootRef.current
    if (!root) return

    const instance = ++instanceRef.current
    let cancelled = false
    root.replaceChildren()

    const crepe = new Crepe({
      root,
      defaultValue: value,
      features: {
        [Crepe.Feature.Toolbar]: false,
      },
      featureConfigs: {
        [Crepe.Feature.Placeholder]: { text: placeholder },
        [Crepe.Feature.BlockEdit]: {
          buildMenu: builder => {
            const group = builder.addGroup("amby-blocks", "Amby")
            group
              .addItem("amby-callout", {
                label: "Callout",
                icon: "!",
                onRun: () => insert("> [!NOTE]\n> ", true),
              })
              .addItem("amby-tag", {
                label: "Tag",
                icon: "#",
                onRun: () => insert("#tag ", true),
              })
              .addItem("amby-wikilink", {
                label: "Backlink",
                icon: "[[",
                onRun: () => insert("[[Note]]", true),
              })
          },
        },
      },
    })

    crepe.editor.use([textStyleMark, underlineMark, safeHtmlNode, inlineTokenDecorations])
    crepeRef.current = crepe

    crepe.on(listener => {
      listener.markdownUpdated((_ctx, markdown) => {
        if (cancelled || instance !== instanceRef.current || markdown === valueRef.current) return
        valueRef.current = markdown
        onChangeRef.current(markdown)
      })
      listener.selectionUpdated((ctx, selection) => {
        if (cancelled || instance !== instanceRef.current) return
        const { from, to, empty } = selection
        if (empty) {
          selectionRef.current = null
          setMenu(prev => prev.open ? { ...prev, open: false } : prev)
          setPanel(null)
          return
        }
        selectionRef.current = { from, to }
        const view = ctx.get(editorViewCtx)
        const start = view.coordsAtPos(from)
        const end = view.coordsAtPos(to)
        const width = panel === "color" ? 320 : 260
        const left = clamp((start.left + end.right) / 2 - width / 2, 8, window.innerWidth - width - 8)
        const above = Math.min(start.top, end.top) - 58
        const below = Math.max(start.bottom, end.bottom) + 12
        const top = above > 8 ? above : clamp(below, 8, window.innerHeight - 76)
        setMenu({ open: true, left, top })
      })
      listener.blur(() => {
        window.setTimeout(() => {
          if (instance !== instanceRef.current) return
          setMenu(prev => prev.open ? { ...prev, open: false } : prev)
          setPanel(null)
        }, 180)
      })
    })

    crepe.create().catch(err => {
      if (!cancelled) console.error("Failed to create Milkdown editor:", err)
    })

    return () => {
      cancelled = true
      selectionRef.current = null
      setPanel(null)
      setMenu(prev => prev.open ? { ...prev, open: false } : prev)
      if (crepeRef.current === crepe) crepeRef.current = null
      crepe.destroy().finally(() => {
        if (instance === instanceRef.current) root.replaceChildren()
      }).catch(() => {})
    }
  }, [documentId, placeholder])

  function runEditorAction(action: (crepe: Crepe) => void) {
    const crepe = crepeRef.current
    if (!crepe) return
    action(crepe)
  }

  function syncMarkdown(crepe: Crepe) {
    window.setTimeout(() => {
      if (crepeRef.current !== crepe) return
      const markdown = crepe.getMarkdown()
      if (markdown !== valueRef.current) {
        valueRef.current = markdown
        onChangeRef.current(markdown)
      }
    }, 0)
  }

  function runBlockCommand(command: BlockCommand) {
    runEditorAction(crepe => {
      crepe.editor.action(ctx => {
        const commands = ctx.get(commandsCtx)
        if (command === "paragraph") {
          commands.call(setBlockTypeCommand.key, { nodeType: paragraphSchema.type(ctx) })
        } else {
          commands.call(setBlockTypeCommand.key, {
            nodeType: headingSchema.type(ctx),
            attrs: { level: Number(command.slice(1)) },
          })
        }
      })
      syncMarkdown(crepe)
    })
  }

  function runInlineCommand(command: InlineCommand) {
    runEditorAction(crepe => {
      crepe.editor.action(ctx => {
        const commands = ctx.get(commandsCtx)
        if (command === "bold") commands.call(toggleStrongCommand.key)
        if (command === "italic") commands.call(toggleEmphasisCommand.key)
        if (command === "strike") commands.call(toggleStrikethroughCommand.key)
        if (command === "code") commands.call(toggleInlineCodeCommand.key)
        if (command === "underline") toggleMark(ctx, underlineMark.type(ctx))
      })
      syncMarkdown(crepe)
    })
  }

  function toggleMark(ctx: Ctx, markType: MarkType, attrs?: Record<string, unknown>) {
    const view = ctx.get(editorViewCtx)
    const { state } = view
    const { from, to, empty } = state.selection
    if (empty) return
    const hasMark = state.doc.rangeHasMark(from, to, markType)
    const tr = state.tr
    if (hasMark) tr.removeMark(from, to, markType)
    else tr.addMark(from, to, markType.create(attrs))
    view.dispatch(tr.scrollIntoView())
    view.focus()
  }

  function getExistingTextStyle(ctx: Ctx, from: number, to: number) {
    const markType = textStyleMark.type(ctx)
    let attrs: { color?: string | null; backgroundColor?: string | null } = {}
    ctx.get(editorViewCtx).state.doc.nodesBetween(from, to, node => {
      const mark = node.marks.find(m => m.type === markType)
      if (mark) attrs = { ...attrs, ...mark.attrs }
    })
    return attrs
  }

  function applyStyle(key: "color" | "backgroundColor", value: string | null) {
    if (value && !HEX_RE.test(value)) return
    runEditorAction(crepe => {
      crepe.editor.action(ctx => {
        const view = ctx.get(editorViewCtx)
        const range = selectionRef.current ?? (view.state.selection.empty ? null : {
          from: view.state.selection.from,
          to: view.state.selection.to,
        })
        if (!range) return

        const markType = textStyleMark.type(ctx)
        const attrs = getExistingTextStyle(ctx, range.from, range.to)
        attrs[key] = value
        const tr = view.state.tr.removeMark(range.from, range.to, markType)
        const nextAttrs = {
          color: attrs.color && HEX_RE.test(attrs.color) ? attrs.color : null,
          backgroundColor: attrs.backgroundColor && HEX_RE.test(attrs.backgroundColor) ? attrs.backgroundColor : null,
        }
        if (nextAttrs.color || nextAttrs.backgroundColor) {
          tr.addMark(range.from, range.to, markType.create(nextAttrs))
        }
        view.dispatch(tr.scrollIntoView())
        view.focus()
      })
      syncMarkdown(crepe)
    })
  }

  function insertText(text: string) {
    runEditorAction(crepe => {
      crepe.editor.action(ctx => {
        const view = ctx.get(editorViewCtx)
        const { from, to } = view.state.selection
        view.dispatch(view.state.tr.insertText(text, from, to).scrollIntoView())
        view.focus()
      })
      syncMarkdown(crepe)
    })
  }

  function runListCommand(command: ListCommand) {
    runEditorAction(crepe => {
      crepe.editor.action(ctx => {
        const commands = ctx.get(commandsCtx)
        if (command === "bullet") commands.call(wrapInBulletListCommand.key)
        if (command === "ordered") commands.call(wrapInOrderedListCommand.key)
        if (command === "task") {
          const view = ctx.get(editorViewCtx)
          const { from, to } = view.state.selection
          const text = view.state.doc.textBetween(from, to, "\n") || "Task"
          view.dispatch(view.state.tr.insertText(`- [ ] ${text}`, from, to).scrollIntoView())
          view.focus()
        }
      })
      syncMarkdown(crepe)
    })
  }

  function applyLink() {
    const url = window.prompt("URL")
    if (!url) return
    runEditorAction(crepe => {
      crepe.editor.action(ctx => {
        const view = ctx.get(editorViewCtx)
        const { from, to, empty } = view.state.selection
        if (empty) {
          const label = window.prompt("Текст ссылки", url) ?? url
          view.dispatch(view.state.tr.insertText(`[${label}](${url})`, from, to).scrollIntoView())
          view.focus()
          return
        }
        ctx.get(commandsCtx).call(toggleLinkCommand.key, { href: url })
        view.focus()
      })
      syncMarkdown(crepe)
    })
  }

  function applyWikiLink() {
    runEditorAction(crepe => {
      crepe.editor.action(ctx => {
        const view = ctx.get(editorViewCtx)
        const { from, to } = view.state.selection
        const selected = view.state.doc.textBetween(from, to, " ").trim()
        const target = window.prompt("Backlink", selected || "Note")
        if (!target) return
        view.dispatch(view.state.tr.insertText(`[[${target}]]`, from, to).scrollIntoView())
        view.focus()
      })
      syncMarkdown(crepe)
    })
  }

  function applyTag() {
    const tag = window.prompt("Tag", "tag")
    if (!tag) return
    insertText(`#${tag.replace(/^#/, "").trim()} `)
  }

  function applyCallout() {
    runEditorAction(crepe => {
      crepe.editor.action(ctx => {
        const view = ctx.get(editorViewCtx)
        const { from, to, empty } = view.state.selection
        const selected = empty ? "" : view.state.doc.textBetween(from, to, "\n")
        const body = selected
          ? `> [!NOTE]\n${selected.split("\n").map(line => `> ${line}`).join("\n")}`
          : "> [!NOTE]\n> "
        view.dispatch(view.state.tr.insertText(body, from, to).scrollIntoView())
        view.focus()
      })
      syncMarkdown(crepe)
    })
  }

  React.useEffect(() => {
    if (!editorRef) return
    ;(editorRef as React.MutableRefObject<TagEditorHandle>).current = {
      undo: () => runEditorAction(crepe => {
        crepe.editor.action(ctx => {
          const view = ctx.get(editorViewCtx)
          undo(view.state, view.dispatch)
          view.focus()
        })
        syncMarkdown(crepe)
      }),
      redo: () => runEditorAction(crepe => {
        crepe.editor.action(ctx => {
          const view = ctx.get(editorViewCtx)
          redo(view.state, view.dispatch)
          view.focus()
        })
        syncMarkdown(crepe)
      }),
    }
  })

  return (
    <div className="amby-milkdown relative min-h-[360px] pb-24">
      {menu.open && (
        <div
          className="amby-floating-menu fixed z-50 flex items-center gap-1 rounded-md border border-zinc-700 bg-zinc-950/95 p-1 shadow-xl backdrop-blur"
          style={{ left: menu.left, top: menu.top }}
          onMouseDown={e => e.preventDefault()}
        >
          <MenuButton title="Заголовок" active={panel === "heading"} onClick={() => setPanel(panel === "heading" ? null : "heading")}>
            <Heading className="size-3.5" />
          </MenuButton>
          <MenuButton title="Bold" onClick={() => runInlineCommand("bold")}><Bold className="size-3.5" /></MenuButton>
          <MenuButton title="Italic" onClick={() => runInlineCommand("italic")}><Italic className="size-3.5" /></MenuButton>
          <MenuButton title="Underline" onClick={() => runInlineCommand("underline")}><Underline className="size-3.5" /></MenuButton>
          <MenuButton title="Strike" onClick={() => runInlineCommand("strike")}><Strikethrough className="size-3.5" /></MenuButton>
          <MenuButton title="Code" onClick={() => runInlineCommand("code")}><Code2 className="size-3.5" /></MenuButton>
          <div className="mx-1 h-5 w-px bg-zinc-800" />
          <MenuButton title="Цвет" active={panel === "color"} onClick={() => setPanel(panel === "color" ? null : "color")}>
            <Palette className="size-3.5" />
          </MenuButton>
          <MenuButton title="Тег" onClick={applyTag}><Hash className="size-3.5" /></MenuButton>
          <MenuButton title="URL link" onClick={applyLink}><Link className="size-3.5" /></MenuButton>
          <MenuButton title="Backlink" onClick={applyWikiLink}><span className="text-[10px] font-semibold">[[</span></MenuButton>
          <MenuButton title="Emoji" active={panel === "emoji"} onClick={() => setPanel(panel === "emoji" ? null : "emoji")}>
            <Smile className="size-3.5" />
          </MenuButton>
          <div className="mx-1 h-5 w-px bg-zinc-800" />
          <MenuButton title="List" active={panel === "list"} onClick={() => setPanel(panel === "list" ? null : "list")}>
            <List className="size-3.5" />
          </MenuButton>
          <MenuButton title="Quote" onClick={() => runEditorAction(crepe => {
            crepe.editor.action(ctx => ctx.get(commandsCtx).call(wrapInBlockquoteCommand.key))
            syncMarkdown(crepe)
          })}>
            <Quote className="size-3.5" />
          </MenuButton>
          <MenuButton title="Callout" onClick={applyCallout}><MessageSquare className="size-3.5" /></MenuButton>

          {panel && (
            <div className="absolute left-0 top-[calc(100%+6px)] rounded-md border border-zinc-800 bg-zinc-950/98 p-1 shadow-xl">
              {panel === "heading" && (
                <div className="grid grid-cols-3 gap-1">
                  {[
                    { command: "paragraph" as const, label: "P", Icon: Pilcrow },
                    { command: "h1" as const, label: "H1" },
                    { command: "h2" as const, label: "H2" },
                    { command: "h3" as const, label: "H3" },
                    { command: "h4" as const, label: "H4" },
                    { command: "h5" as const, label: "H5" },
                  ].map(({ command, label, Icon }) => (
                    <button
                      key={command}
                      type="button"
                      className="flex h-8 min-w-10 items-center justify-center rounded px-2 text-xs font-semibold text-zinc-300 hover:bg-zinc-800 hover:text-white"
                      onMouseDown={e => e.preventDefault()}
                      onClick={() => { runBlockCommand(command); setPanel(null) }}
                    >
                      {Icon ? <Icon className="size-3.5" /> : label}
                    </button>
                  ))}
                </div>
              )}
              {panel === "color" && (
                <TextStylePalette
                  onTextColor={color => applyStyle("color", color)}
                  onBackgroundColor={color => applyStyle("backgroundColor", color)}
                  onClearTextColor={() => applyStyle("color", null)}
                  onClearBackgroundColor={() => applyStyle("backgroundColor", null)}
                />
              )}
              {panel === "list" && (
                <div className="flex items-center gap-1">
                  <MenuButton title="Bullet list" onClick={() => { runListCommand("bullet"); setPanel(null) }}><List className="size-3.5" /></MenuButton>
                  <MenuButton title="Ordered list" onClick={() => { runListCommand("ordered"); setPanel(null) }}><ListOrdered className="size-3.5" /></MenuButton>
                  <MenuButton title="Task list" onClick={() => { runListCommand("task"); setPanel(null) }}><CheckSquare className="size-3.5" /></MenuButton>
                </div>
              )}
              {panel === "emoji" && (
                <div className="grid grid-cols-6 gap-1">
                  {EMOJIS.map(emoji => (
                    <button
                      key={emoji}
                      type="button"
                      className="flex size-8 items-center justify-center rounded text-base hover:bg-zinc-800"
                      onMouseDown={e => e.preventDefault()}
                      onClick={() => { insertText(emoji); setPanel(null) }}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
      <div ref={rootRef} />
    </div>
  )
}
