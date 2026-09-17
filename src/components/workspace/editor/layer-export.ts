import { exportTextFile } from "@/lib/storage"
import { serializeCsv } from "../database/editing/csv"
import { useDatabaseStore } from "../database/database-store"
import { readDatabaseCellValue, databaseCellText } from "../database/database-cell-value"

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export async function exportDatabaseCsv(
  databaseId?: string | null,
  defaultTitle = "database",
): Promise<void> {
  const store = useDatabaseStore.getState()
  const targetId = databaseId ?? store.databases[0]?.databaseId
  const db = store.databases.find((d) => d.databaseId === targetId)
  const host = Object.values(store.hosts).find(
    (h) => h.databaseId === targetId && h.rows.length > 0,
  )
  const properties = db?.properties ?? []
  const rows = host?.rows ?? []

  const headerRow = ["Title", ...properties.map((p) => p.name)]
  const dataRows = rows.map((r) => [
    r.title,
    ...properties.map((p) => {
      const cell = readDatabaseCellValue(r.valuesJson, p.propertyId)
      return databaseCellText(cell, p.propertyType)
    }),
  ])

  const csv = serializeCsv([headerRow, ...dataRows])
  const safeName = (db?.title || defaultTitle).replace(/[/\\?%*:|"<>]/g, "-")
  await exportTextFile(csv, `${safeName}.csv`)
}

export async function exportDatabaseSqlite(
  databaseId?: string | null,
  defaultTitle = "database",
): Promise<void> {
  const store = useDatabaseStore.getState()
  const targetId = databaseId ?? store.databases[0]?.databaseId
  const db = store.databases.find((d) => d.databaseId === targetId)
  const host = Object.values(store.hosts).find(
    (h) => h.databaseId === targetId && h.rows.length > 0,
  )
  const properties = db?.properties ?? []
  const rows = host?.rows ?? []

  const tableName =
    (db?.title || defaultTitle).toLowerCase().replace(/[^a-z0-9_]/g, "_") || "database_table"
  const colDefs = ["title TEXT", ...properties.map((p) => `"${p.name.replace(/"/g, '""')}" TEXT`)]
  const colNames = ["title", ...properties.map((p) => `"${p.name.replace(/"/g, '""')}"`)].join(", ")

  const sqlStatements: string[] = [
    `-- Amby Notes SQLite Export for "${db?.title || defaultTitle}"`,
    `CREATE TABLE IF NOT EXISTS "${tableName}" (${colDefs.join(", ")});`,
    "BEGIN TRANSACTION;",
  ]

  for (const r of rows) {
    const values = [
      `'${r.title.replace(/'/g, "''")}'`,
      ...properties.map((p) => {
        const cell = readDatabaseCellValue(r.valuesJson, p.propertyId)
        const text = databaseCellText(cell, p.propertyType)
        return `'${text.replace(/'/g, "''")}'`
      }),
    ]
    sqlStatements.push(`INSERT INTO "${tableName}" (${colNames}) VALUES (${values.join(", ")});`)
  }

  sqlStatements.push("COMMIT;")
  const sql = sqlStatements.join("\n") + "\n"
  const safeName = (db?.title || defaultTitle).replace(/[/\\?%*:|"<>]/g, "-")
  await exportTextFile(sql, `${safeName}.sql`)
}

export async function exportSketchImage(format: "png" | "jpg", filename: string): Promise<boolean> {
  const canvas = document.querySelector(".excalidraw__canvas") as HTMLCanvasElement | null
  if (!canvas) return false

  if (format === "png") {
    canvas.toBlob((blob) => {
      if (blob) downloadBlob(blob, `${filename}.png`)
    }, "image/png")
    return true
  }

  const offscreen = document.createElement("canvas")
  offscreen.width = canvas.width
  offscreen.height = canvas.height
  const ctx = offscreen.getContext("2d")
  if (!ctx) return false
  ctx.fillStyle = "white"
  ctx.fillRect(0, 0, offscreen.width, offscreen.height)
  ctx.drawImage(canvas, 0, 0)
  offscreen.toBlob(
    (blob) => {
      if (blob) downloadBlob(blob, `${filename}.jpg`)
    },
    "image/jpeg",
    0.95,
  )
  return true
}

export async function exportCanvasImage(format: "png" | "jpg", filename: string): Promise<boolean> {
  const container = document.querySelector(".react-flow") as HTMLElement | null
  if (!container) return false

  const rect = container.getBoundingClientRect()
  const width = Math.max(rect.width, 600)
  const height = Math.max(rect.height, 400)

  const clone = container.cloneNode(true) as HTMLElement
  const controls = clone.querySelectorAll(
    ".select-none, [data-canvas-controls], button, [role='menu']",
  )
  controls.forEach((el) => el.remove())

  const wrapper = document.createElement("div")
  wrapper.setAttribute("xmlns", "http://www.w3.org/1999/xhtml")
  wrapper.style.width = `${width}px`
  wrapper.style.height = `${height}px`
  wrapper.appendChild(clone)

  const svgString = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <foreignObject width="100%" height="100%">
      ${new XMLSerializer().serializeToString(wrapper)}
    </foreignObject>
  </svg>`

  const img = new Image()
  const svgBlob = new Blob([svgString], { type: "image/svg+xml;charset=utf-8" })
  const url = URL.createObjectURL(svgBlob)

  return new Promise((resolve) => {
    img.onload = () => {
      const offscreen = document.createElement("canvas")
      const dpr = window.devicePixelRatio || 1
      offscreen.width = width * dpr
      offscreen.height = height * dpr
      const ctx = offscreen.getContext("2d")
      if (!ctx) {
        URL.revokeObjectURL(url)
        resolve(false)
        return
      }
      ctx.scale(dpr, dpr)
      if (format === "jpg") {
        ctx.fillStyle = "white"
        ctx.fillRect(0, 0, width, height)
      }
      ctx.drawImage(img, 0, 0)
      URL.revokeObjectURL(url)
      offscreen.toBlob(
        (blob) => {
          if (blob) downloadBlob(blob, `${filename}.${format}`)
          resolve(true)
        },
        format === "png" ? "image/png" : "image/jpeg",
        0.95,
      )
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      resolve(false)
    }
    img.src = url
  })
}

export async function exportActiveLayerImage(
  activeLayer: "canvas" | "sketch",
  format: "png" | "jpg",
  title = "export",
): Promise<void> {
  const safeName = title.replace(/[/\\?%*:|"<>]/g, "-") || "export"
  if (activeLayer === "sketch") {
    const ok = await exportSketchImage(format, safeName)
    if (ok) return
  }
  await exportCanvasImage(format, safeName)
}
