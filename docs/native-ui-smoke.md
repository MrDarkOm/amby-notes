# Native UI smoke harness

Run `npm run test:native:ui` to open the production React interface in a real
Tauri/WebView runtime with disposable vaults, isolated global settings and an
isolated WebView profile. The opt-in `native-contract` feature is never enabled
by normal development or production builds. The runner refuses to reuse a path
without its exact marker. It does not read existing Amby settings or vaults.

The command prints the generated profile path. Reopen the same profile with
`npm run test:native:ui -- "<printed path>"` to test full process restart.
Generated profiles live under ignored `.release-evidence/` and remain available
for byte-level verification. The regular storage contract still deletes its
own temporary profile automatically.

Windows smoke on 2026-09-01 covered UI save/autosave, close/reopen, rename,
successful and failed dirty vault switching, external create/edit/rename/delete,
external conflict resolution with local-copy preservation, deleted-file restore,
controlled identity migration, duplicate identity visibility, and a supported
paragraph edit in the compatibility corpus. The latter changed exactly the
intended paragraph while keeping every other fixture byte-exact and preserving
the rest of the edited file byte-for-byte.

This harness is full React lifecycle evidence, but it does not claim installer,
code-signing, removable/network-filesystem, or multi-window acceptance.
The main window uses the production `state::handle_run_event` callback and an
isolated main-window configuration: closing it destroys the prewarmed settings
window, and macOS reopen events use the production restore/recreate path. The
harness does not install the production single-instance plugin.

Window smoke: wait for settings to prewarm, close the main window, and verify
that the test process exits. Reopen the same disposable profile and check a
local image through the insert menu and clipboard. On Windows, repeat against
a normal build and verify a second launch after closing and while minimized.

## Creative workshop: manual check in a native window (stages 7 and 8)

The owner performs this check: it is not part of `npm run test:native:ui` (that one runs the vault storage contract).
Everything else in the workshop plan is covered by tests; what exactly has not been checked by hand is in the "Stage 7 results" section
of the plan.

**Preparation.** An empty folder as a new vault (not a working vault or a copy of one). The «Творческая мастерская» (Creative workshop)
module is enabled. The application is the unpackaged debug build made at stage 7
(`target/debug/amby-notes`; it carries the interface as of the time of the build), or `npm run tauri dev`.
Keep the vault folder open in the file manager: some steps look at the disk.

1. **Initialization and story.** Open the «Мастерская» (Workshop) panel. _Expected:_ the screen «Мастерской здесь ещё нет» (There is no workshop here yet),
   «Папка: Мастерская» (Folder: Workshop) and an «Инициализировать» (Initialize) button; no workshop picker, no «Создать» (Create) button at the bottom, no name
   to type in. Click «Инициализировать». _Expected:_ on disk a `Мастерская` folder with the file `amby-workshop.json`
   and seven databases: `Истории` (Stories), `Персонажи` (Characters), `Локации` (Locations), `Вселенные` (Universes), `Арки` (Arcs), `Якоря` (Anchors), `Заметки` (Notes); the panel immediately
   has the «Якоря» and «Заметки» parts and, under «Мир» (World), characters and locations; there is no «Создать недостающие разделы» (Create missing sections) banner.
   Then «Создать» → «Новая история» (New story), name «Роман 1» (Novel 1), scheme «Роман» (Novel). _Expected:_ the text tree is empty with
   an «Добавить первую страницу» (Add first page) button; on disk `Мастерская/Истории/Роман 1/` with three files: `Роман 1.md`,
   `Роман 1.json`, `amby-story.json`. Add pages: «Книга» (Book), inside it «Глава 1» (Chapter 1) and «Глава 2» (Chapter 2), and in «Глава 1» —
   «Сцена» (Scene). _Expected:_ the levels are called «Книга», «Глава», «Сцена»; the scene has no «+» button for nested pages.
2. **A character with a story selected.** At the top, in the «Истории» (Stories) card, «Роман 1» is selected (a standalone story:
   at the bottom, the «Вселенные» (Universes) card shows «Отдельные истории» (Standalone stories)). In the «Персонажи» part click «+», type «Анна» (Anna),
   Enter. _Expected:_ «Анна» stays in the list and does not vanish after the panel refreshes; the world list has
   no «Вселенные» section.
