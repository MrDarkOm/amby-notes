import { useTranslation } from "react-i18next"
import { releasePageUrl } from "@/lib/app-release-page"
import { cn } from "@/lib/utils"
import { openWebAddressInBrowser } from "./tiptap/external-open"

/**
 * "Download the version manually": the GitHub release of a version the updater could not install,
 * opened in the person's browser.
 */
export function ManualDownloadLink({
  version,
  className,
}: {
  version: string
  className?: string
}) {
  const { t } = useTranslation()
  const url = releasePageUrl(version)
  return (
    <a
      href={url}
      className={cn("underline underline-offset-2 hover:text-foreground", className)}
      onClick={(event) => {
        event.preventDefault()
        void openWebAddressInBrowser(url)
      }}
    >
      {t("common.downloadManually")}
    </a>
  )
}
