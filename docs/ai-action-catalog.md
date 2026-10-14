# Каталог действий ИИ-агента Amby

Статус: проект каталога; агентные adapters ещё не реализованы. Версия: 1.
Дата инвентаризации: 2026-09-30, рабочее дерево с незакоммиченными изменениями.

Связанные документы: [контракт](./ai-harness.md), [журнал](./ai-state-format.md),
[план](./Road/ai-harness-plan.md), [оркестрация](./Road/ai-harness-orchestration.md),
[приёмка](./Road/ai-harness-acceptance.md).

## 1. Как читать каталог

Это стартовая карта domain families, а не завершённая инвентаризация каждого
menu item. H-00 сопоставляет её с реальным UI и native IPC, добавляет input/output,
точные schemas, tests и gaps. H-01 закрепляет каждое имя/schema version. До
прохождения соответствующего gate все новые агентные действия со статусом `M`
остаются `missingImplementation`, даже если в приложении уже существует похожий
метод. Этот документ не регистрирует tools и не меняет права приложения.

Статусы: `M` — `missingImplementation`; `U` — `requiresUserInteraction`;
`B` — `blockedByPolicy`; `I` — `implemented` с evidence, пока не присвоен ни одной
строке. Runtime возвращает полный статус, причину, module/capability versions.
Запись нескольких action IDs в строке объединяет только документацию; каждая
команда получает отдельную закрытую schema. Wildcard tools не создаются.

`R`/`W` ниже — логическое чтение/изменение ресурсов. Физические sidecars,
locks и snapshots определяются adapter, согласно контракту shared metadata.
Слово «undo» обозначает требуемую будущую гарантию, не оценку нынешнего UI undo.

## 2. Текущие точки интеграции

| Основа           | Проверенный интерфейс/путь                                                                                                             | Ограничение для агента                                                         |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Storage boundary | [StoragePort](../src/lib/storage/port.ts), [DesktopAdapter](../src/lib/storage/desktop-adapter.ts)                                     | Не выдавать модели raw port; scope и actor нужны в Rust                        |
| Notes            | [commands/notes.rs](../src-tauri/src/commands/notes.rs), `readNote`, `writeNote`                                                       | Есть revision/generation; добавить grant, durable operation ID и editor bridge |
| Структура        | [commands/mutations.rs](../src-tauri/src/commands/mutations.rs), bundle operations                                                     | Рассчитывать весь effect closure и shared undo                                 |
| Базы             | [DatabasePort](../src/lib/storage/database-port.ts), [commands/database.rs](../src-tauri/src/commands/database.rs)                     | Existing API не доказывает scoped query/aggregate и agent recovery             |
| History          | [commands/history.rs](../src-tauri/src/commands/history.rs)                                                                            | Нужны pins журналов и scoped доступ к старым snapshots                         |
| Доски            | [canvas-format.ts](../src/lib/canvas-format.ts), [sketch-format.ts](../src/lib/sketch-format.ts)                                       | Codec не равен headless command API; соблюдать source envelope                 |
| Settings         | [app-config.ts](../src/components/workspace/app-config.ts), [settings repository](../src/lib/storage/settings-repository.ts)           | Raw JSON writes и frontend queues не заменяют backend key-level policy/CAS     |
| Themes           | [themes.ts](../src/lib/themes.ts), [theme preferences](../src/themes/preferences.ts)                                                   | Только валидированные данные и поддерживаемые значения                         |
| Modules          | [SDK](../src/lib/modules/host/sdk.ts), [types](../src/lib/modules/types.ts), [package_manager.rs](../src-tauri/src/package_manager.rs) | Проверить runtime isolation и согласование installer/registry                  |

## 3. Каталог и разрешённые чтения

