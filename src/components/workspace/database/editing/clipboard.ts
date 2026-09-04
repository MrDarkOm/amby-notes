export interface PasteColumn {
  propertyId: string
  parse: (text: string) => string | null
}

export interface PasteCell {
  rowOffset: number
  columnOffset: number
  propertyId: string
  valueJson: string
}

export interface PastePreflight {
  cells: PasteCell[]
  errors: string[]
}

export function parseTsvRectangle(input: string): string[][] {
  const normalized = input.replace(/\r\n?/gu, "\n")
  const lines = normalized.endsWith("\n")
    ? normalized.slice(0, -1).split("\n")
    : normalized.split("\n")
  return lines.map((line) => line.split("\t"))
}

/** Validates the whole rectangle before returning any mutation payload. */
export function preflightTsvPaste(input: string, columns: PasteColumn[]): PastePreflight {
  const cells: PasteCell[] = []
  const errors: string[] = []
  for (const [rowOffset, row] of parseTsvRectangle(input).entries()) {
    if (row.length > columns.length) {
      errors.push(`row ${rowOffset + 1} has too many cells`)
      continue
    }
    for (const [columnOffset, text] of row.entries()) {
      const column = columns[columnOffset]
      const valueJson = column.parse(text)
      if (valueJson === null) {
        errors.push(`row ${rowOffset + 1}, column ${columnOffset + 1} is invalid`)
        continue
      }
      cells.push({ rowOffset, columnOffset, propertyId: column.propertyId, valueJson })
    }
  }
  return errors.length > 0 ? { cells: [], errors } : { cells, errors }
}
