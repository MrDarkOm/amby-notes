import { describe, expect, it } from "vitest"
import {
  applyProfileWithOfflineFallback,
  createProfileSnapshot,
  formatByteSize,
  PROFILES,
  STANDARD_CATALOG_REVISION,
  STANDARD_MODULES,
  STANDARD_PROFILE_VERSION,
  verifyProfileSignature,
} from "./profiles"

describe("MOD-03: Profiles", () => {
  it("defines minimal profile with zero downloads and empty modules", () => {
    const minimal = PROFILES.minimal
    expect(minimal.id).toBe("minimal")
    expect(minimal.defaultModules).toEqual([])
    expect(minimal.metadata.estimatedDownloadSizeBytes).toBe(0)
    expect(minimal.metadata.estimatedInstalledSizeBytes).toBe(0)
    expect(minimal.metadata.permissions).toEqual([])
  })

  it("defines standard profile with version, signed metadata and standard modules", () => {
    const standard = PROFILES.standard
    expect(standard.id).toBe("standard")
    expect(standard.metadata.version).toBe(STANDARD_PROFILE_VERSION)
    expect(standard.metadata.catalogRevision).toBe(STANDARD_CATALOG_REVISION)
    expect(standard.defaultModules).toEqual(STANDARD_MODULES)
    expect(standard.metadata.estimatedDownloadSizeBytes).toBeGreaterThan(0)
    expect(standard.metadata.estimatedInstalledSizeBytes).toBeGreaterThan(0)
    expect(standard.metadata.permissions).toContain("vault.read")
    expect(standard.metadata.permissions).toContain("vault.write")
    expect(verifyProfileSignature(standard)).toBe(true)
  })

  it("creates a frozen snapshot of the applied profile", () => {
    const snapshot = createProfileSnapshot("standard", STANDARD_MODULES)
    expect(snapshot.version).toBe(STANDARD_PROFILE_VERSION)
    expect(snapshot.catalogRevision).toBe(STANDARD_CATALOG_REVISION)
    expect(snapshot.modules).toEqual(STANDARD_MODULES)
    expect(snapshot.appliedAt).toBeDefined()
    expect(new Date(snapshot.appliedAt).getTime()).not.toBeNaN()
    expect(snapshot.signature?.keyId).toBe("amby-official-2026")
  })

  it("handles online profile application without fallback", () => {
    const result = applyProfileWithOfflineFallback("standard", {}, { isOnline: true })
    expect(result.offlineFallback).toBe(false)
    expect(result.missingModules).toEqual([])
    expect(result.config.enabledModules).toEqual(STANDARD_MODULES)
    expect(result.config.profile.id).toBe("standard")
    expect(result.config.profile.snapshot?.modules).toEqual(STANDARD_MODULES)
  })

  it("handles offline profile application with fallback when modules are missing", () => {
    const available = ["amby.tags", "amby.favorites"]
    const result = applyProfileWithOfflineFallback(
      "standard",
      {},
      { isOnline: false, availableModuleIds: available },
    )
    expect(result.offlineFallback).toBe(true)
    expect(result.missingModules.length).toBeGreaterThan(0)
    // Only available modules are enabled
    expect(result.config.enabledModules).toEqual(available)
    expect(result.config.profile.snapshot?.modules).toEqual(available)
  })

  it("applies minimal profile offline without fallback", () => {
    const result = applyProfileWithOfflineFallback("minimal", {}, { isOnline: false })
    expect(result.offlineFallback).toBe(false)
    expect(result.missingModules).toEqual([])
    expect(result.config.enabledModules).toEqual([])
  })

  it("formats byte sizes accurately", () => {
    expect(formatByteSize(0)).toBe("0 B")
    expect(formatByteSize(500)).toBe("500 B")
    expect(formatByteSize(1024)).toBe("1.0 KB")
    expect(formatByteSize(1024 * 1024 * 4.5)).toBe("4.5 MB")
  })
})
