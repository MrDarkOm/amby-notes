export interface QuarantineRecord {
  moduleId: string
  failureCount: number
  lastError: string
  quarantinedAt?: number
}

const QUARANTINE_THRESHOLD = 3
const QUARANTINE_STORAGE_KEY = "amby:module-quarantine"
const SAFE_MODE_STORAGE_KEY = "amby:safe-mode"

const fallbackStorage = new Map<string, string>()

function getStorageItem(key: string): string | null {
  try {
    if (typeof localStorage !== "undefined") {
      return localStorage.getItem(key)
    }
  } catch {
    // ignore
  }
  return fallbackStorage.get(key) ?? null
}

function setStorageItem(key: string, value: string): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(key, value)
      return
    }
  } catch {
    // ignore
  }
  fallbackStorage.set(key, value)
}

export class QuarantineManager {
  private records = new Map<string, QuarantineRecord>()

  constructor() {
    this.loadFromStorage()
  }

  private loadFromStorage(): void {
    try {
      const raw = getStorageItem(QUARANTINE_STORAGE_KEY)
      if (raw) {
        const list: QuarantineRecord[] = JSON.parse(raw)
        for (const item of list) {
          this.records.set(item.moduleId, item)
        }
      }
    } catch {
      // Storage unavailable or invalid JSON
    }
  }

  private saveToStorage(): void {
    try {
      const list = Array.from(this.records.values())
      setStorageItem(QUARANTINE_STORAGE_KEY, JSON.stringify(list))
    } catch {
      // Storage unavailable
    }
  }

  recordFailure(moduleId: string, error: unknown): boolean {
    const existing = this.records.get(moduleId) ?? {
      moduleId,
      failureCount: 0,
      lastError: "",
    }
    const failureCount = existing.failureCount + 1
    const lastError = error instanceof Error ? error.message : String(error)
    const isNowQuarantined = failureCount >= QUARANTINE_THRESHOLD

    this.records.set(moduleId, {
      moduleId,
      failureCount,
      lastError,
      quarantinedAt: isNowQuarantined ? (existing.quarantinedAt ?? Date.now()) : undefined,
    })

    this.saveToStorage()

    if (isNowQuarantined) {
      console.warn(
        `Module "${moduleId}" has failed ${failureCount} times and has been placed in quarantine.`,
      )
    }

    return isNowQuarantined
  }

  isQuarantined(moduleId: string): boolean {
    const record = this.records.get(moduleId)
    return !!record && record.failureCount >= QUARANTINE_THRESHOLD
  }

  getQuarantinedModules(): QuarantineRecord[] {
    return Array.from(this.records.values()).filter((r) => r.failureCount >= QUARANTINE_THRESHOLD)
  }

  releaseFromQuarantine(moduleId: string): void {
    this.records.delete(moduleId)
    this.saveToStorage()
  }

  clear(): void {
    this.records.clear()
    this.saveToStorage()
  }
}

export class SafeModeState {
  private enabled = false

  constructor() {
    this.loadFromStorage()
  }

  private loadFromStorage(): void {
    try {
      const raw = getStorageItem(SAFE_MODE_STORAGE_KEY)
      if (raw) {
        this.enabled = JSON.parse(raw) === true
      }
    } catch {
      // Storage unavailable
    }
  }

  private saveToStorage(): void {
    try {
      setStorageItem(SAFE_MODE_STORAGE_KEY, JSON.stringify(this.enabled))
    } catch {
      // Storage unavailable
    }
  }

  isEnabled(): boolean {
    return this.enabled
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    this.saveToStorage()
  }
}

export const quarantineManager = new QuarantineManager()
export const safeModeState = new SafeModeState()
