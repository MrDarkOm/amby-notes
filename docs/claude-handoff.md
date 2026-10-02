# Передача работы Claude Code

Дата: 29 сентября 2026. Репозиторий: Amby Notes.

Пользователь попросил закончить текущую работу и продолжить с Claude Code. **Этапы 3–10 не начинались. Весь исходный план НЕ выполнен.** Не считать проект полностью проверенным или безопасным только потому, что текущий gate прошёл.

## Обязательные ограничения

- Сохранить весь текущий незакоммиченный diff. Не делать reset/clean/stash/rebase поверх него.
- Рабочая ветка `dev`, исходный HEAD `698c3eb023e9909ba73f442017a705657689214e`.
- Исходное рабочее дерево было чистым; перечисленные ниже изменения относятся к этой работе. Перед продолжением всё равно проверить `git status` на новые пользовательские правки.
- **Без commit, push, тегов, публикации и повышения версии** до отдельного указания пользователя. Версия приложения осталась `0.1.5`. npm лишь синхронизировал устаревшее поле версии в package-lock (`0.1.3` → уже существующая `0.1.5`).
- Следовать AGENTS.md. Markdown/вложения — исходные данные; SQLite — восстановимый индекс; `.amby/properties.json` — долговечный sidecar, не удаляемый вместе с индексом.
- Этапы выполнять последовательно. Независимые участки можно делегировать параллельно, один писатель на файл. Каждый этап закрывать после независимого ревью и проверки объединённого кода. Не скрывать сбои и непроведённые проверки.
- Общие manifest/lockfiles, changelog, локализации и generated bindings держать у оркестратора. `src/lib/bindings.ts` не редактировать вручную.
- Изменения должны пополнять `updates/upd_next.md`. Обычная реализация не является поводом выпускать новую версию.

## Что читать сначала

1. Этот файл и AGENTS.md.
2. `docs/data-safety-contract.md`, `docs/vault-format.md`, `docs/markdown-compatibility.md`, `docs/engineering.md`.
3. `git diff` и новые untracked-файлы: обычный diff не показывает их содержимое.
4. Полный аудит, подробный исходный план, 34 задачи и журнал сохранены локально в `.release-evidence/claude-handoff/`. Это игнорируемые артефакты, не материалы для публикации:
   - `report.md` — исходные 17 находок, воспроизведения и сравнения библиотек/подходов;
   - `implementation-plan.md` — полный план этапов 0–10 и критерии приёмки;
   - `implementation-tasks.json` — зависимости и статусы всех задач;
   - `execution-log.md` — выполненные действия, отказы, повторы и ограничения;
   - `phase1/`, `phase2/` — review, логи, снимки diff и контрольные суммы.

Оригинал этих артефактов также находится в `/Users/paul/.codex/visualizations/2026/09/28/01a0e946-2811-7122-9dd5-abdd6812c449/amby-audit/`.

## Дополнение от 30 сентября: базы данных уровня Notion

Пользователь попросил сохранить анализ для реализации Claude. Полный документ: [Базы данных Amby: аудит и план достижения возможностей Notion](./notion-database-parity-audit-2026-09-30.md).

