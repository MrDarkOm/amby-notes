# Актуальный аудит и пошаговый план исправления Amby Notes

Дата актуализации: 30 августа 2026 года.

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

| ID      | Приоритет | Статус      | Краткое описание                                                                           | Рабочий пакет        |
| ------- | --------- | ----------- | ------------------------------------------------------------------------------------------ | -------------------- |
| BUG-01  | P0        | FIXED       | Дочернее окно повторно активирует vault и рассинхронизирует `backendGeneration`            | AUTO-01              |
| BUG-02  | P0        | FIXED       | Дочернее окно заменяет и останавливает process-wide watcher                                | AUTO-01              |
| BUG-03  | P0        | IMPLEMENTED | Own-write record регистрируется до публикации atomic write и привязан к операции           | AUTO-03              |
| BUG-04  | P1        | IMPLEMENTED | Подтверждённый Markdown draft сразу попадает в versioned autosave coordinator              | AUTO-04              |
| BUG-05  | P1        | IMPLEMENTED | CRLF/LF нормализуются, а false conflict через own-write race устранён                      | AUTO-03              |
| BUG-06  | P1        | IMPLEMENTED | Tiptap flush выполняется перед coordinator на close/switch/visibility lifecycle            | AUTO-05              |
| BUG-07  | P1        | IMPLEMENTED | История индексирована manifest и очищается только через подтверждённую retention UI        | DATA-01              |
| BUG-08  | P1        | IMPLEMENTED | Sidebar вызывает один debounced backend search вместо чтения каждой заметки                | SEARCH-01            |
| BUG-09  | P1        | IMPLEMENTED | SQLite FTS5 выполняет ограниченный name/content search без линейной загрузки файлов        | SEARCH-01            |
| BUG-10  | P2        | IMPLEMENTED | Чистые закрытые buffers освобождаются только после usage/autosave/conflict/recovery check  | UI-02                |
| BUG-11  | P1        | IMPLEMENTED | Case-only rename проходит через temporary sibling и rollback без collision overwrite       | FS-01                |
| BUG-12  | P1        | IMPLEMENTED | No-replace publish имеет `create_new` stream-copy fallback для hard-link unsupported       | FS-02                |
| BUG-13  | P2        | FIXED       | Media batch remap-ит исходный anchor, не уже mapped position; mixed batch из 3 файлов PASS | MANUAL-06-DROP-FIX   |
| BUG-14  | P2        | FIXED       | Column resize очищает listeners, rAF и DOM при destroy; runtime close-tab до release PASS  | UI-01                |
| BUG-15  | P2        | FIXED       | Quick Open value уникален по path/ID; обе одноимённые заметки доступны через клавиатуру    | UI-03                |
| BUG-16  | P2        | FIXED       | Split View отклоняет одинаковый document buffer в двух editable panes; macOS runtime PASS  | UI-02                |
| BUG-17  | P3        | FIXED       | DnD запрещает self/descendant по paths; root/valid move и сохранность байтов проверены     | UI-03                |
| BUG-18  | P3        | IMPLEMENTED | Обе ветки `findWikiLinkItem` нормализуют `.md`                                             | UI-03                |
| BUG-19  | P3        | IMPLEMENTED | Notifications/help скрыты; presets остаётся рабочим dropdown menu                          | UI-03                |
| BUG-20  | P2        | IMPLEMENTED | Пустой/whitespace secret удаляет credential entry вместо сохранения пустой записи          | SEC-01               |
| BUG-21  | P3        | IMPLEMENTED | AI IPC возвращает safe typed code и provider; UI отображает локализованный текст           | SEC-01               |
| BUG-22  | P2        | IMPLEMENTED | Web adapter нормализует quota/storage failures в локализуемый `WebStorageError`            | SEC-01               |
| BUG-23  | P2        | IMPLEMENTED | Settings UI слушает save event; AI и credential save/delete promises обработаны            | SEC-01               |
| BUG-24  | P3        | FIXED       | Неиспользуемый `Path` удалён; strict Clippy проходит                                       | —                    |
| BUG-25  | P0        | IMPLEMENTED | Два окна одной заметки защищены revision CAS и явной синхронизацией renderer’ов            | AUTO-02              |
| BUG-26  | P1        | IMPLEMENTED | Canvas recovery сравнивается с disk content и сразу enqueue-ится после подтверждения       | AUTO-04              |
| BUG-27  | P1        | IMPLEMENTED | Snippet и frontend highlight отображают folded match в исходные Unicode-границы            | SEARCH-01            |
| BUG-28  | P0        | FIXED       | `refreshTree()` повторно вызывает `load_vault` и увеличивает generation                    | AUTO-01              |
| BUG-29  | P0        | IMPLEMENTED | Очередная локальная запись использовала устаревшую revision и создавала false conflict     | MANUAL-01-FIX        |
| BUG-30  | P1        | IMPLEMENTED | Close lifecycle требовал `destroy`, но capability разрешала только `close`                 | MANUAL-01-CLOSE-FIX  |
| BUG-31  | P2        | IMPLEMENTED | External rename обновлял tree/document, но оставлял устаревший заголовок вкладки           | MANUAL-02-FIX        |
| BUG-32  | P1        | IMPLEMENTED | Rename за пределы vault удалял открытую заметку без явного deletion conflict               | MANUAL-02-DELETE-FIX |
| BUG-33  | P1        | IMPLEMENTED | Session restore загружал Markdown с диска в обход recovery draft и confirmation            | MANUAL-03-FIX        |
| BUG-34  | P1        | IMPLEMENTED | Повторное открытие Canvas создавало параллельные recovery loads, вкладки и prompts         | MANUAL-03-CANVAS-FIX |
| BUG-35  | P1        | IMPLEMENTED | Вставка note ID дублировала BOM: в начале файла и перед Markdown body                      | MANUAL-03-FORMAT-FIX |
| BUG-36  | P2        | FIXED       | Native drop неверно делил macOS coords на DPR и игнорировал пустой хвост редактора         | MANUAL-06-DROP-FIX   |
| BUG-37  | P2        | FIXED       | Split action существовал, но кнопка и её подключение к HeaderTabs отсутствовали            | MANUAL-06-SPLIT-FIX  |
| DEBT-01 | P2        | IMPLEMENTED | Крупные orchestration/domain-файлы разделены за compatibility façade                       | ARCH-01              |
| DEP-01  | P2        | IMPLEMENTED | RustSec transitives имеют target/owner/review policy; новые advisories остаются failing    | SEC-02               |

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

Повтор `MANUAL-06` выявил ошибку уже первого исправления: cumulative mapping
применялся к ранее mapped позиции. В batch из трёх элементов это давало
`RangeError` и оставляло импортированные assets без ссылок в заметке. Исправление
remap-ит неизменный исходный anchor; regression использует настоящую
ProseMirror transaction, а не только mock.

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

### MANUAL-01-FIX — Revision chaining локального autosave

Статус: `IMPLEMENTED`; требуется повторный ручной проход `MANUAL-01`.

Причина ложного конфликта установлена воспроизводящим integration-тестом. Если
вторая локальная правка попадала в очередь во время первой записи, её payload
сохранял прежнюю `expectedRevision`. После успешной первой записи backend уже
выдавал новую revision, поэтому следующая запись того же renderer отправляла
устаревший CAS и корректный backend ошибочно воспринимался UI как внешний
конфликт.

Исправлено:

- autosave берёт revision открытого документа непосредственно перед выполнением
  каждой сериализованной записи; результат предыдущей записи становится CAS
  baseline следующей локальной версии;
- завершившаяся запись обновляет revision даже при наличии более нового dirty
  текста, но не очищает его dirty-состояние;
- ручной merge внешнего конфликта принимает `externalRevision`, чтобы повторная
  запись merged-текста не конфликтовала со старой локальной revision;
- integration regression блокирует первую запись, ставит вторую правку в очередь
  и подтверждает сохранение последней версии без conflict. Настоящий stale CAS
  между двумя renderer-окнами по-прежнему остаётся конфликтом.

Автоматические focused-проверки и полный `npm run verify` проходят: 301 Vitest,
140 Rust tests, typecheck, ESLint, Prettier, Knip, Rustfmt, strict Clippy и
`bindings:check`; `npm run build` также завершён успешно. Предыдущий
`MANUAL-01: FAIL` не переписывается задним числом: пакет должен быть повторён с
нового disposable vault, начиная с rapid-local-edits regression, а затем
полностью с двумя окнами.

### HISTORY-02 — Объединение частых autosave snapshots

Статус: `IMPLEMENTED`.

История не была непосредственной причиной ложного конфликта: `.amby/` исключена
из watcher, а history snapshot создаётся до atomic write заметки. Однако снимок
на каждое успешное автосохранение создавал лишние файловые операции и слишком
быстро увеличивал историю.

- `note-save` и `file-save` создают не более одного pre-write snapshot для одного
  source-файла за скользящий интервал 10 минут;
- сама заметка продолжает сохраняться после короткого editor debounce — ожидания
  10 минут перед записью пользовательского Markdown нет;
- recovery draft остаётся частым и durable, существующие snapshots не удаляются;
- `id-assignment`, `link-refactor`, `restore` и другие явные причины не
  объединяются и сохраняют отдельные recovery points;
- Rust regression-тесты проверяют быстрое объединение без задержки записи файла,
  новую версию на границе 10 минут, безопасный откат системных часов и отсутствие
  coalescing для forced reasons.

### MANUAL-01-CLOSE-FIX — Закрытие окна после autosave flush

Статус: `IMPLEMENTED`; ручной повтор `MANUAL-01.6` и `MANUAL-01.7` пройден.

Причина подтверждена dev log и локальной реализацией Tauri API.
`Window.onCloseRequested()` после непрерванного callback завершает закрытие через
`Window.destroy()`. Прежний обработчик сначала делал `preventDefault()`, выполнял
autosave flush, затем вызывал `close()` повторно. Второе close-событие доходило до
встроенного `destroy()`, которого не было в capabilities, и detached window
оставалось открытым с `window.destroy not allowed`.

Исправлено:

- `core:window:allow-destroy` добавлен только в capabilities окон приложения:
  `main` и `note-*`; broad filesystem, shell или external URL permissions не
  добавлялись;
- после autosave/recovery flush обработчик напрямую вызывает `destroy()`, не
  создавая второе close-request событие;
- если native destroy всё же завершается ошибкой, флаг `closing` сбрасывается и
  окно не остаётся навсегда невосприимчивым к повторному close;
- capability regression фиксирует точные window patterns и наличие пары
  `allow-close`/`allow-destroy` для обоих разрешённых типов окон.

Автоматический результат: focused close/capability/autosave — 7 Vitest; полный
`npm run verify` — 302 Vitest, 140 Rust tests, typecheck, ESLint, Prettier, Knip,
Rustfmt, strict Clippy и `bindings:check`; `npm run build` успешно завершён.

### MANUAL-02-FIX — Синхронизация tab title после external rename

Статус: `IMPLEMENTED`; ручной повтор external rename и move в Tauri — `PASS`.

Первый проход `MANUAL-02.4` подтвердил, что watcher и stable frontmatter ID
работают: дерево, путь открытого документа и document header перешли с
`external-watch` на `renamed-watch`. При этом `Tab.title` хранился отдельно и не
обновлялся после `refreshTree()`, поэтому вкладка продолжала показывать старое
имя.

Исправлено:

- добавлен pure `reconcileTreeBackedTabTitles`, сопоставляющий вкладки с новым
  деревом по stable file ID;
- reconciliation выполняется при каждом успешном `refreshTree()`, поэтому
  external rename/move обновляет все открытые tree-backed tabs во всех renderer
  windows;
- если заголовки уже совпадают, исходный массив сохраняется и лишний Zustand
  update/session write не создаётся;
- regression-тесты покрывают внешний rename, вложенный moved item и отсутствие
  изменений для совпадающих/non-tree вкладок.

Автоматический результат: focused workspace mutation/window tests — 36 Vitest;
полный `npm run verify` — 305 Vitest, 140 Rust tests, typecheck, ESLint, Prettier,
Knip, Rustfmt, strict Clippy и `bindings:check`; `npm run build` успешно завершён.

Ручной повтор 25 августа 2026 года подтвердил: external rename
`renamed-watch` → `renamed-watch-fixed` согласованно обновил tree, document header
и tab title без потери buffer; последующий внешний move в `Moved/` сохранил
открытую вкладку, текст и отсутствие conflict.

### MANUAL-02-DELETE-FIX — Явное и безопасное external deletion

Статус: `IMPLEMENTED`; ручной delete-dialog/restore retest — `PASS`.

Первый delete-проход `MANUAL-02.4` перенёс открытую заметку за пределы vault.
Tree корректно удалил файл, а вкладка осталась открытой, но диалог не появился.
Dev log зафиксировал `watcher.open_document_reload_failed`: macOS сообщил move
за пределы watched vault как `rename`, тогда как прежний frontend создавал
deletion conflict только для raw `remove`. После coalesced re-index stable ID уже
отсутствовал, `readNote()` завершался ошибкой, а catch только записывал warning.

Исправлено:

- pure `planOpenDocumentTreeChanges` классифицирует relocation/deletion по
  stable ID в обновлённом дереве, независимо от platform-specific watcher kind;
- открытый buffer получает явное состояние `externallyDeleted`; вкладка не
  закрывается, autosave не пересоздаёт файл молча, а последующая локальная правка
  снова открывает deletion conflict;
- `readNote` сохраняет полный исходный source-template только в памяти открытого
  buffer, чтобы восстановление не теряло opaque YAML;
- новый typed IPC restore проверяет active generation и vault confinement,
  валидирует stable frontmatter ID и публикует файл atomic no-replace; внезапно
  появившийся target не перезаписывается;
- restore сохраняет opaque frontmatter, UTF-8 BOM и dominant LF/CRLF, затем
  восстанавливает rebuildable note/property index и рассылает tree/note events;
- reappeared/restored файл снимает deletion state; отличающийся текст становится
  обычным external conflict, а совпадающий buffer безопасно сходится;
- `docs/vault-format.md` обновлён этим контрактом.

Автоматический результат: focused watcher/storage/conflict/autosave — 60 Vitest;
полный gate до bindings baseline — typecheck, ESLint, 309 Vitest, Prettier, Knip,
Rustfmt, strict Clippy и 141 Rust tests; `npm run build` и `git diff --check`
проходят. `bindings:check` экспортирует тот же актуальный generated-файл, но до
commit закономерно видит новый `restoreDeletedNote`/`NoteReadOutcome.source` diff
относительно HEAD; `src/lib/bindings.ts` сгенерирован Rust-тестом, вручную не
редактировался.

### MANUAL-03-FIX — Recovery при восстановлении session tabs

Статус: `IMPLEMENTED`; полный ручной `MANUAL-03` повторён 26 августа 2026 года и
получил итоговый `PASS` после двух дополнительных runtime-исправлений.

Ручной `MANUAL-03.3` создал достоверный crash draft: процесс
`target/debug/amby-notes` получил `SIGKILL` через 250 мс после editor input,
source Markdown остался без маркера, а `.amby/recovery/<note-id>.json` сохранил
отличающийся текст и корректный `pathHint`. При следующем запуске
`restoreSession=true` восстановил эту заметку как активную вкладку, но диалог
recovery не появился. Draft остался на месте и продолжил отличаться от диска.

