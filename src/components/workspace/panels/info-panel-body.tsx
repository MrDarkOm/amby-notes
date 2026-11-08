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
import { PropertyDormantList } from "./property-dormant-list"

interface InfoPanelBodyProps {
  properties: DocumentProperties
  openPropertyEditor: () => void
  nonDatabaseFrontmatterProperties: FrontmatterProperty[]
  nonDuplicateCustomProperties: CustomProperty[]
  noteDatabaseContext: DatabaseNoteContext | null
  propertyError: string | null | undefined
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
  onCreateProperty?: (property: CustomProperty) => Promise<void>
  onSetPropertyIcon?: (name: string, icon: string) => Promise<void>
  onSetPropertySettings?: (name: string, settings: string) => Promise<void>
  onRenameProperty?: (name: string, newName: string) => Promise<void>
  onChangePropertyType?: (name: string, propertyType: string) => Promise<void>
  onSetPropertyValue?: (name: string, value: string) => Promise<void>
  onSetPropertyList?: (name: string, items: string[]) => Promise<void>
  metadata: React.JSX.Element | null
  editingProperty: CustomProperty | null
  propertyEditorOpen: boolean
  currentDatabaseName: string | undefined
  setNoteDatabaseContext: (next: React.SetStateAction<DatabaseNoteContext | null>) => void
  refreshDatabaseCatalog: () => Promise<void>
  invalidateDatabaseHosts: () => void
}

function listFromJson(value: string): string[] | null {
  if (!value.startsWith("[")) return null
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : null
  } catch {
    return null
  }
}

export function InfoPanelBody({
  properties,
  openPropertyEditor,
  nonDatabaseFrontmatterProperties,
  nonDuplicateCustomProperties,
  noteDatabaseContext,
  propertyError,
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
  onCreateProperty,
  onSetPropertyIcon,
  onSetPropertySettings,
  onRenameProperty,
  onChangePropertyType,
  onSetPropertyValue,
  onSetPropertyList,
  metadata,
  editingProperty,
  propertyEditorOpen,
  currentDatabaseName,
  setNoteDatabaseContext,
  refreshDatabaseCatalog,
  invalidateDatabaseHosts,
}: InfoPanelBodyProps) {
  const { t } = useTranslation()
  // Where the properties are changed by name (З60), the editor sends only the fields the person
  // changed in the form, each as its own narrow command; the form is compared with the property as
  // it was when the editor opened, never with what a row drew earlier.
  async function saveEdited(draft: CustomProperty) {
    if (!onRenameProperty || !onChangePropertyType || !onSetPropertyIcon) {
      await onUpsertCustomProperty?.(draft)
      return
    }
    const original = editingProperty
    if (!original) {
      await onCreateProperty?.(draft)
      return
    }
    const name = draft.name.trim()
    let at = original.name
    if (name && name !== original.name) {
      await onRenameProperty(original.name, name)
      at = name
    }
    if (draft.propertyType !== original.propertyType)
      await onChangePropertyType(at, draft.propertyType)
    if (draft.icon !== original.icon) await onSetPropertyIcon(at, draft.icon)
    if (draft.settings !== original.settings) await onSetPropertySettings?.(at, draft.settings)
    if (draft.value !== original.value) {
      // A multi-select value is a JSON list of items; it is written as the list (З62).
      const items = draft.propertyType === "list" ? listFromJson(draft.value) : null
      if (items && onSetPropertyList) await onSetPropertyList(at, items)
      else await onSetPropertyValue?.(at, draft.value)
    }
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelHeader
        title={t("infoPanel.properties")}
        actions={
          <>
            {!properties.frontmatter.parseError && (
              <button
                type="button"
                className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                title={t("infoPanel.addProperty")}
                onClick={openPropertyEditor}
              >
                <Plus className="size-3.5" />
              </button>
            )}
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
          <PropertyDormantList noteId={properties.id} />
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
                            if (onSetPropertyIcon) {
                              await onSetPropertyIcon(
                                matchedCustom?.name ?? property.key,
                                nextIcon ?? "",
                              )
                              return
                            }
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
                            if (onRenameProperty) {
                              await onRenameProperty(
                                matchedCustom?.name ?? property.key,
                                newName.trim(),
                              )
                              return
                            }
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
                            if (onChangePropertyType) {
                              await onChangePropertyType(
                                matchedCustom?.name ?? property.key,
                                nextType,
                              )
                              return
                            }
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
                            if (onSetPropertySettings) {
                              await onSetPropertySettings(
                                matchedCustom?.name ?? property.key,
                                nextSettings,
                              )
                              return
                            }
                            await onUpsertCustomProperty?.({
                              id: matchedCustom?.id || property.key,
                              name: property.key,
                              icon: icon ?? "",
                              propertyType,
                              value: matchedCustom?.value || property.value,
                              settings: nextSettings,
                            })
                          }}
                          onSaveList={
                            onSetPropertyList
                              ? (items) =>
                                  onSetPropertyList(matchedCustom?.name ?? property.key, items)
                              : undefined
                          }
                          onSave={async (nextVal) => {
                            if (onSetPropertyValue) {
                              await onSetPropertyValue(matchedCustom?.name ?? property.key, nextVal)
                              return
                            }
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
                          if (onSetPropertyValue) {
                            await onSetPropertyValue(updated.name, updated.value)
                            return
                          }
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
          {!properties.frontmatter.parseError && (
            <button
              type="button"
              className="flex items-start gap-2 px-1.5 py-1 text-left text-xs text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
              title={t("infoPanel.addProperty")}
              onClick={openPropertyEditor}
            >
              <Plus className="mt-0.5 size-3.5 shrink-0" />
              {t(hasNoteProperties ? "infoPanel.addProperty" : "infoPanel.addFirstProperty")}
            </button>
          )}
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
                // The change is saved; if the catalog of databases is not refreshed, the side list
                // stays old until the next refresh.
                void refreshDatabaseCatalog().catch(() => {})
                invalidateDatabaseHosts()
              } catch (err) {
                invalidateDatabaseHosts()
                throw err
              }
            }
          }
          await saveEdited(property)
        }}
        onDelete={async (propertyId) => {
          await onDeleteCustomProperty?.(propertyId)
        }}
      />
    </div>
  )
}
