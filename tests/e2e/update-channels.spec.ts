import { expect } from "@playwright/test"
import { localeResources } from "../../src/locales/resources"
import { seedVault, test } from "./support"

const updates = localeResources.ru.translation.settings.updates

test("update channel defaults to Stable and survives a browser reload", async ({ page }) => {
  await seedVault(page, { Note: "Text\n" })
  const openSettings = () => page.locator("[data-activity-button='settings']").first().click()
  await openSettings()
  const channel = page.getByRole("combobox", { name: updates.channel, exact: true })
  await expect(channel).toHaveText(updates.channelStable)
  await channel.click()
  await page.getByRole("option", { name: updates.channelBeta, exact: true }).click()
  await expect(page.getByText(updates.betaChannelHint, { exact: true })).toBeVisible()
  await page.reload()
  await openSettings()
  await expect(channel).toHaveText(updates.channelBeta)
  await channel.click()
  await page.getByRole("option", { name: updates.channelStable, exact: true }).click()
  await expect(page.getByText(updates.stableChannelHint, { exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: updates.checkAction, exact: true })).toBeDisabled()
})