Root cause: background preload восстановленных вкладок в `use-vault-data.ts`
напрямую вызывает `readNote()` и `setDoc()`. Он не использует recovery decision
из `use-document-loading.ts`, поэтому обходятся `readRecoveryDraft()`, сравнение
с disk content, подтверждение пользователя и immediate autosave принятой версии.

Пошаговое исправление:

1. Вынести единый чистый recovery decision и единый async Markdown load contract,
   который принимает disk `NoteReadOutcome`, metadata/properties и найденный
   draft, но не зависит от конкретного UI entry point.
2. Использовать этот contract и при обычном открытии заметки, и при preload
   восстановленных session tabs. Не создавать второй recovery state в
   `use-vault-data.ts`.
3. Не показывать несколько системных confirmation одновременно: восстановленные
   вкладки обрабатывать последовательно либо через одну контролируемую очередь;
   перед prompt повторно проверять активные vault generation/request ID.
4. При `accept` загрузить recovery content как dirty buffer и немедленно поставить
   его в versioned autosave coordinator; draft удалять только после успешной
   filesystem CAS-записи.
5. При `decline` загрузить disk content и удалить только соответствующий draft.
   При равенстве recovery и disk удалить draft без prompt.
6. При save failure оставить dirty buffer и draft, не очищать их из session
   preload cleanup и показать существующее локализованное сообщение об ошибке.
7. Добавить focused regression tests для session restore: differing draft
   `accept`, `decline`, equal content, stale generation во время prompt и
   filesystem save failure. Проверить, что prompt не дублируется при последующем
   обычном `loadDoc()` той же вкладки.
8. Прогнать focused recovery/session/autosave tests, затем полный
   `npm run verify`, `npm run build` и `git diff --check`.
9. Повторить `MANUAL-03` целиком на новом disposable vault. Предыдущий `FAIL` и
   `/private/tmp/amby-manual-PS8a8H/manual-03-fail.txt` сохранить как
   историческое evidence; к `MANUAL-04` не переходить до итогового `PASS`.

Критерии готовности:

- отличающийся crash draft всегда обнаруживается независимо от того, открывает
  заметку пользователь или её восстанавливает session;
- ни `accept`, ни `decline` не допускают silent overwrite/loss;
- draft удаляется только после подтверждённого disk save либо явного `decline`;
- Canvas recovery contract не регрессирует;
- все шаги `MANUAL-03.1` — `MANUAL-03.7` повторно получают runtime evidence.

Реализовано:

- отдельный preload из `use-vault-data.ts` удалён: session восстанавливает только
  вкладки, а их документы последовательно загружает
  `use-session-document-loading.ts` через тот же `loadDoc`, что используется при
  обычном клике;
- `resolveMarkdownRecoveryLoad` стал единым side-effect-free decision boundary
  для ID/path draft lookup, disk comparison, `accept`, `decline`, equal draft и
  stale generation. Устаревший prompt не меняет document state и не удаляет
  recovery;
- `InFlightDocumentLoads` объединяет одновременный session/click load одной
  заметки, поэтому второй recovery prompt не создаётся; после ошибки entry
  корректно освобождается для retry;
- восстановленные session tabs обрабатываются последовательно, поэтому native
  confirmations разных заметок не открываются параллельно;
- `accept` создаёт dirty document и немедленно enqueue-ит versioned autosave.
  Draft очищается существующим success callback только после актуального disk
  save; `decline` и равный disk draft очищают только ID/path этой заметки;
- filesystem save failure оставляет buffer dirty и recovery draft на месте, а
  UI показывает новое локализованное безопасное сообщение без деталей ошибки;
- recovery contract session restore, generation cancellation и cleanup описаны
  в `docs/vault-format.md`.

Автоматический результат: focused recovery/session/autosave/localization — 36
Vitest; полный gate прошёл typecheck, ESLint, 319 Vitest, Prettier, Knip,
Rustfmt, strict Clippy и 141 Rust tests. `npm run verify` ожидаемо завершился
ненулево только на финальном сравнении уже изменённого MANUAL-02 generated
`src/lib/bindings.ts` с HEAD; повторный `specta_export::export_bindings` сохранил
тот же SHA-256
`c7a1ae82235a41ed90a642eb3413cfe0df8414c25b18410096a3592942e66efa`.
`npm run build` и `git diff --check` проходят. Полный runtime retest описан в
разделе `MANUAL-03`; исторический `FAIL` сохранён отдельно.

### MANUAL-03-CANVAS-FIX — Дедупликация Canvas load и singleton tab

Статус: `IMPLEMENTED`; runtime retest `PASS`.

При быстром повторном открытии Canvas до завершения `loadCanvasBuffer()` каждый
вызов запускал отдельное чтение recovery и системный confirmation. Кроме того,
`openCanvasTab()` проверял устаревший render snapshot `tabs`, поэтому создавал
несколько вкладок одного Canvas. Побочный async-вызов находился внутри updater
`setOpenCanvases`, что дополнительно нарушало требование чистоты state updater.

Исправлено:

- `CanvasLoadDeduplicator` разделяет один pending Promise по ключу
  `(vault generation, path)` и освобождает его после success/failure для retry;
- загрузка вынесена из `setOpenCanvases` updater;
- `openOrActivateSingletonTab` атомарно проверяет и активирует Canvas tab внутри
  Zustand store, поэтому параллельные вызовы не создают дубликаты;
- focused tests проверяют shared in-flight load, generation isolation, retry
  после rejection и атомарное повторное открытие вкладки.

Runtime: отличающийся Canvas показал один prompt и сохранился после `accept`;
совпадающий recovery открылся без prompt и был удалён. После исправления дерево
создавало одну вкладку Canvas.

### MANUAL-03-FORMAT-FIX — Один BOM при вставке frontmatter ID

Статус: `IMPLEMENTED`; runtime retest `PASS`.

`body_with_id()` строил новый frontmatter перед исходной строкой вместе с её
ведущим BOM. Затем `atomic_write()` правильно восстанавливал BOM в байте 0 по
существующему файлу, но старый BOM уже оставался внутри нового Markdown body.
Результат содержал два BOM.

Исправлено:

- перед построением generated envelope BOM отделяется от body и остаётся только
  в начале возвращаемого текста;
- `atomic_write()` по-прежнему сохраняет dominant CRLF/LF и публикует файл
  атомарно;
- Rust tests проверяют вставку ID в BOM-prefixed body, ровно один BOM, CRLF и
  terminal line breaks;
- runtime migration нового fixture подтвердила один BOM в байте 0, отсутствие
  bare LF/CR и сохранение двух terminal blank lines до и после crash recovery.

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

Статус: `IMPLEMENTED`.

- MediaDrop и Tauri external drop сначала импортируют весь batch, затем вставляют
  результаты одной transaction текущего editor state. Следующая позиция выводится
  из `tr.mapping`, поэтому image `nodeSize = 1` и реальная длина file-link text
  не расходятся.
- Plugin и Tauri binding используют abort signals: completion async import после
  destroy/cleanup не dispatch-ит устаревшую transaction.
- Column resize использует idempotent session cleanup; `PluginView.destroy`
  отменяет rAF, global mouse/pointer listeners, body/classes и guide/label DOM.
- Первоначальный mixed-batch mapping оказался недостаточным; исправлен отдельно
  в `MANUAL-06-DROP-FIX`. macOS Finder/Tauri mixed drop, а также
  закрытие вкладки во время resize подтверждены `MANUAL-06.1` и `MANUAL-06.2`.
  DOM regression проверяет снятие пяти listeners, отмену pending rAF и отсутствие
  dispatch после destroy. Windows/Linux runtime здесь не проверялся.

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
  store eviction и split guard. В `MANUAL-06.5` восстановлена и проверена кнопка
  Split; `MANUAL-06.6` подтверждает close/reopen до scheduled autosave и сохранение
  более новой правки после reopen. Медленный in-flight IPC отдельно в runtime
  этого пакета не инжектировался; его race coverage остаётся автоматическим.

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
  обе `.md` wiki ветки и отсутствие пустых actions. macOS Tauri DnD/Quick Open
  smoke завершён в `MANUAL-06.3` и `MANUAL-06.4`.

### MANUAL-06-DROP-FIX — Native drop и mixed-batch insertion

Статус: `IMPLEMENTED`; повтор `MANUAL-06.1` — `PASS` на macOS.

1. Зафиксирован исторический `FAIL`: Finder drop на Retina промахивался мимо
   редактора; drop в пустой хвост не вставлял ссылки; после исправления hitbox
   смешанный batch из трёх элементов вызывал `RangeError`.
2. `media-drop.ts` нормализует native coordinates с учётом платформы: для
   macOS/Linux сохраняются Wry client coordinates, Windows делит physical pixels
   на DPR. `TiptapEditor.tsx` использует hitbox контейнера `.amby-tiptap`.
3. Граница документа переводится в ближайшую допустимую текстовую позицию.
   Все элементы вставляются одной transaction с mapping исходного anchor.
   Ошибка одного native import не отбрасывает предыдущие успешные импорты;
   лог содержит только тип ошибки, без исходного пути/текста ошибки.
4. Добавлены focused tests координат, hitbox, doc-boundary, реального mixed
   batch и partial import failure. Тест abort/destroy сохранён.
5. Реальный Finder file+image+image drop повторён в пустой хвост редактора:
   ссылки/картинки появились в UI и сохранённом Markdown в исходном порядке.

### MANUAL-06-SPLIT-FIX — Доступность Split action

Статус: `IMPLEMENTED`; повтор `MANUAL-06.5` — `PASS` на macOS.

1. Зафиксирован исторический `FAIL`: `toggleSplit` и guard были реализованы,
   но действие отсутствовало в HeaderTabs и было недоступно пользователю.
2. Возвращена кнопка с существующим переводом `tabs.splitEditor`, состоянием
   `aria-pressed` и callback из `useTabActions` через workspace orchestration.
3. Component regression нажимает реальную кнопку, проверяет включение/выключение
   и пропуск вкладки с тем же file ID. Без callback пустая кнопка не выводится.
4. Runtime с двумя вкладками одной заметки выбрал другую заметку вторым pane;
   две editable копии одного document buffer не появились.

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

Статус: `IMPLEMENTED`.

Все пять независимых structural подпакетов выполнены без изменения persistence,
IPC или UI contracts. Старые import paths сохранены compatibility façade.

Текущий размер целевых файлов:

- `src-tauri/src/bundle/mod.rs` — 27 строк;
- `src/components/workspace/workspace.tsx` — 6 строк;
- `src/components/workspace/tiptap/markdown.ts` — 18 строк;
- `src/components/workspace/use-file-actions.ts` — 37 строк;
- `src/lib/storage/web-adapter.ts` — 6 строк.

`ARCH-01` нельзя выполнять одной большой правкой. Он состоит из пяти независимых
commit-sized подпакетов `ARCH-01A` — `ARCH-01E`. Codex выполняет только один
подпакет за запуск и не переходит к следующему без отдельного указания.

#### ARCH-00 — Контрольная точка перед структурным рефакторингом

Статус: `IMPLEMENTED`.

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

Статус: `IMPLEMENTED`.

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

Реализовано:

- `bundle.rs` заменён каталогом `bundle/` со стабильным façade `mod.rs`; старый
  crate-level путь `crate::bundle::*` сохранён для commands и recycle bin;
- path safety, planning, note promotion, layers, execution, rollback, assets и
  bundle classification разделены на focused Rust-модули. В `mod.rs` отсутствуют
  filesystem-алгоритмы; каждый production module содержит не более 293 строк;
- все 22 прежних bundle regression-теста перенесены в `bundle/tests.rs` без
  изменения проверяемого поведения. Новых IPC, persistence-format, permission
  или UI contracts не добавлено.

#### ARCH-01B — Frontend file actions

Статус: `IMPLEMENTED`.

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

Реализовано:

- `use-file-actions.ts` стал compatibility façade над `file-actions/`; публичный
  return contract для `Workspace` сохранён;
- Markdown autosave, recovery/revision, document loading, wiki navigation, CRUD
  и rename/move/merge разделены между focused hooks. Они используют те же
  Zustand stores и один `AutosaveCoordinator`, не создавая копий `openDocs`, tabs
  или vault generation;
- storage и mutation paths сохранены через `@/lib/storage`; rename/move/merge
  продолжают применять mutation result и flush autosave перед merge. Фасад — 37
  строк, каждый production hook — не более 283 строк; IPC, persistence, UI и
  permission contracts не изменены.

#### ARCH-01C — Workspace orchestration и layout

Статус: `IMPLEMENTED`.

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

Реализовано:

- публичный `Workspace` стал шестистрочным composition façade; orchestration
  перенесён в `workspace-orchestration.tsx`, поэтому entry component не содержит
  domain filesystem/storage calls;
- Canvas buffers, validation, recovery drafts и независимый Canvas
  `AutosaveCoordinator` вынесены в `orchestration/use-canvas-workspace.ts`.
  Он регистрирует тот же lifecycle flush contract, что и Markdown coordinator,
  не создавая второй источник workspace state;
- действия workspace picker (open/rename/move/delete vault) и durable custom
  properties вынесены в `use-vault-actions.ts` и `use-property-actions.ts`;
  оба используют исходные Zustand stores и IPC storage boundary;
- добавлен чистый `workspace-layout.tsx` для workspace chrome без domain state.
  Все строки UI продолжают идти через существующие locale keys; новых hook lint
  suppressions не добавлено.

#### ARCH-01D — Markdown parser/serializer boundary

Статус: `IMPLEMENTED`.

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

Реализовано:

- `markdown.ts` стал стабильным 18-строчным façade для прежних exports;
- inline rule, block rules, special blocks, lazy parser, serializer и safe
  read-only renderer разнесены по focused modules (13–370 строк);
- порядок Markdown-it rules, ленивое создание `MarkdownParser` и existing
  round-trip compatibility guard сохранены. Формат Markdown и Live Preview
  admission не изменены; BOM/line-ending restoration остаётся в
  `markdown-compatibility.ts`.

#### ARCH-01E — Web storage adapter

Статус: `IMPLEMENTED`.

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

Реализовано:

- `web-adapter.ts` стал шестистрочным стабильным `StoragePort` façade над
  browser implementation; прежний публичный import сохранён;
- browser persistence operations собраны за `webGet`/`webSet`/`webRemove`,
  которые нормализуют quota/unavailable errors через `withWebStorage`;
- bounded fallback search и desktop-only history/trash contract вынесены в
  `web-search.ts` и `web-history.ts`. CAS read/write, tree и mutation semantics
  не менялись.

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

