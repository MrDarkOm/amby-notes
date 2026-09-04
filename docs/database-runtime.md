# Runtime, SQLite и IPC баз данных Amby

Статус: proposed contract
Версия документа: 1
Дата: 2026-09-04

Документ продолжает
[архитектуру системы](./database-system.md),
[пользовательские сценарии](./database-user-flows.md) и
[durable-формат](./database-format.md). Он определяет перестраиваемую
SQLite-проекцию, границу Tauri IPC, порядок mutations и состояние frontend.

## 1. Граница ответственности

Runtime состоит из трех слоев:

```text
React / Zustand
      │ typed DatabasePort
      ▼
Tauri commands / browser adapter
      │ validated domain requests
      ▼
database domain service
      ├── durable files: ambd.json + .ambd/*      source of truth
      └── .amby/notes.db                          rebuildable projection
```

Основные правила:

- frontend не читает и не пишет файлы базы напрямую;
- пользовательские данные считаются сохраненными только после durable write;
- SQLite никогда не является единственной копией schema, values, views или
  templates;
- ответ mutation отделяет результат durable write от состояния индекса;
- отключение Databases module не меняет durable files;
- property kernel остается доступным приложению независимо от модуля;
- все IPC-типы генерируются Specta; `src/lib/bindings.ts` вручную не меняется.

Database projection живет в существующем `.amby/notes.db`. Отдельный SQLite-файл
не используется: единая транзакция с таблицей `notes` нужна для membership,
relations, поиска и удаления. Модульность обеспечивается кодовой границей,
настройкой и отдельными таблицами с префиксом `db_`, а не вторым файлом.

## 2. Backend-модули

`lib.rs` только регистрирует команды. Предлагаемая структура:

```text
src-tauri/src/
├── commands/database.rs
└── database/
    ├── mod.rs
    ├── model.rs          # durable и IPC domain types
    ├── discovery.rs      # поиск контейнеров и owning database
    ├── format.rs         # parse/validate/preserve unknown fields
    ├── projection.rs     # full rebuild и incremental projection
    ├── query.rs          # AST validation и SQL compilation
    ├── mutations.rs      # single-file и journaled operations
    ├── yaml_sync.rs      # three-way field sync
    └── recovery.rs       # inspect/resume/rollback
```

Перед editable slice текущий `VaultContext` получает узкий `IndexAccess`:

- один serialized writer connection;
- небольшой пул read connections в WAL mode;
- immutable `vaultRoot` и `vaultGeneration` на время операции;
- отмена долгого query при смене vault или закрытии вкладки.

Filesystem I/O и JSON parsing не выполняются под SQLite writer lock. Mutation
держит блокировки только на конкретные durable resources, затем коротко
публикует projection transaction. Блокировки берутся в детерминированном порядке
по canonical vault-relative path, чтобы batch не создавал deadlock.

## 3. Версии runtime

`index_metadata` получает независимые ключи:

| Ключ                         | Назначение                                  |
| ---------------------------- | ------------------------------------------- |
| `database_schema_version`    | Версия SQLite DDL database projection       |
| `database_projection_epoch`  | Новый ULID после полного rebuild            |
| `database_projection_seq`    | Номер incremental transaction               |
| `database_projection_status` | `healthy`, `degraded` или `rebuildRequired` |

Cursor и UI snapshot используют пару `{ epoch, seq }`. После rebuild старые
cursors гарантированно становятся недействительными, даже если счетчик снова
начался с нуля.

SQLite migration является миграцией кэша. Она выполняется повторяемо через
schema introspection и одну DDL transaction. Если существующий индекс нельзя
безопасно обновить, backend закрывает connections, перемещает поврежденный
SQLite-файл в `.amby/recovery/index/` и полностью строит новый. Durable database
files при этом не меняются.

## 4. Нормализованная SQLite-проекция v1

Ниже перечислены логические поля. Точный DDL фиксируется рядом с реализацией и
проверяется schema snapshot test.

### 4.1 Базы и schema

