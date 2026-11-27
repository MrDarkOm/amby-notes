// Where a version can be downloaded by hand when the updater could not install it: its release on
// GitHub, found by the tag the release workflow gives it (`v` + the version). Written before the code.
import { describe, expect, it } from "vitest"
import { releasePageUrl } from "./app-release-page"

describe("the release page of a version", () => {
  it("is the GitHub release of its tag, for a beta and for a final version", () => {
    expect(releasePageUrl("0.1.9-beta.6")).toBe(
      "https://github.com/MrDarkOm/amby-notes/releases/tag/v0.1.9-beta.6",
    )
    expect(releasePageUrl("0.1.9")).toBe(
      "https://github.com/MrDarkOm/amby-notes/releases/tag/v0.1.9",
    )
  })

  it("accepts a version already written with its v", () => {
    expect(releasePageUrl("v0.2.0")).toBe(
      "https://github.com/MrDarkOm/amby-notes/releases/tag/v0.2.0",
    )
  })

  it("falls back to the list of releases for anything that is not a version", () => {
    for (const odd of ["", "../../evil", "0.1.9?x=1", "latest"]) {
      expect(releasePageUrl(odd)).toBe("https://github.com/MrDarkOm/amby-notes/releases")
    }
  })
})
