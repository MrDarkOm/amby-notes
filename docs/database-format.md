# Формат базы данных Amby

Статус: implemented v1 contract with additive computed/chart extensions
Версия документа: 1
Дата: 2026-09-04

Документ определяет durable-формат первой версии баз. Он следует
[архитектуре](./database-system.md) и
[пользовательским сценариям](./database-user-flows.md). SQLite-схема является
отдельной перестраиваемой проекцией этого формата.

## 1. Структура контейнера

```text
Персонажи/
├── Персонажи.json   (или устаревший ambd.json для обратной совместимости)
├── .ambd/
│   ├── views/
│   │   └── <view-id>.json
│   ├── templates/
│   │   └── <template-id>.json
│   ├── records/
│   │   └── <note-id>.json
│   ├── assets/
│   ├── recovery/
│   └── trash/
├── Алиса.md
└── Борис/
    ├── Борис.md
    └── assets/
```

`<Название_Контейнера>.json` (или `ambd.json` в старых версиях) — небольшой manifest и общая schema.
Использование именованного файла манифеста обеспечивает архитектурную симметрию со всеми слоями бандла (`.md`, `.canvas`, `.excalidraw`)
и автоматически исключается из списка дочерних строк в дереве файлов.
Часто изменяемые views, templates и record values вынесены в отдельные атомарные shards. Это уменьшает
конфликты между окнами и не требует переписывать всю базу при правке ячейки.

`.ambd/` является durable частью базы:

- переносится и копируется вместе с контейнером;
- исключается из note indexing и Files panel;
- не удаляется при rebuild SQLite;
- не считается временным кэшем;
- не исполняет содержащиеся данные как код.

Для attached database в том же каталоге присутствует одноименная основная
`.md`. Для standalone database основной заметки нет.

## 1.1. Источники истины и контракт хранения (ST-02)

- **Значения свойств заметок** — Markdown frontmatter файлов заметок в контейнере базы данных является основным источником истины. Значения записываются через точечный бегло-атомарный сплайс (`replace_yaml_binding_lossless`), сохраняя структуру Markdown, BOM, переносы строк и сторонние поля.
- **Схема и представления базы** — файл манифеста (`<Название_Контейнера>.json` / `ambd.json`) и сохранённые представления (`.ambd/views/`).
- **SQLite-проекция** — производный, полностью перестраиваемый кэш (`.amby/notes.db`). Удаление файла базы данных SQLite не приводит к потере пользовательских данных или свойств.
- **Идентичность свойств и ключи:**
  - `propertyId` — неизменяемый канонический ULID свойства в манифесте базы данных.
  - `storageKey` — неизменяемый ключ хранения в frontmatter заметки, задаваемый через `yamlBinding.key`.
  - `name` — отображаемое пользователю название свойства (например, "Дата завершения"). Изменение отображаемого имени не требует перезаписи frontmatter тысяч заметок.
- **Приоритет разрешения ключей при чтении:**
  1. Точное совпадение с `storageKey` (`yamlBinding.key`).
  2. Точное совпадение с `propertyId`.
  3. Регистронезависимое совпадение с `storageKey`.
  4. Точное совпадение с отображаемым `name` (legacy fallback).
  5. Регистронезависимое совпадение с `name` (legacy fallback).
- **Зарезервированные системные ключи:**
  - Системные ключи `amby-id`, `amby-title`, `amby-views`, `amby-database` и любые ключи с префиксом `amby-` зарезервированы ядром Amby.
  - Пользовательские свойства с именами `id` или `title` связываются с соответствующими пользовательскими YAML-ключами и никогда не подменяют `amby-id`. Пользовательским свойствам запрещено связываться с зарезервированными ключами.
- **Версионирование формата:**
  - Текущая версия durable-формата: `1`.
  - Неизвестные/будущие версии (`formatVersion > 1`): открываются в режиме **read-only** с диагностическим предупреждением; файл манифеста и заметки не перезаписываются.
