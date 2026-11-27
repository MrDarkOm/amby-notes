import i18n from "@/lib/i18n"
import { parseOptions } from "../property-options"
import { logger } from "@/lib/logger"
import {
  applyDatabaseValueBatch,
  backupCustomProperties,
  createDatabaseProperty,
  getDatabaseNoteContext,
  type CustomProperty,
  type DatabaseNoteContext,
  type DatabasePropertySummary,
  type NoteProperties,
} from "@/lib/storage"

// Carrying the properties of a note over to the database it was moved into (docs/vault-format.md: the values
// live in the header of the note only). A field is made for each property and named like its header key, so the
// field reads and writes that very key and nothing is stored twice; the header is not rewritten when the value
// already matches. The look of the property (its type and options) is what is new in the database.

/** A property to carry over: one with a look of its own, or a plain key of the header. */
export interface MigratingProperty extends CustomProperty {
  /** The items of a list, as the header has them. */
  items?: string[]
}

/** Keys that Amby or other tools own; they are not fields of a database. */
const KEPT_IN_NOTE = new Set(["id", "title", "tags", "tag", "aliases", "alias", "cssclasses"])

const sameText = (a: string, b: string) =>
  a.localeCompare(b, undefined, { sensitivity: "base" }) === 0

/** What the person would call the properties of the note: those with a look and the plain header keys. */
export function propertiesToMigrate(note: NoteProperties): MigratingProperty[] {
  const found: MigratingProperty[] = (note.customProperties ?? []).map((property) => ({
    ...property,
  }))
  for (const property of note.properties ?? []) {
    const key = property.key.trim()
    if (!key || key.toLowerCase().startsWith("amby-") || KEPT_IN_NOTE.has(key.toLowerCase()))
      continue
    const known = found.find((existing) => sameText(existing.name, key))
    if (known) {
      // A look the panel derived for a list carries its items joined; the header has them whole.
      if (known.propertyType === "list" && !known.items) known.items = property.items
      continue
    }
    const propertyType =
      property.valueKind === "number" ||
      property.valueKind === "checkbox" ||
      property.valueKind === "date" ||
      property.valueKind === "list"
        ? property.valueKind
        : "text"
    found.push({
      id: key,
      name: key,
      icon: "",
      propertyType,
      value: property.value,
      settings: "",
      items: property.items,
    })
  }
  return found
}

function listItems(property: MigratingProperty): string[] {
  if (property.items?.length) return property.items
  try {
    const parsed: unknown = JSON.parse(property.value)
    if (Array.isArray(parsed))
      return parsed.filter((item): item is string => typeof item === "string")
  } catch {
    // Not a JSON list: the items are not known (the value is only their text joined), and the options of
    // the settings stand for them.
  }
  return []
}

function migratedPropertyType(property: MigratingProperty): string {
  if (
    property.propertyType === "number" &&
    (!property.value || Number.isFinite(Number(property.value)))
  )
    return "number"
  if (property.propertyType === "checkbox") return "checkbox"
  if (
    property.propertyType === "date" &&
    (!property.value || /^\d{4}-\d{2}-\d{2}/.test(property.value))
  )
    return "date"
  if (property.propertyType === "url") return "url"
  if (property.propertyType === "select") return "select"
  if (property.propertyType === "list") return "multiSelect"
  return "text"
}

/** The options of a select or a list: `{"options":[…]}` in the settings (the old text split by commas still reads). */
export function migratedOptions(property: MigratingProperty): string[] {
  const options = [...parseOptions(property.settings).options]
  const wanted =
    property.propertyType === "list" ? listItems(property) : property.value ? [property.value] : []
  for (const value of wanted) {
    if (!options.some((option) => sameText(option, value))) options.push(value)
  }
  return options
}

function migratedValue(
  property: MigratingProperty,
  propertyType: string,
  targetProperty: DatabasePropertySummary,
): string | undefined {
  if (propertyType === "multiSelect") return undefined // the list is in the header, the field reads it there
  if (!property.value) return undefined
  if (propertyType === "number") return JSON.stringify({ type: "number", decimal: property.value })
  if (propertyType === "checkbox") {
    return JSON.stringify({ type: "checkbox", checked: property.value === "true" })
  }
  if (propertyType === "date") return JSON.stringify({ type: "date", start: property.value })
  if (propertyType === "select") {
    const option = targetProperty.options.find((candidate) =>
      sameText(candidate.name, property.value),
    )
    if (!option) {
      throw new Error(
        i18n.t("infoPanel.databasePropertyMoveOptionMissing", { property: property.name }),
      )
    }
    return JSON.stringify({ type: "select", optionId: option.optionId })
  }
  return JSON.stringify({ type: propertyType, value: property.value })
}

export async function migratePropertiesToDatabase(
  vault: string,
  context: DatabaseNoteContext,
  properties: MigratingProperty[],
) {
  let manifestRevision = context.manifestRevision
  const targetProperties: Array<{ propertyId: string; property: MigratingProperty; type: string }> =
    []

  for (const property of properties) {
    const type = migratedPropertyType(property)
    const sameName = context.properties.find((candidate) => sameText(candidate.name, property.name))
    if (sameName) {
      const fits =
        sameName.propertyType === type &&
        (type !== "select" ||
          !property.value ||
          sameName.options.some((option) => sameText(option.name, property.value)))
      if (fits) targetProperties.push({ propertyId: sameName.propertyId, property, type })
      // A field of another kind already reads this key: a second field would store the value again
      // under a new key. The value stays in the header of the note, where that field reads it.
      else logger.debug("file.move_property_name_taken", { type })
      continue
    }
    const created = await createDatabaseProperty({
      expectedGeneration: context.vaultGeneration,
      databaseId: context.databaseId,
      expectedManifestRevision: manifestRevision,
      name: property.name.trim(),
      propertyType: type,
      options: type === "select" || type === "multiSelect" ? migratedOptions(property) : undefined,
    })
    manifestRevision = created.manifestRevision
    targetProperties.push({ propertyId: created.propertyId, property, type })
  }

  const refreshedContext = (await getDatabaseNoteContext(context.row.noteId)) ?? context
  const cells = targetProperties.flatMap(({ propertyId, property, type }) => {
    const targetProperty = refreshedContext.properties.find(
      (candidate) => candidate.propertyId === propertyId,
    )
    if (!targetProperty) {
      throw new Error(
        i18n.t("infoPanel.databasePropertyMoveFieldMissing", { property: property.name }),
      )
    }
    const valueJson = migratedValue(property, type, targetProperty)
    return valueJson
      ? [
          {
            noteId: context.row.noteId,
            propertyId,
            valueJson,
            expectedRevision: context.row.rowRevision,
          },
        ]
      : []
  })
  if (cells.length) {
    await applyDatabaseValueBatch({
      expectedGeneration: context.vaultGeneration,
      databaseId: context.databaseId,
      operationId:
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? `property-migration-${crypto.randomUUID()}`
          : `property-migration-${Date.now()}`,
      cells,
    })
  }
  await backupCustomProperties(vault, context.row.noteId)
}
