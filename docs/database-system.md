# Система баз данных Amby

Статус: архитектурное предложение
Версия документа: 1
Дата: 2026-09-04

## 1. Цель

Базы данных Amby должны давать удобство Notion-подобных коллекций, не создавая
вторую закрытую модель документов. Главный инвариант:

> Каждая строка базы — обычная Markdown-заметка с устойчивым `amby-id`.

База определяет общую схему свойств, способ включения заметок и набор
представлений. Текст заметки, вложения и связанные слои остаются доступны без
модуля баз данных. SQLite используется только как перестраиваемый индекс и не
является источником истины.

В этом документе «база» означает пользовательскую коллекцию, а «индекс» —
внутреннюю `.amby/notes.db`.

## 2. Что полезно перенять у Notion

Нужно перенять не внешний вид таблицы, а разделение сущностей:

- строка является страницей, а не анонимной записью;
- схема свойств принадлежит источнику данных, а значения — строкам;
- несколько представлений показывают одни данные по-разному;
- фильтры, сортировки, группировка и видимость колонок принадлежат конкретному
  представлению;
- связанное представление ссылается на исходную базу, поэтому изменение данных
  видно везде, а локальная настройка вида не меняет источник;
- relation связывает записи по устойчивым идентификаторам, rollup вычисляет
  агрегат поверх relation.

В Amby это должно работать поверх файлов и устойчивых идентификаторов, без
облачных сущностей и без исполнения произвольного SQL или JavaScript.

Справочные материалы Notion:

- <https://www.notion.com/help/what-is-a-database>
- <https://www.notion.com/help/views-filters-and-sorts>
- <https://www.notion.com/help/relations-and-rollups>
- <https://www.notion.com/help/guides/databases-reimagined-whats-changed>

## 3. Аудит текущего состояния

Сейчас в репозитории существуют три независимых прототипа одной функции.

### 3.1. Database layer

`bundle/layers.rs` умеет создать `Metadata.md` с блоком `amby-db`, однако
содержимое `[]` не имеет версии, устойчивой схемы и backend-сервиса. Слой можно
создать из нескольких UI-точек, хотя модуль `databases` помечен как `preview`.

### 3.2. Встроенный `amby-db` block

`AmbyBlockView.tsx` хранит простую таблицу строк в
`.amby/blocks/<block-id>.json`. У нее нет типизированных колонок, привязки строк
к заметкам, версионирования, CAS/revision, обработки ошибок сохранения,
межоконной синхронизации и восстановления. Отложенная запись отменяется при
размонтировании, поэтому последняя правка потенциально может не попасть на
диск.

### 3.3. Custom properties

`properties.json` и `note_custom_properties` уже дают заметкам свойства, но
каждый `CustomProperty` одновременно содержит определение поля и его значение.
Тип, значение и настройки представлены строками. Такая форма не позволяет
иметь одну общую схему базы, надежно менять типы, строить relation/rollup или
валидировать запросы.

### 3.4. Модульная граница

Текущий `activeModules` управляет в основном кнопками панелей. Разрешения
manifest пока advisory, lifecycle hooks пусты, а действия слоя базы не связаны
с одной проверкой capability. Поэтому «выключено» еще не является настоящим
состоянием модуля.

### 3.5. Вывод аудита

Нельзя наращивать возможности отдельно в `AmbyBlockView`, `Metadata.md` и
`CustomProperty`. Сначала нужен единый домен свойств и баз, затем все UI-входы
должны стать его клиентами.

## 4. Доменная модель

### 4.1. Основные сущности

```text
Markdown note (Record)
        │ stable amby-id
        ▼
Database membership ──► Database definition ──► Property definitions
        │                         │
        │                         └─────────────► Saved views
        ▼
Property values
```

#### Record

Ссылка на существующую заметку:

```ts
interface RecordRef {
  noteId: string
}
```

Заголовок строки — системное свойство `title`, связанное с названием заметки.
Title уникален во всей owning database, включая sub-items, после Unicode/case
normalization. Rename Title переименовывает реальный `.md` и его bundle через
существующий refactor pipeline. Внешний дубликат никогда не переименовывается
автоматически: обе строки видимы с диагностикой до ручного разрешения.

Открытие строки открывает ту же заметку в peek, вкладке или отдельном окне.
Создание строки проходит через обычную безопасную команду создания заметки.

#### DatabaseDefinition

```ts
interface DatabaseDefinition {
  format: "amby-database"
  formatVersion: 1
  databaseId: string
  name: string
  membership: { kind: "filesystem-descendants"; recursive: true }
  properties: PropertyDefinition[]
  viewOrder: string[]
  defaultViewId: string | null
  templateOrder: string[]
  defaultTemplateId: string | null
}
```

