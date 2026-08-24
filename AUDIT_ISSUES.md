# Актуальный аудит и пошаговый план исправления Amby Notes

Дата актуализации: 24 августа 2026 года.

Этот документ заменяет первоначальный аудит от 20 августа. Он сопоставлен с текущим
кодом после `WP-00` — `WP-33`, результатами локальной проверки и фактической
трассировкой Markdown/Canvas autosave, Tauri multi-window lifecycle и файлового
watcher. Документ одновременно служит очередью работ для Codex.

## 1. Проверенный baseline

На ветке `dev` подтверждены:

- `npm run verify` — успешно;
- 267 тестов Vitest — успешно;
- 110 тестов Rust — успешно;
- TypeScript, ESLint, Prettier, Knip, Rustfmt, strict Clippy и generated bindings —
  успешно;
- `npm run build` — успешно;
- `npm run tauri build` — успешно, собраны macOS `.app` и arm64 `.dmg`;
- `npm audit --omit=dev` — известных production-уязвимостей не найдено;
- `cargo audit` — завершён без запрещённых advisories, но сообщил 18 разрешённых
  предупреждений: 17 unmaintained-зависимостей и `RUSTSEC-2024-0429` для
  транзитивного `glib`.

Автоматический baseline зелёный, но не моделирует несколько Tauri renderer-окон,
реальные события FSEvents/inotify/ReadDirectoryChangesW и закрытие процесса между
ProseMirror-сериализацией и постановкой autosave в очередь.

## 2. Легенда статусов

- `CONFIRMED` — дефект присутствует в текущем коде.
- `PARTIAL` — проблема реальна частично либо исходное объяснение/решение неточно.
- `FIXED` — пункт уже закрыт текущим кодом и проверками.
- `IMPLEMENTED` — код и автоматические проверки готовы, ручной Tauri-сценарий указан
  отдельно.
- `IN PROGRESS` — исправление выполняется в текущем рабочем пакете.

## 3. Исправленный реестр проблем

| ID      | Приоритет | Статус      | Краткое описание                                                                          | Рабочий пакет |
| ------- | --------- | ----------- | ----------------------------------------------------------------------------------------- | ------------- |
| BUG-01  | P0        | FIXED       | Дочернее окно повторно активирует vault и рассинхронизирует `backendGeneration`           | AUTO-01       |
| BUG-02  | P0        | FIXED       | Дочернее окно заменяет и останавливает process-wide watcher                               | AUTO-01       |
| BUG-03  | P0        | IMPLEMENTED | Own-write record регистрируется до публикации atomic write и привязан к операции          | AUTO-03       |
| BUG-04  | P1        | IMPLEMENTED | Подтверждённый Markdown draft сразу попадает в versioned autosave coordinator             | AUTO-04       |
| BUG-05  | P1        | IMPLEMENTED | CRLF/LF нормализуются, а false conflict через own-write race устранён                     | AUTO-03       |
| BUG-06  | P1        | IMPLEMENTED | Tiptap flush выполняется перед coordinator на close/switch/visibility lifecycle           | AUTO-05       |
| BUG-07  | P1        | IMPLEMENTED | История индексирована manifest и очищается только через подтверждённую retention UI       | DATA-01       |
| BUG-08  | P1        | IMPLEMENTED | Sidebar вызывает один debounced backend search вместо чтения каждой заметки               | SEARCH-01     |
| BUG-09  | P1        | IMPLEMENTED | SQLite FTS5 выполняет ограниченный name/content search без линейной загрузки файлов       | SEARCH-01     |
| BUG-10  | P2        | IMPLEMENTED | Чистые закрытые buffers освобождаются только после usage/autosave/conflict/recovery check | UI-02         |
| BUG-11  | P1        | IMPLEMENTED | Case-only rename проходит через temporary sibling и rollback без collision overwrite      | FS-01         |
| BUG-12  | P1        | IMPLEMENTED | No-replace publish имеет `create_new` stream-copy fallback для hard-link unsupported      | FS-02         |
| BUG-13  | P2        | IMPLEMENTED | Media batch вставляется одной mapped transaction без stale offset file-link               | UI-01         |
| BUG-14  | P2        | IMPLEMENTED | Column resize session очищает global listeners, rAF и DOM также из plugin destroy         | UI-01         |
| BUG-15  | P2        | IMPLEMENTED | Quick Open value содержит name, path и ID, поэтому duplicate filenames различимы          | UI-03         |
| BUG-16  | P2        | IMPLEMENTED | Split View отклоняет одинаковый document buffer в двух editable panes                     | UI-02         |
| BUG-17  | P3        | IMPLEMENTED | DnD проверяет self/descendant targets по нормализованным путям, не ULID                   | UI-03         |
| BUG-18  | P3        | IMPLEMENTED | Обе ветки `findWikiLinkItem` нормализуют `.md`                                            | UI-03         |
| BUG-19  | P3        | IMPLEMENTED | Notifications/help скрыты; presets остаётся рабочим dropdown menu                         | UI-03         |
| BUG-20  | P2        | IMPLEMENTED | Пустой/whitespace secret удаляет credential entry вместо сохранения пустой записи         | SEC-01        |
| BUG-21  | P3        | IMPLEMENTED | AI IPC возвращает safe typed code и provider; UI отображает локализованный текст          | SEC-01        |
| BUG-22  | P2        | IMPLEMENTED | Web adapter нормализует quota/storage failures в локализуемый `WebStorageError`           | SEC-01        |
| BUG-23  | P2        | IMPLEMENTED | Settings UI слушает save event; AI и credential save/delete promises обработаны           | SEC-01        |
| BUG-24  | P3        | FIXED       | Неиспользуемый `Path` удалён; strict Clippy проходит                                      | —             |
| BUG-25  | P0        | IMPLEMENTED | Два окна одной заметки защищены revision CAS и явной синхронизацией renderer’ов           | AUTO-02       |
| BUG-26  | P1        | IMPLEMENTED | Canvas recovery сравнивается с disk content и сразу enqueue-ится после подтверждения      | AUTO-04       |
| BUG-27  | P1        | IMPLEMENTED | Snippet и frontend highlight отображают folded match в исходные Unicode-границы           | SEARCH-01     |
| BUG-28  | P0        | FIXED       | `refreshTree()` повторно вызывает `load_vault` и увеличивает generation                   | AUTO-01       |
| DEBT-01 | P2        | CONFIRMED   | Крупные orchestration/domain-файлы всё ещё требуют разделения                             | ARCH-01       |
| DEP-01  | P2        | IMPLEMENTED | RustSec transitives имеют target/owner/review policy; новые advisories остаются failing   | SEC-02        |

## 4. Уточнения к первоначальным рекомендациям

### История

