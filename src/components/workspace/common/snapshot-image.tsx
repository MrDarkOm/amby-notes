import * as React from "react"
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react"
import { useTranslation } from "react-i18next"
import { toAssetUrl } from "@/lib/storage"

import { snapshotImagePaths, type SnapshotAssets } from "./snapshot-assets"

export function SnapshotImage({ node, extension }: NodeViewProps) {
  const { t } = useTranslation()
  const src = String(node.attrs.src ?? "")
  const context = extension.options.snapshotAssets as SnapshotAssets | undefined
  const [urls, setUrls] = React.useState<string[]>([])
  const [index, setIndex] = React.useState(0)
  React.useEffect(() => {
    let cancelled = false
    setUrls([])
    setIndex(0)
    void Promise.all(
      snapshotImagePaths(src, context).map((path) =>
        /^(?:https?:|data:)/iu.test(path) ? path : toAssetUrl(path),
      ),
    ).then(
      (resolved) => {
        if (!cancelled) setUrls(resolved)
      },
      () => {},
    )
    return () => {
      cancelled = true
    }
  }, [src, context])
  return (
    <NodeViewWrapper as="span" className="amby-snapshot-image" contentEditable={false}>
      {urls[index] ? (
        <img
          src={urls[index]}
          alt={node.attrs.alt ?? ""}
          title={node.attrs.title ?? undefined}
          width={node.attrs.width ?? undefined}
          loading="lazy"
          draggable={false}
          onError={() => setIndex((current) => current + 1)}
        />
      ) : (
        <span className="text-xs text-muted-foreground">
          {t("snapshotPreview.image", { name: node.attrs.alt || src })}
        </span>
      )}
    </NodeViewWrapper>
  )
}
