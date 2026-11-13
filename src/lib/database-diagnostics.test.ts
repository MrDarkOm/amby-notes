import { describe, expect, it } from "vitest"
import i18n from "@/lib/i18n"
import { databaseDiagnosticText } from "./database-errors"

describe("text of a remark about a database (docs/notices.md §10)", () => {
  it.each([
    "BrokenManifest",
    "UnsupportedManifest",
    "InvalidManifest",
    "DuplicateDatabaseId",
    "DuplicateDatabaseTitle",
    "BrokenNote",
    "InvalidNoteId",
    "DuplicateNoteId",
    "DuplicateNoteTitle",
    "BrokenShard",
    "OrphanShard",
    "MissingShard",
    "DatabaseIdMismatch",
    "InvalidShardFilename",
    "SymlinkEscape",
    "NestedBoundary",
  ])("has a text for %s in both languages", (code) => {
    for (const language of ["ru", "en"]) {
      const text = databaseDiagnosticText(code, i18n.getFixedT(language))
      expect(text).not.toContain("databaseErrors.diagnostic")
      expect(text).not.toContain(code)
    }
  })

  it("gives the general text and the code for a code it does not know", () => {
    expect(databaseDiagnosticText("FutureThing", i18n.getFixedT("en"))).toContain("FutureThing")
  })
})
