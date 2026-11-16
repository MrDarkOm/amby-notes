import i18n, { SUPPORTED_LANGUAGES } from "@/lib/i18n"

/** The sections of the block menu that can be found by a word other than their label. */
export type BlockMenuAliasGroup =
  | "split"
  | "background"
  | "textColor"
  | "emoji"
  | "fold"
  | "heading"
  | "align"
  | "imageDetails"
  | "list"

/**
 * Words that find a section of the block menu, in every language, whatever the interface
 * language is: a person who types «heading» in a Russian interface still finds the heading
 * levels. Each language lists its own words in `blockMenu.aliases.<group>`, separated by `|`.
 */
export function blockMenuAliases(group: BlockMenuAliasGroup): string[] {
  return SUPPORTED_LANGUAGES.flatMap(({ code }) =>
    i18n
      .t(`blockMenu.aliases.${group}`, { lng: code })
      .split("|")
      .map((word) => word.trim())
      .filter((word) => word !== ""),
  )
}

/** True when the query (already applied inside `matches`) fits any alias of the group. */
export function matchesAlias(matches: (text: string) => boolean, group: BlockMenuAliasGroup) {
  return blockMenuAliases(group).some(matches)
}