- **Семантика значений:**
  - `0` и `false` являются валидными значащими значениями и не интерпретируются как пустота.
  - Очистка значения ячейки (пустая строка, пустой список файлов или связей) приводит к удалению соответствующего ключа из frontmatter (`remove_yaml_binding_lossless`).
  - Опции Select/Status/MultiSelect сохраняют устойчивость к переименованию: значение в frontmatter может быть как именем опции, так и её стабильным ULID (`find_option_id`).

## 2. Общие правила JSON

- UTF-8 без обязательного BOM; невалидный UTF-8/BOM обрабатывается read-only.
- Новые записи форматируются двумя пробелами и завершающим LF.
- `format` и `formatVersion` обязательны в каждом durable JSON-файле.
- ID базы, properties, options, views, templates и notes — canonical uppercase
  ULID.
- Порядок массивов значим; порядок ключей объектов не используется как данные.
- Неизвестные ключи сохраняются при записи известного объекта.
- Неизвестный `formatVersion` открывается read-only целиком.
- Неизвестный discriminant внутри поддерживаемой версии сохраняется как opaque
  entry; остальные понятные части продолжают читаться, если это безопасно.
- `null` используется только там, где он описан. Отсутствующее property value
  обозначается отсутствием ключа, а не неявной пустой строкой.
- JSON numbers не используются для пользовательских decimal values.

## 3. Revision и CAS

Revision не записывается внутрь JSON, иначе внешний редактор может изменить
файл, не обновив поле revision. Backend возвращает opaque revision, вычисленную
по точным raw bytes.

Каждая mutation принимает `expectedRevision`:

1. backend заново читает файл;
2. сравнивает raw-byte revision;
3. валидирует mutation против текущего состояния;
4. пишет sibling temporary file, flush/sync и атомарно публикует;
5. возвращает новую revision;
6. обновляет SQLite projection.

Несовпадение возвращает typed conflict. Last-write-wins и автоматическая запись
поверх поврежденного JSON запрещены.

## 4. Манифест базы данных (`<Название_Контейнера>.json` / `ambd.json`)

```json
{
  "format": "amby-database",
  "formatVersion": 1,
  "databaseId": "01K4...",
  "name": "Персонажи",
  "icon": "📚",
  "cover": null,
  "locked": false,
  "membership": {
    "kind": "filesystem-descendants",
    "recursive": true
  },
  "properties": [],
  "viewOrder": ["01K4..."],
  "defaultViewId": "01K4...",
  "templateOrder": [],
  "defaultTemplateId": null
}
```

### Поля manifest

| Поле                | Семантика                                                       |
| ------------------- | --------------------------------------------------------------- |
| `databaseId`        | Устойчивый ID базы, не зависит от пути и имени                  |
| `name`              | Отображаемое имя; имя каталога может отличаться после конфликта |
| `icon`              | Значение существующего `IconValue` либо `null`                  |
| `cover`             | Database-local asset reference либо `null`                      |
| `locked`            | Блокирует schema/view/membership mutations через UI             |
| `membership`        | В v1 только recursive filesystem descendants                    |
| `properties`        | Упорядоченная общая schema                                      |
| `viewOrder`         | Упорядоченные IDs файлов `.ambd/views`                          |
| `defaultViewId`     | View при открытии базы либо `null`, если views еще нет          |
| `templateOrder`     | Упорядоченные IDs файлов `.ambd/templates`                      |
| `defaultTemplateId` | Template по умолчанию либо `null`                               |

`defaultViewId` обязан присутствовать в `viewOrder`. Аналогичное правило
действует для template. Missing shard не удаляется из manifest автоматически:
UI показывает diagnostic и предлагает восстановление либо явную очистку ссылки.

### Cover

```ts
interface DatabaseCover {
  kind: "asset"
  assetId: string
  relativePath: string
  mimeType: string
}
```

