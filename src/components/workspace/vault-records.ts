import type { VaultRecord } from "./workspace-picker"

/** Compare ordinary and verbatim Windows paths without changing POSIX case rules. */
export function vaultPathKey(path: string): string {
  let normalized = path.replace(/\\/gu, "/").replace(/\/+$/u, "")
  if (/^\/\/\?\/unc\//iu.test(normalized)) normalized = `//${normalized.slice(8)}`
  else if (/^\/\/\?\//u.test(normalized)) normalized = normalized.slice(4)
  return /^(?:[a-z]:\/|\/\/)/iu.test(normalized) ? normalized.toLowerCase() : normalized
}

export function reconcileVaultRecord(records: VaultRecord[], path: string): VaultRecord[] {
  const key = vaultPathKey(path)
  const existing = records.find((record) => vaultPathKey(record.path) === key)
  if (existing)
    return records
      .filter((record) => record === existing || vaultPathKey(record.path) !== key)
      .map((record) => (record === existing ? { ...record, path } : record))
  const name = path.replace(/\\/gu, "/").replace(/\/+$/u, "").split("/").pop() ?? path
  return [...records, { id: crypto.randomUUID(), name, path }]
}

export function deduplicateVaultRecords(records: VaultRecord[]): VaultRecord[] {
  return records.reduceRight<VaultRecord[]>((result, record) => {
    if (result.some((item) => vaultPathKey(item.path) === vaultPathKey(record.path))) return result
    result.unshift(record)
    return result
  }, [])
}
