import { describe, expect, it } from "vitest"
import i18n from "@/lib/i18n"
import { recoveryFileText } from "./recovery-file"

const context = {
  host: "sync.example.com",
  username: "alice",
  recoveryCode: "1111-2222-3333-4444-5555-6666-7777-8888-9999-AAAA-BBBB-CCCC-DDDD-EEEE",
}

describe("the recovery code file", () => {
  it("holds the code, the server, the name and the honest warning", async () => {
    await i18n.changeLanguage("ru")
    const text = recoveryFileText(context, i18n.t.bind(i18n))
    expect(text).toContain(context.recoveryCode)
    expect(text).toContain("sync.example.com")
    expect(text).toContain("alice")
    // О3: nobody can bring the data back without the password or the code
    expect(text).toMatch(/не вернёт никто/)
  })

  it("is written in the language of the interface", async () => {
    await i18n.changeLanguage("en")
    const text = recoveryFileText(context, i18n.t.bind(i18n))
    expect(text).toContain(context.recoveryCode)
    expect(text).toMatch(/nobody can bring/i)
    await i18n.changeLanguage("ru")
  })

  it("asks to keep the file away from the synchronised vault", async () => {
    await i18n.changeLanguage("ru")
    expect(recoveryFileText(context, i18n.t.bind(i18n))).toMatch(/хранилищ/)
  })
})
