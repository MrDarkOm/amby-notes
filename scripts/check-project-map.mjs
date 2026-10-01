import { existsSync, readFileSync, readdirSync } from "node:fs"
import { Buffer } from "node:buffer"
import console from "node:console"
import path from "node:path"
import process from "node:process"
import { fileURLToPath, URL } from "node:url"

const root = fileURLToPath(new URL("../", import.meta.url))
const skipped = new Set(["node_modules", "target", "dist", ".git"])
const maps = ["MAP.md"]
const errors = []

function discover(directory) {
  for (const entry of readdirSync(path.join(root, directory), { withFileTypes: true })) {
    const relative = path.posix.join(directory, entry.name)
    if (entry.isDirectory() && !skipped.has(entry.name)) discover(relative)
    if (entry.isFile() && entry.name === "MAP.md") maps.push(relative)
  }
}

for (const directory of ["src", "src-tauri", "docs", "scripts", "tests"]) {
  discover(directory)
}

const guides = [
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
  "docs/agent-context.md",
  "docs/agent-guidelines.md",
]
const edges = new Map()
for (const file of [...guides, ...maps]) {
  if (!existsSync(path.join(root, file))) {
    errors.push(`${file}: missing navigation document`)
    continue
  }
  const content = readFileSync(path.join(root, file), "utf8")
  const budget = file === "AGENTS.md" ? 6500 : maps.includes(file) ? 12000 : Infinity
  if (Buffer.byteLength(content) > budget)
    errors.push(`${file}: exceeds ${budget}-byte context budget`)
  const imports = [...content.matchAll(/^@(.+)$/gm)].map((match) => match[1].trim())
  if (file === "CLAUDE.md" || file === "GEMINI.md") {
    if (imports.length !== 1 || imports[0] !== "./AGENTS.md")
      errors.push(`${file}: must import only @./AGENTS.md`)
    if (Buffer.byteLength(content) > 500) errors.push(`${file}: adapter must stay below 500 bytes`)
  } else if (imports.length) {
    errors.push(`${file}: use ordinary links instead of eager imports`)
  }

  const targets = []
  // Navigation documents use simple inline Markdown links, without titles.
  for (const match of content.matchAll(/\[[^\]\n]+\]\(([^)\n]+)\)/g)) {
    const link = match[1]
    if (/^[a-z][a-z\d+.-]*:/i.test(link) || link.startsWith("#")) continue
    const target = path.resolve(root, path.dirname(file), decodeURIComponent(link.split("#")[0]))
    const relative = path.relative(root, target).split(path.sep).join("/")
    if (relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) {
      errors.push(`${file}: link escapes repository: ${link}`)
    } else if (!existsSync(target)) {
      errors.push(`${file}: broken local link: ${link}`)
    }
    targets.push(relative)
  }
  edges.set(file, targets)
}

const reachable = new Set()
function visit(file) {
  if (reachable.has(file)) return
  reachable.add(file)
  for (const target of edges.get(file) ?? []) visit(target)
}
visit("MAP.md")
for (const file of maps) {
  if (!reachable.has(file)) errors.push(`${file}: not reachable from MAP.md`)
}

if (errors.length) {
  console.error(errors.join("\n"))
  process.exitCode = 1
} else {
  console.log(
    `Project navigation OK: ${maps.length} maps, ${guides.length} entry/guideline documents; links, reachability, imports and size budgets checked.`,
  )
}
