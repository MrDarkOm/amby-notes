# UI/UX polish audit — 2026-11-18

Status: evidence at a date, not a contract. No fixes were made during the audit.

Goal: find objective defects in the existing interface and propose the smallest fix for
each. The current visual direction (layout, dock, rounded panels, accent, typography,
motion) is the reference and is not questioned here.

## Method and coverage

- Branch `dev` at `5d265ef0`, browser preview (`npm run dev`, localStorage web adapter) in
  Chromium, device pixel ratio 2 (HiDPI), windows 900×640, 1024×768, 1280×800, 1440×900,
  dark and light modes, default theme, violet accent, font size Medium and Large.
- Every claim below is backed by a screenshot in [shots/](shots/), a DOM/computed-style
  measurement taken in the running page, or a cited source line. Source-only findings are
  marked **(code)**: the defect is certain from the code, but the screen was not rendered.
- Reusable checks: [focus-audit.js](scripts/focus-audit.js),
  [contrast-audit.js](scripts/contrast-audit.js),
  [title-body-alignment.js](scripts/title-body-alignment.js) (paste into the console).

### Not verified (state explicitly, do not assume)

- Native shells: macOS WKWebView, Windows WebView2, Linux WebKitGTK were **not** run.
  Title bar, native traffic lights, window resizing, font rendering, scrollbar overlay and
  Windows 125/150 % scaling are therefore unverified.
- Screens that need the desktop runtime or data the web vault lacks: database views
  (creation fails in the web adapter), canvas, Excalidraw, graph, Creative, history with real
  versions, sync, AI, export, deep folder paths, nested-note chips.
- Hover/pressed states were sampled (tree, menus, dock), not exhaustively.

## Severity scale

- **High** — blocks or misleads a class of users (keyboard, low vision) or loses state.
- **Medium** — visible inconsistency or wrong information, workaround exists.
- **Low** — polish; noticeable to an attentive eye.

## Findings

### UI-01 · High · Most controls have no keyboard focus indicator

- **Where:** dock (both rails), tab bar, header buttons, editor status bar, panel toggles.
- **What:** `app.css:3777` removes the outline for every element on `:focus` and
  `:focus-visible`. Components that add their own ring (tree rows, shadcn `Button`) are fine;
  everything else shows nothing. In the running page 28 of 44 visible focusable controls do
  not change at all on `:focus-visible` (e.g. «Теги»: `matches(':focus-visible') === true`,
  outline none, box-shadow none, no pseudo-element ring).
- **Why:** WCAG 2.4.7; keyboard users cannot see where they are.
- **Minimal fix:** keep `outline: none` for `:focus`, and give `:where(*):focus-visible` a
  token ring instead (`outline: 2px solid hsl(var(--ring)); outline-offset: 1px`). Zero
  specificity means component rings still win. Exclude text-entry surfaces
  (`input`, `textarea`, `[contenteditable]`, `.cm-content`) which show a caret.
- **Files:** `src/themes/app.css` (one rule).
- **Check:** Tab through dock, tabs, status bar in both modes; `focus-audit.js` → 0 (or only
  justified exceptions); mouse click must not show the ring.

### UI-02 · High · Destructive menu items use hard-coded dark-theme reds

- **Where:** tree context menu «Удалить» ([07-context-menu-light.jpg](shots/07-context-menu-light.jpg)),
  vault manager, document actions, page menu, Settings → Data.
- **What:** `text-red-400 focus:text-red-300` instead of the existing destructive variant.
  Measured on the light menu: `rgb(248,113,113)` on white = **2.77:1**; it reads as disabled.
  `settings-data.tsx:99` uses `text-red-300 hover:bg-red-950/30` (dark-only colours) in light.
- **Why:** contrast (WCAG 1.4.3) and a false "disabled" signal on the most dangerous action;
  portable themes cannot recolour it.
- **Minimal fix:** `variant="destructive"` on the Radix menu items (already styled with
  `text-destructive`, ≈4.7:1 light) or `text-destructive` / `hover:bg-destructive/10`.
- **Files:** `tree/tree-row.tsx:446,465`, `vault/vault-manager.tsx:191`,
  `editor/document-actions.tsx:76`, `page-chrome/page-menu.tsx:20`,
  `settings/settings-data.tsx:99`, `editor/document-menu.tsx:361` (icon).
- **Check:** `contrast-audit.js` with each menu open in light and dark; existing menu tests.

