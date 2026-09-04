# Frontend и UX runtime баз данных Amby

Статус: proposed contract
Версия документа: 1
Дата: 2026-09-04

Документ продолжает
[архитектуру](./database-system.md),
[пользовательские сценарии](./database-user-flows.md),
[durable-формат](./database-format.md) и
[runtime-контракт](./database-runtime.md). Он фиксирует state ownership,
component boundaries и поведение Table, Board, List, Gallery, side peek и linked
views.

## 1. Главный принцип интерфейса

Table, Board, List и Gallery — четыре представления одной query-модели, а не
четыре самостоятельных редактора данных.

```text
DatabasePort
     │
     ▼
database controller ──► useDatabaseStore
                              │
               ┌──────────────┼──────────────┐
               ▼              ▼              ▼
          view chrome      row layouts    inspector / peek
               │              │              │
               └──────── shared typed value controls ───────┘
```

Компоненты:

- не вызывают Tauri commands напрямую;
- не хранят собственную копию server rows;
- идентифицируют строки по `noteId`, поля по `FieldRef`, views по `viewId`;
- получают I/O только через `DatabasePort` и controller actions;
- используют существующие theme tokens, `IconValue` и localization registry;
- переиспользуют обычный document buffer/autosave для текста страницы.

## 2. Интеграция с текущим workspace

### 2.1 Вкладки

В `TabKind` добавляется `database`. Для совместимости с текущей моделью:

- `tab.fileId` хранит `databaseId`;
- выбранный `viewId` хранится в session state по `tab.key`;
- переход между views одной базы не добавляется в Back/Forward history;
- переход в другую базу использует обычную tab history;
- `Открыть в новой вкладке` может открыть ту же базу с другим view;
- заголовок вкладки берется из database header, а не из имени каталога.

Standalone database открывается как database tab. Attached database может
рендериться тем же `DatabaseWorkspace` внутри существующего layer места
документа. Оба варианта используют один store/controller и отличаются только
`host`.

```ts
type DatabaseHost =
  | { kind: "tab"; tabKey: string }
  | { kind: "layer"; noteId: string }
  | { kind: "linkedBlock"; noteId: string; blockId: string }
```

`workspace-orchestration.tsx` выбирает только host component. Загрузка,
редактирование и dialogs не переносятся в `workspace.tsx`.

### 2.2 Split и focus mode

В первой версии database tab занимает primary pane и использует side peek для
строк. Открытие database tab при активном document split применяет существующую
политику закрытия secondary pane. Две полноценные database panes в split —
отдельное расширение после измерения памяти и scroll performance.

В focus mode database view остается доступным. Activity panels становятся
overlay как сейчас; side peek тоже становится overlay и не уменьшает view до
непригодной ширины.

### 2.3 Databases panel

`ComingSoonPanel` заменяется на `DatabasesPanel`, который показывает:

- attached и standalone databases;
- favorite databases и views;
- saved views внутри каждой базы;
- состояние broken/read-only/recovery;
- команды создать, подключить, открыть и показать в Files.

Panel получает данные через selectors `useDatabaseStore`, а не через расширение
универсального `PanelRenderProps` десятками callback. `PanelRenderProps` передает
только навигационный adapter там, где он действительно нужен.

Перетаскивание view в редактор использует внутренний MIME type
`application/x-amby-database-view` с `databaseId` и `viewId`. Path и raw JSON в
drag payload не передаются.

## 3. Предлагаемая структура файлов

```text
src/components/workspace/database/
├── database-workspace.tsx
├── database-controller.ts
├── database-selectors.ts
├── use-database-store.ts
├── use-database-lifecycle.ts
├── database-session-state.ts
├── database-tab-view.tsx
├── database-layer-view.tsx
├── database-header.tsx
├── database-view-tabs.tsx
├── database-toolbar.tsx
├── database-status-banner.tsx
├── query/
│   ├── query-key.ts
│   ├── query-cache.ts
│   ├── filter-editor.tsx
│   ├── sort-editor.tsx
│   └── group-editor.tsx
├── layouts/
│   ├── table-view.tsx
│   ├── board-view.tsx
│   ├── list-view.tsx
│   └── gallery-view.tsx
├── cells/
│   ├── database-cell.tsx
│   ├── cell-editor-layer.tsx
│   ├── text-cell.tsx
│   ├── number-cell.tsx
│   ├── checkbox-cell.tsx
│   ├── date-cell.tsx
│   ├── option-cell.tsx
│   ├── url-cell.tsx
│   ├── files-cell.tsx
│   └── relation-cell.tsx
├── editing/
│   ├── database-edit-queue.ts
│   ├── cell-selection.ts
│   ├── clipboard.ts
│   └── validation.ts
├── peek/
│   ├── database-side-peek.tsx
│   └── editor-surface-lease.ts
├── properties/
│   ├── property-list.tsx
│   ├── property-value-control.tsx
│   └── database-property-definition-dialog.tsx
└── dialogs/
    ├── database-operation-preview.tsx
    ├── database-conflict-dialog.tsx
    ├── database-recovery-dialog.tsx
    └── csv-import-dialog.tsx

src/components/workspace/panels/databases-panel.tsx
src/components/workspace/tiptap/database-block-view.tsx
```

