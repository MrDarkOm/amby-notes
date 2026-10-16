# Состояние, журнал и восстановление ИИ-агента

Статус: проект durable-формата v1, ещё не реализован. Версия документа: 1.
Дата: 2026-09-30.

Основания: [контракт harness](./ai-harness.md), план,
[сохранность данных](./data-safety-contract.md), [vault format](./vault-format.md).
Этот документ задаёт формат в терминах записей и инвариантов; schemas и их
исполняемые валидаторы создаются в H-01/H-21. Markdown и вложения остаются
пользовательскими данными. Новая agent SQLite не становится их источником истины.

## 1. Размещение и владение

Предлагаемое размещение внутри существующего platform app-data каталога:

```text
ai/v1/
  registry/                          # workspace bindings; grant/revoke events
  global/                            # задания только с global settings
  workspaces/<workspace-id>/         # задания конкретного vault
    namespace.json                   # identity и поддерживаемый format version
    events/<sequence>-<event-id>.json # immutable события данного namespace
    operations/<operation-id>/
      intent.json                    # immutable подготовленный план публикации
      receipts/<receipt-id>.json     # immutable outcomes/reconciliation
    blobs/<digest-prefix>/<digest>   # точные bytes snapshots/plans/private payloads
    checkpoints/<run-id>.json        # восстановимый указатель на checkpoint
    skills/<skill-id>/               # manifests/revisions; active pointer derived
    proposals/<proposal-id>/         # candidate/evaluation references
    memory/                          # versioned scoped records
    plugin-projects/<project-id>/    # source revisions и build artifacts
    recovery/                       # незавершённые recovery/migration intents
    projection.sqlite               # derived; можно перестроить
    staging/                        # только unpublished temporary objects
```

`global/` использует ту же внутреннюю структуру namespace. Реестр хранит привязку
opaque workspace ID к canonical root; имена каталогов пользователя не становятся
именами namespace. Перенос vault и его дублирование различаются: пользователь
выбирает rebind существующей истории или новую identity. Совпадение пути/имён
файлов не доказывает identity. Старые grants автоматически не переносятся.

Состояние агента не индексируется как заметки и не доступно через raw file tools.
Agent history API выдаёт отфильтрованные записи, а не путь к журналу. Runtime
не даёт модели/плагину filesystem доступ к каталогу `ai/`.

Навыки, память, отчёты и plugin source — durable состояние пользователя; их
нельзя удалить вместе с перестроением projection. Checkpoint и active pointers
можно пересоздать из committed events/immutable manifests. Пока восстановление
не завершено, соответствующий объект недоступен для новых mutations.

### 1.1 Один авторитетный журнал операции

Run с заметками и global setting хранится в workspace namespace. Его журнал
содержит все receipts, в том числе global setting effect. Global history index
содержит только ссылки/разрешённую проекцию этого эффекта. Два независимых
авторитетных receipt для одной операции не создаются.

Для просмотра global setting effect не выдаются приватные соседние действия
run. Сведение разных namespaces в один UI timeline — derived query; общего
надёжного порядка по wall clock нет. Dependencies связываются явными IDs.
Удаление workspace из списка recent не удаляет журнал и не отменяет его права.

## 2. Общие правила формата

- Записи — UTF-8 JSON с `format`, `formatVersion`, ID и namespace. Неизвестная
  версия блокирует запись и recovery данного объекта; исходные bytes сохраняются.
- IDs генерирует host. Путь, ID и digest проверяются до построения filesystem
  path; в записи не допускаются исполняемые expressions или arbitrary backup paths.
- Immutable файл создаётся только no-replace. Повтор с теми же bytes допустим,
  несовпадение — повреждение/коллизия, а не разрешение перезаписать.
- Content digest относится к точным bytes. Before/after snapshots сохраняют BOM,
  CRLF/LF, binary assets и неизвестные поля. Они не проходят JSON/Markdown
  pretty-print ради хранения.
- Алгоритм digest и canonical request representation указан версией. Предлагаемый
  digest для v1 — SHA-256; это контроль целостности, а не подпись доверенного автора.
- Timestamps нужны для UI. `sequence` задаёт порядок событий в namespace; числа
  последовательности в JSON хранятся десятичными строками без потери точности JS.
- Любые журналы считаются недоверенным входом при чтении, даже из app data.
  Проверяются размер, глубина, schema, ссылки, namespace и все целевые paths.

### 2.1 Защита и ограничения

