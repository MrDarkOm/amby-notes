import {
  type DatabaseSummary,
  createDatabaseProperty,
  getDatabaseNoteContext,
  type CustomProperty,
  type DatabaseNoteContext,
  type DatabasePropertySummary,
} from "@/lib/storage"
import type { DocumentProperties } from "../panel-registry"
import type { FrontmatterProperty } from "@/lib/storage/types"
import { type PropertyMutation, cellKey } from "../database/use-property-mutation"
import { DatabasePropertyRow, PropertyRow } from "./info-database-rows"
import { FrontmatterPropertyRow } from "./info-frontmatter-rows"
import * as React from "react"
import { Plus } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Reorder } from "motion/react"
import { ScrollArea } from "@/components/ui/scroll-area"
import { PropertyEditor } from "./property-editor"
import { databasePropertyIconKey } from "../database/property-icon"
import { PanelHeader } from "./panel-header"
import { PropertyGroupsNotices } from "./property-groups-notices"

interface InfoPanelBodyProps {
  properties: DocumentProperties
  openPropertyEditor: () => void
  nonDatabaseFrontmatterProperties: FrontmatterProperty[]
  nonDuplicateCustomProperties: CustomProperty[]
  noteDatabaseContext: DatabaseNoteContext | null
  propertyError: string | null | undefined
  warningKey: string | null
  hasNoteProperties: boolean
  orderedNoteDatabaseProperties: DatabasePropertySummary[]
  noteDatabaseOrder: {
    order: string[]
    draggingId: string | null
    reorder: (next: string[]) => void
    startDrag: (propertyId: string) => void
    endDrag: () => void
    moveWithKeyboard: (propertyId: string, direction: -1 | 1) => void
  }
  propertyMutation: PropertyMutation
  databases: DatabaseSummary[]
  onSelect: (id: string) => void
  createDatabaseRelationRow: (targetDatabaseId: string, title: string) => Promise<string | void>
  commitDatabaseProperty: (property: DatabasePropertySummary, valueJson?: string) => Promise<void>
  renameNoteDatabaseProperty: (property: DatabasePropertySummary, name: string) => Promise<void>
  deleteNoteDatabaseProperty: (property: DatabasePropertySummary) => Promise<void>
  iconOverrides: Record<string, string>
  setIcon: (id: string, icon: string) => void
  propertyOrderBusy: boolean
  customProperties: CustomProperty[]
  onUpsertCustomProperty: ((property: CustomProperty) => Promise<CustomProperty>) | undefined
  onDeleteCustomProperty: ((propertyId: string) => Promise<void>) | undefined
  customOrder: {
    order: string[]
    draggingId: string | null
    reorder: (next: string[]) => void
    startDrag: (propertyId: string) => void
    endDrag: () => void
    moveWithKeyboard: (propertyId: string, direction: -1 | 1) => void
  }
  setEditingProperty: React.Dispatch<React.SetStateAction<CustomProperty | null>>
  setPropertyEditorOpen: React.Dispatch<React.SetStateAction<boolean>>
  customPropertyOrderBusy: boolean
  onReorderCustomProperties: ((propertyIds: string[]) => Promise<void>) | undefined
  metadata: React.JSX.Element | null
  editingProperty: CustomProperty | null
  propertyEditorOpen: boolean
  currentDatabaseName: string | undefined
  setNoteDatabaseContext: (next: React.SetStateAction<DatabaseNoteContext | null>) => void
  refreshDatabaseCatalog: () => Promise<void>
  invalidateDatabaseHosts: () => void
}