`databaseId`, идентификаторы свойств, вариантов select/status, представлений и
шаблонов — ULID. Отображаемое имя никогда не используется как ключ. Runtime
revision вычисляется по raw bytes и не хранится внутри JSON.

#### Membership

Состав базы определяется файловой иерархией, а не скрытым списком:

- заметки внутри каталога с `ambd.json` являются строками базы;
- обычные подпапки можно использовать как категории, их заметки остаются
  строками той же базы;
- папка bundle, содержащая одноименную основную заметку, представляет строку с
  дочерними строками;
- ближайший родительский контейнер с `ambd.json` является владельцем строки;
- перенос заметки внутрь/наружу добавляет или удаляет ее из базы без отдельной
  membership-записи.

Пример Notion-подобных sub-items:

```text
Персонажи/
├── ambd.json
├── Алиса/
│   ├── Алиса.md
│   ├── Ученик Алисы.md
│   └── Семья/
│       └── Сестра Алисы.md
└── Борис.md
```

`Алиса`, `Ученик Алисы`, `Сестра Алисы` и `Борис` являются строками одной базы.
`Ученик` и `Сестра` отображаются как дочерние строки Алисы; обычная папка
`Семья` помогает организовать файлы, но сама строкой не является. Системные
свойства `Parent` и `Sub-items` вычисляются из структуры файлов.

Drag-and-drop строки на другую строку выполняет обычное безопасное filesystem
move. Если родитель был одиночным `.md`, он сначала атомарно превращается в
bundle. Нельзя создать цикл или переместить строку за пределы разрешенного
vault.

Удаление строки с sub-items предлагает удалить весь bundle в Trash либо удалить
только родителя и атомарно поднять дочерние строки на его уровень. Preview
показывает число всех затронутых страниц.

Строка внешней базы может иметь собственный database layer. Ее основная
одноименная `.md` остается строкой внешней базы, а дочерние заметки принадлежат
ближайшему внутреннему `ambd.json`. Scan не должен одновременно включать их в
обе базы.

#### PropertyDefinition и PropertyValue

Определение отделено от значения и представлено discriminated union, а не
набором строк:

```ts
type PropertyDefinition =
  | { id: string; name: string; type: "text" }
  | { id: string; name: string; type: "number"; format: NumberFormat }
  | { id: string; name: string; type: "checkbox" }
  | { id: string; name: string; type: "date"; includeTime: boolean }
  | { id: string; name: string; type: "select" | "status"; options: SelectOption[] }
  | { id: string; name: string; type: "multiSelect"; options: SelectOption[] }
  | { id: string; name: string; type: "url" }
  | { id: string; name: string; type: "files"; mediaOnly: boolean }
  | {
      id: string
      name: string
      type: "relation"
      targetDatabaseId: string
      maxItems: 1 | null
      inverse: InverseRelation | null
    }
  | { id: string; name: string; type: "rollup"; config: RollupConfig }
  | { id: string; name: string; type: "formula"; expression: FormulaAst }
```

Значения также типизированы. Даты хранят ISO-значение, исходный timezone и
необязательный конец диапазона; number не проходит через локализованную строку;
select хранит ID варианта; relation хранит `noteId`. Неизвестное или более новое
значение сохраняется как opaque payload и показывается read-only вместо
удаления.

`Status` отличается от обычного Select: его варианты входят в настраиваемые
группы `notStarted`, `inProgress` и `done`; названия и цвета самих вариантов
остаются пользовательскими.

Обычные значения дочерней строки не наследуются от родителя. `Parent` и
`Sub-items` отражают только иерархию; явное получение данных родителя позднее
делается через relation/rollup или formula.

Системные поля `title`, `created`, `modified`, `path`, `tags`, `backlinks` и
`wordCount` вычисляются из заметки/индекса. Их можно показывать, фильтровать и
сортировать, но нельзя удалить как обычное поле базы.

### 4.2. Локальные свойства и свойства базы

Существующие custom properties заметки остаются локальными свойствами. Поля
базы являются общей схемой и не копируются в каждую заметку. В Info panel
свойства показываются секциями:

```text
Локальные свойства
Проекты / свойства базы
Клиенты / свойства базы
```

Одна заметка имеет одну owning database, определенную ближайшим родительским
`ambd.json`. В других базах она появляется через Relation, а в других местах
интерфейса — через linked view исходной базы. Одинаковые отображаемые имена
полей из разных баз не означают одинаковый `propertyId`.

## 5. Источники истины и формат на диске

### 5.1. Определение базы

Определение базы хранится в `ambd.json` внутри ее контейнера. Это специальный
переносимый файл, а не пользовательская заметка и не строка SQLite:

```json
{
  "format": "amby-database",
  "version": 1,
  "id": "01...",
  "name": "Projects",
  "membership": { "kind": "filesystem-descendants", "recursive": true },
  "properties": [],
  "views": []
}
```

Для базы-слоя и самостоятельной базы структура отличается только наличием
основной заметки:

```text
Персонажи истории/          Персонажи/
├── Персонажи истории.md    ├── ambd.json
├── ambd.json               ├── Алиса.md
├── Алиса.md                └── Борис.md
└── Борис.md
```

Amby скрывает `ambd.json` в своем дереве и распознает контейнер как базу по
точному `format` и поддерживаемой версии. Неизвестные JSON-поля сохраняются.
Поврежденный или слишком новый файл не блокирует открытие основной заметки или
вложенных строк: база переходит в read-only Source/Repair mode.

SQLite зеркалирует определение для запросов, но удаление `.amby/notes.db`
должно полностью восстановить схему и виды из `ambd.json`.

### 5.2. Значения свойств базы

Значения базы хранятся внутри ее переносимого контейнера, а не в глобальной
метадиректории vault:

```text
Персонажи/
├── ambd.json
├── .ambd/
│   ├── records/
│   │   └── <note-id>.json
│   ├── recovery/
│   └── trash/
└── Алиса.md
```

`.ambd/` скрывается в дереве Amby и исключается из note indexing. Один record
shard содержит `databaseId`, `noteId`, `formatVersion`, `revision` и значения по
устойчивым `propertyId`. Запись одной ячейки атомарно меняет только один shard.
Массовые операции используют журнал в этом же контейнере.

Если заметку вынести из базы, ее значения этой базы сохраняются в shard, но не
участвуют в запросах. Возврат заметки восстанавливает значения. Их удаление
выполняется только отдельной cleanup-командой с preview и подтверждением.

Эти файлы являются durable data, а не кэшем. Копирование или перемещение папки
базы переносит схему, views, templates, значения и связи вместе с Markdown
строками. `notes.db` остается единственной удаляемой и полностью
перестраиваемой частью.

### 5.3. Локальные свойства заметок

Текущий монолитный `.amby/properties.json` продолжает относиться только к
локальным свойствам заметок. До интенсивного табличного редактирования его нужно
перевести versioned migration на per-note shards в `.amby/properties/notes/`.
Эта миграция не переносит database values обратно в глобальное хранилище.

Переход с `properties.json` требует отдельной миграции по правилам
`docs/engineering.md`: read-only preflight, raw backup, журнал, идемпотентный
resume, rollback и запись результата. Старый файл не удаляется до подтверждения
успешной проверки.

Для совместимых простых типов используется гибридная модель. Полная
типизированная запись остается в property shard, а пользователь может явно
привязать выбранное поле базы к ключу YAML frontmatter. Связи, вычисляемые поля
и внутренние IDs в YAML не экспортируются. Включение, изменение направления и
отключение привязки требуют preview; синхронизация не является неявным условием
работы базы.

Двусторонняя синхронизация первой версии поддерживает Text, Number, Checkbox,
Date, Select, Multi-select и URL. Files & media и Relation остаются Amby-only.
YAML key хранится как отдельная стабильная привязка: rename свойства не меняет
ключ без отдельного preview. Если shard и внешний YAML изменили одно поле после
общей revision, Amby показывает field-level conflict и не применяет
last-write-wins.

### 5.4. Встроенное связанное представление

`amby-db` в обычной заметке больше не хранит собственные строки. Он ссылается на
базу и сохраненное представление:

````markdown
```amby-db
{"version":1,"databaseId":"01...","viewId":"01..."}
```
````

При вставке конфигурация выбранного view копируется в локальные overrides блока.
Строки и значения остаются общими, но последующие изменения фильтра, сортировки
или layout внутри блока не меняют исходный saved view. Блок предлагает команды
`Open source database` и `Reset from source view`.

Изменение ячейки идет в исходный record, изменение общей схемы — в `ambd.json`,
изменение локального вида — в переносимую конфигурацию блока. `.amby/blocks/`
может быть кэшем или recovery draft, но не единственной копией конфигурации либо
данных.

### 5.5. Шаблоны строк

База может хранить несколько versioned templates в
`.ambd/templates/<template-id>.json`; `ambd.json` хранит их порядок и default ID.
Template содержит название, Markdown-заготовку body и начальные значения общих
свойств. Кнопка New предлагает выбрать template.

Template копируется только при создании заметки. Его последующее изменение не
переписывает уже созданные строки. Медиа не встраивается бинарными данными в
JSON; шаблон может содержать только переносимые ссылки или инструкции для
явного копирования asset.

## 6. SQLite как перестраиваемый query index

