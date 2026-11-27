;(function () {
  try {
    var stored =
      globalThis.localStorage.getItem("amby:theme-mode") ||
      globalThis.localStorage.getItem("theme") ||
      "dark"
    var background = globalThis.localStorage.getItem("amby:theme-background")
    if (background && /^[0-9.%+\-\s/]+$/.test(background)) {
      globalThis.document.documentElement.style.setProperty("--background", background)
    }
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