| Предлагаемые действия                                | Основа                            | Scope и результат                                                  | Пакет; статус |
| ---------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------ | ------------- |
| `app.capabilities.list`, `app.capabilities.describe` | Новый registry                    | Только доступные descriptors, limitations и версии                 | H-10/H-12; M  |
| `workspace.tree.list`                                | `listFiles`                       | R выбранного поддерева; scoped children/counts, cursor             | H-20; M       |
| `note.read`, `note.metadata.get`                     | `readNote`, `getNoteMetadata`     | R note; source revision, bounded chunks; без auto-includes соседей | H-11/H-20; M  |
| `workspace.search`                                   | `searchNotes`                     | R scope до ranking/snippets/limit; query budget                    | H-20/H-32; M  |
| `workspace.tags.list`, `workspace.links.query`       | `listTags`, `getLinkGraph`        | Scoped tags, edges и counts, обе стороны связи разрешены           | H-20/H-40; M  |
| `history.list`, `history.diff`                       | Snapshots + новый journal API     | R истории конкретных ресурсов; after revoke перепроверка           | H-24; M       |
| `run.inspect`, `run.changes.list`                    | Новый runtime/journal             | Scope по каждому событию/receipt, resumable cursor                 | H-24/H-31; M  |
| `settings.describe`, `settings.get`                  | App config + новый typed registry | Только разрешённые keys, type/default/effective scope              | H-44/H-45; M  |

Исторические версии и snippets не получают более широкие права, чем живые
ресурсы. При перемещении заметки в запрещённый раздел старый note ID не сохраняет
доступ. В каталоге не раскрываются названия приватных installed projects/skills.

## 4. Заметки, дерево, связи, вложения

| Предлагаемые действия                                                             | Текущая основа                                                            | Scope, эффекты и требуемый undo                                                                 | Пакет; статус |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------- |
| `note.create`                                                                     | `createNote` + согласованная запись содержимого                           | W parent; no-replace, host ID; undo untouched object через archive                              | H-11; M       |
| `note.patch`, `note.replace`                                                      | `readNote`/`writeNote`                                                    | R/W note, exact revision; snapshot после flush пользователя; lossless source patch              | H-11; M       |
| `folder.create`                                                                   | `createFolder`                                                            | W parent; undo только пустой/неизменённой созданной структуры                                   | H-40; M       |
| `item.rename.preview`, `item.move.preview`                                        | `previewRenameRefactor`, `previewMoveRefactor`                            | R разрешённого closure; безопасный отказ при закрытых backlinks                                 | H-40; M       |
| `item.rename`, `item.move`                                                        | `renameItem`, `moveItem`                                                  | W source/destination + rewritten links/metadata; inverse domain plan                            | H-40; M       |
| `item.archive`, `archive.restore`                                                 | `archiveItem`, `restoreTrash`                                             | W всего bundle; ID manifest, conflict-safe restore; current rights обязательны                  | H-40; M       |
| `item.systemTrash`                                                                | `deleteItem`                                                              | Внешний OS effect, restoration через OS; `manualExternal`                                       | H-40; U       |
| `note.properties.get`                                                             | `getNoteProperties`                                                       | R note; scoped logical projection sidecar                                                       | H-40; M       |
| `note.property.set`, `note.property.remove`, `note.properties.reorder`            | `upsertCustomProperty`, `deleteCustomProperty`, `reorderCustomProperties` | W свойств note; logical field inverse, shared sidecar CAS                                       | H-40; M       |
| `note.tags.patch`, `note.links.patch`                                             | Нужен общий lossless adapter над source/frontmatter                       | R/W note; preserve label/unknown syntax; не сериализовать UI controls                           | H-40; M       |
| `note.icon.set`                                                                   | `use-view-state-store`, `icon-values`                                     | W metadata конкретного объекта; typed `IconValue`, field undo                                   | H-40/H-45; M  |
| `note.layers.list`, `note.layer.create`, `note.layer.attach`, `note.layer.unlink` | `noteLayers`, `createLayer`, attach/unlink APIs                           | Bundle closure; identity/paths/metadata, reversible domain step                                 | H-40; M       |
| `note.layer.archive`                                                              | Новой безопасной операции пока нет; `deleteLayer` использует system trash | W слоя и bundle metadata; нужен internal archive/restore                                        | H-40; M       |
| `asset.importBytes`, `asset.attach`                                               | `importAssetBytes`, существующая note/bundle логика                       | W destination и referencing document; scoped input handle, MIME/size; shared assets сохраняются | H-40; M       |
| `history.restore`                                                                 | `restoreSnapshot`                                                         | W live resource; snapshot перед restore, expected revision                                      | H-23/H-40; M  |

