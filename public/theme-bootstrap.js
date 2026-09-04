;(function () {
  try {
    var stored =
      globalThis.localStorage.getItem("amby:theme-mode") ||
      globalThis.localStorage.getItem("theme") ||
      "dark"
    var dark =
      stored === "dark" ||
      (stored === "system" && globalThis.matchMedia("(prefers-color-scheme: dark)").matches)
    globalThis.document.documentElement.classList.toggle("dark", dark)
    globalThis.document.documentElement.style.colorScheme = dark ? "dark" : "light"
  } catch {
    globalThis.document.documentElement.classList.add("dark")
    globalThis.document.documentElement.style.colorScheme = "dark"
  }
})()
