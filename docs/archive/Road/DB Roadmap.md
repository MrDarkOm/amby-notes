# DB Roadmap

Статус: DB-00—DB-09 реализованы; DB-10—DB-20 имеют рабочие вертикальные срезы, но не весь заявленный scope; после runtime/UI-аудита модуль возвращён в `beta`, DB-21 не закрыт без полного native/platform evidence
Версия документа: 1
Дата: 2026-09-04

План превращает
[архитектуру](../database-system.md),
[сценарии](../database-user-flows.md),
[формат](../database-format.md),
[runtime](../database-runtime.md) и
[frontend-контракт](../database-frontend.md) в небольшие проверяемые PR.

## 1. Правила выполнения

- Работа начинается от `dev` короткими ветками `codex/database-*`.
- Один PR решает одну границу; несвязанный cleanup не включается.
- `src/lib/bindings.ts` меняется только генератором после Rust IPC changes.
- Каждый PR запускает `npm run verify` перед review.
- После Rust changes дополнительно запускается `npm run rust:test`; для
  backend-heavy PR — strict Clippy.
- Touched frontend files форматируются Prettier, Rust files — Rustfmt.
- Видимый UI проверяется в `npm run dev`; filesystem/IPC/watcher — обязательно в
  `npm run tauri dev`.
- До DB-10 ни один production path не создает `ambd.json` или `.ambd/`.
- Любая новая durable mutation сначала получает failure/revision/recovery tests.
- Если PR нельзя безопасно откатить отдельно от следующего, он слишком большой.

Целевой размер — один reviewable slice. Generated bindings, fixtures и schema
snapshots не считаются причиной объединять две функции в один PR.

## 2. Карта зависимостей

```text
DB-00 Contracts
   │
   ▼
DB-01 Safe module lifecycle + feature gate
   │
   ▼
DB-02 Typed backend/port skeleton
   │
   ▼
DB-03 Durable format parser ──► DB-04 Discovery/ownership
                                      │
                                      ▼
                               DB-05 SQLite rebuild
                                      │
                                      ▼
                               DB-06 Query engine
                                      │
                         ┌────────────┴────────────┐
                         ▼                         ▼
                  DB-07 Watcher/events      DB-08 Frontend shell
                         └────────────┬────────────┘
                                      ▼
                               DB-09 Read-only Table
                                      │
                                      ▼
                         DB-10 Database/schema/views writes
                                      │
                                      ▼
                         DB-11 Values + edit queue
                                      │
                                      ▼
                         DB-12 Rows/membership/sub-items
                                      │
                                      ▼
                         DB-13 Side peek + inspector
                                      │
                    ┌─────────────────┼─────────────────┐
                    ▼                 ▼                 ▼
             DB-14 List/Gallery  DB-15 Board     DB-16 Relation/Files
                    └─────────────────┼─────────────────┘
                                      ▼
                         DB-17 Templates/history
                                      │
                                      ▼
                         DB-18 Linked views/legacy
                                      │
                                      ▼
                         DB-19 Batch/paste/CSV
                                      │
                                      ▼
                         DB-20 YAML sync/conflicts
                                      │
                                      ▼
                         DB-21 Hardening/release gate
```

DB-14 и DB-15 можно выполнять параллельно после DB-13. DB-16 может начаться
после DB-12, но объединяется с остальными только после общей row model проверки.
Остальные зависимости линейны из-за on-disk и IPC contracts.

## 3. Rollout gates

| Gate | После PR | Что разрешено                                           |
| ---- | -------- | ------------------------------------------------------- |
| A    | DB-04    | Только parser/discovery tests; пользовательского UI нет |
| B    | DB-09    | Внутренний read-only preview на fixtures                |
| C    | DB-13    | Opt-in создание и базовое редактирование реальных баз   |
| D    | DB-20    | Полный согласованный v1 feature set                     |
| E    | DB-21    | Module status `ready`; beta/release candidate           |

До DB-21 действовал persisted flag `experimental.databasesV1`, default `false`.
После DB-21 поле сохраняется для совместимости со старыми настройками, но больше
не является feature gate. Отдельный persisted module toggle по-прежнему определяет,
включены ли базы в выбранном preset/layout.
Legacy feature flag больше не управляет доступностью released-модуля и не
сканирует vault.

При первом стабильном релизе Databases остается opt-in для существующих
профилей. Включение по умолчанию для новых Standard workspaces принимается
отдельным продуктовым решением после beta feedback; migration не меняет выбор
существующего пользователя.

## 4. DB-00 — Зафиксировать контракты

Статус: документация подготовлена в текущем worktree.

### Scope

- `docs/database-system.md`
- `docs/database-user-flows.md`
- `docs/database-format.md`
- `docs/database-runtime.md`
- `docs/database-frontend.md`
- `docs/Road/DB Roadmap.md`

### Acceptance

- source of truth, membership, title uniqueness и module-off semantics не
  противоречат друг другу;
- format отделен от SQLite projection;
- frontend и IPC не вводят вторую копию row data;
- deferred Formula/Rollup/Multi-source явно не входят в v1;
- Markdown проходит Prettier и `git diff --check`.

### Data impact

Нет. Только документация.