`docs/vault-format.md` закрепляет append-only историю и запрещает незаметную
автоматическую очистку. Поэтому BUG-07 нельзя исправлять молчаливой ротацией.
Нужны пользовательская retention policy, предварительный расчёт освобождаемого
места, подтверждение и безопасная очистка пар `metadata + snapshot`.

### No-replace создание

Fallback для BUG-12 не должен использовать обычный `rename`, способный заменить
внезапно появившийся target. Нужен платформенно безопасный no-clobber primitive
либо `create_new` + потоковое копирование + fsync + cleanup с отдельными тестами
гонки и collision.

### MediaDrop

Leaf image node в ProseMirror имеет `nodeSize = 1`, поэтому исходное объяснение
BUG-13 про размер image было неточным. Реальные дефекты: file link вставляет текст
длиной больше 1, а позиция увеличивается на 1; кроме того, позиция устаревает во
время асинхронного импорта.

### Conflict pause

CRLF/LF normalization уже выполнена в Rust read boundary. Отдельный вечный pause
через закрытие диалога сейчас не воспроизводится: диалог контролируемый и без
кнопки закрытия. Основной источник ложных conflicts — race BUG-03.

## 5. Пошаговые рабочие пакеты для Codex

Каждый пакет выполняется отдельно. Сначала добавляется regression-тест, затем
минимальное исправление, targeted checks и полный gate. Несвязанный cleanup не
смешивается с функциональным изменением.

### AUTO-01 — Active vault generation и единственный владелец watcher

Статус: `IMPLEMENTED`; автоматические проверки завершены, ручной multi-window
Tauri-сценарий перенесён в `AUTO-06`.

Цель: обновление дерева и открытие detached note window не должны повторно
активировать vault; watcher запускает и останавливает только окно `main`.

Шаги:

1. Добавить в `LoadVaultResult` канонический `vaultPath` и regenerated bindings.
2. Выделить тестируемые правила роли окна: `main` владеет watcher, `note-*`
   подключается к уже активному backend context.
3. Перевести `refreshTree()` на `loadActiveVaultData()` без increment generation.
4. В detached window на startup всегда использовать `loadActiveVaultData()`, не
   учитывая `reopenLastVault` как запрет явного открытия окна.
5. Передавать в `amby:vault-activated` `{ path, generation }`.
6. При событии того же path обновлять `backendGeneration`, а не игнорировать его.
7. Разделить watcher ownership и подписку на события: все окна слушают изменения,
   но только `main` вызывает start/stop.
8. Запретить detached-окнам сохранять общие `workspaces.json` и vault
   `session.json`.
9. Добавить TS/Rust regression-тесты.
10. Выполнить `npm run rust:test`, bindings check, targeted Vitest и
    `npm run verify`.

Критерии готовности:

- refresh и watcher event не меняют backend generation;
- создание/закрытие note window не заменяет и не останавливает watcher;
- все renderer-окна имеют одинаковые vault path и backend generation;
- stale generation test Rust продолжает проходить.

Реализовано:

- `LoadVaultResult` теперь возвращает канонический `vaultPath`; bindings
  регенерированы тестом `specta_export::export_bindings`;
- `refreshTree()` использует активный backend context и больше не вызывает
  активацию vault;
- detached-окно подключается через `loadActiveVaultData()`, получает фактические
  path/generation и не сохраняет глобальный workspace/session state;
- событие активации содержит generation, поэтому same-path событие больше не
  оставляет renderer с устаревшим поколением;
- lifecycle watcher принадлежит только окну `main`, подписка на его события
  остаётся во всех renderer-окнах;
- добавлены unit-тесты правил ролей окон, web contract и Rust regression на
  неизменность generation при чтении активного vault.

### AUTO-02 — Защита от одновременной записи одной заметки разными окнами

Статус: `IMPLEMENTED`; автоматические проверки завершены, ручной Tauri-сценарий
двух окон указан в журнале ниже.

Цель: сохранение из одного renderer не может быть молча перезаписано устаревшим
буфером другого renderer.

Шаги:

1. Добавить filesystem revision: hash фактических body bytes или устойчивую
   revision, возвращаемую `read_note`/`write_note`.
2. Передавать `expectedRevision` вместе с autosave.
3. Выполнять compare-and-swap до snapshot/write; mismatch возвращает typed conflict.
4. После успешной записи emit-ить событие с `noteId`, новой revision и origin window.
5. Чистые буферы других окон обновлять, dirty-буферы переводить в conflict.
6. Не полагаться на filesystem watcher для Amby-to-Amby синхронизации.
7. Добавить тесты двух renderer writers и stale revision.
8. Выполнить IPC/full gates и manual two-window scenario.

Реализовано:

- `read_note` возвращает body вместе с SHA-256 revision фактических body bytes;
  `write_note` принимает revision в `WriteNoteRequest` и сравнивает её до
  snapshot/atomic write. Stale writer получает typed `revisionConflict` с
  актуальной revision.
- После успешного сохранения backend отправляет `amby:note-written` с `noteId`,
  новой revision и `originWindow`. Другие renderer-окна обновляют clean buffer;
  dirty buffer получает existing conflict UI с внешним content/revision.
- Autosave, clone, merge и conflict resolution передают ожидаемую revision и
  обновляют её только из авторитетного результата write/read; watcher не
  используется для Amby-to-Amby синхронизации.
- Добавлены Rust regression-тесты двух writer’ов, stale revision и сохранения
  CRLF между последовательными CAS writes, а также Vitest-контракт двух writer’ов
  для web adapter.

### AUTO-03 — Атомарная регистрация own-write и внешний conflict

Цель: собственная запись никогда не создаёт false conflict, но внешняя запись не
скрывается временным grace window.

Шаги:

1. Заменить post-write-only marker на двухфазный record либо заранее вычисляемый
   expected fingerprint, привязанный к generation и operation token.
2. Удалять speculative record при ошибке filesystem operation.
3. Сверять event kind, generation и фактический fingerprint.
4. Не подавлять sibling/directory events широким marker.
5. Добавить deterministic test события, пришедшего до возврата atomic write.
6. Проверить create/write/rename/delete/history restore/assets.
7. Выполнить Rust gate и manual external-editor scenario.

Статус: `IMPLEMENTED`.

- `WatcherState::prepare_write` устанавливает ожидаемый точный fingerprint до
  filesystem operation и связывает его с generation и монотонным operation token.
  `confirm_prepared_write` оставляет запись лишь при совпадении фактического
  результата; `cancel_prepared_write` на ошибке удаляет только запись этой
  операции и не затрагивает более новую запись того же пути.
- Реализация сверяет kind события, generation и fingerprint. Маркеры существуют
  только для конкретных путей; directory/sibling path не получают общий grace
  marker.
