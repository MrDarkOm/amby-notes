// One guard for the rules of docs/notices.md that old habits would break (step 6 of the transition).
// It reads the whole of `src` (tests and generated bindings excepted) and fails with a message that
// says what to do and where the rule is. It replaces `no-system-dialogs.test.ts` (windows of the
// system) and `error-text-guard.test.ts` (raw error text), which were narrower.
//
//  - §9, §13   no window of the system: a question is `confirm()`, a message goes to its place
//  - §10       no raw error text on its way to a person: `operationErrorText` and the dictionaries
//  - §13       a swallowed error says why it is swallowed
//  - §11       the colours of a notice are the `--notice-*` tokens, not a palette class
//  - §6        the toasts have one host
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import ts from "typescript"
import { describe, expect, it } from "vitest"

const root = join(import.meta.dirname, "..", "..")
const srcRoot = join(root, "src")

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === "test-utils" ? [] : sourceFiles(path)
    if (!/\.(ts|tsx)$/u.test(name)) return []
    if (/\.test\.(ts|tsx)$/u.test(name) || /\.d\.ts$/u.test(name)) return []
    return [path]
  })
}

const files = sourceFiles(srcRoot)
  .map((path) => ({ path, file: relative(root, path).replace(/\\/gu, "/") }))
  .filter(({ file }) => file !== "src/lib/bindings.ts")

const sources = new Map(files.map(({ path, file }) => [file, readFileSync(path, "utf8")]))

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    sources.get(file) ?? "",
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
}

function where(source: ts.SourceFile, node: ts.Node): string {
  const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
  return `${source.fileName}:${line} ${node.getText(source).split("\n")[0].trim().slice(0, 90)}`
}

function failuresOf(visit: (source: ts.SourceFile, report: (node: ts.Node) => void) => void) {
  const found: string[] = []
  for (const { file } of files) {
    const source = parse(file)
    visit(source, (node) => found.push(where(source, node)))
  }
  return found
}

function walk(node: ts.Node, visit: (node: ts.Node) => void) {
  visit(node)
  ts.forEachChild(node, (child) => walk(child, visit))
}

// ---------------------------------------------------------------------------------------------
// 1. No window of the system (docs/notices.md §9, §13)
// ---------------------------------------------------------------------------------------------

// Written in parts so that this file is not its own finding.
const SYSTEM_WINDOWS: Array<[label: string, pattern: RegExp]> = [
  ["window." + "confirm", /\bwindow\s*\.\s*(confirm|alert|prompt)\b/u],
  ["globalThis." + "confirm", /\bglobalThis\s*\.\s*(confirm|alert|prompt)\b/u],
  ["confirm" + "Action", /\bconfirm(Action)\b/u],
  ["show" + "ErrorMessage", /\bshow(ErrorMessage)\b/u],
  ["plugin:dialog|" + "message", /plugin:dialog\|(message|ask|confirm)/u],
]

describe("no window of the system (docs/notices.md §9, §13)", () => {
  it.each(SYSTEM_WINDOWS)("%s is not used in the code of the application", (label, pattern) => {
    const found = [...sources].filter(([, text]) => pattern.test(text)).map(([file]) => file)
    expect(
      found,
      `${label} opens a window of the system. A question is \`confirm()\` from src/lib/confirmations.ts, ` +
        "a message goes to the place of its level (see docs/notices.md §9 and §13).",
    ).toEqual([])
  })

  it("does not ask the system for permission to show message windows", () => {
    for (const name of ["default.json", "settings-window.json"]) {
      const capability = readFileSync(join(root, "src-tauri", "capabilities", name), "utf8")
      expect(capability).not.toContain("dialog:allow-message")
      expect(capability).not.toContain("dialog:allow-ask")
      expect(capability).not.toContain("dialog:allow-confirm")
      // The pickers of a file and a folder are the exception (section 9).
      expect(capability).toContain("dialog:allow-open")
      expect(capability).toContain("dialog:allow-save")
    }
  })
})

