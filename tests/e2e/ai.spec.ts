import { expect } from "@playwright/test"
import { openNote, seedVault, test } from "./support"

test("AI panel selects and removes note context in a browser workspace", async ({ page }) => {
  await seedVault(page, { First: "# First\n\nSome text.", Second: "# Second\n\nAnother note." })
  await openNote(page, "First")
  await page.locator('[data-activity-button="ai"]').click()
  await expect(page.getByText("Контекст:")).toBeVisible()
  await expect(page.getByRole("button", { name: "Убрать заметку из контекста" })).toBeVisible()
  const composer = page.getByPlaceholder("Сообщение…")
  await composer.fill("Compare @Sec")
  const picker = page.getByRole("listbox", { name: "Добавить заметку или папку" })
  await expect(picker.getByRole("option", { name: /Second/ })).toBeVisible()
  await picker.getByRole("option", { name: /Second/ }).click()
  await expect(composer).toHaveValue("Compare ")
  await expect(page.getByRole("button", { name: "Убрать заметку из контекста" })).toHaveCount(2)
  await page.getByRole("button", { name: "Убрать заметку из контекста" }).first().click()
  await expect(page.getByRole("button", { name: "Добавить текущую заметку" })).toBeVisible()
  await page.getByRole("button", { name: "Добавить текущую заметку" }).click()
  await expect(page.getByRole("button", { name: "Убрать заметку из контекста" })).toHaveCount(2)
})
