# Пошаговый план исправления Amby Notes для Codex

Дата подготовки: 17 августа 2026 года.

Этот файл — исполнимый roadmap от текущего состояния проекта до закрытия найденного технического долга. Он предназначен для последовательной работы Codex небольшими проверяемыми изменениями.

## Как использовать этот roadmap

Для каждого нового задания пользователю достаточно написать:

> Выполни только WP-XX из Fixing.md. Следуй всем шагам, проверь результат и не переходи к следующему пакету.

Codex должен выполнять только один рабочий пакет за раз, если пользователь явно не попросил объединить несколько пакетов.

Общие правила для каждого пакета:

1. Полностью прочитать AGENTS.md и относящиеся к задаче документы из docs/.
2. Выполнить git status --short и сохранить все несвязанные изменения пользователя.
3. Работать от ветки dev. Не создавать ветку, коммит или PR без отдельной просьбы пользователя.
4. До изменения кода изучить существующие тесты и реальные вызовы изменяемого API.
5. Для исправления дефекта сначала добавить regression-тест, который воспроизводит проблему.
6. Не выполнять попутное форматирование или cleanup вне изменяемых файлов.
7. После изменения отформатировать только затронутые файлы.
8. При изменении Rust IPC-команд обязательно выполнить npm run rust:test и проверить обновление src/lib/bindings.ts.
9. Не редактировать src/lib/bindings.ts вручную.
10. Не переходить к следующему пакету при красных проверках.
11. В итоговом сообщении перечислить:
    - что изменено;
    - какие риски закрыты;
    - какие команды проверки выполнены;
    - какие проверки не запускались;
    - остались ли ручные сценарии.
12. Не коммитить vault contents, .amby metadata, secrets, recovery data, build artifacts и machine-specific файлы.

## Базовые архитектурные решения

Эти решения используются во всём плане. Если пользователь хочет другую модель, Codex должен остановиться до начала зависимого рабочего пакета и запросить направление.

### AD-1. Модель vault

Использовать один app-wide active vault. Дочерние note windows работают с тем же vault и не создают независимое backend-состояние. Переключение vault должно синхронно оповещать все окна.

### AD-2. HTML в Markdown

Сырой HTML сохраняется byte-exact в Markdown, но в read-only preview не исполняется. По умолчанию он показывается как inert text/placeholder. Не использовать выполнение или широкий sanitizer allowlist.

### AD-3. Источник истины

Markdown и attachments — источник истины. SQLite — rebuildable cache. Ошибка индекса после успешной filesystem operation не должна превращать успешное изменение пользовательского файла в ложный общий failure.

### AD-4. Recovery

Recovery drafts хранить в vault-local .amby/recovery/, исключённом из индекса. Ключом заметки служит стабильный note ID. Для standalone Canvas использовать стабильный recovery ID, производный от vault-relative path.

### AD-5. Секреты

API-ключи хранятся только в OS credential store. Renderer получает credential ID и masked state, но никогда не получает полный ключ после сохранения.

### AD-6. SVG

По умолчанию SVG импортируется как обычное вложение и не рендерится inline, пока не появится отдельная безопасная политика sanitization.

## Обязательные наборы проверок

### Fast frontend gate

- npm run typecheck
- npm run lint
- npm run test

### Rust gate

- npm run rust:fmt
- npm run rust:clippy
- npm run rust:test

### Full local gate

- npm run verify
- npm run format:check
- npm run rust:fmt
- npm run rust:clippy
- npm run rust:test
- npm run knip

### Дополнительный gate для IPC

- npm run rust:test
- git diff -- src/lib/bindings.ts
- npm run typecheck
- npm run test

### Дополнительный gate для security и dependencies

- npm audit --omit=dev
- Rust advisory scanner, добавленный в WP-30

## Master checklist

### Фаза 0. Зафиксировать baseline и восстановить CI

- [x] WP-00 — Зафиксировать baseline и карту рисков
- [x] WP-01 — Исправить target-specific Rust dependencies
- [x] WP-02 — Исправить branch filters и cross-platform CI
- [x] WP-03 — Закрыть HTML injection в transclusion preview

### Фаза 1. Создать настоящую backend security boundary

- [x] WP-04 — Сделать path confinement возвращающим безопасный путь
- [x] WP-05 — Создать единый VaultContext и транзакционную активацию
- [x] WP-06 — Удалить vaultPath из обычных IPC-команд
- [x] WP-07 — Сузить Tauri capabilities и удалить лишние plugins
- [x] WP-08 — Перевести frontend на generated IPC bindings

### Фаза 2. Исправить семантику filesystem и индекса

- [x] WP-09 — Ввести OperationOutcome и degraded index state
- [x] WP-10 — Сделать incremental index updates транзакционными
- [x] WP-11 — Усилить migration journal и recovery после partial migration
- [x] WP-12 — Заменить watcher grace window на fingerprint reconciliation

### Фаза 3. Унифицировать autosave, vault lifecycle и recovery

- [x] WP-13 — Реализовать независимый AutosaveCoordinator
- [x] WP-14 — Подключить Markdown autosave к coordinator
- [x] WP-15 — Подключить Canvas autosave к coordinator
- [x] WP-16 — Исправить vault switch и multi-window lifecycle
- [x] WP-17 — Реализовать Rust recovery journal и миграцию localStorage drafts
- [x] WP-18 — Закрыть lifecycle внешних конфликтов при rename/move/delete

### Фаза 4. Укрепить settings, AI и attachments

- [x] WP-19 — Перестать скрывать ошибки settings storage
- [x] WP-20 — Перенести AI credentials в OS credential store
- [x] WP-21 — Добавить AI URL policy, limits, timeout и cancellation
- [x] WP-22 — Ограничить и валидировать импорт attachments

### Фаза 5. Уменьшить архитектурный долг

- [x] WP-23 — Разделить storage.ts на port, adapters и repositories
- [x] WP-24 — Разделить Rust lib.rs на command-модули
- [x] WP-25 — Разделить vault_index.rs по обязанностям
- [x] WP-26 — Разделить panel-registry.tsx
- [x] WP-27 — Разделить workspace.tsx и document-editor.tsx
- [x] WP-28 — Разделить canvas-editor.tsx и sidebar-tree.tsx
- [x] WP-29 — Добавить общие TS/Rust compatibility fixtures

### Фаза 6. Закрыть тестовый и repository debt

- [x] WP-30 — Добавить UI, IPC и security integration tests
- [x] WP-31 — Очистить knip, repository artifacts и metadata
- [ ] WP-32 — Сделать полный quality gate обязательным
- [ ] WP-33 — Выполнить финальную cross-platform release verification

---

## WP-00 — Зафиксировать baseline и карту рисков

### Цель

Получить воспроизводимую исходную точку перед изменением security и persistence contracts.

### Зависимости

Нет.

### Шаги

1. Проверить текущую ветку и рабочее дерево:
   - git branch --show-current
   - git status --short
2. Проверить версии Node, npm и Rust.
3. Прочитать:
   - AGENTS.md;
   - docs/vault-format.md;
   - docs/markdown-compatibility.md;
   - docs/themes-and-localization.md;
   - docs/engineering.md, если файл существует.