- Предрегистрация применена к atomic note/file writes, conflict copy, созданию
  файлов и папок, rename/move, import assets, snapshot restore, trash delete и
  trash restore. Для текстовых writes fingerprint строится по фактическим байтам,
  которые опубликует `atomic_write`, с сохранением BOM и line endings.
- Добавлены детерминированные Rust-тесты события между публикацией и возвратом
  команды, отмены failed write, изоляции sibling, atomic rename old/new и защиты
  от отмены устаревшего operation token. Существующие тесты recycle bin и history
  покрывают delete/restore и snapshot restore.
- Автоматический Rust gate выполнен. Ручной сценарий Tauri с внешним редактором
  не выполнялся в headless-среде и остаётся для AUTO-06.

### AUTO-04 — Восстановление Markdown и Canvas recovery

Цель: подтверждённый recovery становится обычным dirty buffer и гарантированно
попадает на диск либо остаётся в journal.

Шаги:

1. После восстановления Markdown вызвать `enqueueImmediate` с актуальными path и
   backend generation.
2. Для Canvas сначала читать disk content, сравнивать с draft и спрашивать решение.
3. Подтверждённый Canvas recovery сразу enqueue-ить.
4. Отказ от recovery удаляет только проверенный draft, не disk content.
5. Close/switch должен считать восстановленный, но не сохранённый buffer dirty.
6. Добавить тесты restore/no-edit/close, stale Canvas draft и failed save.

Статус: `IMPLEMENTED`.

- После подтверждения Markdown recovery документ создаётся как dirty и сразу
  передаётся через `enqueueImmediate` с текущими path, backend generation и
  expected revision. Recovery draft удаляется только из callback успешного
  сохранения; ошибка оставляет coordinator dirty и journal на месте.
- Canvas сначала читает и нормализует disk content, затем сопоставляет его с
  нормализованным draft. При отличии показывается existing recovery prompt.
  Подтверждённый draft повторно фиксируется в journal и сразу enqueue-ится;
  отказ или совпадение удаляет только проверенный draft, не изменяя disk buffer.
- Добавлены unit-тесты pure решения recovery (stale Canvas accept/decline и
  already-persisted draft), а также coordinator-сценарии `restore → no edit →
close` и failed Canvas save. Dirty state сохраняется до успешного write.
- Проверки: 280 Vitest, 117 Rust, typecheck, ESLint, Prettier и strict Clippy.

### AUTO-05 — Flush ProseMirror до lifecycle flush

Цель: последняя транзакция редактора попадает в Markdown/recovery до close/switch.

Шаги:

1. Добавить editor serialization participant или imperative flush API.
2. На `visibilitychange`, close-request и перед vault switch сначала flush-ить
   редакторы, затем AutosaveCoordinator.
3. Не выполнять сериализацию untouched/transient editor document.
4. Добавить fake-timer test «edit → close < 200 ms».
5. Проверить Source/Live toggle и byte-exact fixtures.

Статус: `IMPLEMENTED`.

- Mounted `TiptapEditor` регистрирует guarded serialization participant. Он
  публикует Markdown только при реальном editor update; untouched/transient
  ProseMirror document остаётся no-op.
- `flushAutosaveGeneration` сначала синхронно вызывает все editor participants,
  затем сбрасывает соответствующие autosave queues. Этот порядок используется
  перед vault switch и Tauri close-request; `visibilitychange(hidden)` запускает
  тот же путь до приостановки renderer.
- Добавлен fake-timer regression `edit → close` на 199 мс: последний Markdown
  попадает в `AutosaveCoordinator` и сохраняется до завершения close flush.
  Existing Markdown compatibility suite продолжает проверять Source/Live и
  byte-exact fixtures.
- Проверки: 281 Vitest, typecheck и ESLint; полный Rust/full gate указан ниже.

### AUTO-06 — Сквозной autosave gate

1. Добавить integration harness двух renderer-окон с общим fake backend.
2. Проверить rapid edits, stale completion, child open/close, watcher refresh,
   external edit, recovery restore и vault switch.
3. Выполнить ручные Tauri сценарии на macOS; CI — Windows/Linux smoke tests.
4. Зафиксировать результаты в этом документе.

Статус: `IMPLEMENTED` для автоматического harness; ручной Tauri-проход остаётся
не выполнен в headless-среде.

- Добавлен `autosave-integration-harness.test.ts`: два независимых renderer
  buffers используют общий fake backend с revision CAS и событиями own-write /
  external editor, при этом реальная `AutosaveCoordinator` остаётся в цепочке.
- Harness проверяет rapid edits, stale completion с сохранением local dirty
  buffer как conflict, закрытие child window без потери main watcher ownership,
  reload чистого buffer после external edit, immediate persistence подтверждённого
  recovery и flush перед vault switch.
- Автоматический результат: 283 Vitest и 117 Rust; typecheck, ESLint, Prettier,
  Knip, Rustfmt и strict Clippy проходят. `npm run tauri dev` с двумя окнами и
  внешним редактором требует интерактивного desktop-сеанса и не может быть
  достоверно выполнен headless.

### DATA-01 — Управляемая retention policy истории

1. Добавить индекс/manifest, исключающий O(N) сканирование всех JSON.
2. Показать объём и количество snapshots по заметке/vault.
3. Реализовать явную cleanup/retention операцию с подтверждением.
4. При частичной ошибке не оставлять metadata без snapshot и наоборот.
5. Добавить quota/corruption/interrupted-cleanup tests и обновить vault format.

Статус: `IMPLEMENTED`.

- `.amby/history/manifest.json` стал versioned authoritative index метаданных
  snapshot’ов. Legacy `*.json` импортируются в него однократно, поэтому listing
  больше не читает все JSON-файлы при каждом запросе.
- Backend возвращает vault-wide count/size/notes и preview retention; панель
  истории показывает vault/per-note объём и перед явным подтверждением сообщает,
  сколько snapshots и байтов будет удалено. Политика UI оставляет 20 последних
  версий каждой заметки; автоматического pruning нет.
- Cleanup переносит data во staging, публикует новый manifest и затем удаляет
  staging data. Versioned cleanup journal восстанавливает либо завершает
  прерванную операцию до следующего history action; error-path не оставляет
  новую metadata без snapshot или snapshot без metadata.
- Rust tests покрывают legacy migration, retention preview/cleanup, corrupted
  missing data, interrupted cleanup и injected manifest-write failure (включая
  rollback нового snapshot и cleanup). `docs/vault-format.md` обновлён.

### SEARCH-01 — Единый безопасный backend search

1. Сначала исправить Unicode-safe snippet без byte slicing по несовпадающей строке.
2. Добавить кириллицу, emoji, combining marks и Turkish-I regression fixtures.
3. Перевести name/content/tag search на SQLite query/FTS с `LIMIT` и cancellation.
4. Удалить frontend `Promise.allSettled(read all files)`.
5. Измерить cold/warm поиск на 1k/10k заметок.