3. **Two cards: stories at the top, universes at the bottom.** At the top choose «Все истории» (All stories), create a character
   «Борис» (Boris). _Expected:_ «Борис» is at the end of the list in the «Без истории» (No story) group, «Анна» is labeled «Роман 1»; under
   the card name — «1 история» (1 story). Switch the top back to «Роман 1»: «Борис» is gone. At the bottom open the list: «Отдельные
   истории» and «Новая вселенная» (New universe). «Новая вселенная», name «Мир» (World). _Expected:_ the bottom card shows «Мир», its
   page is open, the top shows «Все истории» and «0 историй» (0 stories). Open the «Истории» database (a tab on the workshop page) and
   in the «Роман 1» row set «Вселенная» (Universe) = «Мир». Select «Мир» at the bottom. _Expected:_ at the top «Роман 1» is in the list,
   «Анна» is there, «Борис» is not. Select «Отдельные истории»: «Роман 1» is no longer in the list of stories, «Борис» is there
   in the «Без истории» group. Close and reopen the application: the choice of universe and story is preserved.
4. **Notebook.** Select «Роман 1». In the «Заметки» part «Новый блокнот» (New notebook) → «Идеи» (Ideas). Create a note «Мысль» (Thought) and
   drag it onto «Идеи». _Expected:_ the note is inside the notebook, on disk `Заметки/Идеи/Мысль.md`. Open
   «Мысль» in a tab. Delete the «Идеи» notebook (notebook menu → «Удалить блокнот…» (Delete notebook…)) and confirm.
   _Expected:_ «Мысль» moved up to «Без блокнота» (No notebook) (file `Заметки/Мысль.md`), the tab with it stayed open,
   the «Идеи» folder went to the vault trash and can be restored from there.
5. **Anchor and arc, first binding.** In the «Якоря» part click «Добавить» (Add), type «Встреча» (Meeting), Enter. The «Арки» (Arcs)
   section already exists: create an arc «Любовь» (Love) in it. Drag «Встреча» onto «Глава 1».
   _Expected:_ «Глава 1» has an anchor icon; in the story's text database the «Якоря» property has been there since the story was created
   (no separate preparation on the first binding). Drag «Любовь» onto «Глава 1»: a colored dot next to the name. In the page menu
   of «Глава 1» there are checkmarks in «Якорях ▸» and «Арках ▸»; in the anchor menu «Отвязать от страницы ▸» (Unbind from page) removes the binding.