// ---------------------------------------------------------------------------------------------
// 2. No raw error text on its way to a person (docs/notices.md §10)
// ---------------------------------------------------------------------------------------------

/** Names under which the code holds a caught or returned failure. */
const FAILURE_NAME =
  /^(?:error|err|e|ex|failure|caught|reason|cause|loadError|reloadFailure|lastError|exception|rejection|problem)$/u

/**
 * Places that may read the text of a failure, each with the reason. A file here is not a licence
 * to put the text on the screen: it is a place where the text is read to be classified, wrapped
 * in a typed error, kept for the debug log or compared with a sentinel. Everything else goes
 * through `operationErrorText` or a dictionary (docs/notices.md §10).
 */
export const RAW_ERROR_TEXT_EXCEPTIONS: Record<string, string> = {
  // Own text, chosen from the dictionary
  "src/lib/operation-errors.ts":
    "`ShownError` carries a text that was already taken from the dictionary where the failure was found.",
  "src/lib/ai.ts":
    "`AiRequestError` builds its message from the `ai.errors.*` dictionary in its constructor.",
  "src/components/workspace/tree/tree-message.tsx":
    "`state.message` is the line under the tree: keys of the locale, not a failure.",
  // Reading a code that is in the text
  "src/lib/app-updater.ts":
    "`updateFailureCode` reads only the kind of an updater failure from its message into a code for the journal; nothing of the text is shown or kept.",
  "src/components/workspace/app-config.ts":
    "Reads the codes our own errors carry as their message (`settingsChanged`); free text gives no code.",
  "src/components/workspace/tiptap/external-open.ts":
    "The backend puts a code into the message of a refusal; the file maps it to a dictionary sentence and shows only that.",
  "src/lib/storage/web-storage-error.ts":
    "Recognises a full or unavailable browser storage by the browser's own error; yields a code.",
  // Boundary adapters: a backend sentence becomes a typed error, and the interface shows the dictionary text by its code
  "src/lib/storage/desktop-adapter.ts":
    "Adapter on the boundary: the backend sentence goes into a typed error (`desktopOperationError`) for the logs.",
  "src/lib/storage/database-types.ts":
    "Builds `DatabaseOperationError`; its `message` is for the logs, the interface uses `reason`/`code`.",
  "src/lib/storage/project-types.ts":
    "Builds `ProjectOperationError`; its `message` is for the logs, the interface uses the kind and `code`.",
  "src/lib/storage/settings-repository.ts":
    "Developer sentence inside the `Error` thrown when a settings file cannot be read; callers show the dictionary text.",
  "src/lib/storage/storage-contract.ts":
    "Assertion text of the storage contract cases that run in Vitest and in the native harness; never shown to a person.",
  // The own diagnostics of a reader
  "src/components/workspace/canvas/canvas-mermaid-dialog.tsx":
    "Remarks of our own Mermaid reader (not a library error), shown beside the code being typed. They are English only: tracked as a follow-up.",
  // Third-party modules: sentences go to the module, and no screen shows them
  "src/lib/modules/community/sandbox.ts":
    "RPC between the host and the code of a community module: the sentences are the module's own, no screen shows them (third-party plugins are deferred).",
  "src/lib/modules/community/isolated-runtime.ts":
    "Same RPC channel, the worker's side and the answer to `executeCode`; no screen shows it.",
}

/** Parsing a sentence to find out what happened: the code says it. */
const PARSED_ERROR_TEXT =
  /\bmessage\.(?:includes|startsWith|match)\(|\/[^/\n]+\/[a-z]*\.test\((?:error|failure|caught|\w+)\.message\)/u

/** The warnings of a successful write, joined or spread into the text of a notice. */
const RAW_WARNINGS =
  /\bdiagnostic\.message\b|\.warnings\.join\(|\[\.\.\.\w+\.warnings\]|\[\.\.\.warnings\]/u

function isFailureName(expression: ts.Expression): boolean {
  let current: ts.Expression = expression
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current)) {
    current = current.expression
  }
  if (ts.isNonNullExpression(current)) return isFailureName(current.expression)
  if (ts.isIdentifier(current)) return FAILURE_NAME.test(current.text)
  if (ts.isPropertyAccessExpression(current)) return FAILURE_NAME.test(current.name.text)
  return false
}