## 5. DB-01 — Безопасный lifecycle модуля и feature gate

Статус: реализовано в текущем worktree.

### Цель

Подготовить настоящий отключаемый модуль до появления database writes и
запретить создание новых legacy `Metadata.md` через новый UI path.

### Основные файлы

- `src/components/workspace/modules.ts`
- `src/components/workspace/use-presets.ts`
- `src/components/workspace/app-config.ts`
- `src/components/workspace/settings-dialog.tsx`
- `src/components/workspace/use-layers.ts`
- `src/components/workspace/editor/document-actions.tsx`
- `src/locales/resources.ts`
- новый `src/components/workspace/module-lifecycle.ts`
- colocated tests для config, presets и lifecycle.

### Изменения

- Добавить `experimental.databasesV1: boolean`, default `false`.
- Разделить `available` и `enabled` для preview modules.
- Сделать deactivate двухфазным: `prepare/flush` → commit enabled state.
- Если flush не удался, не менять active modules или persisted layout.
- Ввести узкие permissions `read-databases` и `write-databases`.
- Пока новый creator не готов, скрыть/заблокировать создание database layer,
  которое сегодня пишет `Metadata.md`.
- Existing legacy layer/block остается читаемым и byte-preserved.

### Acceptance

- Preview flag не включает модуль автоматически.
- Module-off не вызывает database storage calls.
- Failed async deactivate оставляет модуль включенным.
- Switching preset использует тот же lifecycle, а не обходит flush.
- Обычные Canvas/Sketch layer actions не меняются.
- Existing `Metadata.md` не удаляется и не переписывается.

### Проверка

- focused Vitest: config migration, lifecycle failure, preset switch;
- `npm run verify`;
- manual Settings/preset switch в browser dev.

### Data impact

Только versioned app settings. Vault database files не создаются.

## 6. DB-02 — Typed backend и StoragePort skeleton

Статус: реализовано в текущем worktree.

### Цель

Создать компилируемую границу без реализации формата или UI.

### Основные файлы

- новые `src-tauri/src/database/mod.rs`, `model.rs`, `runtime_state.rs`
- новый `src-tauri/src/commands/database.rs`
- `src-tauri/src/commands/mod.rs`
- `src-tauri/src/lib.rs`
- новые `src/lib/storage/database-types.ts`, `database-port.ts`
- новые desktop/web database adapters
- `src/lib/storage/port.ts`, `index.ts`
- generated `src/lib/bindings.ts`.

### Изменения

- Добавить `DatabaseRuntimeState`, scoped к `vaultGeneration`.
- Зарегистрировать только module-state и empty list commands.
- Ввести `DatabasePort` как составную часть `StoragePort`.
- Добавить tagged `DatabaseError`, `ProjectionVersion` и resource refs.
- Web/Desktop adapters проходят один contract harness.
- Любой data command при выключенном runtime возвращает `moduleDisabled`.

### Acceptance

- Смена vault сбрасывает runtime state и отменяет старые operations.
- Frontend различает typed domain error и transport failure.
- WebAdapter и DesktopAdapter имеют одинаковую сигнатуру.
- Generated bindings воспроизводимы.
- Команды не принимают абсолютные resource paths от renderer.

### Проверка

- Rust unit tests runtime state;
- TypeScript storage contract tests;
- `npm run rust:test`, `npm run bindings:check`, `npm run verify`.

### Data impact

Нет database files и нет новых SQLite tables.

## 7. DB-03 — Durable format parser/validator

Статус: реализовано в текущем worktree.

### Цель

Реализовать pure Rust чтение, валидацию, revisions и lossless preservation для
`ambd.json` и `.ambd` shards без подключения к vault scan.

### Основные файлы

- `src-tauri/src/database/model.rs`
- новые `src-tauri/src/database/format.rs`, `validation.rs`
- `src-tauri/src/frontmatter.rs` только для общего raw revision helper
- новые fixtures `src-tauri/fixtures/database-format/`
- `docs/database-format.md` при уточнении только совместимым дополнением.

### Изменения

- Serde types для manifest/property/value/view/template/filter AST.
- `#[serde(flatten)]`/opaque containers для неизвестных полей и variants.
- Raw-byte revision, JSON limits и vault-relative asset validation.
- Typed decimal/date/URL/option/relation validation.
- Writer возвращает bytes до filesystem publish и сохраняет unknown payload.
- Unsupported `formatVersion` читается как read-only.

### Acceptance

- Golden round-trip известных fixtures.
- Unknown keys не исчезают после известной mutation.
- Corrupt JSON не дает writer output поверх исходника.
- BOM/invalid UTF-8/oversize имеют typed read-only/validation outcome.
- Decimal никогда не парсится через `f64`.
- Filter operator проверяется по типу property.

### Проверка

- focused Rust golden/property tests;
- fuzz-like table cases для path traversal, decimal и deep filter AST;
- `npm run rust:test`, strict Clippy, `npm run verify`.

### Data impact

Read-only parser. Ничего не пишет.

## 8. DB-04 — Discovery, ownership и diagnostics

Статус: реализовано в текущем worktree.

### Цель

Находить базы и точно определять owning database каждой note без SQLite.