`relativePath` разрешается только внутри `.ambd/assets/`, не содержит absolute
prefix, `..`, URL или symlink escape.

## 5. Property definitions

Каждое определение имеет общие поля:

```ts
interface PropertyBase {
  id: string
  name: string
  type: string
  pageVisibility: "alwaysShow" | "hideWhenEmpty" | "alwaysHide"
  yamlBinding: YamlBinding | null
}
```

Поддерживаемые v1 определения:

```ts
type PropertyDefinition =
  | (PropertyBase & { type: "text"; config: { multiline: boolean } })
  | (PropertyBase & {
      type: "number"
      config: { format: "number" | "percent" | "currency"; currency: string | null }
    })
  | (PropertyBase & { type: "checkbox"; config: Record<string, never> })
  | (PropertyBase & {
      type: "date"
      config: { includeTime: boolean; allowRange: boolean }
    })
  | (PropertyBase & { type: "select"; config: { options: SelectOption[] } })
  | (PropertyBase & {
      type: "multiSelect"
      config: { options: SelectOption[] }
    })
  | (PropertyBase & {
      type: "status"
      config: { options: StatusOption[] }
    })
  | (PropertyBase & { type: "url"; config: Record<string, never> })
  | (PropertyBase & {
      type: "files"
      config: { mediaOnly: boolean; maxItems: number | null }
    })
  | (PropertyBase & {
      type: "relation"
      config: {
        targetDatabaseId: string
        maxItems: 1 | null
        inversePropertyId: string | null
      }
    })
  | (PropertyBase & {
      type: "formula"
      config: {
        version: 1
        expression: string
        resultType: string | null
        dependencies: string[]
      }
    })
  | (PropertyBase & {
      type: "rollup"
      config: {
        relationPropertyId: string
        targetPropertyId: string
        aggregation:
          | "count"
          | "countNonEmpty"
          | "sum"
          | "average"
          | "min"
          | "max"
          | "earliest"
          | "latest"
          | "unique"
          | "percentChecked"
      }
    })
```

Title, Created, Modified, Path, Tags, Backlinks, Word count, Parent и Sub-items
являются system fields и не записываются как PropertyDefinition.

### Select options

```ts
interface SelectOption {
  id: string
  name: string
  color: string
}

interface StatusOption extends SelectOption {
  group: "notStarted" | "inProgress" | "done"
}
```

Значения хранят option ID, поэтому rename/recolor не меняет records. Удаление
используемого option проходит через preview и Trash.

### YAML binding

```ts
interface YamlBinding {
  key: string
  direction: "twoWay"
}
```

Binding разрешен для Text, Number, Checkbox, Date, Select, Multi-select, Status, URL,
Files и Relation. `key` — непустой top-level YAML mapping key, не являющийся
зарезервированным системным ключом; два поля одной базы не могут писать один key.
Создание новой привязки к другому YAML-ключу требует preflight всех текущих строк.

Переименование свойства меняет только manifest: существующая привязка сохраняется
целиком. Если у хранимого свойства ещё нет `yamlBinding`, при явном переименовании
его прежнее имя фиксируется как `key` с направлением `twoWay` в том же атомарном
изменении manifest. Значения продолжают читаться и записываться по прежнему ключу;
Markdown-файлы, включая заметки вложенных баз, не переписываются. Это фиксация
уже используемого ключа, а не перенос данных. Formula и Rollup остаются без YAML
binding. Manifest проходит валидацию, raw-byte CAS и snapshot перед заменой.

До записи выполняется read-only preflight текущих строк owning database с тем
же resolver, который использует проекция: если новое имя изменит найденное YAML
значение (например, исчезнет legacy fallback при явной привязке), операция
отклоняется. Вложенные базы учитываются через discovery ownership; главная
заметка attached database остаётся строкой внешней базы. Совпадающие после trim
и ASCII case-fold ключи хранения, включая ID других свойств, также блокируют rename. Пока формулы используют
ссылки по имени, переименование поля с такими зависимостями отклоняется до
изменения manifest; автоматическая миграция выражений — отдельная задача.

