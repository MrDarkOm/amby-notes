// @vitest-environment happy-dom
import * as React from "react"
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import i18n from "@/lib/i18n"
import type { PasswordCheck } from "@/lib/sync/sync-port"
import { NewPasswordFields } from "./password-fields"
import { createFakePort } from "./fake-sync-port"

function verdict(patch: Partial<PasswordCheck>): PasswordCheck {
  return {
    ok: false,
    score: 3,
    length: 14,
    minLength: 12,
    tooShort: false,
    missing: [],
    ...patch,
  }
}

function Harness({ check, labels }: { check: PasswordCheck; labels: [string, string] }) {
  const [password, setPassword] = React.useState("")
  const [repeat, setRepeat] = React.useState("")
  const port = React.useMemo(() => createFakePort({ checkPassword: async () => check }), [check])
  return (
    <NewPasswordFields
      port={port}
      username="alice"
      passwordLabel={labels[0]}
      repeatLabel={labels[1]}
      password={password}
      repeat={repeat}
      onPasswordChange={setPassword}
      onRepeatChange={setRepeat}
      onValidChange={() => {}}
    />
  )
}

async function hintFor(check: PasswordCheck, language = "ru") {
  await i18n.changeLanguage(language)
  const labels: [string, string] =
    language === "ru" ? ["Новый пароль", "Повторите"] : ["New password", "Repeat"]
  render(<Harness check={check} labels={labels} />)
  fireEvent.change(screen.getByLabelText(labels[0]), { target: { value: "x" } })
  const box = await screen.findByTestId("password-strength")
  return box
}

describe("the one-line hint under a new password", () => {
  afterEach(async () => {
    cleanup()
    await i18n.changeLanguage("ru")
  })

  it("lists what is missing, only that, in a fixed wording", async () => {
    const box = await hintFor(
      verdict({ missing: ["length", "uppercase", "digit", "symbol"], tooShort: true }),
    )
    expect(box.textContent).toBe("Нужно: не короче 12 символов, заглавная буква, цифра, спецсимвол")
  })

  it("names a single missing item", async () => {
    const box = await hintFor(verdict({ missing: ["lowercase"] }))
    expect(box.textContent).toBe("Нужно: строчная буква")
  })

  it("says the password is too simple or known when nothing is missing but the score is low", async () => {
    const box = await hintFor(verdict({ score: 2 }))
    expect(box.textContent).toBe("Слишком простой или известный пароль")
  })

  it("says good or great by the score when the password is accepted", async () => {
    expect((await hintFor(verdict({ ok: true, score: 3 }))).textContent).toBe("Хороший пароль")
    cleanup()
    expect((await hintFor(verdict({ ok: true, score: 4 }))).textContent).toBe("Отличный пароль")
  })

  it("is one line, red until accepted and muted afterwards", async () => {
    const bad = await hintFor(verdict({ missing: ["digit"] }))
    expect(bad.querySelectorAll("p")).toHaveLength(1)
    expect(bad.querySelector("p")?.className).toContain("text-destructive")
    cleanup()
    const good = await hintFor(verdict({ ok: true, score: 4 }))
    expect(good.querySelectorAll("p")).toHaveLength(1)
    expect(good.querySelector("p")?.className).toContain("text-muted-foreground")
  })

  it("has the wording in English", async () => {
    expect(
      (
        await hintFor(
          verdict({ missing: ["length", "uppercase", "digit", "symbol"], tooShort: true }),
          "en",
        )
      ).textContent,
    ).toBe("Needs: at least 12 characters, an uppercase letter, a digit, a symbol")
    cleanup()
    expect((await hintFor(verdict({ score: 1 }), "en")).textContent).toBe(
      "Too simple or too common",
    )
    cleanup()
    expect((await hintFor(verdict({ ok: true, score: 4 }), "en")).textContent).toBe(
      "Excellent password",
    )
  })
})
