#!/usr/bin/env node

/**
 * Generate a deterministic, disposable Amby database fixture.
 * The script never accepts or reads a vault path. Its output is restricted to
 * a disposable directory below the system temporary directory.
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"

const sizes = new Set([10000, 50000, 100000])
const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

function idFor(index) {
  let value = BigInt(index + 1)
  let suffix = ""
  while (suffix.length < 16) {
    suffix = alphabet[Number(value & 31n)] + suffix
    value >>= 5n
  }
  return "01J0000000" + suffix
}

function argument(name, fallback) {
  const index = globalThis.process.argv.indexOf(name)
  return index < 0 ? fallback : globalThis.process.argv[index + 1]
}

const size = Number(argument("--size", "10000"))
if (!sizes.has(size)) throw new Error("--size must be one of 10000, 50000, or 100000")

const requestedOutput = argument("--output", null)
const output = requestedOutput
  ? resolve(requestedOutput)
  : await mkdtemp(join(tmpdir(), "amby-db-fixture-"))
if (!basename(output).startsWith("amby-db-fixture-") || !output.startsWith(resolve(tmpdir()))) {
  throw new Error("output must be a disposable directory under the system temporary directory")
}

const databaseId = idFor(900000)
const viewIds = [900001, 900002, 900003, 900004].map(idFor)
const propertyIds = Array.from({ length: 20 }, function (_, index) {
  return idFor(100000 + index)
})
const optionIds = Array.from({ length: 8 }, function (_, index) {
  return idFor(200000 + index)
})
const databasePath = join(output, "Characters")
const recordsPath = join(databasePath, ".ambd", "records")
const viewsPath = join(databasePath, ".ambd", "views")
await mkdir(recordsPath, { recursive: true })
await mkdir(viewsPath, { recursive: true })

const properties = [
  {
    type: "text",
    id: propertyIds[0],
    name: "Description",
    pageVisibility: "alwaysShow",
    config: { multiline: true },
  },
  {
    type: "number",
    id: propertyIds[1],
    name: "Power",
    pageVisibility: "alwaysShow",
    config: { format: "number", currency: null },
  },
  {
    type: "checkbox",
    id: propertyIds[2],
    name: "Active",
    pageVisibility: "alwaysShow",
    config: {},
  },
  {
    type: "date",
    id: propertyIds[3],
    name: "Created",
    pageVisibility: "alwaysShow",
    config: { includeTime: false, allowRange: false },
  },
]
  .concat(
    Array.from({ length: 6 }, function (_, index) {
      return {
        type: index % 2 ? "multiSelect" : "select",
        id: propertyIds[index + 4],
        name: "Option " + (index + 1),
        pageVisibility: "hideWhenEmpty",
        config: {
          options: optionIds.map(function (id, optionIndex) {
            return {
              id,
              name: "Option " + (optionIndex + 1),
              color: ["#f97316", "#22c55e", "#3b82f6", "#a855f7"][optionIndex % 4],
            }
          }),
        },
      }
    }),
  )
  .concat([
    {
      type: "relation",
      id: propertyIds[10],
      name: "World",
      pageVisibility: "alwaysShow",
      config: { targetDatabaseId: databaseId, maxItems: null, inversePropertyId: null },
    },
  ])
  .concat(
    Array.from({ length: 9 }, function (_, index) {
      return {
        type: "text",
        id: propertyIds[index + 11],
        name: "Text " + (index + 1),
        pageVisibility: "hideWhenEmpty",
        config: { multiline: false },
      }
    }),
  )

await writeFile(
  join(databasePath, "ambd.json"),
  JSON.stringify(
    {
      format: "amby-database",
      formatVersion: 1,
      databaseId,
      name: "Characters",
      icon: "🧙",
      cover: null,
      locked: false,
      membership: { kind: "filesystem-descendants", recursive: true },
      properties,
      viewOrder: viewIds,
      defaultViewId: viewIds[0],
      templateOrder: [],
      defaultTemplateId: null,
    },
    null,
    2,
  ) + "\n",
)

for (let index = 0; index < viewIds.length; index += 1) {
  const viewId = viewIds[index]
  const fields = [
    { field: { kind: "system", field: "title" }, visible: true, width: null, frozen: true },
  ].concat(
    properties.slice(0, 4).map(function (property) {
      return {
        field: { kind: "property", propertyId: property.id },
        visible: true,
        width: null,
        frozen: false,
      }
    }),
  )
  await writeFile(
    join(viewsPath, viewId + ".json"),
    JSON.stringify(
      {
        format: "amby-database-view",
        formatVersion: 1,
        databaseId,
        viewId,
        name: ["All characters", "Active", "By world", "Gallery"][index],
        layout: ["table", "table", "board", "gallery"][index],
        openMode: "sidePeek",
        subitemsMode: "nested",
        density: "default",
        fields,
        filter:
          index === 1
            ? {
                kind: "condition",
                field: { kind: "property", propertyId: propertyIds[2] },
                operator: "equals",
                value: true,
              }
            : null,
        sorts: [{ field: { kind: "system", field: "title" }, direction: "asc", nulls: "last" }],
        group:
          index === 2
            ? { field: { kind: "property", propertyId: propertyIds[4] }, emptyLabel: "No option" }
            : null,
        manualOrder: [],
        aggregates: [],
        layoutConfig: {},
      },
      null,
      2,
    ) + "\n",
  )
}

for (let index = 0; index < size; index += 1) {
  const noteId = idFor(index)
  const title = index % 17 === 0 ? "Алекс" : "Character " + String(index + 1).padStart(6, "0")
  const selectedOptions =
    index % 10 === 0
      ? [optionIds[index % optionIds.length], optionIds[(index + 1) % optionIds.length]]
      : [optionIds[index % optionIds.length]]
  const values = {
    [propertyIds[0]]: { type: "text", value: "Unicode: Мир " + (index % 11) + " — " + title },
    [propertyIds[1]]: {
      type: "number",
      decimal: String(index % 1000) + "." + String(index % 1000).padStart(3, "0"),
    },
    [propertyIds[2]]: { type: "checkbox", checked: index % 3 !== 0 },
    [propertyIds[3]]: {
      type: "date",
      start: "2026-" + String((index % 12) + 1).padStart(2, "0") + "-15",
      end: null,
      timeZone: null,
    },
    [propertyIds[4]]: { type: "select", optionId: optionIds[index % optionIds.length] },
    [propertyIds[5]]: { type: "multiSelect", optionIds: selectedOptions },
    [propertyIds[10]]: { type: "relation", targetNoteIds: [idFor(index % size)] },
  }
  for (const propertyId of propertyIds.slice(6, 10).concat(propertyIds.slice(11))) {
    values[propertyId] = { type: "text", value: index % 5 === 0 ? "Value " + index : "" }
  }
  const note =
    "---\namby-id: " +
    noteId +
    "\namby-title: " +
    JSON.stringify(title) +
    "\n---\n# " +
    title +
    "\n\nFixture row " +
    (index + 1) +
    ".\n"
  await Promise.all([
    writeFile(join(databasePath, title.replaceAll("/", "-") + "-" + noteId + ".md"), note),
    writeFile(
      join(recordsPath, noteId + ".json"),
      JSON.stringify(
        { format: "amby-database-record", formatVersion: 1, databaseId, noteId, values },
        null,
        2,
      ) + "\n",
    ),
  ])
}

globalThis.console.log(
  JSON.stringify(
    {
      output,
      databaseId,
      size,
      properties: properties.length,
      views: viewIds.length,
      duplicateTitleEvery: 17,
      multiValueEvery: 10,
      relation: "self",
      seed: 1,
    },
    null,
    2,
  ),
)
