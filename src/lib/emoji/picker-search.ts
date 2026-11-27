import type { EmojiMartData } from "@emoji-mart/data"
import { Data, SearchIndex } from "emoji-mart"
import { emojiSearchLocales, type EmojiSearchLocale } from "@/locales/emoji-search"
import { withEmojiSearchKeywords } from "./search-keywords"

interface Catalog {
  english: EmojiMartData
  language?: string
}
const catalogs = new WeakMap<EmojiMartData, Catalog>()

/**
 * Mart keeps one process-global Data/index and ignores later data props. Restore
 * the English baseline before adding the current app language, then let Mart's
 * next Picker/init compile changed entries. Never accumulate previous languages.
 */
export function configurePickerSearch(
  data: EmojiMartData,
  language: string,
  locales: readonly EmojiSearchLocale[] = emojiSearchLocales,
): void {
  const target = (Data as EmojiMartData | undefined) ?? data
  let catalog = catalogs.get(target)
  if (!catalog) {
    catalog = {
      english: {
        ...data,
        emojis: Object.fromEntries(
          Object.entries(data.emojis).map(([id, emoji]) => [
            id,
            { ...emoji, keywords: [...emoji.keywords] },
          ]),
        ),
      },
    }
    catalogs.set(target, catalog)
  }
  if (catalog.language === language) return
  const localized = withEmojiSearchKeywords(catalog.english, language, locales)
  for (const [id, emoji] of Object.entries(target.emojis)) {
    const words = localized.emojis[id]?.keywords
    if (
      !words ||
      (words.length === emoji.keywords.length &&
        words.every((word, index) => word === emoji.keywords[index]))
    )
      continue
    emoji.keywords = [...words]
    delete (emoji as typeof emoji & { search?: string }).search
  }
  SearchIndex.reset()
  catalog.language = language
}
