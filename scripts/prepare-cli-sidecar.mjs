import { spawnSync } from "node:child_process"
import { copyFileSync, mkdirSync, renameSync, rmSync } from "node:fs"
import path from "node:path"
import process from "node:process"
import { URL, fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
const destination = path.join(root, "src-tauri", "binaries")

function run(command, args, capture = false) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    windowsHide: true,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} exited with code ${result.status}`)
  return result.stdout
}

function stage(output, produce) {
  const temp = `${output}.${process.pid}.tmp`
  try {
    produce(temp)
    renameSync(temp, output)
  } finally {
    rmSync(temp, { force: true })
  }
}

const target =
  process.env.TAURI_ENV_TARGET_TRIPLE || /^host: (\S+)$/m.exec(run("rustc", ["-vV"], true))?.[1]
if (!target || !/^[A-Za-z0-9_]+(?:-[A-Za-z0-9_]+){2,}$/u.test(target)) {
  throw new Error("Could not determine the desktop packaging target")
}
const debug = process.env.TAURI_ENV_DEBUG === "true"
const profile = debug ? "debug" : "release"
const targets =
  target === "universal-apple-darwin" ? ["aarch64-apple-darwin", "x86_64-apple-darwin"] : [target]
const metadata = JSON.parse(
  run("cargo", ["metadata", "--locked", "--no-deps", "--format-version", "1"], true),
)
mkdirSync(destination, { recursive: true })

const components = targets.map((triple) => {
  const suffix = triple.includes("-windows-") ? ".exe" : ""
  const source = path.join(metadata.target_directory, triple, profile, `amby${suffix}`)
  const output = path.join(destination, `amby-${triple}${suffix}`)
  run("cargo", [
    "build",
    "--locked",
    "-p",
    "amby-cli",
    "--target",
    triple,
    ...(debug ? [] : ["--release"]),
  ])
  stage(output, (temp) => copyFileSync(source, temp))
  return output
})

if (targets.length > 1) {
  stage(path.join(destination, `amby-${target}`), (temp) =>
    run("lipo", ["-create", ...components, "-output", temp]),
  )
}
