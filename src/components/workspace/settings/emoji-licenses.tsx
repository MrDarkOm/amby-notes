import { useTranslation } from "react-i18next"
import licenses from "@/lib/emoji/licenses.json"
import searchLicenses from "@/locales/emoji-search/licenses.json"
import { NOTO_RELEASE } from "@/lib/emoji/emoji-resolver"

/** License texts are bundled, including in an offline installation. */
export function EmojiLicenses() {
  const { t } = useTranslation()
  return (
    <details className="w-64 max-w-[40vw] text-sm">
      <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
        {t("settings.updates.openLicenses")}
      </summary>
      <div className="mt-3 max-h-80 overflow-auto rounded-md border border-border p-3">
        <p className="mb-3 font-medium">
          {t("settings.updates.openLicenses")} · {NOTO_RELEASE}
        </p>
        {[...licenses, ...searchLicenses].map(({ file, text }) => (
          <details key={file} className="my-2">
            <summary className="cursor-pointer">{file}</summary>
            <pre className="mt-2 whitespace-pre-wrap break-words text-xs text-muted-foreground">
              {text}
            </pre>
          </details>
        ))}
      </div>
    </details>
  )
}