Pure state/query/clipboard code не импортирует React и покрывается Node Vitest.
Reusable visual primitives остаются в `components/ui`; database semantics не
переносятся в UI primitives.

## 4. State ownership

### 4.1 Server и cache state

Один `useDatabaseStore` содержит:

```ts
interface DatabaseState {
  module: DatabaseModuleState
  vaultGeneration: number | null
  projection: ProjectionVersion | null

  databasesById: Record<string, DatabaseHeader>
  schemasByDatabaseId: Record<string, DatabaseSchemaResource>
  viewsById: Record<string, DatabaseViewResource>
  templatesById: Record<string, DatabaseTemplateResource>

  queryEntries: Record<QueryKey, DatabaseQueryEntry>
  sessionsByHost: Record<DatabaseHostKey, DatabaseViewSession>
  pendingByOperationId: Record<string, PendingDatabaseOperation>
  conflictsByKey: Record<string, DatabaseConflict>
  diagnosticsById: Record<string, DatabaseDiagnostic>
}
```

Store не сохраняется целиком в app settings. Durable views находятся в database
files, а runtime cache очищается при смене vault. Из session state сохраняются
только безопасные локальные предпочтения: последний view для host, quick-search
при необходимости и размеры временных панелей.

`databasesById` и resource maps обновляются только controller. Layout components
получают узкие selectors, чтобы ввод в одной ячейке не перерисовывал всю таблицу.

### 4.2 Session state одного host

```ts
interface DatabaseViewSession {
  host: DatabaseHost
  databaseId: string
  viewId: string | null
  quickSearch: string
  transientOverrides: DatabaseQueryOverrides
  selection: CellSelection | RowSelection
  editingCell: CellAddress | null
  expandedGroups: Set<string>
  collapsedRowIds: Set<string>
  scrollAnchor: ScrollAnchor | null
  peek: PeekState
}
```

Linked block получает независимый session: его filter/layout overrides не
меняют source view. Два tabs одной базы также имеют разные selection, scroll и
peek state, но используют общий query cache при совпадающем query key.

### 4.3 Document state

Markdown body строки не хранится в database store. Side peek вызывает обычный
`readNote`, помещает результат в `useDocStore` и использует общий autosave
coordinator. Поэтому редактирование страницы из базы и из Files имеет одинаковые
conflict, recovery и byte-preservation гарантии.

Database properties не добавляются в `Document.noteProperties` как строковые
`CustomProperty`. Inspector объединяет два типизированных источника на уровне
presentation model.

## 5. Lifecycle state machine

```text
disabled
   │ enable
   ▼
enabling ── validation/rebuild ──► ready
   │ error                         │ index warning
   ▼                               ▼
failed                         degraded
                                   │ rebuild needed
                                   ▼
                            rebuildRequired

ready/degraded ── unfinished journal ──► recoveryRequired
ready/degraded ── disable + flush ─────► disabled
```

Семантика:

- `enabling`: database entry points видимы disabled со progress;
- `ready`: чтение и разрешенные mutations доступны;
- `degraded`: последняя целая projection читается, часть данных read-only;
- `rebuildRequired`: подтвержденные optimistic values видны, новые query
  блокируются либо явно помечены stale до rebuild;
- `recoveryRequired`: чтение последней безопасной projection разрешено, новые
  конфликтующие mutations заблокированы;
- `failed`: обычные заметки продолжают работать.

`onDeactivate` сначала вызывает `flushAll`. Если flush не удался, переключатель
остается включенным и показывает ошибку; данные не бросаются ради изменения UI.