| Пакет                | Статус      | Проверки                                                                                                                                      | Примечание                                                                                                       |
| -------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| AUTO-01              | IMPLEMENTED | 273 Vitest; 111 Rust; typecheck; ESLint; Prettier; Knip; Rustfmt; strict Clippy; повторная генерация bindings без дополнительных изменений    | Ручной сценарий `main + note window + external edit` оставлен AUTO-06                                            |
| AUTO-02              | IMPLEMENTED | `npm run verify`: 275 Vitest; 114 Rust; typecheck; ESLint; Prettier; Knip; Rustfmt; strict Clippy; export_bindings                            | Ручной сценарий двух Tauri-окон не выполнен в headless-среде; финальный `bindings:check` diff ожидаем до commit  |
| AUTO-03              | IMPLEMENTED | `npm run verify`: 275 Vitest; 117 Rust; typecheck; ESLint; Prettier; Knip; Rustfmt; strict Clippy; export_bindings                            | Ручной сценарий external editor не выполнен в headless-среде; финальный `bindings:check` diff ожидаем до commit  |
| AUTO-04              | IMPLEMENTED | 280 Vitest; 117 Rust; typecheck; ESLint; Prettier; strict Clippy                                                                              | Ручные Canvas/Markdown recovery-сценарии в Tauri не выполнены в headless-среде                                   |
| AUTO-05              | IMPLEMENTED | 281 Vitest; typecheck; ESLint; Prettier; Rustfmt; strict Clippy; 117 Rust; export_bindings                                                    | Ручные close/switch/visibility сценарии Tauri остаются для AUTO-06                                               |
| AUTO-06              | IMPLEMENTED | 283 Vitest; 117 Rust; typecheck; ESLint; Prettier; Knip; Rustfmt; strict Clippy; export_bindings                                              | Реальные macOS two-window/external-editor/close сценарии не выполнены в headless-среде                           |
| SEARCH-01            | IMPLEMENTED | 284 Vitest; 121 Rust; typecheck; ESLint; Prettier; Knip; Rustfmt; strict Clippy; export_bindings                                              | FTS query capped at 50; headless smoke не измеряет UX latency на пользовательском vault                          |
| DATA-01              | IMPLEMENTED | `npm run verify`: 284 Vitest; 128 Rust; typecheck; ESLint; Prettier; Knip; Rustfmt; strict Clippy; export_bindings                            | Ручной Tauri cleanup/restore scenario не выполнен в headless-среде; final bindings diff ожидаем до commit        |
| FS-01                | IMPLEMENTED | `npm run verify`: 284 Vitest; 131 Rust; typecheck; ESLint; Prettier; Knip; Rustfmt; strict Clippy; export_bindings                            | macOS case-only tests выполнены; Windows cfg tests добавлены, но не запускались на текущей машине                |
| FS-02                | IMPLEMENTED | `npm run verify`: 284 Vitest; 134 Rust; typecheck; ESLint; Prettier; Knip; Rustfmt; strict Clippy; export_bindings                            | Fallback моделируется fault injection; реальные exFAT/FAT/network mounts не доступны в текущей среде             |
| UI-01                | IMPLEMENTED | `npm run verify`: 287 Vitest; 134 Rust; typecheck; ESLint; Prettier; Knip; Rustfmt; strict Clippy; export_bindings                            | Ручные multi-file Finder/Tauri drop и destroy during resize не выполнены в headless-среде                        |
| UI-02                | IMPLEMENTED | `npm run verify`: 293 Vitest; 134 Rust; typecheck; ESLint; Prettier; Knip; Rustfmt; strict Clippy; export_bindings                            | Ручной Tauri close/reopen во время медленного autosave не выполнен в headless-среде; final bindings diff ожидаем |
| UI-03                | IMPLEMENTED | `npm run verify`: 297 Vitest; 134 Rust; typecheck; ESLint; Prettier; Knip; Rustfmt; strict Clippy; export_bindings                            | Ручной Tauri DnD и Quick Open smoke не выполнен в headless-среде; final bindings diff ожидаем                    |
| SEC-01               | IMPLEMENTED | `npm run verify`: 299 Vitest; 136 Rust; typecheck; ESLint; Prettier; Knip; Rustfmt; strict Clippy; export_bindings                            | Headless: no live OS keychain/Tauri event scenario; final bindings diff is expected from prior uncommitted work  |
| SEC-02               | IMPLEMENTED | `npm run audit`: npm 0 vulnerabilities; Rust policy passes; `npm run verify`: 299 Vitest, 136 Rust, typecheck, lint, format, Knip, Clippy     | `bindings:check` export passes; final diff is expected from prior uncommitted generated bindings                 |
| ARCH-00              | IMPLEMENTED | `96dad9f`; `npm run verify`: 300 Vitest; 136 Rust; typecheck; ESLint; Prettier; Knip; Rustfmt; strict Clippy; `bindings:check` без diff       | Функциональный checkpoint создан до structural moves; новых ручных сценариев нет, остаются MANUAL-01 — MANUAL-07 |
| ARCH-01A             | IMPLEMENTED | `cargo test --manifest-path src-tauri/Cargo.toml bundle::tests`: 22 Rust; `npm run verify`: 300 Vitest, 136 Rust; `npm run build`             | `bundle/mod.rs` 27 строк; production modules ≤293 строк; новых ручных сценариев нет                              |
| ARCH-01B             | IMPLEMENTED | `npm run test`: 300 Vitest; `npm run verify`: 300 Vitest, 136 Rust; `npm run build`; typecheck; ESLint; Prettier; bindings без diff           | `use-file-actions.ts` 37 строк; hooks 80–283 строки; новых ручных сценариев нет                                  |
| ARCH-01C             | IMPLEMENTED | `npm run verify`: 300 Vitest; 136 Rust; typecheck; ESLint; Prettier; Knip; Rustfmt; strict Clippy; `bindings:check` без diff; `npm run build` | Workspace façade — 6 строк; Canvas/vault/property orchestration вынесена; новых ручных сценариев нет             |
| ARCH-01D             | IMPLEMENTED | focused `markdown.test.ts`: 43 Vitest; `npm run verify`: 300 Vitest, 136 Rust; `npm run build`; `bindings:check` без diff                     | `markdown.ts` 18 строк; production modules 13–370 строк; новых ручных сценариев нет                              |
| ARCH-01E             | IMPLEMENTED | focused `storage.test.ts`: 9 Vitest; `npm run verify`: 300 Vitest, 136 Rust; `npm run build`; `bindings:check` без diff                       | `web-adapter.ts` 6 строк; storage boundary и fallback ports сохранены; новых ручных сценариев нет                |
| MANUAL-01-FIX        | IMPLEMENTED | focused autosave/conflict: 25 Vitest; `npm run verify`: 301 Vitest, 140 Rust; `npm run build`; user-observed Tauri smoke PASS                 | Rapid local edits больше не создают false conflict; полный multi-window `MANUAL-01` завершён PASS                |
| MANUAL-01-CLOSE-FIX  | IMPLEMENTED | focused close/capability/autosave: 7 Vitest; `npm run verify`: 302 Vitest, 140 Rust; `npm run build`; manual Tauri PASS                       | Detached close, watcher-after-close и pending-autosave close подтверждены                                        |
| MANUAL-02-FIX        | IMPLEMENTED | focused mutation/window: 36 Vitest; `npm run verify`: 305 Vitest, 140 Rust; `npm run build`; manual Tauri PASS                                | External rename и move согласованно обновляют tree/document/tab без потери buffer                                |
| MANUAL-02-DELETE-FIX | IMPLEMENTED | focused watcher/storage/conflict/autosave: 60 Vitest; full gate: 309 Vitest, 141 Rust; `npm run build`; `git diff --check`; manual Tauri PASS | External deletion dialog, byte-identical restore, sibling event и watcher-after-detached-close подтверждены      |
| MANUAL-03-FIX        | IMPLEMENTED | focused recovery/session/autosave/localization: 36 Vitest; full gate: 319 Vitest, 141 Rust; `npm run build`; `git diff --check`               | Session tabs используют общий recovery-aware load; полный MANUAL-03 retest завершён PASS                         |
| MANUAL-03-CANVAS-FIX | IMPLEMENTED | focused Canvas load/tab: 4 Vitest; full gate: 323 Vitest, 143 Rust; `npm run build`; `git diff --check`; manual Tauri PASS                    | In-flight Canvas load дедуплицирован; singleton tab и equal/different recovery подтверждены                      |
| MANUAL-03-FORMAT-FIX | IMPLEMENTED | focused frontmatter: 21 Rust; full gate: 323 Vitest, 143 Rust; `npm run build`; `git diff --check`; manual Tauri PASS                         | ID migration и crash recovery сохраняют один BOM, CRLF и terminal blank lines                                    |
| MANUAL-03-RETEST     | PASS        | macOS Tauri runtime MANUAL-03.1—03.7; `npm run verify`; `npm run build`; `git diff --check`                                                   | Полный повтор на disposable vault; historical FAIL сохранён; следующий пакет MANUAL-04                           |
| MANUAL-04-RETEST     | PASS        | macOS Tauri runtime MANUAL-04.1—04.6; focused history tests; `npm run verify`: 323 Vitest, 144 Rust; `npm run build`; `git diff --check`      | UI/filesystem stats, cancel, count/age retention, restore, restart и corrupted snapshot проверены                |
| MANUAL-05-MACOS      | PARTIAL     | macOS/APFS reusable-vault backend run; focused case-only, rollback, collision и no-replace Rust tests                                         | Доступные APFS шаги PASS; Windows, exFAT/FAT и network filesystem отсутствуют и явно оставлены BLOCKED           |
| MANUAL-06-DROP-FIX   | IMPLEMENTED | 9 focused media-drop tests; macOS Finder/Tauri file+image+image retest; сохранённый Markdown и SHA-256 assets                                 | Исправлены DPR/hitbox/doc-boundary и cumulative remapping исходного anchor; historical FAIL сохранён             |
| MANUAL-06-SPLIT-FIX  | IMPLEMENTED | HeaderTabs component + useTabActions/buffer tests; macOS runtime с двумя вкладками одного document ID                                         | Возвращена доступная Split-кнопка; duplicate tab пропускается при выборе secondary pane                          |
| MANUAL-06-RETEST     | PASS        | macOS Tauri debug .app MANUAL-06.1—06.6; 332 Vitest, 144 Rust; typecheck/lint/format/Knip/Clippy; `npm run build`                             | Runtime PASS; `verify` exit 1 только на diff bindings относительно HEAD, повторный экспорт файл не меняет        |
| HISTORY-02           | IMPLEMENTED | focused history: 14 Rust; `npm run verify`: 301 Vitest, 140 Rust; `npm run build`                                                             | Snapshot истории не чаще одного раза в 10 минут; запись заметки не задерживается                                 |
| FINAL-01             | AUTOMATED   | `git diff --check`; `npm run verify`: 300 Vitest, 136 Rust; `npm run build`; `npm run audit`: npm 0 vulnerabilities; `npm run tauri build`    | Автоматический gate зелёный; production release ожидает MANUAL-01 — MANUAL-07                                    |
| FINAL-02             | PENDING     | —                                                                                                                                             | Ручная приёмка и окончательное решение о production release                                                      |

`FINAL-01` фиксирует зелёный `bindings:check` на чистом дереве 25 августа, а не
состояние текущего незакоммиченного набора исправлений. Более поздние результаты
manual-fix gates записываются отдельно; успешный экспорт bindings не равнозначен
нулевому `git diff --exit-code` относительно HEAD.

После каждого пакета Codex обновляет этот журнал фактическими командами и отдельно
указывает невыполненные ручные сценарии.

## 8. Полный остаток ручной и финальной проверки

Автоматическая проверка 25 августа 2026 года подтвердила 300 Vitest, 136 Rust
tests, TypeScript, ESLint, Prettier, Knip, Rustfmt, strict Clippy, generated
bindings, dependency policy, production frontend build, macOS `.app` и arm64
`.dmg`. Тогда Git был clean и `dev` синхронизирован с `origin/dev`. На 30 августа
ручные исправления находятся в рабочем дереве поверх `9294076`; это не новый
чистый release baseline.

Ниже перечислена вся работа, которая остаётся после автоматических correctness
пакетов. Пункт нельзя считать выполненным без записи фактического результата в
этот раздел.

### Общий протокол выполнения MANUAL-01 — MANUAL-07

Codex выполняет только один MANUAL-пакет за задачу.

1. Прочитать `AGENTS.md`, этот протокол и весь раздел выбранного MANUAL-пакета.
2. Зафиксировать commit (`git rev-parse --short HEAD`), ОС, архитектуру, режим
   запуска и время начала проверки.
3. Повторно использовать disposable vault `/private/tmp/amby-manual-FGt69k`.
   Не создавать новый workspace для каждого шага. Второй допускается только
   при объективной необходимости; отсутствующий первый можно создать через
   `mktemp -d /private/tmp/amby-manual-XXXXXX`, записав новый путь. Реальный
   пользовательский vault для destructive/conflict/recovery не использовать.
4. Подготовить минимальные заметки и fixtures, нужные только выбранному пакету.
   Не добавлять vault data, `.amby/`, credentials и recovery artifacts в Git.
5. Запустить полное приложение через `npm run tauri dev` либо собранный Tauri
   debug `.app` из текущего кода. Явно записать фактический режим, не выдавать
   browser-only Vite или mocked IPC за desktop runtime.
6. Использовать доступные GUI/terminal/browser-control инструменты. Если действие
   возможно только руками пользователя, дать одну точную инструкцию, дождаться
   наблюдаемого результата и только затем перейти к следующему шагу.
7. Не отмечать шаг `PASS` по исходному коду, unit-тесту или ожиданию. Нужен
   наблюдаемый UI/filesystem результат, лог либо screenshot без чувствительных
   данных.
8. Для каждого шага записать `PASS`, `FAIL`, `BLOCKED`, `PARTIAL` или
   `NOT_APPLICABLE`, фактический результат и ссылку/путь к безопасному evidence.
9. При `FAIL` сохранить disposable vault и релевантные безопасные логи, обновить
   журнал, остановить пакет и оформить отдельный `MANUAL-XX-FIX`. Не смешивать
   исправление с оставшимися проверками.
10. При недоступности платформы или оборудования использовать `BLOCKED`, а не
    `PASS`. Для `MANUAL-05` macOS не подтверждает Windows/exFAT/network пункты.
11. После выполнения закрыть тестовый Tauri process. Тестовый vault удалять только
    после фиксации результатов и явного подтверждения; иначе записать его путь.
12. Обновить статус раздела и таблицу ручной приёмки ниже. Не переходить к
    следующему MANUAL-пакету.

Формат evidence для каждого шага:

```text
Шаг: MANUAL-XX.N
Статус: PASS | FAIL | BLOCKED | PARTIAL | NOT_APPLICABLE
Ожидалось: ...
Получено: ...
Evidence: screenshot/log/path или «наблюдено пользователем»
Примечание: ...
```

#### Журнал ручной приёмки