Индекс нормализует данные примерно в следующие таблицы:

```text
database_defs(id, note_id, revision, source_json)
database_properties(id, database_id, type, name, position, config_json)
database_members(database_id, note_id, position, source)
database_values(database_id, note_id, property_id, value_type, value_json)
database_relations(property_id, source_note_id, target_note_id, position)
database_views(id, database_id, type, name, position, config_json)
```

Внешние ключи и индексы обязательны. Кэш строится из `ambd.json` и property
shards. Неизвестные версии не индексируются как частично понятные данные.

Frontend не отправляет SQL. Он отправляет версионированный `DatabaseQuery`:

```ts
interface DatabaseQuery {
  databaseId: string
  filter: FilterGroup | null
  sorts: SortRule[]
  group: GroupRule | null
  search: string | null
  cursor: string | null
  limit: number
}
```

Rust валидирует IDs, типы операторов, глубину filter AST и лимиты, затем строит
параметризованный SQL. Порядок всегда детерминирован: после пользовательских
sort rules добавляется `noteId`. Для больших выборок применяется keyset cursor,
а UI виртуализирует строки и колонки.

Ответ содержит `snapshotRevision`. Мутация со старой revision возвращает
конфликт, а не молча перезаписывает внешнее или межоконное изменение.

## 7. Представления

`DatabaseView` хранит только проекцию над данными:

- layout: `table`, `board`, `list`, `gallery`, позднее `calendar` и `timeline`;
- порядок, ширину и видимость свойств;
- filter AST с явными AND/OR groups;
- последовательность сортировок;
- group/subgroup;
- режим открытия строки;
- настройки конкретного layout.

View не содержит копии строк. Временные значения — выделение, scroll,
незавершенный resize, открытое меню — остаются session state и не попадают в
`ambd.json`.

Фильтры, многоуровневая сортировка, group/subgroup, порядок и видимость свойств
автоматически сохраняются в текущем view. Быстрый текстовый поиск остается
временным. Для изменения настроек без затрагивания исходного view пользователь
дублирует представление. Filter AST поддерживает явные вложенные AND/OR groups.

Без активной сортировки строки можно переставлять вручную. Ручной порядок
хранится по `noteId` отдельно для каждого view; включенная сортировка временно
отключает reorder, но не удаляет сохраненный порядок.

View имеет режим sub-items `nested` или `flat`. В nested-режиме сортируются
siblings каждого уровня с сохранением иерархии; в flat-режиме все строки
сортируются общим набором. Если filter совпал с дочерней строкой, но не с
родителем, результат остается видимым с приглушенным breadcrumb до родителя.

Первая пользовательская версия включает `table`, `board`, `list` и `gallery`.
Table остается первым техническим slice, на котором доказываются типы,
сохранение и query engine. Title всегда остается первой frozen-колонкой;
пользователь может закрепить дополнительные колонки. Footer поддерживает Count,
Count empty, Sum, Average, Min и Max в рамках результата текущего view.

Board первой версии группирует только по Status и одиночному Select; перенос
карточки между колонками меняет значение поля. Multi-select и Relation не
группируют Board, чтобы не создавать несколько визуальных копий одной строки.
List показывает компактный настраиваемый набор свойств. Gallery выбирает card
preview в следующем порядке: указанное поле Files & media, первая картинка из
заметки, иконка заметки, пустой preview. Calendar, timeline, charts, forms и
automations остаются следующими этапами.

По клику строка по умолчанию открывается в Side peek, не закрывая базу. Внутри
доступны две секции свойств и обычный редактор Markdown-описания. Кнопка
открывает ту же заметку в полноценной вкладке; `Escape` закрывает peek, а
`Ctrl/Cmd + click` сразу открывает вкладку. View хранит режим открытия
`sidePeek`, `centerPeek` или `fullPage`; первая версия может начать с рабочего
`sidePeek` и добавить остальные режимы без изменения формата данных.

На широком экране Side peek показывает Markdown-описание слева и две секции
свойств справа. На узком экране свойства становятся сворачиваемым блоком над
текстом. Оба layout используют один document/property state, а не отдельные
копии.

Панель Databases показывает самостоятельные базы и database layers, раскрывает
их saved views и позволяет закреплять часто используемые элементы. Из панели
можно открыть базу/view во вкладке, создать standalone database, подключить
database layer к текущей заметке или перетащить view в редактор как linked
`amby-db` block.

Глобальный Search использует тот же query contract и умеет искать значения
свойств, а также ограничивать результат по database, property, Status и
Relation. При выключенном Databases module database-specific фильтры скрыты,
обычный поиск по Markdown продолжает работать.