## 6. Query entry state machine

```ts
type QueryStatus = "idle" | "loading" | "ready" | "refreshing" | "loadingMore" | "stale" | "error"
```

Правила:

- первая загрузка показывает skeleton текущего layout;
- `refreshing` сохраняет предыдущие rows и не сбрасывает scroll;
- новое изменение filter/sort отменяет старый in-flight request;
- `staleCursor` очищает только страницы query и перезапрашивает первую;
- событие с новым `{ epoch, seq }` отмечает затронутые entries `stale`;
- невидимый host не обновляется немедленно, но invalidation сохраняется;
- infinite loading начинается до достижения последней видимой строки;
- error следующей страницы не скрывает уже загруженные данные.

Query key вычисляется из:

```text
vaultGeneration + databaseId + base view revision + normalized overrides + field set
```

Scroll position, selection и open popovers в query key не входят.

## 7. View chrome

Общая оболочка всех layouts:

```text
DatabaseWorkspace
├── DatabaseHeader
│   ├── icon + title
│   ├── lock / favorite / more
│   └── create row
├── DatabaseViewTabs
├── DatabaseToolbar
│   ├── quick search
│   ├── filter
│   ├── sort
│   ├── group
│   ├── properties
│   └── layout options
├── DatabaseStatusBanner
├── active layout
└── DatabaseSidePeek
```

View tabs переключаются без полной перезагрузки database header/schema. Создание,
rename, duplicate и delete view идут через view mutation CAS.

Quick search временный. Filter, sort, group, visible fields, density и layout
options изменяют saved view с debounce и обязательным flush при закрытии host.
Если view revision изменилась извне, UI предлагает:

- загрузить внешнюю версию;
- сохранить локальную конфигурацию как новый view;
- сравнить изменения, если оба изменяли разные fields.

Автоматического last-write-wins нет.

## 8. Общая row model

Все layouts получают:

```ts
interface DatabaseRowModel {
  databaseId: string
  noteId: string
  title: string
  icon: string | null
  pathLabel: string
  parentNoteId: string | null
  depth: number
  breadcrumb: DatabaseBreadcrumbItem[]
  values: Record<PropertyId, PropertyValue | null>
  systemValues: DatabaseSystemValues
  revision: string
  pendingFields: Set<FieldKey>
  conflicts: Record<FieldKey, DatabaseConflict>
}
```

Layout может запросить сокращенный field set. Добавление новой видимой колонки
дозагружает query с расширенным field set; оно не выполняет N запросов по строкам.

System Title всегда первая/frozen в Table и основной интерактивный элемент в
остальных layouts. Клик по Title открывает страницу; клик по значению редактирует
свойство.

## 9. Table

### 9.1 Рендеринг

Table реализуется как ARIA grid на `div`, а не как огромный DOM `<table>`:

- вертикальная виртуализация строк через `@tanstack/react-virtual`;
- горизонтальная виртуализация незакрепленных колонок;
- отдельный sticky слой frozen columns;
- фиксированная оценка высоты по density;
- group headers и aggregate footer имеют собственный virtual item kind;
- overscan небольшой и настраивается только по benchmark.

DOM cell получает стабильный key `{noteId}:{fieldKey}`, но draft редактора живет
в store/editor layer и не теряется при размонтировании виртуальной строки.

### 9.2 Selection

```ts
interface CellSelection {
  anchor: CellAddress
  focus: CellAddress
  mode: "cell" | "range"
}

interface CellAddress {
  noteId: string
  field: FieldRef
}
```

В selection хранятся IDs, а не только индексы. Текущий query result строит
временную карту ID → position. После filter/sort/invalidation:

- если обе границы существуют, range пересчитывается;
- если осталась одна, selection схлопывается к ней;
- если строки исчезли, selection очищается;
- pending edit никогда не применяется к новой строке по старому индексу.

### 9.3 Keyboard contract

| Клавиша                     | Действие                                        |
| --------------------------- | ----------------------------------------------- |
| Arrow keys                  | переместить active cell                         |
| Shift + Arrow               | расширить range                                 |
| Enter                       | открыть editor / подтвердить и идти вниз        |
| Shift + Enter               | подтвердить и идти вверх                        |
| Tab / Shift + Tab           | подтвердить и идти вправо/влево                 |
| Escape                      | отменить draft либо очистить range              |
| Space на Checkbox           | переключить значение                            |
| Cmd/Ctrl + C                | копировать TSV                                  |
| Cmd/Ctrl + V                | preflight multi-cell paste                      |
| Delete/Backspace вне editor | preview очистки выбранных значений              |
| Cmd/Ctrl + Z                | database undo, если cell editor не владеет undo |