6. **Chapter and the block on the right.** Open «Глава 1». _Expected:_ on the right (under the text on a narrow panel) «Сюжет
   страницы» (Page plot): «Якоря этой страницы» (This page's anchors) — «Встреча», «Отталкиваемся от» (We start from) and «Должны прийти к» (Must arrive at) — hints or
   neighboring anchors, «Арки» — «Любовь» with a color; the editor does not flicker or lose the cursor meanwhile.
7. **Story desk.** Open the story page (the button to the right of the «Истории» card). _Expected:_ the «Якоря» strip: «Встреча»
   with the name «Главы 1». If you set a status from the «Готово» (Done) group on «Глава 1», the anchor gets «пройден» (passed).
8. **Arc and character dossier.** Open the «Любовь» arc: the blocks «Якоря арки» (Arc anchors) («Встреча») and «Главы» (Chapters) («Глава 1»; with
   several pages — «от … до …» (from … to …)). In the arc row, in the «Персонажи» property, set «Анна», then open «Анна».
   _Expected:_ in the «Анна» dossier there is an «Арки» block with «Любовь».
9. **Universe event.** Open the page of the universe «Мир». «События вселенной» (Universe events) → «Новое событие» (New event) → «Потоп» (Flood),
   Enter. _Expected:_ «Потоп» is in the event list; in the panel with «Мир» selected at the bottom and «Все истории» it is
   the first group «События вселенной»; in «Отдельные истории» it is absent (universe events are not shown there).
10. **Interrupted creation.** Creating a story takes just a few tens of milliseconds, so hitting it
    by hand is hard. Try: enter the name of a new story, press Enter and immediately force-quit the
    application (Force Quit or `kill -9`), several times with different names. Open the vault again.
    _Expected:_ each story is either created in full (three files in its folder, it opens) or its folder does not exist;
    there are no half-finished folders; in `.amby/recovery/creative/` there are no files with an unfinished operation and no
    `quarantine/` folder. If you never hit the moment of creation, the check failed as a check: a crash at every
    step of creation is covered by Rust tests (`create_test.rs`), but not by a native window.
11. **Page and anchor order from the keyboard.** Tab to a page row in the text tree (not with the mouse) and
    press the menu key or Shift+F10 (as in the file tree). _Expected:_ a menu with the items «Выше» (Up), «Ниже» (Down),
    «Вложить в предыдущую» (Nest into previous), «Вынести на уровень выше» (Lift one level up). For the first page in the list «Выше» is grayed; for «Глава 2» under
    «Глава 1» «Вложить в предыдущую» is grayed (same level); for «Книга» «Вынести на уровень выше» is grayed. «Глава 2» →
    «Выше»: it moved before «Глава 1», and after a restart the order is the same. «Сцена» → «Вынести на уровень выше»:
    it moved to the chapter level right after its chapter. Grayed items cannot be clicked and give no error. For
    anchors: create two more anchors with no binding (they are in the «Впереди» (Ahead) group), in the menu of the first «Ниже» → the order
    changed and persisted after a restart (it is also the manual order of the «Якоря» table); the bound «Встреча»
    has no «Выше»/«Ниже» items.

12. **Workshop folder in settings.** «Настройки» (Settings) → «Модули» (Modules) → «Творческая мастерская» → «Папка мастерской» (Workshop folder):
    «Мастерская» is shown. «Выбрать…» (Choose…) and pick another folder inside the vault (create an empty one, e.g. `Книги`).
    _Expected:_ the path changed, the files of the previous workshop stayed in place; the «Мастерская» panel shows the initialization
    screen with «Папка: Книги». Choose a folder outside the vault. _Expected:_ a message, the setting did not
    change. Put any file into `Книги` and click «Инициализировать». _Expected:_ a refusal with an explanation,
    nothing appeared on disk. Restore «По умолчанию» (Default): the panel shows the previous workshop again.
13. **Workshop from earlier stages.** Open a vault where the workshop was created before stage 8 (without «Вселенные», etc.).
    _Expected:_ it is the only one and is active right away; at the top a «В мастерской не хватает разделов» (The workshop is missing sections) banner with a list.
    Opening by itself changed nothing on disk (the modification date of `amby-workshop.json` is unchanged). Click
    «Создать недостающие разделы». _Expected:_ the banner disappeared, the missing database folders appeared on disk, the previous
    pages and files are untouched.
14. **Narrow panel and old folders.** Narrow the panel to ~320 px. _Expected:_ no horizontal scrollbar,
    «Добавить первую страницу» in full (on several lines, without "…"). If the vault has folders with `amby-project.json`,
    at the bottom there is one collapsed row «Папки старого формата: N» (Old-format folders: N), no banner at the top. The word «Мастерская» in the panel is
    the title and the story list card, and nowhere else.

If any of this is wrong, write down the step number and what you saw; do not touch the vault storage contract itself.

### Pages and cards (16 October polish)

15. Hover over the bottom «Вселенные» card: inside the frame a segment with a right arrow slides out behind a thin line; with
    «Отдельные истории» the arrow opens the «Отдельные истории» page, with a universe selected — its page with its
    name in the tab.
16. On a universe page «Новая история» creates a story that is immediately visible in that universe; «Новое событие»
    creates an anchor linked to the universe.
17. The «Персонажи» tab on a story or universe page shows only the characters of that scope; «Вся база» (Whole database)
    opens the workshop page.
18. The button next to the «Мастерская» panel title opens the workshop page.
19. Open the card list: it is under the card, the full width of it, the selection arrow is flipped; clicking the arrow
    to the right does not shift it down.

## Sync: connecting to the server (stage Э4)

This checks the connection screen (address, account, recovery
code, sign-in, devices, sign-out); note transfer is covered in the "two computers" section below. The scenario is run against a real server in Docker. The automated
checks (`npm run rust:test`, `npm run test`) do not replace it: they stub out the system keychain,
printing and the file-save dialog.

**Preparation.**

1. Server: from the repository root (Docker is required)

   ```bash
   docker build -f sync/server/Dockerfile -t amby-sync-server:smoke sync/
   docker run -d --name amby-sync-smoke -p 127.0.0.1:18080:8080 amby-sync-server:smoke
   docker exec amby-sync-smoke amby-sync-server user add anna
   ```

   The `user add` command prints a one-time invitation code valid for 24 hours. The server address in the application is
   `http://127.0.0.1:18080` (a local address is allowed without https).

2. Application: `npm run tauri dev`. The check writes to the system's **real** keychain (service
   `com.ambynotes.sync`) and to the application data directory (`sync-connection.json` next to the settings), so
   at the end be sure to perform the «Выйти» (Sign out) step and remove the container: `docker rm -f amby-sync-smoke`.