```text
db_databases
  database_id PK
  container_path UNIQUE
  attached_note_id NULL FK notes(id) ON DELETE SET NULL
  name
  icon
  cover_json NULL
  locked BOOL
  format_version
  manifest_revision
  projection_state        valid | staleReadOnly | unsupported | broken

db_properties
  database_id FK db_databases ON DELETE CASCADE
  property_id
  position
  name
  property_type
  page_visibility
  config_json
  yaml_key NULL
  yaml_direction NULL
  PK (database_id, property_id)

db_options
  database_id
  property_id
  option_id
  position
  name
  color
  status_group NULL
  PK (database_id, property_id, option_id)
```

`config_json` хранит только уже провалидированную проекцию typed config. Он не
исполняется и не передается в SQL как fragment. Неизвестные durable-поля
сохраняются format layer, но не обязаны попадать в SQLite.

### 4.2 Membership и иерархия

```text
db_members
  database_id FK db_databases ON DELETE CASCADE
  note_id UNIQUE FK notes(id) ON DELETE CASCADE
  parent_note_id NULL FK notes(id) ON DELETE SET NULL
  relative_path
  category_path
  depth
  title_sort_key BLOB
  PK (database_id, note_id)
```

`UNIQUE(note_id)` фиксирует правило одного owning database. Owner определяется
ближайшим родительским `ambd.json`. `parent_note_id` содержит только реального
родителя-строку; обычные промежуточные папки отражаются в `category_path`.

Поврежденный или отсутствующий manifest не заставляет runtime молча передавать
строки более далекой внешней базе. Такой subtree получает diagnostic и остается
в предыдущей безопасной projection до явного исправления или подтвержденного
удаления manifest.

### 4.3 Typed values

```text
db_values
  database_id
  note_id
  property_id
  value_type
  canonical_json
  text_value NULL
  text_sort_key BLOB NULL
  decimal_value NULL
  decimal_sort_key BLOB NULL
  bool_value NULL
  date_start NULL
  date_end NULL
  date_start_key INTEGER NULL
  date_end_key INTEGER NULL
  date_precision NULL        date | instant
  option_id NULL
  source_revision
  PK (database_id, note_id, property_id)
```

Для multi-value типов используются отдельные таблицы:

```text
db_value_options(database_id, note_id, property_id, option_id, position)
db_value_files(database_id, note_id, property_id, asset_id, position,
               relative_path, name, mime_type, size_bytes)
db_relation_edges(source_database_id, source_note_id, property_id,
                  target_note_id, position, target_state)
```

`target_state` равен `resolved`, `outsideDatabase` или `missing`. Foreign key на
`target_note_id` намеренно не запрещает unresolved relation; при появлении цели
projection обновляет состояние без изменения record shard.

`canonical_json` нужен для точного round-trip IPC и diagnostics. Typed columns
нужны для фильтрации и индексов. Они всегда строятся из canonical value и сами
не являются источником данных.

### 4.4 Точное сравнение Number

Decimal string остается точным значением. Runtime дополнительно строит
канонический бинарный `decimal_sort_key`, сравнимый SQLite побайтно с тем же
результатом, что arbitrary-precision decimal comparison. Алгоритм обязан:

- нормализовать знак, ноль, exponent и trailing zeros;
- сохранять правильный порядок отрицательных и положительных чисел;
- иметь golden tests на очень большие значения и разный scale;
- отклонять значения за документированными лимитами до записи.

`Sum`, `Average`, `Min` и `Max` вычисляются exact-decimal aggregate на backend и
возвращаются decimal string. SQLite `REAL` не используется как authoritative
значение или ключ сортировки.

### 4.5 Текст и даты

`text_sort_key` вычисляется backend из Unicode-normalized case-folded строки и
версируется вместе с projection schema. Это исключает зависимость от ASCII-only
`NOCASE` и различий системной locale.

Date-only индексируется как календарный день. Date-time сначала валидируется с
offset, затем индексируется UTC epoch; исходная строка и IANA timezone остаются
в `canonical_json`. Сравнение date-only и date-time внутри одного property
запрещается schema/config, а не угадывается query compiler.

### 4.6 Views, templates и diagnostics

```text
db_views
  database_id
  view_id
  position
  name
  layout
  revision
  query_json
  layout_json
  projection_state
  PK (database_id, view_id)

db_templates
  database_id
  template_id
  position
  name
  revision
  body
  values_json
  projection_state
  PK (database_id, template_id)

db_yaml_conflicts
  database_id
  note_id
  property_id
  base_json
  shard_json
  yaml_json
  note_revision
  record_revision
  PK (database_id, note_id, property_id)

db_diagnostics
  diagnostic_id PK
  scope_kind
  scope_key
  code
  severity
  details_json
  first_seen_at
  last_seen_at
```

