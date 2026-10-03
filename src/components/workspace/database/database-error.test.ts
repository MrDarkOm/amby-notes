import { describe, expect, it } from "vitest"
import i18n from "@/lib/i18n"
import { databaseErrorText } from "./database-error"

const t = i18n.t.bind(i18n)

describe("databaseErrorText", () => {
  it("explains a refusal because values exist, by what was being changed", () => {
    const backend = new Error(
      "Property type can only be changed after its existing values are cleared",
    )
    expect(databaseErrorText(backend, t, "type")).toMatch(/нет его значений/)
    expect(databaseErrorText(backend, t, "relation")).toMatch(
      /связанные страницы|связанных страниц/,
    )
    expect(
      databaseErrorText(
        new Error(
          "Date time and range settings can only change after the existing values are cleared",
        ),
        t,
        "date",
      ),
    ).toMatch(/Хранение времени/)
  })

  it("explains a conflict and a dependency, and shows anything else as it is", () => {
    expect(databaseErrorText(new Error("Manifest revision conflict"), t, "type")).toMatch(
      /изменилась в другом месте/,
    )
    expect(
      databaseErrorText(
        new Error("Property type cannot be changed while another property depends on it"),
        t,
        "type",
      ),
    ).toMatch(/формулы или сводки/)
    expect(databaseErrorText(new Error("Disk is full"), t, "type")).toBe("Disk is full")
    expect(databaseErrorText("plain text", t, "type")).toBe("plain text")
  })
})