3. The second device is simulated by a client example (it signs in with a password and holds the device):
   `cargo run --manifest-path sync/Cargo.toml -p amby-sync-client --example second_device -- http://127.0.0.1:18080 anna "<password>" "Второй компьютер"`.

**Scenario.**

1. **Settings section.** Settings → the list of sections on the left. _Expected:_ the «Синхронизация» (Sync) section
   is always available, no separate module needs to be enabled.
2. **Connection.** Open the section. _Expected:_ account connection is available and there is no outdated warning about a limited mode. Note transfer is checked by the section below, "two computers".
3. **Address.** Empty address: the «Проверить сервер» (Check server) button is unavailable. `http://example.com` _Expected:_ an error
   about `https://`. `http://192.168.1.5:8080` without the toggle — the same. Turn on «Сервер в локальной сети» (Server on the local network):
   _Expected:_ a warning that without https data travels openly over the network. `http://127.0.0.1:18080`:
   «Сервер найден» (Server found), the server version. Stop the container (`docker stop amby-sync-smoke`) and click
   «Проверить сервер»: «Не удалось связаться с сервером» (Could not reach the server). Start it again (`docker start amby-sync-smoke`).
4. **Creating an account.** «Создать учётную запись» (Create account): name `anna`, the invitation code from `user add`.
   Password `password12345678`: _Expected:_ «Слабый пароль» (Weak password), «Продолжить» (Continue) is unavailable. Password `Short1!`:
   «Не короче 12 символов» (At least 12 characters). Different passwords in the two fields: «Пароли не совпадают» (Passwords do not match). Password
   `correct horse battery staple 42`: «Отличный пароль» (Excellent password), «Продолжить» is available.
5. **Recovery code.** «Продолжить». _Expected:_ 14 groups of 4 characters in large type, the text «если вы потеряете и
   пароль, и этот код, данные на сервере не вернёт никто» (if you lose both the password and this code, no one can bring back the data on the server); buttons «Сохранить в файл» (Save to file), «Напечатать» (Print); two
   «Группа N» (Group N) fields; the «Подтвердить и подключиться» (Confirm and connect) button is unavailable; there is no other way forward (no «Готово» (Done),
   «Пропустить» (Skip)). Nothing is on the server yet: `docker exec amby-sync-smoke amby-sync-server user list`
   shows `anna` without a password.
   - «Сохранить в файл»: a save dialog opens with the name `amby-recovery-code.txt`; the file contains the code, address,
     name and a warning, no password. Cancelling the dialog gives no error.
   - «Напечатать»: the system print dialog opens (check macOS separately, it is the weakest spot); the
     sheet has only the code and the explanation, without the other window elements.
   - Enter wrong groups: _Expected:_ «Эти группы не совпадают с кодом» (These groups do not match the code), you stay on the step.
   - «Назад» (Back), then «Продолжить» again: _Expected:_ a **different** code (the previous one is invalid).
   - Enter the correct groups (lowercase is fine): _Expected:_ «Подключено к 127.0.0.1:18080» (Connected to 127.0.0.1:18080),
     user `anna`, the device list has one with the label «Это устройство» (This device). The code is no longer on screen.
6. **Where things are stored.** In Keychain Access (macOS) / Credential Manager (Windows) there is one entry for the service
   `com.ambynotes.sync`: `credentials` (the account key and the token together; the former `account-key` and `device-token`
   disappear after the first launch of the new version). In the application data directory there is
   `sync-connection.json` with four fields (address, http permission, name, device number), without passwords or
   keys. `grep -r "correct horse" <data directory>` finds nothing; the application logs (Settings →
   General → Debug → Show logs) contain no password, code or token.
7. **Restart.** Close the application and open it again. _Expected:_ the section still shows «Подключено» (Connected).
8. **Second device.** Run the example (preparation, step 3). _Expected:_ the list has two devices; the name
   «Второй компьютер» (Second computer) is fully visible, and it has «Отключить» (Disconnect). «Отключить» → «Отмена» (Cancel): nothing
   changed. «Отключить» → «Подтвердить отключение» (Confirm disconnection): the device disappeared; on its next request the example
   reports that its token has been revoked.
