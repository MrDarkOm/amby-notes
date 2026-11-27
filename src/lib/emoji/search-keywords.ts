import type { EmojiMartData } from "@emoji-mart/data"
import { emojiSearchLocales, type EmojiSearchLocale } from "@/locales/emoji-search"

// Qualification aliases share vocabulary; VS15, skin tones and ZWJ remain distinct.
const sequenceKey = (value: string) =>
  Array.from(value)
    .filter((point) => point !== "\uFE0F")
    .map((point) => point.codePointAt(0)!.toString(16))
    .join("-")

/** Build once before passing data to Mart, which mutates its own search index. */
export function withEmojiSearchKeywords(
  data: EmojiMartData,
  language: string,
  locales: readonly EmojiSearchLocale[] = emojiSearchLocales,
): EmojiMartData {
  const parts = language.toLowerCase().replace(/_/gu, "-").split("-")
  const languages = new Set(["en", ...parts.map((_, index) => parts.slice(0, index + 1).join("-"))])
  const selected = locales.filter((locale) => languages.has(locale.locale.toLowerCase()))
  if (!selected.length) return data
  const vocabulary = new Map<string, Set<string>>()
  for (const locale of selected) {
    for (const [sequence, terms] of Object.entries(locale.keywords)) {
      const key = sequenceKey(sequence)
      const words = vocabulary.get(key) ?? new Set<string>()
      for (const term of terms) {
        // Mart searches comma-delimited token prefixes, splitting queries by spaces.
        // Index words separately so multiword queries also work.
        for (const form of [term.normalize("NFC"), term.normalize("NFD")]) {
          const normalized = form.trim().toLowerCase()
          const tokens = [
            ...normalized.replace(/(\w)-/u, "$1 ").split(/[\s|,]+/u),
            ...normalized.split(/[\s|,_-]+/u),
          ]
          for (const word of tokens) {
            if (word) words.add(word)
          }
        }
      }
      vocabulary.set(key, words)
    }
  }
  return {
    ...data,
    emojis: Object.fromEntries(
      Object.entries(data.emojis).map(([id, emoji]) => {
        const extra = emoji.skins.flatMap((skin) => {
          const sequence = String.fromCodePoint(
            ...skin.unified.split("-").map((point) => parseInt(point, 16)),
          )
          return [...(vocabulary.get(sequenceKey(sequence)) ?? [])]
        })
        if (!extra.length) return [id, emoji]
        // Never reuse a search string compiled before the new vocabulary was added.
        const { search: _search, ...original } = emoji as typeof emoji & { search?: string }
        return [id, { ...original, keywords: [...new Set([...emoji.keywords, ...extra])] }]
      }),
    ),
  }
}
