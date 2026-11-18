// Paste into the devtools console (browser preview, `npm run dev`).
// Press Shift once first so Chromium treats the next programmatic focus as keyboard focus.
// Lists visible focusable controls whose own computed style does not change on :focus-visible.
// Pseudo-element focus styles are not inspected; confirm suspects visually.
;(() => {
  const sel =
    'button,[role=button],[role=tab],a[href],input,select,textarea,[tabindex]:not([tabindex="-1"])'
  const els = [...document.querySelectorAll(sel)].filter((e) => {
    const r = e.getBoundingClientRect()
    return r.width > 0 && r.height > 0 && !e.disabled
  })
  const snap = (e) => {
    const c = getComputedStyle(e)
    return [
      c.outlineStyle + c.outlineWidth + c.outlineColor,
      c.boxShadow,
      c.backgroundColor,
      c.borderColor,
      c.color,
    ].join("|")
  }
  const bad = []
  for (const e of els) {
    document.activeElement?.blur()
    const a = snap(e)
    e.focus({ preventScroll: true })
    if (document.activeElement !== e || !e.matches(":focus-visible")) continue
    if (a === snap(e))
      bad.push((e.getAttribute("aria-label") || e.textContent.trim() || e.tagName).slice(0, 40))
  }
  document.activeElement?.blur()
  return { total: els.length, noIndicator: bad.length, list: bad }
})()