4. Выполнить Full local gate.
5. Отдельно выполнить npm audit --omit=dev.
6. Зафиксировать в рабочем отчёте:
   - проходящие проверки;
   - известный ожидаемый failure npm run knip;
   - количество frontend и Rust tests;
   - отсутствие или наличие незакоммиченных пользовательских изменений.
7. Не менять код в этом пакете.

### Критерии готовности

- Baseline воспроизводим.
- Все исходные failures перечислены.
- Никаких файлов не изменено.
- Понятно, какие проверки должны оставаться зелёными в следующих пакетах.

### Рекомендуемая граница PR

PR не нужен. Это диагностический пакет.

---

## WP-01 — Исправить target-specific Rust dependencies

### Цель

Сделать unconditional Rust modules собираемыми на macOS, Linux и Windows.

### Зависимости

WP-00.

### Основные файлы

- src-tauri/Cargo.toml
- src-tauri/Cargo.lock

### Шаги

1. Подтвердить все unconditional imports crates:
   - rusqlite;
   - ulid;
   - walkdir;
   - notify;
   - specta;
   - specta-typescript;
   - tauri-specta.
2. Переместить эти crates из macOS target table в общую dependencies table.
3. Оставить под macOS только Objective-C/AppKit/Foundation crates.
4. Не менять версии crates без отдельной необходимости.
5. Выполнить cargo metadata и проверить, что target conditions корректны.
6. Выполнить Rust gate.
7. Выполнить npm run verify.
8. Если локально доступны дополнительные Rust targets, выполнить cargo check для них; иначе оставить проверку CI для WP-02.
9. Проверить, что Cargo.lock изменился только ожидаемо.

### Regression checks

- macOS cargo check остаётся зелёным.
- specta export test по-прежнему генерирует те же bindings, если IPC signatures не менялись.
- В Cargo.toml нет общих dependencies внутри target table.

### Критерии готовности

- Общие crates доступны на всех desktop targets.
- Rust gate проходит.
- Нет функциональных изменений приложения.

### Рекомендуемый commit

chore: fix cross-platform Rust dependencies

---

## WP-02 — Исправить branch filters и cross-platform CI

### Цель

Гарантировать, что проверки запускаются на реальных ветках и выявляют platform-specific failures.

### Зависимости

WP-01.

### Основные файлы

- .github/workflows/verify.yml
- package.json, только если нужны отдельные verify scripts

### Шаги

1. Заменить Main, Beta, Dev на main, beta, dev.
2. Сохранить pull_request и workflow_dispatch triggers.
3. Добавить Rust check/test matrix минимум для:
   - ubuntu-latest;
   - windows-latest;
   - macos-latest.
4. Не дублировать дорогую bundle-сборку в каждом matrix job:
   - matrix проверяет compile/test;
   - bundle jobs проверяют release packaging отдельно.
5. Оставить permissions минимальными: contents read.
6. Сохранить concurrency cancellation.
7. Сделать formatting job блокирующим, поскольку текущий baseline проходит.
8. Пока не добавлять npm run knip в обязательный gate — это будет сделано после WP-31.
9. Добавить проверку generated bindings diff после Rust tests.
10. Проверить YAML syntax локальным доступным инструментом или внимательным parse.
11. Выполнить Full local gate.

### Критерии готовности

- Push в dev, beta и main запускает workflow.
- PR проверяется на трёх OS.
- Formatting failure блокирует merge.
- Generated bindings drift блокирует merge.
- Windows bundle job не маскирует matrix failures.

### Рекомендуемый commit

ci: verify real branches and desktop targets

---

## WP-03 — Закрыть HTML injection в transclusion preview

### Цель

Не исполнять сырой HTML из пользовательского Markdown при preview вложенной заметки.

### Зависимости

WP-00. Можно выполнять после WP-02.

### Основные файлы

- src/components/workspace/tiptap/markdown.ts
- src/components/workspace/tiptap/transclusion-view.tsx
- новые colocated tests/fixtures
- docs/markdown-compatibility.md, если меняется documented preview behavior

### Шаги

1. Отделить byte-exact parser/serializer Live Preview от read-only HTML renderer.
2. Не менять tokenizer, необходимый для round-trip сохранения opaque HTML.
3. Создать отдельный safe read-only renderer с html disabled.
4. Если raw HTML должен быть виден, выводить его как inert text/placeholder через React escaping.
5. Не передавать результат общего html-enabled tokenizer в dangerouslySetInnerHTML.
6. Если dangerouslySetInnerHTML остаётся для безопасного Markdown HTML:
   - ограничить его отдельной функцией;
   - вернуть branded type;
   - документировать, почему источник безопасен.
7. Добавить regression fixtures:
   - script element;
   - image with onerror;
   - iframe;
   - javascript link;
   - style injection;
   - SVG payload;
   - обычный raw HTML, который должен сохраниться в source без выполнения.
8. Проверить, что wiki links, headings, lists, code blocks и transclusion loading/error UI не сломались.
9. Выполнить Fast frontend gate и format check.
10. Ручной сценарий в npm run dev:
    - открыть заметку с вредоносным HTML;
    - открыть её как transclusion;
    - убедиться, что DOM payload не исполняется.

### Критерии готовности

- Пользовательский raw HTML сохраняется byte-exact.
- Preview не создаёт активные scriptable elements.
- Security regression tests проходят.
- Обычный Markdown preview визуально не деградировал.

### Рекомендуемый commit

fix: render transclusions without active raw HTML

---

## WP-04 — Сделать path confinement возвращающим безопасный путь

### Цель

Убрать использование исходной непроверенной строки после canonical path validation.

### Зависимости

WP-01.

### Основные файлы

- src-tauri/src/paths.rs
- команды в src-tauri/src/lib.rs
- Rust tests рядом с paths.rs

### Шаги

1. Изменить guard и guard_in так, чтобы они возвращали Result PathBuf.
2. Обновить каждый caller: filesystem operation должна использовать возвращённый PathBuf.
3. Не выполнять повторный PathBuf::from исходного renderer argument после проверки.
4. Для create operations сохранить логику longest existing ancestor.
5. Добавить тесты:
   - existing file внутри vault;
   - missing nested destination внутри vault;
   - absolute path снаружи;
   - dot-dot traversal;
   - symlink внутри vault наружу;
   - symlinked parent для нового файла;
   - путь с похожим строковым prefix, но не являющийся child.
6. Отдельно исследовать platform-safe open-at/confined directory API.
7. Если полноценный handle-based confinement нельзя внедрить без большого dependency change:
   - завершить этот пакет возвратом validated PathBuf;
   - создать явный follow-up note для handle-based hardening;
   - не заявлять, что TOCTOU полностью устранён.
8. Выполнить Rust gate.

### Критерии готовности

- Ни одна затронутая команда не использует raw path после guard.
- Escape через обычный symlink отклоняется тестом.
- Поведение создания нового файла внутри vault сохранено.

### Рекомендуемый commit

fix: use confined paths for vault filesystem access

---

## WP-05 — Создать единый VaultContext и транзакционную активацию

### Цель

Хранить canonical root, SQLite connection и generation как единое согласованное backend-состояние.

### Зависимости

WP-04.

### Основные файлы

- новый src-tauri/src/vault/context.rs или эквивалент
- src-tauri/src/lib.rs
- src-tauri/src/paths.rs
- src-tauri/src/vault_index.rs
- Rust tests

### Шаги