Browser/native clipboard errors показываются ненавязчиво и не меняют selection.

### 9.4 Resize, reorder, freeze

- Во время resize ширина локальна и обновляется через pointer capture.
- В durable view она записывается один раз на pointer up.
- Reorder работает по stable field refs.
- Title нельзя скрыть, переместить с первой позиции или разморозить.
- Дополнительные frozen columns образуют непрерывный prefix; разрывы запрещены.
- Включенная сортировка блокирует ручной drag rows, но не стирает manual order.

## 10. Cell editing

### 10.1 Общий контракт control

```ts
interface PropertyValueControlProps<T extends PropertyValue> {
  definition: PropertyDefinition
  value: T | null
  draft: T | null
  state: CellEditState
  readOnly: boolean
  onDraftChange(value: T | null): void
  onCommit(): void
  onCancel(): void
}
```

Control ничего не знает о note path, SQLite, IPC или optimistic cache.
`CellEditorLayer` позиционирует popover через portal, поэтому virtualizer и
`overflow: hidden` не обрезают Date/Select/Relation/Files editors.

### 10.2 Состояние ячейки

```text
idle ── edit ──► editing ── commit ──► validating
 ▲                 │ escape                │ valid
 │                 └───────────────────────┤
 │                                         ▼
 └──── success ◄──── saving ◄──────── optimistic
                         │
               ┌─────────┴─────────┐
               ▼                   ▼
             error              conflict
```

- Text commit: blur, Enter или debounce с flush.
- Number хранит строковый draft и парсится только при commit.
- Checkbox обычно выполняет immediate commit.
- Select/Status commit-ится выбором option.
- Multi-select держит popover открытым и commit-ит batch при закрытии.
- Date сохраняет date-only или date-time строго по definition.
- URL не открывается тем же click, которым редактируется; open — отдельная
  безопасная команда.
- Relation picker ищет целевую базу через paginated backend search.
- Files сначала импортируются в row bundle, затем value mutation ссылается на
  подтвержденный asset.

### 10.3 Очередь

`DatabaseEditQueue` сериализует mutations одного resource:

- ключ ячейки `{databaseId}:{noteId}:{propertyId}`;
- Title использует отдельный filesystem-operation key;
- новое значение может coalesce-ить еще не отправленный Text draft;
- in-flight mutation не отменяется после durable write;
- batch имеет один operation ID и не раскладывается frontend на несвязанные
  одиночные writes;
- flush запускается при смене view/tab/vault, закрытии peek, выключении модуля и
  `beforeunload` desktop window lifecycle.

## 11. Paste и массовое редактирование

Clipboard parser является pure-функцией:

1. Читает TSV с сохранением пустых cells и строк.
2. Проецирует rectangle на visible editable fields.
3. Конвертирует каждую строку по property type.
4. Собирает все ошибки без записи.
5. Показывает preview для destructive/large batch.
6. Отправляет один `apply_database_value_batch`.

Значения Relation, Files и неизвестные Select options не создаются неявно при
paste. UI предлагает явный mapping/создание options только через отдельный
preview. Частичный success запрещен.

Row selection существует отдельно от cell range и используется для move,
relation, delete-to-Trash и batch property action.

## 12. Board

Board получает те же filtered rows, сгруппированные только по Status или
single Select.

- колонка имеет option ID, включая отдельную `empty` lane;
- drag card между lanes отправляет одну value mutation;
- optimistic card перемещается сразу и помечается pending;
- ошибка возвращает карточку в исходную lane без потери scroll;
- card order внутри lane следует active sorts либо manual view order;
- Relation/Multi-select не используются как group field в v1;
- footer lane показывает count;
- свойства карточки выбираются из view fields;
- Title открывает side peek, drag handle не открывает страницу.

Горизонтально виртуализируются lanes, вертикально — cards внутри длинной lane.
Одновременно монтируются только видимые lanes с небольшим overscan.

## 13. List

List — самый компактный read/edit layout:

- Title, icon, breadcrumb и выбранные secondary fields;
- nested mode показывает disclosure control и indentation;
- flat mode показывает breadcrumb вместо indentation;
- inline edit разрешен для простых secondary fields;
- сложные Relation/Files открывают общий editor popover;
- вся строка открывает side peek, кроме интерактивных controls;
- виртуализация вертикальная с одной фиксированной высотой на density.

## 14. Gallery

Gallery использует responsive CSS grid и вертикальную виртуализацию рядов, а не
отдельную виртуализацию каждой карточки.

Порядок preview:

1. явно выбранное Files & media property;
2. первая картинка заметки;
3. `IconValue`;
4. нейтральный placeholder.

Только видимые изображения получают asset URL. Preview использует lazy loading,
ограниченный decode size и не загружает remote resources. Карточка показывает
настраиваемый список fields; Title открывает side peek. Empty/broken media дает
diagnostic placeholder, но не ломает всю сетку.

## 15. Sub-items

Nested и flat layouts используют один projection:

- collapsed IDs принадлежат session, а не durable view;
- filter match child без parent показывает child и breadcrumb;
- раскрытие parent не загружает все дерево заранее;
- drag row/card на другую row вызывает membership operation preview;
- cycle, перенос в собственный descendant и пересечение с nested database
  отклоняются backend;
- удаление parent всегда открывает выбор `вместе с дочерними` или `поднять
дочерние`, если sub-items существуют.

Manual order хранится по note IDs и применяется среди siblings в nested mode.

## 16. Side peek и страница строки

### 16.1 Геометрия

На широком окне side peek занимает правую часть main content с resize в
ограничениях примерно 420–760 px. Ниже адаптивного порога он становится overlay
почти на весь content. Глобальные activity bar и sidebar не дублируются внутри.

```text
┌──────── database view ────────┬──────── side peek ────────┐
│ rows/cards                    │ title + page actions      │
│                               │ Markdown body             │
│                               │                           │
└───────────────────────────────┴───────────────────────────┘
                                             right Info panel
                                             inspects peek row
```

Side peek использует существующий `DocumentEditor` в compact chrome mode, а не
новый Markdown editor. Его header добавляет:

- close;
- previous/next row текущего query;
- открыть полной страницей;
- показать в Files;
- move/delete через preview.

### 16.2 Inspector target

Right Info panel получает discriminated target:

```ts
type InspectorTarget =
  | { kind: "activeTab"; tabKey: string }
  | { kind: "databaseRow"; hostKey: string; databaseId: string; noteId: string }
```

При открытом peek приоритет имеет database row. После закрытия target возвращается
к active tab. В property list два явно разделенных блока:

1. свойства базы в порядке schema и с `pageVisibility`;
2. локальные свойства заметки.

Оба используют общий `PropertyValueControl`, но только database property меняет
`.ambd/records`; local property продолжает существующий property-store path.

### 16.3 Общий document buffer

Открытие peek:

1. выбирает row, не меняя активную workspace tab;
2. переиспользует загруженный `useDocStore` buffer либо читает note;
3. открывает обычный autosave lifecycle;
4. меняет inspector target после успешной загрузки;
5. восстанавливает focus в исходную cell после закрытия.

Если та же note уже редактируется в другом surface одного окна,
`EditorSurfaceLease` гарантирует одного writable owner. Перед передачей lease
текущий surface flush-ится; остальные показывают живое содержимое read-only.
Это не дает двум Tiptap instances независимо сохранять один buffer.

Escape закрывает peek только после завершения активного cell/editor popover.
При ошибке flush он остается открыт и показывает recovery choice.

`Открыть полной страницей` открывает обычный document tab, сохраняет origin
`{databaseId, viewId, noteId}` для команды возврата и закрывает peek после
успешной передачи editor lease.

## 17. Linked views в Markdown

Новый reference block хранит JSON из format contract прямо в `amby-db` fence:

```amby-db
{"version":1,"databaseId":"01...","viewId":"01..."}
```

`DatabaseBlockView`:

- парсит reference через typed parser;
- использует host `{ kind: "linkedBlock" }`;
- показывает source data и локальные overrides;
- ограничивает высоту, но позволяет открыть view в database tab;
- не хранит или не сохраняет собственные rows;
- при missing source показывает диагностический placeholder;
- при выключенном модуле оставляет переносимый fence неизменным;
- неизвестную версию показывает read-only и сериализует byte-exact.

