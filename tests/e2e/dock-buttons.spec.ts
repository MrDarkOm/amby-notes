import { expect, type Page } from "@playwright/test"
import { localeResources } from "../../src/locales/resources"
import { seedVault, test } from "./support"

const ru = localeResources.ru.translation

const dock = (page: Page) => page.locator("[data-activity-bar='left']").first()
const zone = (page: Page, name: "view" | "action") =>
  dock(page).locator(`div[data-activity-zone='${name}']`)
const dockButton = (page: Page, id: string) => dock(page).locator(`[data-activity-button='${id}']`)
const toggle = (page: Page, id: string) => page.locator(`[data-dock-toggle='${id}']`)

/** Right click on the empty part of a zone, below its last button. */
async function openZoneMenu(page: Page, name: "view" | "action") {
  const box = (await zone(page, name).boundingBox())!
  await page.mouse.click(box.x + box.width / 2, box.y + box.height - 3, { button: "right" })
}

test("each dock zone switches off only its own buttons, never settings", async ({ page }) => {
  await seedVault(page, { Note: "Text\n" })
  await expect(dockButton(page, "tags")).toBeVisible()

  // The upper zone lists the section buttons only.
  await openZoneMenu(page, "view")
  await expect(page.getByText(ru.activityBar.zoneSections)).toBeVisible()
  await expect(toggle(page, "tags")).toBeVisible()
  await expect(toggle(page, "settings")).toHaveCount(0)
  await expect(toggle(page, "search")).toHaveCount(0)
  await toggle(page, "tags").click()
  // The menu stays open for the next switch.
  await expect(toggle(page, "tags")).toHaveAttribute("aria-checked", "false")
  // The focused item is shown by its background, without the browser's blue ring.
  expect(await toggle(page, "tags").evaluate((item) => getComputedStyle(item).outlineStyle)).toBe(
    "none",
  )
  await page.keyboard.press("Escape")
  await expect(dockButton(page, "tags")).toHaveCount(0)

  // The lower zone lists the action buttons; settings cannot be switched off.
  await openZoneMenu(page, "action")
  await expect(page.getByText(ru.activityBar.zoneActions)).toBeVisible()
  await expect(toggle(page, "files")).toHaveCount(0)
  await expect(toggle(page, "settings")).toHaveAttribute("data-disabled", "")
  await expect(toggle(page, "settings")).toHaveAttribute("aria-checked", "true")
  // A press on an item gives way a little, as buttons do.
  const searchBox = (await toggle(page, "search").boundingBox())!
  await page.mouse.move(searchBox.x + 40, searchBox.y + searchBox.height / 2)
  await page.mouse.down()
  await expect
    .poll(() => toggle(page, "search").evaluate((item) => getComputedStyle(item).transform))
    .toMatch(/^matrix\(0\.97/)
  await page.mouse.up()
  await page.keyboard.press("Escape")
  await expect(dockButton(page, "search")).toHaveCount(0)
  await expect(dockButton(page, "settings")).toBeVisible()
  // No control anywhere gets the browser's own focus ring.
  await dockButton(page, "settings").focus()
  expect(
    await dockButton(page, "settings").evaluate((button) => getComputedStyle(button).outlineStyle),
  ).toBe("none")

  // A button's own menu hides it too; settings has no such item.
  await dockButton(page, "favorites").click({ button: "right" })
  // It also lists the switches of its own zone, and only that zone.
  await expect(page.getByText(ru.activityBar.zoneSections)).toBeVisible()
  await expect(toggle(page, "files")).toBeVisible()
  await expect(toggle(page, "search")).toHaveCount(0)
  await page.getByRole("menuitem", { name: ru.activityBar.hideButton }).click()
  await expect(dockButton(page, "favorites")).toHaveCount(0)
  await dockButton(page, "settings").click({ button: "right" })
  await expect(page.getByRole("menuitem", { name: ru.activityBar.hideButton })).toHaveCount(0)
  await page.keyboard.press("Escape")

  // Hidden buttons stay listed in their zone and come back in their place, also after a reload.
  await page.reload()
  await expect(dockButton(page, "files")).toBeVisible()
  await expect(dockButton(page, "tags")).toHaveCount(0)
  await openZoneMenu(page, "view")
  await expect(toggle(page, "tags")).toHaveAttribute("aria-checked", "false")
  await toggle(page, "tags").click()
  await page.keyboard.press("Escape")
  const order = await zone(page, "view")
    .locator("[data-activity-button]")
    .evaluateAll((buttons) => buttons.map((button) => button.getAttribute("data-activity-button")))
  expect(order.indexOf("tags")).toBe(order.indexOf("files") + 1)
})
