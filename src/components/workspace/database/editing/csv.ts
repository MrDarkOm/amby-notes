export interface CsvImportColumn {
  sourceIndex: number
  propertyId?: string
}

export interface CsvImportRow {
  title: string
  values: Record<string, string>
}

export function parseCsv(input: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ""
  let quoted = false
  for (let index = 0; index < input.length; index++) {
    const character = input[index]
    if (quoted) {
      if (character === '"' && input[index + 1] === '"') {
        cell += '"'
        index++
      } else if (character === '"') {
        quoted = false
      } else {
        cell += character
      }
    } else if (character === '"' && cell.length === 0) {
      quoted = true
    } else if (character === ",") {
      row.push(cell)
      cell = ""
    } else if (character === "\n") {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ""
    } else if (character !== "\r") {
      cell += character
    }
  }
  if (quoted) throw new Error("CSV contains an unterminated quoted field")
  if (cell.length > 0 || row.length > 0 || input.endsWith(",")) {
    row.push(cell)
    rows.push(row)
  }
  return rows.filter((candidate) => candidate.some((value) => value.length > 0))
}

/** v1 deliberately plans creates only; no title lookup or update mode exists. */
export function planCsvCreates(
  input: string,
  titleColumn: number,
  columns: CsvImportColumn[],
): CsvImportRow[] {
  return parseCsv(input)
    .slice(1)
    .map((row, rowIndex) => {
      const title = row[titleColumn]?.trim() ?? ""
      if (!title) throw new Error(`CSV row ${rowIndex + 2} has no title`)
      const values: Record<string, string> = {}
      for (const column of columns) {
        if (!column.propertyId || column.sourceIndex === titleColumn) continue
        const value = row[column.sourceIndex] ?? ""
        if (value.length > 0) values[column.propertyId] = value
      }
      return { title, values }
    })
}

export function serializeCsv(rows: string[][]): string {
  return rows
    .map((row) =>
      row
        .map((value) => {
          const text = String(value)
          return /[",\n\r]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text
        })
        .join(","),
    )
    .join("\n")
}