### Независимое отображаемое название заметки

Новая запись может содержать namespaced frontmatter key `amby-title`. Его
непустое значение имеет приоритет над первым H1/body title и именем файла.
Generic `title` не захватывается и не изменяется. Смена `amby-title` не требует
переименования файла; пустое или некорректное значение игнорируется с
сохранением исходных bytes.

## 6. Record shard

Путь: `.ambd/records/<note-id>.json`.

```json
{
  "format": "amby-database-record",
  "formatVersion": 1,
  "databaseId": "01K4...",
  "noteId": "01K5...",
  "values": {
    "01PROPERTY...": { "type": "select", "optionId": "01OPTION..." }
  },
  "yamlSyncBases": {}
}
```

Filename обязан совпадать с `noteId`; `databaseId` обязан совпадать с ближайшим
владельцем на момент активного использования. Shard строки, вынесенной из базы,
сохраняется, но не индексируется как active record.

Отсутствие shard означает, что все database values пусты. Пустой shard можно
удалить только если у него нет YAML sync base, diagnostics или неизвестных
полей.

## 7. Property values

```ts
type PropertyValue =
  | { type: "text"; value: string }
  | { type: "number"; decimal: string }
  | { type: "checkbox"; checked: boolean }
  | {
      type: "date"
      start: string
      end: string | null
      timeZone: string | null
    }
  | { type: "select" | "status"; optionId: string }
  | { type: "multiSelect"; optionIds: string[] }
  | { type: "url"; value: string }
  | { type: "files"; items: FileValue[] }
  | { type: "relation"; targetNoteIds: string[] }
```

Правила:

- Number использует каноническую decimal string, чтобы JSON/JavaScript не терял
  точность; формат валюты принадлежит definition.
- Date-only использует `YYYY-MM-DD` и `timeZone: null`; date-time использует
  ISO-8601 offset и исходную IANA timezone при наличии.
- Date range не допускает `end < start`.
- Option IDs должны существовать в definition; удаленный option остается
  diagnostic value до явной конверсии.
- Multi-select IDs и relation targets уникальны, порядок отображения сохраняется.
- URL валидируется, но никогда автоматически не открывается.
- Formula/rollup values не записываются в record shard.

### Files & media

```ts
interface FileValue {
  assetId: string
  kind: "asset"
  relativePath: string
  name: string
  mimeType: string
  sizeBytes: number
}
```

`relativePath` разрешается от bundle строки и обязан оставаться внутри ее
`assets/`. Remote URL, absolute path и `..` запрещены. Удаление FileValue не
удаляет asset автоматически.

### Relations

В текущем native-пути `update_database_relation_value` forward `targetNoteIds`
и список обратного свойства записываются в YAML соответствующих заметок. Это
зеркальные durable-значения; обратный список пока не является только вычисляемой
проекцией. Изменения значений и схемы имеют отдельные журналы, описанные ниже.
Единая координация схемы/значений ещё требует усиления (P0/F2): изменение схемы
заполненной связи не должно незаметно переносить или удалять значения.

Двустороннее **создание** свойства (`create_database_property`,
`propertyType: relation`, `relationTwoWay: true`) требует `operationId` и
`expectedManifestRevision` источника. Для другой базы дополнительно обязателен
`expectedTargetManifestRevision`; для self-relation используется ревизия
источника. UI получает актуальную целевую ревизию через storage `listDatabases`
перед отправкой запроса; native discovery читает raw manifest bytes.
Rust сначала готовит обе схемы в памяти: проверяет insertion point, locked и
read-only manifests, лимиты и конфликты имён, YAML-ключей и системных ключей.
Self-relation создаёт два разных свойства одним изменением manifest.