### Основные файлы

- новый `src-tauri/src/database/discovery.rs`
- `src-tauri/src/vault/scan.rs`
- `src-tauri/src/vault/tree.rs`
- `src-tauri/src/paths.rs`
- discovery fixtures/tests.

### Изменения

- Найти `ambd.json`, не индексируя `.ambd/` как notes.
- Различить attached и standalone container.
- Выбрать ближайший ancestor manifest.
- Рассчитать parent row, category path, depth и nested-database boundary.
- Выдать diagnostics для duplicate IDs/titles, broken/unsupported manifests,
  orphan shards и symlink escapes.
- Не исправлять внешние ошибки автоматически.

### Acceptance

- Одна note имеет не более одного owner.
- Nested database перехватывает только свой subtree.
- Обычная папка не становится row, но остается category path.
- Duplicate Title/ID видимы и не переименовываются.
- Corrupt nested manifest не отдает subtree внешней базе молча.
- `.obsidian`, `.git`, `.trash`, `assets`, `.amby`, `.ambd` исключены корректно.

### Проверка

- Rust table tests Windows/macOS/Linux path forms;
- nested/bundle/symlink fixtures;
- существующие vault tree/index tests;
- `npm run rust:test`, strict Clippy, `npm run verify`.

### Data impact

Только scan. Ничего не пишет.

## 9. DB-05 — SQLite schema и полный rebuild

Статус: реализовано в текущем worktree.

### Цель

Добавить `db_*` projection и атомарно восстанавливать ее из durable files.

### Основные файлы

- `src-tauri/src/index/schema.rs`
- `src-tauri/src/index/connection.rs`
- новый `src-tauri/src/database/projection.rs`
- `src-tauri/src/vault_context.rs`
- schema snapshot и rebuild tests.

### Изменения

- Добавить DDL из runtime contract и необходимые indexes/FTS.
- Ввести `database_schema_version`, projection epoch/seq/state.
- Парсить filesystem snapshot до SQLite transaction.
- Публиковать целую projection одной transaction.
- Сохранять last healthy projection как `staleReadOnly` при incremental parse
  failure.
- При невозможной cache migration перемещать старый index в recovery и rebuild.
- Добавить exact decimal/text/date sort keys без `REAL`/ASCII `NOCASE`.

### Acceptance

- Удаление `.amby/notes.db`, `-wal`, `-shm` и rebuild дает эквивалентный result.
- Reader видит только старую или новую целую generation.
- Index failure не меняет durable files.
- Foreign keys и cascade не удаляют unresolved relation targets.
- Rebuild 10 000-row fixture не держит write transaction во время JSON parsing.
- Schema snapshot обнаруживает случайный DDL drift.

### Проверка

- Rust schema/rebuild/failure injection tests;
- `EXPLAIN QUERY PLAN` smoke для базовых indexes;
- `npm run rust:test`, strict Clippy, `npm run verify`.

### Data impact

Только rebuildable `.amby/notes.db` и его recovery copy. Источники не меняются.

## 10. DB-06 — Typed query engine и read IPC

Статус: реализовано в текущем worktree.

### Цель

Сделать безопасные list/get/query/search APIs с keyset pagination.

### Основные файлы

- новый `src-tauri/src/database/query.rs`
- `src-tauri/src/database/model.rs`
- `src-tauri/src/commands/database.rs`
- `src-tauri/src/lib.rs`
- desktop/web database adapters и contract harness
- generated `src/lib/bindings.ts`.

### Изменения

- Валидировать `FilterNode`, sorts, group, aggregates и requested fields.
- Компилировать только whitelist SQL fragments с bind parameters.
- Вернуть opaque cursor с epoch/seq/query hash/tie-breaker.
- Поддержать nested/flat, breadcrumbs и child match without parent.
- Поддержать typed aggregates и board counts по полному result set.
- Объединить property FTS с обычным note search через отдельный command.
- Ограничить AST, result page и execution time; поддержать cancellation.

### Acceptance

- Renderer не может передать SQL identifier/expression.
- Все operators имеют null/empty/wrong-type tests.
- Pagination не пропускает и не повторяет строки при равных sort values.
- Старый cursor дает `staleCursor`.
- Number sort/aggregate точен за пределами JavaScript safe integer.
- Query не делает N+1 reads.
- Absolute path не попадает в `DatabaseRow`.

### Проверка

- Rust compiler/query matrix tests;
- malicious operand tests;
- adapter contract tests;
- generated bindings check;
- `npm run verify` и manual Tauri query fixture.

### Data impact

Read-only относительно durable database files.

## 11. DB-07 — Incremental watcher, events и multi-window convergence

Статус: реализовано в текущем worktree.

### Цель

Обновлять только затронутую projection и синхронизировать открытые окна.

### Основные файлы

- `src-tauri/src/watcher.rs`
- `src-tauri/src/commands/vault.rs`
- `src-tauri/src/database/projection.rs`
- новый `src-tauri/src/database/events.rs`
- `src-tauri/src/vault_context.rs`
- watcher/integration tests.

### Изменения