9. **Sign-out.** «Выйти на этом устройстве» (Sign out on this device). _Expected:_ the connection wizard again; there are no `com.ambynotes.sync` entries
   in the keychain; `sync-connection.json` is deleted; the device disappeared on the server.
10. **Password sign-in.** «Проверить сервер» → «Войти» (Sign in), name `anna`, wrong password: _Expected:_ «Неверное имя
    пользователя, пароль или код восстановления» (Wrong username, password or recovery code), the fields stayed filled. Correct password: connected, the list has
    your new device (the previous devices did not disappear).
11. **Forgot password.** Sign out. «Забыли пароль?» (Forgot password?): name, recovery code **with spaces and lowercase
    letters**, new password (a weak one is rejected). _Expected:_ connected; the old password no longer works,
    the new one does. The code remains valid meanwhile.
12. **Keychain cleared.** Delete the `credentials` entry manually in Keychain Access and open the section.
    _Expected:_ «Ключи этого устройства не найдены в связке ключей» (This device's keys were not found in the keychain), the address and name are filled in, sign-in is required.
13. **Sign-out without the server.** Connect, stop the container, click «Выйти». _Expected:_ you are signed out,
    a message «Сервер не удалось уведомить, отключите это устройство с другого устройства» (The server could not be notified, disconnect this device from another device).
14. **Language and theme.** Switch the language to English: all texts in the section are in English. Check the light and dark
    themes: the code field is readable, errors are noticeable.

15. **Many failures (do this last).** Sign out. «Войти» (Sign in), name `anna`, wrong password five times in a row.
    _Expected:_ on the sixth attempt "Слишком много неудачных попыток… Подождите N мин" (Too many failed attempts… Wait N min); the correct password
    is also rejected at that point (by design, П16). Recreate the container (`docker rm -f amby-sync-smoke` and the
    preparation commands again) if you need to continue.

**Cleanup.** `docker rm -f amby-sync-smoke`; the `com.ambynotes.sync` entries in the keychain are removed (step 9);
`sync-connection.json` is removed.

## Sync: two computers (stage Э4, notes)

Manual check of note transfer. You need **two computers** (or two vaults on one: a second app instance
with a different data directory, see Preparation, step 4) and a server in Docker. The automated checks
(`npm run rust:test`, `npm run test`, `npm run test:native:sync`) do not replace it: they substitute the keychain,
the network between computers, and real file watching on two machines.

**Automated run of two windows:** `npm run test:native:sync-vault` ([script](../scripts/run-native-sync-vault.mjs), page
`tests/native/sync-vault.tsx`) starts two real application windows ("computer A" and "computer B": their own app data,
their own in-memory keychain, their own vault) against one server: the Docker image if Docker is running and the image is built, otherwise
the server program from this repository. It goes through steps 1–3 and 6 and partly 4 below (an edit arriving, an ordinary external change
for the editor, a snapshot in history, the trash), but does not replace the manual scenario: it has no real keychain, no second
physical computer, no version comparison dialog in the editor, and no view of the screen.

For the manual check, use separate vaults with artificial data,
so that checking renames and deletion does not touch working notes.

**Preparation.**

1. The server — as in the section above (`docker build`, `docker run … -p 0.0.0.0:18080:8080`, `user add anna`). For
   two computers the server address is the address of the first computer on the local network, `http://192.168.x.x:18080`,
   with the «Сервер в локальной сети» (Server on the local network) switch.
2. Computer A: create the account `anna` (steps 4–5 of the section above). Create the test vault `Тест A` (Test A)
   and put in it: 5 notes in the `Заметки/` (Notes) folder, one note `Привет.md` (Hello.md) with Russian text, one
   `.png` (any), an empty folder `Пустая` (Empty), a nested folder `Проекты/Глубоко/Ещё` (Projects/Deep/More). Notes with attachments
   (`assets/`) too.
3. Computer B: sign in as `anna` with the same password («Войти»). Create an empty test vault `Тест B` (Test B).
4. (One computer, two vaults.) A second app instance: `npm run tauri dev` with a different data directory
   (`AMBY_APP_DATA_DIR=/tmp/amby-b`), a different device name at sign-in. The keys in the keychain will be
   shared with the first instance, so in this mode steps 1–12 are checked, but not step 13.
5. Open the app logs (Settings → General → Debug) to watch for errors.

**Scenario.**

1. **Enabling and backup.** On A open `Тест A`, Settings → Sync (connected).
   Under the connection line is the «Это хранилище» (This vault) block. _Expected:_ an explanation of the external backup
   and an available «Включить синхронизацию» (Enable sync) button, with no additional checkboxes. Leave the name
   empty and enable. _Expected:_ the path to the finished copy and restore instructions;
   the state «Идёт синхронизация…» (Syncing…), then «Всё синхронизировано» (Everything is synced) and the time; a space appeared on the server
   (`docker exec amby-sync-smoke amby-sync-server` — it has no list of spaces, and that is correct: the server does not
   know the names. Check on the second computer, step 2). `.amby/sync/state.db` appeared in the vault.
2. **Connecting an existing one.** On B open `Тест B`, «Включить синхронизацию» → «Подключить
   существующее» (Connect an existing one). _Expected:_ the list shows one space named `Тест A` (the name of A's folder); the second row
   is never "Без названия" (Unnamed). Select it and enable. _Expected:_ first an external copy is created,
   then A's files and folders appear on B one to one: the same names (Russian ones too), empty folders, the image opens,
   nested folders are in place.
3. **An edit goes both ways.** On A change `Привет.md` and save; after a few seconds open
   it on B. _Expected:_ the new text, without pressing «Синхронизировать сейчас» (Sync now). Create a note on B — it appears on A.
4. **An open note.** On B open `Привет.md` and **start editing without saving** (leave the cursor in the text).
   On A change the same note. _Expected:_ on B the ordinary version comparison dialog appears ("the file was changed
   on disk"), the text you typed is not lost, the choice is yours. Choose "keep my version" and save:
   the change goes to A.
5. **Conflict.** Turn off the network on B (Wi-Fi), change `Заметки/1.md` on A and on B differently, turn the network on.
   _Expected:_ on the second one to get there, in the «Конфликты (1)» (Conflicts (1)) block the row "“1” изменили на двух компьютерах" (“1” was changed on two computers),
   «Обе версии целы» (Both versions are intact) and one «Сравнить» (Compare) button, with no paths. In the comparison window «Оставить версию в заметке» (Keep the version in the note):
   the second version ended up in the trash (vault Trash → find it), the entry disappeared from the list, and it says «Оставлена версия в заметке…» (The version in the note was kept…).
   Repeat and choose «Взять вторую версию» (Take the second version): the note text is from the second version, the previous text is visible in the note's
   history (reason «Перед заменой с сервера» (Before replacement from the server)), and it says «…Прежняя — в истории заметки» (…The previous one is in the note's history). «Сохранить обе как
   отдельные заметки» (Save both as separate notes) (the «…» menu) makes the second version a separate note.
6. **Deletion.** Delete `Заметки/2.md` on A (using the "System trash" method). _Expected:_ on B the file disappeared and
   is in the vault trash (**even with the deletion mode "System trash" or "Permanently" on B**); «Вернуть» (Restore)
   returns it, and it goes back to A.
7. **Stopping on mass changes.** On A delete the `Заметки/` folder entirely (more than 20 files: add
   files before that). _Expected:_ A shows a red banner «Сразу N файлов…» (N files at once…), a list of files, **nothing is
   deleted on B**. «Да, продолжить» (Yes, continue): B shows the same stop with different text (about the "trash"), and only after «Да,
   продолжить» do the files go to B's trash. Cancel the deletion: restore the folder from the trash on A.
8. **A disconnected disk.** If the vault is on an external disk — disconnect it (or rename the vault folder on A).
   _Expected:_ «Папка хранилища не найдена… Ничего не удалено» (Vault folder not found… Nothing was deleted), there is no «Да…» (Yes…) button; put the folder back — «Проверить
   снова» (Check again) — «Всё синхронизировано» again, nothing disappeared on B.
9. **Server reset.** `docker rm -f amby-sync-smoke`, then `docker run …` again (new data). _Expected:_ on A and B
   «Сервер сброшен…, на этом компьютере ничего не удалено» (The server was reset…, nothing was deleted on this computer); the files are in place. «Загрузить это хранилище на сервер
   заново» (Upload this vault to the server again) asks for a second confirmation; until the account is created again (step 4–5 of the section above), after
   the confirmation «Войдите снова» (Sign in again) appears.
10. **Files that are not synced.** On A create a symbolic link (`ln -s Привет.md ссылка.md`),
    on B (Windows) or with the name `a:b.md` on Mac/Linux, a file named `CON.txt`. _Expected:_ the «Не
    синхронизируется (N)» (Not synced (N)) block with a reason for each: «Символическая ссылка» (Symbolic link),
    «Имя нельзя создать на этой системе (недопустимый символ)…» (The name cannot be created on this system (invalid character)…). The file did not appear on the other computer, nothing was renamed.
11. **Rename with an edit.** On A rename a note and change its text before the sync pause passes
    (2–3 seconds). _Expected:_ on B one note with the new name and the new text; nothing appeared
    in B's trash.
12. **No network.** Turn off the network on A and save a note. _Expected:_ «Нет связи с сервером. Повторим через N
    с» (No connection to the server. Retrying in N s), the pause grows (5, 10, 20… seconds), the app does not freeze and closes without delay. Turn the network on:
    within a minute everything is «Всё синхронизировано» without pressing anything.
13. **Restart and turning off.** Close the app on A and open it again: sync continued by itself
    (without «Включить» (Enable)). «Выключить синхронизацию» (Turn off sync) → «Отмена» (Cancel) changes nothing; «Да, выключить» (Yes, turn off): «Синхронизация
    выключена» (Sync is turned off); an edit of a note on A does not appear on B; «Включить снова» (Enable again) — it appears, and there is no new space on the
    server.
14. **An unfinished operation.** On A create a database relation so that the operation is interrupted (in the native
    check: manually place the file `.amby/recovery/database_relations/x.json` with
    `{"status":"inProgress"}`) and change a note. _Expected:_ «Отправка приостановлена…» (Sending paused…); the change does not
    appear on B. Replace the status with `completed`: the change goes through.
15. **Language and theme.** English: all texts in the block are English; light and dark themes — warnings and stops
    are noticeable.

**Conflicts and deletions in plain view (manual check).** Two computers A and B with sync enabled and an open
note.

16. **Badge and notice.** Turn off the network on B, change one note on A and on B (differently), turn the network on.
    _Expected:_ near the bottom-right corner of the window a short notice about the second version appeared, the bell in the dock shows
    "1"; clicking the bell shows a list, in the row the note title, «Обе версии целы» (Both versions are intact) and one «Сравнить» (Compare) button.
17. **A card in the note.** Open the note. _Expected:_ above the bottom bar (time, words, undo, lock) a card
    opened by itself: "“Имя” изменили на двух компьютерах" (“Name” was changed on two computers), «Обе версии целы» and a «Сравнить» button, with no paths. Click the
    strip: the stack hid; click again: it showed. Notes without notices have no strip.
18. **Full comparison.** «Сравнить»: two versions side by side («Версия в заметке» (Version in the note) and «Вторая версия» (Second version), rendered as notes), two
    main buttons and the «…» menu. «Взять вторую версию» — the conflict card disappeared, and in its place a summary «В заметке…
    теперь вторая версия. Прежняя — в истории заметки» (The note… now has the second version. The previous one is in the note's history) with an «Открыть историю» (Open history) button; the button opens the note's history.
    Repeat for «Оставить версию в заметке» (the second version goes to the "Архив" (Archive)) and «Сохранить обе как отдельные заметки».
    If the note is not open, the summary stays as a row in the bell list until the list is closed.
19. **Deletion while the note is open.** Open the note on B and delete it on A. _Expected:_ on B above the note
    a card «Эту заметку удалили на другом компьютере. Она в архиве хранилища» (This note was deleted on another computer. It is in the vault archive) and «Вернуть» (Restore) (the stack opened
    by itself), the tab did not close.
    «Вернуть» — the note is back in the tree and on A.
20. **Deletion without opening.** Close the note on B and delete it on A. _Expected:_ no messages on B;
    the note is in the «Архив» panel.

21. **Badge on the winning computer.** After step 16, wait for sync on A (the one whose version stayed under the
    name). _Expected:_ on A there is also a badge with "1", a notice, and a card about the second version in the
    main file and in the copy. (Previously there was no badge on A.)
22. **Resolution from one computer.** On A choose «Оставить основной файл» (Keep the main file). _Expected:_ the badge and cards disappeared
    on A and on B; the copy is in the vault trash on B; on B the conflict list is empty without pressing anything.
23. **A note coming back after your own deletion.** On B close the note and delete it (sync pause of 2–3 seconds
    so the deletion goes through). On A, before syncing, open the same note, edit the text and wait for it to be sent. _Expected:_
    on B the note is back in the tree with the text from A, and at the bottom right a notice "Заметку «…» вернули: её правили на другом
    компьютере." (The note “…” was restored: it was edited on another computer.). Repeat with the note open on B: instead of the pop-up notice, a card "Заметку «…» вернули…" above the bar,
    without the "удалили" (deleted) card.
24. **Restoring an open note that has a copy (known defect).** Create a conflict (steps 16–17),
    open the main file on B and delete it on A (the copy remains). _Expected:_ «Восстановить файл» (Restore file) and
    «Восстановить локальную» (Restore the local one) return the note with its text; «Не удалось восстановить файл» (Could not restore the file) and «Не удалось
    сохранить текст» (Could not save the text) do not appear. Currently this is not the case: see `sync-test-fixes-report.md` (local archive).

**Note notices and block-level comparison (stage Э4б, К3 and К4; manual check).** The same setup: two computers,
the note `Заметки/1.md` has several paragraphs, a heading, a list of three items, and a code block.

25. **All warnings are above the bar.** There are no more yellow strips at the top of the note for any warning.
    Check in turn that each one is a card in the stack above the bottom bar, and the lightbulb shows the number
    of cards: (a) a note with broken YAML or a foreign `amby-id` (insert `---\nx: [\n---` at the start); (b) a note
    changed in another program while there are unsaved edits («Автосохранение приостановлено» (Autosave paused) → «Разрешить
    конфликт» (Resolve conflict) opens the previous window); (c) a file deleted externally while the tab is open («Файл удалён» (File deleted) → «Восстановить
    файл»); (d) a note that Live does not accept without loss (a message about the source view). Informational warnings
    (a, d) do not open by themselves, the lightbulb with the number is there; urgent ones (b, c) open by themselves. Close the stack with the lightbulb:
    a new urgent card opens it again.
26. **An unsaved draft.** Type text and kill the app (`kill -9`), open the note again. _Expected:_
    no dialog; the note is open with the text from disk **read-only** (lock), a card «Найдена
    несохранённая версия» (An unsaved version was found) with «Восстановить» (Restore) and «Отклонить» (Discard). «Восстановить»: the text from the draft is in the note, it is saved,
    the previous file is visible in history. Repeat: «Отклонить» keeps the text from disk, the note can be edited.
27. **Could not save.** Make the vault folder non-writable (`chmod a-w Заметки`) and type text.
    _Expected:_ a card «Не удалось сохранить заметку» (Could not save the note) opened by itself with «Сохранить сейчас» (Save now) (no system dialog);
    restore the permissions and press the button — the card disappeared, the text is on disk.
28. **Block-level comparison.** Turn off the network on B. On A change paragraph 2 and list item 2, on B — paragraph 3, and also
    paragraph 2 differently. Turn the network on. _Expected:_ paragraph 3 (edited on only one computer) would merge without a conflict
    after К1; while there is no merging yet, open «Сравнить»: the two versions are rendered as notes, the differing blocks (paragraphs,
    items, headings, code) are highlighted, each has «Моя / Другая / Обе» (Mine / Other / Both), and at the top «Отличий: N» (Differences: N). Choose «Другая» for
    paragraph 2, «Обе» for the item, and «Готово» (Done). _Expected:_ the window closed, the badge and card disappeared on both
    computers, the file has the desired result, the file's history has the previous version, the copy is in the «Архив». Open the file in Source and
    check that untouched blocks (unusual markup: `* ` in a list, an underlined heading `===`, lines with
    trailing spaces) stayed as they were, and the line endings (CRLF) and BOM did not change.
29. **Source view and non-note files.** A conflict on a note with reference-style links (`[a][ref]` and `[ref]: https://…`
    at the end) or with mixed line endings: the comparison opens in the source view (the caption "versions are shown
    in the source view"), and with mixed line endings — by choosing a whole version. A conflict on a `.json` or an image:
    only three buttons, «Это не текст: показать нечего» (This is not text: nothing to show) for non-text.

**Cleanup.** «Выключить синхронизацию» (Turn off sync) on both computers, «Выйти на этом устройстве» (Sign out on this device), `docker rm -f
amby-sync-smoke`, delete the test vaults.