1. Спроектировать ActiveVault:
   - canonical root;
   - SQLite connection;
   - generation ID;
   - optional watcher identity;
   - состояние index health.
2. Поместить ActiveVault в один managed VaultContext.
3. Не хранить root и DB connection в независимых mutex, которые могут рассинхронизироваться.
4. Реализовать prepare activation:
   - canonicalize candidate;
   - убедиться, что это directory;
   - открыть новую SQLite connection;
   - выполнить schema/init checks;
   - выполнить обязательный preflight без изменения active state.
5. Реализовать commit activation:
   - атомарно заменить старый context новым;
   - увеличить generation;
   - только после успешного commit обновить scopes и watcher.
6. При ошибке подготовки оставить старый active vault полностью рабочим.
7. Определить один privileged activation path:
   - native folder picker для нового vault;
   - backend-owned reopen flow для последнего vault.
8. Убрать side effect активации из apply_id_migration.
9. Добавить тесты:
   - ошибка открытия новой БД не меняет старый root;
   - ошибка scope update не оставляет half-active context;
   - generation меняется только после успеха;
   - concurrent commands получают согласованный root и connection.
10. Выполнить Rust gate и IPC gate.

### Критерии готовности

- Невозможно получить новый root со старой DB connection.
- Failed switch сохраняет предыдущий рабочий vault.
- Generation доступен для frontend lifecycle в WP-16.

### Рекомендуемый commit

refactor: make vault activation transactional

---

## WP-06 — Удалить vaultPath из обычных IPC-команд

### Цель

Не позволять renderer задавать filesystem root для каждой отдельной операции.

### Зависимости

WP-05.

### Основные файлы

- src-tauri/src/lib.rs и новые command modules
- src/lib/storage.ts
- src/lib/ai.ts, если затрагивается общий invoke layer
- src/lib/bindings.ts, только generated
- workspace hooks и tests

### Шаги

1. Составить полный список commands, принимающих vault_path.
2. Разделить их на:
   - activation/preflight commands, которым candidate root действительно нужен;
   - обычные commands, которые должны использовать active VaultContext.
3. Удалить vault_path из signatures обычных commands:
   - list/read/write note;
   - tags/search/graph;
   - create/rename/move/delete;
   - layers/canvas;
   - properties;
   - watcher start;
   - attachment import destination.
4. Внутри command получать active context snapshot/generation.
5. Проверять, что note ID/path принадлежит active vault.
6. Обновить frontend calls.
7. Выполнить npm run rust:test для regenerated bindings.
8. Не редактировать bindings вручную.
9. Добавить IPC tests:
   - command до открытия vault возвращает typed error;
   - operation использует active root;
   - renderer не может передать альтернативный root;
   - stale generation после vault switch отклоняется там, где это необходимо.
10. Выполнить IPC gate и Full local gate.

### Критерии готовности

- Только activation flow принимает candidate vault path.
- Обычные commands не доверяют renderer root.
- Frontend компилируется с новыми signatures.
- Generated bindings актуальны.

### Рекомендуемый commit

refactor: scope IPC commands to the active vault

---

## WP-07 — Сузить Tauri capabilities и удалить лишние plugins

### Цель

Оставить renderer только минимально необходимые Tauri permissions.

### Зависимости

WP-06.

### Основные файлы

- src-tauri/capabilities/default.json
- src-tauri/Cargo.toml
- src-tauri/src/lib.rs
- package.json, если есть frontend plugin packages
- tauri configuration files

### Шаги

1. Выполнить rg по всем frontend imports и invoke plugin commands.
2. Подтвердить фактическое использование:
   - dialog message/confirm;
   - webview/window APIs;
   - asset protocol.
3. Проверить, используется ли frontend JS API opener.
4. Проверить, используется ли frontend JS API fs.
5. Если нет:
   - удалить opener permissions и plugin dependency/init;
   - удалить fs permissions и plugin dependency/init;
   - убрать fs_scope activation code.
6. Оставить asset protocol scope отдельно.
7. Сузить dialog permissions до реально используемых операций.
8. Проверить permissions для note-* windows отдельно; не давать им больше main window.
9. Выполнить Rust gate.
10. Выполнить npm run tauri build на текущей OS.
11. Ручные сценарии:
    - native confirm;
    - native folder picker;
    - import/export preset;
    - image rendering через asset protocol;
    - open in explorer через custom command;
    - создание note window.

### Критерии готовности

- Нет неиспользуемых broad permissions.
- Основные desktop сценарии работают.
- Asset loading не требует broad filesystem scope.

### Рекомендуемый commit

security: narrow Tauri desktop capabilities

---

## WP-08 — Перевести frontend на generated IPC bindings

### Цель

Сделать Specta bindings реальным compile-time контрактом, а не неиспользуемым generated artifact.

### Зависимости

WP-06.

### Основные файлы

- src/lib/bindings.ts
- новый src/lib/storage/ipc-result.ts
- desktop storage adapter или временный src/lib/desktop-ipc.ts
- src/lib/storage.ts
- src/lib/ai.ts

### Шаги

1. Изучить generated Result shape и error behavior.
2. Создать единый helper unwrapCommandResult.
3. Начать миграцию с read-only commands.
4. Затем мигрировать note writes и mutations.
5. Затем history, trash, properties, attachments, settings и AI.
6. Оставить прямой invoke только для plugin commands, которых нет в generated app bindings.
7. Удалить ручные IPC DTO, совпадающие с generated types.
8. Перенести TreeItem из sidebar-tree.tsx в domain/storage type boundary.
9. В Rust заменить строковые enum-like поля настоящими serde/specta enums там, где это не ломает compatibility.
10. Выполнить IPC gate после каждой группы commands.
11. Выполнить rg и убедиться, что строковые app invoke почти полностью исчезли.
12. Выполнить Full local gate.

### Критерии готовности

- App commands вызываются через generated commands.
- Ручные types не дублируют Rust DTO.
- Изменение Rust signature вызывает TypeScript compile failure до runtime.
- Прямые invokes остались только для обоснованных plugin commands.

### Рекомендуемый commit

refactor: use generated IPC bindings in the frontend

---

## WP-09 — Ввести OperationOutcome и degraded index state

### Цель

Корректно сообщать об успешной filesystem operation даже при сбое rebuildable SQLite cache.

### Зависимости

WP-06 и WP-08.

### Основные файлы

- src-tauri/src/model.rs
- mutation/note commands
- src-tauri/src/vault_index.rs
- frontend mutation handlers
- localization resources
- tests

### Шаги

1. Добавить typed index state:
   - healthy;
   - degraded;
   - rebuild_required.
2. Добавить OperationWarning без raw paths/secrets.
3. Создать generic или конкретный OperationOutcome:
   - authoritative result;
   - index status;
   - warnings.
4. Для write_note определить результат, который различает:
   - filesystem save failed;
   - filesystem save succeeded, index updated;
   - filesystem save succeeded, index degraded.
5. Для create/rename/move/delete/restore применить ту же семантику.
6. После index failure:
   - сохранить filesystem result;
   - пометить context rebuild_required;
   - запланировать или предложить rebuild;
   - не позволять frontend слепо повторить destructive mutation.
7. Frontend должен:
   - применить filesystem mutation result;
   - обновить UI/tree через fallback rescan;
   - показать локализованное предупреждение о rebuild.