- Классифицировать manifest, record, view, template, note и container changes.
- Coalesce events по container и перепроверять fingerprints до commit.
- Связать own-write tracking с database mutations.
- Emit `database:changed`, `database:index-state`, `database:conflict`.
- Игнорировать события старой vault generation.
- Не запускать database projection при выключенном module state.

### Acceptance

- Внешний cell edit появляется во втором окне после invalidation/refetch.
- Own write не применяется дважды.
- Rapid rename + atomic replace не создает временную потерю membership.
- Corrupt external shard сохраняет last healthy projection read-only.
- Delayed callback старого vault не загрязняет новый.
- View-only edit не перестраивает records.

### Проверка

- notify PollWatcher integration tests;
- two-window event harness;
- failure and debounce tests;
- `npm run rust:test`, strict Clippy, `npm run verify`.

### Data impact

Только SQLite projection. Внешние изменения не исправляются автоматически.

## 12. DB-08 — Frontend store, lifecycle и navigation shell

Статус: реализовано в текущем worktree.

### Цель

Подключить read-only runtime к workspace без Table реализации.

### Основные файлы

- новая папка `src/components/workspace/database/`
- `use-database-store.ts`, controller, selectors, lifecycle, session state
- `src/components/workspace/use-tabs-store.ts`
- `src/components/workspace/tab-target.ts`
- `src/components/workspace/workspace-orchestration.tsx`
- новый `src/components/workspace/panels/databases-panel.tsx`
- `src/components/workspace/panel-definitions.tsx`
- `src/locales/resources.ts`.

### Изменения

- Добавить `database` tab kind и host sessions по tab/layer/block.
- Подписать controller на backend invalidation events.
- Нормализовать schemas/views/templates, query entries и diagnostics.
- Реализовать module enable/rebuild/disable lifecycle.
- Databases panel показывает containers/views/status и открывает placeholder tab.
- Store очищается по vault generation, а hidden stale queries не refetch-ятся.

### Acceptance

- `workspace.tsx` не получает database data/callback jungle.
- Открытие одной базы повторно активирует tab; explicit new tab создает второй.
- Смена vault отменяет requests и очищает store.
- Disabled module не оставляет panel/tab entry points.
- Broken database видна с diagnostic, но не ломает Files/notes.
- Selectors не перерисовывают весь panel при изменении одного host session.

### Проверка

- pure store/lifecycle/navigation Vitest;
- localization guard;
- `npm run verify`;
- browser manual shell + Tauri runtime state.

### Data impact

Нет database writes. Session/config меняется только через уже versioned settings.

## 13. DB-09 — Read-only Table и saved view navigation

Статус: реализовано в текущем worktree.

### Цель

Доказать query/render path на большой базе до разрешения mutations.

### Основные файлы

- `database-workspace.tsx`, header, view tabs, toolbar/status banner
- `layouts/table-view.tsx`
- query key/cache/selectors
- `editing/cell-selection.ts`
- layout-specific tests и localization resources.

### Изменения

- ARIA grid с vertical/horizontal virtualization.
- Title и frozen columns, width/order/visibility из view.
- Keyset infinite loading, skeleton, retry и stale refresh.
- Selection/navigation по stable IDs без редактирования.
- Nested/flat rows, breadcrumbs, group headers и aggregate footer.
- Quick search только в session; saved filter/sort пока read-only.

### Acceptance

- Первый экран не монтирует/получает все 10 000 rows.
- Scroll остается при background refresh с тем же anchor.
- Stale cursor перезапрашивает первую page без смешивания generations.
- Keyboard arrows/selection работают через virtual boundaries.
- Title всегда первая/frozen.
- Error следующей page не скрывает ранее загруженные rows.

### Проверка

- query cache/selection Vitest;
- component focus/ARIA tests;
- native manual 10 000-row scroll;
- `npm run verify`.

### Data impact

Read-only. Это Gate B.

## 14. DB-10 — Создание базы, schema и view mutations

Статус: частично. Создание standalone/attached базы и базового property работает;
полные CRUD/reorder для schema, options, views и templates ещё не реализованы.

### Цель

Впервые безопасно создавать v1 container и менять его структуру под feature
flag, еще без редактирования record values.

### Основные файлы

- новые backend `database/mutations.rs`, `recovery.rs`
- `database/format.rs`, commands, watcher integration
- bundle/layer creation code
- DatabasePort mutation methods и generated bindings
- schema/view dialogs, header/toolbar, Databases panel
- localization and tests.

### Изменения

- Создать standalone folder + `ambd.json` + default view shard.
- Создать attached database layer как `ambd.json`, не `Metadata.md`.
- Добавить property/option/view create, update, reorder и delete preview.
- Все writes используют CAS, atomic helper, history и own-write registration.
- Destructive/multi-manifest operations используют recovery journal.
- Lock проверяется backend.
- View settings autosave semantic patches с flush/revision conflict.

### Acceptance

- Standalone creation не создает `.md`.
- Attached creation сохраняет основную note без изменения Markdown body.
- Title system field нельзя удалить/скрыть из Table.
- Rename property не меняет ID/YAML key.
- Used option/property delete требует preview и идет в `.ambd/trash`.
- Stale manifest/view revision ничего не перезаписывает.
- Crash/failure injection оставляет исходник либо recoverable journal.

