import { describe, expect, it } from "vitest"
import config from "../../src-tauri/tauri.conf.json"

function directives(policy: string): Map<string, string[]> {
  return new Map(
    policy
      .split(";")
      .map((part) => part.trim().split(/\s+/u))
      .filter((parts) => parts[0])
      .map(([name, ...sources]) => [name, sources]),
  )
}

describe("content security policy", () => {
  const policy = directives(config.app.security.csp)

  // Audio and video in notes are played from the vault through the asset protocol. They
  // need no directive of their own: `media-src` falls back to `default-src`, and that must
  // stay limited to the app itself and the local file protocol. A note can never make the
  // webview fetch a remote file, frame a page or load a plug-in.
  it("lets media come only from the app and the local asset protocol", () => {
    expect(policy.has("media-src")).toBe(false)
    expect([...(policy.get("default-src") ?? [])].sort()).toEqual(
      ["'self'", "asset:", "https://asset.localhost"].sort(),
    )
  })

  it("allows no frames, plug-ins or remote connections", () => {
    for (const name of ["frame-src", "child-src", "object-src"])
      expect(policy.has(name)).toBe(false)
    expect(policy.get("connect-src")).toEqual(["'self'"])
    expect(policy.get("script-src")).toEqual(["'self'"])
  })
})
