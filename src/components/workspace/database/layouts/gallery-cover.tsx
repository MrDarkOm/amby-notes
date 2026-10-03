import * as React from "react"
import { motion } from "motion/react"
import { motionTransition, motionTransitions } from "@/lib/motion-config"
import { ImageIcon } from "lucide-react"
import { useTranslation } from "react-i18next"
import { assetUrlForAbsolutePath } from "../../tiptap/asset-resolver"
import type { CardSize } from "../view-config"
import type { CoverResolver } from "./cover-resolver"

const COVER_HEIGHT: Record<CardSize, string> = { small: "h-16", medium: "h-24", large: "h-40" }
import type { GalleryPreview } from "./gallery-preview"

type CoverState =
  { status: "idle" | "loading" | "missing" | "error" } | { status: "ready"; url: string }

interface GalleryCoverProps {
  preview: GalleryPreview
  resolver: CoverResolver
  size?: CardSize
}

/**
 * Card cover. Resolves and loads the image only once the card is near the
 * viewport; a missing, unsupported or broken image leaves a readable placeholder.
 */
export function GalleryCover({ preview, resolver, size = "medium" }: GalleryCoverProps) {
  const { t } = useTranslation()
  const ref = React.useRef<HTMLSpanElement>(null)
  const [visible, setVisible] = React.useState(() => typeof IntersectionObserver === "undefined")
  const [state, setState] = React.useState<CoverState>({ status: "idle" })
  const relativePath = preview.kind === "asset" ? preview.relativePath : null

  React.useEffect(() => {
    const element = ref.current
    if (visible || !element) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true)
          observer.disconnect()
        }
      },
      { rootMargin: "200px" },
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [visible])

  React.useEffect(() => {
    if (!visible || !relativePath) return
    let cancelled = false
    setState({ status: "loading" })
    resolver.request(relativePath).then(
      (absolutePath) => {
        if (cancelled) return
        const url = absolutePath ? assetUrlForAbsolutePath(absolutePath) : null
        setState(url ? { status: "ready", url } : { status: "missing" })
      },
      () => !cancelled && setState({ status: "error" }),
    )
    return () => {
      cancelled = true
    }
  }, [visible, relativePath, resolver])

  return (
    <span
      ref={ref}
      data-gallery-cover=""
      className={`mb-2.5 flex w-full ${COVER_HEIGHT[size]} items-center justify-center overflow-hidden rounded-xl bg-muted/60 text-muted-foreground`}
      title={state.status === "error" ? t("databaseValue.coverUnavailable") : undefined}
    >
      {state.status === "ready" ? (
        <motion.img
          src={state.url}
          alt=""
          loading="lazy"
          decoding="async"
          // The picture fades in once it has loaded instead of popping in.
          initial={{ opacity: 0, scale: 1.04 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={motionTransition(motionTransitions.slow)}
          className="size-full object-cover"
          onError={() => setState({ status: "error" })}
        />
      ) : (
        <ImageIcon className="size-5 opacity-50" aria-hidden="true" />
      )}
    </span>
  )
}