### Проверка

- Rust atomic/CAS/recovery tests;
- frontend view autosave conflict tests;
- generated bindings check;
- manual create both modes in Tauri;
- `npm run verify`.

### Data impact

Первый PR, создающий `ambd.json`, `.ambd/views` и `.ambd/trash`. Только при
явно включенном experiment и module toggle.

## 15. DB-11 — Record values, simple cells и edit queue

Статус: частично. Базовые typed cells, per-row serialization, CAS и durable
value-batch recovery работают; clipboard range, persistent drafts и полный undo
ещё не реализованы.

### Цель

Редактировать Text, Number, Checkbox, Date, Select, Multi-select, Status и URL с
durable CAS и optimistic UI.

### Основные файлы

- backend record value mutation/validation/projection
- `.ambd/records` writer и history path
- DatabasePort `applyDatabaseValueBatch`
- `database-edit-queue.ts`, `cell-editor-layer.tsx`
- typed cell/value controls
- store optimistic/conflict actions.

### Изменения

- Single/multi-cell typed mutations с operation ID и expected revisions.
- Queue serialization по cell/resource, Text coalescing и lifecycle flush.
- Portal editors, string decimal draft, immediate Checkbox, option popovers.
- Durable success + SQLite failure возвращает success + rebuild warning.
- Inline validation/error/conflict markers.
- Undo session coalescing для Text values.

### Acceptance

- Быстрый ввод + закрытие host сохраняет последнюю версию.
- Два окна не затирают одну record revision.
- Number не проходит через JS/Rust float.
- Invalid batch не пишет ни одной ячейки.
- Повтор operation ID не применяет mutation дважды.
- Durable success не откатывается UI из-за index failure.
- Editor draft переживает virtual cell unmount.

### Проверка

- Rust value/atomic/idempotency/failure tests;
- queue/state/component Vitest;
- Tauri rapid edit + multi-window manual scenario;
- `npm run verify`.

### Data impact

Создает/изменяет `.ambd/records/<note-id>.json` и history snapshots.

## 16. DB-12 — Rows, Title, membership и sub-items

Статус: частично. Blank row создаётся как Markdown note с record shard;
rename/move/nest/lift/delete и property mapping между базами ещё не реализованы.

### Цель

Создавать реальные Markdown rows и безопасно менять их filesystem membership.

### Основные файлы

- backend database structural plans/mutations/recovery
- existing `bundle/`, `index/refactor.rs`, history/trash integration
- Table row actions и operation preview dialog
- tree/workspace mutation fan-out tests.

### Изменения

- Create blank row с stable `amby-id` и unique normalized Title.
- Title edit через filesystem rename preview, не value write.
- Add existing note через safe move.
- Move row между databases с explicit property mapping.
- Nest/lift sub-items и category-folder handling.
- Delete parent: bundle или lift children; restore сохраняет note IDs.
- Exclusion оставляет старый record shard неактивным.

### Acceptance

- Каждая row — реальный `.md`, видимый при module-off.
- Rename/move сохраняет body, BOM, line endings, relations и open tab identity.
- Duplicate normalized Title отклоняется до filesystem mutation.
- Nested database boundary не пересекается неявно.
- Cycle/self-descendant move невозможен.
- Failure на любом шаге дает исходное состояние либо resume/rollback.
- Workspace tree/tabs/doc stores применяют backend `pathChanges`, а не угадывают.

### Проверка

- Rust structural success/failure/collision/rollback tests;
- workspace mutation integration tests;
- Tauri create/move/nest/delete/restore scenarios;
- `npm run verify`.

### Data impact

Создает и перемещает реальные notes/bundles; multi-file actions журналируются.

## 17. DB-13 — Side peek и два раздела Inspector

Статус: частично. Side Peek использует общий editor/autosave и writable lease;
resize, inspector targeting, focus restore и origin-context navigation не завершены.

### Цель

Открывать row как полноценную страницу, не дублируя document/autosave model.

### Основные файлы

- `database/peek/database-side-peek.tsx`
- `database/peek/editor-surface-lease.ts`
- `document-editor.tsx` и editor chrome для compact host
- `use-doc-store.ts`, document loading/autosave hooks
- `panel-registry.tsx`, Info panel/property presenter
- shared property value controls.

### Изменения

- Side peek с resize, previous/next, full-page и restore focus.
- Markdown body использует существующий DocumentEditor/useDocStore/autosave.
- Один writable editor lease на note в одном окне.
- Inspector target отдает приоритет открытой database row.
- Разделы `Свойства базы` и `Локальные свойства` имеют разные storage actions.
- Open full page сохраняет origin database/view/note context.

### Acceptance

- Редактирование body из peek имеет те же revision conflicts и recovery drafts,
  что обычная note.
- Открытие той же note в двух surfaces не запускает двух writers.
- Ошибка flush не закрывает peek и не теряет draft.
- Закрытие возвращает keyboard focus в исходную virtual cell/card.
- Right panel возвращается к active tab после закрытия peek.
- Compact/focus mode использует overlay без недоступных controls.

### Проверка

- editor lease/inspector priority/lifecycle Vitest;
- existing autosave/conflict regression suite;
- Tauri peek → edit → full page → return;
- `npm run verify`.