View filter/sort/group остается валидированным AST в `query_json`. Отдельная
нормализация каждого condition не нужна: SQL compiler строит план при запросе,
а индексы находятся на typed value tables.

### 4.7 Поиск

```text
db_values_fts
  database_id UNINDEXED
  note_id UNINDEXED
  property_id UNINDEXED
  searchable_text
```

FTS включает Text, URL и отображаемые имена Select/Status/Multi-select. Relation
ищется через title цели, но не дублирует его в durable value. Global Search
объединяет `notes_fts` и `db_values_fts`, удаляет дубликаты по `note_id` и явно
указывает источник совпадения.

## 5. Индексы

Минимальный набор:

- `db_databases(container_path)`;
- `db_members(database_id, parent_note_id, note_id)`;
- `db_members(database_id, title_sort_key, note_id)`;
- `db_values(database_id, property_id, text_sort_key, note_id)`;
- `db_values(database_id, property_id, decimal_sort_key, note_id)`;
- `db_values(database_id, property_id, date_start_key, note_id)`;
- `db_values(database_id, property_id, bool_value, note_id)`;
- `db_values(database_id, property_id, option_id, note_id)`;
- `db_value_options(database_id, property_id, option_id, note_id)`;
- `db_relation_edges(property_id, target_note_id, source_note_id)`.

Дополнительный индекс добавляется только после `EXPLAIN QUERY PLAN` и benchmark,
а не для каждого потенциального сочетания. Размер кэша не должен бесконтрольно
расти из-за duplicate JSON indexes.

## 6. Full rebuild

Полный rebuild проходит так:

1. Создать immutable snapshot списка путей и fingerprints.
2. Найти containers, notes и shards, не заходя внутрь служебных каталогов как в
   обычные заметки.
3. Прочитать и валидировать durable files вне SQLite transaction.
4. Рассчитать ownership, hierarchy, typed columns, relations и diagnostics.
5. Если vault сменился или snapshot устарел, отменить публикацию и повторить.
6. В одной transaction заменить только `db_*` projection, обновить epoch/seq и
   FTS.
7. Emit одного события о новой projection generation.

WAL readers продолжают видеть предыдущую целую projection до commit. Ошибка
чтения одной базы не превращается в удаление всех ее данных:

- при наличии предыдущей projection база остается `staleReadOnly`;
- при чистом rebuild создается broken-container diagnostic по vault-relative
  path;
- автоматический repair durable file запрещен.

## 7. Incremental projection и watcher

Watcher классифицирует изменения:

| Путь                                 | Перестраивается                              |
| ------------------------------------ | -------------------------------------------- |
| `ambd.json`                          | schema, ownership затронутого subtree, views |
| `.ambd/records/<id>.json`            | одна строка, relations, YAML conflict        |
| `.ambd/views/<id>.json`              | один view                                    |
| `.ambd/templates/<id>.json`          | один template                                |
| row `.md`, bundle rename/move/delete | note fields, membership, YAML binding        |
| nested container create/move/delete  | ownership всего затронутого subtree          |

События coalesce-ятся по container с коротким debounce. Перед incremental commit
backend снова проверяет fingerprints. Собственные записи отмечаются существующим
`WatcherState`, но command сам обновляет projection; watcher-event остается
страховкой, а не создает вторую mutation.

При выключенном Databases module watcher продолжает обычный note index, но не
парсит database shards. Старая `db_*` projection не используется для query.
Повторное включение всегда начинает с validation и full database rebuild.

## 8. Query contract

```ts
interface DatabaseQueryRequest {
  expectedGeneration: number
  databaseId: string
  source:
    | { kind: "savedView"; viewId: string; expectedRevision?: string }
    | { kind: "inline"; spec: DatabaseQuerySpec }
  overrides?: DatabaseQueryOverrides
  page: { limit: number; cursor: string | null }
}

interface DatabaseQueryResult {
  database: DatabaseHeader
  projection: { epoch: string; seq: number }
  rows: DatabaseRow[]
  nextCursor: string | null
  groups: DatabaseGroup[]
  aggregates: DatabaseAggregate[]
  diagnostics: DatabaseDiagnostic[]
}
```

