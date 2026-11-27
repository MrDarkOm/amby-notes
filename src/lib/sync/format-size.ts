// Sizes of the plans and of the storages in decimal units, like Finder (docs/sync-plan.md,
// appendix Е, У2): 1 KB is 1000 bytes, never 1024.

const UNITS: Record<"ru" | "en", string[]> = {
  ru: ["Б", "КБ", "МБ", "ГБ", "ТБ"],
  en: ["B", "KB", "MB", "GB", "TB"],
}

/**
 * Bytes as a person reads them: under 1000 as "950 B"; from there the largest unit that keeps the
 * number at least 1 (KB, MB, GB, TB), one decimal while the number is under 10 (a trailing ".0" is
 * dropped), none from 10 up, rounded to the nearest. The decimal separator and the names of the
 * units follow `language` ("1,5 МБ" in Russian, "1.5 MB" in English).
 */
export function formatSize(bytes: number, language: string): string {
  const units = language.toLowerCase().startsWith("ru") ? UNITS.ru : UNITS.en
  const separator = language.toLowerCase().startsWith("ru") ? "," : "."
  const whole = Math.max(0, Math.round(bytes))
  if (whole < 1000) return `${whole} ${units[0]}`
  let unit = 1
  let value = whole / 1000
  const round = (number: number) =>
    number < 10 ? Math.round(number * 10) / 10 : Math.round(number)
  while (unit < units.length - 1 && (value >= 1000 || round(value) >= 1000)) {
    value /= 1000
    unit += 1
  }
  const rounded = round(value)
  const text = Number.isInteger(rounded)
    ? String(rounded)
    : rounded.toFixed(1).replace(".", separator)
  return `${text} ${units[unit]}`
}
