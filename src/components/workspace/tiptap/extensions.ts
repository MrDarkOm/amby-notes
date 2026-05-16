import type { Extensions } from "@tiptap/core"
import { Placeholder } from "@tiptap/extension-placeholder"

import { schemaExtensions } from "./schema"
import { TagsWikilinks, type TagsWikilinksCallbacks } from "./tags-wikilinks"
import { SlashMenu } from "./slash-menu"
import { IndentShortcut } from "./indent-shortcut"
import { WrapShortcuts } from "./wrap-shortcuts"

export interface BuildExtensionsOptions {
  placeholder: string
  callbacks: { current: TagsWikilinksCallbacks }
}

// Full extension list for an editor instance (Live or Read).
// CalloutNode is already part of schemaExtensions (see schema.ts) so it does
// not need to be listed separately here.
export function buildExtensions({ placeholder, callbacks }: BuildExtensionsOptions): Extensions {
  return [
    ...schemaExtensions,
    Placeholder.configure({ placeholder, showOnlyWhenEditable: true }),
    TagsWikilinks.configure({ callbacks }),
    SlashMenu,
    IndentShortcut,
    WrapShortcuts,
  ]
}