Статус: `IMPLEMENTED`.

- Добавлен rebuildable SQLite FTS5 index `notes_fts` с trigger-синхронизацией
  insert/update/delete и one-time rebuild для уже существующего `notes.db`.
  Name/content search выполняется через FTS с `LIMIT 50`; tag search использует
  индексированную таблицу `tags` с тем же лимитом.
- Rust snippets и frontend highlight больше не режут source string по offsets
  lowercased копии: case-folded символы отображаются обратно в границы исходного
  UTF-8/UTF-16 текста. Regression fixtures покрывают кириллицу, emoji, combining
  mark и Turkish I.
- Sidebar удалил `Promise.allSettled(readFile(...))` и использует один
  debounced `searchNotes` Storage/IPC запрос. Stale frontend results игнорируются
  по request token; web fallback остаётся за той же границей Storage API.
- Тесты FTS подтверждают limit=50, Unicode snippets и tag query. 284 Vitest,
  121 Rust, typecheck, ESLint, Prettier и strict Clippy проходят.

### FS-01 — Case-only rename

1. Выделить helper распознавания same filesystem entry.
2. Выполнять case-only rename через уникальный sibling temp и rollback.
3. Сохранять bundle main/canvas/excalidraw согласованными.
4. Добавить macOS/Windows tests для file/folder/bundle и collision.

Статус: `IMPLEMENTED`.

- `same_filesystem_entry` отличает другой colliding target от альтернативного
  spelling того же entry через canonical path (и device/inode на Unix).
- Case-only rename выполняется через уникальный sibling temp; неудачная вторая
  фаза возвращает исходное имя. Та же операция используется при bundle rename и
  rollback для main, Canvas и Excalidraw sidecar’ов.
- Platform-focused tests для macOS/Windows покрывают file, folder и bundle;
  collision tests защищают distinct file/folder, а существующий bundle collision
  test проверяет отсутствие частичных moves. `docs/vault-format.md` обновлён.

### FS-02 — Portable atomic no-replace creation

1. Выделить единый no-replace publish helper.
2. Сохранить `create_new`, size limit, fsync и cleanup guarantees.
3. Добавить fallback для unsupported hard links без overwrite race.
4. Проверить exFAT/FAT/network error classes и collision tests.

Статус: `IMPLEMENTED`.

- `publish_prepared_no_replace` стал общим publisher для byte write и file copy:
  он предпочитает hard link подготовленного fsync sibling temp.
- Для native error classes типичных hard-link unsupported FS используется
  `create_new` reservation final path, stream-copy, fsync и cleanup. Fallback
  не вызывает overwrite-capable `rename` и возвращает `AlreadyExists` при
  collision.
- Focused tests force fallback, проверяют byte/file-copy success, collision без
  overwrite, cleanup после copy failure и exFAT/FAT/network error classes.
  Сохранены существующие size-limit и create-new coverage; `vault-format.md`
  обновлён.

### UI-01 — MediaDrop и ColumnResize lifecycle

1. Импортировать все media, затем вставлять одной актуальной transaction.
2. Правильно учитывать размер file-link text и mapping позиции.
3. Добавить abort/cleanup при уничтожении editor.
4. Вынести resize session cleanup и вызывать его из plugin `destroy`.
5. Добавить focused unit tests и ручной multi-file/drop/resize сценарий.

### UI-01 — MediaDrop и ColumnResize lifecycle

Статус: `IMPLEMENTED`.

- MediaDrop и Tauri external drop сначала импортируют весь batch, затем вставляют
  результаты одной transaction текущего editor state. Следующая позиция выводится
  из `tr.mapping`, поэтому image `nodeSize = 1` и реальная длина file-link text
  не расходятся.
- Plugin и Tauri binding используют abort signals: completion async import после
  destroy/cleanup не dispatch-ит устаревшую transaction.
- Column resize использует idempotent session cleanup; `PluginView.destroy`
  отменяет rAF, global mouse/pointer listeners, body/classes и guide/label DOM.
- Focused Vitest покрывает mixed batch mapping, aborted batch и resize cleanup.
  Полный multi-file Finder/Tauri drop и destroy во время drag остаются ручными
  сценариями для desktop-сеанса.

### UI-02 — Документные буферы, вкладки и Split View

1. Добавить ref-count/usage check для открытых вкладок и panes.
2. Evict только чистый buffer без pending autosave/conflict/recovery.
3. Не показывать одну заметку в двух editable panes либо синхронизировать selection-safe.
4. Добавить close/reopen/pending-save/split tests.

Статус: `IMPLEMENTED`.

- `document-buffer-lifecycle.ts` считает отдельные ссылки вкладок и активных
  panes. После close, close-all, back/forward и document-навигации освобождаются
  только buffers без ссылок.
- Перед eviction проверяются dirty marker, external conflict, scheduled/in-flight/
  paused autosave и recovery draft по note ID и path. После асинхронного чтения
  recovery состояние вкладок перечитывается, поэтому быстрый reopen/edit сохраняет
  buffer.
- Split выбирает только другую заметку; дополнительная render guard исключает
  два editable редактора для одной заметки даже при устаревшем состоянии.
- Focused Vitest покрывает usage после close/reopen, pending autosave, recovery,
  store eviction и split guard. Ручной Tauri сценарий закрытия/reopen во время
  медленного файлового autosave не выполнен в headless-среде.

### UI-03 — Quick Open, DnD, wiki matching и пустые actions

1. Сделать `cmdk value` уникальным по path/id.
2. Валидировать DnD по source/target paths.
3. Нормализовать `.md` в обеих ветках wiki lookup.
4. Реализовать либо скрыть notifications/presets/help actions.
5. Добавить focused pure/component tests.

Статус: `IMPLEMENTED`.

- Quick Open передаёт cmdk unique value из filename, path и stable ID, сохраняя
  поиск по имени и пути при одинаковых filename.
- Tree DnD передаёт и сравнивает нормализованные source/target paths, запрещая
  self и descendant drop; файловые строки больше не объявляются folder targets,
  а mutation handler дополнительно отклоняет non-folder target.
- `findWikiLinkItem` удаляет `.md` в name и relative-path ветках до
  case-insensitive matching.
- Неработающие notifications/help исключены из definitions и persistent layout.
  Presets остаётся отдельным рабочим dropdown menu, поэтому не получает пустой
  action callback.
- Focused Vitest покрывает duplicate Quick Open values, path-based DnD validation,
  обе `.md` wiki ветки и отсутствие пустых actions. Ручной Tauri DnD/Quick Open
  smoke остаётся для desktop-сеанса.

### SEC-01 — Credentials, localization и видимые storage errors