| Пакет                | Статус  | Commit                   | Платформа/режим                                                                              | Evidence                                                                                                    | Примечание                                                                                          |
| -------------------- | ------- | ------------------------ | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| MANUAL-01            | PASS    | `9294076`                | macOS 26.5.2 arm64; `npm run tauri dev`; полный прогон и повтор исправлений 09:24–10:12 EEST | `/private/tmp/amby-manual-liPGgV/`; `manual-01-terminal.log`; наблюдено пользователем                       | Multi-window sync/CAS, три resolution, close, watcher-after-close и pending-autosave close пройдены |
| MANUAL-02            | PASS    | `9294076`                | macOS 26.5.2 arm64; `npm run tauri dev`; полный прогон и fix/retest 10:15–11:00 EEST         | `/private/tmp/amby-manual-Vt4mp6/`; `manual-02-final-pass.txt`; `manual-02-external-delete-dialog-pass.png` | Все шаги 1–6 PASS; исторические rename/delete FAIL сохранены как evidence устранённых дефектов      |
| MANUAL-03 historical | FAIL    | `9294076`                | macOS 26.5.2 arm64; `npm run tauri dev`; 2026-08-25 11:13–11:31 EEST                         | `/private/tmp/amby-manual-PS8a8H/`; `manual-03-fail.txt`; наблюдено пользователем                           | Исторический session recovery bypass; evidence сохранён                                             |
| MANUAL-03            | PASS    | `9294076`                | macOS 26.5.2 arm64; `npm run tauri dev`; 2026-08-26 08:25–09:08 EEST                         | `/private/tmp/amby-manual-FGt69k/`; `manual-03-retest.txt`; screenshots; filesystem evidence                | Шаги 1–7 PASS; Canvas load race и duplicate BOM исправлены и повторно проверены                     |
| MANUAL-04            | PASS    | `9294076`                | macOS 26.5.2 arm64; `npm run tauri dev`; 2026-08-28—2026-08-29 EEST                          | `/private/tmp/amby-manual-FGt69k/`; `manual-04-retest.txt`; screenshots; manifest/filesystem checks         | Шаги 1–6 PASS; age retention и corrupted restore дополнительно закреплены Rust regression tests     |
| MANUAL-05            | PARTIAL | `9294076`                | macOS 26.5.2 arm64; APFS; reusable vault; 2026-08-29 EEST                                    | `/private/tmp/amby-manual-FGt69k/manual-05-macos.txt`; focused Rust tests; before/after SHA-256             | macOS/APFS PASS; Windows, exFAT/FAT и network filesystem BLOCKED                                    |
| MANUAL-06            | PASS    | `9294076` + working tree | macOS arm64, 30.08: 26.6.2; Tauri debug `Amby Manual.app`; 2026-08-29—2026-08-30 EEST        | `/private/tmp/amby-manual-FGt69k/manual-06-retest.txt`; screenshots; filesystem checks                      | Шаги 1–6 PASS; native drop и Split UI исправлены; один reusable vault                               |
| MANUAL-07 historical | FAIL    | `9294076` + working tree | macOS 26.6.2 arm64; Tauri debug `Amby Manual`; 2026-08-30 14:11–14:53 EEST                   | `/private/tmp/amby-manual-FGt69k/manual-07-fail.txt`                                                        | Keyring mock backend; исправлено MANUAL-07-FIX                                                      |
| MANUAL-07 historical | FAIL    | `9294076` + working tree | macOS 26.6.2 arm64; изолированный `tauri dev`; 2026-08-30 15:08–15:16 EEST                   | `/private/tmp/amby-manual-FGt69k/manual07-runtime/evidence/result-16.json`                                  | OpenAI HTTP 429 ошибочно классифицирован; исправлено MANUAL-07-FIX-02                               |
| MANUAL-07            | PASS    | `9294076` + working tree | macOS 26.6.2 arm64; изолированный `tauri dev`; 2026-08-30 15:19–15:24 EEST                   | `/private/tmp/amby-manual-FGt69k/manual-07-pass.txt`; `manual07-runtime/evidence/`                          | Шаги 1–5 PASS; real Keychain, settings error, 24 AI IPC cases и три UI errors; secrets очищены      |

### MANUAL-01 — Реальные Tauri multi-window autosave и conflict

Статус: `PASS` (25 августа 2026 года). Оба найденных при ручной проверке дефекта
исправлены отдельными пакетами, после чего multi-window, CAS, conflict resolution,
закрытие окна, watcher-after-close и pending-autosave close подтверждены в полном
Tauri-приложении.

Среда: commit `9294076`; macOS 26.5.2 (`25F84`), arm64; полный desktop-режим
`npm run tauri dev`; начало 2026-08-25 08:12 EEST. Использован disposable vault
`/private/tmp/amby-manual-HG6Hik`, пользовательский vault не изменялся.

```text
Шаг: MANUAL-01.1
Статус: PARTIAL
Ожидалось: открыть vault в main и ту же заметку в detached note window.
Получено: disposable vault открыт в main, создана заметка manual-conflict; до detached window проверка не дошла из-за FAIL.
Evidence: /private/tmp/amby-manual-HG6Hik/step-01-vault-open.png; /private/tmp/amby-manual-HG6Hik/manual-conflict.md
Примечание: начало сценария наблюдалось в реальном Tauri-приложении.

Шаг: MANUAL-01.2
Статус: BLOCKED
Ожидалось: оба окна показывают одинаковые canonical vault path и generation.
Получено: второе окно не открывалось после раннего FAIL.
Evidence: /private/tmp/amby-manual-HG6Hik/step-01-vault-open.png
Примечание: остановлено по п. 9 общего протокола.

Шаг: MANUAL-01.3
Статус: BLOCKED
Ожидалось: чистый buffer второго окна обновляется после сохранения из первого.
Получено: второе окно не открывалось после раннего FAIL.
Evidence: /private/tmp/amby-manual-HG6Hik/step-01-vault-open.png
Примечание: остановлено по п. 9 общего протокола.

Шаг: MANUAL-01.4
Статус: BLOCKED
Ожидалось: stale save второго окна создаёт revision conflict, не перезапись.
Получено: второй renderer не создавался после раннего FAIL.
Evidence: /private/tmp/amby-manual-HG6Hik/step-01-vault-open.png
Примечание: остановлено по п. 9 общего протокола.

Шаг: MANUAL-01.5
Статус: BLOCKED
Ожидалось: проверены keep local, accept external и save conflict copy.
Получено: конфликт для этого шага не проверялся; обнаруженный ниже конфликт не был вызван второй копией заметки.
Evidence: /private/tmp/amby-manual-HG6Hik/manual-01-user-false-conflict.png
Примечание: остановлено по п. 9 общего протокола.

Шаг: MANUAL-01.6
Статус: BLOCKED
Ожидалось: после закрытия detached window watcher продолжает работать в main.
Получено: detached window не создавался после раннего FAIL.
Evidence: /private/tmp/amby-manual-HG6Hik/step-01-vault-open.png
Примечание: остановлено по п. 9 общего протокола.

Шаг: MANUAL-01.7
Статус: FAIL
Ожидалось: rapid local edits не должны выдавать «Внешний конфликт»; pending-autosave close выполняется только после этого.
Получено: после быстрых локальных ввода/удалений в единственном main window появился диалог «Обнаружен внешний конфликт» с внешней версией `bas`; внешнего редактора и detached window не было. Медленный последующий ввод сохранился, но не устраняет ложный конфликт.
Evidence: /private/tmp/amby-manual-HG6Hik/manual-01-user-false-conflict.png; /private/tmp/amby-manual-HG6Hik/manual-conflict.md
Примечание: тестовый vault и screenshot сохранены для диагностики; процесс Tauri закрыт после фиксации результата.
```

Диагностика и исправление после зафиксированного FAIL:

- history snapshot не являлся источником filesystem event, потому что `.amby/`
  исключена из watcher;
- ложный conflict создавал stale `expectedRevision` второй локальной версии,
  поставленной в очередь во время первой записи;
- autosave revision chaining и manual-merge baseline исправлены, добавлен
  воспроизводящий regression-тест;
- history autosave snapshots отдельно объединены до одного на source-файл за 10
  минут без замедления сохранения Markdown;
- текущий статус: `RETEST REQUIRED`. Старые screenshot и vault остаются evidence
  предыдущего дефекта, но не могут служить доказательством исправления.

Повторная smoke-проверка после исправления, 25 августа 2026 года, 09:22 EEST:

```text
Шаг: MANUAL-01.7a — rapid local edits в одном окне
Статус: PASS
Ожидалось: быстрые ввод и удаление не создают ложный «Внешний конфликт».
Получено: ложный конфликт не появился; пользователь подтвердил «Все гуд».
Evidence: наблюдено пользователем в npm run tauri dev.
Примечание: итоговый текст сохранился на диск; Tauri dev после проверки остановлен.

Шаг: MANUAL-01.7b — закрытие окна во время pending autosave
Статус: PARTIAL
Ожидалось: close-request дожидается pending autosave без потери последнего текста.
Получено: обычное сохранение на диск подтверждено, но отдельный close во время незавершённой записи не воспроизводился.
Evidence: наблюдено пользователем только для обычного rapid-edit сохранения.
Примечание: выполнить в полном повторном MANUAL-01 вместе с multi-window шагами 1–6.
```

Таким образом, обнаруженный regression исправлен и его основной smoke-сценарий
пройден. Общий пакет имеет статус `PARTIAL; RETEST REQUIRED`, а не `PASS`, пока не
выполнены multi-window шаги 1–6 и pending-close часть шага 7.

На macOS в `npm run tauri dev`:

1. Открыть vault в `main`, затем ту же заметку в detached note window.
2. Убедиться, что оба окна показывают одинаковые canonical vault path и generation.
3. Сохранить из одного окна: чистый buffer другого окна должен обновиться.
4. Изменить заметку одновременно в двух окнах: второй stale save должен получить
   revision conflict, а не перезаписать первый.
5. Проверить варианты keep local, accept external и save conflict copy.
6. Закрыть detached-окно и убедиться, что watcher продолжает работать в `main`.
7. Повторить rapid edits и закрытие окна во время pending autosave.

При повторном проходе сначала выполнить шаг 7 в одном окне. Если ложный конфликт
не появляется, продолжить шагами 1–6 и снова завершить шагом 7. Evidence нового
прохода хранить отдельно от `/private/tmp/amby-manual-HG6Hik`.

Повторный полный прогон после исправления, 25 августа 2026 года, 09:24–09:53 EEST:
commit `9294076`; macOS 26.5.2 (`25F84`), arm64; `npm run tauri dev`; disposable
vault `/private/tmp/amby-manual-liPGgV`. Пользовательский vault не изменялся.

```text
Шаг: MANUAL-01.1
Статус: PASS
Ожидалось: открыть test vault в main и ту же заметку в detached note window.
Получено: открыты два отдельных окна Amby с manual-conflict.
Evidence: /private/tmp/amby-manual-liPGgV/step-02-main-and-detached.png
Примечание: macOS Window menu перечисляло Amby и manual-conflict.

Шаг: MANUAL-01.2
Статус: PARTIAL
Ожидалось: оба окна показывают одинаковые canonical vault path и generation.
Получено: оба окна показывали один disposable vault; backend generation в UI/log не экспонируется.
Evidence: /private/tmp/amby-manual-liPGgV/step-02-main-and-detached.png
Примечание: path подтверждён, generation нельзя отметить PASS без наблюдаемого значения.

Шаг: MANUAL-01.3
Статус: PASS
Ожидалось: чистый buffer второго окна обновляется после save из первого.
Получено: from-main отобразился в detached window без conflict.
Evidence: наблюдено пользователем; /private/tmp/amby-manual-liPGgV/step-02-main-and-detached.png
Примечание: проверено в полном Tauri-приложении.

Шаг: MANUAL-01.4
Статус: PASS
Ожидалось: stale save второго окна показывает revision conflict, не перезапись.
Получено: controlled concurrent edits main-wins и child-stale дали диалог с разными local/external версиями.
Evidence: /private/tmp/amby-manual-liPGgV/step-05-save-copy-dialog.png
Примечание: исходная заметка на диске не была молча заменена локальной версией.

Шаг: MANUAL-01.5
Статус: PASS
Ожидалось: проверены keep local, accept external и save conflict copy.
Получено: keep local записал local content; accept external записал external content; save copy создал отдельный conflict файл и не заменил исходную заметку.
Evidence: /private/tmp/amby-manual-liPGgV/step-05-keep-local.png; /private/tmp/amby-manual-liPGgV/step-05-accept-external.png; /private/tmp/amby-manual-liPGgV/step-05-save-copy.png; /private/tmp/amby-manual-liPGgV/manual-conflict.01M0VTYTYNHHQRGXD9XE0HTA84-conflict.md
Примечание: после save copy диалог оставался открытым с путём созданной копии; затем штатно разрешён через accept external.

Шаг: MANUAL-01.6
Статус: FAIL
Ожидалось: detached window закрывается, а watcher продолжает работать в main.
Получено: detached window осталось открытым после Window → Close Window, системной close button и Command-W. Dev log сообщил repeated unhandled rejection: window.destroy not allowed; требуемое разрешение core:window:allow-destroy отсутствует.
Evidence: /private/tmp/amby-manual-liPGgV/step-06-detached-closed.png; /private/tmp/amby-manual-liPGgV/manual-01-terminal.log
Примечание: пакет остановлен по п. 9 общего протокола; watcher после закрытия не проверялся.

Шаг: MANUAL-01.7
Статус: PARTIAL
Ожидалось: rapid edits и close во время pending autosave не теряют последний текст.
Получено: rapid local edits без ложного conflict ранее подтверждены PASS в этом дне; close во время pending autosave не запускался после FAIL шага 6.
Evidence: smoke evidence выше; /private/tmp/amby-manual-liPGgV/step-01-vault-open.png
Примечание: остановлено по п. 9 общего протокола.
```

Исправление после второго FAIL:

- Tauri close listener фактически завершает разрешённый close через
  `Window.destroy()`;
- для `main` и `note-*` добавлен узкий `core:window:allow-destroy`;
- обработчик после flush теперь напрямую вызывает `destroy()` и разрешает
  повторную попытку при ошибке;
- статус: `RETEST REQUIRED`. Повторить шаг 6, проверить watcher в оставшемся main
  window, затем закрыть detached window во время pending autosave по шагу 7.

Финальный повтор после `MANUAL-01-CLOSE-FIX`, 25 августа 2026 года, до 10:12 EEST:

```text
Шаг: MANUAL-01.2 — общий active vault/generation
Статус: PASS
Ожидалось: оба окна работают с одним canonical vault и текущей backend generation.
Получено: оба renderer показали один test vault; child write, cross-window sync и CAS conflict успешно прошли через backend без stale-generation error.
Evidence: наблюдено пользователем; /private/tmp/amby-manual-liPGgV/step-02-main-and-detached.png; результаты шагов 3–5.
Примечание: числовая generation не показана в UI, но её принятие подтверждено реальными child write и CAS командами, которые отклоняют stale generation.

Шаг: MANUAL-01.6
Статус: PASS
Ожидалось: detached window закрывается, main остаётся открытым, watcher продолжает работать.
Получено: дополнительное окно закрыто системным крестиком без ошибки destroy; main осталось открытым; внешняя строка watcher-after-detached-close-1023 появилась автоматически.
Evidence: наблюдено пользователем; внешняя правка /private/tmp/amby-manual-liPGgV/manual-conflict.md; dev log без window.destroy error.
Примечание: Tauri процесс оставался активным после закрытия detached window.

Шаг: MANUAL-01.7
Статус: PASS
Ожидалось: rapid edits и немедленное закрытие во время pending autosave не теряют последний текст.
Получено: после ввода pending-close-check, немедленного закрытия дополнительного окна и повторного открытия строка сохранилась.
Evidence: наблюдено пользователем в npm run tauri dev.
Примечание: после завершения проверки Tauri dev остановлен штатно; новых ошибок в log нет.
```