Перед первым publish сохраняются no-replace raw backups и version-1 журнал
`.amby/recovery/database_relation_schemas/<operationId>.json`
(`format: amby-relation-schema-recovery`); backups находятся в
`<operationId>/<index>.bin`. Он хранит запрос, fingerprint без
`expectedGeneration`, database IDs, пути manifests, pre/post SHA-256, progress и
результат со стабильными forward/inverse IDs и `manifestRevisions`. Обычное
одностороннее создание свойства не требует operation ID и использует прежний
однофайловый путь. Формат журнала значений Relation не изменён.

Все исходные manifests сравниваются до публикации; каждый файл и журнал
перепроверяются перед записью. Ошибка запускает условный откат только собственных
post bytes; внешние правки сохраняются, неполное восстановление возвращает
`rollback incomplete`. Completion фиксируется до watcher confirmation.
Тот же ID/payload возвращает завершённый результат до source CAS, без новых
свойств или записей; другой payload, pending или rolled-back ID отклоняются.
IPC по-прежнему требует актуальный `expectedGeneration`: после reactivation
клиент меняет только generation в прежнем запросе; fingerprint его исключает.
Устаревший generation отклоняется и для replay, сохраняя границу активного vault.
Отказ до публикации первого journal может оставить raw backup directory без
журнала и без изменений manifests; повтор с тем же ID тогда отклоняется при
подготовке каталога. Для новой попытки нужен новый ID. Такие копии сохраняются,
а не удаляются автоматически; resume/cleanup этого окна ещё не реализованы.
При activation прерванная операция восстанавливает точные raw pre bytes после
проверки всех pending journals. Journals/backups не удаляются editor draft
cleanup или rebuild индекса. Это восстановление незавершённой операции, а не
пользовательский undo создания свойства.

Настройка существующего Relation и конверсия поля в/из Relation через
`change_database_property_type` используют version-2 schema journal в том же
namespace. Version-1 journals создания продолжают читаться без миграции.
Version-2 различает вид запроса, хранит исходный property ID и результат
`ChangedDatabasePropertyType`. Запрос содержит `operationId`, source
`expectedManifestRevision` и `expectedRelatedManifestRevisions` — пары
`databaseId`/`revision` для прочитанных связанных баз. UI получает их через
`listDatabases`. Публикация может менять до трёх manifests: source, прежнюю
inverse-базу и новую inverse-базу; совпадающие базы объединяются в один шаг.

Включение двустороннего режима создаёт обратное свойство, в том числе при
конверсии существующего поля и внутри одной базы. Отключение, смена базы и
конверсия из Relation снимают reciprocal pointer у прежнего обратного поля,
сохраняя само поле и его metadata как одностороннюю связь. Неполная или неверная
пара отклоняется до записи. Изменения топологии требуют отсутствия durable
значений у исходного и обратного полей; пока автоматический backfill или перенос
заполненных связей не выполняется. Проверяются принадлежащие базе Markdown,
record shards и templates; ошибки чтения и malformed YAML блокируют конверсию.
Вложенные базы не входят в проверку значений внешней базы. Настройка Relation
сохраняет существующую YAML binding; конверсия типа требует её снять.

Version-2 использует те же raw backups, CAS журнала/файлов, conditional rollback,
activation preflight и durable replay, что и создание пары. Result возвращает
`inversePropertyId`, `manifestRevisions` и ID операции. Recovery восстанавливает
схемы, не переписывая Markdown или значения. Неизменяемые связанные manifests
также проверяются перед каждой записью и completion; они не входят в rollback.
Запрос без изменения схемы возвращает `operationId: null`, не создаёт journal
и не резервирует переданный ID. `relationMaxItems: 0` явно снимает ограничение,
`1` задаёт одну страницу, а отсутствующее значение сохраняет прежний лимит.
Полноценная миграция заполненной
связи, пользовательский schema undo и recovery UI остаются отдельными задачами.