8. Добавить failure injection в Rust tests после filesystem commit, до index commit.
9. Проверить retry semantics.
10. Обновить generated bindings и выполнить IPC gate.

### Критерии готовности

- Успешное изменение файла не представляется пользователю как полностью неуспешное из-за cache failure.
- Index failure видим и восстанавливаем.
- Повтор destructive action не требуется.
- Markdown остаётся источником истины.

### Рекомендуемый commit

fix: separate filesystem success from index health

---

## WP-10 — Сделать incremental index updates транзакционными

### Цель

Не оставлять notes, tags и links в частично обновлённом состоянии.

### Зависимости

WP-09.

### Основные файлы

- src-tauri/src/vault_index.rs или будущие index modules
- Rust tests

### Шаги

1. Найти все multi-statement index updates.
2. Обернуть upsert note, tag replacement, link replacement и link resolution в одну SQLite transaction.
3. Аналогично проверить path changes и delete paths.
4. Не держать DB transaction во время медленного filesystem I/O.
5. Разделить этапы:
   - подготовить данные из файла;
   - открыть transaction;
   - применить DB changes;
   - commit.
6. Добавить failure injection между SQL stages.
7. Проверить rollback:
   - note row не обновлён частично;
   - старые tags/links остаются согласованными;
   - rebuild по-прежнему восстанавливает cache.
8. Выполнить Rust gate.

### Критерии готовности

- Incremental update либо полностью committed, либо полностью rolled back.
- Filesystem write не откатывается из-за derived cache.
- Failure tests подтверждают целостность.

### Рекомендуемый commit

fix: transact incremental vault index updates

---

## WP-11 — Усилить migration journal и partial recovery

### Цель

Сделать ID migration однозначно восстанавливаемой после crash или ошибки посередине.

### Зависимости

WP-05 и WP-09.

### Основные файлы

- migration logic из vault_index.rs
- docs/vault-format.md
- Rust tests

### Шаги

1. Перед первой мутацией создать journal со status planned/in_progress.
2. Записать:
   - migration version;
   - created timestamp;
   - backup root;
   - полный план файлов;
   - progress по каждому файлу;
   - итоговый status.
3. fsync journal и parent directory в критических точках.
4. Для каждого файла:
   - создать no-replace backup;
   - записать progress backup_created;
   - атомарно изменить note;
   - записать progress applied.
5. После успеха записать completed.
6. При следующем запуске обнаруживать unfinished journal и предлагать:
   - resume;
   - rollback;
   - inspect only.
7. Не менять user-managed или duplicate IDs.
8. Добавить crash/failure tests на каждом этапе.
9. Документировать rollback.
10. Выполнить Rust gate.

### Критерии готовности

- Любая partial migration обнаруживается.
- Есть проверяемый backup и понятный outcome.
- Resume/rollback идемпотентны.
- User-managed frontmatter не переписывается.

### Рекомендуемый commit

fix: journal and recover partial ID migrations

---

## WP-12 — Заменить watcher grace window на fingerprint reconciliation

### Цель

Не пропускать реальные внешние изменения сразу после autosave.

### Зависимости

WP-05 и WP-10.

### Основные файлы

- watcher state/code
- write commands
- frontend watcher integration
- Rust tests

### Шаги

1. Ввести SelfWriteRecord:
   - path;
   - operation kind;
   - expected size;
   - expected content hash для файлов;
   - timestamp/expiry;
   - generation.
2. Регистрировать record после известного результата атомарной записи.
3. При watcher event:
   - убедиться, что generation совпадает;
   - получить fingerprint текущего файла;
   - подавить event только при точном совпадении собственной записи.
4. Если fingerprint отличается, немедленно эмитить external-change event.
5. Для rename/delete использовать operation-aware reconciliation.
6. После expiry запускать контрольную сверку для неоднозначных directory events.
7. Не подавлять sibling change только потому, что отмечен parent directory.
8. Добавить deterministic tests:
   - own write suppressed;
   - external write в пределах двух секунд emitted;
   - sibling change emitted;
   - atomic rename handled;
   - old generation ignored.
9. Выполнить Rust gate и ручной Tauri test с внешним редактором.

### Критерии готовности

- Временное окно само по себе не скрывает изменение.
- Свои writes не создают ложные conflicts.
- Sibling changes не подавляются.

### Рекомендуемый commit

fix: reconcile watcher events by write fingerprint

---

## WP-13 — Реализовать независимый AutosaveCoordinator

### Цель

Создать тестируемую serial autosave state machine вне React-компонентов.

### Зависимости

WP-09.

### Основные файлы

- новый src/components/workspace/autosave/autosave-coordinator.ts
- colocated tests
- существующий per-key-queue.ts, если его можно переиспользовать

### Шаги

1. Определить AutosaveKey:
   - vault generation;
   - document kind;
   - stable document ID.
2. Определить version counter для каждого buffer.
3. Реализовать:
   - schedule;
   - enqueue immediate;
   - flush key;
   - flush all;
   - cancel generation;
   - remap key;
   - report save success/failure;
   - inspect pending state.
4. Гарантировать:
   - writes одного key последовательны;
   - разные keys не блокируют друг друга;
   - старая completion не очищает новый dirty state;
   - stale generation не записывается;
   - flush ждёт timer и queued write.
5. Coordinator не должен импортировать React, Zustand или Tauri.
6. Добавить unit tests с controllable promises/fake timers.
7. Выполнить targeted Vitest и Fast frontend gate.

### Критерии готовности

- State machine покрыта тестами.
- Coordinator можно использовать для Markdown и Canvas.
- Нет filesystem side effects внутри unit tests.

### Рекомендуемый commit

feat: add a versioned autosave coordinator

---

## WP-14 — Подключить Markdown autosave к coordinator

### Цель

Заменить локальные timers/queue в use-file-actions.ts единым coordinator.

### Зависимости

WP-13 и WP-09.

### Основные файлы

- use-file-actions.ts
- use-doc-store.ts
- workspace orchestration
- autosave coordinator
- tests

### Шаги

1. Вынести save transport callback из use-file-actions.
2. При content change:
   - обновить buffer;
   - увеличить version;
   - записать recovery draft;
   - schedule через coordinator.
3. После save:
   - применить OperationOutcome;
   - очистить dirty только для той же version;
   - удалить recovery только после filesystem success.
4. При index degraded не оставлять документ ложно unsaved, но показать warning.
5. При external conflict приостановить write конкретного key.
6. При resolution конфликта явно resume/replace/discard.
7. Удалить старые saveTimersRef и локальный queue.
8. Добавить tests:
   - rapid edits;
   - failed save;
   - stale completion;
   - conflict pause;
   - retry;
   - rename key.
9. Выполнить Fast frontend gate.

### Критерии готовности

- Нет старой параллельной Markdown autosave системы.
- Dirty/recovery state соответствует filesystem outcome.
- Stale save не очищает новый buffer.

### Рекомендуемый commit

refactor: route note autosaves through the coordinator

---

## WP-15 — Подключить Canvas autosave к coordinator

### Цель

Дать Canvas те же гарантии serial save и recovery, что и Markdown.

### Зависимости

WP-13.

### Основные файлы

- workspace.tsx
- canvas-editor.tsx
- autosave coordinator
- canvas format tests

### Шаги