`note.create` с содержимым — один logical step с recovery для промежутка между
созданием и заполнением файла. Оставшаяся пустая заметка не считается полным
успехом. При lossless structured patch нельзя найти однозначный фрагмент —
возвращается диагностика/preview, а не массовая пересериализация документа.

`asset.importBytes` получает bounded data либо host-issued input handle.
Произвольный абсолютный `sourcePath` моделью не задаётся. Системный picker может
выдать handle выбранного пользователем файла; grant на весь каталог не возникает.

### 4.1 Расхождение текущих контрактов удаления

AGENTS.md и [data-safety-contract](./data-safety-contract.md) задают vault-local
restorable deletion. [Актуальный vault-format](./vault-format.md) и проверенные
`delete_item`/`archive_item` в рабочем дереве различают system trash и internal
archive. H-00 обязан зафиксировать это расхождение перед реализацией. Настоящий
проект использует разные action IDs и не объявляет нынешнее OS удаление
автоматически обратимым. Эти документы не меняют реализацию удаления и не
переопределяют репозиторные инструкции.

## 5. Базы и представления

Авторитетные значения строк находятся в Markdown frontmatter; schema и views —
в durable manifest/`.ambd/`; SQLite — rebuildable projection. Legacy shards
и fallback чтения описаны в [database format](./database-format.md); нельзя
самостоятельно мигрировать их «для удобства» агента.

| Предлагаемые действия                                                                 | Методы DatabasePort / gap                                           | Scope, проверка и undo                                              | Пакет; статус |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------- |
| `database.list`, `database.describe`                                                  | `listDatabases`, `getDatabaseNoteContext`                           | R schema и разрешённые rows; не выдавать private totals             | H-41; M       |
| `database.query`, `database.aggregate`                                                | `queryDatabase`, `aggregateDatabase`                                | Policy до вычисления relation/rollup/count; bounded query           | H-41; M       |
| `database.create`, `database.rename`                                                  | `createDatabase`, `renameDatabase`                                  | W parent/container; attached/standalone, durable manifest inverse   | H-41; M       |
| `database.property.create`, `database.property.rename`, `database.properties.reorder` | Соответствующие create/rename/reorder методы                        | W schema; stable propertyId/storageKey; revision-based inverse      | H-41; M       |
| `database.property.changeType`, `database.property.delete`                            | `changeDatabasePropertyType`, `deleteDatabaseProperty`              | W schema + все изменяемые rows; preview потерь/conversions; backups | H-41; M       |
| `database.values.patch`, `database.relation.set`                                      | `applyDatabaseValueBatch`, `updateDatabaseRelationValue`            | R/W конкретных cells/notes, R relation targets, inverse всей batch  | H-41; M       |
| `database.row.create`, `database.asset.import`                                        | `createDatabaseRow`, `importDatabaseAsset`                          | W parent/row/assets; coordinated IDs и archive undo                 | H-41; M       |
| `database.view.get`, `database.view.create`, `database.view.update`                   | `getDatabaseView`, `createDatabaseView`, `updateDatabaseViewConfig` | R/W view и schema; allowed layout/filter/sort/group types           | H-41; M       |
| `database.view.rename`, `database.view.duplicate`, `database.view.delete`             | Одноимённые DatabasePort методы                                     | W view/order/default references; multi-file inverse                 | H-41; M       |
| `database.views.reorder`, `database.view.setDefault`                                  | `reorderDatabaseViews`, `setDefaultDatabaseView`                    | W manifest, expected revisions, logical inverse                     | H-41; M       |
| `database.yaml.sync`, `database.yaml.resolveConflict`                                 | `syncDatabaseYaml`, `resolveDatabaseYamlConflict`                   | W точных keys; явное решение конфликта, dirty bridge                | H-41; M       |
| `database.template.create`, `database.template.update`, `database.template.apply`     | Полного API в прочитанном DatabasePort нет                          | Требуются общий domain contract и inventory фактических templates   | H-41; M       |
| `database.linkedView.create`, `database.pageLayout.update`                            | Отдельный план развития; текущая поддержка не подтверждена          | Сначала реализованный module API, scoped source и durable metadata  | H-41; M       |