### UI-03 · High · File tree: two Tab stops per row, nested interactive control

- **Where:** file tree (also favourites list, which reuses the row).
- **What:** observed Tab order: tree container → row → its type/favourite icon → next row →
  its icon → … The favourite toggle is `<span role="button" tabindex="0">` **inside**
  `<button role="treeitem">` (`tree-icons.tsx` `TreeItemStatusIcon`). The 14×14 target is
  intentional design, the tab stops are not.
- **Why:** a tree should be one Tab stop with arrow-key navigation; nested interactive
  elements are invalid and confuse screen readers; with many rows Tab cannot leave the tree.
- **Minimal fix:** `tabIndex={-1}` on the status toggle (mouse click stays; keyboard users
  have «Добавить в избранное» in the context menu); keep a single roving `tabIndex=0` on the
  active row and `-1` on the rest; the container should not be a separate stop when a row is
  focusable (or use `aria-activedescendant`, not both).
- **Files:** `tree/tree-icons.tsx`, `tree/tree-row.tsx`, tree container in `panels/files-panel.tsx`.
- **Check:** Tab enters the tree once and leaves to «Создать» next; arrows move; Enter opens;
  `tree-icons.test.tsx`, `sidebar-tree.test.tsx`, `favorites-*.test.tsx` stay green.

### UI-04 · Medium · Note title is not aligned with body text

- **Where:** every Live Preview note ([06-compact-900-title-offset.jpg](shots/06-compact-900-title-offset.jpg),
  [01-note-1024-dark.jpg](shots/01-note-1024-dark.jpg)).
- **What:** title textarea text starts at x=389, first body block at x=401 (1024 px window):
  `.amby-tiptap .ProseMirror` has `padding-inline: clamp(0.5rem, 1.5vw, 0.75rem)`, the title
  has `p-0`. Offset varies 8–12 px with window width.
- **Why:** the strongest vertical edge of the page is broken; visible at a glance.
- **Minimal fix:** move the clamp into one variable (e.g. `--amby-editor-inline-pad`) and apply
  it to the title row as `padding-inline-start`, so both share it. Do not remove the body
  padding (block handles rely on it).
- **Files:** `src/themes/app.css:754`, `editor/document-title.tsx:205`; check
  `database/database-title-header.tsx:104` for the same pattern.
- **Check:** `title-body-alignment.js` → delta 0 at 900/1280/1440; Source mode, read-only,
  focus mode, page icon present/absent, database title.

### UI-05 · Medium · Light theme: switch "off" state is nearly invisible

- **Where:** all `Switch` controls in light mode ([03-settings-appearance-light.jpg](shots/03-settings-appearance-light.jpg),
  «Градиентное окрашивание дерева»).
- **What:** unchecked track `rgb(212,215,222)` on a white card ≈ **1.45:1**; thumb
  `rgb(246,247,249)` has no shadow, so the knob merges with the track. Dark mode is fine.
- **Why:** WCAG 1.4.11 (3:1 for control boundaries); off looks like "missing control".
- **Minimal fix:** light-only: thumb `shadow-sm` (or `ring-1 ring-black/10`) and unchecked
  track one step darker (e.g. `bg-muted-foreground/30`), keeping dark classes as they are.
- **Files:** `src/components/ui/switch.tsx`.
- **Check:** Settings in light/dark, all accents; disabled switch still looks disabled.

### UI-06 · Medium · Emoji picker uses emoji-mart's blue accent and Apple-only font

- **Where:** page icon / emoji picker ([11b-emoji-picker-zoom.png](shots/11b-emoji-picker-zoom.png)):
  blue category underline and search focus ring next to violet Amby tabs.
- **What:** `em-emoji-picker` in `app.css:2820` sets background/border only; `--color-accent`
  and `--color-foreground` fall back to emoji-mart defaults (`rgb(58,130,247)`), and
  `--font-family` is `-apple-system, BlinkMacSystemFont, "Helvetica Neue"` (generic sans on
  Windows/Linux). Glyphs themselves are Noto — correct.
- **Minimal fix:** add `--color-accent: hsl(var(--primary)); --color-foreground:
hsl(var(--foreground)); --font-family: inherit;` (or the app font variable).
- **Files:** `src/themes/app.css` (em-emoji-picker block).
- **Check:** picker in both modes and every accent; search focus ring and category bar follow
  the accent; native WebKit check of the shadow-DOM fallback styles.