Текущий prototype `.amby/blocks/<block-id>.json` автоматически не превращается в
новый reference. Он открывается как legacy read-only block с явной командой
миграции: создать настоящую database, materialize rows как Markdown notes,
показать preview и только после success заменить fence.

Изменение linked-block overrides проходит изменение Markdown node attributes и
обычный lossless editor serialization. Оно не пишет source view shard.

## 18. Schema и property dialogs

Текущий `PropertyEditor` нельзя расширять строковыми `value/settings`. Он
разделяется на:

- `PropertyValueControl` — редактирует одно typed значение;
- `DatabasePropertyDefinitionDialog` — type/config/options/YAML binding;
- `LocalPropertyDefinitionDialog` — текущая локальная schema;
- общий `PropertyIconPicker` на `IconValue`/`EmojiPickerPanel`.

Изменение property type всегда показывает preflight:

- число затронутых непустых values;
- допустимые/недопустимые conversions;
- relations/options/YAML effects;
- backup/recovery behavior.

Rename property не меняет property ID или YAML key. Удаление используемого
property/option не выполняется из popover одним click: нужен preview и Trash.

## 19. Relation picker

Relation editor состоит из paginated search, выбранных chips и команды открыть
target.

- target database определяется definition, не пользовательским текстом;
- поиск идет по Title и выбранным display fields;
- уже выбранные IDs не дублируются;
- single relation закрывает picker после выбора;
- inverse relation показывается как вычисляемая и не отправляет отдельный write;
- missing/outsideDatabase target сохраняется chip с diagnostic state;
- создание новой target row из picker использует template целевой базы;
- circular relations разрешены как данные, но UI не раскрывает их рекурсивно.

## 20. View autosave

View settings имеют отдельную очередь от cell values:

- быстрые pointer/typing updates меняют локальный draft;
- debounce сохраняет semantic patch с expected view revision;
- закрытие popover/host выполняет flush;
- новое внешнее revision не перезаписывается;
- layout query перезапускается только если patch влияет на data set/order;
- resize/card field visibility может обновить layout без query;
- один view autosave failure не блокирует редактирование row values.

Создание временного filter пока popover открыт можно отменить Escape. После
подтверждения он становится частью saved view автоматически.

## 21. Ошибки, stale state и recovery

Уровни отображения:

| Событие                | UI                                                   |
| ---------------------- | ---------------------------------------------------- |
| Cell validation        | inline у ячейки, draft сохраняется                   |
| Revision/YAML conflict | marker ячейки + conflict dialog                      |
| Query page error       | inline retry после последних rows                    |
| View revision conflict | banner/popover, данные продолжают читаться           |
| Broken shard           | row/property diagnostic, read-only scope             |
| Rebuild required       | общий database banner с rebuild action               |
| Recovery required      | modal до конфликтующих mutations                     |
| Module failure         | Databases panel; обычный workspace продолжает работу |

Toast не используется как единственное место ошибки: исчезающий toast не должен
быть единственным способом понять, что value не сохранилось.

Optimistic value с подтвержденным durable write и сломанным index остается
визуально успешным с warning. UI не предлагает повторить эту mutation.

## 22. Accessibility

- Table имеет `role="grid"`, row/column counts и active descendant.
- В обычном состоянии tab stop один на grid; стрелки перемещают active cell.
- Editor popover переводит focus внутрь и возвращает его в cell при закрытии.
- Board drag имеет keyboard alternative через menu `Переместить в статус`.
- Цвет Select/Status никогда не является единственным носителем смысла.
- Pending, error, conflict и read-only имеют icon/text state.
- Gallery/List cards имеют различимые accessible names.
- Resize handles доступны с keyboard и объявляют текущую ширину.
- Reduced motion отключает animated card moves и peek transition.

Все строки интерфейса добавляются одним dotted key во все языки
`src/locales/resources.ts`; динамические property names не переводятся.

## 23. Themes и визуальный стиль Amby

Механика берет основу Notion, но визуально остается Amby:

- используются существующие `background`, `card`, `border`, `accent`, `muted`,
  `ring` tokens;
- density наследует глобальную настройку, view может ее переопределить;
- layout CSS живет в theme-owned static definitions, когда это visual token;
- database component не встраивает theme palettes;
- encoded icons рендерятся только через `IconValue`;
- side peek и popovers используют существующие Radix primitives и z-index
  conventions.