Локальное хранение не означает шифрование. В v1 snapshots и source blobs содержат
пользовательские bytes и защищаются разрешениями app data и scoped API. Не
обещать защиту от администратора/процесса с правами пользователя. Credentials
остаются в штатном credential storage и не включаются в экспорт журнала.

Dedup blobs выполняется внутри namespace, не между независимыми vault.
Счётчик ссылок/наличие одинакового digest не выдаются агенту. Права определяет
каждая ссылка и provenance, а не владение hash. Произвольный hash не является
capability на чтение blob.

## 3. Event envelope

| Поле                                          | Семантика                                                         |
| --------------------------------------------- | ----------------------------------------------------------------- |
| `eventId`, `sequence`, `previousEventDigest`  | Identity и порядок; genesis имеет явное отсутствие predecessor    |
| `eventType`, `schemaVersion`                  | Тип события и его схема                                           |
| `timestamp`, `processSessionId`               | Время наблюдения и host session                                   |
| `runId`, `stepId`, `operationId`, `attemptId` | Nullable references согласно типу события                         |
| `actorRef`, `grantRef`, `bindingRevision`     | Host-issued provenance, не модельные строки                       |
| `publicSummaryCode`                           | Безопасный код для локализованного UI; без текста заметки/секрета |
| `payloadRef`, `resourceRefs`                  | References защищённых данных с scope provenance                   |
| `recordDigest`                                | Digest канонической записи без самого поля digest                 |

Содержательные titles, paths, arguments, text diffs и model outputs хранятся в
защищённом payload, а не в безусловно выдаваемой шапке. Даже metadata envelope
фильтруется перед показом агенту. Ошибка разрешения не раскрывает существование
объектов другого раздела.

Типы событий включают: submission/run lifecycle, plan revision, grant decision,
context disclosure, provider request/result, tool attempt/denial, operation
prepared/receipt/verification, user approval, stop, recovery, undo, skill/memory
revision, proposal/evaluation/activation, plugin build/lifecycle, retention.
Каждое состояние run выводится из событий; «running» в SQLite не authority.

Host пишет событие запроса до передачи контекста провайдеру или выдачи данных
модели. Для read записывает также revisions/resources и outcome до раскрытия
результата. Если журнал недоступен, новые раскрытия и mutations приостанавливаются.
При отказе самого носителя последняя попытка может остаться только в памяти;
UI сообщает о неполном аудите. Абсолютная запись события при разрушенном диске
не обещается, незафиксированные side effects автоматически не повторяются.

Raw prompts/responses отключены по умолчанию. Журнал содержит metadata, usage,
references и безопасное резюме, достаточное для анализа действий. Hidden
chain-of-thought не сохраняется. Секреты редактируются до записи диагностик.

## 4. Intent и recovery manifest

`intent.json` существует и durable до первого domain effect. Его наличие само
по себе не означает, что изменение применено. Минимальные поля:

| Группа           | Содержание                                                              |
| ---------------- | ----------------------------------------------------------------------- |
| Identity         | Operation/run/step, namespace, action/schema/catalog version            |
| Authorization    | Grant revision, binding revision/generation, approval reference         |
| Inputs           | Request digest, аргументы/payload refs, pinned skill/artifact revisions |
| Read set         | Логические ресурсы и source revisions для preconditions                 |
| Write/effect set | Все физические targets и логические изменяемые поля                     |
| Before           | Presence, exact revision, snapshot/blob references, object identity     |
| Intended after   | Expected bytes/digest или ограниченный domain reconciliation predicate  |
| Undo             | Версионированный inverse plan, dependencies, protected blobs            |
| Domain recovery  | Ссылка на существующий domain journal с тем же operation identity       |
| Limits           | Число/размер targets, разрешённые этапы публикации, expiry              |

Для create ожидается `absent`, заранее резервируются object IDs и destinations.
Для rename/move записываются обе стороны, bundle children, переписываемые ссылки
и metadata. Системный путь trash нельзя придумать до OS операции; такой эффект
имеет отдельный ограниченный контракт и не включается в обычный automatic undo.

Перед recovery валидируется manifest целиком до первой записи, включая каждый
target и backup reference. Загрузка журнала не предоставляет право выйти за
vault, изменить другой namespace или проигнорировать отозванную grant.

### 4.1 Domain journals

Harness не заменяет действующие recovery contracts баз, history, modules и
миграций. Domain operation должна принять/сопоставить operation ID и вернуть
свой durable outcome. Recovery сначала согласует domain intent и фактические
bytes, затем пишет harness receipt. Один и тот же backup может использоваться
по проверенной ссылке с pin; очистка domain history учитывает этот pin.

