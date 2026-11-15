import { expect } from "@playwright/test"
import config from "../../src-tauri/tauri.conf.json" with { type: "json" }
import { test } from "./support"

// Exercise the shipped policy in a real browser: the web adapter's normal
// preview server does not send Tauri's CSP, and would miss Windows regressions.
test("the desktop CSP loads Windows assets and still blocks unrelated image hosts", async ({
  page,
}) => {
  const requested: string[] = []
  await page.route("**/*", (route) => {
    if (route.request().resourceType() === "document") {
      return route.fulfill({
        contentType: "text/html",
        headers: { "Content-Security-Policy": config.app.security.csp },
        body: "<!doctype html><title>Desktop asset policy</title>",
      })
    }
    requested.push(route.request().url())
    return route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>',
    })
  })
  await page.goto("http://tauri.localhost/")

  for (const [src, allowed] of [
    ["http://asset.localhost/C%3A%5CVault%5Cassets%5Cphoto.png", true],
    ["https://asset.localhost/C%3A%5CVault%5Cassets%5Cphoto.png", true],
    ["http://example.test/photo.png", false],
    ["https://example.test/photo.png", false],
    ["http://asset.localhost.example.test/photo.png", false],
  ] as const) {
    const loaded = await page.evaluate(
      (url) =>
        new Promise<boolean>((resolve) => {
          const image = new Image()
          image.onload = () => resolve(image.naturalWidth === 2)
          image.onerror = () => resolve(false)
          image.src = url
          document.body.append(image)
        }),
      src,
    )
    expect(loaded, src).toBe(allowed)
    expect(requested.includes(src), src).toBe(allowed)
  }
})
