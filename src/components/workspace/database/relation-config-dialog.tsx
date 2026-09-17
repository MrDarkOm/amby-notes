"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import { ArrowLeftRight, Database } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import type { DatabaseSummary } from "@/lib/storage"

export interface RelationConfigState {
  targetDatabaseId: string
  maxItems: number | null
  twoWay: boolean
  inversePropertyName: string
}

interface RelationConfigDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  currentDatabaseId: string
  currentDatabaseTitle: string
  propertyName: string
  databases: DatabaseSummary[]
  initialTargetDatabaseId?: string
  initialMaxItems?: number | null
  initialTwoWay?: boolean
  initialInversePropertyName?: string
  isSaving?: boolean
  onSave: (config: RelationConfigState) => Promise<void> | void
}

export function RelationConfigDialog({
  open,
  onOpenChange,
  currentDatabaseId,
  currentDatabaseTitle,
  propertyName,
  databases,
  initialTargetDatabaseId,
  initialMaxItems = null,
  initialTwoWay = false,
  initialInversePropertyName = "",
  isSaving = false,
  onSave,
}: RelationConfigDialogProps) {
  const { t } = useTranslation()

  const defaultTargetId =
    initialTargetDatabaseId ||
    databases.find((d) => d.databaseId !== currentDatabaseId)?.databaseId ||
    currentDatabaseId

  const [targetDatabaseId, setTargetDatabaseId] = React.useState(defaultTargetId)
  const [maxItems, setMaxItems] = React.useState<number | null>(initialMaxItems)
  const [twoWay, setTwoWay] = React.useState(initialTwoWay)
  const [inversePropertyName, setInversePropertyName] = React.useState(
    initialInversePropertyName || currentDatabaseTitle || propertyName || "Related",
  )
  const [selfDual, setSelfDual] = React.useState(true)

  React.useEffect(() => {
    if (open) {
      const targetId =
        initialTargetDatabaseId ||
        databases.find((d) => d.databaseId !== currentDatabaseId)?.databaseId ||
        currentDatabaseId
      setTargetDatabaseId(targetId)
      setMaxItems(initialMaxItems)
      setTwoWay(Boolean(initialTwoWay))
      setInversePropertyName(
        initialInversePropertyName || currentDatabaseTitle || propertyName || "Related",
      )
      setSelfDual(true)
    }
  }, [
    open,
    initialTargetDatabaseId,
    initialMaxItems,
    initialTwoWay,
    initialInversePropertyName,
    currentDatabaseId,
    currentDatabaseTitle,
    propertyName,
    databases,
  ])

  const isSelfRelation = targetDatabaseId === currentDatabaseId
  const selectedTargetDb = databases.find((d) => d.databaseId === targetDatabaseId)
  const targetTitle = selectedTargetDb?.title || t("databaseWorkspace.relationTarget")

  const handleSave = async () => {
    await onSave({
      targetDatabaseId,
      maxItems,
      twoWay: isSelfRelation ? selfDual : twoWay,
      inversePropertyName: (isSelfRelation ? selfDual : twoWay) ? inversePropertyName.trim() : "",
    })
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowLeftRight className="size-4 text-primary" />
            <span>{t("databaseTable.configureRelation")}</span>
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            {propertyName}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2 text-sm">
          {/* Target database selection */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
              <Database className="size-3.5" />
              <span>{t("databaseWorkspace.relationTarget")}</span>
            </label>
            <select
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={targetDatabaseId}
              onChange={(e) => {
                const nextTargetId = e.target.value
                setTargetDatabaseId(nextTargetId)
                if (!inversePropertyName || inversePropertyName === targetTitle) {
                  setInversePropertyName(currentDatabaseTitle || "Related")
                }
              }}
            >
              {databases.map((db) => (
                <option key={db.databaseId} value={db.databaseId}>
                  {db.title}{" "}
                  {db.databaseId === currentDatabaseId
                    ? `(${t("databaseWorkspace.relationSelfSingle")})`
                    : ""}
                </option>
              ))}
            </select>
          </div>

          {/* Limit: 1 page vs No limit */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              {t("databaseWorkspace.relationLimit")}
            </label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                className={`flex items-center justify-center rounded-md border px-3 py-2 text-xs font-medium ${
                  maxItems === null
                    ? "border-primary bg-primary/10 text-primary font-semibold"
                    : "border-input bg-background text-muted-foreground hover:bg-accent/50"
                }`}
                onClick={() => setMaxItems(null)}
              >
                {t("databaseWorkspace.relationLimitNoLimit")}
              </button>
              <button
                type="button"
                className={`flex items-center justify-center rounded-md border px-3 py-2 text-xs font-medium ${
                  maxItems === 1
                    ? "border-primary bg-primary/10 text-primary font-semibold"
                    : "border-input bg-background text-muted-foreground hover:bg-accent/50"
                }`}
                onClick={() => setMaxItems(1)}
              >
                {t("databaseWorkspace.relationLimitSingle")}
              </button>
            </div>
          </div>

          {/* Two-way / Reciprocal relation configuration */}
          {isSelfRelation ? (
            <div className="space-y-2 rounded-lg border border-border/80 bg-muted/20 p-3">
              <label className="text-xs font-medium text-foreground">
                {t("databaseWorkspace.relationSelfDirection")}
              </label>
              <div className="grid grid-cols-2 gap-2 pt-1">
                <button
                  type="button"
                  className={`rounded-md border p-2 text-left text-xs ${
                    selfDual
                      ? "border-primary bg-primary/10 text-primary font-semibold"
                      : "border-input bg-background text-muted-foreground hover:bg-accent/50"
                  }`}
                  onClick={() => setSelfDual(true)}
                >
                  <div className="font-medium">{t("databaseWorkspace.relationSelfDual")}</div>
                </button>
                <button
                  type="button"
                  className={`rounded-md border p-2 text-left text-xs ${
                    !selfDual
                      ? "border-primary bg-primary/10 text-primary font-semibold"
                      : "border-input bg-background text-muted-foreground hover:bg-accent/50"
                  }`}
                  onClick={() => setSelfDual(false)}
                >
                  <div className="font-medium">{t("databaseWorkspace.relationSelfSingle")}</div>
                </button>
              </div>
              {selfDual && (
                <div className="space-y-1.5 pt-2">
                  <label className="text-xs text-muted-foreground">
                    {t("databaseWorkspace.relationTwoWayTargetName")}
                  </label>
                  <input
                    type="text"
                    className="h-8 w-full rounded-md border border-input bg-background px-2.5 text-xs text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    value={inversePropertyName}
                    onChange={(e) => setInversePropertyName(e.target.value)}
                    placeholder={t("databaseWorkspace.relationSelfDual")}
                  />
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-3 rounded-lg border border-border/80 bg-muted/20 p-3">
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <div className="text-xs font-medium text-foreground">
                    {t("databaseWorkspace.relationTwoWay")}
                  </div>
                  <div className="text-[11px] text-muted-foreground">{targetTitle}</div>
                </div>
                <Switch checked={twoWay} onCheckedChange={setTwoWay} />
              </div>

              {twoWay && (
                <div className="space-y-1.5 pt-1">
                  <label className="text-xs text-muted-foreground">
                    {t("databaseWorkspace.relationTwoWayTargetName")}
                  </label>
                  <input
                    type="text"
                    className="h-8 w-full rounded-md border border-input bg-background px-2.5 text-xs text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    value={inversePropertyName}
                    onChange={(e) => setInversePropertyName(e.target.value)}
                    placeholder={currentDatabaseTitle || t("databaseWorkspace.relationTarget")}
                  />
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button disabled={isSaving || !targetDatabaseId} onClick={handleSave}>
            {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
