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
      isCollapsed: tok.attrGet("isCollapsed") === "true",
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
    getAttrs: (tok) => ({
      start: tok.attrGet("start") ? Number(tok.attrGet("start")) : 1,
      markdownPadded: tok.meta?.padded ? true : null,
    }),
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
    getAttrs: (tok) => {
      const rawAlt = tok.children?.[0]?.content || ""
      const pipeMatch = /^(.*?)(?:\|(\d+)(?:x(\d+))?)?$/s.exec(rawAlt)
      if (pipeMatch && (pipeMatch[2] !== undefined || rawAlt.startsWith("|"))) {
        const alt = pipeMatch[1] ?? ""
        const width = pipeMatch[2] ? Number(pipeMatch[2]) : null
        const height = pipeMatch[3] ? Number(pipeMatch[3]) : null
        return {
          src: tok.attrGet("src"),
          title: tok.attrGet("title") || null,
          alt: alt || null,
          width,
          height,
          hasPipe: true,
        }
      }
      const pureSizeMatch = /^(\d+)(?:x(\d+))?$/.exec(rawAlt)
      if (pureSizeMatch) {
        return {
          src: tok.attrGet("src"),
          title: tok.attrGet("title") || null,
          alt: null,
          width: Number(pureSizeMatch[1]),
          height: pureSizeMatch[2] ? Number(pureSizeMatch[2]) : null,
          hasPipe: false,
        }
      }
      return {
        src: tok.attrGet("src"),
        title: tok.attrGet("title") || null,
        alt: rawAlt || null,
        width: null,
        height: null,
        hasPipe: false,
      }
    },
  },
  hardbreak: { node: "hardBreak" },
  footnote_ref: {
    node: "footnoteReference",
    noCloseToken: true,
    getAttrs: (tok) => ({ label: (tok.meta?.label as string) ?? "" }),
  },
  footnote_inline: {
    node: "footnoteInline",
    noCloseToken: true,
    getAttrs: (tok) => ({ value: (tok.meta?.value as string) ?? "" }),
  },
  footnote_def: {
    block: "footnoteDefinition",
    getAttrs: (tok) => ({ label: (tok.meta?.label as string) ?? "" }),
  },
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
    getAttrs: (tok) => ({
      href: tok.attrGet("href"),
      title: tok.attrGet("title") || null,
      markdownTitleMarkup: (tok.meta?.titleMarkup as string | undefined) ?? null,
    }),
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

// A top-level block carries the source text the tokenizer recorded for it.
function withBlockSource(spec: ParseSpec): ParseSpec {
  if (!spec.block && !spec.node) return spec
  return {
    ...spec,
    getAttrs: (tok, tokens, index) => {
      let attrs = spec.getAttrs?.(tok, tokens, index) ?? null
      if (typeof tok.meta?.itemSource === "string") {
        attrs = {
          ...attrs,
          markdownItemSource: tok.meta.itemSource as string,
          markdownItemGap: (tok.meta.itemGap as string | null) ?? null,
          markdownItemPrev: (tok.meta.itemPrev as string | null) ?? null,
        }
      }
      if (typeof tok.meta?.blockSource !== "string") return attrs
      return {
        ...attrs,
        markdownBlockSource: tok.meta.blockSource as string,
        markdownBlockGap: (tok.meta.blockGap as string | null) ?? null,
        markdownBlockPrev: (tok.meta.blockPrev as string | null) ?? null,
      }
    },
  }
}

const sourcedParserTokens = Object.fromEntries(
  Object.entries(parserTokens).map(([name, spec]) => [name, withBlockSource(spec)]),
)

// Built lazily on first use so that *loading* this module never touches
// `editorSchema`. markdown.ts ⇄ schema.ts ⇄ transclusion-node.tsx form an
// import cycle; an eager `new MarkdownParser(editorSchema, …)` at module scope
// would hit `editorSchema` while it's still in its temporal dead zone whenever
// transclusion-node is the entry into the cycle (white screen in dev ESM).
let _parser: MarkdownParser | null = null
export function getMarkdownParser(): MarkdownParser {
  if (!_parser) _parser = new MarkdownParser(editorSchema, tokenizer, sourcedParserTokens)
  return _parser
}
