import { expect } from "@playwright/test"
import { openNote, seedVault, test } from "./support"

test("AI panel selects and removes note context in a browser workspace", async ({ page }) => {
  await seedVault(page, { First: "# First\n\nSome text.", Second: "# Second\n\nAnother note." })
  await openNote(page, "First")
  await page.locator('[data-activity-button="ai"]').click()
  await expect(page.getByRole("button", { name: "Убрать заметку из контекста" })).toBeVisible()
  const composer = page.getByPlaceholder("Сообщение…")
  await composer.fill("Compare @Sec")
  const picker = page.getByRole("listbox", { name: "Добавить заметку или папку" })
  await expect(picker.getByRole("option", { name: /Second/ })).toBeVisible()
  await picker.getByRole("option", { name: /Second/ }).click()
  await expect(composer).toHaveValue("Compare ")
  await expect(page.locator("[data-context-group]")).toBeVisible()
  await page.locator("[data-context-group]").hover()
  const attached = page.getByRole("list", { name: "Прикреплённые заметки" })
  await expect(attached.getByRole("button", { name: "Убрать заметку из контекста" })).toHaveCount(2)
  await attached.getByRole("button", { name: "Убрать заметку из контекста" }).first().click()
  await page.mouse.move(5, 5)
  await expect(page.getByRole("button", { name: "Добавить текущую заметку" })).toBeVisible()
  await page.getByRole("button", { name: "Добавить текущую заметку" }).click()
  await expect(page.locator("[data-context-group]")).toBeVisible()
})

test("the list of attached notes opens inside the AI panel, not past its edge", async ({
  page,
}) => {
  await seedVault(page, { First: "# First\n\nSome text.", Second: "# Second\n\nAnother note." })
  await openNote(page, "First")
  await page.locator('[data-activity-button="ai"]').click()
  const composer = page.getByPlaceholder("Сообщение…")
  await composer.fill("Compare @Sec")
  await page
    .getByRole("listbox", { name: "Добавить заметку или папку" })
    .getByRole("option", { name: /Second/ })
    .click()
  const group = page.locator("[data-context-group]")
  await expect(group).toBeVisible()
  await group.hover()
  const list = page.getByRole("list", { name: "Прикреплённые заметки" })
  await expect(list).toBeVisible()
  await page.waitForTimeout(400)
  const panel = (await page.locator("[data-composer-line]").locator("xpath=..").boundingBox())!
  const box = (await list.locator("xpath=ancestor::*[@data-popover-content]").boundingBox())!
  expect(box.x).toBeGreaterThanOrEqual(panel.x - 1)
  expect(box.x + box.width).toBeLessThanOrEqual(panel.x + panel.width + 1)
  await expect(list.getByRole("button", { name: "Убрать заметку из контекста" })).toHaveCount(2)
})

test("the AI settings icon opens Settings on the AI module, where the models are managed", async ({
  page,
}) => {
  await seedVault(page, { First: "# First\n\nSome text." })
  await openNote(page, "First")
  await page.locator('[data-activity-button="ai"]').click()
  await expect(page.getByRole("button", { name: "Добавить модель" })).toHaveCount(0)
  await page.getByRole("button", { name: "Настройки ИИ" }).click()
  await expect(page.getByRole("button", { name: "Добавить модель" })).toBeVisible()
})

test("connection cards retain model choices in a narrow browser window", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 800 })
  await page.addInitScript(() => {
    if (localStorage.getItem("amby:e2e-ai-seeded")) return
    localStorage.setItem("amby:e2e-ai-seeded", "1")
    localStorage.setItem(
      "amby:g:settings.json",
      JSON.stringify({
        ai: {
          version: 1,
          activeModelId: "one",
          connections: [
            {
              id: "c1",
              provider: "openai",
              method: "api",
              label: "Account one",
              baseUrl: "",
              credentialId: "k1",
              apiVersion: "",
              catalogUpdatedAt: "2026-10-31T00:00:00Z",
            },
            {
              id: "c2",
              provider: "openai",
              method: "api",
              label: "Account two",
              baseUrl: "",
              credentialId: "k2",
              apiVersion: "",
              catalogUpdatedAt: "2026-10-31T00:00:00Z",
            },
          ],
          models: [
            {
              id: "one",
              connectionId: "c1",
              model: "gpt-a",
              label: "Model A",
              enabled: true,
              available: true,
              origin: "catalog",
            },
            {
              id: "two",
              connectionId: "c2",
              model: "gpt-b",
              label: "Model B",
              enabled: false,
              available: true,
              origin: "catalog",
            },
          ],
        },
      }),
    )
  })
  await seedVault(page, { First: "# First\n\nSome text." })
  await openNote(page, "First")
  await page.locator('[data-activity-button="ai"]').click()
  await page.getByRole("button", { name: "Настройки ИИ" }).click()
  await page.setViewportSize({ width: 800, height: 700 })
  await expect(page.getByRole("button", { name: /Account one/ })).toBeVisible()
  await expect(page.getByRole("button", { name: /Account two/ })).toBeVisible()
  const toggle = page.getByRole("switch", { name: "Включить модель Model B" })
  await toggle.click()
  await expect(toggle).toBeChecked()
  await expect
    .poll(() =>
      page.evaluate(
        () => JSON.parse(localStorage.getItem("amby:g:settings.json")!).ai.models[1].enabled,
      ),
    )
    .toBe(true)
  await page.setViewportSize({ width: 1200, height: 800 })
  await page.reload()
  const showRight = page.getByRole("button", { name: "Показать правую панель" })
  if (await showRight.isVisible()) await showRight.click()
  const settingsButton = page.getByRole("button", { name: "Настройки ИИ" })
  if (!(await settingsButton.isVisible())) await page.locator('[data-activity-button="ai"]').click()
  await settingsButton.click()
  await expect(page.getByRole("switch", { name: "Включить модель Model B" })).toBeChecked()
})