export function InfoPanelBody({
  properties,
  openPropertyEditor,
  nonDatabaseFrontmatterProperties,
  nonDuplicateCustomProperties,
  noteDatabaseContext,
  propertyError,
  warningKey,
  hasNoteProperties,
  orderedNoteDatabaseProperties,
  noteDatabaseOrder,
  propertyMutation,
  databases,
  onSelect,
  createDatabaseRelationRow,
  commitDatabaseProperty,
  renameNoteDatabaseProperty,
  deleteNoteDatabaseProperty,
  iconOverrides,
  setIcon,
  propertyOrderBusy,
  customProperties,
  onUpsertCustomProperty,
  onDeleteCustomProperty,
  customOrder,
  setEditingProperty,
  setPropertyEditorOpen,
  customPropertyOrderBusy,
  onReorderCustomProperties,
  metadata,
  editingProperty,
  propertyEditorOpen,
  currentDatabaseName,
  setNoteDatabaseContext,
  refreshDatabaseCatalog,
  invalidateDatabaseHosts,
}: InfoPanelBodyProps) {
  const { t } = useTranslation()
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelHeader
        title={t("infoPanel.properties")}
        actions={
          <>
            <button
              type="button"
              className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              title={t("infoPanel.addProperty")}
              disabled={Boolean(properties.frontmatter.parseError)}
              onClick={openPropertyEditor}
            >
              <Plus className="size-3.5" />
            </button>
            <span className="rounded-full bg-accent px-2 py-0.5 text-[10px] tabular-nums text-muted-foreground">
              {nonDatabaseFrontmatterProperties.length +
                nonDuplicateCustomProperties.length +
                (noteDatabaseContext?.properties.length ?? 0)}
            </span>
          </>
        }
      />
      <ScrollArea className="flex-1">
        <div className="space-y-5 px-4 pb-4">
          {propertyError && (
            <p role="alert" className="text-xs text-destructive">
              {propertyError}
            </p>
          )}
          {warningKey && (
            <p role="status" className="text-xs text-muted-foreground">
              {t(warningKey)}
            </p>
          )}
          <PropertyGroupsNotices noteId={properties.id} />
          {hasNoteProperties ? (
            <section>
              <div className="space-y-0.5">
                {noteDatabaseContext && orderedNoteDatabaseProperties.length > 0 && (
                  <Reorder.Group
                    as="div"
                    axis="y"
                    values={noteDatabaseOrder.order}
                    onReorder={noteDatabaseOrder.reorder}
                    role="list"
                    className="space-y-0.5"
                  >
                    {orderedNoteDatabaseProperties.map((property, propertyIndex) => (
                      <DatabasePropertyRow
                        key={property.propertyId}
                        property={property}
                        context={noteDatabaseContext}
                        pending={propertyMutation.pendingCells.size > 0}
                        error={
                          propertyMutation.cellErrors[
                            cellKey(noteDatabaseContext.row.noteId, property.propertyId)
                          ]
                        }
                        databases={databases}
                        onOpenNote={onSelect}
                        onCreateRelationRow={createDatabaseRelationRow}
                        onCommit={(valueJson) => commitDatabaseProperty(property, valueJson)}
                        onRename={(name) => renameNoteDatabaseProperty(property, name)}
                        onDelete={() => deleteNoteDatabaseProperty(property)}
                        iconValue={
                          iconOverrides[
                            databasePropertyIconKey(
                              noteDatabaseContext.databaseId,
                              property.propertyId,
                            )
                          ]
                        }
                        onIconChange={(icon) =>
                          setIcon(
                            databasePropertyIconKey(
                              noteDatabaseContext.databaseId,
                              property.propertyId,
                            ),
                            icon,
                          )
                        }
                        dragging={noteDatabaseOrder.draggingId === property.propertyId}
                        disabled={noteDatabaseContext.locked || propertyOrderBusy}
                        onDragStart={() => noteDatabaseOrder.startDrag(property.propertyId)}
                        onDragEnd={noteDatabaseOrder.endDrag}
                        onKeyDown={(event) => {
                          if (event.key === "ArrowUp" && propertyIndex > 0) {
                            event.preventDefault()
                            noteDatabaseOrder.moveWithKeyboard(property.propertyId, -1)
                          }
                          if (
                            event.key === "ArrowDown" &&
                            propertyIndex < orderedNoteDatabaseProperties.length - 1
                          ) {
                            event.preventDefault()
                            noteDatabaseOrder.moveWithKeyboard(property.propertyId, 1)
                          }
                        }}
                      />
                    ))}
                  </Reorder.Group>
                )}
                {nonDatabaseFrontmatterProperties.length > 0 && (
                  <div role="list" className="space-y-0.5">
                    {nonDatabaseFrontmatterProperties.map((property) => {
                      const matchedCustom = customProperties.find(
                        (cp) =>
                          cp.name.trim().toLowerCase() === property.key.trim().toLowerCase() ||
                          cp.id === property.key,
                      )
                      const propertyType =
                        matchedCustom?.propertyType ||
                        (property.valueKind === "checkbox"
                          ? "checkbox"
                          : property.valueKind === "number"
                            ? "number"
                            : property.valueKind === "date"
                              ? "date"
                              : property.valueKind === "list"
                                ? "list"
                                : "text")
                      const icon = matchedCustom?.icon

                      return (
                        <FrontmatterPropertyRow
                          key={property.key}
                          property={property}
                          iconValue={icon}
                          propertyType={propertyType}
                          settings={matchedCustom?.settings || ""}
                          onIconChange={async (nextIcon) => {
                            await onUpsertCustomProperty?.({
                              id: matchedCustom?.id || property.key,
                              name: property.key,
                              icon: nextIcon ?? "",
                              propertyType,
                              value: matchedCustom?.value || property.value,
                              settings: matchedCustom?.settings || "",
                            })
                          }}
                          onRename={async (newName) => {
                            if (!newName.trim() || newName.trim() === property.key) return
                            await onUpsertCustomProperty?.({
                              id: matchedCustom?.id || property.key,
                              name: newName.trim(),
                              icon: icon ?? "",
                              propertyType,
                              value: matchedCustom?.value || property.value,
                              settings: matchedCustom?.settings || "",
                            })
                          }}
                          onChangeType={async (nextType) => {
                            if (nextType === propertyType) return
                            await onUpsertCustomProperty?.({
                              id: matchedCustom?.id || property.key,
                              name: property.key,
                              icon: icon ?? "",
                              propertyType: nextType,
                              value: matchedCustom?.value || property.value,
                              settings: matchedCustom?.settings || "",
                            })
                          }}
                          onChangeSettings={async (nextSettings) => {
                            if (nextSettings === (matchedCustom?.settings || "")) return
                            await onUpsertCustomProperty?.({
                              id: matchedCustom?.id || property.key,
                              name: property.key,
                              icon: icon ?? "",
                              propertyType,
                              value: matchedCustom?.value || property.value,
                              settings: nextSettings,
                            })
                          }}
                          onSave={async (nextVal) => {
                            await onUpsertCustomProperty?.({
                              id: matchedCustom?.id || property.key,
                              name: property.key,
                              icon: icon ?? "",
                              propertyType,
                              value: nextVal,
                              settings: matchedCustom?.settings || "",
                            })
                          }}
                          onDelete={async () => {
                            await onDeleteCustomProperty?.(matchedCustom?.id || property.key)
                          }}
                          disabled={Boolean(properties.frontmatter.parseError)}
                        />
                      )
                    })}
                  </div>
                )}
                {nonDuplicateCustomProperties.length > 0 && (
                  <Reorder.Group
                    as="div"
                    axis="y"
                    values={customOrder.order}
                    onReorder={customOrder.reorder}
                    role="list"
                    className="space-y-0.5"
                  >
                    {nonDuplicateCustomProperties.map((property, propertyIndex) => (
                      <PropertyRow
                        key={property.id}
                        property={property}
                        onEdit={() => {
                          setEditingProperty(property)
                          setPropertyEditorOpen(true)
                        }}
                        onValueSave={async (updated) => {
                          await onUpsertCustomProperty?.(updated)
                        }}
                        dragging={customOrder.draggingId === property.id}
                        disabled={customPropertyOrderBusy || !onReorderCustomProperties}
                        onDragStart={() => customOrder.startDrag(property.id)}
                        onDragEnd={customOrder.endDrag}
                        onKeyDown={(event) => {
                          if (event.key === "ArrowUp" && propertyIndex > 0) {
                            event.preventDefault()
                            customOrder.moveWithKeyboard(property.id, -1)
                          }
                          if (
                            event.key === "ArrowDown" &&
                            propertyIndex < nonDuplicateCustomProperties.length - 1
                          ) {
                            event.preventDefault()
                            customOrder.moveWithKeyboard(property.id, 1)
                          }
                        }}
                      />
                    ))}
                  </Reorder.Group>
                )}
              </div>
            </section>
          ) : null}
          <button
            type="button"
            className="flex items-start gap-2 px-1.5 py-1 text-left text-xs text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            title={t("infoPanel.addProperty")}
            disabled={Boolean(properties.frontmatter.parseError)}
            onClick={openPropertyEditor}
          >
            <Plus className="mt-0.5 size-3.5 shrink-0" />
            {t(hasNoteProperties ? "infoPanel.addProperty" : "infoPanel.addFirstProperty")}
          </button>
        </div>
      </ScrollArea>
      {metadata}
      <PropertyEditor
        property={editingProperty}
        open={propertyEditorOpen}
        onOpenChange={setPropertyEditorOpen}
        databaseContext={
          noteDatabaseContext && !noteDatabaseContext.locked
            ? {
                databaseId: noteDatabaseContext.databaseId,
                name: currentDatabaseName || noteDatabaseContext.databaseId,
              }
            : null
        }
        onSave={async (property, options) => {
          if (options?.addToDatabase && noteDatabaseContext && !noteDatabaseContext.locked) {
            const existsInDb = noteDatabaseContext.properties.some(
              (p) => p.name.trim().toLowerCase() === property.name.trim().toLowerCase(),
            )
            if (!existsInDb) {
              try {
                const created = await createDatabaseProperty({
                  expectedGeneration: noteDatabaseContext.vaultGeneration,
                  databaseId: noteDatabaseContext.databaseId,
                  expectedManifestRevision: noteDatabaseContext.manifestRevision,
                  name: property.name.trim(),
                  propertyType: property.propertyType,
                })
                if (property.icon) {
                  setIcon(
                    databasePropertyIconKey(noteDatabaseContext.databaseId, created.propertyId),
                    property.icon,
                  )
                }
                const refreshed = await getDatabaseNoteContext(noteDatabaseContext.row.noteId)
                setNoteDatabaseContext(refreshed)
                void refreshDatabaseCatalog().catch(() => {})
                invalidateDatabaseHosts()
              } catch (err) {
                invalidateDatabaseHosts()
                throw err
              }
            }
          }
          await onUpsertCustomProperty?.(property)
        }}
        onDelete={async (propertyId) => {
          await onDeleteCustomProperty?.(propertyId)
        }}
      />
    </div>
  )
}
