import * as React from "react"
import { cn } from "@/lib/utils"
import { assetUrlForAbsolutePath } from "../../tiptap/asset-resolver"
import type { CoverResolver } from "../../database/layouts/cover-resolver"

interface PortraitDotProps {
  /** The page's first image, as the dossier picks it; `null` for none (the initials show). */
  relativePath: string | null
  resolver: CoverResolver
  initials: string
  /** Replaces the size of the face (a list row's by default). */
  className?: string
}

/**
 * The small round face of a page in a list: its first picture, or the initials of its name. The
 * picture is looked up only once the row is near the viewport (and only rows of unfolded parts
 * are on screen at all), through the batched resolver, so a long list reads nothing up front.
 * The name is already in the row, so the picture has an empty alt.
 */
export function PortraitDot({ relativePath, resolver, initials, className }: PortraitDotProps) {
  const ref = React.useRef<HTMLSpanElement>(null)
  const [visible, setVisible] = React.useState(() => typeof IntersectionObserver === "undefined")
  const [url, setUrl] = React.useState<string | null>(null)

  React.useEffect(() => {
    const element = ref.current
    if (visible || !element || !relativePath) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true)
          observer.disconnect()
        }
      },
      { rootMargin: "100px" },
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [visible, relativePath])

  React.useEffect(() => {
    if (!visible || !relativePath) {
      setUrl(null)
      return
    }
    let cancelled = false
    resolver.request(relativePath).then(
      (absolutePath) => {
        if (!cancelled) setUrl(absolutePath ? assetUrlForAbsolutePath(absolutePath) : null)
      },
      () => !cancelled && setUrl(null),
    )
    return () => {
      cancelled = true
    }
  }, [visible, relativePath, resolver])

  return (
    <span
      ref={ref}
      aria-hidden="true"
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted font-medium uppercase text-muted-foreground",
        className ?? "size-5 text-[9px]",
      )}
    >
      {url ? (
        <img
          src={url}
          alt=""
          loading="lazy"
          decoding="async"
          className="size-full object-cover"
          onError={() => setUrl(null)}
        />
      ) : (
        initials
      )}
    </span>
  )
}