### Data impact

Новых форматов нет. Это Gate C для opt-in базового использования.

## 18. DB-14 — List и Gallery

Статус: частично. Виртуализированные List/Gallery и pagination существуют;
configured secondary fields, inline edit и полный preview fallback не завершены.

### Цель

Добавить два layout поверх общей row/query/edit модели без отдельных data stores.

### Основные файлы

- `database/layouts/list-view.tsx`
- `database/layouts/gallery-view.tsx`
- gallery preview resolver
- shared row/card components и tests.

### Изменения

- List: nested/flat, breadcrumbs, secondary fields, inline simple edits.
- Gallery: virtualized grid rows, card fields, configured preview fallback.
- Lazy asset URLs и safe missing/corrupt placeholders.
- Общие side peek, selection, pagination, filters и sorts.

### Acceptance

- Layout switch не создает второй query при совпадающем field set/query key.
- Gallery preview следует точному fallback order.
- Remote/missing assets не загружаются как внешние URLs.
- List indentation и breadcrumbs соответствуют sub-item mode.
- Edit/conflict state виден одинаково после переключения layout.
- Большая Gallery не монтирует все cards.

### Проверка

- preview choice/query reuse tests;
- component accessibility tests;
- browser/Tauri manual responsive layouts;
- `npm run verify`.

### Data impact

Только существующий view shard при сохранении layout options.

## 19. DB-15 — Board и атомарный drag

Статус: частично. Virtual lanes, CAS drag, keyboard move и vertical pagination
работают; global lane counts и manual order ещё не реализованы.

### Цель

Добавить группировку Status/Select и безопасное перемещение карточек.

### Основные файлы

- `database/layouts/board-view.tsx`
- board drag/model utilities
- shared view group controls
- backend query count coverage при необходимости.

### Изменения

- Lanes по Status/single Select, включая empty.
- Horizontal lane и vertical card virtualization.
- Drag меняет одно typed value с optimistic pending state.
- Keyboard alternative для смены lane.
- Sort/manual order определяет card order внутри lane.

### Acceptance

- Multi-select/Relation нельзя выбрать как v1 group field.
- Failed drag возвращает card в исходную lane без scroll jump.
- Lane counts относятся ко всему result, а не текущей page.
- Drag handle не открывает side peek.
- Keyboard-only пользователь может выполнить то же перемещение.
- Внешнее изменение group value корректно инвалидирует card/lane.

### Проверка

- pure board grouping/optimistic rollback tests;
- keyboard component tests;
- Tauri pointer drag + multi-window refresh;
- `npm run verify`.

### Data impact

Меняет обычное Status/Select value; нового формата нет.

## 20. DB-16 — Relations и Files & media

Статус: частично. Durable format/query и row-scoped asset import существуют;
relation/files editors и полный lifecycle UI ещё не реализованы.

### Цель

Завершить сложные v1 property types и portable relation behavior.

### Основные файлы

- backend relation projection/inverse query
- schema mutation recovery для двух manifests
- asset import/bundle integration
- relation/files cells и picker
- diagnostics/search tests.

### Изменения

- Relation picker с paginated target search и one/many cardinality.
- Canonical forward edges; inverse вычисляется.
- Двусторонняя schema relation изменяет два manifests через journal.
- Missing/outsideDatabase targets сохраняются и диагностируются.
- Files импортируются в row bundle assets до value reference.
- Удаление value не удаляет asset автоматически.

### Acceptance

- Relation переживает rename/move/delete/restore target.
- Inverse не дублируется в durable record.
- Partial update двух manifests невозможен без recoverable journal.
- Asset path не выходит из row bundle через symlink/traversal.
- Failed import не создает value на отсутствующий asset.
- Gallery безопасно использует media property.

### Проверка

- Rust relation/asset/security/recovery tests;
- picker/card tests;
- Tauri cross-database relation и asset lifecycle;
- `npm run verify`.

### Data impact

Relation values остаются в record shards; assets — в row bundle.

## 21. DB-17 — Templates, history и Undo

Статус: частично. Default template применяется при создании row, writes получают
history snapshots; template CRUD/picker, grouped history и safe inverse Undo не завершены.

### Цель

Добавить несколько templates базы и единый восстанавливаемый пользовательский
цикл для schema/view/value operations.

### Основные файлы

- backend template format/mutations/application
- history snapshot integration для `.ambd` resources
- frontend template picker/editor/default selection
- database undo coordinator.

### Изменения

- CRUD/reorder/default template с CAS.
- Создание row применяет body/default values один раз.
- View/board context overrides конфликтующие template defaults.
- Template edit не меняет существующие rows.
- Undo вызывает безопасную inverse/recovery mutation с revision checks.
- Batch history отображается одной операцией.

### Acceptance

- Несколько templates и default сохраняются после rebuild/copy vault.
- Новый row получает новый note ID и lossless Markdown envelope.
- Context override имеет документированный приоритет.
- Изменение template не переписывает rows.
- Undo не затирает внешний edit и сообщает conflict.
- History cleanup не удаляет активный recovery journal.

### Проверка

