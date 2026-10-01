import { describe, expect, it } from "vitest"
import corpus from "../../../../tests/fixtures/package-versions.json"
import {
  compareSemver,
  validateApiCompatibility,
  validateDependencies,
  validateManifest,
} from "./validator"
import type { PackageManifest } from "./types"

const manifestBase: PackageManifest = {
  formatVersion: 1,
  id: "test.package",
  name: "Test package",
  version: "1.0.0",
  publisher: "Amby",
  kind: "community",
  minAppVersion: "0.1.5",
  entry: "index.js",
  permissions: [],
  checksums: { "index.js": "00" },
  signature: { keyId: "community", sig: "unsigned" },
}

describe("package SemVer contract", () => {
  it("shares portable module ID rules with the backend", () => {
    for (const id of corpus.validModuleIds) {
      expect(validateManifest({ ...manifestBase, id }).valid, id).toBe(true)
      expect(validateManifest({ ...manifestBase, dependencies: { [id]: "1.0.0" } }).valid, id).toBe(
        true,
      )
    }
    for (const id of corpus.invalidModuleIds) {
      expect(validateManifest({ ...manifestBase, id }).valid, id).toBe(false)
      expect(validateManifest({ ...manifestBase, dependencies: { [id]: "1.0.0" } }).valid, id).toBe(
        false,
      )
    }
  })

  it("does not treat prototype properties as installed dependencies", () => {
    for (const id of ["toString", "constructor"]) {
      const manifest = { ...manifestBase, dependencies: { [id]: "1.0.0" } }
      expect(validateDependencies(manifest, {}).satisfied).toBe(false)
      expect(validateDependencies(manifest, { [id]: { activeVersion: "1.0.0" } }).satisfied).toBe(
        true,
      )
    }
  })

  it("accepts and rejects the shared strict-version corpus", () => {
    for (const version of corpus.validVersions) {
      expect(compareSemver(version, version)).toBe(0)
    }
    for (const version of corpus.invalidVersions) {
      expect(() => compareSemver(version, "1.0.0")).toThrow(/Invalid version/)
    }
  })

  it("orders prereleases and ignores build metadata", () => {
    for (const comparison of corpus.comparisons) {
      expect(compareSemver(comparison.left, comparison.right)).toBe(comparison.order)
    }
  })

  it("keeps exact dependency strings as minimum versions", () => {
    for (const requirement of corpus.minimumRequirements) {
      const manifest = { ...manifestBase, dependencies: { "dep.module": requirement.requirement } }
      for (const version of requirement.satisfiedBy) {
        expect(
          validateDependencies(manifest, { "dep.module": { activeVersion: version } }).satisfied,
        ).toBe(true)
      }
      for (const version of requirement.rejectedBy) {
        expect(
          validateDependencies(manifest, { "dep.module": { activeVersion: version } }).satisfied,
        ).toBe(false)
      }
    }
  })

  it("supports shared explicit ranges and rejects ambiguous requirements", () => {
    for (const requirement of corpus.ranges) {
      const manifest = { ...manifestBase, dependencies: { "dep.module": requirement.requirement } }
      for (const version of requirement.satisfiedBy) {
        expect(
          validateDependencies(manifest, { "dep.module": { activeVersion: version } }).satisfied,
        ).toBe(true)
      }
      for (const version of requirement.rejectedBy) {
        expect(
          validateDependencies(manifest, { "dep.module": { activeVersion: version } }).satisfied,
        ).toBe(false)
      }
    }

    for (const requirement of [...corpus.invalidRequirements, "not-a-range"]) {
      const invalid = { ...manifestBase, dependencies: { "dep.module": requirement } }
      expect(validateManifest(invalid).valid, requirement).toBe(false)
    }
  })

  it("validates manifest app bounds with strict SemVer", () => {
    expect(
      validateManifest({ ...manifestBase, version: "1.0.0-beta.1", minAppVersion: "0.1.5" }).valid,
    ).toBe(true)
    expect(
      validateManifest({ ...manifestBase, minAppVersion: "1.0.0", maxAppVersion: "0.9.0" }).valid,
    ).toBe(false)
    expect(
      validateApiCompatibility(
        { ...manifestBase, minAppVersion: "1.0.0-beta.1", maxAppVersion: "1.0.0" },
        "1.0.0-beta.2",
      ).compatible,
    ).toBe(true)
    expect(validateApiCompatibility(manifestBase, "not-a-version").compatible).toBe(false)
    const builds = { ...manifestBase, minAppVersion: "0.1.5+zzz", maxAppVersion: "0.1.5+aaa" }
    expect(validateManifest(builds).valid).toBe(true)
    expect(validateApiCompatibility(builds, "0.1.5").compatible).toBe(true)
    expect(
      validateApiCompatibility({ ...manifestBase, maxAppVersion: "" }, "0.1.5").compatible,
    ).toBe(false)
  })
})