`DatabaseRow` содержит system fields, typed property values, `parentNoteId`,
`depth`, breadcrumb и row revision. Он не содержит абсолютный путь. Media URLs
создаются через существующий asset boundary.

Query rules:

- page limit: backend constant, не более 200 в v1;
- cursor использует keyset pagination, а не `OFFSET`;
- opaque cursor содержит projection epoch/seq, hash нормализованного query,
  sort keys и последний `(databaseId, noteId)`;
- cursor от другой projection/query возвращает `staleCursor`, не пустую страницу;
- каждый sort имеет явный `nullsFirst`/`nullsLast` и стабильный ID tie-breaker;
- nested mode сортирует siblings; отфильтрованный child возвращается с
  breadcrumb, даже если parent сам не совпал;
- backend возвращает только поля, нужные текущему layout;
- board counts и footer aggregates считаются по полному filtered set, не по
  загруженной странице.

### 8.1 Compiler безопасности

Frontend передает только versioned `FilterNode`, `SortRule`, `GroupRule` и
`FieldRef`. Backend:

1. ограничивает размер/depth AST;
2. сверяет field IDs с текущей schema;
3. сверяет operator и operand с типом;
4. выбирает SQL fragment из закрытого enum;
5. передает все пользовательские данные параметрами;
6. добавляет execution budget и поддерживает отмену.

Raw SQL, SQL identifiers, collations и expressions из renderer не принимаются.
Property IDs также используются как bind values, а не вставляются в SQL.

## 9. IPC surface v1

Команды группируются по назначению, но используют общие typed requests.

Чтение:

- `get_database_module_state`;
- `list_databases`;
- `get_database`;
- `query_database`;
- `get_database_record`;
- `search_database_records`;
- `list_database_recovery`;
- `preview_database_operation`.

Быстрые mutations:

- `apply_database_value_batch`;
- `apply_database_schema_mutation`;
- `apply_database_view_mutation`;
- `apply_database_template_mutation`;
- `resolve_database_yaml_conflict`.

Структурные operations:

- `create_database`;
- `execute_database_operation`;
- `recover_database_operation`;
- `rebuild_database_projection`.

Структурные действия — attach/remove/delete database, add/move/lift rows, CSV
import и destructive schema changes — сначала вызывают preview. Preview
возвращает opaque `planId`, exact affected resources, conflicts, warnings и
expected revisions. `execute_database_operation(planId)` повторно проверяет все
revisions; устаревший plan не выполняется частично.

Небольшие изменения используют tagged enums вместо универсального JSON Patch.
Это сохраняет строгие Specta types и позволяет backend проверять семантику:

```ts
interface DatabaseMutationEnvelope<T> {
  operationId: string
  expectedGeneration: number
  databaseId: string
  originWindow: string
  expectedRevisions: ResourceRevision[]
  mutation: T
}
```

`operationId` генерируется frontend один раз и повторяется только для safe retry
того же запроса. Backend запоминает завершенные IDs в коротком idempotency log;
тот же ID с другим payload отклоняется.

## 10. Mutation protocol

### 10.1 Single-resource write

1. Проверить module state, vault generation, lock и permissions.
2. Разрешить resource IDs в canonical guarded paths.
3. Прочитать raw bytes и сверить expected revision.
4. Провести полную typed validation и YAML three-way merge.
5. Создать history snapshot при существующем содержимом.
6. Выполнить atomic write через established helper.
7. Обновить SQLite короткой transaction.
8. Вернуть outcome и emit invalidation event.

### 10.2 Multi-resource write

Schema relation pair, batch, CSV и filesystem moves используют `.ambd/recovery`
journal из format contract. Durable commit считается завершенным только после
финального journal marker. Resume/rollback идемпотентны; затронутая база не
принимает новые конфликтующие mutations до recovery.

### 10.3 Durable success, index failure

Если шаг 6 завершился, а SQLite update упал:

- команда возвращает success, потому что source of truth уже записан;
- `indexState` становится `rebuildRequired`;
- warning содержит только стабильный code, без требования повторить mutation;
- UI оптимистически применяет подтвержденное значение и предлагает rebuild;
- повтор с тем же `operationId` возвращает исходный success, а не пишет файл
  второй раз.