- Rust template/history/revision tests;
- frontend template precedence/undo tests;
- Tauri create from template/undo/external edit;
- `npm run verify`.

### Data impact

Создает `.ambd/templates` и history snapshots; формат уже versioned.

## 22. DB-18 — Linked views и explicit legacy migration

Статус: частично. Portable reference парсится и рендерится в изолированном host;
drag insertion, editable overrides и explicit legacy migration не реализованы.

### Цель

Заменить prototype table block ссылкой на настоящую базу без скрытой конверсии.

### Основные файлы

- `tiptap/amby-block-node.ts`
- новый `tiptap/database-block-view.tsx`
- Markdown parser/serializer compatibility fixtures
- legacy `AmbyBlockView.tsx`/sidecar reader
- linked-view host/session/drag integration
- migration preview/backend journal.

### Изменения

- Читать reference JSON из portable `amby-db` fence.
- Linked host использует source data и собственные local overrides.
- Drag saved view из Databases panel вставляет typed reference node.
- Missing/disabled/unsupported source дает inert byte-preserved placeholder.
- Legacy `.amby/blocks/<id>.json` остается read-only.
- Explicit migration создает database/Markdown rows и заменяет fence только
  после полного success.

### Acceptance

- Reference fence round-trip byte-exact при unrelated editor edit.
- Linked filter/layout не меняет source view.
- Value edit сразу виден в source и других linked hosts.
- Missing database не удаляет reference.
- Legacy block никогда не мигрирует при scan/open.
- Failed migration оставляет старый fence и sidecar пригодными для повторения.

### Проверка

- Markdown golden acceptance/rejection fixtures;
- legacy migration failure/rollback tests;
- linked host/store isolation tests;
- browser and Tauri drag/open scenarios;
- `npm run verify`.

### Data impact

Reference живет в Markdown. Legacy conversion — только explicit journaled action.

## 23. DB-19 — Batch, clipboard и CSV

Статус: частично. Pure TSV/CSV planners и journaled value batch существуют;
selection UI, paste orchestration и CSV import/export commands/dialogs не реализованы.

### Цель

Добавить массовые операции без частичных writes и неявной идентификации rows.

### Основные файлы

- `editing/clipboard.ts`, selection и batch UI
- backend batch plans/recovery
- CSV import/export commands and dialogs
- text file import/export storage integration
- tests/fixtures.

### Изменения

- TSV copy/paste rectangle с typed preflight.
- Row multi-select: property/relation/move/delete actions.
- CSV mapping/types/paths preview.
- CSV v1 только создает новые rows.
- Export current view либо whole database.
- Relation/media используют переносимое представление, не абсолютные paths.

### Acceptance

- Одна invalid cell блокирует весь paste до исправления.
- Unknown Select option не создается неявно.
- CSV совпадение Title никогда не обновляет существующую note.
- Import failure дает целый rollback/resume, не половину rows.
- Export order соответствует выбранному view.
- Update mode без explicit `amby-id` отсутствует из v1 UI/API.

### Проверка

- pure TSV/CSV mapping tests;
- Rust batch recovery/failure tests;
- Tauri large paste/import/export/rollback;
- `npm run verify`.

### Data impact

Batch меняет existing durable resources через один recovery journal; CSV создает
только новые notes/records.

## 24. DB-20 — YAML two-way sync и field conflicts

Статус: частично. Backend sync с CAS/history/rollback, conflict projection/IPC и
разрешение конфликта из Side Peek работают; создание/редактирование bindings и
полный Inspector UI ещё не реализованы.

### Цель

Безопасно связать простые database properties с YAML frontmatter.

### Основные файлы

- новый `src-tauri/src/database/yaml_sync.rs`
- frontmatter lossless splice helpers
- record `yamlSyncBases`
- conflict projection/IPC/events
- inspector conflict UI and tests.

### Изменения

- Preflight binding key/type по всем active rows.
- Three-way compare: base, current shard, current YAML.
- Импорт/экспорт только Text, Number, Checkbox, Date, Select, Multi-select, URL.
- Field conflict предлагает shard/YAML/manual resolution.
- Note and record revisions проверяются вместе.
- Relation/Files остаются Amby-only.

### Acceptance

- Одностороннее изменение синхронизируется и обновляет base.
- Разные одновременные изменения никогда не решаются last-write-wins.
- Malformed/unsupported YAML не переписывается.
- `amby-id`, unknown YAML, BOM и line endings сохраняются.
- Property rename не меняет stable YAML key.
- Одновременный conflict блокирует только поле, а не всю note/base.

### Проверка

- Rust three-way matrix и byte-preservation fixtures;
- conflict UI/store tests;
- Tauri external-editor scenarios;
- `npm run rust:test`, strict Clippy, `npm run verify`.

### Data impact

Первый optional path, меняющий user-managed YAML. Только после explicit binding,
preflight, snapshot и revision check.

## 25. DB-21 — Hardening, performance и release gate

Статус: не завершено. Аудит 2026-09-04 обнаружил функциональные пробелы между
контрактом и UI, а native storage runner в этой macOS-сессии не вернул
структурированный PASS. Модуль доступен как явный opt-in `beta`, но не входит в
новый Standard preset до закрытия всех platform gates.

