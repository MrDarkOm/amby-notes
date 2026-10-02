"use client"

import { RollupWizard } from "./rollup-wizard"
import { isDraftComplete, type RollupDraft } from "./rollup-model"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import type { DatabaseSummary } from "@/lib/storage"

export interface DatabaseViewDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  mode: "create" | "edit" | "rename"
  viewName: string
  onViewNameChange: (name: string) => void
  viewLayout: "table" | "board" | "list" | "gallery" | "chart"
  onViewLayoutChange: (layout: "table" | "board" | "list" | "gallery" | "chart") => void
  mutationBusy: boolean
  mutationError: string | null
  onSave: () => void
}

export function DatabaseViewDialog({
  open,
  onOpenChange,
  mode,
  viewName,
  onViewNameChange,
  viewLayout,
  onViewLayoutChange,
  mutationBusy,
  mutationError,
  onSave,
}: DatabaseViewDialogProps) {
  const { t } = useTranslation()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {mode === "create"
              ? t("databaseWorkspace.viewCreate")
              : mode === "edit"
                ? t("databaseWorkspace.editView")
                : t("databaseWorkspace.renameView")}
          </DialogTitle>
          <DialogDescription>{t("databaseWorkspace.views")}</DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          value={viewName}
          placeholder={t("databaseWorkspace.viewNamePlaceholder")}
          aria-label={t("databaseWorkspace.viewName")}
          onChange={(event) => onViewNameChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void onSave()
          }}
        />
        {(mode === "create" || mode === "edit") && (
          <label className="space-y-1 text-xs text-muted-foreground">
            <span>{t("databaseWorkspace.viewLayout")}</span>
            <select
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={viewLayout}
              onChange={(event) =>
                onViewLayoutChange(
                  event.target.value as "table" | "board" | "list" | "gallery" | "chart",
                )
              }
            >
              {(["table", "board", "list", "gallery", "chart"] as const).map((layout) => (
                <option key={layout} value={layout}>
                  {t(`databaseLayouts.${layout}`)}
                </option>
              ))}
            </select>
          </label>
        )}
        {mutationError && <p className="text-xs text-destructive">{mutationError}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button disabled={!viewName.trim() || mutationBusy} onClick={() => void onSave()}>
            {mode === "create" ? t("common.create") : t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export interface DatabaseRowDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  rowTitle: string
  onRowTitleChange: (title: string) => void
  mutationBusy: boolean
  mutationError: string | null
  onCreate: () => void
}

export function DatabaseRowDialog({
  open,
  onOpenChange,
  rowTitle,
  onRowTitleChange,
  mutationBusy,
  mutationError,
  onCreate,
}: DatabaseRowDialogProps) {
  const { t } = useTranslation()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("databaseWorkspace.newPage")}</DialogTitle>
          <DialogDescription>{t("databaseWorkspace.newPageDescription")}</DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          value={rowTitle}
          placeholder={t("databaseWorkspace.pageTitle")}
          aria-label={t("databaseWorkspace.pageTitle")}
          onChange={(event) => onRowTitleChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void onCreate()
          }}
        />
        {mutationError && <p className="text-xs text-destructive">{mutationError}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button disabled={!rowTitle.trim() || mutationBusy} onClick={() => void onCreate()}>
            {t("common.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export interface DatabasePropertyDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  propertyName: string
  onPropertyNameChange: (name: string) => void
  propertyType: string
  onPropertyTypeChange: (type: string) => void
  formulaExpression: string
  onFormulaExpressionChange: (expression: string) => void
  relationTargetDatabaseId: string
  onRelationTargetDatabaseIdChange: (id: string) => void
  relationMaxItems: number | null
  onRelationMaxItemsChange: (maxItems: number | null) => void
  relationSelfDual: boolean
  onRelationSelfDualChange: (dual: boolean) => void
  relationTwoWay: boolean
  onRelationTwoWayChange: (twoWay: boolean) => void
  relationInversePropertyName: string
  onRelationInversePropertyNameChange: (name: string) => void
  currentDatabaseId: string
  currentDatabaseTitle: string
  databases: DatabaseSummary[]
  rollupDraft: RollupDraft
  onRollupDraftChange: (draft: RollupDraft) => void
  mutationBusy: boolean
  mutationError: string | null
  onCreate: () => void
}

export function DatabasePropertyDialog({
  open,
  onOpenChange,
  propertyName,
  onPropertyNameChange,
  propertyType,
  onPropertyTypeChange,
  formulaExpression,
  onFormulaExpressionChange,
  relationTargetDatabaseId,
  onRelationTargetDatabaseIdChange,
  relationMaxItems,
  onRelationMaxItemsChange,
  relationSelfDual,
  onRelationSelfDualChange,
  relationTwoWay,
  onRelationTwoWayChange,
  relationInversePropertyName,
  onRelationInversePropertyNameChange,
  currentDatabaseId,
  currentDatabaseTitle,
  databases,
  rollupDraft,
  onRollupDraftChange,
  mutationBusy,
  mutationError,
  onCreate,
}: DatabasePropertyDialogProps) {
  const { t } = useTranslation()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("databaseWorkspace.addProperty")}</DialogTitle>
          <DialogDescription>{t("databaseWorkspace.addPropertyDescription")}</DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          value={propertyName}
          placeholder={t("databaseWorkspace.propertyName")}
          aria-label={t("databaseWorkspace.propertyName")}
          onChange={(event) => onPropertyNameChange(event.target.value)}
        />
        <label className="space-y-1 text-xs text-muted-foreground">
          <span>{t("databaseWorkspace.propertyType")}</span>
          <select
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={propertyType}
            onChange={(event) => onPropertyTypeChange(event.target.value)}
          >
            {[
              "text",
              "number",
              "checkbox",
              "date",
              "url",
              "select",
              "multiSelect",
              "status",
              "formula",
              "relation",
              "rollup",
            ].map((type) => (
              <option key={type} value={type}>
                {t(`databaseWorkspace.propertyTypes.${type}`)}
              </option>
            ))}
          </select>
        </label>
        {propertyType === "formula" && (
          <label className="space-y-1 text-xs text-muted-foreground">
            <span>{t("databaseWorkspace.formulaExpression")}</span>
            <Input
              value={formulaExpression}
              placeholder={t("databaseWorkspace.formulaExpressionHint")}
              aria-label={t("databaseWorkspace.formulaExpression")}
              onChange={(event) => onFormulaExpressionChange(event.target.value)}
            />
          </label>
        )}
        {propertyType === "rollup" && (
          <RollupWizard
            draft={rollupDraft}
            onChange={onRollupDraftChange}
            database={databases.find((candidate) => candidate.databaseId === currentDatabaseId)}
            databases={databases}
            currentDatabaseId={currentDatabaseId}
          />
        )}
        {propertyType === "relation" && (
          <div className="space-y-3 pt-1">
            <label className="space-y-1 text-xs text-muted-foreground block">
              <span>{t("databaseWorkspace.relationTarget")}</span>
              <select
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={relationTargetDatabaseId}
                onChange={(event) => {
                  const nextId = event.target.value
                  onRelationTargetDatabaseIdChange(nextId)
                  if (!relationInversePropertyName) {
                    onRelationInversePropertyNameChange(currentDatabaseTitle || "Related")
                  }
                }}
              >
                {databases.map((candidate) => (
                  <option key={candidate.databaseId} value={candidate.databaseId}>
                    {candidate.title}{" "}
                    {candidate.databaseId === currentDatabaseId
                      ? `(${t("databaseWorkspace.relationSelfSingle")})`
                      : ""}
                  </option>
                ))}
              </select>
            </label>

            {/* Limit */}
            <div className="space-y-1.5">
              <span className="text-xs text-muted-foreground block">
                {t("databaseWorkspace.relationLimit")}
              </span>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  className={`flex items-center justify-center rounded-md border px-3 py-1.5 text-xs ${
                    relationMaxItems === null
                      ? "border-primary bg-primary/10 text-primary font-semibold"
                      : "border-input bg-background text-muted-foreground hover:bg-accent/50"
                  }`}
                  onClick={() => onRelationMaxItemsChange(null)}
                >
                  {t("databaseWorkspace.relationLimitNoLimit")}
                </button>
                <button
                  type="button"
                  className={`flex items-center justify-center rounded-md border px-3 py-1.5 text-xs ${
                    relationMaxItems === 1
                      ? "border-primary bg-primary/10 text-primary font-semibold"
                      : "border-input bg-background text-muted-foreground hover:bg-accent/50"
                  }`}
                  onClick={() => onRelationMaxItemsChange(1)}
                >
                  {t("databaseWorkspace.relationLimitSingle")}
                </button>
              </div>
            </div>

            {/* Two-way relation */}
            {relationTargetDatabaseId === currentDatabaseId ? (
              <div className="space-y-2 rounded-lg border border-border/80 bg-muted/20 p-2.5">
                <span className="text-xs font-medium text-foreground block">
                  {t("databaseWorkspace.relationSelfDirection")}
                </span>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    className={`rounded-md border p-2 text-left text-xs ${
                      relationSelfDual
                        ? "border-primary bg-primary/10 text-primary font-semibold"
                        : "border-input bg-background text-muted-foreground hover:bg-accent/50"
                    }`}
                    onClick={() => onRelationSelfDualChange(true)}
                  >
                    <div>{t("databaseWorkspace.relationSelfDual")}</div>
                  </button>
                  <button
                    type="button"
                    className={`rounded-md border p-2 text-left text-xs ${
                      !relationSelfDual
                        ? "border-primary bg-primary/10 text-primary font-semibold"
                        : "border-input bg-background text-muted-foreground hover:bg-accent/50"
                    }`}
                    onClick={() => onRelationSelfDualChange(false)}
                  >
                    <div>{t("databaseWorkspace.relationSelfSingle")}</div>
                  </button>
                </div>
                {relationSelfDual && (
                  <label className="space-y-1 text-xs text-muted-foreground block pt-1">
                    <span>{t("databaseWorkspace.relationTwoWayTargetName")}</span>
                    <Input
                      value={relationInversePropertyName}
                      placeholder={t("databaseWorkspace.relationSelfDual")}
                      onChange={(e) => onRelationInversePropertyNameChange(e.target.value)}
                    />
                  </label>
                )}
              </div>
            ) : (
              <div className="space-y-2 rounded-lg border border-border/80 bg-muted/20 p-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-foreground">
                    {t("databaseWorkspace.relationTwoWay")}
                  </span>
                  <Switch checked={relationTwoWay} onCheckedChange={onRelationTwoWayChange} />
                </div>
                {relationTwoWay && (
                  <label className="space-y-1 text-xs text-muted-foreground block pt-1">
                    <span>{t("databaseWorkspace.relationTwoWayTargetName")}</span>
                    <Input
                      value={relationInversePropertyName}
                      placeholder={currentDatabaseTitle || t("databaseWorkspace.relationTarget")}
                      onChange={(e) => onRelationInversePropertyNameChange(e.target.value)}
                    />
                  </label>
                )}
              </div>
            )}
          </div>
        )}
        {mutationError && <p className="text-xs text-destructive">{mutationError}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            disabled={
              !propertyName.trim() ||
              mutationBusy ||
              (propertyType === "rollup" && !isDraftComplete(rollupDraft))
            }
            onClick={() => void onCreate()}
          >
            {t("common.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
