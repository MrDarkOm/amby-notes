import { spawn, execFileSync } from "node:child_process"
import { createRequire } from "node:module"
import { mkdir, writeFile } from "node:fs/promises"
import console from "node:console"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import process from "node:process"

// Native check of the sync connect screen (docs/native-ui-smoke.md, «Синхронизация»; plan Э4).
// It starts a disposable server container, creates a user, builds the frozen test page and runs
// the real application window against the container. The key store is in memory unless
// AMBY_NATIVE_REAL_KEYCHAIN=1. Needs Docker and a built image:
//   docker build -f sync/server/Dockerfile -t amby-sync-server:smoke sync/
// The image name can be changed with AMBY_SYNC_IMAGE.
const resolve = createRequire(import.meta.url).resolve
// Tools are found the way Node finds packages, so this also works in a git worktree.
const bin = (pkg, file) => path.join(path.dirname(resolve(`${pkg}/package.json`)), file)
const image = process.env.AMBY_SYNC_IMAGE || "amby-sync-server:smoke"
const port = process.env.AMBY_SYNC_PORT || "18081"
const name = `amby-sync-native-${process.pid}`
const username = "native-check"

function docker(...args) {
  return execFileSync("docker", args, { encoding: "utf8" })
}

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
  try {
    docker("info")
  } catch {
    console.error("UNAVAILABLE: Docker is not running.")
    process.exit(3)
  }
  docker("run", "-d", "--name", name, "-p", `127.0.0.1:${port}:8080`, image)
  const url = `http://127.0.0.1:${port}`
  let up = false
  for (let attempt = 0; attempt < 60 && !up; attempt += 1) {
    up = await globalThis.fetch(`${url}/v1/info`).then(
      (response) => response.ok,
      () => false,
    )
    if (!up) await sleep(1000)
  }
  if (!up) throw new Error("The server container did not answer")
  const added = JSON.parse(
    docker("exec", name, "amby-sync-server", "user", "add", username, "--json")
      .trim()
      .split("\n")
      .at(-1),
  )

  await run(process.execPath, [
    bin("typescript", "bin/tsc"),
    "--project",
    "tests/native/tsconfig.json",
  ])
  await run(process.execPath, [
    bin("vite", "bin/vite.js"),
    "build",
    "--config",
    "tests/native/vite.sync.config.ts",
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
      AMBY_NATIVE_PAGE: "sync-connect",
      AMBY_NATIVE_SYNC_URL: url,
      AMBY_NATIVE_SYNC_USER: username,
      AMBY_NATIVE_SYNC_CODE: added.enroll_code,
      TAURI_CONFIG: JSON.stringify({
        build: { devUrl: null, frontendDist: "../.release-evidence/native-sync-dist" },
      }),
    },
  )
  const report = [...log.matchAll(/AMBY_NATIVE_RESULT=(.*)/g)].at(-1)
  if (!report) throw new Error("Missing native report")
  const result = JSON.parse(report[1])
  for (const step of result.results)
    console.log(
      `${step.passed ? "ok  " : "FAIL"} ${step.name}${step.error ? `\n     ${step.error}` : ""}`,
    )
  if (result.passed !== true) throw new Error("The native sync check failed")
} catch (error) {
  log += `\n${String(error)}\n`
  console.error(String(error))
  process.exitCode = 1
} finally {
  try {
    docker("rm", "-f", name)
  } catch {
    // The container may not have started.
  }
  await writeFile(".release-evidence/native-sync.log", log)
}