1. Удалить canvasSaveTimers.
2. Определить стабильный Canvas AutosaveKey.
3. Route каждое изменение JSON через coordinator.
4. Валидировать/serialize Canvas до schedule.
5. Сохранять recovery draft до filesystem save.
6. Очищать recovery только после save success.
7. Поддержать remap key при attach/move/rename.
8. Добавить tests:
   - overlapping saves;
   - close during pending save;
   - move/rename;
   - invalid Canvas JSON;
   - recovery restore.
9. Выполнить Fast frontend gate и targeted manual Canvas test.

### Критерии готовности

- Canvas не имеет отдельной timer-only системы.
- Старый save не может перезаписать новый.
- Crash recovery работает.

### Рекомендуемый commit

refactor: give Canvas coordinated autosave and recovery

---

## WP-16 — Исправить vault switch и multi-window lifecycle

### Цель

Не смешивать документы, timers и backend context разных vault generations.

### Зависимости

WP-05, WP-14 и WP-15.

### Основные файлы

- use-vault-data.ts
- workspace.tsx
- Zustand stores
- Tauri window event integration
- tests

### Шаги

1. Перед switch:
   - заблокировать повторный switch;
   - flush current generation;
   - если flush неуспешен, сохранить recovery и запросить решение пользователя.
2. Начать backend activation.
3. Только после success:
   - отменить old generation;
   - очистить docs, canvases, conflicts, tabs и transient state;
   - hydrate новую session;
   - запустить watcher новой generation.
4. Защитить async load через request ID/AbortController.
5. Результат старого load не должен заменить новый vault.
6. Broadcast active vault change всем note windows.
7. В note windows:
   - использовать app-wide vault;
   - закрывать или remap tabs, которых нет в новом vault;
   - не позволять независимую скрытую activation.
8. Обработать Tauri close-request:
   - prevent close;
   - flush;
   - сохранить recovery при failure;
   - затем закрыть.
9. Добавить tests с fake activation/save promises.
10. Выполнить manual multi-window Tauri scenarios.

### Критерии готовности

- После switch нет old openDocs или old Canvas buffers.
- Pending writes старой generation не достигают нового context.
- Failed activation оставляет старый vault рабочим.
- Все окна согласованы.

### Рекомендуемый commit

fix: make vault switching generation-safe

---

## WP-17 — Реализовать Rust recovery journal и миграцию localStorage drafts

### Цель

Убрать критичные recovery contents из ненадёжного WebView localStorage.

### Зависимости

WP-14, WP-15 и WP-16.

### Основные файлы

- новый src-tauri/src/recovery.rs
- IPC commands/bindings
- recovery-drafts.ts
- docs/vault-format.md
- Rust и frontend tests

### Шаги

1. Определить versioned RecoveryEntry:
   - version;
   - vault generation/id;
   - document kind;
   - stable ID;
   - current path hint;
   - saved timestamp;
   - content bytes/text;
   - content hash.
2. Хранить entries под .amby/recovery/.
3. Использовать atomic no-truncate writes.
4. Добавить commands:
   - save recovery;
   - read recovery;
   - delete recovery;
   - list recovery;
   - sweep expired recovery.
5. Ограничить:
   - максимальный размер entry;
   - общий размер;
   - количество entries;
   - TTL.
6. Реализовать startup sweep.
7. При первом запуске новой версии:
   - прочитать legacy localStorage drafts;
   - перенести доступные entries;
   - проверить запись;
   - только затем удалить legacy value.
8. При rename/move обновлять path hint, но stable ID оставлять тем же.
9. При delete сохранять или удалять draft согласно подтверждённой пользовательской операции.
10. Добавить corruption/quota/failure tests.
11. Обновить bindings и выполнить IPC gate.

### Критерии готовности

- Recovery работает после renderer crash.
- Legacy drafts мигрируются без потери.
- Expired/orphan entries очищаются.
- Ограничения защищают disk usage.

### Рекомендуемый commit

feat: persist editor recovery drafts in the vault journal

---

## WP-18 — Закрыть lifecycle внешних конфликтов при rename/move/delete

### Цель

Сохранить корректный conflict state при filesystem mutations.

### Зависимости

WP-14, WP-16 и WP-17.

### Основные файлы

- use-doc-store.ts
- workspace-mutations.ts
- external-conflict-dialog.tsx
- use-file-actions.ts
- tests

### Шаги

1. При mutation remap:
   - remap conflict path;
   - сохранить local/external buffers;
   - remap recovery hint;
   - remap autosave key.
2. При delete dirty/conflicted document:
   - не закрывать молча;
   - запросить keep recovery/discard/cancel.
3. При external delete:
   - не позволять autosave автоматически воссоздать файл без решения пользователя.
4. При save conflict copy использовать текущий confined path.
5. Добавить tests:
   - conflict + rename;
   - conflict + folder move;
   - conflict + delete;
   - external delete + pending timer;
   - restore from trash.
6. Выполнить Fast frontend gate.

### Критерии готовности

- Conflict dialog всегда ссылается на актуальный path.
- Нет молчаливого overwrite/recreate.
- Recovery state не теряется.

### Рекомендуемый commit

fix: preserve conflict state across filesystem mutations

---

## WP-19 — Перестать скрывать ошибки settings storage

### Цель

Не показывать пользователю ложный успех при невозможности сохранить settings/session.

### Зависимости

WP-08.

### Основные файлы

- app-config.ts
- storage settings functions
- use-settings-store.ts
- localization resources
- tests

### Шаги

1. Ввести typed SettingsReadResult:
   - found;
   - missing;
   - corrupt;
   - unavailable.
2. Не превращать corrupt и unavailable в одинаковый fallback.
3. Перед восстановлением defaults сохранить recoverable copy повреждённого JSON.
4. Добавить schemaVersion в global settings, workspace config и session.
5. Реализовать runtime validation и explicit migrations.
6. Убрать пустые catch из saveGlobalJSON/saveVaultJSON/delete.
7. Propagate failure до store/UI.
8. Добавить единый non-blocking notification и safe logger event.
9. Не логировать paths, API keys или note contents.
10. Добавить tests:
    - missing file;
    - corrupt JSON;
    - write failure;
    - migration;
    - concurrent patches;
    - failed session save.
11. Выполнить Fast frontend gate и Rust tests для app_data.

### Критерии готовности

- UI знает, сохранена ли настройка.
- Corrupt file не перезаписывается без recovery copy.
- Concurrent settings writes сериализованы.

### Рекомендуемый commit

fix: surface and recover settings persistence failures

---

## WP-20 — Перенести AI credentials в OS credential store

### Цель

Удалить plaintext API keys из settings.json и renderer state.

### Зависимости

WP-19 и WP-08.

### Основные файлы

- src-tauri/src/ai.rs
- новый credentials module
- app-config.ts
- models-manager.tsx
- generated bindings
- tests и docs

### Шаги

1. Проверить актуальные официальные варианты OS credential storage для macOS, Windows и Linux.
2. Выбрать abstraction, не допускающий silent plaintext fallback.
3. Создать backend commands:
   - store credential;
   - replace credential;
   - delete credential;
   - inspect presence/masked metadata.
4. AiModel должен хранить credentialId, а не apiKey.
5. ai_chat принимает model/provider configuration без secret.
6. Rust загружает secret непосредственно перед request.
7. Реализовать migration:
   - обнаружить legacy plaintext key;
   - сохранить в credential store;
   - проверить read/use;
   - записать credentialId;
   - атомарно удалить plaintext key.
