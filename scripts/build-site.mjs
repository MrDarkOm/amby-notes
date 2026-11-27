import { spawnSync } from "node:child_process"
import { cpSync, mkdirSync } from "node:fs"
import { fileURLToPath, URL } from "node:url"
import console from "node:console"
import process from "node:process"

const root = fileURLToPath(new URL("../", import.meta.url))
const types = spawnSync("npm", ["exec", "tsc", "--", "--project", "tsconfig.site.json"], {
  cwd: root,
  stdio: "inherit",
})
if (types.status !== 0) process.exit(types.status ?? 1)
const result = spawnSync(
  "npm",
  ["exec", "vite", "--", "build", "--config", "vite.site.config.ts"],
  { cwd: root, stdio: "inherit" },
)
if (result.status !== 0) process.exit(result.status ?? 1)
mkdirSync(new URL("../build/site/", import.meta.url), { recursive: true })
cpSync(
  new URL("../site/index.html", import.meta.url),
  new URL("../build/site/index.html", import.meta.url),
)
cpSync(
  new URL("../site/assets/", import.meta.url),
  new URL("../build/site/assets/", import.meta.url),
  { recursive: true },
)
console.log("Website with the real browser demo: build/site/")
