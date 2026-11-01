import { expect, type Page } from "@playwright/test"
import { localeResources } from "../../src/locales/resources"
import { openNote, seedVault, test } from "./support"

const ru = localeResources.ru.translation
const help = (page: Page) => page.locator("[data-help-screen]")
const tip = (page: Page, id: string) => help(page).locator(`[data-help-tip="${id}"]`)

async function openHelp(page: Page) {
  await page.locator('[data-activity-button="help"]').click()
  await expect(help(page)).toBeVisible()
  await expect(help(page)).toHaveCSS("opacity", "1")
}

test("help maps visible controls, explains focused actions and keeps shortcuts interactive", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1680, height: 1000 })
  await page.addInitScript(() =>
    localStorage.setItem(
      "amby:g:settings.json",
      JSON.stringify({ prefs: { theme: "light", shortcuts: { quickOpen: "Mod+Shift+P" } } }),
    ),
  )
  await seedVault(page, { Guide: "# Guide\n\nA note for exploring the workspace.\n" })
  await openNote(page, "Guide")
  await openHelp(page)
  await expect(help(page)).toHaveAttribute("data-layout", "spacious")
  await expect(tip(page, "create")).toBeVisible()
  await expect(tip(page, "focus")).toBeVisible()
  await expect(tip(page, "lock")).toBeVisible()
  await expect(help(page).locator("[data-help-highlight]")).toHaveCount(0)
  const panels = await help(page).locator("[data-help-group]").count()
  expect(panels).toBeGreaterThanOrEqual(6)
  await expect(help(page).locator(".amby-help-connector").first()).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath("help-desktop.png") })

  await tip(page, "focus").hover()
  await expect(help(page).locator('[data-help-highlight="focus"]')).toBeVisible()
  await expect(help(page).locator("[data-help-detail]")).toContainText(
    ru.help.guide.tips.focus.description,
  )
  // Explaining a control must never invoke it or enter focus mode.
  await tip(page, "lock").click()
  await expect(help(page).locator('[data-help-highlight="lock"]')).toBeVisible()
  await expect(page.locator('[data-help-target="lock"]')).not.toHaveAttribute(
    "aria-pressed",
    "true",
  )
  await page.screenshot({ path: testInfo.outputPath("help-highlight.png") })

  const search = help(page).getByRole("textbox", { name: ru.help.guide.searchShortcuts })
  await search.fill(ru.help.note.bold)
  await expect(help(page).locator(".amby-help-shortcut-row")).toHaveCount(1)
  await search.fill("no-matching-command")
  await expect(help(page).getByText(ru.help.guide.noShortcuts)).toBeVisible()
  await search.fill("")
  await help(page).getByRole("tab", { name: ru.help.tabs.general, exact: true }).click()
  await expect(help(page).getByText(ru.settings.shortcuts.save, { exact: true })).toBeVisible()
  await expect(
    help(page)
      .locator(".amby-help-shortcut-row")
      .filter({ hasText: ru.settings.shortcuts.quickOpen })
      .locator("kbd"),
  ).toContainText(/⇧|Shift/)

  const count = await page.locator('[role="treeitem"]').count()
  await search.focus()
  await page.keyboard.press("ControlOrMeta+n")
  expect(await page.locator('[role="treeitem"]').count()).toBe(count)
  await page.keyboard.press("Escape")
  await expect(help(page)).toHaveCount(0)
  await expect(page.locator('[data-activity-button="help"]')).toBeFocused()
})

test("help reflows on resize and excludes cached file panels", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await seedVault(page, { Guide: "# Guide\n\nSome text.\n" })
  await openNote(page, "Guide")
  await openHelp(page)
  await expect(help(page).locator(".amby-help-connector").first()).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath("help-dark.png") })
  await page.keyboard.press("Escape")
  await page.locator('[data-activity-button="archive"]').click()
  await openHelp(page)
  await expect(tip(page, "tree")).toHaveCount(0)
  await expect(tip(page, "create")).toHaveCount(0)

  for (const [width, height] of [
    [1000, 760],
    [520, 740],
    [1440, 600],
  ]) {
    await page.setViewportSize({ width, height })
    await expect(help(page)).toHaveAttribute("data-layout", "compact")
    await expect(
      help(page).getByRole("tab", { name: ru.help.tabs.note, exact: true }),
    ).toBeVisible()
    const overflow = await help(page).evaluate((element) => element.scrollWidth > window.innerWidth)
    expect(overflow).toBe(false)
    await page.screenshot({ path: testInfo.outputPath(`help-${width}x${height}.png`) })
  }
  await tip(page, "pageMenu").click()
  await expect(
    help(page).locator('[data-help-group="page"] .amby-help-inline-detail[data-active="true"]'),
  ).toContainText(ru.help.guide.tips.pageMenu.description)
  await expect(help(page).getByRole("button", { name: ru.common.close, exact: true })).toBeVisible()
  await page.setViewportSize({ width: 1440, height: 900 })
  await expect(help(page)).toHaveAttribute("data-layout", "spacious")
  await page.keyboard.press("Escape")
  await expect(help(page)).toHaveCount(0)
})

test("page hints follow the active split pane", async ({ page }) => {
  await page.setViewportSize({ width: 1680, height: 1000 })
  await seedVault(page, { Guide: "# Guide\n\nAn editable page.\n" })
  await openNote(page, "Guide")
  await page.locator('[data-active-tab="true"]').first().click({ button: "right" })
  await page.getByRole("menuitem", { name: ru.tabs.splitRight, exact: true }).click()
  await expect(page.locator("[data-pane-id]")).toHaveCount(2)
  const pane = page.locator("[data-pane-id]").last()
  await pane.click({ position: { x: 20, y: 120 } })
  const target = await pane.locator('[data-help-target="focus"]').boundingBox()
  expect(target).not.toBeNull()
  await openHelp(page)
  await tip(page, "focus").focus()
  const highlight = help(page).locator('[data-help-highlight="focus"]')
  await expect(highlight).toBeVisible()
  expect(Number(await highlight.getAttribute("x"))).toBeCloseTo(target!.x - 4, 0)
  await page.keyboard.press("Escape")
  await expect(help(page)).toHaveCount(0)
})

test("shortcuts collapse to free space and layer hint needs a layer switcher", async ({ page }) => {
  await page.setViewportSize({ width: 1680, height: 1000 })
  await seedVault(page, { Guide: "# Guide\n\nAn editable page.\n" })
  await openNote(page, "Guide")
  await openHelp(page)
  await expect(help(page)).not.toContainText(/help\.guide\./)
  const list = help(page).locator(".amby-help-shortcut-list:visible")
  await expect(list).toBeVisible()
  const toggle = help(page).locator(".amby-help-section-toggle")
  await toggle.click()
  await expect(toggle).toHaveAttribute("aria-expanded", "false")
  await expect(list).toHaveCount(0)
  await toggle.click()
  await expect(list).toBeVisible()
  await expect(tip(page, "layers")).toHaveCount(0)
})