Database может быть locked. В locked-состоянии разрешено редактировать значения
и содержимое страниц, но запрещено менять схему, saved views и файловое
membership. Поиск и временные фильтры остаются доступны; разблокировка явная.

Для страницы строки schema хранит независимую от views настройку каждого поля:
`alwaysShow`, `hideWhenEmpty` или `alwaysHide`. Она управляет Info panel/peek, но
не видимостью колонки конкретного view.

Композиция интерфейса следует знакомой механике Notion — header, tabs views,
Filter, Sort, Group, Properties, Search и New — но использует компоненты,
типографику, IconValue и theme tokens Amby. Плотность наследуется из глобальной
настройки и может быть переопределена view значением `compact`, `default` или
`tall`.

Создание строки из однозначно отфильтрованного view или Board column подставляет
соответствующие значения. Контекст создания имеет приоритет над конфликтующим
default из row template, чтобы новая строка не исчезала из текущего view.

## 8. Relations, rollups и formulas

### Relations

Relation хранит устойчивые `noteId`, поэтому rename/move ничего не ломает. При
создании поля выбирается любая целевая база, включая текущую, а cardinality
ограничивает значение одной записью или разрешает несколько. Пользователь может
создать обратное поле с отдельным названием. Обратная сторона вычисляется из
канонического relation edge, а не записывается вторым независимым значением.
Удаленная или временно недоступная заметка остается unresolved reference и
может восстановиться из Trash.

Если связанная заметка покинула target database, edge сохраняется и помечается
`outsideDatabase`; ссылка продолжает открываться. При копировании контейнера в
другой vault внутренние relations восстанавливаются по ID, а отсутствующие
внешние цели остаются unresolved до появления соответствующей базы/заметки.

### Rollups

Rollup задает relation property, target property и allowlisted aggregate:
`count`, `countUnique`, `sum`, `average`, `min`, `max`, `earliest`, `latest`.
Значение вычисляется и кэшируется; оно никогда не становится источником истины.

### Formulas

Formula — собственный парсер и типизированный AST. Запрещены `eval`, JavaScript,
динамический импорт, сетевой доступ и сырой SQL. Функции pure и allowlisted,
вычисление имеет лимиты глубины/операций. Граф зависимостей обнаруживает циклы и
показывает диагностическое значение вместо зависания.

Relation входит в первую пользовательскую версию. Rollup и formula не входят в
первый table slice: сначала должны быть доказаны типы, сохранение, конфликтная
модель и rebuild индекса.

## 9. Граница отключаемого модуля

Нужно разделить две вещи:

- **Property kernel** — небольшое всегда доступное ядро типов/значений, нужное
  Info panel, поиску и другим модулям;
- **Databases module** — схемы коллекций, membership, query engine, views,
  database layer и embedded views.

При выключенном `databases`:

- скрыты панель, создание/подключение слоя, переключатель database layer,
  команды вставки database block и database-specific settings;
- не запускаются query subscriptions, formula/rollup evaluation и построение
  database-specific кэша;
- существующие `ambd.json`, legacy `Metadata.md`, `amby-db` blocks и property
  shards не изменяются и не удаляются;
- обычные заметки, локальные свойства, поиск, ссылки и редакторы работают;
- generic Markdown editor видит `amby-db` как сохраняемый code fence;
- повторное включение валидирует durable files и перестраивает индекс.

Выключение сначала flush-ит ожидающие подтвержденные мутации и отписывает UI.
Оно не запускает миграцию формата. Если flush завершить нельзя, пользователь
получает явную ошибку, а модуль не сообщает ложное состояние «выключен».

Все entry points используют одну capability-проверку. Нельзя отдельно скрыть
панель и оставить активной команду создания слоя. Backend-команды также
проверяют состояние/контекст capability, а не полагаются на отсутствие кнопки.

`activeModules` отвечает за функциональность, а activity-bar layout — только за
расположение/видимость кнопок. Эти понятия не должны снова сливаться в одну
проверку.

## 10. Архитектура frontend и IPC

```text
Database UI / Info panel / Folder view / Search
                    │
                    ▼
             useDatabaseStore
                    │
                    ▼
            DatabaseRepository
                    │
                    ▼
               StoragePort
              /           \
        Tauri adapter    Web adapter
              │
              ▼
      Rust database service
      ├── definition parser
      ├── property store
      ├── query compiler
      └── index projector
```

Компоненты не читают `loadVaultJSON` и не пишут sidecar напрямую.
`AmbyBlockView` становится renderer/controller, а не хранилищем. Workspace
получает нормализованное состояние через один Zustand store и focused hooks;
таблица, Info panel и Folder view не создают параллельные копии строк.

Минимальные backend operations:

```text
list_databases
read_database_definition
create_database
update_database_schema(expected_revision)
query_database(query, snapshot_revision?)
set_database_value(note_id, property_id, value, expected_revision)
apply_database_batch(expected_revisions)
add_database_member / remove_database_member
```

Результат мутации различает durable commit и состояние индекса:

```ts
interface DatabaseMutationOutcome {
  durableRevision: string
  indexState: "healthy" | "rebuildRequired"
  warnings: string[]
  changedNoteIds: string[]
}
```

Если durable file уже записан, а обновление SQLite не удалось, команда не
возвращает двусмысленное «ничего не сохранено». Она сообщает commit и
`rebuildRequired`; повторный scan восстанавливает кэш.

Web adapter реализует тот же контракт на небольшой reference engine. Общие
contract tests обязаны проходить для desktop и browser fallback, даже если
browser-версия не обещает производительность native backend.

## 11. Конкурентность, история и внешние изменения

- Все записи конкретного property shard сериализуются по `noteId`.
- Schema/view writes сериализуются по `databaseId`.
- Каждая мутация использует expected revision; last-write-wins запрещен.
- Изменение свойства открытой dirty-заметки не должно очищать dirty state или
  перезаписывать body.
- Успешная мутация публикует межоконное событие с новой revision.
- Autosave UI не очищается до durable acknowledgement.
- Text cells сохраняются через debounce с обязательным flush при blur,
  размонтировании и закрытии view. Discrete types сохраняются сразу. Ошибка
  оставляет recovery draft и видимый pending/error state.
- Перед schema replacement, массовой операцией и миграцией создается snapshot
  или recovery journal.
- Удаление строки проходит через vault-local Trash, потому что строка — заметка.
- Удаление из membership не удаляет заметку. Значения базы удаляются только
  отдельной подтвержденной cleanup-операцией.
- Restore возвращает связь и значения по тому же `noteId`.
- Rename свойства сохраняет его ID и значения. Смена типа требует preview;
  неконвертируемые значения сохраняются как диагностируемые данные.
- Удаленная колонка и ее значения сначала попадают в восстанавливаемую корзину
  базы, а не уничтожаются немедленно.

Удаление базы разделено на две команды. `Remove database, keep pages` отправляет
`ambd.json` и `.ambd/` в Trash и превращает контейнер в обычную папку, сохраняя
все `.md`. `Delete database with pages` показывает число затрагиваемых заметок
и переносит контейнер целиком в vault-local Trash.

Для Files & media одиночная строка при необходимости становится bundle, а
импортированный файл атомарно помещается в ее `assets/`. Значение содержит
относительную ссылку. Очистка значения не удаляет asset автоматически;
неиспользуемые вложения удаляются отдельной операцией с preview.

Подключение database layer к заметке с существующими дочерними заметками сначала
показывает preview; после подтверждения они становятся строками без физического
перемещения. Команда `Add existing pages` и drag из дерева, наоборот, явно
показывают будущие filesystem moves, сохраняют IDs/ссылки/assets и используют
существующий refactor pipeline. Строка не может одновременно иметь две owning
databases.

Multi-selection поддерживает массовое изменение свойства, Relation, move и
delete-to-Trash. Операция валидируется целиком и выполняется через журнал: после
частичного сбоя доступны resume или rollback.

Table поддерживает стрелки, Enter, Tab, Shift+Tab, Escape и copy/paste диапазона.
Вставка нескольких ячеек сначала валидирует типы и показывает preview
неприменимых значений; она выполняется как одна batch operation.

CSV import сначала показывает mapping колонок, типы и список создаваемых
Markdown-заметок. CSV export работает для текущего view или всей базы; Relation
и Files & media сериализуются как переносимые ссылки. Импорт не перезаписывает
существующие заметки по одному совпадению title.

Создание новой базы предлагает empty database либо копию schema, views и row
templates существующей базы без строк. Полное клонирование с rows/assets и
перегенерацией всех внутренних IDs остается после первой версии. Ручная копия
внутри одного vault с duplicate IDs диагностируется и никогда не исправляется
автоматически.

Database имеет IconValue и необязательную cover-ссылку на asset контейнера.
Schema mutation создает snapshot `ambd.json`, а view/template mutation —
snapshot соответствующего shard. Правки одной ячейки объединяются в историю
сессии, batch/CSV import записываются как одна восстанавливаемая операция. Undo
не создает обходной небезопасный write path.

## 12. Ошибки и безопасное ухудшение

IPC должен возвращать стабильные машинные коды как минимум для:

```text
moduleDisabled
databaseNotFound
schemaRevisionConflict
recordRevisionConflict
schemaMismatch
invalidPropertyValue
malformedDatabaseDefinition
unsupportedDatabaseVersion
identityConflict
noteReadOnly
staleQueryCursor
indexRebuildRequired
```

