import { describe, expect, it } from "vitest"
import i18n from "@/lib/i18n"
import { databaseFailure } from "@/lib/test-utils/errors"
import { databaseErrorText } from "./database-error"

const t = i18n.t.bind(i18n)

describe("databaseErrorText", () => {
  it("explains a refusal because values exist, by what was being changed", () => {
    const backend = databaseFailure("values_not_empty")
    expect(databaseErrorText(backend, t, "type")).toMatch(/нет его значений/)
    expect(databaseErrorText(backend, t, "relation")).toMatch(
      /связанные страницы|связанных страниц/,
    )
    expect(databaseErrorText(backend, t, "date")).toMatch(/Хранение времени/)
  })

  it("explains a conflict and a dependency by the reason, not by the sentence", () => {
    expect(databaseErrorText(databaseFailure("revision_conflict"), t, "type")).toMatch(
      /изменилась в другом месте/,
    )
    expect(databaseErrorText(databaseFailure("has_dependents"), t, "type")).toMatch(
      /формулы или сводки/,
    )
  })

  it("does not recognise a sentence: only the reason counts", () => {
    const text = databaseErrorText(new Error("Manifest revision conflict"), t, "type")
    expect(text).not.toMatch(/изменилась в другом месте/)
    expect(text).not.toContain("Manifest")
  })

  it("never shows an unexplained backend sentence", () => {
    expect(databaseErrorText(new Error("Disk is full"), t, "type")).not.toContain("Disk is full")
    expect(databaseErrorText("plain text", t, "type")).not.toContain("plain text")
  })
})