### UI-07 · Medium · Shortcut labels ignore the platform

- **What:** editor status bar says «Отменить (Ctrl+Z)» / «Повторить (Ctrl+Y)» on macOS
  (correct: ⌘Z / ⇧⌘Z); canvas and sketch say «(⌘Z)» on Windows/Linux; code-block hint
  «⌘↵ … » and link hint «⌘K / Ctrl+K» are fixed strings. Empty-state chips already render
  per-platform (⌘ N), and `ai/model-picker.tsx:23` has a platform formatter.
- **Files:** `locales/resources.ts:2200,2226,2375-2376` and English twins
  `6459,6485,6634-6635`; `canvas/canvas-toolbar.tsx:250`, `sketch/sketch-editor.tsx:958`.
- **Minimal fix:** strings take `{{shortcut}}`; one shared formatter (reuse the existing one,
  move to `src/lib/keyboard.ts` if needed) fills it.
- **Check:** `localization-guard.test.ts`; tooltip text with `navigator.platform` mocked
  Mac/Win.

### UI-08 · Medium · "Show in file manager" names the wrong OS

- **What:** Russian «Показать в проводнике» (Windows Explorer), English «Show in Finder»
  (macOS) — on every OS. Vault picker uses a third verb («Открыть в проводнике»).
- **Files:** `resources.ts:2279,2584,2703,6538,6843`; call sites `tree/tree-row.tsx:432`,
  `panels/files-panel.tsx:704`, `editor/document-menu.tsx:497`, `creative/project-page.tsx:412`,
  `vault/vault-manager.tsx:185`.
- **Minimal fix:** three keys per language (Finder / Explorer / file manager) picked by
  platform; same verb («Показать») everywhere.
- **Check:** localization guard; context menu on each OS.

### UI-09 · Medium · Tree: hovered row looks identical to the selected row

- **Where:** [12-tree-hover-equals-selected.png](shots/12-tree-hover-equals-selected.png) — «Notes» is
  selected, «Welcome» is hovered; they are indistinguishable.
- **What:** selected = `bg-accent`, hover = `hover:bg-accent`; only rainbow mode
  (`app.css:3792`) styles `data-tree-selected`. The tree is multi-selectable, so the ambiguity
  matters (which rows will a bulk action touch?).
- **Minimal fix:** hover one step lighter (`hover:bg-accent/60`), selected unchanged.
  (Alternative that changes the selected look instead: see optional O1.)
- **Files:** `tree/tree-row.tsx` (row class).
- **Check:** hover over selected, unselected, multi-selected rows in both modes, compact density.

### UI-10 · Low · Settings selects come in two sizes; long values crowd the chevron

- **Where:** Settings → General ([02-settings-general-dark.jpg](shots/02-settings-general-dark.jpg)).
- **What:** Radix `Select` triggers are 176×36 with a 16 px chevron; «Канал обновлений»
  (`AmbySelect`) is 176×32 with a 14 px chevron. «В системную корзину» pushes the chevron to
  1 px from the right padding edge (others: 13 px), because the value span does not truncate.
- **Minimal fix:** same size token for both triggers in settings rows; value span
  `min-w-0 truncate` so the chevron keeps its inset (tooltip/title shows the full value).
- **Files:** `components/ui/select.tsx`, `components/ui/amby-select.tsx`,
  `settings/settings-updates.tsx`.
- **Check:** every Settings section, Russian and English (longest strings), font size Large.

### UI-11 · Low · Settings comboboxes have no accessible name

- **What:** triggers expose only the value («Тёмная, combobox»), no `aria-label`/
  `aria-labelledby` to the row title («Режим темы»).
- **Minimal fix:** give each row label an id and pass `aria-labelledby` to the trigger
  (one place if rows share a component).
- **Check:** accessibility tree (`read_page`) shows "Режим темы".

### UI-12 · Medium · Narrowing the window and widening it again loses both panels

- **What:** below 960 px (`use-sidebar-layout.ts:17`) both panels auto-close; when the window
  grows back they stay closed ([05-compact-collapse-midframe.jpg](shots/05-compact-collapse-midframe.jpg)
  shows the collapse; after returning to 1280 px both panels were hidden). One time after this
  transition the right-panel toggle read «Скрыть правую панель» while the panel was hidden —
  observed once, not reproduced.
