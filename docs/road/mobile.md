# Amby on the phone: plan

Date: 2 November 2026.
Status: **draft, no code.** Order by the owner's decision: browser first, then Telegram (Mini App —
the same browser version inside Telegram), then a full app. Sync is ready
(`GATES_PASSED = true`); the phone connects to it as one more device. The design is worked out before
code and approved separately (section 4). Work with data follows the "tests first" rule (section 6
of the [sync plan](../sync-plan.md)).

## 1. The main points in brief

- **One mobile version, three ways to open it.** The browser on a phone, a Telegram Mini App and a
  Tauri 2 app show the same mobile React interface. The only difference is the shell: where the keys are
  stored, whether there is a camera, background work, "Share". Step 3 is a wrapper and polish, not a rewrite.
- **The phone is a window into the server, not a second copy of the vault.** It downloads notes as they are
  opened and sends edits as commits with a base version. A full folder reconciliation engine is not needed on the phone.
- **The design is a separate mobile shell, not a squeezed desktop screen.** Shared themes, icons, editor,
  storage and stores; its own navigation, screens and gestures.

## 2. Promises that change

| Promise                          | What changes on the phone                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| О1 "the server cannot read"      | In the browser and Telegram it holds as long as the page code is honest: whoever serves the page can swap it and steal the key. This is a limitation of all web clients with end-to-end encryption, and we say so plainly. Telegram does not serve the page and does not see notes, only the fact that it was opened. In the app there is no such limitation. |
| О4 "a full copy on every device" | The phone keeps only a cache: iOS erases the data of a site that has not been opened for 7 days unless it is on the home screen; storage inside Telegram can also be cleared. The phone copy is not a backup. Unsent edits sit in a queue and stay visible until the server accepts them.                                                                     |
| О5 "both versions on conflict"   | Preserved: if the server rejects an edit, the phone overwrites nothing and saves its own version as the second version of the conflict (`.amby/conflicts/`).                                                                                                                                                                                                  |
| О7 "byte for byte"               | Preserved: unchanged blocks are written with the same bytes as on the computer (the Live Preview rule from AGENTS.md).                                                                                                                                                                                                                                        |

## 3. Step 0. What is needed before starting

- **A server on the internet:** a domain, Caddy with HTTPS, data on a separate volume, backups, a firewall for 80/443
  (Hetzner). A Telegram Mini App opens only HTTPS addresses.