/** Inside the arguments of `logger.…(…)`: the debug log is where the raw text belongs (§13). */
function insideLogger(node: ts.Node): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (
      ts.isCallExpression(parent) &&
      /^(?:logger|log)\.(?:debug|info|warn|error|trace)$/u.test(parent.expression.getText())
    ) {
      return true
    }
  }
  return false
}

function rawErrorText(): string[] {
  return failuresOf((source, report) => {
    if (RAW_ERROR_TEXT_EXCEPTIONS[source.fileName]) return
    walk(source, (node) => {
      // Any `.message`: whatever it is read from, it is the sentence of somebody else's code.
      if (
        ts.isPropertyAccessExpression(node) &&
        node.name.text === "message" &&
        node.expression.kind !== ts.SyntaxKind.ThisKeyword &&
        !insideLogger(node)
      ) {
        report(node)
      }
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "String" &&
        node.arguments.length === 1 &&
        isFailureName(node.arguments[0]) &&
        !insideLogger(node)
      ) {
        report(node)
      }
    })
  })
}

describe("raw error text (docs/notices.md §10)", () => {
  it("does not read the text of a failure outside the places that translate it", () => {
    expect(
      rawErrorText(),
      "A person sees our text for the failure, never what Rust, the OS, a module or a library said. " +
        "Take the text from `operationErrorText` / a dictionary by the code or the kind of the error, " +
        "and put the raw text into `logger` with `operationErrorCode(error)` (docs/notices.md §10, §13). " +
        "A place that only classifies or wraps the text goes into RAW_ERROR_TEXT_EXCEPTIONS with its reason.",
    ).toEqual([])
  })

  it("does not parse the sentence of an error in a component", () => {
    const found: string[] = []
    for (const [file, text] of sources) {
      if (!file.startsWith("src/components/")) continue
      text.split("\n").forEach((line, index) => {
        if (line.trimStart().startsWith("//")) return
        if (PARSED_ERROR_TEXT.test(line))
          found.push(`${file}:${index + 1} ${line.trim().slice(0, 90)}`)
      })
    }
    expect(
      found,
      "Find out what happened from the code or the kind of the error (`isNotFoundError`, `isRevisionConflict`, " +
        "`error.reason`), never from its sentence; the code is the contract, the sentence is not " +
        "(docs/notices.md §10).",
    ).toEqual([])
  })

  it("does not show the warnings of a write as they came", () => {
    const found: string[] = []
    for (const [file, text] of sources) {
      if (!file.startsWith("src/components/")) continue
      text.split("\n").forEach((line, index) => {
        if (line.trimStart().startsWith("//")) return
        if (RAW_WARNINGS.test(line)) found.push(`${file}:${index + 1} ${line.trim().slice(0, 90)}`)
      })
    }
    expect(
      found,
      "Warnings that come back with a write are backend sentences: show `warningNotices(warnings)` " +
        "(src/lib/operation-errors.ts), not the list itself (docs/notices.md §10).",
    ).toEqual([])
  })

  it("lists only exceptions that still exist", () => {
    const stale = Object.keys(RAW_ERROR_TEXT_EXCEPTIONS).filter((file) => !sources.has(file))
    expect(stale, "Remove the exception: the file is gone.").toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------
// 3. A swallowed error says why (docs/notices.md §13)
// ---------------------------------------------------------------------------------------------

/**
 * The reason for a silent `.catch(…)` stands on its line (inside the callback or after it), on the line above
 * the `.catch`, or on the line above the statement it belongs to.
 */
function hasComment(source: ts.SourceFile, call: ts.CallExpression): boolean {
  const lines = source.text.split("\n")
  const lineOf = (position: number) => source.getLineAndCharacterOfPosition(position).line
  const isComment = (line: string | undefined) => {
    const trimmed = line?.trim() ?? ""
    return trimmed.startsWith("//") || trimmed.endsWith("*/") || trimmed.startsWith("/*")
  }
  const access = call.expression as ts.PropertyAccessExpression
  const first = lineOf(access.name.getStart(source))
  const last = lineOf(call.getEnd())
  if (lines.slice(first, last + 1).some((line) => /\/\/|\/\*/u.test(line))) return true
  if (isComment(lines[first - 1])) return true
  let statement: ts.Node = call
  while (statement.parent && !ts.isStatement(statement)) statement = statement.parent
  return isComment(lines[lineOf(statement.getStart(source)) - 1])
}

function isSilentCallback(node: ts.Expression | undefined): boolean {
  if (!node) return false
  if (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node)) return false
  const body = node.body
  if (ts.isBlock(body)) return body.statements.length === 0
  if (ts.isIdentifier(body)) return body.text === "undefined"
  if (body.kind === ts.SyntaxKind.NullKeyword) return true
  return ts.isVoidExpression(body)
}

function silentCatches(): string[] {
  return failuresOf((source, report) => {
    walk(source, (node) => {
      // `catch {}` and `catch (error) {}`
      if (ts.isCatchClause(node) && node.block.statements.length === 0) {
        if (!/\/\/|\/\*/u.test(node.block.getText(source))) report(node)
      }
      // `.catch(() => {})`, `.catch(() => undefined)`, `.catch(() => null)`
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "catch" &&
        isSilentCallback(node.arguments[0]) &&
        !hasComment(source, node)
      ) {
        report(node)
      }
    })
  })
}

describe("swallowed errors (docs/notices.md §13)", () => {
  it("never swallows an error without saying why", () => {
    expect(
      silentCatches(),
      "A swallowed error needs a comment that says why nobody can do anything with it, and, unless it is plain " +
        "clean-up, a `logger.warn`/`logger.debug` with a code. If the data of the person is touched, do not " +
        "swallow it at all (docs/notices.md §13).",
    ).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------
// 4. Colours of a notice are tokens (docs/notices.md §11)
// ---------------------------------------------------------------------------------------------

/** Where notices are drawn: their directories and the files that draw a notice elsewhere. */
const NOTICE_PLACES = [
  "src/components/workspace/notices/",
  "src/components/workspace/note-notices/",
  "src/components/workspace/sync/",
  "src/components/workspace/settings/settings-package-manager.tsx",
  "src/components/workspace/tree/tree-message.tsx",
]

const PALETTE_CLASS =
  /\b(?:text|bg|border|ring|fill|stroke|from|to|via|divide|outline|decoration|accent|shadow)-(?:amber|red|yellow|orange|rose|green|emerald|lime|sky|blue|cyan|teal|indigo|violet|purple|fuchsia|pink)-\d/u

describe("colours of a notice (docs/notices.md §11)", () => {
  it("draws notices with the --notice-* tokens, not a palette class", () => {
    const found: string[] = []
    for (const [file, text] of sources) {
      if (!NOTICE_PLACES.some((place) => file.startsWith(place))) continue
      text.split("\n").forEach((line, index) => {
        if (PALETTE_CLASS.test(line)) found.push(`${file}:${index + 1} ${line.trim().slice(0, 90)}`)
      })
    }
    expect(
      found,
      "A level has one colour in every theme: use NoticeLevel / the `--notice-<level>-{bg,fg,border}` tokens " +
        "(src/themes/app.css), not `text-amber-500` and the like (docs/notices.md §11).",
    ).toEqual([])
  })
})

/**
 * Property editors and cells of the databases and of the note panel: a refusal there is a line under the
 * element (docs/notices.md, section 8) drawn by `NoticeLine` at its level, not a red `text-destructive` text.
 * A destructive action (a delete item that is red on hover) is not a message and may keep the colour.
 */
const PROPERTY_ERROR_PLACES = [
  "src/components/workspace/database/property-config-editor.tsx",
  "src/components/workspace/database/relation-settings.tsx",
  "src/components/workspace/database/rollup-settings.tsx",
  "src/components/workspace/database/option-edit-menu.tsx",
  "src/components/workspace/database/option-cell.tsx",
  "src/components/workspace/database/database-cell.tsx",
  "src/components/workspace/database/date-cell.tsx",
  "src/components/workspace/panels/property-editor.tsx",
  "src/components/workspace/panels/property-options-editor.tsx",
  "src/components/workspace/panels/property-dormant-list.tsx",
  "src/components/workspace/panels/info-panel-body.tsx",
]

describe("refusals of property editors and cells (docs/notices.md §8, §11)", () => {
  it("are NoticeLine / level tokens, not a red `text-destructive` message", () => {
    const found: string[] = []
    for (const file of PROPERTY_ERROR_PLACES) {
      const text = sources.get(file)
      expect(text, `${file} is listed in PROPERTY_ERROR_PLACES but does not exist`).toBeDefined()
      text!.split("\n").forEach((line, index) => {
        if (
          /role="alert"[^>]*text-destructive|(?:error|failed)\s*&&\s*"text-destructive"|\?\s*"text-destructive"\s*$/u.test(
            line,
          )
        ) {
          found.push(`${file}:${index + 1} ${line.trim().slice(0, 90)}`)
        }
      })
    }
    expect(
      found,
      "A refusal under a property editor or in a cell is a `NoticeLine` (notices/notice-line.tsx) at the level " +
        "`warning`, and a cell's own mark is `noticeTextClass(level)`; the colour is the `--notice-*` token, " +
        "not `text-destructive` (docs/notices.md §8, §11).",
    ).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------
// 5. One host of toasts (docs/notices.md §6)
// ---------------------------------------------------------------------------------------------

const TOAST_LIBRARIES = /["'](?:sonner|react-hot-toast|react-toastify|@radix-ui\/react-toast)["']/u
const TOAST_HOST = "src/components/workspace/notices/notice-toasts-host.tsx"
const TOAST_STORE = "src/components/workspace/notices/use-notice-toasts-store.ts"

describe("toasts (docs/notices.md §6)", () => {
  it("has the shared host and no other", () => {
    const libraries = [...sources].filter(([, text]) => TOAST_LIBRARIES.test(text)).map(([f]) => f)
    expect(
      libraries,
      "Toasts come only from `useNoticeToastStore.announce` drawn by the host in notices/ (docs/notices.md §6).",
    ).toEqual([])

    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>
    }
    const toastPackages = Object.keys(manifest.dependencies ?? {}).filter((name) =>
      /toast|sonner/u.test(name),
    )
    expect(
      toastPackages,
      "A second toast library means a second host (docs/notices.md §6).",
    ).toEqual([])

    // Only the host reads the list of toasts to draw it.
    const readers = [...sources]
      .filter(
        ([file, text]) => file !== TOAST_HOST && file !== TOAST_STORE && /\.toasts\b/u.test(text),
      )
      .map(([file]) => file)
    expect(
      readers,
      "Draw toasts in the shared host (notice-toasts-host.tsx), and announce through `announce`; " +
        "a second list of toasts is a second host (docs/notices.md §6).",
    ).toEqual([])

    const hosts = [...sources]
      .filter(
        ([file, text]) => file !== TOAST_HOST && /\b(?:Toaster|ToastsHost|ToastHost)\b/u.test(text),
      )
      .map(([file]) => file)
    expect(hosts, "There is one toast host: notice-toasts-host.tsx (docs/notices.md §6).").toEqual(
      [],
    )
  })
})
