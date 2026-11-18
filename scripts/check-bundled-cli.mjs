import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import process from "node:process"

const [, , executable, ...launcherArgs] = process.argv
assert(executable, "Usage: node scripts/check-bundled-cli.mjs EXECUTABLE [LAUNCHER_ARG ...]")

const fixture = await mkdtemp(path.join(tmpdir(), "amby-bundled-cli-"))
const vault = path.join(fixture, "Test vault")
const projects = path.join(vault, "Projects")
const inside = path.join(projects, "Inside.md")
const outside = path.join(vault, "Outside.md")
const insideSource = "# Inside\n"
const outsideSource = "# Outside\n"

const run = (args, input) =>
  execFileSync(path.resolve(executable), [...launcherArgs, ...args], {
    cwd: fixture,
    encoding: "utf8",
    input,
    timeout: 60_000,
    windowsHide: true,
    env: { ...process.env, AMBY_APP_DATA_DIR: path.join(fixture, "app data") },
  })

const rpc = (id, method, params) => ({ jsonrpc: "2.0", id, method, params })
const initialize = rpc(1, "initialize", {
  protocolVersion: "2025-11-25",
  capabilities: {},
  clientInfo: { name: "amby-bundle-smoke", version: "1" },
})
const append = (id, note, content) =>
  rpc(id, "tools/call", { name: "append_note", arguments: { path: note, content } })

function session(args, requests) {
  const frames = [initialize, rpc(undefined, "notifications/initialized"), ...requests]
  const input = frames.map((frame) => JSON.stringify(frame)).join("\n") + "\n"
  const output = run(["--vault", vault, "mcp", ...args], input)
  const replies = output
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line))
  assert.deepEqual(
    replies.map(({ id }) => id),
    [initialize, ...requests].map(({ id }) => id),
  )
  for (const reply of replies) {
    assert.equal(reply.jsonrpc, "2.0")
    assert.equal(reply.error, undefined, JSON.stringify(reply))
    assert(reply.result, JSON.stringify(reply))
  }
  assert.equal(replies[0].result.serverInfo.name, "amby")
  assert.equal(replies[0].result.protocolVersion, initialize.params.protocolVersion)
  return replies.slice(1).map(({ result }) => result)
}

try {
  await mkdir(projects, { recursive: true })
  await writeFile(inside, insideSource)
  await writeFile(outside, outsideSource)
  assert.match(run(["--help"]), /^Usage: amby\b/)

  const [readOnlyTools] = session([], [rpc(2, "tools/list")])
  assert(readOnlyTools.tools.some(({ name }) => name === "read_note"))
  assert(!readOnlyTools.tools.some(({ name }) => name === "append_note"))

  const line = "Written by bundled MCP.\n"
  const [tools, denied, written] = session(
    ["--allow-write=Projects/"],
    [rpc(2, "tools/list"), append(3, "Outside.md", line), append(4, "Projects/Inside.md", line)],
  )
  assert(tools.tools.some(({ name }) => name === "append_note"))
  assert.equal(denied.isError, true)
  assert.equal(denied.structuredContent.error, "accessDenied")
  assert.equal(written.isError, false)
  assert.equal(await readFile(inside, "utf8"), insideSource + line)
  assert.equal(await readFile(outside, "utf8"), outsideSource)
  process.stdout.write("Bundled CLI and scoped MCP passed.\n")
} finally {
  await rm(fixture, { recursive: true, force: true })
}