Штатные `undoDatabaseMutation`/`redoDatabaseMutation` не вызываются как «откатить
последнее» без identity: последним может оказаться пользовательский шаг. H-41
связывает domain history с harness operation IDs или использует свой проверенный
inverse adapter. Два независимых undo механизма не должны отменять одну операцию
дважды или потерять промежуточные пользовательские изменения.

Все layouts и property types перечисляет актуальный module descriptor. Новые
возможности из [плана баз](./notion-database-parity-audit-2026-09-30.md) появляются
в каталоге после их реализации и проверки. Обязательный scenario нельзя закрыть
«табличным view» вместо запрошенного другого layout без решения пользователя.

## 6. Canvas и Excalidraw

Согласовать с [планом единой доски](./excalidraw-canvas-claude-plan.md).
Один renderer не означает один формат: `.canvas` и `.excalidraw` сохраняют
свои источники и ограничения. Предлагаемая внешняя family `board` использует
общий command service и отдельные codec adapters; старый Canvas UI не становится
второй независимой реализацией агентных команд.

| Предлагаемые действия                                          | Основа/gap                                     | Scope, результат и undo                                                     | Пакет; статус     |
| -------------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------- | ----------------- |
| `board.create`, `board.read`                                   | `createCanvasFile`, `createSketchFile`, codecs | Format явно задан; R/W board parent/source; no UI mount                     | H-42/H-43; M      |
| `board.card.insert`, `board.card.update`, `board.card.remove`  | Общие commands из плана доски                  | W scene, R embedded notes/assets; stable element IDs, snapshot/inverse      | H-42/H-43; M      |
| `board.edge.connect`, `board.edge.update`, `board.edge.remove` | Headless domain service требуется              | W scene; валидные endpoints/bindings; geometric link не relation базы       | H-42/H-43; M      |
| `board.elements.patch`, `board.elements.duplicate`             | Sketch/Canvas codec + domain validator         | W selected elements, unknown fields остальных сохранены                     | H-42/H-43; M      |
| `board.group`, `board.ungroup`, `board.layout`                 | Shared grouping/layout commands                | W explicit selection; finite geometry, bounded cost, deterministic seed     | H-42/H-43; M      |
| `board.drawing.add`                                            | Excalidraw-only shapes/text/arrows             | W `.excalidraw`; `.canvas` возвращает unsupportedCapability                 | H-43; M           |
| `board.card.convertToNote`                                     | Composite note+board domain command            | W parent + scene; создание note и замена card согласованы, dependency undo  | H-40/H-42/H-43; M |
| `board.validate`, `board.preview`                              | Headless validation/render bridge              | R scene и всех включённых в preview sources; результаты с revisions         | H-42/H-43; M      |
| `board.export`                                                 | Export pipeline требуется inventory            | R scene, W scoped destination либо user-picked handle; no silent conversion | H-42/H-43; M      |

Preview проверяет отсутствующие targets, finite coordinates, bounds, bindings и
читаемость. Модель не получает screenshot с недоступными note cards. Без прав
на исходный embed показывается нейтральная заглушка без кэшированного текста.
Внешний URL в карточке не даёт права выполнить network fetch.

Если requested drawing невозможно выразить в исходном формате, preview предлагает
явное создание/преобразование копии. Открытие `.canvas` не превращает его в
`.excalidraw`. Сохранение unknown JSON/opaque fields проверяется настоящими codecs.

