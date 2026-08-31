import { spawn } from "node:child_process"
import console from "node:console"
import { cp, mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import process from "node:process"

// Test-only entry, never distribute. No existing app settings or vaults are read.
const root = path.resolve(process.argv[2] || `.release-evidence/native-ui-${Date.now()}`)
if (process.argv[2]) {
  if ((await readFile(path.join(root, ".native-ui-profile"), "utf8")) !== "amby-native-ui-v1")
    throw new Error("Not a native UI test profile")
} else {
  await mkdir(root, { recursive: true })
  await writeFile(path.join(root, ".native-ui-profile"), "amby-native-ui-v1", { flag: "wx" })
  await mkdir(path.join(root, ".app-data"))
  for (const name of ["Smoke A", "Smoke B"]) {
    await mkdir(path.join(root, name))
    await writeFile(path.join(root, name, "Lifecycle.md"), `# ${name}\n\nInitial saved content.\n`)
  }
  await cp("tests/fixtures/compatibility-vault", path.join(root, "Compatibility"), {
    recursive: true,
  })
  await writeFile(
    path.join(root, ".app-data", "workspaces.json"),
    JSON.stringify({
      schemaVersion: 1,
      recent: ["Smoke A", "Smoke B", "Compatibility"].map((name) => ({
        id: name,
        name,
        path: path.join(root, name),
      })),
      lastOpened: path.join(root, "Smoke A"),
    }),
  )
}
console.log(`Native UI profile: ${root}`)
console.log(`Reopen: npm run test:native:ui -- "${root}"`)
async function run(command, args, env = process.env) {
  const child = spawn(command, args, { env, windowsHide: true, stdio: "inherit" })
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", resolve)
  })
  if (code !== 0) throw new Error(`${command} exited ${code}`)
}
await run(process.execPath, ["node_modules/typescript/bin/tsc"])
await run(process.execPath, ["node_modules/vite/bin/vite.js", "build"])
await run(
  "cargo",
  [
    "run",
    "--manifest-path",
    "src-tauri/Cargo.toml",
    "--features",
    "native-contract,tauri/custom-protocol",
  ],
  {
    ...process.env,
    AMBY_NATIVE_UI_ROOT: root,
    TAURI_CONFIG: JSON.stringify({ build: { devUrl: null, frontendDist: "../dist" } }),
  },
)