Ни одна из этих ошибок не должна делать Markdown-заметку недоступной. При
непонятной схеме база становится read-only, исходный `ambd.json` остается
открываемым в Source/Repair mode, а opaque поля не выбрасываются.

## 13. Миграция существующих прототипов

### Existing custom properties

Они мигрируют в локальные свойства заметок без изменения семантики. Перенос в
общую схему базы выполняется отдельным wizard с preview сопоставления по
`name + type`; исходные значения не удаляются до подтверждения результата.

### Existing `Metadata.md` with `[]`

Считается legacy empty database layer. Файл не переписывается при обычном
сканировании. При первом открытии показывается preview создания version-1
`ambd.json`, backup и возможность отмены. После успешной проверки старый файл
остается в backup до явной cleanup-операции.

### Existing block sidecars

Таблица `columns + rows` не может быть автоматически превращена в базу заметок:
в строках нет `noteId`, а создание заметки на каждую строку меняет vault.
Поэтому legacy block остается доступным read-only/editable в старом режиме, а
явная команда Convert показывает:

- какие заметки будут созданы;
- какую колонку использовать как title;
- тип и ID каждого нового свойства;
- куда будет помещена база;
- какие файлы и snapshots появятся.

Исходный JSON сохраняется до завершения и проверки конверсии.

## 14. План реализации

### Этап 0 — контракт и защита legacy

- Зафиксировать форматы и fixtures.
- Закрыть потерю последней debounce-записи legacy block: flush on blur/unmount,
  обработка ошибки и recovery draft.
- Связать все database entry points с единой capability-проверкой.
- Оставить экспериментальный флаг выключенным по умолчанию.

### Этап 1 — property kernel

- Ввести shared typed unions и runtime validation.
- Реализовать versioned migration локальных `properties.json` в property shards.
- Добавить database-local `.ambd/records` для значений общей схемы.
- Добавить revision/CAS, write queues, mutation outcomes и межоконные события.
- Перевести Info panel на новый repository без изменения пользовательского UX.

### Этап 2 — DatabaseDefinition и Table

- Реализовать безопасный parser/writer `ambd.json`.
- Добавить normalized SQLite projection и rebuild.
- Реализовать filesystem membership, создание строки-заметки, sub-items,
  универсальный Relation, typed cells, table query, pagination и virtualization.
- Подключить field-level History/Undo и ручной порядок строк.
- Заменить placeholder панели реальным списком баз.

### Этап 3 — Views, List и linked blocks

- Saved table views, property visibility/order/width, filters, sorts и search.
- List projection и режим открытия Side peek.
- `amby-db` reference block без собственной копии строк.
- Folder view и Search используют общий query API.

### Этап 4 — Board и Gallery

- Общая group/subgroup модель.
- Board для Status и одиночного Select.
- Table aggregates и column freezing.
- Gallery с Files & media, первой картинкой и иконкой как fallback.
- Multi-select batch operations и CSV import/export с preview.
- Завершение первого пользовательского релиза с четырьмя layout.

### Этап 5 — Расширенные relations и rollups

- Двусторонние relation, unresolved references и aggregates.
- Тесты rename/move/trash/restore и циклов между базами.

### Этап 6 — Formulas

- Парсер, type checker, dependency graph, execution budget и diagnostic UI.

### Этап 7 — Multi-source views

Один view сможет объединять несколько owning databases без изменения их
файловой принадлежности:

- `sourceRefs` хранит устойчивые `databaseId` и пользовательские aliases;
- системные поля Title, Created, Modified, Path и Tags общие;
- свойства разных баз никогда не объединяются автоматически по отображаемому
  имени;
- пользователь создает unified column только через явное mapping совместимых
  пар `{ databaseId, propertyId }`;
- query compiler строит параметризованный `UNION ALL` и добавляет
  `(databaseId, noteId)` как стабильный tie-breaker cursor;
- редактирование маршрутизируется в owning database и ее `.ambd/records`;
- перенос строки между базами остается отдельной filesystem-операцией с preview
  mapping свойств;
- недоступный source оставляет view частично рабочим и показывает диагностику,
  не удаляя ссылку;
- multi-source view хранится в host `.ambd/views/<view-id>.json` либо в
  переносимой конфигурации embedded block, а схемы исходных баз остаются
  независимыми.

Multi-source не входит в первую версию: сначала один source должен доказать
корректность membership, typed queries, relations и conflict handling.

Каждый этап должен быть отдельным небольшим PR. Нельзя объединять format
migration, query engine и полный UI в одну поставку.

## 15. Обязательные проверки

### Модульность

