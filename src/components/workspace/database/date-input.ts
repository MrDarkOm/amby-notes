const pad = (value: number) => String(value).padStart(2, "0")

/** The value of the browser's date or date-time field for a stored date. */
export function dateInputValue(start: string, includeTime: boolean): string {
  if (!includeTime) return /^\d{4}-\d{2}-\d{2}/.test(start) ? start.slice(0, 10) : ""
  const dateOnly = /^(\d{4}-\d{2}-\d{2})$/.exec(start)
  if (dateOnly) return `${dateOnly[1]}T00:00`
  const date = new Date(start)
  if (Number.isNaN(date.getTime())) return ""
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** The stored date for what the date field holds: a UTC instant when a time is kept. */
export function storedDate(input: string, includeTime: boolean): string | null {
  if (!input) return null
  if (!includeTime) return input
  const date = new Date(input)
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString().replace(/\.\d{3}Z$/, "Z")
}