8. Если keychain unavailable:
   - сохранить старый key до решения пользователя;
   - не потерять credential;
   - не продолжать silent insecure storage.
9. Очистить key из React state и logs.
10. Добавить tests с mock credential store.
11. Обновить bindings и выполнить IPC gate.
12. Ручные tests на каждой поддерживаемой OS выполнять в WP-33.

### Критерии готовности

- Новый settings.json не содержит API keys.
- Renderer не получает полный сохранённый key.
- Migration не удаляет key до подтверждённого успеха.
- Delete model удаляет или предлагает удалить credential.

### Рекомендуемый commit

security: store AI credentials outside renderer settings

---

## WP-21 — Добавить AI URL policy, limits, timeout и cancellation

### Цель

Снизить SSRF, resource exhaustion и hanging request risks.

### Зависимости

WP-20.

### Основные файлы

- src-tauri/src/ai.rs
- новый ai/client.rs и ai/policy.rs при необходимости
- src/lib/ai.ts
- AI panel
- tests и localization

### Шаги

1. Создать один reusable reqwest Client.
2. Настроить:
   - connect timeout;
   - overall request timeout;
   - ограниченный redirect policy;
   - user agent;
   - bounded response consumption.
3. Парсить URL типом URL, не конкатенацией unchecked strings.
4. Реализовать policy:
   - https для remote keyed providers;
   - http loopback разрешён;
   - private LAN требует явного opt-in;
   - metadata/link-local endpoints запрещены;
   - unsupported schemes запрещены.
5. Проверять redirect destination той же policy.
6. Ограничить backend:
   - messages count;
   - total prompt bytes;
   - system prompt bytes;
   - max tokens range;
   - stream bytes;
   - non-stream response bytes.
7. Ввести stream registry и cancel_ai_request command.
8. UI отменяет request при:
   - cancel button;
   - panel unmount;
   - model change;
   - vault switch.
9. Не включать raw provider response body целиком в user error.
10. Добавить tests URL policy и fake HTTP server tests.
11. Выполнить IPC gate и Full local gate.

### Критерии готовности

- Hanging request имеет timeout/cancel.
- Response не может расти без ограничения.
- Key не отправляется на endpoint, нарушающий policy.
- Local Ollama/LM Studio сценарии сохранены.

### Рекомендуемый commit

security: constrain and cancel AI provider requests

---

## WP-22 — Ограничить и валидировать импорт attachments

### Цель

Не допускать path manipulation, memory exhaustion и unsafe inline media.

### Зависимости

WP-04, WP-06 и WP-07.

### Основные файлы

- attachment/import commands
- bundle.rs helpers
- media-drop.ts
- canvas-editor.tsx
- asset resolver/rendering
- tests и docs/vault-format.md

### Шаги

1. Определить продуктовые limits:
   - максимальный imported file size;
   - максимальный pasted bytes payload;
   - допустимая длина extension/name.
2. Валидировать extension только как короткий ASCII token.
3. Не строить destination из unchecked filename components.
4. Повторно confine destination перед create.
5. Для disk import:
   - проверить metadata size;
   - streaming copy в temporary file;
   - fsync;
   - atomic publish no-replace.
6. Для pasted bytes отклонять payload сверх limit до копирования.
7. Определять image kind по signature/MIME sniffing.
8. SVG по AD-6 импортировать как attachment, не inline image.
9. Не читать arbitrary source path, если он не получен через native picker/drag grant.
10. Добавить tests:
    - slash/backslash/dot-dot extension;
    - huge declared file;
    - truncated copy;
    - collision;
    - wrong extension;
    - SVG behavior;
    - source outside allowed grant.
11. Выполнить Rust gate, Fast frontend gate и manual import scenarios.

### Критерии готовности

- Import не требует загрузки большого disk file целиком в память.
- Extension не влияет на directory traversal.
- Oversized payload отклоняется понятной ошибкой.
- SVG не становится active inline content.

### Рекомендуемый commit

security: bound and validate attachment imports

---

## WP-23 — Разделить storage.ts на port, adapters и repositories

### Цель

Убрать файл с множеством обязанностей и выбрать desktop/web implementation один раз.

### Зависимости

WP-08, WP-09, WP-17, WP-19 и WP-22.

### Целевая структура

```text
src/lib/storage/
  port.ts
  desktop-adapter.ts
  web-adapter.ts
  ipc-result.ts
  notes-repository.ts
  mutations-repository.ts
  assets-repository.ts
  history-repository.ts
  settings-repository.ts
  index.ts
```

### Шаги

1. Зафиксировать public API storage.ts contract tests.
2. Вынести generated desktop calls без изменения поведения.
3. Вынести web localStorage implementation.
4. Создать StoragePort с минимальными domain operations.
5. Выбирать adapter один раз при bootstrap.
6. Разделить repositories по доменам.
7. Перенести domain DTO из UI components.
8. Удалить циклические направления import, где lib импортирует component.
9. Не менять persistence semantics в том же PR, что и перенос.
10. Сохранить временный compatibility re-export из старого storage.ts.
11. Перевести consumers группами.
12. После миграции удалить compatibility facade, если он больше не нужен.
13. Добавить contract tests, запускаемые против web adapter и mocked desktop adapter.
14. Выполнить Full local gate.

### Критерии готовности

- Нет 50 отдельных isTauri branches по public functions.
- lib layer не импортирует workspace UI.
- Desktop adapter использует generated bindings.
- Web adapter проверяется тем же domain contract.

### Рекомендуемая разбивка

- PR A: port и desktop adapter.
- PR B: web adapter.
- PR C: repositories и consumer migration.
- PR D: удалить compatibility debt.

---

## WP-24 — Разделить Rust lib.rs на command-модули

### Цель

Оставить в lib.rs только application composition.

### Зависимости

WP-06, WP-07, WP-09, WP-17 и WP-22.

### Целевая структура

```text
src-tauri/src/
  commands/
    mod.rs
    vault.rs
    notes.rs
    mutations.rs
    assets.rs
    history.rs
    settings.rs
  state.rs
  watcher.rs
  lib.rs
```

### Шаги

1. До переноса зафиксировать command registration/export tests.
2. Вынести WatcherState и watcher helpers.
3. Вынести VaultContext/AppState.
4. Перенести read-only commands.
5. Перенести note write commands.
6. Перенести mutations.
7. Перенести assets/history/settings.
8. Сохранить command names и Specta export.
9. Не менять signatures или behavior в этом пакете.
10. Оставить в lib.rs:
    - mod declarations;
    - logging/startup;
    - Tauri builder;
    - plugins;
    - managed state;
    - command registration;
    - run.
11. Выполнять Rust gate после каждого перенесённого блока.
12. Финально выполнить generated bindings diff.

### Критерии готовности

- lib.rs является composition root.
- Commands сгруппированы по доменам.
- Generated bindings не меняются без причины.
- Все Rust tests проходят.

### Рекомендуемая разбивка

Несколько маленьких refactor PR, по одному command domain.

---

## WP-25 — Разделить vault_index.rs по обязанностям

### Цель

Разделить schema, scan, sync, queries и refactor logic без изменения формата vault.

### Зависимости