Итог: все шаги `MANUAL-01.1` — `MANUAL-01.7` имеют достаточное runtime evidence;
исторические `FAIL` выше сохранены как диагностика устранённых дефектов.

### MANUAL-02 — External editor и filesystem watcher

Статус: `PASS`. Все шаги 1–6 подтверждены в полном Tauri-приложении. Первый
rename и первый delete ранее остановили пакет; их evidence сохранён ниже, а
повтор после `MANUAL-02-FIX` и `MANUAL-02-DELETE-FIX` завершился успешно.

Среда: commit `9294076`; macOS 26.5.2 arm64; `npm run tauri dev`; disposable vault
`/private/tmp/amby-manual-Vt4mp6`; пользовательский vault не изменялся.

```text
Шаг: MANUAL-02.1
Статус: PASS
Ожидалось: external edit чистой открытой заметки обновляет buffer без conflict.
Получено: clean-baseline внешне заменён на external-clean-update; Amby автоматически показала новый текст без диалога.
Evidence: наблюдено пользователем; /private/tmp/amby-manual-Vt4mp6/external-watch.md.
Примечание: buffer до внешней записи оставался clean.

Шаг: MANUAL-02.2
Статус: PASS
Ожидалось: external edit при локально dirty buffer показывает conflict без silent overwrite.
Получено: во время локальной local-unsaved-version внешняя запись external-dirty-version показала диалог с обеими разными версиями.
Evidence: наблюдено пользователем в полном Tauri-приложении.
Примечание: конфликт разрешён через «Принять внешнюю» для продолжения теста.

Шаг: MANUAL-02.3
Статус: PASS
Ожидалось: типичный atomic-save через temporary file + rename корректно обрабатывается watcher.
Получено: hidden temporary file атомарно заменил исходную заметку; external-atomic-save-version появилась без false conflict.
Evidence: наблюдено пользователем; итоговый файл /private/tmp/amby-manual-Vt4mp6/renamed-watch.md.
Примечание: frontmatter ID и содержимое сохранены в replacement.

Шаг: MANUAL-02.4 — external rename
Статус: FAIL
Ожидалось: tree, document и tab согласованно показывают renamed-watch без потери открытого buffer.
Получено: tree и document header обновились на renamed-watch, содержимое сохранилось, но tab остался external-watch.
Evidence: /private/tmp/amby-manual-Vt4mp6/manual-02-external-rename-stale-tab.png.
Примечание: Tauri остановлен; move/delete не выполнялись. Root cause исправлен в MANUAL-02-FIX.

Шаг: MANUAL-02.4 — повтор external rename
Статус: PASS
Ожидалось: tree, document и tab согласованно показывают новое имя без потери buffer.
Получено: после external rename все три заголовка показали renamed-watch-fixed; external-atomic-save-version сохранился, conflict не появился.
Evidence: наблюдено пользователем в npm run tauri dev.
Примечание: ручное подтверждение MANUAL-02-FIX.

Шаг: MANUAL-02.4 — external move
Статус: PASS
Ожидалось: открытая заметка переходит во вложенную папку без закрытия вкладки, потери текста или conflict.
Получено: renamed-watch-fixed появилась внутри Moved; вкладка осталась открытой с тем же заголовком и содержимым; conflict не появился.
Evidence: наблюдено пользователем в npm run tauri dev.
Примечание: stable ID и открытый buffer сохранены.

Шаг: MANUAL-02.4 — external delete, первый проход
Статус: FAIL
Ожидалось: файл исчезает из tree, вкладка остаётся открытой и появляется явный external-deletion dialog.
Получено: файл исчез из tree, вкладка осталась открытой, но диалог не появился; dev log сообщил watcher.open_document_reload_failed.
Evidence: /private/tmp/amby-manual-Vt4mp6/manual-02-external-delete-fail.txt; наблюдено пользователем.
Примечание: исходный файл перенесён в recoverable backup и затем возвращён для retest; Tauri остановлен. Root cause исправлен в MANUAL-02-DELETE-FIX; требуется повтор delete.

Шаг: MANUAL-02.4 — external delete, повтор после fix
Статус: PASS
Ожидалось: файл исчезает из tree, вкладка остаётся открытой и появляется явный deletion dialog с безопасными действиями.
Получено: tree удалил файл, вкладка осталась открытой, появился диалог «Файл был удалён вне Amby» с «Оставить вкладку открытой» и «Восстановить локальную».
Evidence: /private/tmp/amby-manual-Vt4mp6/manual-02-external-delete-dialog-pass.png; наблюдено пользователем.
Примечание: platform-specific rename-out корректно классифицирован по отсутствию stable ID.

Шаг: MANUAL-02.4 — «Восстановить локальную»
Статус: PASS
Ожидалось: explicit restore атомарно возвращает файл без потери buffer, stable ID или source bytes.
Получено: диалог закрылся, файл вернулся в Moved/, вкладка и текст сохранились, conflict не появился; cmp и SHA-256 подтвердили byte-identical результат с backup.
Evidence: /private/tmp/amby-manual-Vt4mp6/manual-02-final-pass.txt; SHA-256 fe874a12f76cd4072eefe76ad0d5da426c7ebe32cb22aa1ee4e4a768ffe83162.
Примечание: stable ID 01M0VWDRR9TZXXXERDX6QNYHVZ и frontmatter сохранены.

Шаг: MANUAL-02.5
Статус: PASS
Ожидалось: собственная запись Amby не создаёт watcher conflict; внешнее изменение sibling не подавляется own-write suppression.
Получено: own-write-no-conflict-1053 сохранилась на диск без диалога; sibling-external-update-1058 появилась в уже открытой sibling-вкладке.
Evidence: /private/tmp/amby-manual-Vt4mp6/manual-02-final-pass.txt; итоговые Markdown-файлы test vault.
Примечание: одна попытка создать дополнительный dirty conflict исключена как таймингово недействительная — disk content доказал, что local autosave завершился до внешней операции.

Шаг: MANUAL-02.6
Статус: PASS
Ожидалось: после открытия и закрытия detached window process-wide watcher продолжает работать в main.
Получено: detached sibling-window закрыто; затем watcher-after-detached-close-1100 автоматически появилась в main без conflict.
Evidence: /private/tmp/amby-manual-Vt4mp6/manual-02-final-pass.txt; наблюдено пользователем.
Примечание: Tauri dev остановлен штатно; новых ошибок в log нет.
```

Итог: все шаги `MANUAL-02.1` — `MANUAL-02.6` имеют runtime evidence;
исторические `FAIL` сохранены как диагностика устранённых `BUG-31` и `BUG-32`.

1. Открыть чистую заметку и изменить её внешним редактором: Amby должен обновить
   buffer без ложного conflict.
2. Повторить с локально dirty buffer: должен появиться conflict без silent overwrite.
3. Проверить external atomic-save/rename pattern используемого редактора.
4. Внешне переименовать, переместить и удалить открытую заметку.
5. Проверить, что собственная запись Amby не создаёт watcher conflict, а соседнее
   внешнее изменение не подавляется own-write record.
6. Повторить после открытия и закрытия detached window.

### MANUAL-03 — Close/switch/visibility и recovery

Статус: `PASS` (26 августа 2026 года). Исторический `FAIL` первого прохода
сохранён ниже как evidence устранённого `BUG-33`.

Среда: commit `9294076`; macOS 26.5.2 (`25F84`), arm64; полный desktop-режим
`npm run tauri dev`; 2026-08-25 11:13–11:31 EEST. Использованы disposable vaults
`/private/tmp/amby-manual-PS8a8H` и
`/private/tmp/amby-manual-PS8a8H-switch`; пользовательский vault не изменялся.

```text
Шаг: MANUAL-03.1
Статус: PASS
Ожидалось: изменение Live Preview не теряется при закрытии main window быстрее 200 мс.
Получено: CLOSE-FLUSH-M03 записан в manual-close.md; после успешного save recovery draft отсутствует.
Evidence: /private/tmp/amby-manual-PS8a8H/manual-close.md; наблюдено пользователем.
Примечание: окно закрыто немедленно после ввода, Tauri process штатно завершился.

Шаг: MANUAL-03.2
Статус: PASS
Ожидалось: editor serialization и autosave flush выполняются перед vault switch и visibilitychange: hidden.
Получено: SWITCH-FLUSH-M03 записан до активации второго vault; HIDDEN-FLUSH-M03 записан после Cmd-H; recovery после успеха очищен.
Evidence: /private/tmp/amby-manual-PS8a8H/manual-close.md; наблюдено пользователем.
Примечание: оба события проверены отдельно при autosave delay 10000 мс.

Шаг: MANUAL-03.3
Статус: PASS
Ожидалось: crash между editor serialization и filesystem save оставляет disk baseline и durable recovery draft.
Получено: цифровой marker 0303030303 введён системным trigger; через 250 мс PID 75664 получил SIGKILL. Markdown остался без marker, recovery JSON содержит marker и корректный pathHint.
Evidence: /private/tmp/amby-manual-PS8a8H/manual-crash.md; /private/tmp/amby-manual-PS8a8H/.amby/recovery/01M0VZWSGPC0RBDXWKAMZNEPF2.json; manual-03-fail.txt.
Примечание: штатный close lifecycle не выполнялся. Предварительные timing shots не учитывались, потому что попадали в hidden/close flush.

Шаг: MANUAL-03.4
Статус: FAIL
Ожидалось: после restart отличающийся Markdown recovery draft вызывает явный accept/decline prompt; затем проверяются обе ветки и save failure.
Получено: session.json восстановил manual-crash активной вкладкой напрямую с disk content, диалог recovery не появился. Draft с 0303030303 сохранился и продолжал отличаться от source-файла.
Evidence: /private/tmp/amby-manual-PS8a8H/.amby/session.json; /private/tmp/amby-manual-PS8a8H/.amby/recovery/01M0VZWSGPC0RBDXWKAMZNEPF2.json; /private/tmp/amby-manual-PS8a8H/manual-03-fail.txt; отсутствие диалога наблюдено пользователем.
Примечание: root cause подтверждён в use-vault-data.ts — restored-tab preload вызывает readNote/setDoc в обход recovery path use-document-loading.ts. Accept, decline и save failure не продолжались после FAIL.

Шаг: MANUAL-03.5
Статус: BLOCKED
Ожидалось: Canvas recovery проверяется при совпадающем и отличающемся disk content.
Получено: не выполнялось после MANUAL-03.4 FAIL.
Evidence: /private/tmp/amby-manual-PS8a8H/manual-03-fail.txt.
Примечание: остановлено по п. 9 общего протокола.

Шаг: MANUAL-03.6
Статус: BLOCKED
Ожидалось: recovery draft удаляется только после успешного filesystem save.
Получено: положительная часть подтверждена в шагах 1–2, а failure boundary не выполнялась после MANUAL-03.4 FAIL.
Evidence: /private/tmp/amby-manual-PS8a8H/manual-03-fail.txt.
Примечание: полный шаг требует повторного прохода после MANUAL-03-FIX.

Шаг: MANUAL-03.7
Статус: BLOCKED
Ожидалось: recovery сохраняет BOM, CRLF и terminal line breaks.
Получено: не выполнялось после MANUAL-03.4 FAIL.
Evidence: /private/tmp/amby-manual-PS8a8H/manual-03-fail.txt.
Примечание: остановлено по п. 9 общего протокола.
```

Итог первого прохода: lifecycle flush и durable crash draft подтвердились runtime
evidence, а session restore выявил silent recovery bypass. `BUG-33` исправлен;
исходный `FAIL` не переписан задним числом.

Полный повтор: commit baseline `9294076`; macOS 26.5.2 (`25F84`), arm64;
`npm run tauri dev`; 2026-08-26 08:25–09:08 EEST. Использованы disposable vaults
`/private/tmp/amby-manual-FGt69k` и
`/private/tmp/amby-manual-switch-2no9vL`; пользовательский vault не изменялся.

```text
Шаг: MANUAL-03.1
Статус: PASS
Ожидалось: Live Preview edit flush-ится при закрытии main window быстрее 200 мс.
Получено: CLOSE-RETEST-M03 сохранён; recovery после успешной записи отсутствует.
Evidence: /private/tmp/amby-manual-FGt69k/manual-close.md; manual-03-retest.txt.

Шаг: MANUAL-03.2
Статус: PASS
Ожидалось: editor serialization/flush завершаются до vault switch и visibility hidden.
Получено: SWITCH-RETEST-M03 и 0202020202 сохранены до переключения/Cmd-H; recovery очищен.
Evidence: оба disposable vault; step-02-current.png; manual-03-retest.txt.

Шаг: MANUAL-03.3
Статус: PASS
Ожидалось: SIGKILL между serialization и save оставляет disk baseline и durable draft.
Получено: цифровые markers после 250 мс SIGKILL отсутствовали на диске и присутствовали в recovery с корректным pathHint.
Evidence: Markdown/Canvas/format fixtures и manual-03-retest.txt.

Шаг: MANUAL-03.4
Статус: PASS
Ожидалось: session restore показывает recovery prompt; accept/decline/save failure не теряют данные.
Получено: accept записал 0303031111; decline оставил disk без 0303032222; chmod 0555 показал локализованную ошибку, сохранил draft и dirty state, а retry после chmod 0755 записал 0303033333 и только затем удалил draft.
Evidence: step-04-accept-prompt.png; step-05-decline-prompt.png; step-06-save-failure-error.png.

Шаг: MANUAL-03.5
Статус: PASS
Ожидалось: отличающийся Canvas требует prompt, равный disk recovery удаляется без prompt.
Получено: differing Canvas принят и записан; byte-equal Canvas открылся без prompt. В ходе проверки найден и исправлен BUG-34 — parallel Canvas loads/duplicate tabs/prompts.
Evidence: step-07-canvas-different-prompt-3.png; step-08-canvas-equal-no-prompt-2.png.

Шаг: MANUAL-03.6
Статус: PASS
Ожидалось: recovery удаляется только после успешного filesystem save.
Получено: success cleanup подтверждён Markdown/Canvas; forced failure сохранил draft до успешного lifecycle retry.
Evidence: recovery directory states и manual-03-retest.txt.

Шаг: MANUAL-03.7
Статус: PASS
Ожидалось: ID migration и recovery сохраняют BOM, CRLF и terminal line breaks.
Получено: после исправления BUG-35 runtime migration и crash recovery сохранили ровно один BOM в byte 0, ноль bare LF/CR и три terminal CRLF sequences (две пустые строки).
Evidence: format-recovery-fixed.md; step-09-fixed-fixture-tree.png; step-09-format-recovery-prompt.png; manual-03-retest.txt.
```