- Выключение скрывает все entry points и не меняет durable files.
- После перезапуска модуль остается выключенным.
- Повторное включение восстанавливает те же базы и виды.
- Simple preset открывает заметки с database blocks без потери байтов.

### Целостность

- Удаление `notes.db`, `-wal` и `-shm` с последующим rebuild не меняет результат.
- Rename/move заметки сохраняет membership, значения и relations.
- Перенос строки внутрь и наружу меняет membership по файловой структуре.
- Drag-and-drop на строку создает sub-item без дублирования заметки.
- Ближайший вложенный `ambd.json` корректно меняет owning database.
- Копирование полного контейнера в другой vault сохраняет схему, views,
  templates, значения и relations после rebuild индекса.
- Исключение и повторное добавление строки восстанавливает прежние значения.
- Trash/restore возвращает строку с тем же `noteId`.
- Удаление родителя отдельно от sub-items не оставляет частично перемещенный
  bundle при сбое.
- Обе команды удаления базы восстанавливаются без потери страниц или схемы.
- Изменение шаблона не переписывает существующие строки.
- Удаление media value не удаляет asset без отдельного подтверждения.
- Одновременное изменение YAML и shard дает field-level conflict.
- Batch failure восстанавливается через resume/rollback без частичного сокрытия.
- CSV import не перезаписывает заметку только из-за совпадения title.
- Внешние Title-дубликаты видимы и не переименовываются автоматически.
- Unmount/blur не теряет последнюю debounce-правку ячейки.
- Multi-cell paste проходит общую типовую валидацию до записи.
- Relation остается доступным и диагностируемым после выхода цели из базы.
- Board drag атомарно меняет Status/Select и корректно откатывается при ошибке.
- Поврежденный `ambd.json` или property shard не перезаписывается.
- Старая revision не может затереть внешнее или межоконное изменение.
- Сбой после durable write и до index update дает `rebuildRequired`, а не
  ложный rollback.

### Совместимость

- Новый `ambd.json` и reference `amby-db` имеют golden/contract fixtures.
- Неизвестные JSON-поля сохраняются.
- Unsupported version работает только read-only.
- Поврежденный JSON никогда не перезаписывается автоматическим repair.

### Запросы

- Все filter operators имеют тесты для null/empty и неверного типа.
- Sort стабилен при одинаковых значениях.
- Cursor обнаруживает устаревший snapshot.
- Ни один пользовательский текст не конкатенируется в SQL.
- Циклическая formula завершается диагностикой.

### Масштаб

Нужно зафиксировать benchmark vault минимум на 10 000 заметок и 20 свойств.
Первый экран таблицы не должен загружать все строки в React. Конкретные p95
бюджеты утверждаются после baseline на Windows/macOS/Linux и затем становятся
регрессионным контрактом.

## 16. Решения для первого production slice

Принятые по умолчанию решения:

1. Строка всегда является Markdown-заметкой.
2. Schema живет в `ambd.json`, views/templates — в собственных `.ambd` shards.
3. Значения базы живут в versioned `.ambd/records`; SQLite — только индекс.
4. Membership и sub-items определяются реальной файловой вложенностью.
5. Первая версия содержит Table, Board, List, Gallery и универсальный Relation.
6. Side peek является режимом открытия строки по умолчанию.
7. Базы поддерживают шаблоны новых строк без обратной синхронизации.
8. Исключение строки сохраняет значения до отдельной cleanup-команды.
9. Вложенная база перехватывает владение своими дочерними строками.
10. Linked view разделяет данные, но хранит локальные настройки отображения.
11. Rollup и formula отложены до устойчивого property/query kernel.
12. Простые поля можно явно связать с YAML, полная модель остается в sidecar.
13. Database поддерживает блокировку структуры без блокировки значений.
14. YAML sync двусторонний для простых типов и разрешает конфликты по полям.
15. View автоматически сохраняет настройки и имеет собственный ручной порядок.
16. Первая версия поддерживает batch operations и CSV import/export.
17. История coalesce-ит ввод, а массовые изменения журналируются целиком.
18. Title уникален в owning database и переименовывает реальный файл.
19. Sub-items отображаются в nested или flat режиме.
20. Text autosave всегда flush-ится, а таблица поддерживает keyboard/paste.
21. Table имеет frozen Title и агрегаты, Board группирует Status/Select.
22. Видимость свойства на странице не зависит от видимости колонки view.
23. Property kernel остается доступным приложению, Databases module отключаем.
24. Выключение никогда не удаляет и не мигрирует данные.
25. Frontend не получает raw SQL и не пишет sidecars напрямую.
26. Multi-source views добавляются отдельным этапом через явное typed mapping.

Любое изменение пунктов 1–3 меняет source-of-truth model и требует отдельного
архитектурного решения до начала реализации.
