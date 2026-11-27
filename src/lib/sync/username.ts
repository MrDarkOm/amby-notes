/** Folds only ASCII uppercase letters; validation owns trimming and grammar checks. */
export function normalizeSyncUsername(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => letter.toLowerCase())
}
