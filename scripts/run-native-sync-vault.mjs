import { spawn, execFileSync } from "node:child_process"
import { createRequire } from "node:module"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import console from "node:console"
import os from "node:os"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import process from "node:process"

// Native check of the sync of a vault (docs/native-ui-smoke.md, «Синхронизация: два компьютера»;
// plan Э4). Two real windows of the application — two computers with their own app data, key store
// and vault — against one real server. It needs a server: a Docker container when Docker works
// (the image: `docker build -f sync/server/Dockerfile -t amby-sync-server:smoke sync/`, the name can
// be changed with AMBY_SYNC_IMAGE), otherwise the server program of this repository, built and run
// here (AMBY_SYNC_SERVER=binary forces it). The key store is in memory unless
// AMBY_NATIVE_REAL_KEYCHAIN=1.
const resolve = createRequire(import.meta.url).resolve
// Tools are found the way Node finds packages, so this also works in a git worktree.
const bin = (pkg, file) => path.join(path.dirname(resolve(`${pkg}/package.json`)), file)
const image = process.env.AMBY_SYNC_IMAGE || "amby-sync-server:smoke"
const port = process.env.AMBY_SYNC_PORT || "18082"
const containerName = `amby-sync-vault-native-${process.pid}`
const username = "native-vault"
const password = "correct horse battery staple 42"
const spaceName = "Нативная проверка"
const url = `http://127.0.0.1:${port}`

await mkdir(".release-evidence", { recursive: true })
let log = ""
const append = (chunk) => {
  log += chunk
  process.stdout.write(chunk)
}

function sh(command, args, options = {}) {
  return execFileSync(command, args, { encoding: "utf8", ...options })
}

async function run(command, args, env = process.env) {
  const child = spawn(command, args, { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
  child.stdout.on("data", append)
  child.stderr.on("data", append)
  const code = await new Promise((resolveExit, reject) => {
    child.once("error", reject)
    child.once("exit", resolveExit)
  })
  if (code !== 0) throw new Error(`${command} exited ${code}`)
}

function dockerWorks() {
  if (process.env.AMBY_SYNC_SERVER === "binary") return false
  try {
    sh("docker", ["info"], { stdio: "pipe" })
    sh("docker", ["image", "inspect", image], { stdio: "pipe" })
    return true
  } catch {
    return false
  }
}

let stopServer = async () => {}
let admin = () => ""

async function startServer() {
  if (dockerWorks()) {
    sh("docker", ["run", "-d", "--name", containerName, "-p", `127.0.0.1:${port}:8080`, image])
    stopServer = async () => {
      try {
        sh("docker", ["rm", "-f", containerName])
      } catch {
        // The container may not have started.
      }
    }
    admin = (...args) => sh("docker", ["exec", containerName, "amby-sync-server", ...args])
    append(`server: container ${image}\n`)
  } else {
    await run("cargo", ["build", "--manifest-path", "sync/Cargo.toml", "-p", "amby-sync-server"])
    const data = await mkdtemp(path.join(os.tmpdir(), "amby-sync-native-server-"))
    const env = {
      ...process.env,
      AMBY_SYNC_DATA_DIR: data,
      AMBY_SYNC_LISTEN: `127.0.0.1:${port}`,
      AMBY_SYNC_PUBLIC_URL: url,
      AMBY_SYNC_ALLOW_HTTP: "1",
    }
    const program = path.resolve("sync/target/debug/amby-sync-server")
    const child = spawn(program, [], { env, stdio: ["ignore", "pipe", "pipe"] })
    child.stdout.on("data", append)
    child.stderr.on("data", append)
    stopServer = async () => {
      child.kill("SIGTERM")
      await sleep(500)
      await rm(data, { recursive: true, force: true })
    }
    admin = (...args) => sh(program, args, { env })
    append(`server: the program of this repository, data in ${data}\n`)
  }
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const up = await globalThis.fetch(`${url}/v1/info`).then(
      (response) => response.ok,
      () => false,
    )
    if (up) return
    await sleep(1000)
  }
  throw new Error("The server did not answer")
}

function startApp(role, extra) {
  const output = { text: "" }
  const child = spawn(path.resolve("src-tauri/target/debug/amby-notes"), [], {
    env: {
      ...process.env,
      AMBY_NATIVE_PAGE: "sync-vault",
      AMBY_NATIVE_SYNC_URL: url,
      AMBY_NATIVE_SYNC_USER: username,
      AMBY_NATIVE_SYNC_PASSWORD: password,
      AMBY_NATIVE_SYNC_SPACE: spaceName,
      AMBY_NATIVE_SYNC_ROLE: role,
      ...extra,
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  const collect = (chunk) => {
    output.text += chunk
    append(`[${role}] ${chunk}`)
  }
  child.stdout.on("data", collect)
  child.stderr.on("data", collect)
  const done = new Promise((resolveExit, reject) => {
    child.once("error", reject)
    child.once("exit", (code) => resolveExit({ code, output }))
  })
  return { child, done }
}

function report(role, { code, output }) {
  const found = [...output.text.matchAll(/AMBY_NATIVE_RESULT=(.*)/g)].at(-1)
  if (!found) throw new Error(`Computer ${role.toUpperCase()}: no report (exit code ${code})`)
  const result = JSON.parse(found[1])
  for (const step of result.results)
    console.log(
      `${step.passed ? "ok  " : "FAIL"} [${role.toUpperCase()}] ${step.name}${step.error ? `\n     ${step.error}` : ""}`,
    )
  return result.passed === true && code === 0
}

try {
  await startServer()
  const added = JSON.parse(admin("user", "add", username, "--json").trim().split("\n").at(-1))

  await run(process.execPath, [
    bin("typescript", "bin/tsc"),
    "--project",
    "tests/native/tsconfig.json",
  ])
  await run(process.execPath, [
    bin("vite", "bin/vite.js"),
    "build",
    "--config",
    "tests/native/vite.sync-vault.config.ts",
  ])
  await run(
    "cargo",
    [
      "build",
      "--manifest-path",
      "src-tauri/Cargo.toml",
      "--features",
      "native-contract,tauri/custom-protocol",
    ],
    {
      ...process.env,
      TAURI_CONFIG: JSON.stringify({
        build: { devUrl: null, frontendDist: "../.release-evidence/native-sync-vault-dist" },
      }),
    },
  )

  // Computer A makes the account; B starts when the account has its password, so that B signs in
  // once and never counts as a failed attempt (П16).
  const a = startApp("a", { AMBY_NATIVE_SYNC_CODE: added.enroll_code })
  let ready = false
  for (let attempt = 0; attempt < 120 && !ready; attempt += 1) {
    await sleep(1000)
    const users = JSON.parse(admin("user", "list", "--json").trim().split("\n").at(-1))
    ready = users.some((user) => user.username === username && user.has_password)
  }
  if (!ready) throw new Error("Computer A did not create the account")
  const b = startApp("b", {})
  const [doneA, doneB] = await Promise.all([a.done, b.done])
  const okA = report("a", doneA)
  const okB = report("b", doneB)
  if (!okA || !okB) throw new Error("The native check of the sync of a vault failed")
} catch (error) {
  log += `\n${String(error)}\n`
  console.error(String(error))
  process.exitCode = 1
} finally {
  await stopServer()
  await writeFile(".release-evidence/native-sync-vault.log", log)
}