- **Minimal fix:** store the open state before entering compact mode in a ref and restore it
  when leaving compact mode (only if the user did not toggle panels meanwhile).
- **Files:** `workspace/use-sidebar-layout.ts:117-126`.
- **Check:** unit test for compact → wide; manual drag-resize of the native window.

### UI-13 · Medium · Main window has no minimum size **(code)**

- **What:** `src-tauri/tauri.conf.json` `main` window has width/height but no
  `minWidth`/`minHeight` (note windows set 720, Settings 680). On Windows/Linux the window
  can be shrunk until the dock, tabs and editor overlap.
- **Minimal fix:** `minWidth: 720, minHeight: 480` (match note windows).
- **Check:** native build on macOS + Windows (Tauri config change → native build required
  by AGENTS.md); resize to the limit, no overlap.

### UI-14 · Medium · Database creation failures are silent

- **Where:** Create → База данных ([10-db-create-silent-failure.jpg](shots/10-db-create-silent-failure.jpg)).
- **What:** `files-panel.tsx:306` awaits `onNewDatabase` without try/catch; `use-layers.ts:195,413`
  likewise. In the web build the click produces an unhandled rejection and the dialog just
  stays open; any native failure would behave the same. Violates [notice rules](../../notices.md).
- **Minimal fix:** catch, keep the dialog open, show the existing inline field error or one
  notice through the notice API (no raw error text).
- **Check:** web build (deterministic failure) shows one notice; native success path closes.

### UI-15 · Medium · Expanded breadcrumb is white in dark mode **(code)**

- **What:** `page-header-bar.tsx:262` expanded path uses `bg-white text-slate-900 ring-slate-200`
  with no dark variant, while segments inside use `text-muted-foreground` (light grey in dark
  mode) → light-grey text on white. Appears when a path is deeper than the fold limit and
  the user hovers the ellipsis.
- **Minimal fix:** `bg-popover text-popover-foreground ring-border`.
- **Check:** note 5+ folders deep, hover «…», both modes.

### UI-16 · Low · Search overlay is not exposed as a listbox

- **What:** query input has only a placeholder (no `aria-label`); filter chips «Всё/Заметки/
  Теги» have no `aria-pressed`; results are plain buttons with no `listbox`/`option` roles and
  no `aria-activedescendant`, so arrow-key selection is silent for screen readers
  ([08-search-light.jpg](shots/08-search-light.jpg)).
- **Minimal fix:** add the three ARIA attributes; no visual change.
- **Files:** `workspace/search-modal.tsx`.

### UI-17 · Low · Dock buttons do not expose which section is active

- **What:** rail buttons have no `aria-pressed`/`aria-current`; the active state is visual only.
- **Minimal fix:** `aria-pressed={active}` in `workspace/activity-bar.tsx`.

### UI-18 · Low · Focus is lost after closing Settings

- **What:** after Esc the focused element is `<body>` (Chromium). Keyboard users restart from
  the top of the page.
- **Minimal fix:** `onCloseAutoFocus` → focus the dock's Settings button.
- **Check:** also in native WebKit (buttons are not focused by mouse click there).

### UI-19 · Low · Database chrome bypasses theme tokens **(code)**

- **What:** `database-view-tabs.tsx`, `database-toolbar-actions.tsx`, `database-view-menu.tsx`,
  `database-settings-toggle.tsx`, `property-header-menu.tsx` use `slate-100/500/900` with
  `dark:` overrides instead of `accent`/`muted-foreground`/`foreground`. Default theme looks
  almost the same, but portable themes and accent palettes do not reach these controls.
- **Minimal fix:** replace with the token classes already used in the `dark:` branch.

### UI-20 · Low · Same object type, two icon systems **(code)**

- **What:** tree uses Lucide for default type icons (`TreeIcon`), but nested-note chips fall
  back to emoji 🗺️ ✏️ 🗄️ 📄 (`editor/document-body.tsx:256-265`) and folder tabs to 📁
  (`workspace-orchestration.tsx:1161`). Target standard: Lucide for interface icons, Noto
  only for user-chosen emoji.
- **Minimal fix:** use `TreeIcon`/`TreeItemIcon` as the fallback for these two places.

### UI-21 · Low · Dialog default names are not selected

- **What:** «Создать базу данных» pre-fills «Без названия» with the caret at the end
  (`selectionStart = selectionEnd = 12`), so typing appends to the placeholder name.
- **Minimal fix:** select the text on autofocus (as tree inline rename does).