- **Sign-in by QR (Э2б):** typing a long password on a phone is inconvenient. The computer shows a QR code, the phone
  scans it with its camera (in Telegram — with the Mini App's built-in scanner). The design is laid down in Э2б.

## 4. Mobile version design

The design is done **before code** and passes the owner's stop point (Д.8). Below are the requirements for it.

### Д.0. Principles

- **The phone is for writing, reading and short edits.** Restructuring the vault, databases and canvases stay
  with the computer. The main scenario: take out the phone → in 3 seconds you are writing a thought.
- **One hand, the thumb.** Frequent actions at the bottom of the screen; at the top only the title, "back" and status.
- **It is the same Amby.** The same themes (tokens in `src/themes/`), `IconValue` icons, the note's font and appearance, properties,
  the notice light bulb. But not a shrunken copy of the desktop layout.
- **The data state is always visible:** saved on the server / not sent / no network / conflict.
- **Platform habits:** the back swipe from the edge on iOS, the system "back" on Android, `BackButton` in Telegram.
- **An accidental edit is impossible.** Scrolling does not place the cursor or open the keyboard; the cursor is placed
  only by tapping the text (Д.9). This is about convenience and about data: an edit rewrites the block (О7).

### Д.1. Navigation

- Bottom bar: **Home**, **Notes** (folders), in the center the **"+" quick capture**, **Search**, **More**
  (settings, sync, trash, about).
- Screens stack and slide sideways; the folder path is abbreviated in the header, tapping shows all of it.
- Inside a note the bottom bar hides on scroll and comes back with a tap at the top of the screen.
- The desktop version's side panels (backlinks, table of contents, properties) become bottom sheets that
  pull up to half or the full screen.

### Д.2. Screens

| Screen                   | What is on it                                                                                                                                                                                                    |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First launch and sign-in | choose a server ("Сервер Amby" (Amby server) / "Свой сервер" (own server)), sign in by QR from the computer, by password, recovery code; honest text about О1 and the cache (section 2)                          |
| Home                     | daily note, recent, favorites and pinned, the "Входящие" (Inbox) folder, the "not sent" counter                                                                                                                  |
| Folder                   | a list with icons and edit date, sorting, long press — an action sheet (rename, move, add to favorites, move to trash)                                                                                           |
| Note                     | full-width text, links open on tap, tapping the text starts editing with a bar above the keyboard (Д.3); "…" — properties, links, history                                                                        |
| Search                   | a field at the top with immediate focus, recent queries, results by titles and by the text of downloaded notes, filter by tag and folder                                                                         |
| Quick capture            | an empty sheet with the keyboard; where to save ("Входящие" (Inbox), daily note, a chosen folder) is remembered; photos and attachments                                                                          |
| Note properties          | a sheet with properties from frontmatter; in the first version, editing simple types (text, number, date, checkbox, tags)                                                                                        |
| Conflict                 | blocks one under another instead of "side by side", each with "mine / other / both", "Готово" (Done) at the bottom; the same logic as in the desktop Live comparison                                             |
| Notices                  | the light bulb in the note header opens a sheet with cards (conflict, changed on another device, recovery draft)                                                                                                 |
| Sync                     | status and "refresh", account and space on the server, how many notes are downloaded and "download all", when to download attachments, devices with "disconnect", "sign out and erase everything from the phone" |
| Settings                 | theme, text size, where quick capture saves, what to download without a network, sync and devices, "sign out and erase everything from the phone"                                                                |

Databases in the first version — viewing as a list and as cards; canvas, Excalidraw and the creative workshop —
an "open on the computer" label with a "copy link" button.

### Д.3. Touch editor

- **The bar above the keyboard** — a scrollable strip: undo, redo, "/" block insertion, heading,
  list, task, bold, `[[` link, photo and attachment, indent left and right, hide the keyboard. The set and
  order are configurable.
- **The "/" menu** and `[[` suggestions — as a bottom sheet with large rows, not a small list at the cursor.
- **Blocks:** long press on the handle → an action sheet (up, down, turn into…, copy link to block,
  delete). Dragging is also by the handle after a long press, with haptic feedback.
- **Columns** on a narrow screen are shown one under another; the file does not change.
- **Tables, formulas, code** scroll inside the block; the page does not move sideways.
- **The keyboard** does not cover the cursor: the visible area height comes from `visualViewport`, the line with the cursor is always
  above the bar.
- **Source mode** (CodeMirror) — under "…", not the main one.

### Д.4. Sizes and typography

- Touch targets are at least 44 × 44 pt, with at least 8 pt between neighbors.
- Input fields are at least 16 px, otherwise Safari zooms the page by itself.
- Note text 17 px, line height 1.5, side margins 16 px; text size is in settings (in the app —
  the system font size).
- Insets for the notch and the home indicator (`safe-area-inset-*`; in Telegram — its safe area insets).
- Theme follows the system; contrast is checked in bright sunlight. The desktop version's "Compact" density
  is not applied on the phone.

### Д.5. States and feedback

- The sync icon in the header: a cloud with a check mark, a send arrow, a crossed-out cloud, a conflict
  triangle. Tapping opens a sheet with details and "send now".
- No network — a thin strip at the top, not a window; notes from the cache open, new ones — marked "not
  downloaded".
- Loading — gray row placeholders, no full-screen spinners. Empty screens explain what to do.
- Errors in plain words and with an action ("server unavailable — edits are saved on the phone").
- Animations of 150–250 ms, "reduce motion" is honored (`src/lib/motion-config.ts`).

### Д.6. Telegram

- Colors: Amby's own theme or "as in Telegram" using its theme colors (a setting).
- The Mini App expands to full screen; while there are unsent edits, swiping down does not close it, and
  closing asks for confirmation.
- Telegram's `BackButton` instead of our own "back" button; we keep our own bottom bar and do not use Telegram's
  `MainButton`.

### Д.7. How it is built in code

- A separate mobile shell (a root component and its own screens), chosen at startup by screen width
  and platform. The desktop `workspace.tsx` does not grow media queries.
- Shared with desktop: storage behind the `src/lib/storage/port.ts` port, Zustand stores, the Tiptap editor,
  autosave and recovery, themes and translations.
- Mobile tokens (touch sizes, insets, font) — in `src/themes/`, strings — in
  `src/locales/resources.ts` in all languages.

### Д.8. Process

1. Scenarios and the screen map (this section) — approval by the owner.
2. Mockups of 8–10 key screens in light and dark themes, then a clickable prototype that opens on a
   phone in the browser. **Stop point: the owner approves the mockups, only then code.**
3. Testing on phones: a narrow one (iPhone SE / mini), a regular iPhone, a mid-range Android; with one hand;
   inside Telegram.
4. After each step — phone screenshots in the report, as for the desktop version.

### Д.9. What we take from Obsidian and Notion

We take techniques users are already used to. We do not copy their look or branding.

| Technique                                                                   | From whom | Decision                                                                                                                              |
| --------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Editing by tapping the text, without a separate mode                        | both      | **take**: tapping the text places the cursor at that spot; scrolling does not place the cursor. No "Edit" button needed (changes Д.0) |
| "New note" is a button in the bottom bar, not one floating over the text    | both      | **take**: "+" in the center of the bar; a floating button covers the text and duplicates                                              |
| The bottom bar hides when scrolling a note, a tap at the top brings it back | Obsidian  | **take**                                                                                                                              |
| Home: recent, favorites, "continue where you left off"                      | Notion    | **take**, plus an "open the last note" setting, as in Obsidian                                                                        |
| Search: before typing — recent notes and queries; title matches first       | both      | **take**                                                                                                                              |
| Bar above the keyboard: block "+", "Aa" style, indent, undo; configurable   | both      | **take**; indent left and right is mandatory in the bar, without it lists cannot be edited on a phone                                 |
| Long press on a block — a menu and dragging                                 | Notion    | **take** (already in Д.3)                                                                                                             |
| Backlinks and table of contents — a separate slide-out panel                | Obsidian  | **take as a bottom sheet**: opened by a button, not only by a gesture                                                                 |
| A side panel from a swipe off the left edge                                 | Obsidian  | **do not take**: it conflicts with the system "back" on iOS and Android, and it cannot be guessed                                     |
| Pull down — the command palette                                             | Obsidian  | **later**, as an additional gesture; everything it does must also be available as a button                                            |
| Tabs as on the computer                                                     | Obsidian  | **do not take**: on a phone the screen stack and "recent" are enough                                                                  |
| Inbox notifications, AI and meetings as separate tabs                       | Notion    | **do not take**: we have one owner; notices are the light bulb (Д.2)                                                                  |

What they lack and what we keep as our own: a note opens instantly from the cache and without a network, the sending state
is always visible (Д.5), a conflict is resolved block by block.

## 5. Step 1. The browser on the phone (PWA)

Goal: open the address in Safari or Chrome, sign in, read, search and edit notes, quickly capture a thought.
"Add to Home Screen" — looks like an app and does not lose the cache after 7 days.

### 1а. Mobile shell (without sync)

Based on the approved mockups (Д.8). Tested on the existing browser demo, no risk to data. The most
labor-intensive part is the touch editor (Д.3).

### 1б. Encryption in the browser (WebAssembly)

- `sync/core` (cryptography only: keys, headers, bodies, Padmé, recovery code) is built to
  WebAssembly. The network is in TypeScript via `fetch`, not via `reqwest`/`tokio`.
- Tests before code: the WebAssembly build passes the `sync/vectors/` vectors byte for byte, like Rust and the Python reference.
  Argon2id 64 MiB timing — on a real phone (we expect 1–3 s).
- Keys: AK is wrapped with a non-extractable WebCrypto key in IndexedDB; "do not remember" mode and "sign out and erase
  everything from this phone".

### 1в. Thin sync client

- The change feed (headers: paths, versions) is the note tree.
- A note body is downloaded on open, recent ones stay in the cache for reading without a network; attachments — on
  tap; optionally "download all notes" without attachments (needed for full search).
- An edit goes out as a commit with a base version (Р3). A server rejection — a "changed on another
  device" card: refresh or save your own version as the second version of the conflict.
- A queue of unsent edits with retry after a drop (`commit_id`), a "not sent" counter.
- Complies with Р4 (what is synced), Р8 (no mass deletions from the phone), Р13 (an unfamiliar format —
  read only).
- A new storage adapter next to `web-adapter-core.ts`, behind the `src/lib/storage/port.ts` port. The interface knows nothing
  about the network.

### 1г. Where the page is served from

- Own server: the same Docker image serves the page too. The server's owner trusts themselves.
- "Amby server": the page is served separately from the data server, with a version number and checksums,
  and the build is reproducible. The data server alone cannot swap the page.

**Done** when, on iPhone and Android in the browser and from the home screen: sign-in by QR, opening, changing and creating
a note, an edit reaches the computer and back, a conflict keeps both versions, a network drop does not lose an edit,
"sign out and erase" really erases.

## 6. Step 2. Telegram Mini App

The "Open" button in Telegram opens the same page from step 1 in the built-in browser. There is no new interface;
only the Telegram integration is added.

- **The bot is only an entry point:** the menu button "Открыть Amby" (Open Amby) and a `t.me/…` link. The bot does not accept or see notes.
- **Signing in to Amby — as in the browser:** an Amby account, a QR from Telegram's built-in scanner, or a password. Telegram
  data (`initData`) does not replace keys; at most, it remembers the server address.
- **Own server:** the instruction "create a bot with @BotFather and enter your server's address"; for the "Amby
  server" — our bot.
- **Storage inside Telegram** is unreliable — the same cache and queue rules as in the browser. Check during the step
  whether the wrapped key can be kept in the device's secure storage that newer Mini App versions provide.
- Presentation specifics — Д.6.

**Done** when everything in step 1's "Done" passes inside Telegram on iOS and Android, and closing by swipe with an
unsent edit does not lose it.

Later, optionally: an "Inbox" bot (you write to the bot — a note appears). It requires an account X25519 key pair
(Р14) and an honest caveat that Telegram and the bot's server see the text at the moment of receipt. In many ways
"Share to Amby" in the app will replace it.

## 7. Step 3. The full app (Tauri 2, iOS and Android)

- The same mobile interface and the same Rust: cryptography is native, without WebAssembly; keys in Keychain and
  Android Keystore; О1 without the caveat about the page code.
- Storage: first a thin client with a persistent cache, then optionally "keep the whole vault" with the full
  Э3 engine and selective folder sync.
- What the browser lacks: "Share to Amby" from any app, a quick-capture widget, background
  sync, conflict notifications, Face ID, haptic feedback.
- Publishing: Apple Developer ($99 a year), Google Play ($25 once). The license is ready: AGPL with an exception and
  the CLA allow releasing in the App Store.
- We start with iOS: the Mac, Xcode and the simulator are already there.

## 8. Order and size

| Step                          | Size   | Risk to data  | Depends on       |
| ----------------------------- | ------ | ------------- | ---------------- |
| 0. Server on the internet, QR | medium | high (strict) | —                |
| Д. Design and prototype       | medium | none          | —, can start now |
| 1а. Mobile shell              | large  | none          | approved design  |
| 1б. Encryption in WebAssembly | small  | high (strict) | Э1 vectors       |
| 1в. Thin client               | large  | high (strict) | 1б, step 0       |
| 1г. Serving the page          | small  | medium        | 1в               |
| 2. Telegram Mini App          | small  | low           | step 1           |
| 3. Tauri app                  | large  | medium        | step 1           |

In parallel: design (Д) and encryption in WebAssembly (1б), then the mobile shell (1а) and the server with QR (0) —
they do not overlap in files.

## 9. Questions for the owner

1. Editing by tapping the text, without an "Edit" button, as in Obsidian and Notion (Д.9). Agreed?
2. Does quick capture save to "Inbox" or to the daily note by default?
3. What is needed on the phone right away besides notes: databases (viewing), tasks, the graph?
4. Attachments are downloaded only on tap — is that right?
