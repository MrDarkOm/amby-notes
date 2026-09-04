export interface DatabaseLinkedReference {
  databaseId: string
  viewId: string
  filter?: unknown
  layout?: string
}

export interface ParsedDatabaseLinkedReference {
  value: DatabaseLinkedReference
  raw: string
}

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/u

/** Parses only the new portable reference shape; legacy sidecar IDs stay opaque. */
export function parseDatabaseLinkedReference(raw: string): ParsedDatabaseLinkedReference | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (!value || typeof value !== "object") return null
  const reference = value as Partial<DatabaseLinkedReference>
  if (
    typeof reference.databaseId !== "string" ||
    typeof reference.viewId !== "string" ||
    !ULID.test(reference.databaseId) ||
    !ULID.test(reference.viewId)
  ) {
    return null
  }
  if (reference.layout !== undefined && typeof reference.layout !== "string") return null
  return { value: reference as DatabaseLinkedReference, raw }
}

/** Keeps original fence bytes available for byte-exact unrelated editor saves. */
export function serializeDatabaseLinkedReference(
  parsed: ParsedDatabaseLinkedReference,
  next?: Partial<DatabaseLinkedReference>,
): string {
  if (!next) return parsed.raw
  return JSON.stringify({ ...parsed.value, ...next })
}
