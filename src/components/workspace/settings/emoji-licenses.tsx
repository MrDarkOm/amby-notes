import * as React from "react"
import { useTranslation } from "react-i18next"
import { ChevronRight } from "lucide-react"
import licenses from "@/lib/emoji/licenses.json"
import searchLicenses from "@/locales/emoji-search/licenses.json"
import { NOTO_RELEASE } from "@/lib/emoji/emoji-resolver"

/** The bundled license texts of the emoji font and search data, folded under one title; each file
 * opens on its own. They are part of the app, including an offline installation. */
export function EmojiLicenses() {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)
  const id = React.useId()
  return (
    <div data-testid="emoji-licenses" className="px-4 py-3 text-[12px]">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        className="sync-footer-toggle text-[12px]"
        onClick={() => setOpen((value) => !value)}
      >
        <span>
          {t("settings.updates.openLicenses")} · {NOTO_RELEASE}
        </span>
        <ChevronRight className="size-3.5" aria-hidden="true" />
      </button>
      {open && (
        <div id={id} className="mt-2 space-y-1 pl-1">
          {[...licenses, ...searchLicenses].map(({ file, text }) => (
            <details key={file} className="py-1">
              <summary className="cursor-pointer text-foreground hover:text-foreground/80">
                {file}
              </summary>
              <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border p-3 text-[11px] text-muted-foreground">
                {text}
              </pre>
            </details>
          ))}
        </div>
      )}
    </div>
  )
}