Успешный результат изменения Relation содержит `affectedNotes` — дедуплицированные
пары `databaseId`/`noteId` фактически записанных страниц. В них входят источник,
прежние цели с удалённой обратной ссылкой и новые цели с добавленной обратной
ссылкой. Неизменённые цели односторонней связи не входят в этот список.
`targetNoteIds` описывает только новый набор целей. Command использует
`affectedNotes` для немедленного обновления derived projection обеих сторон.

Запрос изменения значения требует непустой `expectedRevision` исходной страницы:
SHA-256 исходных raw bytes, как `rowRevision` в query. Несовпадение отклоняет запрос
до планирования обратных записей, включая запрос без изменения значения. Успешный
результат возвращает `revisions` (`noteId`, `revision`) для всех записанных страниц;
источник включается и при повторном сохранении того же значения. Очередь UI берёт
ревизию из результата предыдущей записи до обновления query.

Перед публикацией Rust сравнивает текущие байты всех запланированных заметок и
прочитанных manifests с исходными. Перед каждой отдельной записью повторяются
проверки её файла, пути и manifests. При ошибке уже опубликованные файлы
восстанавливаются только если их байты всё ещё совпадают с опубликованными этой
операцией; более поздние внешние изменения сохраняются. Неполный откат возвращает
ошибку с `rollback incomplete` и ID затронутых страниц.

При снятии связи отсутствующая прежняя цель пропускается с предупреждением:
обратное значение обновить невозможно. Неоднозначный ID, ошибка чтения или
некорректное значение найденной цели останавливают операцию до записи. Сохранённые
цели должны быть canonical uppercase ULIDs (допускается одна пара `[[ULID]]` и
пробелы вокруг ID); пустые строки, malformed wiki links и другие значения
отклоняются. `targetNoteIds` запроса требуют canonical uppercase ULIDs. Если цель
не найдена и часть каталога не удалось прочитать, это ошибка разрешения, а не
доказательство отсутствия страницы.

Запрос и результат теперь содержат обязательный `operationId` (1–160 ASCII
букв/цифр, `-` или `_`). До первого изменения заметок Rust публикует no-replace
raw backups и version-1 журнал
`.amby/recovery/database_relations/<operationId>.json`; backups лежат в соседнем
`<operationId>/<index>.bin`. Namespace общий для vault, чтобы журнал покрывал
обе базы. Журнал содержит исходный запрос, его SHA-256 fingerprint без
`expectedGeneration`, точные vault-relative paths, note/database IDs, pre/post
revisions, per-step status и ожидаемый результат. Все ошибки записи backups и
журнала возвращаются наружу. Завершённый результат фиксируется до session history
и подтверждения watcher; outcome и backups не удаляются автоматически.
Обычные pre-write snapshots в `.amby/history/` создаются раньше и могут остаться
при отказе подготовки journal; session undo entry для отказавшей операции не
добавляется. Это отдельные raw recovery points, а не запись успешной операции.

Повтор того же `operationId` с тем же payload (кроме текущего generation) возвращает
сохранённый результат до source CAS, без повторной записи и history. Другой
payload с тем же ID отклоняется. `completed` — исторический результат, а не
утверждение о текущем содержимом после внешних правок, undo или rename. Pending
операция требует восстановления; `rolledBack` ID нельзя использовать снова.

При открытии vault после read-only проверки ID migrations и до загрузки индекса
незавершённые операции автоматически откатываются к pre bytes. Сначала для ВСЕХ
pending journals проверяются headers, уникальность путей, confined/no-symlink
paths, backup integrity/identity и текущие pre/post revisions. Изменённый или
удалённый файл, повреждённая копия, неподдерживаемая версия или небезопасный путь
блокируют activation без начала восстановления. Журнал и копии сохраняются для
разрешения конфликта. Для неизвестных полей журнала/steps применяется сохранение
при перезаписи. Editor draft TTL/quota и rebuild SQLite не удаляют этот namespace.