## 7. Настройки и оформление

`settings.patch` принимает конечный список typed keys и ожидаемых presence/value
revisions. Он не принимает имя JSON-файла, произвольный JSON pointer или полный
`prefs`. Backend отказывает на неизвестном ключе/значении; нормализация invalid
input в defaults не используется как успешное выполнение команды агента.

### 7.1 Предлагаемый начальный allowlist

В таблице указаны реально наблюдаемые ключи `AppPreferences`, хранящиеся глобально
в `settings.json`. Поддержка workspace override не предполагается автоматически.

| Keys                                                | Значения/ограничения                                     | Права и пакет            |
| --------------------------------------------------- | -------------------------------------------------------- | ------------------------ |
| `prefs.theme`                                       | `system` либо существующий валидный theme ID             | Global appearance; H-44  |
| `prefs.accent`                                      | `violet`, `sky`, `teal`, `emerald`, `amber`, `rose`      | Global appearance; H-44  |
| `prefs.fontScale`                                   | `sm`, `md`, `lg`                                         | Global appearance; H-44  |
| `prefs.fontFamily`                                  | `system`, `sans`, `serif`, `mono`                        | Global appearance; H-44  |
| `prefs.density`                                     | `comfortable`, `compact`                                 | Global appearance; H-44  |
| `prefs.rainbowTree`, `prefs.treeGuides`             | Boolean                                                  | Global appearance; H-44  |
| `prefs.language`                                    | Реестр поддерживаемых языков приложения                  | Global language; H-45    |
| `prefs.tooltipDelayMs`                              | Ограничения актуального typed registry                   | Global interaction; H-45 |
| `prefs.editor.defaultViewMode`                      | `source`, `live`, `read`; live не обходит lossless guard | Global editor; H-45      |
| `prefs.editor.contentWidth`                         | `normal`, `wide`, `full`                                 | Global editor; H-45      |
| `prefs.docks.leftPinned`, `prefs.docks.rightPinned` | Boolean                                                  | Global layout; H-45      |

Все строки allowlist пока имеют статус M. Остальные настройки инвентаризируются
H-45: отсутствие в начальном списке должно иметь причину и явный статус в
runtime catalog. Глобальный effect всегда обозначается пользователю, даже если
run ограничен папкой. Требование «только этот раздел» не даёт global settings grant.

| Действия/область                                                    | Основа и контракт                                                                                     | Пакет; статус     |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------- |
| `theme.list`, `theme.create`, `theme.update`, `theme.select`        | Validator token allowlist; новая пользовательская копия, built-ins immutable; no CSS/JS/remote assets | H-44; M           |
| `workspace.layout.patch`, `workspace.session.patch`                 | `WorkspaceConfig`, `SessionFile`, существующие stores; typed per-object keys, revision/undo           | H-45; M           |
| `workspace.tabs.open`, `workspace.tabs.close`, `workspace.navigate` | Existing tabs/actions; transient с optional persisted session; dirty close guard                      | H-45; M           |
| `module.describe`, `module.setEnabled`                              | Module host + database module state; enable не выдаёт новые permissions                               | H-45; M           |
| `prefs.editor.autosaveMs`, startup/window/shortcuts settings        | Нужны bounds, влияние на lifecycle, individual key policy и native checks                             | H-45; M           |
| Provider profiles/endpoints, credentials, network grants            | Доверенная пользовательская форма; секреты модели не возвращаются                                     | H-30/H-45; U      |
| Security, journal/retention policy, agent budgets/grants            | Host control plane; собственные права агент не меняет                                                 | H-20/H-24/H-31; B |
| Updater, debug logs, experimental flags                             | Отдельный пользовательский flow; не часть appearance grant                                            | H-45; U           |

Просьба поставить произвольный установленный шрифт не считается поддержанной:
нынешняя модель предоставляет четыре font families. Расширение списка требует
отдельного domain/UI контракта и тестов, а не записи неизвестной строки.
Undo setting восстанавливает ключ с учётом отсутствия значения и inheritance;
новое значение соседнего ключа не теряется при общей записи файла.

