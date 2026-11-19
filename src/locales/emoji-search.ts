import ru from "./emoji-search/ru.json"

/** Search-only vocabulary; UI labels remain in resources.ts. Unicode keys are never persisted. */
export interface EmojiSearchLocale {
  locale: string
  /** Record provenance and review the full license before bundling a language pack. */
  source: string
  revision: string
  license: string
  keywords: Readonly<Record<string, readonly string[]>>
}

/**
 * Register bundled language files here, e.g. import ru from "./emoji-search/ru.json".
 * English names/keywords are already supplied by Emoji Mart. Only the current app language
 * and English are searched; regional languages inherit their base vocabulary. No language packs are downloaded at runtime.
 */
export const emojiSearchLocales: readonly EmojiSearchLocale[] = [ru]