Восстановление также проверяет ревизии перед каждым restore и записывает progress
после него. Crash между restore и progress update узнаётся по точным pre bytes;
повторное восстановление безопасно. Ошибка записи во время восстановления может
оставить часть страниц восстановленной, но pending journal остаётся для повторной
попытки. Если запись notes завершилась, а completion journal не удалось записать,
возвращается явная ошибка; notes не объявляются откатанными, journal сохраняется.

Между проверкой и atomic rename остаётся окно для внешней записи; файловая
блокировка и межпроцессная атомарность CAS не гарантируются. Автоматический resume,
UI разрешения конфликтов recovery, cleanup журналов и протокол двустороннего
создания свойств остаются следующими задачами P0.

## 8. YAML sync base

Для каждого связанного property record хранит последнее согласованное
нормализованное значение:

```ts
type YamlSyncBase = { state: "missing" } | { state: "value"; value: PropertyValue }
```

Алгоритм сравнивает current shard value, current YAML value и base:

| Shard               | YAML                | Результат            |
| ------------------- | ------------------- | -------------------- |
| равен base          | изменен             | импортировать YAML   |
| изменен             | равен base          | экспортировать shard |
| одинаково изменены  | одинаково изменены  | принять новый base   |
| по-разному изменены | по-разному изменены | field-level conflict |

Невалидный YAML type не конвертируется молча и становится конфликтом. YAML
envelope меняется только lossless splice/writer с revision check и snapshot.

## 9. View shard

Путь: `.ambd/views/<view-id>.json`.

```ts
interface DatabaseViewFile {
  format: "amby-database-view"
  formatVersion: 1
  databaseId: string
  viewId: string
  name: string
  layout: "table" | "board" | "list" | "gallery" | "chart"
  openMode: "sidePeek" | "centerPeek" | "fullPage"
  subitemsMode: "nested" | "flat"
  density: "compact" | "default" | "tall" | null
  fields: ViewField[]
  filter: FilterNode | null
  sorts: SortRule[]
  group: GroupRule | null
  manualOrder: string[]
  aggregates: AggregateRule[]
  layoutConfig: LayoutConfig
}
```

View revision также вычисляется по raw bytes. Изменение одного view не меняет
revision schema или соседних views.

### Field references

```ts
type FieldRef =
  | {
      kind: "system"
      field:
        | "title"
        | "created"
        | "modified"
        | "path"
        | "tags"
        | "backlinks"
        | "wordCount"
        | "parent"
        | "subitems"
    }
  | { kind: "property"; propertyId: string }
```

`ViewField` добавляет `visible`, `width` и `frozen`. System Title всегда
присутствует первым, visible и frozen. Missing property reference сохраняется и
показывается diagnostic column.

### Filter AST

```ts
type FilterNode =
  | { kind: "group"; operator: "and" | "or"; children: FilterNode[] }
  | {
      kind: "condition"
      field: FieldRef
      operator: string
      value?: unknown
    }
```

Операторы валидируются по типу поля. Frontend не передает SQL. V1 ограничивает
глубину AST, число conditions и размер operands константами backend.

### Sort/group/order

- Sort содержит FieldRef, direction и явное null placement.
- Backend всегда добавляет `(databaseId, noteId)` как стабильный tie-breaker.
- Nested mode сортирует siblings; Flat mode — общий результат.
- Group v1 принимает Status или одиночный Select.
- Manual order применяется только без active sorts, но не удаляется при их
  включении.
- Missing note IDs в manual order сохраняются для возможного restore; новые IDs
  добавляются детерминированно в конец.

### Layout config