1. Пустой secret в backend должен удалять credential или отклоняться typed error.
2. Rust AI возвращает error codes/context, UI локализует сообщения.
3. Web adapter централизованно преобразует quota/storage errors.
4. Подключить UI listener к `SETTINGS_SAVE_ERROR_EVENT` и обработать AI save promise.
5. Добавить tests, не выводящие secret/path-sensitive детали.

Статус: **IMPLEMENTED**.

- Backend удаляет credential при пустом или whitespace secret; unit test проверяет
  путь удаления без обращения к системному keychain.
- `ai_chat` возвращает сгенерированный Specta typed error (`code`, `provider`) и
  никогда не отправляет renderer’у provider response, URL или credential details.
  Клиент локализует code, включая непредвиденные transport failures.
- Web fallback оборачивает read/write/delete global, vault и credential metadata в
  безопасный `WebStorageError` с кодами `quotaExceeded`/`unavailable`.
- Settings dialog показывает событие ошибки сохранения; AI settings и credential
  операции перехватывают rejected promises и сохраняют модель только после
  успешного удаления credential.
- Focused Rust/Vitest tests покрывают empty credential, sanitised typed AI error,
  typed AI-client localization и quota normalization без secret или path details.

### SEC-02 — Rust dependency advisories

1. Зафиксировать `cargo tree --target all` для каждого advisory.
2. Отделить build/dev/target-specific зависимости от runtime surface.
3. Обновить прямые зависимости, где это возможно без format/API migration.
4. Для неизбежных transitives документировать owner, target и review date.
5. Настроить явную audit policy вместо неограниченного списка allowed warnings.

Статус: **IMPLEMENTED**.

- `cargo audit` зафиксировал 18 warning-level RustSec advisories: GTK3/glib Linux
  chain Tauri/Wry/rfd, Specta proc-macro `paste` и `tauri-utils` Unicode chain.
  `cargo tree --target all` подтвердил их owners и build/runtime targets.
- `tauri` уже использует текущую совместимую версию 2.11.5. `rfd` 0.17.2 был
  проверен и отклонён: он откатывает `tauri-plugin-dialog` до 2.4.2 и добавляет
  второй dialog dependency; lockfile восстановлен на совместимую 0.16.0.
- `scripts/audit-rust.sh` перечисляет только конкретные RustSec IDs. Новый
  advisory не будет автоматически разрешён; owner, target и review date каждого
  исключения записаны в `docs/security-advisories.md` (повторная проверка
  2026-11-24).

### ARCH-01 — Оставшееся разделение крупных файлов

Статус: `PENDING`.

На 24 августа 2026 года функциональные correctness-пакеты реализованы, но само
архитектурное разделение ещё не выполнено. Частичные helpers, созданные во время
предыдущих исправлений, не закрывают `ARCH-01`: целевые файлы по-прежнему содержат
несколько независимых обязанностей.

Текущий размер целевых файлов:

- `src-tauri/src/bundle.rs` — 1863 строки;
- `src/components/workspace/workspace.tsx` — 1391 строка;
- `src/components/workspace/tiptap/markdown.ts` — 1214 строк;
- `src/components/workspace/use-file-actions.ts` — 1066 строк;
- `src/lib/storage/web-adapter.ts` — 869 строк.

`ARCH-01` нельзя выполнять одной большой правкой. Он состоит из пяти независимых
commit-sized подпакетов `ARCH-01A` — `ARCH-01E`. Codex выполняет только один
подпакет за запуск и не переходит к следующему без отдельного указания.

#### ARCH-00 — Контрольная точка перед структурным рефакторингом

Статус: `PENDING`.

1. Зафиксировать все функциональные пакеты в Git до начала перемещений.
2. Включить сгенерированный `src/lib/bindings.ts` в тот же checkpoint, что и
   изменившие IPC Rust-типы.
3. На чистом относительно checkpoint рабочем дереве выполнить `npm run verify` и
   убедиться, что `bindings:check` полностью зелёный.
4. Сохранить список текущих тестов: минимум 300 Vitest и 136 Rust tests.
5. Не смешивать последующие структурные перемещения с исправлением нового
   поведения. Обнаруженный дефект оформляется отдельным пакетом.

Причина обязательной контрольной точки: сейчас в рабочем дереве одновременно
находятся десятки функциональных изменений, пересекающихся со всеми пятью
ARCH-целями. Без checkpoint невозможно надёжно отличить move-only diff от изменения
поведения и безопасно откатить отдельный архитектурный шаг.

#### Общий протокол для ARCH-01A — ARCH-01E

Для каждого подпакета Codex обязан:

1. Сначала зафиксировать существующие публичные exports, импорты и тестовые
   контракты целевого файла.
2. Добавить или сохранить focused tests на перемещаемое поведение до переноса.
3. Перемещать код механически, без изменения сериализации, persistence, UI и IPC
   contracts.
4. Оставить compatibility façade, если старый import path используется другими
   модулями.
5. Не создавать параллельное Zustand-состояние и не обходить `src/lib/storage.ts`.
6. Не допускать нового циклического импорта; существующий цикл Markdown/schema не
   должен ухудшиться.
7. Форматировать только затронутые frontend/Rust-файлы.
8. Выполнить targeted tests, затем `npm run verify` и `npm run build`.
9. Обновить журнал этого документа фактическими командами, количеством тестов и
   оставшимися ручными сценариями.
10. Остановиться после одного подпакета.

#### ARCH-01A — Rust bundle domain

Статус: `PENDING`.

Цель: превратить `bundle.rs` в узкий façade над модулями планирования,
filesystem-исполнения, rollback, layers и assets.

Планируемая структура:

- `src-tauri/src/bundle/mod.rs` — публичные crate-level entrypoints и re-exports;
- `src-tauri/src/bundle/path_ops.rs` — case-safe rename, no-clobber проверки,
  уникальные sibling paths и общие path helpers;
- `src-tauri/src/bundle/scan.rs` — bundle tree scan и классификация bundle main;
- `src-tauri/src/bundle/planning.rs` — preview rename/move и `PathChange` planning;
- `src-tauri/src/bundle/notes.rs` — создание/продвижение standalone note;
- `src-tauri/src/bundle/layers.rs` — Canvas/Excalidraw layer create/attach/unlink/delete;
- `src-tauri/src/bundle/execute.rs` — rename/move execution;
- `src-tauri/src/bundle/rollback.rs` — rollback rename/move/promotion;
- `src-tauri/src/bundle/assets.rs` — sanitize/sniff/classify/import helpers;
- тесты рядом с владельцем поведения либо в `src-tauri/src/bundle/tests.rs`.

Критерии готовности:

