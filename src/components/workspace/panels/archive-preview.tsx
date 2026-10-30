import * as React from "react"
import { ArrowLeft, FileText, Folder, Loader2, RotateCcw } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { MotionSpinner } from "@/lib/motion"
import { readTrashPreview, type TrashEntry, type TrashPreview } from "@/lib/storage"
import { SnapshotModeToggle, SnapshotPreview, type SnapshotMode } from "../common/snapshot-preview"
import { useVaultStore } from "../use-vault-store"
import { archiveEntryLabel } from "./archive-model"

export function ArchivePreview({
  entry,
  busy,
  actionError,
  onClose,
  onRestore,
}: {
  entry: TrashEntry
  busy: boolean
  actionError: string | null
  onClose: () => void
  onRestore: () => void
}) {
  const { t } = useTranslation()
  const [mode, setMode] = React.useState<SnapshotMode>("read")
  const [path, setPath] = React.useState("")
  const [retry, setRetry] = React.useState(0)
  const [state, setState] = React.useState<{
    path: string
    preview: TrashPreview | null
    error: boolean
  }>({ path: "", preview: null, error: false })
  React.useEffect(() => {
    let cancelled = false
    setState({ path, preview: null, error: false })
    void readTrashPreview(entry.id, path).then(
      (preview) => {
        if (!cancelled) setState({ path, preview, error: false })
      },
      () => {
        if (!cancelled) setState({ path, preview: null, error: true })
      },
    )
    return () => {
      cancelled = true
    }
  }, [entry.id, path, retry])
  const vault = useVaultStore((state) => state.vault)
  const assets = React.useMemo(
    () =>
      vault
        ? {
            vaultPath: vault,
            notePath: `${vault}/.amby/trash/${entry.id}/${entry.name}${path ? `/${path}` : ""}`,
          }
        : undefined,
    [vault, entry.id, entry.name, path],
  )
  const preview = state.path === path ? state.preview : null
  const failed = state.path === path && state.error
  const up = () => setPath(path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "")
  const title = archiveEntryLabel(entry).title
  const markdown = /\.md$/iu.test(path || entry.name)
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="flex max-h-[85vh] min-h-0 flex-col sm:max-w-3xl">
        <div className="min-w-0 pr-8">
          <DialogTitle className="break-words">{title}</DialogTitle>
          <DialogDescription className="mt-2 break-words">{entry.originalPath}</DialogDescription>
          <p className="mt-1 text-xs text-muted-foreground">{t("archivePanel.previewReadOnly")}</p>
        </div>
        {path && (
          <div className="flex min-w-0 items-center gap-2">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={up}
              aria-label={t("archivePanel.previewBack")}
            >
              <ArrowLeft className="size-4" />
            </Button>
            <span className="min-w-0 truncate text-xs text-muted-foreground" title={path}>
              {path}
            </span>
          </div>
        )}
        {preview?.text !== null && preview && markdown && (
          <SnapshotModeToggle value={mode} onChange={setMode} />
        )}
        <div className="min-h-0 flex-1 overflow-auto">
          {failed ? (
            <div role="alert" className="py-8 text-center text-sm">
              <p>{t("archivePanel.previewFailed")}</p>
              <Button variant="ghost" size="sm" onClick={() => setRetry((value) => value + 1)}>
                {t("historyPanel.refresh")}
              </Button>
            </div>
          ) : !preview ? (
            <div
              className="flex justify-center py-10"
              role="status"
              aria-label={t("archivePanel.previewLoading")}
            >
              <MotionSpinner>
                <Loader2 className="size-5" />
              </MotionSpinner>
            </div>
          ) : preview.directory ? (
            preview.children.length ? (
              <div className="space-y-1">
                {preview.children.map((child) => (
                  <button
                    type="button"
                    key={child.path}
                    onClick={() => setPath(child.path)}
                    className="flex w-full min-w-0 items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-accent/40"
                  >
                    {child.directory ? (
                      <Folder className="size-4 shrink-0 text-muted-foreground" />
                    ) : (
                      <FileText className="size-4 shrink-0 text-muted-foreground" />
                    )}
                    <span className="min-w-0 break-words">{child.name}</span>
                  </button>
                ))}
              </div>
            ) : (
              <p className="py-8 text-center text-sm text-muted-foreground">
                {t("archivePanel.previewFolderEmpty")}
              </p>
            )
          ) : preview.text !== null ? (
            preview.text ? (
              <SnapshotPreview
                content={preview.text}
                mode={mode}
                markdown={markdown}
                assets={assets}
              />
            ) : (
              <p className="p-4 text-sm text-muted-foreground">
                {t("archivePanel.previewFileEmpty")}
              </p>
            )
          ) : (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {t("archivePanel.previewUnsupported")}
            </p>
          )}
        </div>
        {preview?.truncated && (
          <p className="text-xs text-muted-foreground">{t("archivePanel.previewTruncated")}</p>
        )}
        {actionError && (
          <p role="alert" className="text-xs text-destructive">
            {actionError}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t("common.close")}
          </Button>
          <Button size="sm" disabled={busy} onClick={onRestore}>
            <RotateCcw className="size-4" />
            {t("historyPanel.restore")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
