import { MarkdownParser, type ParseSpec } from "prosemirror-markdown"
import { createAmbyTokenizer } from "./markdown-block-plugins"
import { editorSchema } from "./schema"

const tokenizer = createAmbyTokenizer()

const parserTokens: { [token: string]: ParseSpec } = {
  callout: {
    block: "callout",
    getAttrs: (tok) => ({
      calloutType: tok.attrGet("calloutType") ?? "NOTE",
      emoji: tok.attrGet("emoji") ?? "💡",
      headerSuffix: tok.attrGet("headerSuffix") ?? "",
      headerPrefix: tok.attrGet("headerPrefix") ?? "",
      headerContentInBody: tok.attrGet("headerContentInBody") === "true",
      headerBodyTight: tok.attrGet("headerBodyTight") === "true",
      hasRawHeader: tok.attrGet("hasRawHeader") === "true",
    }),
  },
  column_set: {
    block: "columnSet",
    getAttrs: (tok) => ({ widths: tok.attrGet("widths") || null }),
  },
  column: { block: "column" },
  blockquote: { block: "blockquote" },
  paragraph: { block: "paragraph" },
  list_item: { block: "listItem" },
  bullet_list: {
    block: "bulletList",
    getAttrs: (tok) => ({ markdownMarkup: tok.markup || null }),
  },
  ordered_list: {
    block: "orderedList",
    getAttrs: (tok) => ({ start: tok.attrGet("start") ? Number(tok.attrGet("start")) : 1 }),
  },
  task_list: { block: "taskList" },
  task_item: {
    block: "taskItem",
    getAttrs: (tok) => ({ checked: Boolean(tok.meta?.checked) }),
  },
  heading: { block: "heading", getAttrs: (tok) => ({ level: Number(tok.tag.slice(1)) }) },
  code_block: { block: "codeBlock", noCloseToken: true },
  fence: {
    block: "codeBlock",
    getAttrs: (tok) => ({ language: tok.info ? tok.info.trim().split(/\s+/)[0] : null }),
    noCloseToken: true,
  },
  hr: { node: "horizontalRule" },
  image: {
    node: "image",
    getAttrs: (tok) => ({
      src: tok.attrGet("src"),
      title: tok.attrGet("title") || null,
      alt: tok.children?.[0]?.content || null,
    }),
  },
  hardbreak: { node: "hardBreak" },
  table: {
    block: "table",
    getAttrs: (tok) => ({
      markdownSeparator: tok.meta?.markdownSeparator ?? null,
      markdownSource: tok.meta?.markdownSource ?? null,
      markdownSignature: tok.meta?.markdownSignature ?? null,
    }),
  },
  tr: { block: "tableRow" },
  th: { block: "tableHeader" },
  td: { block: "tableCell" },
  em: { mark: "italic", getAttrs: (tok) => ({ markdownMarkup: tok.markup || null }) },
  strong: { mark: "bold", getAttrs: (tok) => ({ markdownMarkup: tok.markup || null }) },
  s: { mark: "strike" },
  link: {
    mark: "link",
    getAttrs: (tok) => ({ href: tok.attrGet("href") }),
  },
  code_inline: { mark: "code", noCloseToken: true },
  html_inline: {
    node: "ambyHtml",
    noCloseToken: true,
    getAttrs: (tok) => ({ value: tok.content }),
  },
  html_block: {
    node: "opaqueHtmlBlock",
    noCloseToken: true,
    getAttrs: (tok) => ({ value: tok.content }),
  },
  opaque_markdown: {
    node: "opaqueMarkdownBlock",
    noCloseToken: true,
    getAttrs: (tok) => ({
      kind: (tok.meta?.kind as string) ?? "source",
      value: (tok.meta?.value as string) ?? tok.content,
    }),
  },
  amby_block: {
    node: "ambyBlock",
    getAttrs: (tok) => ({
      blockType: (tok.meta?.blockType as string) ?? "db",
      blockId: (tok.meta?.blockId as string) ?? "",
    }),
  },
  amby_span: {
    mark: "ambyTextStyle",
    getAttrs: (tok) => ({
      color: (tok.meta?.color as string | null) ?? null,
      backgroundColor: (tok.meta?.backgroundColor as string | null) ?? null,
    }),
  },
  amby_u: { mark: "ambyUnderline" },
  transclusion: {
    node: "transclusion",
    getAttrs: (tok) => ({ target: tok.attrGet("target") ?? "", raw: tok.attrGet("raw") ?? "" }),
  },
}

// Built lazily on first use so that *loading* this module never touches
// `editorSchema`. markdown.ts ⇄ schema.ts ⇄ transclusion-node.tsx form an
// import cycle; an eager `new MarkdownParser(editorSchema, …)` at module scope
// would hit `editorSchema` while it's still in its temporal dead zone whenever
// transclusion-node is the entry into the cycle (white screen in dev ESM).
let _parser: MarkdownParser | null = null
export function getMarkdownParser(): MarkdownParser {
  if (!_parser) _parser = new MarkdownParser(editorSchema, tokenizer, parserTokens)
  return _parser
}

export function markdownToDoc(markdown: string): Record<string, unknown> {
  const doc = getMarkdownParser().parse(markdown ?? "")
  return doc.toJSON() as Record<string, unknown>
}

// ── Serializer ────────────────────────────────────────────────────────────────
