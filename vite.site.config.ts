import { defineConfig, mergeConfig } from "vite"
import path from "node:path"
import appConfig from "./vite.config"

export default defineConfig(async (env) => {
  const config = typeof appConfig === "function" ? await appConfig(env) : await appConfig
  return mergeConfig(config, {
    root: path.resolve(import.meta.dirname, "site/demo"),
    base: "./",
    define: { "import.meta.env.VITE_SITE_DEMO": JSON.stringify("true") },
    build: { outDir: path.resolve(import.meta.dirname, "build/site/demo"), emptyOutDir: true },
  })
})
