import * as React from "react"
import { useTheme } from "next-themes"
import { useTranslation } from "react-i18next"
import { warmEmojiPicker } from "@/lib/emoji/picker-runtime"
import { emojiPickerI18n } from "@/lib/emoji/picker-i18n"

/** Runs only after hydrated preferences and startup gates have mounted the workspace. */
export function EmojiPickerWarmup() {
  const { resolvedTheme } = useTheme()
  const { t, i18n } = useTranslation()
  const labels = React.useMemo(() => emojiPickerI18n(t), [t])
  const language = i18n.resolvedLanguage ?? i18n.language
  React.useEffect(() => {
    if (!resolvedTheme) return
    const warm = () =>
      warmEmojiPicker({
        language,
        i18n: labels,
        theme: resolvedTheme === "dark" ? "dark" : "light",
      })
    if (typeof window.requestIdleCallback === "function") {
      const task = window.requestIdleCallback(warm, { timeout: 1500 })
      return () => window.cancelIdleCallback(task)
    }
    const task = window.setTimeout(warm, 300)
    return () => window.clearTimeout(task)
  }, [language, labels, resolvedTheme])
  return null
}