### UI-22 · Low · Russian copy switches between «ты» and «вы»

- **What:** «Начни писать...» (`resources.ts:2173`), «Нет файлов. Создай новый.» (`2759`) while
  the rest of the UI uses «вы» («Создайте заметку…», «Начните записывать…»). Ellipsis is mixed
  («...» vs «…»).
- **Minimal fix:** «Начните писать…», «Нет файлов. Создайте новый.»; typographic ellipsis.

### UI-23 · Low · Monospace and UI fonts differ per machine **(code)**

- **What:** four different monospace stacks (`app.css:973,1928,4841,6313`, …); `--font-mono`
  is referenced but never defined; "JetBrains Mono"/"Inter" are listed but not bundled.
  Code blocks therefore render in whatever the OS has.
- **Minimal fix:** define `--font-mono` once (`ui-monospace, "SF Mono", Menlo, Consolas,
"Cascadia Mono", "DejaVu Sans Mono", "Liberation Mono", monospace`) and use it everywhere.
  Bundling fonts is optional (O7).

## Other observations (not UI polish, check separately)

- Web adapter only: renaming a just-created folder produced a file-like entry
  `web-vault/Проекты` next to the folder, and tree labels switched from titles to file names
  (`Welcome`, `Notes`) — [09-folder-collection-light.jpg](shots/09-folder-collection-light.jpg).
  Probably the dual-adapter debt; confirm it does not happen natively.
- Console in dev: "Encountered a script tag while rendering React component".
- Checked and fine: UI font scale applies to fixed-px Tailwind text (13 → 14.6 px at Large);
  reduced motion is honoured through `MotionConfig reducedMotion="user"`; macOS traffic lights
  in Settings are platform-gated; dark-mode text contrast had no failures except the
  decorative «·» separator; empty states and menus have consistent 32 px rows.

## Optional visual suggestions (need owner approval)

- **O1** Make the selected tree row slightly stronger (accent tint at ~12 %) instead of
  weakening hover (UI-09 alternative).
- **O2** Replace the custom `BrainIcon`/`WorkspaceIcon` (`tree/tree-icons.tsx`, 16-grid,
  stroke 1.5) and the canvas toolbar's hand-drawn SVGs with the closest Lucide icons.
- **O3** Normalise ad-hoc Lucide stroke widths (1.2, 1.3, 1.5, 1.7, 1.75, 1.8) to the
  default or one token.
- **O4** Appearance → «Цвета и эффекты» reuses the Palette icon of «Библиотека тем»; give it
  a distinct icon.
- **O5** Show the matched text snippet under "В тексте" search results.
- **O6** 960–1100 px windows leave a 227 px editor column with both panels open
  ([01-note-1024-dark.jpg](shots/01-note-1024-dark.jpg)); consider auto-hiding the right panel
  first, or raising the compact threshold.
- **O7** Bundle Inter and one monospace font for identical rendering on all OSes (size cost).

## Prioritised plan for Codex

Each batch is independent, starts from `dev`, keeps visuals otherwise unchanged, and ends
with `npm run build` plus the batch checks; run `npm run verify` before review. Add an
`updates/upd_next.md` entry per batch.

1. **Focus and contrast (CSS only):** UI-01, UI-05, UI-06. Check: `focus-audit.js`,
   `contrast-audit.js`, `scrollbar-rules.test.ts`, `prosemirror-base.test.ts`, both modes.
2. **Destructive and theme tokens:** UI-02, UI-15, UI-19. Check: menus in both modes,
   `theme-boundary.test.ts`, `themes.test.ts`.
3. **Tree keyboard and states:** UI-03, UI-09, UI-17. Check: tree/favourites tests, Tab
   walkthrough, multi-select hover.
4. **Editor edge alignment:** UI-04. Check: `title-body-alignment.js` at three widths, Source
   and read modes, database title.
5. **Platform-correct text (strings):** UI-07, UI-08, UI-22 — use the `amby-ui-strings` skill;
   `localization-guard.test.ts`.
6. **Dialogs and errors:** UI-14, UI-21, UI-18, UI-11, UI-16, UI-10. Check: notice rules,
   web failure path, accessibility tree.
7. **Window behaviour:** UI-12, UI-13. UI-13 changes Tauri config → native build on macOS
   and Windows is mandatory.
8. **Icons and fonts:** UI-20, UI-23; then optional O-items only after approval.
