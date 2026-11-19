import martData, { type EmojiMartData } from "@emoji-mart/data"
import additions from "./picker-additions.json"
import { pickerEmojiUrl } from "./emoji-resolver"

const data = martData as unknown as EmojiMartData

/** Retain every existing ID/search alias/recent choice; supplement the older Mart catalog. */
export const notoPickerData: EmojiMartData = {
  ...data,
  categories: data.categories.map((category) => ({
    ...category,
    emojis: [
      ...category.emojis,
      ...additions.filter((entry) => entry.category === category.id).map((entry) => entry.id),
    ],
  })),
  // Mart 5's Picker hardcodes spritesheet=true and does not forward getImageURL.
  // Its supported per-skin src takes precedence over spritesheets, including in search.
  emojis: Object.fromEntries(
    Object.entries({
      ...data.emojis,
      ...Object.fromEntries(additions.map((entry) => [entry.id, entry])),
    }).map(([id, emoji]) => [
      id,
      {
        ...emoji,
        skins: emoji.skins.map((skin) => ({
          ...skin,
          src: pickerEmojiUrl("google", skin.unified),
        })),
      },
    ]),
  ),
}

/** Mart owns its image DOM. Capture non-bubbling load errors inside its shadow root. */
export function installPickerImageFallback(root: ShadowRoot): () => void {
  const handleError = (event: Event) => {
    const image = event.target
    if (!(image instanceof HTMLImageElement) || !image.closest(".emoji-mart-emoji")) return
    const fallback = document.createElement("span")
    fallback.className = "amby-picker-emoji-fallback"
    fallback.textContent = image.alt
    image.replaceWith(fallback)
  }
  root.addEventListener("error", handleError, true)
  return () => root.removeEventListener("error", handleError, true)
}
