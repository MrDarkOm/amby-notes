// Paste into the console with a Live Preview note open. Prints the left edge of the title
// text and of the first body block; after UI-04 the difference must be 0 (±0.5px).
;(() => {
  const title = document.querySelector("textarea")
  const pm = document.querySelector(".ProseMirror")
  const first = pm?.firstElementChild
  if (!title || !first) return "open a note with body text first"
  const range = document.createRange()
  range.selectNodeContents(first)
  const bodyX = range.getClientRects()[0]?.x
  const titleX = title.getBoundingClientRect().x + parseFloat(getComputedStyle(title).paddingLeft)
  return { titleX, bodyX, delta: +(bodyX - titleX).toFixed(1), viewport: innerWidth }
})()