Итог повторного прохода: все шаги `MANUAL-03.1` — `MANUAL-03.7` получили
runtime `PASS`. Полный gate после исправлений: TypeScript, ESLint, 323 Vitest,
Prettier, Knip, Rustfmt, strict Clippy и 143 Rust tests. `npm run build` и
`git diff --check` проходят. `bindings:check` экспортирует bindings успешно и
останавливается только на уже существующем generated diff MANUAL-02 относительно
HEAD; SHA-256 остаётся
`c7a1ae82235a41ed90a642eb3413cfe0df8414c25b18410096a3592942e66efa`.

### MANUAL-04 — History retention и restore

Статус: `PASS` (29 августа 2026 года).

Среда: commit `9294076` с текущими незакоммиченными исправлениями; macOS 26.5.2
(`25F84`), arm64; полный desktop-режим `npm run tauri dev`. Повторно использован
уже существующий disposable vault `/private/tmp/amby-manual-FGt69k`; новые vault
для отдельных проверок не создавались.

1. На тестовом vault создать несколько версий нескольких заметок.
2. Сверить UI stats с фактическим количеством и размером snapshots.
3. Проверить preview cleanup и отмену без изменений filesystem.
4. Выполнить cleanup по count и age retention.
5. Восстановить оставшийся snapshot после cleanup.
6. Перезапустить приложение и убедиться, что manifest читается без полного O(N)
   восстановления и не скрывает повреждённые записи.

```text
Шаг: MANUAL-04.1
Статус: PASS
Ожидалось: создать версии нескольких заметок.
Получено: manifest содержал 29 snapshots для 8 заметок; history-beta — 22 версии.
Evidence: /private/tmp/amby-manual-FGt69k/manual-04-retest.txt; manual-04-single-workspace-ready.png.

Шаг: MANUAL-04.2
Статус: PASS
Ожидалось: UI stats совпадают с manifest и snapshot-файлами.
Получено: manifest 29/8/2501 bytes и 29 файлов; UI показал 29 версий, 8 заметок, 3 КБ и 22 версии/2 КБ для history-beta.
Evidence: /private/tmp/amby-manual-FGt69k/manual-04-stats-two-notes.png; manual-04-retest.txt.

Шаг: MANUAL-04.3
Статус: PASS
Ожидалось: preview корректен, отмена не меняет filesystem.
Получено: preview предлагал удалить 2 и оставить 20; после отмены SHA-256 manifest, список snapshot-файлов и count 29 остались идентичными.
Evidence: /private/tmp/amby-manual-FGt69k/manual-04-cleanup-preview.png; manual-04-retest.txt.

Шаг: MANUAL-04.4
Статус: PASS
Ожидалось: count/age retention удаляют только подходящие версии.
Получено: count cleanup удалил ровно 2 и оставил 27 всего/20 для history-beta; age cleanup удаляет только старый snapshot в focused regression test. Journal/staging/temp отсутствуют.
Evidence: /private/tmp/amby-manual-FGt69k/manual-04-retest.txt; history::tests::cleanup_removes_only_versions_older_than_the_requested_age.

Шаг: MANUAL-04.5
Статус: PASS
Ожидалось: оставшийся snapshot восстанавливается после cleanup.
Получено: retained snapshot восстановлен; заменяемое состояние сначала попало в новую forced-history запись. Повторный count cleanup вернул 27/20.
Evidence: /private/tmp/amby-manual-FGt69k/manual-04-retest.txt.

Шаг: MANUAL-04.6
Статус: PASS
Ожидалось: restart читает manifest и не скрывает повреждённую запись; corrupted restore отклоняется.
Получено: после restart статистика сохранилась, намеренно повреждённая запись осталась видима; integrity regression test отклоняет restore до изменения source. Тестовая порча затем устранена байт-в-байт, snapshot удалён штатной retention.
Evidence: /private/tmp/amby-manual-FGt69k/manual-04-retest.txt; history::tests::rejects_a_corrupted_snapshot_before_restore.
```

Итог: runtime и filesystem части `MANUAL-04.1` — `MANUAL-04.6` получили
`PASS`. Финальный manifest содержит 27 snapshots, из них 20 для `history-beta`,
и ровно 27 snapshot-файлов; журналов незавершённой очистки нет. Полный gate:
323 Vitest и 144 Rust tests, typecheck, ESLint, Prettier, Knip, Rustfmt, strict
Clippy, `npm run build` и `git diff --check` проходят. Экспорт bindings проходит;
финальный `bindings:check` видит только уже существующий generated IPC diff
относительно HEAD, SHA-256 файла не изменился:
`c7a1ae82235a41ed90a642eb3413cfe0df8414c25b18410096a3592942e66efa`.

### MANUAL-05 — Filesystem portability

Статус: `PARTIAL` (29 августа 2026 года). Доступные проверки на macOS/APFS
выполнены в уже существующем disposable vault
`/private/tmp/amby-manual-FGt69k`; отдельные vault не создавались. На машине
установлен только target `aarch64-apple-darwin`, а среди mounts отсутствуют
Windows, exFAT/FAT, SMB и NFS, поэтому эти среды не отмечены как `PASS`.

1. Выполнить case-only rename note/folder/bundle на Windows.
2. Проверить bundle main, Canvas и Excalidraw sidecars после rename и rollback.
3. Проверить no-replace create/import на реальных exFAT и FAT носителях.
4. По возможности проверить network filesystem без hard-link support.
5. Во всех случаях смоделировать внезапно появившийся target и убедиться, что
   пользовательский файл не перезаписан.

```text
Шаг: MANUAL-05.1
Статус: BLOCKED
Ожидалось: case-only rename note/folder/bundle на Windows.
Получено: Windows host/VM/target отсутствует. Дополнительный macOS/APFS прогон case-only note/folder/bundle прошёл.
Evidence: /private/tmp/amby-manual-FGt69k/manual-05-macos.txt; 2 focused case_only Rust tests.

Шаг: MANUAL-05.2
Статус: PASS (macOS/APFS)
Ожидалось: main, Canvas и Excalidraw sidecars сохраняются после rename и rollback.
Получено: production rename/rollback выполнены прямо в reusable vault; точные имена и SHA-256 main/Canvas/Excalidraw/child восстановлены.
Evidence: /private/tmp/amby-manual-FGt69k/manual-05-macos.txt; 5 focused rollback tests.

Шаг: MANUAL-05.3
Статус: BLOCKED
Ожидалось: no-replace create/import на реальных exFAT и FAT.
Получено: подходящих физических/смонтированных носителей нет; automated fallback/collision tests проходят, но не заменяют real-media run.
Evidence: mount list; /private/tmp/amby-manual-FGt69k/manual-05-macos.txt.

Шаг: MANUAL-05.4
Статус: BLOCKED
Ожидалось: network filesystem без hard-link support.
Получено: SMB/NFS mount отсутствует; fault-injection unsupported-hard-link fallback проходит.
Evidence: 2 focused no_replace Rust tests; manual-05-macos.txt.

Шаг: MANUAL-05.5
Статус: PARTIAL
Ожидалось: внезапно появившийся target нигде не перезаписывается.
Получено: APFS sentinel сохранён production atomic_write_new, fallback collision и rename collisions отклонены, temp-файлов нет. Недоступные Windows/exFAT/FAT/network среды не проверены.
Evidence: /private/tmp/amby-manual-FGt69k/manual-05-macos.txt; focused collision tests.
```

Итог: macOS/APFS часть пройдена без потери данных, но общий пакет остаётся
`PARTIAL`. Перед заявлением поддержки Windows или съёмных/network filesystem
необходим отдельный прогон шагов `MANUAL-05.1`, `MANUAL-05.3`, `MANUAL-05.4` и
оставшейся матрицы `MANUAL-05.5` на реальном окружении.

### MANUAL-06 — UI interactions

Статус: `PASS` на macOS (29–30 августа 2026 года).

Проверено в полном Tauri debug bundle `Amby Manual.app`, identifier
`amby-notes-manual`, на коде `9294076` + текущие незакоммиченные изменения.
Фактический `sw_vers -productVersion` 30 августа: `26.6.2`, `uname -m`: `arm64`;
версия ОС старых manual-прогонов не переносится автоматически на текущий.
Использован один vault `/private/tmp/amby-manual-FGt69k`; отдельный каталог
`/private/tmp/amby-manual-dnd-source` — только источник Finder drag, не workspace.
Общий evidence: `/private/tmp/amby-manual-FGt69k/manual-06-retest.txt`.

Исходный checklist:

1. Перетащить несколько файлов из Finder в Tiptap и проверить порядок image/file
   links после асинхронного импорта.
2. Уничтожить editor во время column resize и проверить отсутствие зависших
   listeners, rAF и resize DOM.
3. Проверить DnD note/folder на self, descendant, root и допустимый target.
4. Проверить Quick Open с одинаковыми именами в разных папках.
5. Проверить запрет одной editable заметки в двух split panes.
6. Закрыть и открыть вкладку во время pending autosave; dirty/conflict/recovery
   buffer не должен быть преждевременно evicted.

#### Исторические FAIL и исправления

- `MANUAL-06.1`: native coordinates/hitbox мешали drop на macOS Retina и в пустой
  области под текстом. После исправления hitbox batch из трёх элементов выявил
  `RangeError` из-за remap уже mapped позиции. Файлы были импортированы в assets,
  но соответствующие ссылки не появились. Исправлено в `MANUAL-06-DROP-FIX`.
  `manual-06-boundary-result.png` и `manual-06-boundary-pass.png` — evidence
  исторических неуспешных попыток; слово `pass` в старом имени не означает PASS.
- `MANUAL-06.5`: проверка выявила недоступность Split action: функция/guard были,
  кнопки не было. Исправлено и повторно проверено в `MANUAL-06-SPLIT-FIX`.
- Первоначальное закрытие всего процесса во время resize не доказывало снятие
  listeners в живом окне. Поэтому `MANUAL-06.2` повторён закрытием только вкладки
  до отпускания кнопки мыши; старый process-exit smoke не принят как достаточный.

#### Результаты повторного прогона

1. **MANUAL-06.1 — PASS.** Finder file+image+image batch вставлен в пустой хвост
   Tiptap; в `manual-boundary.md` сохранены file link, `b-icon`, `c-icon` именно
   в этом порядке после `Last block.`. SHA-256 всех трёх импортированных assets
   совпадает с исходниками. Evidence: `manual-06-boundary-final.png`, Markdown
   и hashes в общем evidence. Ранний drop в строку записан отдельно в
   `manual-ui.md`/`manual-06-dnd-retest.png`; итоговый PASS основан на повторе
   после последнего mapping fix, а не на раннем screenshot.
2. **MANUAL-06.2 — PASS.** Начат resize двух колонок до `57% · 43%`; активная
   вкладка закрыта средней кнопкой, пока левая ещё удерживалась. До `leftUp`
   исчезли guide/label, осталась рабочая вкладка Deep в том же живом окне.
   После release артефакты не вернулись, Markdown колонок сохранил исходные
   `0.5000,0.5000`. Evidence: `manual-06-resize-tab-active.png`,
   `manual-06-resize-tab-destroyed-before-release.png`,
   `manual-06-resize-tab-after-release.png`. DOM plugin regression дополнительно
   проверяет отмену pending rAF, снятие всех пяти mouse/pointer listeners,
   очистку classes/cursor и отсутствие dispatch после destroy.
3. **MANUAL-06.3 — PASS.** Self-drop ManualFolder и drop в descendant Nested
   не изменили дерево/пути. Deep перемещён из Nested в root, затем в QuickA,
   после чего возвращён в Nested. До/после этих moves SHA-256 одинаков:
   `9d6e1c865ff2d00f0a0fa235b8d9ffcb7929527dca7db44f32e6ad3f8c16b0bf`.
   Evidence: `manual-06-tree-root-move.png`, `manual-06-tree-valid-move.png`;
   35 focused tree/mutation tests. Поздние marker edits шага 6 намеренно изменили
   этот тестовый файл и не относятся к проверке byte-preserving moves.
4. **MANUAL-06.4 — PASS.** Quick Open по `Duplicate` показал две строки.
   Enter открыл QuickA/Duplicate с текстом A; повторный поиск, ArrowDown/Enter —
   QuickB/Duplicate с текстом B и другим breadcrumb. Поиск `QuickB` также
   находит B. Evidence: `manual-06-quick-open-duplicates.png`,
   `manual-06-quick-open-first.png`, `manual-06-quick-open-second.png`.
   Уточнение: пути различаются в selection value и breadcrumb после открытия;
   сами строки результатов пока показывают одинаковые имена без подписи пути.
   Отображение пути в списке — отдельное UX-улучшение, не выполненное этим пакетом.
5. **MANUAL-06.5 — PASS после fix.** После восстановления кнопки Split две
   вкладки QuickB/Duplicate не создали два editable pane одной заметки: вторым
   pane выбрана другая заметка (manual-columns). Evidence:
   `manual-06-split-control-restored.png`, `manual-06-split-duplicate-tab.png`,
   `manual-06-split-guard.png`; HeaderTabs component и split render-guard tests.
6. **MANUAL-06.6 — PASS.** Autosave delay временно выставлен через UI с 1000 на
   10000 мс. В единственную вкладку Deep введён marker A; она закрыта до save:
   на диске marker отсутствовал, session refs = 0, recovery entries с marker = 1.
   После быстрого reopen A был в редакторе с dirty marker, disk ещё без A,
   session refs = 1, recovery = 1. Второй цикл добавил B, закрыл/открыл вкладку,
   затем до save добавил C. После autosave на диске A/B/C ровно по одному разу,
   исходный текст/frontmatter сохранены, recovery = 0 и dirty marker снят.
   SHA-256 результата:
   `2cad018ff4278b525fef855ab1029280ae418192dd712636c671e45a1c69ac01`.
   Evidence: `manual-06-pending-closed.png`, `manual-06-pending-reopened.png`,
   `manual-06-pending-newer-edit.png`, `manual-06-pending-saved.png`;
   filesystem/session/recovery checkpoints в общем evidence.
   Исходные 1000 мс восстановлены (`manual-06-autosave-restored-1000.png`).

Границы результата: runtime шага 6 проверял pending **scheduled** autosave, а не
искусственно заторможенный in-flight IPC. Conflict/in-flight защита дополнительно
покрыта focused lifecycle/coordinator tests и предыдущими MANUAL-01—03; новый
runtime conflict injection в MANUAL-06 не выполнялся. Windows/Linux UI этот
прогон не подтверждает. Тестовый vault и evidence сохранены; к MANUAL-07 в этом
пакете не переходили.

#### Автоматические проверки после MANUAL-06

- `npm run verify`: TypeScript, ESLint, **332 Vitest / 56 files**, Prettier, Knip,
  Rustfmt, strict Clippy и **144 Rust tests** — PASS. Knip вывел только
  нефатальный configuration hint для `.css`.
