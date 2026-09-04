# Формат базы данных Amby

Статус: proposed contract
Версия документа: 1
Дата: 2026-09-04

Документ определяет durable-формат первой версии баз. Он следует
[архитектуре](./database-system.md) и
[пользовательским сценариям](./database-user-flows.md). SQLite-схема является
отдельной перестраиваемой проекцией этого формата.

## 1. Структура контейнера

```text
Персонажи/
├── ambd.json
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

`ambd.json` — небольшой manifest и общая schema. Часто изменяемые views,
templates и record values вынесены в отдельные атомарные shards. Это уменьшает
конфликты между окнами и не требует переписывать всю базу при правке ячейки.

`.ambd/` является durable частью базы:

- переносится и копируется вместе с контейнером;
- исключается из note indexing и Files panel;
- не удаляется при rebuild SQLite;
- не считается временным кэшем;
- не исполняет содержащиеся данные как код.

Для attached database в том же каталоге присутствует одноименная основная
`.md`. Для standalone database основной заметки нет.

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

## 4. `ambd.json`

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

Binding разрешен только для Text, Number, Checkbox, Date, Select, Multi-select и
URL. `key` — непустой top-level YAML mapping key, не равный `amby-id`; два поля
одной базы не могут писать один key. Создание binding требует preflight всех
текущих строк.

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

Forward `targetNoteIds` является канонической записью edge. Inverse property
вычисляется из forward values и не дублирует список. Создание двусторонней schema
ссылки меняет два manifests через recovery journal.

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
  layout: "table" | "board" | "list" | "gallery"
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

Unknown layout/config открывается read-only без удаления payload.

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

Multi-file mutation сначала создает `.ambd/recovery/<operation-id>.json`:

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