WP-10, WP-11, WP-12 и WP-24.

### Целевая структура

```text
src-tauri/src/index/
  mod.rs
  schema.rs
  connection.rs
  sync.rs
  note_index.rs
  query.rs
  tags.rs
  links.rs
  refactor.rs

src-tauri/src/vault/
  mod.rs
  scan.rs
  tree.rs
  migration.rs
```

### Шаги

1. Создать characterization tests для public functions.
2. Вынести чистые types/models.
3. Вынести schema и connection.
4. Вынести scan и exclusion policy.
5. Вынести tree builder.
6. Вынести incremental note index.
7. Вынести tags/search/query.
8. Вынести link resolution/refactor.
9. Вынести migration.
10. Сократить public surface через pub(crate).
11. Удалить дублирующиеся file_name/is_markdown/is_bundle helpers.
12. Не менять SQL schema и filesystem semantics в переносных PR.
13. После каждого шага выполнять Rust gate.
14. Обновить docs только если module ownership documentation существует.

### Критерии готовности

- Нет монолитного vault_index.rs.
- Exclusion policy имеет один источник истины.
- Domain modules имеют узкий public API.
- Все compatibility и failure tests проходят.

### Рекомендуемая разбивка

Один PR на один или два тесно связанных модуля.

---

## WP-26 — Разделить panel-registry.tsx

### Цель

Оставить registry декларативным и вынести реализации панелей.

### Зависимости

WP-23.

### Целевая структура

```text
src/components/workspace/panels/
  files-panel.tsx
  tags-panel.tsx
  favorites-panel.tsx
  info-panel.tsx
  property-editor.tsx
  history-panel.tsx
  links-panel.tsx
  coming-soon-panel.tsx
  index.ts
```

### Шаги

1. Зафиксировать PanelRenderProps и registry contract.
2. Вынести panels по одной без изменения JSX/behavior.
3. Вынести PropertyEditor отдельно.
4. Сохранить localization keys.
5. Не переносить domain logic обратно в components; использовать repositories/hooks.
6. После каждого extraction выполнять typecheck и targeted tests.
7. Оставить panel-registry.tsx только с:
   - types;
   - IDs;
   - metadata;
   - component mapping.
8. Выполнить Fast frontend gate и format check.

### Критерии готовности

- Registry не содержит большие panel implementations.
- Нет circular imports.
- Все visible strings остаются локализованными.
- UI не изменился визуально.

### Рекомендуемая разбивка

Несколько механических PR по группам панелей.

---

## WP-27 — Разделить workspace.tsx и document-editor.tsx

### Цель

Сделать Workspace orchestration root, а editor — композицией небольших компонентов и hooks.

### Зависимости

WP-14, WP-16, WP-18, WP-23 и WP-26.

### Целевая структура

```text
src/components/workspace/
  workspace-shell.tsx
  vault/use-vault-session.ts
  windows/use-note-windows.ts
  editor/
    document-editor.tsx
    document-header.tsx
    document-title.tsx
    document-breadcrumbs.tsx
    document-actions.tsx
    document-body.tsx
    use-document-view-mode.ts
```

### Шаги

1. Зафиксировать Workspace integration contract тестами stores/hooks.
2. Вынести window handling.
3. Вынести vault picker/known vault actions.
4. Вынести document header.
5. Вынести title/rename behavior.
6. Вынести breadcrumbs.
7. Вынести actions/view menus.
8. Вынести editor body/layer switch.
9. Не создавать новый параллельный state; сохранять Zustand ownership.
10. Избегать prop drilling через domain-specific hooks/context, но не создавать глобальный catch-all context.
11. После каждого extraction выполнять Fast frontend gate.
12. Выполнить manual source/live/read, rename, move, merge, layer и multi-window scenarios.

### Критерии готовности

- Workspace содержит orchestration, а не детали editor UI.
- DocumentEditor не управляет несвязанными modal/window concerns.
- Autosave и vault state остаются в выделенных services/stores.
- Поведение не изменилось.

### Рекомендуемая разбивка

Маленькие refactor PR по одному UI concern.

---

## WP-28 — Разделить canvas-editor.tsx и sidebar-tree.tsx

### Цель

Изолировать Canvas nodes/edges/toolbar и Tree row/keyboard/DnD behavior.

### Зависимости

WP-15, WP-18 и WP-23.

### Целевая структура

```text
src/components/workspace/canvas/
  canvas-editor.tsx
  canvas-nodes.tsx
  canvas-edges.tsx
  canvas-toolbar.tsx
  canvas-markdown.ts
  use-canvas-document.ts
  use-canvas-dnd.ts

src/components/workspace/tree/
  sidebar-tree.tsx
  tree-row.tsx
  tree-icons.tsx
  use-tree-keyboard.ts
  use-tree-dnd.ts
  tree-types.ts
```

### Шаги

1. Вынести Canvas safe markdown renderer.
2. Вынести node components.
3. Вынести edge components.
4. Вынести toolbar/context menu.
5. Вынести Canvas DnD hook.
6. В Tree вынести domain types из UI.
7. Вынести row rendering.
8. Вынести keyboard navigation.
9. Вынести pointer DnD state machine.
10. Сохранить virtualization и memoization.
11. Не менять serialized Canvas format.
12. Добавить pure tests для extracted state machines.
13. Выполнить Fast frontend gate и manual drag/drop scenarios.

### Критерии готовности

- Canvas serialization byte behavior не изменён.
- Tree keyboard и DnD работают.
- Domain TreeItem больше не принадлежит UI component.
- Большие файлы существенно уменьшены без нового монолита.

### Рекомендуемая разбивка

Отдельные PR для Canvas и Tree.

---

## WP-29 — Добавить общие TS/Rust compatibility fixtures

### Цель

Не допустить расхождения web fallback и Rust index parsing.

### Зависимости

WP-23 и WP-25.

### Основные файлы

- новый shared fixtures directory
- TypeScript wiki/tag tests
- Rust index parser tests
- docs/markdown-compatibility.md

### Шаги

1. Определить JSON fixture schema:
   - name;
   - markdown;
   - expected tags;
   - expected links/targets/labels;
   - excluded regions.
2. Добавить cases:
   - code fences;
   - inline code;
   - HTML comments;
   - escaped syntax;
   - Unicode normalization;
   - anchors/aliases/block IDs;
   - embeds;
   - frontmatter tags;
   - numeric/invalid tags;
   - Canvas references, если применимо.
3. Загрузить одни и те же fixtures в Vitest.
4. Загрузить те же fixtures в Rust tests.
5. Исправлять parser divergence отдельными маленькими changes.
6. Документировать accepted behavior.
7. Выполнить Fast frontend gate и Rust gate.

### Критерии готовности

- TS и Rust дают одинаковые tags/wiki links на shared corpus.
- Новый fixture автоматически проверяется двумя implementations.
- Compatibility contract документирован.

### Рекомендуемый commit

test: share Markdown index compatibility fixtures

---

## WP-30 — Добавить UI, IPC и security integration tests

### Цель

Покрыть сценарии, которые pure Node/Rust unit tests не видят.

### Зависимости

WP-03, WP-06, WP-12, WP-16, WP-18, WP-21 и WP-22.

### Шаги