- Итог команды — **exit 1**, исключительно на заключительном
  `git diff --exit-code -- src/lib/bindings.ts`. `export_bindings` успешен;
  SHA-256 bindings до/после полного прогона одинаков:
  `c7a1ae82235a41ed90a642eb3413cfe0df8414c25b18410096a3592942e66efa`.
  Diff относительно HEAD относится к более ранним изменениям
  `restoreDeletedNote`/`NoteReadOutcome.source`, а не к устаревшей генерации.
  Файл не редактировался вручную; staging/commits не менялись. Полный gate нельзя
  объявлять зелёным до фиксации согласованного Rust + generated bindings набора
  и повторного успешного запуска.
- `npm run build` — PASS; `git diff --check` — PASS.
- `npm run tauri build -- --debug --bundles app --config
/private/tmp/amby-manual-FGt69k/tauri-manual-config.json` — PASS; собран свежий
  `src-tauri/target/debug/bundle/macos/Amby Manual.app`. Это debug bundle для
  manual-проверок, не новый production `.dmg` и не повтор `FINAL-01`.
- Тестовое приложение штатно закрыто; проверка bundle ID подтвердила отсутствие
  процесса. Vault не удалён, исходный autosave delay 1000 мс восстановлен.
  `app-config.ts` не содержит тестового startup diff. `dist/`, target bundle и
  vault/recovery data не добавлены в Git.

### MANUAL-07 — Settings, credentials и AI errors

Статус: `PASS` (30 августа 2026 года, финальный повтор 15:19–15:24 EEST).
Два найденных дефекта устранены отдельными fix-пакетами ниже, после каждого
FAIL runtime-проверка останавливалась. Итоговые evidence и границы — после
`MANUAL-07-FIX-02`. Следующие PERF-01/FINAL-02 не выполнялись.

Первый исторический прогон — `FAIL`. Runtime-проверка остановлена на первом
шаге по общему протоколу: после сохранения синтетического ключа UI сохранил
`credentialId` в settings, но безопасная account-specific проверка реального
macOS Keychain (`security find-generic-password`, без чтения пароля) не нашла
отдельную тестовую запись `com.ambynotes.ai`. Никакие реальные credentials или
полные provider responses не читались и не записывались. Тестовая модель удалена
и заменена безопасной локальной Ollama-моделью без credentialId; тестовое
приложение закрыто. Evidence:
`/private/tmp/amby-manual-FGt69k/manual-07-fail.txt`.

1. Проверить store/delete/inspect credential через реальный macOS Keychain.
2. Сохранить whitespace secret и убедиться, что credential удалён.
3. Смоделировать ошибку сохранения settings и проверить видимое локализованное
   уведомление.
4. Проверить AI network/provider/configuration errors для настроенных providers.
5. Убедиться, что UI/logs/IPC errors не содержат secret, полный provider response
   или чувствительные request details.

Фактический runtime-результат (debug `Amby Manual`, commit `9294076` + working
tree; macOS 26.6.2 arm64; 14:11–14:53 EEST):

```text
Шаг: MANUAL-07.1
Статус: FAIL
Ожидалось: синтетическая test credential хранится, inspectable и удаляется через реальный macOS Keychain.
Получено: UI создал credentialId, но безопасный точечный Keychain lookup не нашёл test entry; пароль не читался.
Evidence: /private/tmp/amby-manual-FGt69k/manual-07-fail.txt; manual-07-keychain-store-result.png
Примечание: пакет остановлен; модель и credentialId reference очищены.

Шаги: MANUAL-07.2 — MANUAL-07.5
Статус: BLOCKED
Ожидалось: whitespace delete, settings-save error и безопасные AI errors/logs.
Получено: Не запускались после FAIL шага 1 по обязательному stop-condition.
Evidence: /private/tmp/amby-manual-FGt69k/manual-07-fail.txt
Примечание: требуется отдельный MANUAL-07-FIX до повторного полного прогона.
```

### MANUAL-07-FIX — Durable Keychain store/inspect

Статус: `IMPLEMENTED`; повторный runtime 30 августа подтвердил настоящий
Keychain store/inspect, сохранность между процессами, UI delete и whitespace
delete. Причина: `keyring = "3"` без backend features использовал mock.
Добавлены native backends, read-back verification и frontend regression против
dangling credentialId. Итоговые проверки и evidence записаны ниже.

Runtime MANUAL-07.1 подтвердил небезопасное расхождение: после UI store settings
содержали `credentialId`, но точечный lookup той же test account в реальном
macOS Keychain не находил entry. Не считать store успешным, пока backend
`store_ai_credential` и последующий `inspect_ai_credential` не подтверждают
созданную запись; при ошибке не сохранять новый credentialId в frontend settings.

1. Воспроизвести только на новой synthetic test account; не читать существующие
   Keychain records и не логировать password.
2. Установить причину: command registration/capability, keyring backend,
   Keychain search scope или error propagation. Не угадывать её по unit-тесту.
3. Исправить minimal boundary и добавить regression, который доказывает отсутствие
   dangling `credentialId` при store/inspect failure.
4. Повторить полный MANUAL-07 с real Keychain, whitespace-delete, settings-error и
   controlled provider-error шагами. До этого не выполнять PERF-01/FINAL-02.

#### Повтор 30 августа, 15:08–15:16 EEST

Полный `tauri dev`, `9294076` + working tree, macOS 26.6.2 arm64.
Временный driver в настоящем native webview вызывает штатные UI handlers и
реальный IPC (не browser fallback и не mocked IPC). App-data root временно
направлен в `/private/tmp/amby-manual-FGt69k/manual07-runtime`; отдельный
bundle ID **сам по себе не изолирует** `app_data::app_root`. Предыдущий прогон
MANUAL-07 использовал общий app-data root; его замена модели на локальную
не была точным восстановлением первоначальных настроек. Этот повтор общие
настройки не меняет.

- 07.1 PASS: UI store, inspect.exists=true, system lookup exit 0; после
  завершения процесса и нового запуска маска совпадает. UI delete,
  inspect.exists=false, system lookup exit 44. Evidence: `result-6.json`,
  `result-8.json`, `result-9.json`, `keychain-after-restart.png`.
- 07.2 PASS: новая test account, UI whitespace update, inspect=false,
  credentialId=null, system lookup exit 44. Evidence: `result-10.json`,
  `result-11.json`, `keychain-whitespace-deleted.png`.
- 07.3 PASS: временный directory collision вместо тестового settings.json;
  настоящий SettingsDialog показал локализованное уведомление. Исходный файл
  возвращён, SHA-256 до/после:
  `ab35841fc031acf1c48bd153e50d643a133962e884d4b4b6c068a2bf309ace2b`.
  Evidence: `settings-save-error.png`, `result-13.json`. Driver result-12
  завершился ошибкой при чтении намеренно недоступного settings, а не при
  отображении alert; screenshot и следующий snapshot подтверждают UI.
- 07.4 FAIL: loopback mock вернул HTTP 429, OpenAI non-streaming IPC вернул
  `requestFailed` вместо `providerRejected`. Предыдущие Ollama случаи и
  configuration/network cases успешны. Прогон остановлен при первом
  несоответствии, оставшиеся случаи не запускались.
- 07.5 PARTIAL: в выполненных случаях IPC имеет только code/provider,
  canary-утечек не обнаружено. Полная матрица ожидает fix ниже.

Evidence всех файлов этой попытки:
`/private/tmp/amby-manual-FGt69k/manual07-runtime/evidence/`.

### MANUAL-07-FIX-02 — Provider error classification

Статус: `IMPLEMENTED`; focused AI Rust tests — PASS (5 tests).

Runtime `result-16.json` воспроизвёл HTTP 429 → `requestFailed` в
OpenAI-compatible family. Внутренний текст начинается с «Ошибка провайдера»,
а классификатор распознавал только английские HTTP-префиксы. Исправить
классификацию по доверенному HTTP status, исключив влияние provider body,
добавить regression и затем повторить MANUAL-07 с начала.

Все четыре wire family теперь используют один status-only error. Тело
неуспешного HTTP-ответа не читается и не интерполируется во внутреннюю ошибку;
401/403/429 дают `providerRejected`, 5xx — безопасный `requestFailed`.

#### Финальный повтор MANUAL-07 — PASS

Среда: `9294076` + рабочее дерево, macOS 26.6.2 arm64; настоящий
`npm run tauri dev -- --config /private/tmp/amby-manual-FGt69k/tauri-manual07-config.json`.
Начало повторного credential-store 15:19 EEST, окончание/cleanup 15:24 EEST.
Один прежний disposable vault; временный отдельный app-data root и native-webview
driver, без mocked IPC. Скриптовые DOM-события вызывают штатные обработчики
ModelsManager/SettingsDialog/AiPanel; AI-матрица дополнительно вызывает команды
настоящего Rust backend. Driver недоступности locator/контролов не считались
продуктовыми FAIL или PASS: локаторы исправлены, действия повторены и проверены.

Все пути evidence ниже относительно
`/private/tmp/amby-manual-FGt69k/manual07-runtime/evidence/`.

1. **07.1 — PASS.** Новый synthetic key сохранён через ModelsManager;
   inspect=true и маска, system account-specific lookup exit 0. После завершения
   Tauri process и нового запуска inspect/маска сохранились. UI delete очистил
   reference и запись; inspect=false, system lookup exit 44.
   Evidence: `result-19.json`, `result-20.json`, `result-21.json`;
   screenshot предыдущего успешного идентичного Keychain цикла:
   `keychain-after-restart.png`.
2. **07.2 — PASS.** UI-ввод пробелов в новую test account вызвал empty-secret
   IPC update; inspect=false, credentialId=null, system lookup exit 44.
   Rust regression отдельно покрывает raw whitespace argument.
   Evidence: `result-22.json`, `result-23.json`.
3. **07.3 — PASS.** Тестовый settings.json временно заменён пустым каталогом
   с сохранением оригинала; реальное изменение switch в SettingsDialog показало
   русское уведомление об ошибке. Оригинальный файл восстановлен побайтно
   (SHA-256 `ab35841fc031acf1c48bd153e50d643a133962e884d4b4b6c068a2bf309ace2b`).
   Evidence: `result-24.json`, `final-settings-error.png`.
4. **07.4 — PASS.** 24 настоящих IPC случая: Ollama/OpenAI/Anthropic/Azure ×
   streaming/non-streaming × invalid configuration/refused loopback connection/
   HTTP 429. Все ожидаемые error codes совпали. В реальной AiPanel для
   OpenAI-compatible test model проверены три локализованных сообщения.
   Evidence: `result-27.json`, `result-32.json`, `result-33.json`, `result-34.json`,
   `final-ai-provider-error.png`, `final-ai-network-error.png`,
   `final-ai-configuration-error.png`.
5. **07.5 — PASS в проверенной матрице.** Mock ошибочного ответа намеренно
   включал synthetic authorization и private canaries; они не попали в
   IPC error (только code/provider), DOM ошибок, console или сохранённые
   JSON/log evidence. Полные secrets в settings отсутствуют. Evidence:
   safe=true у всех 24 cases, failures=[] в UI snapshots и итоговый scan.

Границы: не выполнялись платные/реальные cloud-запросы, locked-Keychain prompt,
Windows Credential Manager или Linux Secret Service runtime. HTTP 401/403/500
проверены unit-тестом классификатора, а не этим runtime mock (он возвращал 429).
Успешный inference, все возможные provider failure bodies и timeout/cancellation
не входят в этот прогон. При fault injection наблюдался также существующий
unhandled rejected settings-save promise; он не содержал секретов и не мешал
видимому alert (`tauri-final.log`), но UI error-handling cleanup остаётся
отдельным улучшением. Это не production release gate.

#### Cleanup и автоматические проверки MANUAL-07

- Все шесть созданных здесь synthetic Keychain accounts удалены через UI;
  отдельный системный lookup каждой вернул **44 (NoEntry)**. Последний
  `result-36.json` подтверждает credentialId=null/inspect=false.
- Общий пользовательский settings.json не изменился: SHA-256 контрольных
  снимков 15:13/15:24 одинаков:
  `4ad32763a2db3dc88e009ada940937e51fe0791f4e4861eed011f716a0ab2495`.
  Существующие пользовательские Keychain entries не читались/не менялись.
- Tauri/Vite и loopback mock остановлены, порты 1420/18427 освобождены.
  `app_data.rs` и `main.tsx` возвращены точно к исходному состоянию; временный
  driver удалён из src и сохранён только в disposable evidence. Пустой каталог
  fault injection удалён, оригинальные тестовые settings восстановлены.
  Vault/evidence сохранены, в Git не добавлены.
- `npm run verify`: typecheck, ESLint, **341 Vitest / 57 files**, Prettier,
  Knip, Rustfmt, strict Clippy, **147 Rust tests** и bindings export — PASS.
  Общий exit **1** только на заключительном `git diff --exit-code` для ранее
  изменённых generated bindings (`restoreDeletedNote`/`NoteReadOutcome.source`).
  SHA-256 bindings до/после одинаков:
  `c7a1ae82235a41ed90a642eb3413cfe0df8414c25b18410096a3592942e66efa`.
  Gate не объявляется полностью зелёным; staging/commit не выполнялись.
- `npm run build`, `git diff --check` — PASS. `npm run audit:rust` — exit 0,
  без новых блокирующих advisories; warning: ранее присутствовавший в HEAD
  `chacha20 0.10.1` yanked. Существующая advisory allowlist не расширялась.
- Browser-only smoke на отдельном `127.0.0.1:1422` с навыком Browser:
  настройки/модели отрисованы, AiPanel показывает «AI доступен только в
  десктоп-версии Amby», console warn/error пусты. Desktop settings/credentials
  при этом не использовались. Тестовые вкладка и dev server закрыты.
- Продуктовые изменения: Cargo.toml/Cargo.lock native keyring backends,
  credentials read-back/error masking, ModelsManager verification/error handling,
  RU/EN error translation, status-only HTTP failures и focused regression tests.
  Новых IPC типов, permissions или миграций нет; формат vault не изменён.

### PERF-01 — Search smoke и измерения

Статус: `PASS` для smoke на 1 000/10 000 synthetic notes в macOS/APFS.
Выполнено 30 августа 2026 года, успешные runtime runs 21:55–21:57 EEST.
Это не release gate и не подтверждение производительности на других платформах.

1. Подготовить тестовые vaults примерно на 1 000 и 10 000 заметок.
2. Измерить cold/warm name, content и tag search.
3. Проверить cancellation/debounce при быстром вводе.
4. Подтвердить limit 50 и отсутствие frontend read-all IPC fan-out.
5. Записать размеры vault, платформу и фактическое время ответа в журнал.

#### Среда и методика PERF-01

- `dev`, HEAD `9294076` + текущие незакоммиченные изменения после MANUAL-07;
  macOS 26.6.2 arm64, Apple M5, 16 GiB RAM, APFS. Настоящий `tauri dev`,
  Rust debug/unoptimized, React StrictMode; не browser fallback и не mock IPC.
- Измерения выполнены в отдельной APFS copy-on-write копии исходников,
  зависимостей и build cache: `/private/tmp/amby-perf-ONvHfi/runtime`.
  Только в этой копии изменены app-data root и измерительный драйвер.
  Глобальные настройки изолированы в `/private/tmp/amby-perf-ONvHfi/app-data`,
  WebView — в `webview`; отдельный bundle ID не считается гарантией изоляции.
  Основные `src/main.tsx` и `src-tauri/src/app_data.rs` не изменялись.