- Table: column borders/row height и frozen boundary.
- Board: group property, card fields, cover visibility.
- List: secondary fields и indentation.
- Gallery: card size, field list и preview source (`property`, `firstImage`,
  `icon`, `none`).
- Chart: chart type, category/measure fields, aggregation и ограничение числа
  групп. Данные получает backend aggregate query, а не renderer-side full scan.

Unknown layout/config открывается read-only без удаления payload. Calendar и
timeline пока не входят в v1: для них ещё нет согласованного range-query и
fictional-time контракта.

## 10. Template shard

Путь: `.ambd/templates/<template-id>.json`.

```json
{
  "format": "amby-database-template",
  "formatVersion": 1,
  "databaseId": "01K4...",
  "templateId": "01K6...",
  "name": "Главный герой",
  "body": "## Внешность\n\n## Характер\n",
  "values": {}
}
```

Template body — UTF-8 Markdown без frontmatter `amby-id`. Создание строки
назначает новый ID через обычный note writer. Template values используют тот же
PropertyValue contract. Binary media не встраивается в JSON.

## 11. Recovery и Trash

Relation value mutations используют реализованный vault-wide журнал из
[контракта Relations](#relations). Для остальных multi-file mutations общий
контракт `.ambd/recovery/<operation-id>.json` остаётся целевым:

- versioned operation kind;
- точные source/target paths;
- expected raw revisions;
- backup/snapshot paths;
- per-step status;
- итоговый status `planned`, `inProgress`, `completed` или `rolledBack`.

Journal записывается и sync-ится до первого изменения. Resume и rollback
идемпотентны и никогда не заменяют файл, измененный после операции.

Удаленные property/option/view/template и record values сначала перемещаются в
`.ambd/trash/` с manifest восстановления. Обычные Markdown notes и bundles
продолжают использовать vault-local `.amby/trash/`.

## 12. Валидация и лимиты

Backend применяет централизованные лимиты к:

- размеру каждого JSON-файла и Markdown template;
- числу properties, views, templates и select options;
- длине names/text/URL;
- числу relation targets и media items;
- глубине/ширине filter AST;
- размеру batch mutation и page query.

Превышение лимита возвращает typed error и не переписывает исходный файл.
Значения лимитов фиксируются после benchmark baseline и одинаковы для desktop и
browser contract tests, кроме допустимого query page size.

Все filesystem paths проходят canonical vault guard. Symlink escape, absolute
path, traversal, remote resource и выполнение JSON как JS запрещены.

## 13. Rebuild SQLite

Rebuild выполняется в порядке:

1. найти валидные `ambd.json` без входа во вложенные `.ambd/`;
2. определить owning database каждой Markdown note по ближайшему manifest;
3. загрузить property definitions;
4. загрузить view/template registries и диагностировать missing shards;
5. загрузить active record shards;
6. сохранить orphan/removed record shards вне active projection;
7. построить relations и inverse projection;
8. сопоставить YAML bindings и создать conflicts;
9. атомарно опубликовать новую index generation.

Unreadable durable file останавливает замену предыдущей здоровой projection или
изолирует только затронутую базу согласно typed outcome. Он никогда не
трактуется как подтвержденное удаление данных.

## 14. Миграции

- `formatVersion` монотонный для каждого типа файла.
- Read-only preflight перечисляет все будущие записи.
- До изменения создаются raw backups и journal.
- Resume/rollback идемпотентны.
- Outcome записывается до cleanup старого формата.
- Legacy `Metadata.md` и `.amby/blocks/*.json` не конвертируются при scan.
- Existing local `.amby/properties.json` мигрирует только в local-property
  shards; database records сразу создаются в owning `.ambd/records`.
- Downgrade к версии без поддержки нового формата не должен изменять durable
  files.

## 15. Следующий контракт

Normalized SQLite schema и versioned IPC types определены в
[runtime-контракте](./database-runtime.md). Они являются проекцией данных выше и
не добавляют единственные копии пользовательских значений.
