import { readFileSync, readdirSync, statSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { localeResources } from "./resources"

const sourceRoot = fileURLToPath(new URL("../", import.meta.url))

const leafKeys = (value: Record<string, unknown>, prefix = ""): string[] =>
  Object.entries(value).flatMap(([name, child]) =>
    typeof child === "object" && child !== null
      ? leafKeys(child as Record<string, unknown>, `${prefix}${name}.`)
      : [`${prefix}${name}`],
  )

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = `${dir}${name}`
    if (statSync(path).isDirectory()) return sourceFiles(`${path}/`)
    // Tests count as users: a test that names a key states that the key must exist.
    return /\.tsx?$/u.test(name) && name !== "unused-keys.test.ts" ? [path] : []
  })

/**
 * Prefixes of keys that are built at run time and so never appear whole in the code. They are
 * found in the code itself: a string that starts like a key and continues with `${...}`
 * (`t(`help.guide.tips.${id}`)`, `t(`docEditor.copyPath_${mode}`)`). Everything under such a
 * prefix counts as used. Add a prefix here only when a key is built in a way that scan cannot
 * see (for example from two variables), and say where it is built.
 */
const manualDynamicPrefixes: readonly string[] = []

const pluralSuffix = /_(?:zero|one|two|few|many|other)$/u

describe("localization resources", () => {
  it("have no key that nothing in the code uses", () => {
    const keys = leafKeys(localeResources.ru.translation)
    const roots = new Set(Object.keys(localeResources.ru.translation))
    const resourcesSource = readFileSync(`${sourceRoot}locales/resources.ts`, "utf8")
    // The part of the resources file before the dictionaries holds real references
    // (the language names of SUPPORTED_LANGUAGES).
    const text = [
      ...sourceFiles(sourceRoot)
        .filter((path) => !path.endsWith("/locales/resources.ts"))
        .map((path) => readFileSync(path, "utf8")),
      resourcesSource.slice(0, resourcesSource.indexOf("const ru = {")),
    ].join("\n")

    const dynamicPrefixes = [
      // `foo.bar.${x}`, `foo.bar_${x}`
      ...text.matchAll(/["'`]([A-Za-z]\w*(?:\.\w+)*[._]?)(?=\$\{)/gu),
      // "foo.bar." + x
      ...text.matchAll(/["'`]([A-Za-z]\w*(?:\.\w+)*\.)(?=["'`])/gu),
    ]
      .map((match) => match[1])
      .filter((prefix) => roots.has(prefix.split(".")[0]))
    dynamicPrefixes.push(...manualDynamicPrefixes)

    const unused = keys.filter(
      (key) =>
        !text.includes(key.replace(pluralSuffix, "")) &&
        !dynamicPrefixes.some((prefix) => key.startsWith(prefix)),
    )
    expect(unused).toEqual([])
  }, 60_000)
})