- Два disposable vaults, по 20 папок, UTF-8 Markdown примерно по 3,9 KB,
  canonical ULID, одинаковые имя файла и H1. Name search здесь означает
  индексированный title: поиск filename при отличающемся H1 не проверялся.
  Content marker расположен в конце тела, есть кириллица.
- `cold` — первый запрос каждой категории после нового процесса и первичной
  индексации. ОС-кэш не очищался; индексация уже прочитала исходные файлы.
  Это не disk-cold benchmark. `warm` — 30 запросов каждой категории с
  чередованием порядка. Время включает storage adapter, настоящий IPC и
  лёгкую инструментализацию; это не изолированное время SQL.
  Таймер WebView практически имеет шаг 1 ms, значения округлены до ms.
- UI latency — от input event до наблюдаемого DOM с 50 результатами,
  3 повтора на категорию, включая debounce 200 ms; опрос DOM каждые 10 ms.
  Искусственная задержка ответа применялась только в stale-response сценарии
  и не включена в cold/warm/UI latency.

| Vault        | Markdown, bytes | SQLite после остановки, bytes | Read-only preflight | Первичная активация: index + tree |
| ------------ | --------------: | ----------------------------: | ------------------: | --------------------------------: |
| 1 000 notes  |       3 882 145 |                     5 472 256 |               90 ms |                            674 ms |
| 10 000 notes |      39 060 667 |                    53 903 360 |              888 ms |                          6 630 ms |

| Vault  | Поиск                | Cold, ms | Warm median / p95, ms | UI median, ms |
| ------ | -------------------- | -------: | --------------------: | ------------: |
| 1 000  | name `TitleNeedle`   |        8 |                 1 / 2 |           223 |
| 1 000  | content `bodyneedle` |       41 |               21 / 22 |           256 |
| 1 000  | tag `#perfshared`    |        5 |                 3 / 3 |           232 |
| 10 000 | name `TitleNeedle`   |       12 |                 3 / 4 |           230 |
| 10 000 | content `bodyneedle` |       45 |               24 / 24 |           258 |
| 10 000 | tag `#perfshared`    |       24 |               21 / 21 |           259 |

#### Проверки и ограничения PERF-01

- Limit 50 подтверждён в обоих runtime runs: реальных совпадений name/content/tag
  соответственно 100/142/1 000 и 1 000/1 428/10 000; каждый широкий запрос
  возвращает ровно 50 результатов правильного matchType. SQLite counts отдельно
  сверены read-only. Selective queries возвращают 1, отсутствующий/пустой/`#` — 0.
- Debounce: 11 input events с интервалом 30 ms дают ровно один `search_notes`;
  dispatch через 203/204 ms после последнего ввода. Очистка через 60 ms отменяет
  ещё не отправленный запрос: дополнительных IPC нет.
- Stale response: ответ первого настоящего IPC задержан драйвером на 800 ms;
  второй запрос успевает отрисоваться раньше. Поздний первый ответ не заменяет
  актуальные результаты. Это cancellation на уровне UI/request token;
  уже запущенный backend SQL **не прерывается**. Backend abort не заявляется.
- В каждом run зарегистрировано 111 search IPC; во время search phases нет
  `read_file`, `read_note`, `list_files`, `load_vault`, `load_active_vault`.
  Frontend read-all fan-out отсутствует. Проверка кода также подтверждает:
  поиск читает индексированные данные SQLite и ограничен `SEARCH_LIMIT = 50`.
- Runtime error/unhandled rejection в успешных runs нет. Сохранены и просмотрены
  native-window screenshots для обоих размеров. Численный SLO ранее не задан:
  PASS относится к smoke-сценариям и фиксации измерений, не к произвольному
  порогу и не к vaults с большими файлами или иной нагрузкой.
- Подготовительные ошибки драйвера (readonly Tauri invoke, Vite dependency cache)
  и fixture (H1 отличался от filename) сохранены отдельно в `harness-*`/логах.
  Они исправлены только в disposable test setup; их времена исключены.
  Перед успешным 1k run пробные индексы вынесены за пределы vault, не удалены.

#### Evidence, cleanup и проверки PERF-01

- Evidence root: `/private/tmp/amby-perf-ONvHfi`:
  `manifest.json`, `app-data/report-1000.json`, `app-data/report-10000.json`
  содержат размеры, сырые времена и IPC traces; `search-1000.png`,
  `search-10000.png`, `tauri-1000-pass-run.log`, `tauri-10000-pass-run.log`.
  Generator: `generate.mjs`; driver: `runtime/src/perf-01-driver.ts`.
- `after.json` и `integrity.json`: Markdown byte/hash/count unchanged,
  SQLite integrity `ok` для обоих vaults. SHA-256 настоящих пользовательских
  `settings.json` и `workspaces.json` совпадают с baseline; пользовательские
  vaults и credentials в сценариях не использовались. MANUAL-01 — MANUAL-07
  evidence не менялся. Test Tauri processes остановлены, listener 1420 отсутствует.
- В основном проекте этот пакет меняет только `AUDIT_ISSUES.md`; source changes,
  permissions, IPC types, migrations и новые runtime зависимости не добавлены.
  Изолированная тестовая копия и synthetic evidence оставлены в `/private/tmp`,
  в Git не добавлены; накопленные до старта PERF изменения сохранены.
- `npm run verify` 21:57–21:58 EEST: typecheck, ESLint, 341 Vitest / 57 files,
  Prettier, Knip, Rustfmt, strict Clippy, 147 Rust tests и повторный export test
  прошли. Общий exit 1 — только финальный `bindings:check` из-за уже существующего
  diff generated bindings (`restoreDeletedNote`, `NoteReadOutcome.source`).
  SHA-256 bindings остался `c7a1ae82235a41ed90a642eb3413cfe0df8414c25b18410096a3592942e66efa`;
  журнал проверки: `verify.log`. Этот gate не назван зелёным и diff не стёрт.
- `git diff --check` — PASS. `FINAL-02`, production build и решение о release
  support matrix в этом пакете не выполнялись.

### FOLLOWUP-01 — Rust dependency review

Статус: `SCHEDULED` на 24 ноября 2026 года.

1. Повторно выполнить `npm run audit` и `cargo tree --target all`.
2. Перепроверить owners/targets всех разрешённых RustSec advisories.
3. Обновить совместимые прямые зависимости без добавления второго Tauri dialog
   stack.
4. Новый advisory не добавлять в allowlist без owner, target, причины и следующей
   даты review.

### FINAL-01 — Финальный release gate

Статус: `AUTOMATED`; автоматический gate пройден, production release ожидает
ручную приёмку `FINAL-02`.

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

Фактический результат, повторно подтверждённый 25 августа 2026 года:

- `git diff --check` — без ошибок; рабочее дерево чисто до обновления этого
  журнала;
- `npm run verify` — 300 Vitest, 136 Rust tests, typecheck, ESLint, Prettier,
  Knip, Rustfmt, strict Clippy и `bindings:check` без diff;
- `npm run build`, `npm run audit` (npm: 0 vulnerabilities; RustSec scan) и
  `npm run tauri build` успешно завершены. Создан свежий
  `src-tauri/target/release/bundle/dmg/Amby_0.1.0_aarch64.dmg`;
- `dist/` и `src-tauri/target/` подтверждённо игнорируются Git; vault data,
  `.amby/`, credentials и recovery drafts не отслеживаются;
- эта строка фиксировала состояние 25 августа: тогда MANUAL-01 — MANUAL-07 были
  `PENDING`. На 26 августа `MANUAL-01`, `MANUAL-02` и `MANUAL-03` имеют `PASS`;
  `MANUAL-04` также завершён с `PASS`; доступная macOS/APFS часть `MANUAL-05`
  пройдена, пакет остаётся `PARTIAL` из-за отсутствующих Windows/exFAT/FAT/network
  сред; на 30 августа `MANUAL-06` также завершён с `PASS` на macOS.
  На 30 августа `MANUAL-07` также повторно пройден с `PASS`; затем `PERF-01`
  пройден на macOS/APFS для 1k/10k notes. Повторный финальный gate не выполнен.

### FINAL-02 — Ручная приёмка и решение о release

Статус: `RELEASE_BLOCKED` (31 августа 2026 года). Финальная проверка выполнена;
production release не одобрен. Полный отчёт: `docs/release-readiness.md`.
Windows-проверка по запросу пользователя выделена в
`docs/windows-release-checklist.md`; это перенос работы, не PASS и не исключение
Windows из заявленной поддержки.

Выполняется после прохождения доступных `MANUAL-01` — `MANUAL-07`:

1. Проверить таблицу ручной приёмки и evidence каждого выполненного шага.
2. Для production release потребовать `PASS` как минимум для data-safety пакетов
   `MANUAL-01`, `MANUAL-02`, `MANUAL-03` и `MANUAL-04`.
3. Потребовать `PASS` для доступных на целевой платформе частей `MANUAL-06` и
   `MANUAL-07`.
4. Для `MANUAL-05` отдельно перечислить реально проверенные платформы/filesystems.
   Непроверенную среду либо исключить из заявленной поддержки, либо оставить
   явным release blocker.
5. Решить, является ли `PERF-01` release blocker для текущего размера целевых
   vaults; решение и основание записать явно.
6. После последнего manual run повторить `git diff --check`, `npm run verify` и
   `npm run tauri build`.
7. Статус `RELEASE_READY` разрешён только при отсутствии `FAIL` и неоговорённых
   `BLOCKED` в поддерживаемой release matrix.
8. Если остаётся риск, установить `RELEASE_BLOCKED` или `BETA_READY`, перечислив
   конкретные ограничения.

#### Фактический итог FINAL-02 — 31.08.2026

- Среда: macOS 26.6.2 arm64, Apple M5, 16 GiB, APFS; `dev`, `9294076` +
  накопленные незакоммиченные manual fixes. Пользовательские vault/settings и
  credentials не использовались; собранное приложение не запускалось.
- Подробный журнал MANUAL-01—07 сверён с доступными файлами. Исторические PASS
  сохранены, но raw directories MANUAL-01/02 и отчёты `manual-03-retest.txt`,
  `manual-04-retest.txt`, `manual-05-macos.txt` сейчас отсутствуют. Причина не
  установлена; для production приёмки нужны архив или повтор соответствующих
  runtime проверок. Unit-тесты не выданы за новое ручное evidence.
- MANUAL-06/07 и PERF-01 имеют доступное итоговое evidence; выбранные отчёты,
  screenshots, JSON и logs скопированы из `/private/tmp` в постоянный локальный
  `.release-evidence/2026-08-31/`, исключённый из Git. `inventory.json` явно
  перечисляет отсутствующие файлы, а не подменяет их пересказом.
- PERF-01 не блокирует проверенный диапазон до 10k synthetic notes около 3,9 KB
  на macOS/APFS: warm median name/content/tag 3/24/21 ms. Это не общий SLO,
  не disk-cold результат и не подтверждение других платформ/больших документов.
- Generated bindings актуальны: Rust `restore_deleted_note`, соответствующий
  request type и `NoteReadOutcome.source` совпадают с экспортом; повторный export
  byte-exact. SHA-256 остаётся
  `c7a1ae82235a41ed90a642eb3413cfe0df8414c25b18410096a3592942e66efa`.
  Правильный diff не удалялся, check не ослаблялся, отдельного staging ради PASS нет.
- `npm run verify`: typecheck, lint, 341 Vitest/57 files, Prettier, Knip,
  Rustfmt, strict Clippy, 147 Rust tests и export PASS. Общий exit 1 — последний
  `git diff --exit-code` из-за накопленного generated bindings diff. Для чистого
  gate нужен согласованный checkpoint; коммит и push без подтверждения не сделаны.
- `npm run audit` — exit 0: npm 0 vulnerabilities; RustSec без новых блокирующих
  advisories, прежний warning `chacha20 0.10.1` yanked. Allowlist не расширялась.
- `npm run tauri build` — exit 0, включая frontend `npm run build`:
  production `.app` и `Amby_0.1.0_aarch64.dmg` созданы. DMG SHA-256:
  `24f2e6de4396987a5990cd2402ec7039cc72b05ca23b6a6a96e753ae391cda37`;
  сохранена копия `.release-evidence/2026-08-31/build/`. `hdiutil verify` — exit 0.
- Дополнительный distribution check: `codesign --verify --deep --strict` —
  exit 1 (`code has no resources but signature indicates they must be present`).
  Бинарник только ad-hoc/linker signed, TeamIdentifier/resource seal отсутствуют.
  Developer ID/notarization не подтверждены; успешная сборка не названа готовым
  подписанным релизом. Системная защита не отключалась.
- `git diff --check` — PASS. Артефакты сборки, локальный evidence, vault data,
  `.amby` и credentials не добавлены в Git; изменение `.gitignore` относится
  только к локальному release evidence. Runtime-код в FINAL-02 не менялся.

Блокеры: checkpoint с `verify` exit 0; восстановление/повтор недоступного
data-safety evidence; непроверенная Windows/exFAT/FAT/network матрица;
release signing. Заявленная поддержка платформ не менялась. `RELEASE_READY`
и `BETA_READY` не устанавливаются автоматически из успешного build.

## 9. Промпт для следующей работы

`MANUAL-01` — `MANUAL-04` завершены со статусом `PASS`; доступная macOS/APFS
часть `MANUAL-05` выполнена, а отсутствующие filesystem/platform пункты явно
записаны как `BLOCKED`. `MANUAL-06` и `MANUAL-07` пройдены на macOS.
Исторические FAIL MANUAL-07 устранены отдельными fix-пакетами и повторно
проверены. `PERF-01` завершён с `PASS` на macOS/APFS для 1k/10k notes;
его измерения и ограничения записаны выше. `FINAL-02` выполнен 31 августа
с решением `RELEASE_BLOCKED`; полный отчёт — `docs/release-readiness.md`.

Последовательность: `MANUAL-01` — `MANUAL-04` выполнены, доступная часть
`MANUAL-05` выполнена, `MANUAL-06` и `MANUAL-07` выполнены на macOS;
`PERF-01` и проверка `FINAL-02` выполнены. До зелёного `verify` требуется отдельно
разобраться с накопленным generated bindings diff и checkpoint рабочего дерева;
не удалять корректные bindings и не смешивать чужие изменения ради exit 0.

Windows-прогон выполняется отдельно по `docs/windows-release-checklist.md`.
Также нужны восстановление раннего raw evidence либо новые изолированные
data-safety прогоны и решение distribution signing.

Промпт для повторного решения после устранения блокеров:

```text
Прочитай AGENTS.md и AUDIT_ISSUES.md.

Повтори FINAL-02 по docs/release-readiness.md. Проверь evidence всех MANUAL-пакетов
и заполненный docs/windows-release-checklist.md, повтори финальные
автоматические gates и вынеси один статус: RELEASE_READY, BETA_READY или
RELEASE_BLOCKED.

Не отмечай непроверенную платформу или сценарий как PASS. Обнови AUDIT_ISSUES.md
фактическим решением и оставшимися ограничениями.
```