Пока domain journal не поддерживает требуемое распознавание результата,
обёртка «записать до/после» не считается достаточной. Соответствующее действие
остаётся `missingImplementation` для агента.

## 5. Протокол публикации журнала

1. Зарезервировать operation ID и записать принятый tool attempt.
2. Записать необходимые blobs через staging; sync, проверить digest, no-replace
   publish. Синхронизировать directory entry по возможностям платформы.
3. Атомарно опубликовать immutable intent; затем событие `operationPrepared`.
4. Выполнить domain action, проверяя preconditions у границы публикации.
5. Сохранить immutable receipt; затем событие, ссылающееся на receipt.
6. Обновить derived projection/checkpoint и отправить событие UI.

Если сбой возник между immutable объектом и событием, startup scanner находит
orphan intent/receipt и сверяет его. Отсутствие event reference не доказывает
отсутствие эффекта. Объект без подтверждённой связи помещается в recovery, а не
удаляется как мусор. Операция с durable intent не запускается повторно только
потому, что checkpoint отстаёт.

Events публикуются одним writer на namespace в serial append section. Номер
следующего события определяется по проверенной цепочке. Hole, duplicate sequence
или mismatch predecessor останавливает дальнейший append; исходные файлы
сохраняются для диагностики. Частично записанный temp не считается event.

Файловый rename даёт атомарность видимости одного файла; долговечность при потере
питания зависит от sync и платформы. H-21 проверяет crash boundaries на целевых
платформах. В спецификации нет обещания общей транзакции между vault и app data.

## 6. Матрица прерываний

| Момент сбоя                                         | Что проверяет recovery                                                   | Допустимый результат                                                         |
| --------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| До durable intent                                   | Нет публикаций по контракту; temp blobs не являются разрешением          | `failedBeforePublish`, staging cleanup после проверки references             |
| Intent есть, before bytes на всех targets           | Domain journal и права; не считать операцию начатой заново автоматически | `notApplied`; продолжение только после revalidation                          |
| Один target совпадает с intended after              | Source identity, остальные targets, domain progress                      | Partial/recoverable либо completed для однофайловой операции                 |
| Все targets совпадают с intended after, receipt нет | Preconditions/effect closure и domain journal                            | Receipt `succeeded` с recovery provenance и original operation identity      |
| Receipt есть, event/UI ответа нет                   | Целостность receipt; расхождение bytes может быть последующей правкой    | Доставить исторический receipt; не повторять effect                          |
| Receipt success, index update упал                  | Durable sources и состояние projection                                   | Retry только derived indexing                                                |
| Часть targets изменилась пользователем              | Before/after/actual по каждому ресурсу                                   | `needsRecovery`; конфликт без перезаписи пользователя                        |
| Source rename отсутствует, target отличается        | Domain identity и записи публикации                                      | `outcomeUnknown`; отсутствие source не доказывает успех                      |
| Grant отозвана или vault перепривязан               | Registry revision и новый scope                                          | Только host reconciliation; новые data writes требуют актуального разрешения |
| Повреждены intent/blob/цепочка                      | Schema/digest и доступный recovery point                                 | Read-only для затронутой цепочки; не выдумывать успешный outcome             |
| Неизвестный format version                          | Supported versions                                                       | Сохранить bytes, предложить совместимую версию приложения                    |

Совпадение digest после операции не доказывает, кто записал эти bytes. Recovery
использует identity/operation markers и domain journal, где они предусмотрены.
При недостаточной доказательности результат остаётся unknown. Поддельные или
неоднозначные журналы не «лечатся» успешным пересохранением.

## 7. Receipt, verification и undo manifest

Receipt — immutable наблюдение. Поздняя проверка/компенсация добавляет следующую
запись со ссылкой на предыдущую; она не переписывает исторический outcome.
Projection вычисляет последнее согласованное состояние operation.

Verification report различает deterministic invariants, domain query,
visual inspection и model judgement. Модельная оценка рисунка не доказывает
сохранность JSON. Report содержит проверяемые resource revisions, checker version
и результаты. Проверки после последующей правки не переопределяют ранний успех.

Undo manifest содержит inverse kind/version, before refs, ожидаемые after
revisions, dependency closure и правило conflict handling. Для shared JSON
sidecar/settings сохраняется field inverse с presence/value и schema version;
полный snapshot нужен для recovery, но не разрешает затирать соседние изменения.