- в `bundle/mod.rs` нет самостоятельных filesystem-алгоритмов;
- planning не изменяет filesystem;
- execute и rollback используют единые no-clobber/path helpers;
- assets не зависят от rename/move orchestration;
- все существующие success/failure/collision/rollback tests сохранены;
- `bundle/mod.rs` не более 250 строк, каждый production submodule не более 500
  строк; крупные test fixtures вынесены из production-модулей;
- `cargo fmt --check`, strict Clippy, Rust tests и полный frontend gate проходят.

#### ARCH-01B — Frontend file actions

Статус: `PENDING`.

Цель: оставить `use-file-actions.ts` композиционным façade, а document loading,
autosave, navigation и filesystem mutations распределить по focused hooks.

Планируемая структура:

- `file-actions/types.ts` — параметры и возвращаемый контракт;
- `file-actions/use-markdown-autosave.ts` — coordinator, recovery и revision state;
- `file-actions/use-document-loading.ts` — select/open/clone/buffer lifecycle;
- `file-actions/use-wiki-navigation.ts` — wiki target, anchor и create-missing flow;
- `file-actions/use-document-crud.ts` — create/delete/new folder/new Canvas;
- `file-actions/use-document-mutations.ts` — rename/move/merge и mutation results;
- `file-actions/index.ts` — внутренние exports;
- `use-file-actions.ts` — compatibility façade и композиция hooks.

Критерии готовности:

- autosave coordinator и recovery draft имеют одного владельца;
- ни один hook не создаёт копию `openDocs`, tabs или vault generation;
- rename/move/merge продолжают flush-ить очередь до mutation;
- wiki navigation не зависит от CRUD implementation details;
- `use-file-actions.ts` не более 300 строк, focused hooks не более 400 строк;
- autosave, document-buffer, recovery, tab-actions и mutation tests проходят.

#### ARCH-01C — Workspace orchestration и layout

Статус: `PENDING`.

Цель: оставить `Workspace` верхнеуровневым composition root без Canvas autosave,
vault mutations, property mutations и построения больших editor/panel props внутри
одного React-компонента.

Планируемая структура:

- `orchestration/use-canvas-workspace.ts` — Canvas buffers, recovery и autosave;
- `orchestration/use-vault-actions.ts` — open/rename/move/delete vault;
- `orchestration/use-property-actions.ts` — custom property mutations;
- `orchestration/use-panel-render-props.ts` — стабильный `PanelRenderProps`;
- `workspace-editor-panes.tsx` — primary/secondary editor rendering;
- `workspace-layout.tsx` — focus/normal layout shell;
- `workspace.tsx` — store subscriptions, composition и связывание модулей.

Критерии готовности:

- `Workspace` не содержит domain filesystem/storage calls;
- Canvas и Markdown coordinators остаются независимыми, но участвуют в общем
  lifecycle flush;
- layout-компоненты получают явные props и не создают второе workspace state;
- все visible strings остаются в `src/locales/resources.ts`;
- `workspace.tsx` не более 500 строк, layout/editor components не более 400 строк;
- production build, workspace tests и полный verify проходят без новых hook lint
  suppressions.

#### ARCH-01D — Markdown parser/serializer boundary

Статус: `PENDING`.

Цель: разделить Markdown-it plugins, ProseMirror parser, serializer, readonly
renderer и compatibility guards, сохранив прежний публичный import path.

Планируемая структура:

- `markdown-inline.ts` — Amby inline HTML/style rule;
- `markdown-block-plugins.ts` — columns, empty paragraphs, task lists, callouts,
  Amby blocks, transclusions и math preservation;
- `markdown-parser.ts` — token mapping и lazy `MarkdownParser`;
- `markdown-serializer.ts` — marks/nodes/table serialization;
- `markdown-readonly.ts` — safe raw-HTML-disabled renderer;
- существующий `markdown-compatibility.ts` — formatting restore и round-trip guard;
- `markdown.ts` — стабильный façade `markdownToDoc`, `docToMarkdown`,
  `roundTripCheck`, `markdownToSafeReadonlyHtml`.

Критерии готовности:

- старые imports продолжают работать через `markdown.ts`;
- Source/Live admission остаётся byte-exact;
- неизвестные Markdown/YAML/HTML, columns markers, BOM и line endings сохраняются;
- parser/serializer не получают новый eager цикл со `schema.ts`;
- `markdown.ts` не более 200 строк, каждый production module не более 500 строк;
- все Markdown compatibility fixtures и focused round-trip tests проходят.

#### ARCH-01E — Web storage adapter

Статус: `PENDING`.

Цель: оставить `WebAdapter` реализацией `StoragePort`, делегирующей notes,
mutations, search, history и metadata отдельным web ports без дублирования tree
state.

Планируемая структура:

- сохранить `web-tree.ts`, `web-frontmatter.ts`, `web-metadata.ts` и
  `web-storage-error.ts` как существующие primitives;
- `web-notes.ts` — note/file read-write и revision CAS;
- `web-mutations.ts` — create/rename/move/delete/layer operations;
- `web-search.ts` — ограниченный browser fallback search;
- `web-history.ts` — explicit desktop-only/no-op history contract;
- `web-settings.ts` — workspace/vault metadata и credentials delegation;
- `web-adapter.ts` — wiring `StoragePort`, dialogs и browser-only boundaries.

Критерии готовности:

- `WebAdapter` не содержит самостоятельных tree traversal/frontmatter algorithms;
- все localStorage операции проходят через web storage helpers и нормализованные
  quota errors;
- web revision CAS и desktop contract имеют одинаковую семантику conflict;
- frontend components не обращаются к localStorage напрямую;
- `web-adapter.ts` не более 350 строк, production helpers не более 400 строк;
- storage contract tests, web recovery/settings tests и полный verify проходят.

#### Общие критерии завершения ARCH-01

`ARCH-01` получает статус `IMPLEMENTED` только когда одновременно выполнены:

1. `ARCH-00` и все пять подпакетов `ARCH-01A` — `ARCH-01E`.
2. Все старые публичные imports либо сохранены, либо мигрированы одной проверяемой
   правкой без compatibility break.
3. Ни один из пяти исходных façade-файлов не превышает указанный budget.
4. Не добавлены новые persistence formats, IPC commands, permissions и UI behavior.
5. `npm run verify` полностью зелёный, включая `bindings:check`, на чистом
   относительно checkpoint дереве.
6. `npm run build` успешно создаёт production frontend bundle.
7. Журнал содержит результаты каждого подпакета отдельно.

## 6. Порядок выполнения

Обязательная последовательность:

1. `AUTO-01` — generation и watcher ownership.
2. `AUTO-02` — cross-window compare-and-swap.
3. `AUTO-03` — watcher race.
4. `AUTO-04` — recovery restore.
5. `AUTO-05` и `AUTO-06` — lifecycle flush и сквозной gate.
6. `SEARCH-01`, затем `DATA-01`.
7. `FS-01`, `FS-02`.
8. `UI-01`, `UI-02`, `UI-03`.
9. `SEC-01`, `SEC-02`.
10. `ARCH-01` — только после стабилизации correctness contracts.