## 11. Mutation outcome

```ts
interface DatabaseMutationOutcome {
  operationId: string
  databaseId: string
  changedNoteIds: string[]
  changedResources: ResourceRevision[]
  pathChanges: PathChange[]
  projection: { state: IndexState; epoch: string; seq: number }
  warnings: DatabaseWarning[]
}
```

Отсутствие `pathChanges` отличает cell edit от rename/move. UI не должен заново
угадывать пути по Title.

## 12. Typed errors

Database commands возвращают `Result<T, DatabaseError>`, а не строку:

```ts
type DatabaseError =
  | { kind: "moduleDisabled" }
  | { kind: "vaultGenerationConflict"; actualGeneration: number }
  | { kind: "revisionConflict"; resource: ResourceRef; actualRevision: string }
  | { kind: "staleCursor" }
  | { kind: "stalePlan"; changedResources: ResourceRef[] }
  | { kind: "notFound"; resource: ResourceRef }
  | { kind: "duplicateTitle"; conflictingNoteId: string }
  | { kind: "databaseLocked" }
  | { kind: "readOnly"; reason: ReadOnlyReason }
  | { kind: "validation"; code: string; field?: FieldRef }
  | { kind: "yamlConflict"; noteId: string; propertyId: string }
  | { kind: "recoveryRequired"; operationId: string }
  | { kind: "indexUnavailable"; canRebuild: boolean }
  | { kind: "failed"; code: string; message: string }
```

Пути в ошибках vault-relative. Низкоуровневые OS details уходят в diagnostics
log, а не становятся пользовательским путем или SQL-текстом. Frontend adapter
преобразует union в `DatabaseOperationError`, сохраняя `kind` для UI; retry
разрешен только для явно retryable cases.

## 13. Backend events

```ts
interface DatabaseChangedEvent {
  vaultGeneration: number
  databaseId: string
  operationId: string | null
  originWindow: string | null
  epoch: string
  seq: number
  kind: "schema" | "values" | "views" | "membership" | "rebuild"
  changedNoteIds: string[]
}
```

События:

- `database:changed` — инвалидирует соответствующие query pages;
- `database:index-state` — меняет banner/availability;
- `database:conflict` — сообщает о новом YAML/external edit conflict.

Event является invalidation hint, не единственным источником состояния. Все окна
сравнивают `{ epoch, seq }`, а затем дочитывают данные. Same-origin event тоже
безопасно обработать повторно: revisions и operation ID делают обновление
идемпотентным.

## 14. Frontend boundary

Основной `StoragePort` получает составной `databases: DatabasePort`. Он всегда
типизирован и реализован обоими adapters; состояние `disabled` является
результатом capability, а не отсутствующим методом.

```text
src/lib/storage/database-port.ts
src/lib/storage/database-types.ts
src/lib/storage/desktop-database-adapter.ts
src/lib/storage/web-database-adapter.ts
```

Browser adapter соблюдает тот же contract. На первом этапе он может использовать
ограниченное localStorage-представление для fixtures, но production-sized browser
режим должен перейти на IndexedDB. Компоненты не ветвятся по Tauri/browser.

`useDatabaseStore` хранит только runtime state:

- module state и текущую projection generation;
- schema/views/templates по ID и revision;
- страницы query cache по нормализованному query key;
- pending operations по `operationId`;
- conflicts и diagnostics;
- локальные selection/edit/peek state.

Durable database values не копируются в глобальный workspace state целиком.
Query cache ограничен LRU и очищается при смене vault. Компоненты Table, Board,
List и Gallery получают один общий `DatabaseRowModel`; layout не создает свою
версию данных.

## 15. Оптимистическое редактирование

- Cell edit сразу появляется в cache с pending marker.
- Очередь сериализуется по `{ noteId, propertyId }`, но разные строки могут
  сохраняться параллельно до backend writer boundary.
- Следующая правка строится на revision подтвержденного либо pending результата.
- Success заменяет revision и снимает marker.
- Validation error возвращает прежнее значение и оставляет ввод доступным для
  исправления.
- Revision/YAML conflict не откатывается молча: ячейка показывает обе версии.
- Закрытие view, выключение модуля и unmount сначала flush-ят очереди.
- Batch/paste проходит полную preflight validation до первого optimistic apply.