- Документ содержит 13 находок по текущему коду, матрицу возможностей, целевые сценарии страниц и связей, архитектуру, этапы P0–P6 и критерии приёмки. Ход внедрения отмечается в разделе 15.
- 1 октября начат P0: F13 исправлен — rename меняет только manifest, сохраняет YAML-ключ и предварительно отклоняет потерю legacy-значений, неоднозначные привязки и нарушенные зависимости формул. Контракт и оставшиеся задачи описаны в [разделе внедрения](./notion-database-parity-audit-2026-09-30.md#15-ход-внедрения--1-октября-2026-года); не повторять рекурсивную перезапись YAML при rename.
- Второй пакет исправляет F3: Relation возвращает `affectedNotes` из фактически выполненных записей, а команда обновляет проекцию прежних и новых inverse-целей. Добавлены проверки inverse Rollup, self-relation и native IPC. Полный протокол CAS/journal и остальные задачи F2 этим пакетом не внедряются; не считать весь P0 завершённым.
- Третий пакет начинает F2: Relation требует исходную `expectedRevision`, возвращает `revisions` для очереди UI, проверяет байты notes/manifests перед записью и выполняет условный откат без перезаписи внешних правок. Ошибки старых inverse-целей больше не скрываются; отсутствующая цель даёт предупреждение. Durable journal, operation ID, crash recovery и блокировка между read/rename ещё не внедрены.
- Четвёртый пакет добавляет durable journal для значений Relation: обязательный `operationId`, replay завершённого результата без повторной записи, raw backups, per-step progress и conditional crash rollback при vault activation до индекса. Все pending операции проверяются до начала restore; конфликт, unsafe path или corrupt backup блокируют activation с сохранением recovery данных. Это не закрывает весь F2: протокол создания пары свойств, межпроцессные блокировки, resume/UI разрешения конфликтов и cleanup ещё требуют работы.
- Пятый пакет защищает создание пары свойств Relation: обе схемы готовятся до publish, проверяются source/target revisions и имена/YAML-ключи, отдельный schema journal сохраняет raw manifests и стабильные property IDs. Self-pair меняет один manifest. Activation проверяет оба Relation recovery namespaces до первого restore. Существующие Relation config/type mutations, общий undo/resume, recovery UI и межпроцессные блокировки остаются следующими задачами; не объявлять весь F2 закрытым.
- Шестой пакет расширяет schema journal на настройку существующего Relation и конверсию в/из Relation. Version-2 сохраняет вид запроса и результат изменения; version-1 создания остаётся читаемым. До трёх manifests готовятся вместе, related revisions проверяются, обратное поле при отключении пары сохраняется как одностороннее. Смена топологии требует пустых значений обеих сторон; миграция заполненных связей, общий undo/resume, recovery UI и межпроцессные блокировки остаются незавершёнными. Результаты проверок и ограничения — в разделе 15 плана.
- Перед началом сверить находки с актуальным рабочим деревом и сохранить уже имеющиеся изменения. Сначала закрывать P0: протокол Relation, ревизии, восстановление, обновление обеих сторон связи и безопасное переименование свойств, включая F13.
- Первый законченный пользовательский сценарий: «Проекты ↔ Задачи», страница проекта, полноценный поиск Relation, обратные связи, Rollup прогресса, реальные обложки и встроенная доска задач проекта.
- Для каждого этапа фиксировать сделанное, проверки и оставшиеся ограничения; выполнять требования AGENTS.md к build, verify, Rust/IPC и нативным сценариям. Обновлять накопительный changelog без повышения версии.
- Этот план дополняет передачу работы; он не означает, что прежние незавершённые этапы ниже выполнены или отменены.

## Дополнение от 30 сентября: творческая мастерская

Подробное задание: [Творческая мастерская Amby: план для Claude Code](./creative-module-claude-plan.md).

- Предложен официальный модуль `amby.creative`: персонажи, вселенные, книги, главы, сцены, арки, локации, объекты, собственные типы и автоматическая пробковая доска.
- Зафиксированы общий каталог сущностей, отдельные записи содержательных отношений, независимость структуры рукописи от хронологии и расположения карточек, границы хранения и критерии приёмки.
- Этапы C0–C4 описывают первую законченную версию; хронология с интервалами, альтернативные каноны и AI вынесены в дальнейшее развитие. Перед реализацией перепроверить необходимые блокеры Relation и recovery по актуальному коду.
- Это сохранённый план, а не готовая функция. Он не отменяет незакрытые задачи предыдущих этапов и не требует завершить весь паритет Notion до первого творческого сценария.

## Дополнение от 30 сентября: Excalidraw как единая доска

Подробное задание: [Excalidraw как единая доска Amby: план для Claude Code](./excalidraw-canvas-claude-plan.md).

- План содержит 12 исходных находок, архитектуру двух исходных форматов, требования к живым заметкам, связям, группам, раскладке, экспорту и переходу со старого Canvas. Этапы E0–E12 имеют зависимости и критерии завершения; приложены матрица приёмки и готовый запрос исполнителю.
- Это план, а не реализованная замена Canvas. Сначала исправлять потерю данных и проверять критические interactions на настоящем Excalidraw; `.canvas` нельзя направлять в текущий sketch parser без отдельного адаптера.
- Для сохранения досок нужен согласованный общий revision/recovery contract. Переиспользовать актуальную реализацию общих этапов ниже; не создавать второй механизм и не считать их завершёнными из-за появления этого задания.
- При отдельном поручении реализовать доску следовать объёму её плана. Старые незавершённые проекты сохраняют свои статусы; их наличие не требует автоматически начинать несвязанные задачи баз данных.
- При подготовке задания менялась только документация. Реальные результаты будущей реализации и проверок записывать отдельно, без commit/push и повышения версии до поручения пользователя.

## Сделано: этап 0

- Зафиксированы чистый baseline, версия и текущие находки.
- Записаны инварианты сохранности и правила оркестрации.
- Подготовлены изолированные fixtures; пользовательские vault и ключи не использовались.
- Зафиксированы исходные failures: dependency audits и два native trash-contract сценария. Они не исчезают от успешного unit gate.

## Сделано: этап 1 — закрыт

Независимое ревью завершилось scoped approve после исправлений. Проверен объединённый код: 885 frontend tests, 382 Rust tests, 2 ignored, полный verify и native bundle с frontend build.

### Модули и пути

Файлы: `src-tauri/src/package_manager.rs`, `src-tauri/src/paths.rs`, `src/lib/modules/package-manager/installer.ts`, новый `staging-ipc.test.ts`, Cargo.toml/Cargo.lock.

- Проверяются portable module IDs, версии, пути пакета, entry, точный состав файлов и контрольные суммы.
- Staging handle генерирует backend; frontend использует именно возвращённый handle.
- Stage/publish/list/entry/rollback/uninstall отвергают симлинки и выход за каталог. Корень сначала канонизируется, чтобы системный alias `/var` → `/private/var` на macOS не блокировал корректные пути.
- Повторно проверяются установленные manifests, файлы и подписи. Hex decoder безопасно отвергает не-ASCII вместо panic.
- Для публикации введён `pending-publish.json`, format version 1: manifest, staging ID, previous/next metadata. Intent сохраняется до rename. Ошибка metadata оставляет файлы и журнал; list/entry/publish/rollback восстанавливают завершённый либо прерванный переход.
- Ревью обнаружило orphan publication после metadata failure и недостаточную проверку previous history. Исправлено; есть failure-injection/retry/tampered-journal тесты.
- Межпроцессная подмена пути между проверкой и rename полностью не исключена. Журнал пока не координирует frontend registry. Не расширять эти гарантии в документации.

### Журналы миграции ID

Файл: `src-tauri/src/vault/migration.rs`.

- До первой записи проверяются ВСЕ source/backup paths и сам journal.
- Проверяются vault scope, reserved directories, расширение, operation backup root, дубликаты, симлинки и типы файлов.
- Inspect, apply и rollback используют проверки. Старые journal versions 1/2 поддерживаются.
- Тесты подтверждают отказ без изменения исходных файлов и корректный apply/rollback.

### Допуск Markdown в Live Preview

Файлы: `document-editor.tsx`, `note-editing-policy.ts`, colocated tests, новый `document-editor-compatibility.test.tsx`, `src/locales/resources.ts`.

- Проверяется byte-exact round trip реальным parser/serializer до mount rich editor.
- Raw source учитывается отдельно: mixed EOL нельзя скрыть нормализованным body.
- Проверка повторяется для локального буфера, переключения документа и внешнего обновления. Исправлен stale buffer A→B→A.
- Неподдерживаемый синтаксис остаётся Source-only с RU/EN объяснением; malformed YAML продолжает следовать отдельной политике.
- Native UI на synthetic profile: footnotes/references/mixed EOL — Source, простой Markdown — Live, Source edit/save проверен по байтам через реальный IPC.
- Полноценный browser app smoke этапа 1 не завершён: через IAB не удалось открыть web vault. Отдельный browser dependency harness этапа 2 не заменяет этот сценарий.

## Сделано: этап 2 — реализация есть, этап НЕ закрыт

### S2.1: YAML

Файлы: `src-tauri/src/frontmatter.rs`, `frontmatter_test.rs`, `docs/vault-format.md`.

- Splice/remove используют точный case-sensitive ключ верхнего уровня. Вложенные ключи и текст block scalar не принимаются за цель.
- Сохраняются BOM, EOL, комментарии при замене, кавычки, порядок и байты соседних полей.
- Повторный parse сравнивает весь mapping с ожидаемой единственной мутацией.
- Сложные/многострочные/anchored targets и неоднозначные формы безопасно отвергаются.
- Слишком строгая первая реализация отвергала собственные inline lists связей. Это была регрессия, её исправили: однострочные flow lists/maps допускаются при сбалансированных delimiters и отсутствии anchors/aliases/tags вне quoted text. Root flow maps остаются запрещены.
- Добавлена защита от потери комментария после апострофа в plain scalar (`Bob's note # comment`).
- 44 focused frontmatter tests прошли; ранее падавший existing two-way relation mutation test снова проходит.

### S2.2: формулы и проекция

Файлы: `src-tauri/src/database/formula.rs`, `formula_test.rs`, `projection.rs`, `projection_test.rs`.

- Проверяемая арифметика для i128 MIN/-1, remainder/division, масштабирования, add/sub/mul; корректный parse отрицательного i128 MIN.
- Ограничены размер выражения, число цифр, глубина и количество токенов.
- Независимое ревью заблокировало первоначальный вариант: ошибка первой note прерывала остальные, rollup errors игнорировались, diagnostics не очищались.
- Исправлено: вычисления каждого note/kind идут через savepoint; ошибка удаляет его derived values, создаёт deterministic diagnostic и не останавливает другие notes. Успех очищает прежнюю ошибку. Исходные Markdown/record shards не меняются.
- Full rebuild сначала вычисляет formulas всех баз, затем rollups. Diagnostics очищаются перед вычислениями, а не после них. Reports считают реальные diagnostics.
- Rollup проверяет ошибку целевого computed kind именно в целевой database. Чужая ошибка либо ошибка формулы при чтении обычного number не блокирует сумму.
- `healthy` означает актуальный опубликованный cache, который может содержать явные computation diagnostics. Не переводить весь источник в read-only только из-за исправляемой пользователем формулы.
- Debug/release formula tests (13) и projection tests (9 passed, 1 ignored) прошли. Финальный formula diff также прошёл 13 release-тестов. При этом финальное независимое review обнаружило ещё один blocker в refresh_dependent_rollups; он НЕ исправлен, описание ниже.

### S2.3: зависимости и SemVer

Файлы: `package.json`, `package-lock.json`, Cargo.lock, `package_manager.rs`, `validator.ts`, новый `validator.test.ts`, `tests/fixtures/package-versions.json`, `docs/security-advisories.md`.

- Rust и frontend используют готовые библиотеки SemVer вместо числовых эвристик. Общий corpus проверяет версии, prereleases/build metadata, ranges, portable IDs, JS safe integer limit.
- Bare dependency version сохраняет прежний смысл minimum (`>=`). Поддерживаются ограниченные одинаковые в обоих языках explicit comparator sets; неподдерживаемые формы отвергаются.
- Backend проверяет app bounds и установленные direct dependencies при публикации, recovery, rollback и entry resolution.
- После review исправлены inherited-object lookup (`toString`/`constructor`) и несовпадение правил module IDs в browser/backend.
- Rustls → 0.23.45 с необходимыми aws-lc/webpki; yanked chacha20 → 0.10.2; Vitest → 4.1.11; semver → 7.8.5 и типы.
- Overrides: lodash-es 4.18.1, Nano ID 3.3.18 для Excalidraw, 5.1.16 для mermaid-to-excalidraw. Excalidraw остаётся 0.18.1. Не применять `npm audit fix --force` с предложенным downgrade.
- `npm run audit:rust` прошёл с существующим точным списком исключений. Новых исключений не добавляли; исходные GTK/Specta/Unicode риски не объявлены исправленными.
- **Свежий npm audit НЕ выполнен.** Автоматический reviewer отклонил отправку графа имён/версий в registry.npmjs.org без специального согласия. Запрос пользователю остался без ответа; «Продолжай» не считали таким согласием. Все installs делались с `--no-audit --ignore-scripts`. Не обходить это ограничение.
- Публичные advisory/registry сведения и локальный lockfile проверены, но это не равнозначно текущему чистому npm audit всего дерева.

## Проверки и непроведённые сценарии

- Финальный последовательный `npm run verify`: PASS, **892 TS tests (139 files), 401 Rust tests, 2 ignored**, TypeScript, ESLint, Prettier, knip, Rustfmt, strict Clippy, version sync, regenerated binding check. Покрывает последний quote-regression и formula-scope diff.
- Frontend production build и отдельный ad-hoc native macOS bundle финальных исходников: PASS. Точные команды и результаты записаны ниже.
- Native property smoke: synthetic `YAML.md`, через реальный UI/IPC `status: before` → `after`. Полное сравнение байтов подтвердило сохранение `Status`, nested status, inline comment и body. UI run был до финального flow/quote/scope патча; это ограничение не скрывать.
- Browser harness: Excalidraw create/restore/draw (3 figures), sketch serialize/reopen с unknown metadata, flowchart import и Canvas import прошли.
- **Mermaid class diagram conversion не чистый PASS**: upstream converter выдаёт DOM-ID error и возвращает SVG fallback. SVG и новые уникальные file IDs работают, редактируемые class shapes — незакрытый дефект. Исходный baseline этим же harness не сравнивался; не называть достоверно новым или старым.
- Не проводились Windows/Linux manual tests, полноценный browser workspace smoke, финальные plugin isolation/CSP проверки, crash/restart матрица следующих этапов.
- Исходные 2 native trash-contract failures не перепроверялись и не считаются исправленными. Delete/system-trash против vault-local `.amby/trash/` остаётся конфликтом контрактов для этапа 5.
- Сохранились warnings: missing `activeModules` dependency в settings-modules.tsx, крупный JS chunk, ineffective dynamic import debug health.
- Были реальные failures перед исправлениями: Object.hasOwn против TS target; Clippy char comparison/collapsible match; two-way relation regression. Логи сохранены, тест не ослабляли ради зелёного результата.
- Несколько исполнителей остановились по usage limit; root завершал их частичный код. Само завершение агента не считалось review/acceptance.
- CUA подключение к отдельному native app зависало на 2213.7 секунды вопреки таймауту. Долгая пауза была инструментальной, не скрытой работой.

## Состояние на 2 октября 2026 (Claude Code, ветка `checkpoint/handoff-stage2`)

Работа шла по пересмотренному плану: сначала всё, что защищает файлы пользователя; улучшения производительности и замены библиотек отложены. Коммиты — только локальные чекпойнты на этой ветке, версия `0.1.5`, push и теги не выполнялись.

| Этап / задачи | Статус                                                | Что сделано / что осталось                                                                                                                                                                                                                                                                                |
| ------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0, 1          | Закрыты                                               | Без изменений                                                                                                                                                                                                                                                                                             |
| 2 / S2.1–S2.3 | Код готов, **не закрыт**: нет полного `npm audit`     | Исправлен blocker `refresh_dependent_rollups` (очистка значений и диагностика `rollupError` при непригодном манифесте, детерминированный порядок баз), независимое review — APPROVE WITH NITS. Открыто: многошаговые цепочки Rollup, `npm audit` без согласия пользователя на отправку графа зависимостей |
| 3 / S3.1      | Готов                                                 | [mutation-protocol.md](./mutation-protocol.md)                                                                                                                                                                                                                                                            |
| 3 / S3.2      | Частично                                              | `durable.rs` (общие проверки и no-replace create), строгий `recover_pending_batches` блокирует активацию. Не сделано: общий `JournalFile`, исход `recovery-required` вне Relation, блокировка только затронутой базы                                                                                      |
| 3 / S3.3      | Частично                                              | Матрица отказов: каждая запись двусторонней Relation, до/после публикации, 22 границы. Не сделан тест с убийством процесса                                                                                                                                                                                |
| 4 / S4.1      | Частично                                              | Условная запись `write_file` (ревизия SHA-256) и приостановка автосохранения Canvas/Excalidraw при внешней правке. Нет UI разрешения конфликта; переименованные пути берут текущую ревизию                                                                                                                |
| 4 / S4.2      | Покрыт пакетами Relation (разд. 15 аудита баз данных) | Не переделывался; открыты resume/UI, миграция заполненных связей, межпроцессные блокировки                                                                                                                                                                                                                |
| 4 / S4.3      | Частично                                              | Атомарные записи манифестов и журнала миграции, один список служебных каталогов. Не проверены `rename`/link refactor на полный traversal-контракт                                                                                                                                                         |
| 5 / S5.1      | Минимум                                               | Блокирующие ошибки показываются диалогом открытия хранилища; карантинные журналы и аномалии корзины — уведомлением при открытии, без возможности управлять ими                                                                                                                                            |
| 5 / S5.2      | Готов                                                 | Настройка режима удаления (system / vault / permanent), два старых native-теста проходят, обнаружение «осиротевших» записей корзины и идемпотентное завершение восстановления                                                                                                                             |
| 5 / S5.3      | Не сделан                                             | Нет интеграционной матрицы restart/conflict в реальном WebView                                                                                                                                                                                                                                            |
| 6 / S6.1–S6.4 | Отложен                                               | Community-плагины не используются; выполнение установленных модулей отключено выключателем. Полная изоляция, подписи полного manifest и bounded downloader не делались. **Открыта находка высокой важности про ключ подписи — см. [security-advisories.md](./security-advisories.md)**                    |
| 7 / S7.1      | Готов                                                 | Замер macOS записан в [performance-baseline.md](./performance-baseline.md): при 10 000 заметок правка одного файла 0,52 с (debug), рост почти линейный с размером хранилища. S7.2–S7.4 не начаты; сначала повторный замер в release                                                                       |
| 8             | Отложен                                               | Нет найденной потери данных                                                                                                                                                                                                                                                                               |
| 9 / S9.1      | Написан, не проверен                                  | `gate` в `release.yml` (полный verify + audit до сборки). Первый запуск по тегу — его настоящая проверка                                                                                                                                                                                                  |
| 10            | Не начат                                              | Итоговая независимая приёмка и platform acceptance (Windows/Linux)                                                                                                                                                                                                                                        |

## Критичные незакрытые находки для продолжения

- Stage 3/4: обычные note revisions не везде учитывают полный raw source/YAML; Canvas/Excalidraw generic writes не имеют общей CAS-защиты. Не выдавать нынешние отдельные guards за универсальный протокол сохранения.
- Property sidecar/YAML/SQLite и reciprocal mutations ещё нуждаются в согласованной долговечной операции. Одно исправление YAML splice не делает несколько файлов атомарными.
- Recovery/undo/activation paths местами проглатывают ошибки. Проверить callers, в том числе database commands, прежде чем объявлять cache failures корректно показанными пользователю.
- Frontend registry модулей не включён в backend publication journal.
- Community module JS всё ещё может импортироваться в привилегированный renderer; Worker-прототип не доказывает изоляцию.
- Test official private key остаётся в исходном package tooling/validator; canonical signature payload не охватывает всю будущую metadata. Это НЕ исправлено SemVer-изменениями.
- Downloader ещё требует ограничения размера во время получения потока, а не после накопления всего ответа.
- Новые Zod/TanStack/DnD/BigDecimal подходы не внедрены. Реально заменена библиотекой только SemVer-эвристика; остальные решения требуют отдельных pilots и измерений.

## Как продолжить

1. Прочитать финальную приёмку ниже и локальный `phase2/review.md`. Сначала исправить оставшийся blocker этапа 2 и добавить failure-boundary regression; затем повторить gate и получить независимый scoped approve.
2. Проверить текущий diff, untracked-файлы, отсутствие работающих тестовых процессов и версию `0.1.5`.
3. Не повторять уже закрытый этап 1 с нуля. Новые изменения поверх него проверять как новый diff.
4. После закрытия этапа 2 начать S3.1 с одного согласованного дизайна. Не разрабатывать несколько параллельных transaction engines.
5. На каждый batch: focused tests → `npm run verify` → `npm run build`, Rust changes также `npm run rust:test`/strict Clippy; IPC/config/package changes — native build. Review независимо от автора.
6. Сохранить запрет commit/push/publication и явно перечислять всё, что не удалось проверить.

## Финальная приёмка при передаче

**Итог: code gate PASS, независимый review BLOCK. Этап 2 не закрыт. Работа остановлена по просьбе пользователя для продолжения с Claude Code.**

### Первая задача Claude: stale dependent rollup

- Место: `src-tauri/src/database/formula.rs:1503–1520`, функция `refresh_dependent_rollups`; публикация статуса — `src-tauri/src/database/projection.rs:323–332`.
- Вложенные `if let Ok(...)` молча пропускают ошибки database lookup, confinement, чтения manifest и parse.
- Воспроизведение: сначала успешно вычислить зависимый rollup; затем повредить либо сделать недоступным manifest source database; изменить target note и запустить incremental refresh. Source пропускается, прежний rollup остаётся в `db_values`, projection публикует `healthy`.
- Это результат независимого code review; отдельного исполняемого regression test для этого failure path пока нет. Зелёный существующий gate не опровергает находку.
- Требуемый результат: typed failure и явное stale-состояние либо очистка затронутых computed values с deterministic diagnostic. Проверить callers, чтобы ошибка не поглощалась выше. Исходные пользовательские данные не изменять. Добавить regression на повреждённый/недоступный manifest и восстановление после исправления.
- Reviewer принял предыдущие исправления YAML, арифметики, per-note savepoint, ordering, diagnostics и SemVer, но **не дал approve всему этапу**. Новую независимую приёмку проводить после исправления.

### Финальные результаты

Все логи находятся в `.release-evidence/claude-handoff/phase2/`.

- `npm run verify` → exit 0; `amby-handoff-verify-serial.log`: 892 frontend, 401 Rust, 2 ignored, doc-tests и bindings check успешны.
- `npm run tauri build -- --debug --features native-contract --bundles app --config /tmp/amby-phase2-native-config.json` → exit 0; `amby-handoff-native-build.log`. Включает production frontend build. Создан отдельный ad-hoc `src-tauri/target/debug/bundle/macos/Amby Phase2 Smoke.app`; это локальный debug bundle, не подписанный релиз. Конфигурация сохранена рядом с логом.
- Финальные 13 formula tests в release → exit 0; `amby-handoff-formula-release.log`.
- Первый handoff verify завершился ошибкой rustdoc E0460/E0463 после успешных 892 frontend/401 Rust tests: одновременно шла native compilation с другим feature set в общем Cargo target. После завершения native build последовательный retry выше прошёл. Первый failure сохранён как `amby-handoff-verify.log`; не запускать такие сборки параллельно в общем target.
- В Rust test log есть stderr от osascript/Finder (`Connection Invalid`, `Can’t get application Finder`), хотя test process завершился успешно. Это не доказательство исправности desktop trash; исходные два native trash failures остаются открытыми.
- Финальный `npm run build` после подготовки текста передачи: результат хранится в `acceptance.json` и `amby-handoff-build-final.log`. Для prose-only изменений исходниковые тесты заново не повторяются.
- Нативное тестовое приложение закрыто, собственный Vite на 1437 остановлен, браузерный harness закрыт. Запущенных дочерних агентов нет; финальный reviewer завершился. Полный системный process inventory не подтверждён: sandbox запретил `ps`; известные собственные процессы завершены по их tool sessions.
- Финальные `source-sha256.json`, `tracked.patch`, `untracked/` фиксируют переданный код без Git commit. Native bundles, logs и synthetic fixtures остаются только локальными.

### Короткий запрос для Claude Code

```text
Прочитай AGENTS.md, docs/claude-handoff.md и .release-evidence/claude-handoff/implementation-plan.md.
Сохрани весь текущий незакоммиченный diff. Начни с blocker этапа 2 в refresh_dependent_rollups,
добавь failure-boundary regression, прогони объединённые проверки и независимое review.
Не считай этап 2 завершённым до закрытия blocker и явного учёта непроведённого npm audit.
Затем продолжай исходный план с этапа 3 через оркестрацию, последовательно по этапам.
Без commit, push, публикации и изменения версии. Отмечай реальные сбои и непроведённые проверки.
```
