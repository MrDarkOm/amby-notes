import { spawn } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import process from "node:process"

// Build a frozen test page: no dev server, HMR, mock commands, or user's profile.
// The test-only Rust entry creates and removes its own unique temporary vault.
await mkdir(".release-evidence", { recursive: true })
let log = ""
async function run(command, args, env = process.env) {
  const child = spawn(command, args, { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
  child.stdout.on("data", (chunk) => {
    log += chunk
    process.stdout.write(chunk)
  })
  child.stderr.on("data", (chunk) => {
    log += chunk
    process.stderr.write(chunk)
  })
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", resolve)
  })
  if (code !== 0) throw new Error(`${command} exited ${code}`)
}
try {
  await run(process.execPath, [
    "node_modules/typescript/bin/tsc",
    "--project",
    "tests/native/tsconfig.json",
  ])
  await run(process.execPath, [
    "node_modules/vite/bin/vite.js",
    "build",
    "--config",
    "tests/native/vite.config.ts",
  ])
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
      TAURI_CONFIG: JSON.stringify({
        build: { devUrl: null, frontendDist: "../.release-evidence/native-dist" },
      }),
    },
  )
  const reports = [...log.matchAll(/AMBY_NATIVE_RESULT=(.*)/g)]
  const report = reports.at(-1)
  if (!report || JSON.parse(report[1]).passed !== true)
    throw new Error("Missing passing native report")
} catch (error) {
  log += `\n${String(error)}\n`
  process.exitCode = 1
} finally {
  await writeFile(".release-evidence/native-contract.log", log)
}
