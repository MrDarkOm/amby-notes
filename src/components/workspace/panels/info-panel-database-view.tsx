import {
  type DatabaseDiagnostic,
  type DatabaseSummary,
  createDatabaseProperty,
  listDatabases,
  type CustomProperty,
  type DatabasePropertySummary,
} from "@/lib/storage"
import type { DatabasePanelProperties } from "../panel-registry"
import { DatabaseSchemaRow } from "./info-database-rows"
import * as React from "react"
import { Plus } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Reorder } from "motion/react"
import { ScrollArea } from "@/components/ui/scroll-area"
import { PropertyEditor } from "./property-editor"
import { databasePropertyIconKey } from "../database/property-icon"
import { PanelHeader } from "./panel-header"

interface InfoPanelDatabaseViewProps {
  databaseProperties: DatabasePanelProperties
  databaseSchemaBusy: boolean
  setEditingDatabaseProperty: React.Dispatch<React.SetStateAction<CustomProperty | null>>
  setDatabasePropertyEditorOpen: React.Dispatch<React.SetStateAction<boolean>>
  databaseSchemaOrder: {
    order: string[]
    draggingId: string | null
    reorder: (next: string[]) => void
    startDrag: (propertyId: string) => void
    endDrag: () => void
    moveWithKeyboard: (propertyId: string, direction: -1 | 1) => void
  }
  orderedDatabaseSchemaProperties: DatabasePropertySummary[]
  propertyOrderBusy: boolean
  renameSchemaProperty: (property: DatabasePropertySummary, name: string) => Promise<void>
  deleteSchemaProperty: (property: DatabasePropertySummary) => Promise<void>
  iconOverrides: Record<string, string>
  setIcon: (id: string, icon: string) => void
  metadata: React.JSX.Element | null
  editingDatabaseProperty: CustomProperty | null
  databasePropertyEditorOpen: boolean
  vaultGeneration: number | null
  setDatabaseSchemaBusy: React.Dispatch<React.SetStateAction<boolean>>
  setDatabaseCatalog: (databases: DatabaseSummary[], diagnostics?: DatabaseDiagnostic[]) => void
  invalidateDatabaseHosts: () => void
}

export function InfoPanelDatabaseView({
  databaseProperties,
  databaseSchemaBusy,
  setEditingDatabaseProperty,
  setDatabasePropertyEditorOpen,
  databaseSchemaOrder,
  orderedDatabaseSchemaProperties,
  propertyOrderBusy,
  renameSchemaProperty,
  deleteSchemaProperty,
  iconOverrides,
  setIcon,
  metadata,
  editingDatabaseProperty,
  databasePropertyEditorOpen,
  vaultGeneration,
  setDatabaseSchemaBusy,
  setDatabaseCatalog,
  invalidateDatabaseHosts,
}: InfoPanelDatabaseViewProps) {
  const { t } = useTranslation()
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelHeader
        title={t("panels.info")}
        actions={
          <>
            <button
              type="button"
              className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              title={t("infoPanel.addProperty")}
              disabled={Boolean(databaseProperties.locked) || databaseSchemaBusy}
              onClick={() => {
                setEditingDatabaseProperty(null)
                setDatabasePropertyEditorOpen(true)
              }}
            >
              <Plus className="size-3.5" />
            </button>
            <span className="rounded-full bg-accent px-2 py-0.5 text-[10px] tabular-nums text-muted-foreground">
              {databaseProperties.properties.length}
            </span>
          </>
        }
      />
      <ScrollArea className="flex-1">
        <div className="space-y-5 px-4 pb-4">
          <section>
            {databaseProperties.properties.length > 0 ? (
              <Reorder.Group
                as="div"
                axis="y"
                values={databaseSchemaOrder.order}
                onReorder={databaseSchemaOrder.reorder}
                role="list"
                className="space-y-0.5"
              >
                {orderedDatabaseSchemaProperties.map((property, propertyIndex) => (
                  <DatabaseSchemaRow
                    key={property.propertyId}
                    property={property}
                    disabled={
                      Boolean(databaseProperties.locked) || databaseSchemaBusy || propertyOrderBusy
                    }
                    onRename={(name) => renameSchemaProperty(property, name)}
                    onDelete={() => deleteSchemaProperty(property)}
                    iconValue={
                      iconOverrides[
                        databasePropertyIconKey(databaseProperties.id, property.propertyId)
                      ]
                    }
                    onIconChange={(icon) =>
                      setIcon(
                        databasePropertyIconKey(databaseProperties.id, property.propertyId),
                        icon,
                      )
                    }
                    dragging={databaseSchemaOrder.draggingId === property.propertyId}
                    onDragStart={() => databaseSchemaOrder.startDrag(property.propertyId)}
                    onDragEnd={databaseSchemaOrder.endDrag}
                    onKeyDown={(event) => {
                      if (event.key === "ArrowUp" && propertyIndex > 0) {
                        event.preventDefault()
                        databaseSchemaOrder.moveWithKeyboard(property.propertyId, -1)
                      }
                      if (
                        event.key === "ArrowDown" &&
                        propertyIndex < orderedDatabaseSchemaProperties.length - 1
                      ) {
                        event.preventDefault()
                        databaseSchemaOrder.moveWithKeyboard(property.propertyId, 1)
                      }
                    }}
                  />
                ))}
              </Reorder.Group>
            ) : (
              <div className="px-1 py-3 text-xs text-muted-foreground">
                {t("infoPanel.noCustom")}
              </div>
            )}
          </section>
          {!databaseProperties.locked && (
            <button
              type="button"
              className="flex items-start gap-2 px-1.5 py-1 text-left text-xs text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
              title={t("infoPanel.addProperty")}
              disabled={databaseSchemaBusy}
              onClick={() => {
                setEditingDatabaseProperty(null)
                setDatabasePropertyEditorOpen(true)
              }}
            >
              <Plus className="size-3.5" />
              {t("infoPanel.addProperty")}
            </button>
          )}
        </div>
      </ScrollArea>
      {metadata}
      <PropertyEditor
        property={editingDatabaseProperty}
        open={databasePropertyEditorOpen}
        onOpenChange={(open) => {
          setDatabasePropertyEditorOpen(open)
          if (!open) setEditingDatabaseProperty(null)
        }}
        onSave={async (property) => {
          if (!databaseProperties || vaultGeneration === null || databaseProperties.locked) return
          setDatabaseSchemaBusy(true)
          try {
            const created = await createDatabaseProperty({
              expectedGeneration: vaultGeneration,
              databaseId: databaseProperties.id,
              expectedManifestRevision: databaseProperties.manifestRevision,
              name: property.name.trim(),
              propertyType: property.propertyType,
            })
            if (property.icon) {
              setIcon(
                databasePropertyIconKey(databaseProperties.id, created.propertyId),
                property.icon,
              )
            }
            const catalog = await listDatabases()
            setDatabaseCatalog(catalog)
            invalidateDatabaseHosts()
          } finally {
            setDatabaseSchemaBusy(false)
          }
        }}
        onDelete={async () => {}}
      />
    </div>
  )
}