Нельзя начинать автоматическое pruning истории, менять persistent formats или
ослаблять no-replace semantics без отдельного документированного решения.

## 7. Журнал выполнения

| Пакет     | Статус      | Проверки                                                                                                                                   | Примечание                                                                                                       |
| --------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| AUTO-01   | IMPLEMENTED | 273 Vitest; 111 Rust; typecheck; ESLint; Prettier; Knip; Rustfmt; strict Clippy; повторная генерация bindings без дополнительных изменений | Ручной сценарий `main + note window + external edit` оставлен AUTO-06                                            |
| AUTO-02   | IMPLEMENTED | `npm run verify`: 275 Vitest; 114 Rust; typecheck; ESLint; Prettier; Knip; Rustfmt; strict Clippy; export_bindings                         | Ручной сценарий двух Tauri-окон не выполнен в headless-среде; финальный `bindings:check` diff ожидаем до commit  |
| AUTO-03   | IMPLEMENTED | `npm run verify`: 275 Vitest; 117 Rust; typecheck; ESLint; Prettier; Knip; Rustfmt; strict Clippy; export_bindings                         | Ручной сценарий external editor не выполнен в headless-среде; финальный `bindings:check` diff ожидаем до commit  |
| AUTO-04   | IMPLEMENTED | 280 Vitest; 117 Rust; typecheck; ESLint; Prettier; strict Clippy                                                                           | Ручные Canvas/Markdown recovery-сценарии в Tauri не выполнены в headless-среде                                   |
| AUTO-05   | IMPLEMENTED | 281 Vitest; typecheck; ESLint; Prettier; Rustfmt; strict Clippy; 117 Rust; export_bindings                                                 | Ручные close/switch/visibility сценарии Tauri остаются для AUTO-06                                               |
| AUTO-06   | IMPLEMENTED | 283 Vitest; 117 Rust; typecheck; ESLint; Prettier; Knip; Rustfmt; strict Clippy; export_bindings                                           | Реальные macOS two-window/external-editor/close сценарии не выполнены в headless-среде                           |
| SEARCH-01 | IMPLEMENTED | 284 Vitest; 121 Rust; typecheck; ESLint; Prettier; Knip; Rustfmt; strict Clippy; export_bindings                                           | FTS query capped at 50; headless smoke не измеряет UX latency на пользовательском vault                          |
| DATA-01   | IMPLEMENTED | `npm run verify`: 284 Vitest; 128 Rust; typecheck; ESLint; Prettier; Knip; Rustfmt; strict Clippy; export_bindings                         | Ручной Tauri cleanup/restore scenario не выполнен в headless-среде; final bindings diff ожидаем до commit        |
| FS-01     | IMPLEMENTED | `npm run verify`: 284 Vitest; 131 Rust; typecheck; ESLint; Prettier; Knip; Rustfmt; strict Clippy; export_bindings                         | macOS case-only tests выполнены; Windows cfg tests добавлены, но не запускались на текущей машине                |
| FS-02     | IMPLEMENTED | `npm run verify`: 284 Vitest; 134 Rust; typecheck; ESLint; Prettier; Knip; Rustfmt; strict Clippy; export_bindings                         | Fallback моделируется fault injection; реальные exFAT/FAT/network mounts не доступны в текущей среде             |
| UI-01     | IMPLEMENTED | `npm run verify`: 287 Vitest; 134 Rust; typecheck; ESLint; Prettier; Knip; Rustfmt; strict Clippy; export_bindings                         | Ручные multi-file Finder/Tauri drop и destroy during resize не выполнены в headless-среде                        |
| UI-02     | IMPLEMENTED | `npm run verify`: 293 Vitest; 134 Rust; typecheck; ESLint; Prettier; Knip; Rustfmt; strict Clippy; export_bindings                         | Ручной Tauri close/reopen во время медленного autosave не выполнен в headless-среде; final bindings diff ожидаем |
| UI-03     | IMPLEMENTED | `npm run verify`: 297 Vitest; 134 Rust; typecheck; ESLint; Prettier; Knip; Rustfmt; strict Clippy; export_bindings                         | Ручной Tauri DnD и Quick Open smoke не выполнен в headless-среде; final bindings diff ожидаем                    |
| SEC-01    | IMPLEMENTED | `npm run verify`: 299 Vitest; 136 Rust; typecheck; ESLint; Prettier; Knip; Rustfmt; strict Clippy; export_bindings                         | Headless: no live OS keychain/Tauri event scenario; final bindings diff is expected from prior uncommitted work  |
| SEC-02    | IMPLEMENTED | `npm run audit`: npm 0 vulnerabilities; Rust policy passes; `npm run verify`: 299 Vitest, 136 Rust, typecheck, lint, format, Knip, Clippy  | `bindings:check` export passes; final diff is expected from prior uncommitted generated bindings                 |
| ARCH-00   | IMPLEMENTED | `96dad9f`; `npm run verify`: 300 Vitest; 136 Rust; typecheck; ESLint; Prettier; Knip; Rustfmt; strict Clippy; `bindings:check` без diff    | Функциональный checkpoint создан до structural moves; новых ручных сценариев нет, остаются MANUAL-01 — MANUAL-07 |
| ARCH-01A  | PENDING     | —                                                                                                                                          | Rust bundle domain                                                                                               |
| ARCH-01B  | PENDING     | —                                                                                                                                          | Frontend file actions                                                                                            |
| ARCH-01C  | PENDING     | —                                                                                                                                          | Workspace orchestration и layout                                                                                 |
| ARCH-01D  | PENDING     | —                                                                                                                                          | Markdown parser/serializer boundary                                                                              |
| ARCH-01E  | PENDING     | —                                                                                                                                          | Web storage adapter                                                                                              |
| FINAL-01  | PENDING     | —                                                                                                                                          | Полный release gate и ручные сценарии                                                                            |

Примечание к `AUTO-01`: `npm run verify` выполнил все функциональные этапы, но
завершился кодом 1 на финальном `bindings:check`, потому что корректно
регенерированный `src/lib/bindings.ts` содержит ожидаемый незакоммиченный diff с
новым `vaultPath`. Сам тест `specta_export::export_bindings` проходит, повторный
запуск не создаёт новых изменений. После фиксации текущего пакета в Git этот gate
станет полностью зелёным.

После каждого пакета Codex обновляет этот журнал фактическими командами и отдельно
указывает невыполненные ручные сценарии.

## 8. Полный остаток ручной и финальной проверки

