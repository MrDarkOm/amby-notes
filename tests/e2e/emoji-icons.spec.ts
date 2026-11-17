import { expect } from "@playwright/test"
import { test, seedVault, openInLive, liveEditor, storedMarkdown } from "./support"
import { localeResources } from "../../src/locales/resources"

const original = "> [!NOTE] 👩🏽‍💻\n> Body.\n\nOrdinary 👍🏽 🇫🇮 text.\n"

test("Emoji and Icons search fields share the same focused appearance", async ({ page }) => {
  await seedVault(page, { Emoji: original })
  await openInLive(page, "Emoji")
  await page
    .getByRole("button", { name: localeResources.ru.translation.docEditor.changeIcon, exact: true })
    .click()
  const panel = page.locator(".amby-emoji-picker-panel")
  const emojiInput = panel.locator('[data-amby-emoji-picker] input[type="search"]')
  await emojiInput.focus()
  await expect(emojiInput).toHaveCSS("background-color", "rgba(0, 0, 0, 0)")
  const emojiStyle = await emojiInput.evaluate((input) => {
    const field = getComputedStyle(input)
    const loupe = (input.getRootNode() as ShadowRoot).querySelector(".loupe")!
    const icon = getComputedStyle(loupe, "::before")
    return {
      height: field.height,
      radius: field.borderRadius,
      border: field.borderColor,
      font: field.fontFamily,
      fontSize: field.fontSize,
      iconInsetX: loupe.getBoundingClientRect().left - input.getBoundingClientRect().left,
      iconWidth: icon.width,
      iconHeight: icon.height,
      iconColor: icon.backgroundColor,
      mask: icon.maskImage || icon.webkitMaskImage,
    }
  })
  expect(emojiStyle.mask).toContain("data:image/svg+xml")
  expect(
    await emojiInput.evaluate(
      (input) =>
        getComputedStyle((input.getRootNode() as ShadowRoot).querySelector(".loupe")!, "::before")
          .display,
    ),
  ).toBe("block")
  await panel
    .getByRole("button", { name: localeResources.ru.translation.emojiPicker.icons, exact: true })
    .click()
  const iconsInput = panel.getByRole("textbox")
  await iconsInput.focus()
  await expect(iconsInput).toHaveCSS("background-color", "rgba(0, 0, 0, 0)")
  const iconsStyle = await iconsInput.evaluate((input) => {
    const field = getComputedStyle(input)
    const label = input.closest("label")!
    const box = getComputedStyle(label)
    const icon = getComputedStyle(label.querySelector("svg")!)
    return {
      height: box.height,
      radius: box.borderRadius,
      border: box.borderColor,
      font: field.fontFamily,
      fontSize: field.fontSize,
      iconInsetX:
        label.querySelector("svg")!.getBoundingClientRect().left -
        label.getBoundingClientRect().left,
      iconWidth: icon.width,
      iconHeight: icon.height,
      iconColor: icon.color,
    }
  })
  const { mask: _mask, ...style } = emojiStyle
  expect(style).toEqual(iconsStyle)
})

test("picker styles survive asynchronous initialization under packaged-style CSP", async ({
  page,
}) => {
  await page.route(
    (url) => url.hostname === "localhost" && url.pathname === "/",
    async (route) => {
      const response = await route.fetch()
      await route.fulfill({
        response,
        headers: {
          ...response.headers(),
          "content-security-policy": "style-src 'self' 'nonce-packaged-style-test'",
        },
      })
    },
  )
  await seedVault(page, { Emoji: original })
  await openInLive(page, "Emoji")
  await page.locator(".amby-callout-emoji-btn").click()
  const picker = page.locator("[data-amby-emoji-picker]")
  const search = picker.locator('input[type="search"]')
  await expect(search).toHaveCSS("height", "40px")
  await search.fill("Finland")
  await expect(picker.getByRole("button", { name: "🇫🇮", exact: true })).toBeVisible()
  await expect(search).toHaveCSS("height", "40px")
})

test("picker keeps skin selection, Unicode insertion and recent choices", async ({ page }) => {
  await seedVault(page, { Emoji: original })
  await openInLive(page, "Emoji")
  await page.locator(".amby-callout-emoji-btn").click()
  const picker = page.locator("[data-amby-emoji-picker]")
  await picker.locator('input[type="search"]').fill("thumbsup")
  await picker.locator(".skin-tone-button").click()
  await picker.locator(".menu .skin-tone-4").click()
  const thumb = picker.getByRole("button", { name: "👍🏽", exact: true })
  await expect(thumb.locator("img")).toHaveAttribute("src", /emoji_u1f44d_1f3fd\.svg\?v=/u)
  await thumb.click()
  await expect.poll(() => storedMarkdown(page, "Emoji")).toContain("> [!NOTE] 👍🏽")
  await page.locator(".amby-callout-emoji-btn").click()
  await expect(picker.getByRole("button", { name: "👍🏽", exact: true }).first()).toBeVisible()
})