Undo run записывает отдельные operation IDs с `revertsOperationId`. Частично
применённый rollback имеет собственные receipts/recovery intents. Прерывание
rollback проверяется так же, как обычная публикация. «Откат начат» не равно
«исходное состояние восстановлено».

## 8. Retention, квоты и удаление данных

### 8.1 Защищённые ссылки

Не удаляются blobs/intents, нужные незавершённым operations, конфликтам, активному
recovery, обещанному undo, pinned skills, текущим plugin builds и migrations.
References учитываются между namespaces через host registry; агент не может
снять защиту собственного аудита. GC использует durable mark/sweep plan и
проверяет отсутствие новых references непосредственно перед удалением.

Недостаток места для snapshot/intent останавливает mutation до публикации.
При исчерпании места после публикации сохраняется recovery ambiguity; UI не
выдаёт `failedBeforePublish`. Квота не является разрешением удалить пользовательский
vault или нужный rollback blob. Размер journals/blobs виден в storage UI.

### 8.2 Три разных пользовательских операции

| Операция                           | Последствие                                                                                               |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Убрать задание из списка           | Только UI archival; история и undo сохраняются                                                            |
| Очистить историю/точки отката      | Preview affected runs/skills; после подтверждения undo становится unavailable                             |
| Забыть данные выбранного источника | Удалить его retained payloads, memory, embeddings, summaries и производные приватные данные по provenance |

Forget не реализуется только удалением строки SQLite. План очистки вычисляет
зависимые objects: proposal, skill revision, checkpoint, rendered preview, plugin
source/build output могут содержать исходный текст. Зависимые активные версии
блокируются либо пересоздаются после очистки; ссылку на удалённый источник
нельзя сохранить как способ повторно загрузить содержимое.

Обычный append-only журнал допускает только добавление событий. Исключение —
явная пользовательская privacy/retention операция по отдельному контракту:
она удаляет защищённые payloads и оставляет минимальный tombstone без текста,
путей и названий удалённых данных. Если чувствительные данные попали в envelope,
нужна versioned redaction/пересборка цепочки с новым genesis и явным разрывом
истории, а не скрытое изменение hash chain. Агенту это действие недоступно.

Очистка работающего задания сначала останавливает его и разрешает in-flight
operations; нельзя удалять единственный recovery point незавершённой публикации.
Preview сообщает о потере undo и невозможности восстановления старой памяти.
Приложение не обещает стирание уже отправленных данных у провайдера, внешних
backups или физическое уничтожение секторов SSD.

## 9. Export и перенос

Экспорт истории — отдельная пользовательская операция с выбором scope и
содержимого. По умолчанию экспортируется безопасный timeline без note snapshots,
raw prompts и credentials. Полный backup явно включает private blobs, versions
навыков/плагинов и сведения о чувствительности.

Импорт валидирует формат, ссылки, размер, digest и paths. Он не импортирует
действующие grants, approvals, credential references или разрешение продолжить
run. История открывается read-only до привязки к workspace; операции никогда
не воспроизводятся ради импорта. Новая machine binding требует revalidation.

## 10. Миграции и совместимость

Миграция имеет ID/version, read-only preflight, backup manifest, outcome и
rollback description. Она переводит namespace целиком в maintenance mode,
не запускает model calls и не меняет note IDs. Multi-namespace references
проверяются до publication. Durable progress позволяет повторить запуск без
повторного преобразования уже опубликованных records.

Новая версия пишет отдельные файлы/namespace и переключает проверенный binding
после завершения. Старые recovery readers сохраняются на заявленный срок
поддержки. Downgrade не пытается исполнить неизвестные inverse/schema версии.
Rollback миграции допустим только при отсутствии несовместимых последующих
записей либо по отдельному проверенному плану.

## 11. Обязательные доказательства реализации

H-21/H-22/H-23 должны показать failure injection для каждой строки матрицы
прерываний, повтор startup/recovery/undo, отсутствие lost update в mixed
workspace/global run, отказ на повреждённых путях журнала и неизменность sources
при ошибке snapshot. Проверять настоящий filesystem и domain calls.

H-24/H-32 подтверждают scope для исторических payloads, queued UI events,
summaries и provider requests после revoke. H-50/H-63/H-74 добавляют provenance
и retention для skills, learning и plugins. Сценарии привязаны к Q01–Q70 в
матрице приёмки; новый формат сам по себе
не означает PASS ни одного сценария.
