const DENSITY_SELECTOR = 'html[data-density="compact"]'
const SCALE_VARIABLE = "var(--app-density-spacing-scale, 0.5)"

const SPACING_PROPERTIES = new Set([
  "padding",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "padding-block",
  "padding-block-start",
  "padding-block-end",
  "padding-inline",
  "padding-inline-start",
  "padding-inline-end",
  "margin",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "margin-block",
  "margin-block-start",
  "margin-block-end",
  "margin-inline",
  "margin-inline-start",
  "margin-inline-end",
  "gap",
  "row-gap",
  "column-gap",
])

const UNSCALED_VALUES = new Set([
  "auto",
  "inherit",
  "initial",
  "normal",
  "none",
  "revert",
  "revert-layer",
  "unset",
])

/** Splits a CSS shorthand at whitespace while keeping function arguments intact. */
function splitTopLevel(value) {
  const parts = []
  let part = ""
  let depth = 0
  let quote = null

  for (const character of value.trim()) {
    if (quote) {
      part += character
      if (character === quote) quote = null
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
      part += character
      continue
    }
    if (character === "(") depth += 1
    if (character === ")") depth = Math.max(0, depth - 1)
    if (/\s/.test(character) && depth === 0) {
      if (part) parts.push(part)
      part = ""
    } else {
      part += character
    }
  }
  if (part) parts.push(part)
  return parts
}

function scaleSpacingValue(value, property) {
  const minimum = property.startsWith("padding")
    ? "var(--app-density-padding-min, 0.25rem)"
    : property === "gap" || property === "row-gap" || property === "column-gap"
      ? "var(--app-density-gap-min, 0.25rem)"
      : property.startsWith("margin")
        ? "var(--app-density-margin-min, 0.125rem)"
        : null

  return splitTopLevel(value)
    .map((part) => {
      if (UNSCALED_VALUES.has(part.toLowerCase()) || /^0(?:[a-z%]+)?$/i.test(part)) return part
      const scaled = `calc((${part}) * ${SCALE_VARIABLE})`
      // Keep tiny icon/button hit areas and one-pixel visual gaps usable. The
      // minimum only applies to positive spacing; negative margins still scale
      // exactly so positioning hacks retain their direction and intent.
      return minimum && !part.trim().startsWith("-") ? `max(${minimum}, ${scaled})` : scaled
    })
    .join(" ")
}

/** Splits a selector list without breaking commas inside :is(), :where(), or attributes. */
function splitSelectors(value) {
  const selectors = []
  let selector = ""
  let depth = 0
  let bracketDepth = 0
  let quote = null

  for (const character of value) {
    if (quote) {
      selector += character
      if (character === quote) quote = null
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
      selector += character
      continue
    }
    if (character === "(") depth += 1
    if (character === ")") depth = Math.max(0, depth - 1)
    if (character === "[") bracketDepth += 1
    if (character === "]") bracketDepth = Math.max(0, bracketDepth - 1)
    if (character === "," && depth === 0 && bracketDepth === 0) {
      selectors.push(selector.trim())
      selector = ""
    } else {
      selector += character
    }
  }
  if (selector.trim()) selectors.push(selector.trim())
  return selectors
}

function shouldSkipSelector(selector) {
  // Note content spacing and generated PDF layout are document semantics, not
  // interface density. Existing compact selectors are already intentionally
  // tuned and must not be scaled a second time.
  return (
    selector.includes(".amby-tiptap") ||
    selector.includes(".md-body") ||
    selector.includes(".amby-read-body") ||
    selector.includes(".amby-source-editor") ||
    selector.includes(".amby-pdf-export-root") ||
    selector.includes(".cm-") ||
    selector.includes("data-density")
  )
}

function compactSelector(selector) {
  return splitSelectors(selector)
    .map((part) => `${DENSITY_SELECTOR} ${part}`)
    .join(",\n")
}

/**
 * Duplicates spacing rules under the compact-density scope. Running this after
 * Tailwind means responsive and arbitrary-value utilities are covered too.
 */
export function densityScalePlugin() {
  return {
    postcssPlugin: "amby-density-scale",
    OnceExit(root) {
      const candidates = []
      root.walkRules((rule) => {
        if (!rule.selector || shouldSkipSelector(rule.selector)) return
        const spacingDeclarations = []
        rule.walkDecls((decl) => {
          if (SPACING_PROPERTIES.has(decl.prop)) spacingDeclarations.push(decl)
        })
        if (spacingDeclarations.length > 0) candidates.push({ rule, spacingDeclarations })
      })

      for (const { rule, spacingDeclarations } of candidates) {
        // Copy only spacing declarations. Cloning the whole rule would repeat
        // font, color, display, and sizing declarations under the compact
        // selector, unexpectedly changing the cascade when density toggles.
        const compactRule = rule.clone({ selector: compactSelector(rule.selector) })
        compactRule.removeAll()
        for (const declaration of spacingDeclarations) {
          compactRule.append(
            declaration.clone({
              value: scaleSpacingValue(declaration.value, declaration.prop),
            }),
          )
        }
        rule.parent.insertAfter(rule, compactRule)
      }
    },
  }
}

densityScalePlugin.postcss = true