test("interface emoji and picker use local Noto while Markdown stays Unicode", async ({ page }) => {
  const remoteRequests: string[] = []
  page.on("request", (request) => {
    if (/^https?:/u.test(request.url()) && new URL(request.url()).hostname !== "localhost")
      remoteRequests.push(request.url())
  })
  await seedVault(page, { Emoji: original })
  await openInLive(page, "Emoji")
  const icon = page.locator(".amby-callout-emoji-btn")
  await expect(icon.locator("img")).toHaveAttribute("src", /\/emoji\/noto\//u)
  await expect
    .poll(() => icon.locator("img").evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBeGreaterThan(0)
  const ordinary = liveEditor(page).getByText("Ordinary 👍🏽 🇫🇮 text.", { exact: true })
  await expect(ordinary).toBeVisible()
  await expect(ordinary.locator("img")).toHaveCount(0)
  expect(await storedMarkdown(page, "Emoji")).toBe(original)

  await icon.click()
  const picker = page.locator("[data-amby-emoji-picker]")
  await picker.locator('input[type="search"]').fill("Finland")
  const flag = picker.getByRole("button", { name: "🇫🇮", exact: true })
  await expect(flag.locator("img")).toHaveCSS("width", "24px")
  await expect(flag.locator("img")).toHaveCSS("height", "24px")
  await expect
    .poll(() => flag.locator("img").evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBeGreaterThan(0)
  await flag.click()
  await expect.poll(() => storedMarkdown(page, "Emoji")).toContain("> [!NOTE] 🇫🇮")
  const saved = await storedMarkdown(page, "Emoji")
  expect(saved).toContain("Ordinary 👍🏽 🇫🇮 text.")
  expect(saved).not.toContain("emoji/noto")
  expect(remoteRequests).toEqual([])
})

test("missing local images fall back intact in the interface and picker", async ({ page }) => {
  await page.route(/\/emoji\/noto\/.*\.svg(?:\?|$)/u, (route) => route.abort())
  await seedVault(page, { Emoji: original })
  await openInLive(page, "Emoji")
  const icon = page.locator(".amby-callout-emoji-btn")
  await expect(icon).toHaveText("👩🏽‍💻")
  await expect(icon.locator("img")).toHaveCount(0)
  await icon.click()
  const picker = page.locator("[data-amby-emoji-picker]")
  await picker.locator('input[type="search"]').fill("Finland")
  const flag = picker.getByRole("button", { name: "🇫🇮", exact: true })
  await expect(flag).toHaveText("🇫🇮")
  await expect(flag.locator("img")).toHaveCount(0)
  expect(await storedMarkdown(page, "Emoji")).toBe(original)
})

test("emoji search follows the app language and always supports English", async ({ page }) => {
  await seedVault(page, { Emoji: original })
  await openInLive(page, "Emoji")
  const picker = page.locator("[data-amby-emoji-picker]")
  const search = picker.locator('input[type="search"]')
  const changeLanguage = async (from: "ru" | "en", to: "ru" | "en") => {
    const current = localeResources[from].translation
    const next = localeResources[to].translation
    await page.locator('[data-activity-button="settings"]').click()
    await page
      .getByRole("combobox")
      .filter({ hasText: current.settings.appearance[from === "ru" ? "russian" : "english"] })
      .click()
    await page
      .getByRole("option", {
        name: current.settings.appearance[to === "ru" ? "russian" : "english"],
        exact: true,
      })
      .click()
    await page.getByRole("button", { name: next.settings.window.close, exact: true }).click()
    await page.locator(".amby-callout-emoji-btn").click()
  }
  await page.locator(".amby-callout-emoji-btn").click()
  for (const query of ["кот", "cat"]) {
    await search.fill(query)
    await expect(picker.getByRole("button", { name: "🐱", exact: true })).toBeVisible()
  }
  await search.fill("Финляндия")
  await expect(picker.getByRole("button", { name: "🇫🇮", exact: true })).toBeVisible()
  await changeLanguage("ru", "en")
  await search.fill("кот")
  await expect(picker.getByRole("button", { name: "🐱", exact: true })).toHaveCount(0)
  await search.fill("cat")
  await expect(picker.getByRole("button", { name: "🐱", exact: true })).toBeVisible()
  await changeLanguage("en", "ru")
  await search.fill("кот")
  await expect(picker.getByRole("button", { name: "🐱", exact: true })).toBeVisible()
  expect(await storedMarkdown(page, "Emoji")).toBe(original)
})

test("flag proportions stay stable after search and clearing results", async ({
  page,
}, testInfo) => {
  await seedVault(page, { Emoji: original })
  await openInLive(page, "Emoji")
  await page.locator(".amby-callout-emoji-btn").click()
  const picker = page.locator("[data-amby-emoji-picker]")
  await picker
    .locator("#nav")
    .getByRole("button", {
      name: localeResources.ru.translation.emojiPicker.categories.flags,
      exact: true,
    })
    .click()
  const image = picker.getByRole("button", { name: "🇺🇸", exact: true }).first().locator("img")
  await picker.locator(".scroll").evaluate((scroll) => {
    scroll.scrollTop = scroll.scrollHeight
  })
  await image.scrollIntoViewIfNeeded()
  await image.hover()
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(128)
  const bounds = async (png: Buffer) =>
    page.evaluate(async (base64) => {
      const bitmap = new Image()
      bitmap.src = `data:image/png;base64,${base64}`
      await bitmap.decode()
      const canvas = document.createElement("canvas")
      canvas.width = bitmap.naturalWidth
      canvas.height = bitmap.naturalHeight
      const context = canvas.getContext("2d")!
      context.drawImage(bitmap, 0, 0)
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
      const points = []
      for (let y = 0; y < canvas.height; y++)
        for (let x = 0; x < canvas.width; x++) {
          const offset = (y * canvas.width + x) * 4
          const rgb = [...pixels.slice(offset, offset + 3)]
          // Red/blue flag artwork, excluding neutral selection and page backgrounds.
          if (Math.max(...rgb) - Math.min(...rgb) > 20) points.push([x, y])
        }
      return {
        width: Math.max(...points.map(([x]) => x)) - Math.min(...points.map(([x]) => x)) + 1,
        height: Math.max(...points.map(([, y]) => y)) - Math.min(...points.map(([, y]) => y)) + 1,
      }
    }, png.toString("base64"))
  const before = await bounds(
    await image.screenshot({ path: testInfo.outputPath("flag-before.png") }),
  )
  expect(before.width).toBeGreaterThan(20)
  expect(before.height).toBeGreaterThan(10)
  const search = picker.locator('input[type="search"]')
  for (const query of ["United States", "Finland", "United States", ""]) {
    await search.fill(query)
    if (query === "Finland") {
      await expect(picker.getByRole("button", { name: "🇫🇮", exact: true })).toBeVisible()
      continue
    }
    if (!query) {
      await picker
        .locator("#nav")
        .getByRole("button", {
          name: localeResources.ru.translation.emojiPicker.categories.flags,
          exact: true,
        })
        .click()
      await picker.locator(".scroll").evaluate((scroll) => {
        scroll.scrollTop = scroll.scrollHeight
      })
    }
    await image.scrollIntoViewIfNeeded()
    await image.hover()
    await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(128)
    const after = await bounds(
      await image.screenshot({ path: testInfo.outputPath("flag-after.png") }),
    )
    expect(Math.abs(after.width - before.width)).toBeLessThanOrEqual(1)
    expect(Math.abs(after.height - before.height)).toBeLessThanOrEqual(1)
  }
})

test("one warmed picker is reused across notes without stale queries or callbacks", async ({
  page,
}) => {
  await seedVault(page, { First: original, Second: original })
  await openInLive(page, "First")
  const picker = page.locator("[data-amby-emoji-picker]")
  await page.locator(".amby-callout-emoji-btn").click()
  const search = picker.locator('input[type="search"]')
  await search.fill("Finland")
  await picker.evaluate((element) => {
    ;(element as HTMLElement).dataset.reuseProbe = "retained"
  })
  await picker.getByRole("button", { name: "🇫🇮", exact: true }).click()
  await expect.poll(() => storedMarkdown(page, "First")).toContain("> [!NOTE] 🇫🇮")
  await expect(page.locator(".amby-emoji-picker-panel")).toHaveCount(0)
  await expect(picker).toBeHidden()
  await openInLive(page, "Second")
  await page.locator(".amby-callout-emoji-btn").click()
  await expect(picker).toHaveCount(1)
  await expect(picker).toHaveAttribute("data-reuse-probe", "retained")
  await expect(search).toHaveValue("")
  await expect(
    picker
      .locator('.category[data-id="frequent"]')
      .getByRole("button", { name: "🇫🇮", exact: true }),
  ).toBeVisible()
  await search.fill("cat")
  await picker.getByRole("button", { name: "🐱", exact: true }).click()
  await expect.poll(() => storedMarkdown(page, "Second")).toContain("> [!NOTE] 🐱")
  expect(await storedMarkdown(page, "First")).toContain("> [!NOTE] 🇫🇮")
})

test("background warmup does not steal editor focus", async ({ page }) => {
  await page.addInitScript(() => {
    const tasks = new Map<number, IdleRequestCallback>()
    let next = 0
    window.requestIdleCallback = (callback) => {
      tasks.set(++next, callback)
      return next
    }
    window.cancelIdleCallback = (id) => {
      tasks.delete(id)
    }
    Object.assign(window, {
      runPickerWarmup: () => {
        for (const [id, callback] of tasks) {
          tasks.delete(id)
          callback({ didTimeout: false, timeRemaining: () => 50 })
        }
      },
    })
  })
  await seedVault(page, { Emoji: original })
  await openInLive(page, "Emoji")
  const editor = liveEditor(page)
  await editor.focus()
  await page.evaluate(() =>
    (window as unknown as { runPickerWarmup: () => void }).runPickerWarmup(),
  )
  const cached = page.locator(".amby-emoji-picker-parking [data-amby-emoji-picker]")
  await expect(cached.locator('input[type="search"]')).toHaveCount(1)
  await expect(cached).toBeHidden()
  await expect(editor).toBeFocused()
})