Title edit не является обычной cell mutation: он вызывает filesystem rename
preview/execute и применяет возвращенные `pathChanges` ко всему workspace.

## 16. Lock и module state

Backend проверяет lock для каждой mutation, даже если UI уже скрыл control.

| Действие                      | Locked | Module disabled       |
| ----------------------------- | ------ | --------------------- |
| Читать/редактировать Markdown | да     | да                    |
| Читать database projection    | да     | нет                   |
| Менять database values        | да     | нет                   |
| Временный filter/search       | да     | нет                   |
| Менять schema/view/membership | нет    | нет                   |
| Recovery операции             | да     | отдельный entry point |

Отключение модуля:

1. frontend flush-ит pending value writes;
2. отписывается от database events и очищает query cache;
3. backend прекращает database projection work;
4. `db_*` tables могут остаться на диске как неиспользуемый кэш;
5. повторное включение валидирует durable files и делает full database rebuild.

## 17. Performance contract

Reference benchmark: 10 000 rows, 20 properties, 4 views, relations и 10%
multi-value fields. До утверждения абсолютных p95 после baseline обязательны
структурные гарантии:

- первый экран не загружает всю базу в Rust response или React;
- обычная query использует keyset pagination и не делает N+1 reads;
- cell edit не перестраивает весь container;
- изменение view не перестраивает values;
- full rebuild парсит файлы до начала SQLite write transaction;
- query можно отменить;
- размер result ограничен на backend;
- benchmark фиксирует query plan для title, option, date, number и relation.

После baseline отдельным решением фиксируются p95 бюджеты для macOS, Windows и
Linux; они становятся regression tests, а не обещанием без измерений.

## 18. Обязательные tests

### SQLite и projection

- полный rebuild после удаления `notes.db`, `-wal`, `-shm` дает тот же результат;
- nested container корректно перехватывает ownership;
- malformed shard не стирает последнюю здоровую projection;
- index failure после durable write возвращает success + `rebuildRequired`;
- exact decimal sort/aggregate не использует floating point;
- Unicode title/text sort одинаков на поддерживаемых ОС;
- unresolved relation переживает удаление и восстановление цели;
- FTS rebuild не создает duplicate matches.

### Query

- каждый operator проверен для типа, null и empty;
- query AST никогда не конкатенирует пользовательский текст в SQL;
- одинаковые значения имеют стабильный ID tie-breaker;
- cursor отклоняется после mutation/rebuild и при другом query hash;
- aggregates и board counts не зависят от page size;
- nested/flat возвращают правильные breadcrumb и parent IDs;
- cancellation освобождает read connection.

### IPC и concurrency

- generated bindings совпадают с Rust types;
- старая vault generation не пишет в новый vault;
- два окна не могут затереть одну revision;
- повтор одного `operationId` идемпотентен;
- тот же `operationId` с другим payload отклоняется;
- stale preview не выполняет filesystem mutation;
- module disabled отклоняет database calls без изменения файлов;
- lock проверяется backend для всех schema/view/membership mutations.

### Contract adapters

Один общий набор TypeScript contract tests запускается против desktop harness и
web adapter: CRUD values, query, conflicts, pagination, module toggle и recovery
имеют одинаковую наблюдаемую семантику.

## 19. Порядок реализации runtime

1. Выделить pure Rust model/validation для durable format и fixtures.
2. Добавить `db_*` DDL, full rebuild и schema snapshot tests.
3. Ввести `DatabasePort`, read-only list/get/query и generated IPC bindings.
4. Добавить incremental watcher projection и generation events.
5. Реализовать single-value CAS mutations и optimistic frontend queue.
6. Добавить views/templates/schema mutations.
7. Добавить journaled membership, relations, batch и CSV operations.
8. Добавить YAML sync/conflict resolution.
9. Запустить benchmark, зафиксировать p95 и расширять query planner по данным.

Каждый шаг остается отдельным небольшим PR. Первый implementation slice не
начинает Table UI, пока rebuild, typed query и revision conflict не доказаны
автоматическими tests.

## 20. Следующий контракт

[Frontend-контракт](./database-frontend.md) определяет state machines и component
boundaries для Table, Board, List, Gallery, side peek, editing queue и linked
views. Следующий шаг — разложить общий план на независимые implementation PR с
явными acceptance criteria.
