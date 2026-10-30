# Product website

| Owner                                                                                            | Responsibility                                                                                                                                    |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| [index.html](index.html)                                                                         | Single-page Russian/English landing page, theme, downloads from GitHub releases, demo frame and theme synchronization                             |
| [demo/index.html](demo/index.html), [demo/main.ts](demo/main.ts)                                 | Separate browser entry importing the real [application entry](../src/main.tsx); prepared notes and in-memory browser Storage, recreated on reload |
| [assets/](assets/)                                                                               | Website brand assets                                                                                                                              |
| [../vite.site.config.ts](../vite.site.config.ts), [../tsconfig.site.json](../tsconfig.site.json) | Demo build and type checking, separate from desktop build                                                                                         |
| [../scripts/build-site.mjs](../scripts/build-site.mjs)                                           | `npm run build:site`: builds demo, then copies landing page and assets to ignored `build/site/`                                                   |

Deploy the complete `build/site/` directory, not the source `site/` directory:
the demo requires the compiled application chunks. No desktop bridge is exposed.
The iframe uses the existing browser storage adapter. Its Storage objects are
replaced only in this separate entry with a memory implementation before app
imports; demo edits never reach a visitor's persistent browser storage or disk.
The browser fallback cannot demonstrate desktop-only history, files, sync,
databases or creative workshop operations. Landing-page descriptions cover the
desktop product; the demo exposes the application’s browser-supported controls.

`amby-demo-theme` messages accept only light/dark themes from the same-origin
parent window. The initial URL carries language and theme; a ready handshake
synchronizes any theme change during startup. Theme changes update the app's
preferences in memory without reloading or losing edits. Language changes and
reset reload the demo with the current theme. There are no external scenario tabs.
The site-only build flag disables settings and workspace switching, removes native
window-control space and aligns the left sidebar toggle with the far left activity
dock. Desktop controls are unchanged.

For verification build the site, serve `build/site/`, check the real editor,
wiki links, graph, theme synchronization without losing edits, language, reset and narrow viewports.
Main application ownership: [frontend](../src/MAP.md).