1. Выбрать минимальный component test environment для React interactions.
2. Не смешивать component tests с Tauri E2E.
3. Добавить component tests:
   - conflict dialog;
   - vault switch state reset;
   - settings save failure notification;
   - autosave pending/failed state;
   - malicious transclusion rendering.
4. Добавить Rust command integration tests:
   - no active vault;
   - path outside vault;
   - symlink escape;
   - stale generation;
   - filesystem success + index failure;
   - recovery corruption;
   - attachment limits.
5. Добавить desktop E2E smoke scenarios, если стабильный инструмент доступен:
   - open vault;
   - edit/save;
   - external edit conflict;
   - rename/move;
   - restore trash/history;
   - child window.
6. Сделать E2E deterministic с temporary vault.
7. Не использовать реальные пользовательские vaults.
8. Добавить CI jobs с разумными timeout и artifact screenshots/logs без note contents.
9. Выполнить полный test suite.

### Критерии готовности

- Критичные lifecycle/security paths покрыты выше unit level.
- Tests используют temporary isolated vault.
- Failure artifact не содержит secrets или пользовательские paths.

### Рекомендуемая разбивка

- PR A: component test harness и tests.
- PR B: Rust command integration.
- PR C: desktop smoke E2E.

---

## WP-31 — Очистить knip, repository artifacts и metadata

### Цель

Удалить подтверждённый dead code и случайные repository files без функционального изменения.

### Зависимости

WP-23–WP-29, чтобы не удалить API, нужный рефакторингу.

### Основные файлы

- knip.json
- dead exports, показанные npm run knip
- src-tauri/Тестовый.md
- dynamic.md
- editor_gpt_work1.md
- starter assets
- Cargo/package/Tauri metadata

### Шаги

1. Запустить npm run knip и сохранить точный список.
2. Для каждого export определить:
   - удалить;
   - сделать non-exported;
   - отметить entry только при реальном external use.
3. Не маскировать dead code расширением ignore list.
4. Удалить src-tauri/Тестовый.md.
5. Для dynamic.md и editor_gpt_work1.md:
   - проверить, содержат ли они актуальную спецификацию;
   - перенести полезное в docs/ с понятным именем;
   - удалить устаревшие prompt artifacts.
6. Проверить starter SVG/assets через rg и build output; удалить только неиспользуемые.
7. Обновить:
   - Cargo description;
   - authors;
   - package metadata;
   - application identifier только после проверки migration/signing impact.
8. Не менять identifier установленного приложения без отдельного migration plan.
9. Выполнить npm run knip до зелёного результата.
10. Выполнить Full local gate.

### Критерии готовности

- npm run knip проходит без новых ignores для реального dead code.
- Случайный vault content отсутствует.
- Полезные specs находятся в docs/.
- Metadata не содержит шаблонных значений.

### Рекомендуемый commit

chore: remove dead code and repository artifacts

---

## WP-32 — Сделать полный quality gate обязательным

### Цель

Не позволить technical debt снова накопиться после cleanup.

### Зависимости

WP-02, WP-30 и WP-31.

### Основные файлы

- package.json
- .github/workflows/verify.yml
- lefthook.yml
- dependency/security configuration

### Шаги

1. Добавить scripts:
   - verify:fast;
   - verify:full.
2. Full gate должен включать:
   - typecheck;
   - lint;
   - unit/component tests;
   - format check;
   - knip;
   - Rust fmt;
   - Rust clippy;
   - Rust tests;
   - generated bindings diff.
3. Добавить Rust advisory scanner:
   - cargo-audit или cargo-deny;
   - зафиксировать policy exceptions с причиной и сроком.
4. Добавить production npm advisory check или dependency update automation.
5. CI должен вызывать те же npm scripts, что и разработчик, без расходящейся логики.
6. Оставить pre-commit быстрым; не запускать тяжёлый bundle build на каждый commit.
7. PR gate должен быть blocking.
8. Nightly/weekly job может выполнять полные audits и platform bundles.
9. Выполнить Full local gate.
10. Проверить workflow на тестовом PR.

### Критерии готовности

- Локальный и CI full gate совпадают.
- Knip/format/security checks блокируют regression.
- Exceptions документированы, а не скрыты.

### Рекомендуемый commit

ci: enforce the full project quality gate

---

## WP-33 — Выполнить финальную cross-platform release verification

### Цель

Доказать, что весь roadmap завершён и приложение готово к promotion dev → beta.

### Зависимости

Все предыдущие пакеты.

### Подготовка

1. Рабочее дерево должно содержать только ожидаемые изменения roadmap.
2. Все migrations должны иметь rollback documentation.
3. Все generated bindings должны быть актуальны.
4. Не использовать пользовательский vault для destructive tests.

### Автоматические проверки

1. npm ci на чистой checkout.
2. npm run verify:full.
3. npm audit --omit=dev.
4. Rust advisory scanner.
5. npm run tauri build на:
   - macOS;
   - Windows;
   - Linux.
6. Проверить generated bundles/artifacts.
7. Проверить git diff после tests: генераторы не оставляют неожиданный drift.

### Ручные сценарии на каждой поддерживаемой OS

1. Первый запуск без settings.
2. Открытие нового vault через native picker.
3. Reopen last vault.
4. ID migration:
   - preview;
   - backup;
   - journal;
   - cancel;
   - complete;
   - recovery unfinished migration.
5. Создание и autosave Markdown note.
6. Source/Live/Read modes и byte-exact Markdown.
7. Raw HTML и malicious transclusion остаются inert.
8. Canvas create/edit/autosave/recovery.
9. Attachment import:
   - image;
   - generic file;
   - oversized file;
   - SVG;
   - collision.
10. Rename/move/merge/delete/restore.
11. History snapshot и restore.
12. External edit:
    - clean buffer reload;
    - dirty buffer conflict;
    - edit сразу после own save;
    - external delete.
13. Vault switch с pending save.
14. Child note window и app-wide vault synchronization.
15. Settings save failure.
16. AI:
    - local HTTP provider;
    - remote HTTPS provider;
    - keychain store/migration/delete;
    - timeout;
    - cancel;
    - oversized response.
17. Close app с pending Markdown и Canvas saves.
18. Crash/restart recovery journal.

### Data-safety audit

1. Проверить сохранение BOM и CRLF.
2. Проверить отсутствие silent frontmatter rewrite.
3. Проверить no-replace creation.
4. Проверить atomic save failure boundaries.
5. Проверить, что .obsidian, .git, .trash, assets и .amby не индексируются.
6. Проверить, что SQLite можно удалить и полностью rebuild.
7. Проверить, что plaintext AI keys отсутствуют в settings/logs.
8. Проверить, что old vault scopes недоступны после switch.

### Финальный отчёт

Codex должен подготовить:

- краткую сводку завершённых WP;
- список migrations и rollback;
- результаты всех commands;
- OS matrix;
- screenshots/recordings UI changes;
- оставшиеся known limitations;
- risk/data-format impact;
- рекомендацию, готова ли ветка dev к promotion в beta.

### Критерии завершения всего roadmap

- Все checkbox WP-00–WP-33 отмечены.
- Full gate зелёный на чистой checkout.
- Builds зелёные на macOS, Windows и Linux.
- Нет открытых P0/P1 data-safety или security defects из исходного аудита.
- Документация соответствует фактическим contracts.
- Репозиторий не содержит secrets, vault contents или generated bundles.