Нельзя копировать пиксель-в-пиксель интерфейс Notion или вводить второй набор
серых цветов. Перенимаются interaction patterns и информационная плотность.

## 24. Module boundary

`ModulePermission` расширяется узкими capability:

```ts
type DatabaseModulePermission = "read-databases" | "write-databases"
```

Databases module объявляет UI panel, read/write notes для row pages и
read/write database capabilities. Backend все равно проверяет активность модуля;
frontend manifest сам по себе не является security boundary.

При выключении:

- panel, database tabs/layer controls и insert commands скрываются;
- открытый database host сначала flush-ится, затем превращается в обычный
  folder/note context либо закрывается по существующей tab policy;
- linked blocks становятся inert placeholders, fence сохраняется;
- `useDatabaseStore` очищает caches и editor drafts;
- чистые peek document buffers могут быть evicted обычным doc lifecycle;
- local note properties продолжают работать.

## 25. Тестовая стратегия

### Pure Vitest

- query key normalization;
- event invalidation по epoch/seq;
- cell/row selection после sort/filter/delete;
- TSV parse и typed conversion;
- optimistic queue coalescing, ordering, retry и flush;
- view autosave revision conflict;
- module/query/cell state transitions;
- linked block version parser и byte preservation;
- gallery preview choice;
- inspector target priority;
- editor surface lease.

### Component tests

Happy DOM используется только для компактных controls/dialog contracts:

- keyboard grid navigation;
- focus return из editor popover;
- relation picker selection;
- read-only/conflict markers;
- view toolbar draft/commit;
- legacy block не вызывает write автоматически.

Virtualization geometry и pointer drag не полагаются только на jsdom-подобную
среду; они проходят native UI scenarios.

### Manual/native scenarios

- 10 000 rows во всех четырех layouts;
- быстрый ввод с немедленным закрытием tab/peek;
- одновременное редактирование в двух окнах;
- внешний edit record/YAML/view;
- resize/freeze/scroll Table;
- keyboard-only Table и Board;
- drag Board, sub-item и linked view;
- module off/on с открытыми hosts;
- side peek → full page → back to originating row;
- compact window, focus mode и обе sidebars;
- asset previews с missing/corrupt media.

## 26. Порядок frontend-реализации

1. Добавить generated database types/port и pure `useDatabaseStore` без UI.
2. Ввести `database` tab kind, lifecycle controller и read-only workspace shell.
3. Реализовать Table read-only с virtualization и query pagination.
4. Добавить shared typed cells, selection и single-value edit queue.
5. Подключить side peek к существующим doc store/autosave и Info inspector.
6. Добавить view tabs/toolbar/autosave и schema dialogs.
7. Реализовать List и Gallery поверх общей row model.
8. Реализовать Board и atomic drag mutation.
9. Заменить prototype `AmbyBlockView` новым linked view с legacy migration path.
10. Добавить batch/paste, Relation/Files, sub-items и operation previews.
11. Добавить module disable/recovery UX и native multi-window scenarios.
12. Провести benchmark и оптимизировать только измеренные bottlenecks.

Каждый slice включает localization keys, selectors, pure tests и ручной сценарий.
Ни один layout не получает собственный storage path или отдельное значение row.

## 27. Закрытые решения

1. Один database store обслуживает все layouts и hosts.
2. Markdown body остается в существующем document store/autosave.
3. Side peek использует настоящий `DocumentEditor`, не сокращенный текстовый
   редактор.
4. Right Info panel инспектирует peek row и показывает два раздела свойств.
5. Table виртуализирует строки и незакрепленные колонки.
6. Draft editor переживает размонтирование virtual cell.
7. Selection хранится по stable IDs.
8. Saved view autosave использует CAS; quick search остается временным.
9. Linked view не копирует rows и имеет независимые local overrides.
10. Legacy block мигрирует только явно через preview.
11. Один note имеет одного writable editor owner на окно.
12. Database tab не добавляется во вторую split pane в первой версии.
13. Ошибка сохранения остается рядом с объектом, а не только в toast.
14. Layouts используют дизайн-систему Amby, перенимая у Notion только механику.

## 28. Следующий шаг

Архитектурных продуктовых вопросов, блокирующих первый slice, не осталось.
[DB Roadmap](<./Road/DB Roadmap.md>) превращает контракты в конкретный backlog
PR: изменяемые файлы, зависимости, acceptance criteria, tests и безопасный
порядок включения feature flag.