## 8. Навыки, обучение, плагины и управление заданием

| Предлагаемые действия                                                    | Контракт                                                                            | Пакет; статус     |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- | ----------------- |
| `skill.list`, `skill.read`, `skill.propose`                              | Scoped metadata/content; pinned digests; proposal не активирует навык               | H-50/H-51/H-52; M |
| `skill.evaluate`, `skill.activate`, `skill.rollback`                     | Host-owned evaluation; exact candidate hash, ownership и activation policy          | H-61/H-63; M      |
| `memory.query`, `memory.propose`                                         | Typed provenance; факт/предпочтение/вывод различаются                               | H-62; M           |
| `learning.extract`, `learning.evaluate`                                  | Runtime service jobs с отдельным budget; не unbounded recursive agent tool          | H-60/H-61; M      |
| `plugin.project.create`, `plugin.project.read`, `plugin.project.patch`   | Только выданный project namespace; source versioning/undo                           | H-71; M           |
| `plugin.build`, `plugin.test`, `plugin.preview`                          | Trusted fixed runner; synthetic profile, no arbitrary shell/network                 | H-71/H-72; M      |
| `plugin.install`, `plugin.activate`, `plugin.rollback`, `plugin.disable` | Exact artifact + permissions; user gate для расширения, registry/recovery agreement | H-73; M           |
| `plugin.uninstall`                                                       | Сохранить данные по умолчанию; отдельная очистка с preview                          | H-73; M           |
| `run.undo.preview`, `run.undo.apply`                                     | Dependency closure, current grant, inverse revisions; отдельные receipts            | H-23/H-24; M      |
| `run.stop`, `run.resume`                                                 | Доверенные user controls; pending writes сначала reconcile                          | H-31/H-33; U      |

Learning services вызываются host по настройке пользователя. Навык не может
сам активировать новую версию или произвольно запускать evaluator тысячи раз.
Служебные operations видны в журнале, но не все являются доступными модели tools.

## 9. Намеренные границы

| Возможность                                                                  | Статус и причина                                                           |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Произвольные `readFile`/`writeFile`, `readGlobalRaw`/`writeGlobalRaw`        | B: обход typed adapters, policy, invariants и undo                         |
| Shell/process/native code приложения                                         | B: вне SDK мастерской и пространства пользователя                          |
| Выбор vault/системного файла, ввод API key                                   | U: доверенный OS/credential flow выдаёт конкретный handle                  |
| Постоянный purge, очистка AI audit/undo snapshots                            | U: user control plane, preview необратимых последствий                     |
| Произвольная отправка данных, публикация, clipboard/external open            | B в обычной grant; отдельный явно разрешённый connector contract требуется |
| Изменение чужих metadata `.obsidian/`, `.git/` и произвольных `.amby/` files | B: domain operations работают только с собственной объявленной metadata    |
| Vault ID migration, backup recovery, rebuild index                           | U по умолчанию: domain maintenance, собственные recovery contracts         |

Внутренний index refresh после mutation — host effect и отражается в receipt.
Он не разрешает модели запустить миграцию source data. Команда полного rebuild
не должна раскрывать названия/ошибки закрытых объектов через progress.

## 10. Правило расширения каталога

Для каждого нового модуля, включая [творческий модуль](./creative-workshop-plan.md),
реализация предоставляет domain descriptor, source-of-truth, typed operations,
scope resolver, preconditions, verifier, undo/recovery и acceptance evidence.
Только после этого новая возможность появляется в агентном каталоге.
Просьба агента «включить модуль» не делает запланированную функцию реализованной.

H-00/H-46 ведут coverage ledger: user action → domain operation → agent action →
permission → inverse → scenario → evidence. Для необратимых/manual действий
фиксируется честное исключение; для обязательных сценариев `missingImplementation`
блокирует соответствующий gate. Подготовка этого проекта каталога не является
свидетельством полноты ledger.