### Цель

Доказать production readiness и перевести модуль из experiment в `ready` без
скрытого включения существующим пользователям.

### Основные файлы

- benchmark generator/scripts и `docs/performance-baseline.md`
- native storage/UI contract scenarios
- release/readiness documentation
- module registry/settings/localization
- security and recovery tests.

### Изменения

- Baseline 10 000 rows × 20 properties на macOS/Windows/Linux.
- Зафиксировать p95 для first page, filter/sort, cell commit и incremental update.
- Проверить memory/DOM counts Table/Board/List/Gallery.
- Прогнать corruption, disk-full, permission, stale window и crash recovery.
- Проверить module off/on, downgrade и full container portability.
- Снять experimental gate, поставить module status `ready`.
- Сохранить explicit enabled choice существующих layouts.

### Фактический результат после аудита

- `databases` имеет `status: beta`, доступен вручную без зависимости от legacy
  `experimental.databasesV1` и не включается автоматически в новые Standard presets.
- Исправлено обычное открытие базы: оно заменяет активную вкладку; отдельная
  вкладка создаётся только явной командой «Открыть копию».
- Existing attached database переключается внутри слоя заметки без повторного
  создания `ambd.json`; слой рендерит общий DatabaseWorkspace.
- Table читает реальные properties/options, создаёт строки и базовые поля,
  редактирует поддерживаемые typed values через CAS batch и обновляет projection.
- Side Peek загружает общий Markdown editor с единым writable lease; external
  database events обновляют runtime, catalog и mounted hosts.
- Value batch получил durable `.ambd/recovery` journal, raw-revision backups,
  идемпотентный completed result и rollback, который не перезаписывает более
  позднее внешнее изменение; повторное использование `operationId` с другим
  payload отклоняется и до, и после перезапуска.
- `locked` снова соответствует format contract: schema mutation заблокирована,
  но редактирование values и YAML sync разрешены.
- Source write больше не маскируется под неуспешный create/commit, если уже после
  него не удалось перестроить derived projection: IPC возвращает durable result
  с предупреждением и допускает безопасный повтор rebuild.
- Row creation публикует новую Markdown-заметку в основной note index до rebuild,
  поэтому подавленное собственное watcher-событие больше не оставляет `db_members`
  пустым. Создатель view пишет contract-совместимые `openMode`, `density` и Title
  field; ранее созданные DB-10 aliases читаются совместимо без изменения файлов.
- Headless gate: TypeScript, ESLint, 463 Vitest, Prettier, Knip, Rustfmt, strict
  Clippy и 257 Rust tests проходят; 1 large-vault smoke остаётся explicit ignored.
  Generated bindings повторно воспроизводятся
  byte-for-byte; `git diff` остаётся ожидаемым до фиксации нового IPC в commit.
- Native storage runner без structured report не считается PASS. Windows/Linux
  release evidence и полный native UI сценарий остаются обязательными для DB-21.

### Acceptance

- Полный `npm run verify` зеленый.
- `npm run tauri build` проходит на release platforms.
- Native scenarios и performance budgets документированы как PASS.
- Удаление SQLite и rebuild не меняет пользовательский result.
- Module-off показывает все Markdown rows как обычные notes/folders.
- Ни одна capability не требует broad static filesystem scope.
- Migration/recovery/rollback описаны в release notes.
- Нет known P0/P1 data-loss или security defects.

### Data impact

Новых форматов нет. Меняется доступность функции, но не включенность пользователя.

## 26. Что не входит в backlog v1

- Formula и Rollup.
- Multi-source views и SQL `UNION ALL` UI.
- Автоматический CSV update; будущий режим только по explicit `amby-id`.
- Database form/public sharing/cloud collaboration.
- Database в secondary split pane.
- Remote media URLs.
- Автоматическая миграция `Metadata.md` или legacy `.amby/blocks`.
- Автоматическая очистка orphan record values/assets.

Эти функции не добавляются «заодно» в один из PR. Для каждой нужен отдельный
format/runtime/frontend contract после стабильного v1.

## 27. Definition of done каждого PR

PR готов к review, только если:

1. Scope соответствует одному пункту этого backlog.
2. Новые типы и ошибки имеют стабильные имена и exhaustive handling.
3. Failure path проверен до happy UI path, если PR делает durable write.
4. Нет direct filesystem access из frontend.
5. Нет manual edits generated bindings.
6. Нет hard-coded visible TSX strings.
7. Нет broad Tauri permissions.
8. Touched files отформатированы без repository-wide churn.
9. `npm run verify` выполнен; пропущенная platform check явно указана.
10. PR description содержит data-format impact, rollback и manual scenarios.

## 28. Первый практический шаг

Начать нужно с отдельного DB-00 docs commit, затем DB-01. Реализацию parser или
Table до безопасного async module lifecycle начинать нельзя: иначе текущий
синхронный toggle сможет размонтировать UI раньше, чем database edits будут
сохранены, а legacy layer action продолжит создавать неверный формат.

После DB-01 следующий кодовый slice DB-02 не должен читать vault. Это сохраняет
границу, на которой feature можно многократно включать/выключать без влияния на
пользовательские файлы.
