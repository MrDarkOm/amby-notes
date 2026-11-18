// Paste into the devtools console. Reports visible text below WCAG AA (4.5:1, 3:1 for large text),
// blending alpha colours, element opacity and stacked translucent backgrounds.
;(() => {
  const parse = (c) => {
    const m = c.match(/rgba?\(([^)]+)\)/)
    if (!m) return null
    const p = m[1]
      .split(/[ ,/]+/)
      .filter(Boolean)
      .map(Number)
    return [p[0], p[1], p[2], p[3] === undefined ? 1 : p[3]]
  }
  const lum = ([r, g, b]) => {
    const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
  }
  const blend = (fg, bg) => [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3]))
  const bgOf = (el) => {
    const layers = []
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      const c = parse(getComputedStyle(e).backgroundColor)
      if (c && c[3] > 0) {
        layers.push(c)
        if (c[3] >= 1) break
      }
    }
    let base = document.documentElement.classList.contains("dark") ? [0, 0, 0] : [255, 255, 255]
    for (let i = layers.length - 1; i >= 0; i--) base = blend(layers[i], base)
    return base
  }
  const out = []
  const seen = new Set()
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  for (let n; (n = w.nextNode());) {
    const t = n.textContent.trim()
    const el = n.parentElement
    if (!t || seen.has(el)) continue
    seen.add(el)
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    if (!r.width || !r.height || cs.visibility === "hidden") continue
    let op = 1
    for (let e = el; e; e = e.parentElement) op *= parseFloat(getComputedStyle(e).opacity)
    const fg = parse(cs.color)
    if (!fg) continue
    const bg = bgOf(el)
    const f = blend([fg[0], fg[1], fg[2], fg[3] * op], bg)
    const L1 = lum(f),
      L2 = lum(bg)
    const cr = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05)
    const fs = parseFloat(cs.fontSize)
    const need = fs >= 24 || (fs >= 18.66 && +cs.fontWeight >= 700) ? 3 : 4.5
    if (cr < need) out.push({ text: t.slice(0, 40), ratio: +cr.toFixed(2), fontSize: fs })
  }
  return out
})()
