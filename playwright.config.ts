import { defineConfig, devices } from "@playwright/test"

// Real-browser checks of the browser build (localStorage web adapter). The desktop app
// runs in WKWebView, so the only project is WebKit.
//
// The suite runs against the built bundle served by `vite preview`: that is the code the
// desktop app ships, and it has no React StrictMode double effects, so "one editor is
// built per note" can be counted. `AMBY_E2E_DEV=1` uses the dev server for quick
// iteration (editor counts double there). A port of its own keeps the suite away from a
// dev server of another checkout on the default 1420.
const DEV = process.env.AMBY_E2E_DEV === "1"
const PORT = Number(process.env.AMBY_E2E_PORT ?? (DEV ? 1431 : 1432))

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  // A shared CI machine stalls now and then: one retry there, reported as "flaky" so that
  // it is seen. Locally a case passes the first time or fails.
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["github"]] : [["list"]],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    actionTimeout: 10_000,
  },
  outputDir: "node_modules/.cache/amby-e2e",
  projects: [{ name: "webkit", use: { ...devices["Desktop Safari"] } }],
  webServer: {
    command: DEV
      ? `npm run dev -- --port ${PORT} --strictPort`
      : `npx vite build && npx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    // A preview server would serve a stale bundle; only the dev server is reused.
    reuseExistingServer: DEV && !process.env.CI,
    timeout: 120_000,
  },
})