Автоматическая проверка 24 августа 2026 года подтвердила 300 Vitest, 136 Rust
tests, TypeScript, ESLint, Prettier, Knip, Rustfmt, strict Clippy и production
frontend build. `npm run verify` завершился кодом 1 только на финальном
`bindings:check`: сгенерированный файл содержит ожидаемые незакоммиченные IPC
изменения. Это должно быть устранено контрольной точкой `ARCH-00`, а не ручным
редактированием `bindings.ts`.

Ниже перечислена вся работа, которая остаётся после автоматических correctness
пакетов. Пункт нельзя считать выполненным без записи фактического результата в
этот раздел.

### MANUAL-01 — Реальные Tauri multi-window autosave и conflict

Статус: `PENDING`.

На macOS в `npm run tauri dev`:

1. Открыть vault в `main`, затем ту же заметку в detached note window.
2. Убедиться, что оба окна показывают одинаковые canonical vault path и generation.
3. Сохранить из одного окна: чистый buffer другого окна должен обновиться.
4. Изменить заметку одновременно в двух окнах: второй stale save должен получить
   revision conflict, а не перезаписать первый.
5. Проверить варианты keep local, accept external и save conflict copy.
6. Закрыть detached-окно и убедиться, что watcher продолжает работать в `main`.
7. Повторить rapid edits и закрытие окна во время pending autosave.

### MANUAL-02 — External editor и filesystem watcher

Статус: `PENDING`.

1. Открыть чистую заметку и изменить её внешним редактором: Amby должен обновить
   buffer без ложного conflict.
2. Повторить с локально dirty buffer: должен появиться conflict без silent overwrite.
3. Проверить external atomic-save/rename pattern используемого редактора.
4. Внешне переименовать, переместить и удалить открытую заметку.
5. Проверить, что собственная запись Amby не создаёт watcher conflict, а соседнее
   внешнее изменение не подавляется own-write record.
6. Повторить после открытия и закрытия detached window.

### MANUAL-03 — Close/switch/visibility и recovery

Статус: `PENDING`.

1. В Live Preview изменить документ и закрыть окно быстрее 200 мс.
2. Повторить перед vault switch и при `visibilitychange` в hidden.
3. Прервать приложение между editor serialization и filesystem save.
4. Перезапустить и проверить Markdown recovery: accept, decline и save failure.
5. Проверить Canvas recovery при совпадающем и отличающемся disk content.
6. Убедиться, что recovery draft удаляется только после успешного filesystem save.
7. Проверить сохранение BOM, CRLF и terminal line breaks после recovery.

### MANUAL-04 — History retention и restore

Статус: `PENDING`.

1. На тестовом vault создать несколько версий нескольких заметок.
2. Сверить UI stats с фактическим количеством и размером snapshots.
3. Проверить preview cleanup и отмену без изменений filesystem.
4. Выполнить cleanup по count и age retention.
5. Восстановить оставшийся snapshot после cleanup.
6. Перезапустить приложение и убедиться, что manifest читается без полного O(N)
   восстановления и не скрывает повреждённые записи.

### MANUAL-05 — Filesystem portability

Статус: `PENDING`.

1. Выполнить case-only rename note/folder/bundle на Windows.
2. Проверить bundle main, Canvas и Excalidraw sidecars после rename и rollback.
3. Проверить no-replace create/import на реальных exFAT и FAT носителях.
4. По возможности проверить network filesystem без hard-link support.
5. Во всех случаях смоделировать внезапно появившийся target и убедиться, что
   пользовательский файл не перезаписан.

### MANUAL-06 — UI interactions

Статус: `PENDING`.

1. Перетащить несколько файлов из Finder в Tiptap и проверить порядок image/file
   links после асинхронного импорта.
2. Уничтожить editor во время column resize и проверить отсутствие зависших
   listeners, rAF и resize DOM.
3. Проверить DnD note/folder на self, descendant, root и допустимый target.
4. Проверить Quick Open с одинаковыми именами в разных папках.
5. Проверить запрет одной editable заметки в двух split panes.
6. Закрыть и открыть вкладку во время pending autosave; dirty/conflict/recovery
   buffer не должен быть преждевременно evicted.

### MANUAL-07 — Settings, credentials и AI errors

Статус: `PENDING`.

1. Проверить store/delete/inspect credential через реальный macOS Keychain.
2. Сохранить whitespace secret и убедиться, что credential удалён.
3. Смоделировать ошибку сохранения settings и проверить видимое локализованное
   уведомление.
4. Проверить AI network/provider/configuration errors для настроенных providers.
5. Убедиться, что UI/logs/IPC errors не содержат secret, полный provider response
   или чувствительные request details.

### PERF-01 — Search smoke и измерения

Статус: `PENDING`.

1. Подготовить тестовые vaults примерно на 1 000 и 10 000 заметок.
2. Измерить cold/warm name, content и tag search.
3. Проверить cancellation/debounce при быстром вводе.
4. Подтвердить limit 50 и отсутствие frontend read-all IPC fan-out.
5. Записать размеры vault, платформу и фактическое время ответа в журнал.

### FOLLOWUP-01 — Rust dependency review

Статус: `SCHEDULED` на 24 ноября 2026 года.

1. Повторно выполнить `npm run audit` и `cargo tree --target all`.
2. Перепроверить owners/targets всех разрешённых RustSec advisories.
3. Обновить совместимые прямые зависимости без добавления второго Tauri dialog
   stack.
4. Новый advisory не добавлять в allowlist без owner, target, причины и следующей
   даты review.

### FINAL-01 — Финальный release gate

Статус: `PENDING`.

Выполняется только после `ARCH-01A` — `ARCH-01E` и доступных ручных сценариев:

1. `git diff --check`.
2. `npm run verify` — должен завершиться кодом 0, включая `bindings:check`.
3. `npm run build`.
4. `npm run audit`.
5. `npm run tauri build`.
6. Проверить, что `dist/`, `src-tauri/target/`, vault data, `.amby/`, credentials и
   recovery drafts не добавлены в Git.
7. Обновить `DEBT-01` и `ARCH-01` на `IMPLEMENTED` только после выполнения всех
   критериев.
8. Записать невыполнимые на текущей платформе сценарии как явные release risks, а
   не отмечать их выполненными.

## 9. Короткий промпт для продолжения

После этой детализации Codex нужно передавать только один номер:

```text
Прочитай AGENTS.md и AUDIT_ISSUES.md.
Выполни пакет ARCH-00 полностью по указанному протоколу.
Не переходи к следующему пакету. Обнови журнал фактическими результатами.
```

После завершения `ARCH-00` последовательно заменять номер на `ARCH-01A`,
`ARCH-01B`, `ARCH-01C`, `ARCH-01D`, `ARCH-01E`, затем `FINAL-01`.
