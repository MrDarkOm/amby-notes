# ИИ-агент Amby: исполнение через оркестрацию

Статус: все пакеты запланированы. Дата: 2026-09-24. Версия: 1.

Контракт: [архитектурный план](./ai-harness-plan.md).  
Проверки: [приёмка](./ai-harness-acceptance.md).

## Правила координации

Один оркестратор отвечает за общий результат, контракты, integration и gates.
Работа может выполняться последовательно либо независимыми агентами после
явной команды пользователя на реализацию с оркестрацией. Для четырёх доступных
слотов использовать максимум трёх исполнителей плюс оркестратора. Новые
пользовательские задачи в sidebar для технических подзадач не создавать.

Каждый пакет имеет одного владельца. Независимый проверяющий получает diff,
контракт и сценарии приёмки, а не только итоговое сообщение исполнителя.
Проверяющий может быть отдельным агентом после завершения автора; постоянного
свободного слота для него не требуется. Число агентов не является критерием качества.

Правила рабочего дерева:

1. В H-00 записать HEAD, текущую ветку и список уже изменённых файлов. Сейчас
   дерево содержит существенные пользовательские изменения в модулях, данных,
   настройках и документации. Они не являются работой этого плана.
2. Продолжать от `dev` или согласованного пользователем состояния; новые ветки
   именовать `codex/...`. Не переключать и не сбрасывать чужие изменения.
3. Git worktree не переносит незакоммиченные файлы. Изолированное выполнение
   допустимо только из baseline, содержащего нужное состояние. При отсутствии
   такого baseline работать в общем checkout с эксклюзивным владением файлами;
   не делать скрытый commit/stash ради запуска агентов.
4. В общем checkout перед редактированием назначать владельцев пересекающихся
   файлов. Параллельные агенты не запускают форматирование всего репозитория,
   git clean/reset или массовые генераторы.
5. Общие generated bindings и полные проверки запускает интегратор последовательно.
   При смене baseline все затронутые контракты перепроверяются.
6. Реальные vault, API keys и пользовательские настройки не становятся fixtures.

Оркестратор единолично интегрирует изменения `src-tauri/src/lib.rs`,
`src-tauri/src/commands/mod.rs`, общих storage ports/adapters,
`src/lib/bindings.ts`, `src/locales/resources.ts`, `package.json`,
Tauri capabilities/config и `updates/upd_next.md`. Исполнитель передаёт точный
integration patch или отдельно согласованное владение. Bindings генерируются
через Specta, вручную не редактируются. Другие shared files назначаются в H-00.

## Состояния и отчётность

Допустимые состояния пакета: `planned`, `ready`, `running`, `needsIntegration`,
`needsReview`, `blocked`, `done`. Причина `blocked` включает конкретную отсутствующую
зависимость, доказательство и следующий возможный шаг. Gate имеет состояние
`notRun`, `failed`, `passed`; «код написан» не равен `passed`.

При запуске реализации создать `docs/Road/ai-harness-progress.md` с таблицей:

```text
package | owner | status | baseline | touched files | checks | evidence | blockers
```

Отчёт исполнителя:

```text
Пакет:
Baseline / branch:
Изменено и зачем:
Файлы:
Контракт / migrations / generated bindings:
Проверки: команда, exit code, путь к synthetic evidence:
Не проверено и почему:
Integration patch для общих файлов:
Оставшиеся риски / следующие зависимости:
```

`done` выставляет оркестратор после integration и review. Unavailable native
runner, provider credentials или целевая ОС фиксируются как `notRun/blocked`,
а не как условный PASS. Можно продолжать независимые пакеты, но нельзя объявлять
соответствующий продуктовый gate завершённым.

Каждый завершённый integration batch обновляет русский changelog, проходит
`npm run build` и применимые проверки из документа приёмки. Версию приложения
не повышать до отдельного запроса commit-and-push. Теги, GitHub Release и
продвижение dev → beta → main требуют отдельной команды.

## Волны и зависимости

Волна задаёт максимум возможной параллельности, а не требование одновременно
редактировать все перечисленные файлы. Реальные `Depends` обязательны.

| Волна | Пакеты                  | Условие начала / gate                                           |
| ----- | ----------------------- | --------------------------------------------------------------- |
| W0    | H-00 → H-01             | Инвентаризация, baseline, contract freeze; G0                   |
| W1    | H-10; затем H-11 + H-12 | Общие action types; G1                                          |
| W2    | H-20 + H-21             | Зафиксирован G1; независимые policy и journal                   |
| W3    | H-22 → H-23 → H-24      | Исполнение с журналом, восстановление, read API; G2             |
| W4    | H-30 + H-32; затем H-31 | G2; runtime зависит от provider/context                         |
| W5    | H-33 → H-34             | Runtime интегрирован; G3                                        |
| W6    | H-40 + H-41 + H-44      | G3; отдельные domain adapters                                   |
| W7    | H-42 + H-43 + H-45      | H-40; H-45 также требует H-44                                   |
| W8    | H-46                    | Все adapters этапа 4; G4                                        |
| W9    | H-50 → H-51 → H-52      | Реальные domain workflows; G5                                   |
| W10   | H-60 + H-61             | G5; extraction и evaluator имеют общий frozen proposal contract |
| W11   | H-62 → H-63             | H-60/H-61; G6                                                   |
| W12   | H-70 → H-71             | G4/G5; допустимо параллельно W10/W11 при свободных слотах       |
| W13   | H-72 + H-73             | H-71, замороженный workbench API                                |
| W14   | H-74                    | G6 и H-70—H-73; G7                                              |

Граф критического пути: G0 → G1 → G2 → G3 → G4 → G5 → G6 → G7.
Мастерская может частично разрабатываться после G5, но финальная приёмка требует
завершения обучения и проверки общей policy. Если два пакета требуют одного
store/adapter, интегратор сериализует изменения независимо от номера волны.

## Подготовка

### H-00. Инвентаризация и фактический baseline

- **Depends:** нет. **Владелец:** интегратор/архитектор.
- **Читать:** AGENTS.md, package scripts, storage ports, commands, все UI actions,
  stores, native runners, модульный план/аудит, текущие database format/mutations.
- **Сделать:** каталог всех пользовательских действий с input/output, owner,
  UI-only dependencies, source-of-truth, текущим undo и тестами. Проверить
  module runtime, пути данных и различия документации/кода. Зафиксировать
  исходные проверки; несвязанные ошибки отделить от блокирующих зависимостей.
  Зафиксировать версии/лицензии upstream материалов для планируемых заимствований.
- **Артефакт:** `docs/ai-action-catalog.md`, progress baseline и integration ownership.
- **Готово:** каждая группа из каталога плана имеет реальные code references;
  строки `missingImplementation` имеют владельца; существующие проблемы storage
  и plugin isolation не скрыты release notes. Проверки Q01.

### H-01. Контракты и каркас приёмки

- **Depends:** H-00. **Владелец:** архитектор с проверкой data-safety reviewer.
- **Сделать:** закрепить Action/Receipt/Grant/Run/Event/Skill/Proposal schemas,
  revisions, operation IDs, lock ordering и storage layout v1. Описать модель
  undo, границы атомарности, quotas, scope на derived data и привязку vault.
  Подготовить synthetic fixtures и общий test driver interface без LLM-зависимости.
- **Артефакт:** `docs/ai-harness.md`, `docs/ai-state-format.md`, schemas и начальный
  `tests/fixtures/agent/` с expected invariants. Отдельно решить transport/context
  для открытых документов и безопасный typed settings patch.
- **Готово:** policy, persistence и UI owners могут реализовывать контракты без
  несовместимых предположений; Q01, Q02; G0. Изменения контрактов далее требуют
  review всех downstream owners и обновления fixtures.

## Этап 1. Общие действия

### H-10. Registry и типизированная граница

- **Depends:** G0. **Владелец:** backend actions.
- **Основные файлы:** новый `src-tauri/src/app_actions/`, generated types через интегратора.
- **Сделать:** descriptors, schema validation, executor interface, availability,
  stable errors, preview/verify/undo interfaces. Actor/grant выдаёт host.
  Имена инструментов являются адаптером к registry, а не отдельным набором mutations.
- **Готово:** invalid/unknown/version-mismatched actions отвергаются до побочных
  эффектов; UI/AI адаптеры используют одинаковые domain semantics; Q02.
  Публичные agent writes пока не включены.

### H-11. Вертикальная операция заметки и bridge редактора

- **Depends:** H-10. **Владелец:** notes/editor integration.
- **Основные файлы:** notes/mutations services, `use-doc-store.ts`, autosave coordinator,
  serialization lifecycle, новый focused bridge hook.
- **Сделать:** create/read/patch note через общие services; flush/lease протокол
  открытых буферов, stale draft rejection, события всех окон. Snapshot после
  предшествующего пользовательского save; закрытый документ не требует mount.
  UI и agent adapter не вызывают Tauri commands друг через друга.
- **Готово:** реальные версии/IDs проходят весь путь; BOM/YAML/Source-only
  сохраняются; текущая заметка не затирается stale AI ответом; Q04, Q08, Q11.
  Fault/undo подключаются к этому adapter в H-22/H-23.

### H-12. Каталог доступных возможностей

- **Depends:** H-10. **Владелец:** module/context integration.
- **Основные файлы:** registry, module host/registries, storage API.
- **Сделать:** machine-readable catalog и компактные описания; фильтрация по
  module state/API version; события enable/disable. Выделить server policy
  checking point H-20, не считать скрытие tool достаточной защитой.
- **Готово:** disabled/missing module не рекламируется как доступный;
  stale cached tool выдаёт `moduleUnavailable`; Q02, Q12; G1 после H-11.

## Этап 2. Права, журнал и восстановление

### H-20. Backend grants и scoped чтение

- **Depends:** G1. **Владелец:** security/backend.
- **Основные файлы:** policy, `paths.rs`, vault context integration, scoped query adapters.
- **Сделать:** read/write roots, object IDs, keys настроек, provider consent,
  revocation, generation check; фильтрация поиска/агрегатов до выдачи данных.
  Проверить indirect reads и все ресурсы multi-file operations. Grant issuance
  доступен только доверенному пользовательскому действию, не tool arguments.
- **Готово:** чтение/изменение/metadata leakage за scope блокируются, включая
  symlink и vault switch; Q03—Q07. Negative tests вызывают executor напрямую.

### H-21. Durable журнал и snapshots

- **Depends:** G1. **Владелец:** persistence.
- **Основные файлы:** новый agent journal/storage, `app_data.rs` integration.
- **Сделать:** versioned event records, sequence, immutable before blobs,
  reconstruction index, atomic publication, redaction, quotas, retention/pinning,
  migration/backup/recovery. Журналирование всех tool attempts и отказов.
- **Готово:** crash в каждой фазе записи не создаёт фиктивный success; удаление
  derived index восстанавливает журнал; нет секретов; snapshots не исчезают
  от фонового pruning; Q09, Q10, Q19, Q20.

### H-22. Executor с идемпотентностью и recovery

- **Depends:** H-20, H-21, H-11. **Владелец:** backend integration.
- **Основные файлы:** action executor, notes adapter, agent recovery.
- **Сделать:** соединить policy → preconditions → durable intent → domain mutation
  → receipt → verification; lock ordering, idempotency, commit/index separation.
  Добавить failure-injection seams и startup reconciliation. Journal unavailable
  блокирует новые side effects; уже выполненный, но неподтверждённый шаг остаётся
  uncertain до восстановления.
- **Готово:** retries не дублируют заметки; падения до/после publication и receipt
  проверены настоящими файлами; Q09, Q13, Q14, Q16, Q17.

### H-23. Откат действий и групп

- **Depends:** H-22. **Владелец:** recovery/undo.
- **Сделать:** inverse registry, dependency graph, group preview, revision checks,
  compensation receipts, partiallyUndone и повторный откат. Доступность undo
  учитывает текущие права, snapshots и зависимые пользовательские изменения.
  Сначала note actions; новые adapters обязаны подключать свой inverse contract.
- **Готово:** полный/частичный откат, новый пользовательский edit и concurrent undo
  проверены; audit не переписывается; Q15, Q16, Q18, Q19.

### H-24. API истории и управления областью

- **Depends:** H-20, H-21, H-23. **Владелец:** integration/storage.
- **Сделать:** scoped list/get/diff/undo-preview/undo, cursor pagination,
  event catch-up, safe grant selection API и журнал доступов. Tools получают
  только разрешённые события/фрагменты. Synthetic browser adapter поддерживает
  contract tests; native-only возможности честно сообщают unavailable.
- **Готово:** журнал чужой папки/старой grant не читается косвенно; подготовлена
  typed UI boundary; Q06, Q18, Q20; G2 после native executor smoke.

## Этап 3. Runtime и первый агент

### H-30. Provider protocol и contract fixtures

- **Depends:** G2. **Владелец:** inference/backend.
- **Основные файлы:** `ai.rs`, новые provider adapters и fixtures.
- **Сделать:** normalize streaming text/tool calls/results, cancel, usage,
  capability detection и limits. Сначала один live provider, затем все текущие
  transport families по единому contract. URL/credentials protections сохраняются.
  Fake provider детерминированно выдаёт сценарии tools/errors для всей приёмки.
- **Готово:** partial JSON, malformed calls, multiple calls, truncation, retry,
  rate limit, disconnect и cancellation проверены; Q21, Q22, Q28.

### H-31. Долговечный цикл выполнения

- **Depends:** H-30, H-32, H-22, H-24. **Владелец:** runtime/backend.
- **Сделать:** state machine, task queue, checkpoints, bounded retries, budgets,
  Stop, user-wait, resume и sequence events. Host исполняет tools только после
  schema/policy checks. Завершение сообщения модели не обходится как success
  задачи, пока обязательные verification не выполнены.
- **Готово:** двойная отправка не создаёт второй run; панель можно закрыть;
  restart/смена vault/провайдера не повторяют effects; Q13, Q23—Q26, Q28.

### H-32. Контекст и scoped сессии

- **Depends:** H-20, H-24, H-11, H-12. **Владелец:** context/retrieval.
- **Сделать:** active selection references, chunked reads, scoped search,
  revision-bound context, clear truncation, persistent conversation/checkpoint.
  Content из notes/tool outputs отделить от policy instructions. Compaction
  сохраняет unresolved requirements и receipts. Отзыв scope удаляет недоступный
  контент из дальнейших model requests и invalidate provider caches.
- **Готово:** «здесь» привязано к конкретному объекту; ambiguous target уточняется;
  injection и cross-scope retrieval не расширяют доступ; Q04—Q08, Q27, Q29.

### H-33. Панель задач и прозрачное выполнение

- **Depends:** H-31, H-24. **Владелец:** frontend.
- **Основные файлы:** `ai-panel.tsx`, `workspace/ai/`, focused Zustand store;
  локализацию и theme tokens интегрирует назначенный владелец.
- **Сделать:** режимы обсуждения/подготовки/выполнения, scope picker, plan/progress,
  change previews, exact pending approvals, Stop/Resume/Undo, history/filter/diff,
  budget indicators. Обсуждение технически лишено mutating tools. Preview approval
  связан с конкретным plan hash и revisions; stale preview применяется заново
  только после обновления. Существующее разрешение не спрашивается на каждом шаге.
- **Готово:** readable keyboard-accessible RU/EN flow, reconnect восстанавливает
  состояние; pending dialog не разрешает другую версию действия; Q18, Q26, Q29, Q30.

### H-34. Приёмка первого агента

- **Depends:** H-30—H-33. **Владелец:** интегратор + независимый reviewer.
- **Сделать:** notes vertical workflow в browser harness и реальном Tauri,
  fresh/reopened vault, editor dirty state, multi-window, cancel/restart,
  network/provider failures. Проверить production build с AI module disabled.
- **Готово:** Q01—Q30 применимы и проходят; один live model выполняет note scenario,
  fake provider проходит все fault cases; G3. Никаких заявлений о полноте
  остальных доменов на этом этапе.

## Этап 4. Полное покрытие прикладных сценариев

### H-40. Заметки, структура, свойства и слои

- **Depends:** G3. **Владелец:** note domain.
- **Сделать:** закрыть каталог заметок/папок/tags/properties/icons и source edits;
  rename/move с backlinks, bundle/layer lifecycle, trash/restore, attachments.
  Preview перечисляет все effects; наружные links и shared assets учитываются
  policy. Стабильные IDs и opaque YAML не переписываются автоматически.
- **Готово:** Q04, Q08, Q11, Q15—Q17, Q31, Q32; операции доступны без открытого
  редактора и отменяются через общий журнал.

### H-41. Базы и представления

- **Depends:** G3. **Владелец:** database domain.
- **Сделать:** registry adapters для всех поддерживаемых database operations,
  включая schema/options/values/relations, layouts/filters/grouping/linked views,
  templates/assets и YAML sync. Для пробелов H-00 реализовать требуемый общий
  domain API отдельными внутренними подзадачами; direct JSON/SQL writes модели
  не выдавать. Совместить domain history и agent inverse через один receipt.
- **Готово:** проект с attached базой и несколькими views работает после restart,
  locked schema и scope границы проверяются, undo не удаляет пользовательские
  значения; Q33—Q36. Формулы вычисляются после сохранения, ошибки видны.

### H-42. Canvas без UI-автоматизации

- **Depends:** H-40. **Владелец:** Canvas.
- **Сделать:** create/read/patch scene, note/text/image cards, edges/groups,
  reusable layout, bounds validation, stable IDs и сохранение unknown fields.
  Выделить editor-independent scene transformations; persist только через executor.
- **Готово:** карточки открывают настоящие заметки, внешние ссылки не обогащают
  scope, round-trip и undo сохраняют неизвестные данные; Q37, Q39.

### H-43. Excalidraw: наброски и схемы

- **Depends:** H-40. **Владелец:** Sketch.
- **Сделать:** semantic scene builder для текста/фигур/стрелок/групп/embeddables,
  deterministic layout и patch по IDs; renderer preview как результат проверки.
  Использовать существующий format/serializer и совместимые Excalidraw helpers;
  не хранить editor runtime fields в документе.
- **Готово:** заметки встроены и кликабельны, редактирование одного элемента
  сохраняет остальные, переносимость/visual/undo checks проходят; Q38, Q39.

### H-44. Темы и типографика

- **Depends:** G3. **Владелец:** appearance/settings.
- **Сделать:** typed backend allowlist, validated theme creation/patch/select,
  preview, existing font choices/scale и field-level settings inverse. Согласовать
  с очередью пользовательских settings patches, чтобы два writer не теряли ключи.
  Новая тема получает свой ID и не заменяет built-in.
- **Готово:** видимый эффект и restart persistence, запрет remote/CSS/JS payload,
  конфликт того же ключа и сохранение соседних ключей; Q40—Q42.

### H-45. Workspace, остальные настройки и модули

- **Depends:** H-40, H-44, H-12. **Владелец:** workspace/modules.
- **Сделать:** закрыть remaining settings/action catalog: tabs, panels/layout,
  favorites/view-state, shortcuts, presets, enable/disable modules. Для transient
  операций обозначить session undo; для durable — versioned inverse. Missing
  package не скачивается молча; установка проходит выделенный разрешённый flow.
- **Готово:** runtime правдив после module changes, глобальные настройки явно
  отделены от workspace, policy/credentials недоступны, Q12, Q41, Q42, Q44.

### H-46. Составные задачи и закрытие карты покрытия

- **Depends:** H-40—H-45. **Владелец:** интегратор + reviewer.
- **Сделать:** scenario «заметка + база + views + Excalidraw + тема», task DAG,
  verification всех артефактов, group undo и recovery на каждом шаге. Дополнить
  каталог всеми actions из UI. Каждую missingImplementation закрыть owner patch
  либо вынести на явное продуктовое решение, не помечать как готовую.
- **Готово:** Q31—Q44, G4; все обязательные действия каталога реализованы,
  намеренные исключения обоснованы и видны пользователю.

## Этап 5. Навыки

### H-50. Версии и хранилище навыков

- **Depends:** G4, H-21, H-24. **Владелец:** skills/backend.
- **Сделать:** package parser, immutable revisions, manifests, owned namespaces,
  required capabilities, source attribution, install/disable/archive/revert и
  frozen run snapshot. Все skill writes идут через journal/executor.
- **Готово:** broken imports/paths/duplicate names/version conflicts определены,
  active run не переключает revision посреди шага, Q45, Q46, Q48, Q49.

### H-51. Подбор и начальная библиотека

- **Depends:** H-50, H-32. **Владелец:** skills/context + workflow author.
- **Сделать:** компактный catalog, загрузку нужных instructions/resources,
  explicit invocation и conservative automatic matching. Подготовить skills
  для project/database/diagram/theme на работающих actions с verification steps.
  Каждому навыку дать positive/negative triggers и tests на лишнюю активацию.
- **Готово:** skill экономит повторный поиск процедуры, не дублирует schema;
  hidden scope/disabled module фильтруются до catalog; Q45—Q47.

### H-52. UI навыков и явное обучение

- **Depends:** H-50, H-51. **Владелец:** frontend/skills.
- **Сделать:** список, текст, версии/diff/evidence, enable/disable/revert,
  команда «запомни этот способ» и preview proposal. Импорт локального источника
  подчиняется scope; внешние skill scripts остаются неисполняемыми до H-70.
- **Готово:** пользователь понимает, чему агент научен и какая версия используется;
  replay не активирует навыки скрытно; Q48—Q50; G5.

## Этап 6. Обучение, eval и память

### H-60. Извлечение уроков и proposals

- **Depends:** G5. **Владелец:** learning/runtime.
- **Сделать:** bounded post-run job с отделённым context, positive/negative
  evidence, prior-skill lookup, candidate diff и parent hash. Run statuses и
  receipts отделяют проверенный успех от утверждения модели. `off/propose`
  работают без фоновых writes в vault; явные corrections имеют источник.
- **Готово:** одна процедура не размножается на каждый run; temporary failures,
  неизвестный outcome и private data не превращаются в global skills; Q51, Q52, Q55.

### H-61. Evaluator и применение проверенных версий

- **Depends:** G5, H-50. **Владелец:** evaluation/backend, независимый от автора урока.
- **Сделать:** evaluator interface, isolated fixture runner, baseline/candidate
  comparison, holdout suite, statistical repeat protocol, policy/data-integrity
  gates, budgets. Proposal contract согласован с H-60 до параллельной работы.
  Promotion применяет exact tested revision; drift требует reevaluation.
- **Готово:** вредное/бесполезное улучшение отклоняется; оценщик не изменяет criteria;
  нет replay реальных mutations; Q53, Q54, Q56, Q57.

### H-62. Scoped память и обслуживание библиотеки

- **Depends:** H-60, H-61. **Владелец:** memory/curator.
- **Сделать:** явно управляемые preferences/facts, provenance и scope propagation,
  deduplication, expiry, forget и зависимые caches/proposals. Curator предлагает
  consolidation/archival только для agent-owned collection, сохраняет support
  files и не повторяется бесконечно. Редкие навыки не удаляются только из-за возраста.
- **Готово:** чужой namespace не меняется, пользовательский pin соблюдается,
  forget прекращает retrieval удалённого урока, Q55, Q58, Q59.

### H-63. Управление обучением и приёмка

- **Depends:** H-60—H-62. **Владелец:** frontend + reviewer.
- **Сделать:** экран предложений, evidence/diff/eval, accept/reject/revert,
  off/propose/autoVerified, отдельный бюджет и kill switch. Переключение mode
  не подтверждает задним числом старые proposals. Отзыв прав прекращает pending jobs.
- **Готово:** пользователь видит действительное изменение навыка, стоимость и
  основания; Q51—Q59, G6. AutoVerified не является обязательным default.

## Этап 7. Плагины внутри приложения

### H-70. SDK и настоящая изоляция

- **Depends:** G4, G5. **Владелец:** security/modules.
- **Сделать:** проверить текущий Worker с hostile plugin fixtures: globals,
  network, direct IPC, filesystem, resource exhaustion, callback lifetime.
  Выбрать/доработать runtime по результату; все доступные host methods проходят
  schemas, grant intersection, revocation и executor. Ограничить UI contributions.
- **Готово:** production native tests доказывают scope и отсутствие обходов;
  Q60—Q62. Без этого package installation generated code заблокирован.

### H-71. Проект плагина и доверенный build runner

- **Depends:** H-70, H-50. **Владелец:** plugin toolchain.
- **Сделать:** versioned plugin project, templates/examples SDK, source patch,
  compile diagnostics, test/preview manifests. Выделить trusted compiler runtime
  и доступные dependencies; run без общего shell/host filesystem. Все исходники,
  artifacts и логи имеют quotas, ownership и revisions.
- **Готово:** простой плагин собирается на поддерживаемых desktop platforms,
  исправление compiler error через агента воспроизводимо; Q63, Q64.

### H-72. Интерфейс мастерской и итерации

- **Depends:** H-71. **Владелец:** frontend/workbench.
- **Сделать:** source/project view, diff, diagnostics, isolated preview,
  conversation с привязкой к project revision, test results и возврат версии.
  Простой UI плагина использует SDK contribution model, не получает DOM приложения.
- **Готово:** пользователь просит новую функцию, видит изменения и работающий
  preview; manual edits кода не перезаписываются stale generation; Q63—Q65.

### H-73. Установка, происхождение и lifecycle

- **Depends:** H-71, H-45. **Владелец:** package-manager integration.
- **Сделать:** installation exact tested artifact hash, permission diff,
  local-generated provenance, staged activation, old version rollback,
  persistent quarantine и restart recovery. Plugin migrations имеют свой
  preflight/backup/outcome и не смешиваются с заменой package files.
- **Готово:** grant не расширяется при update, previous version живёт после crash,
  uninstall сохраняет данные; Q62, Q65—Q67.

### H-74. Полная приёмка и готовность к выпуску

- **Depends:** G6, H-70—H-73. **Владелец:** интегратор + независимый reviewer.
- **Сделать:** пройти всю матрицу Q01—Q70 на итоговом diff; fresh/existing state,
  migration rollback, module off, fake/live providers, packaged desktop, три ОС.
  Закрыть action catalog, docs, RU/EN и changelog. Повторить только затронутые
  проверки после исправлений; весь required gate выполнить на финальном состоянии.
- **Готово:** G7 с evidence и без скрытых NOT RUN. Подготовить итоговый handoff:
  что работает, ограничения, проверки, native packaging evidence. Commit/push,
  patch release и публикация выполняются только по отдельной команде пользователя.

## Шаблон задания исполнителю

```text
Выполни пакет H-XX из docs/Road/ai-harness-orchestration.md.
Прочитай AGENTS.md, архитектурный контракт, пакет и связанные Q-сценарии.
Baseline: <HEAD + сведения о рабочем дереве>.
Зависимости уже приняты: <ID и evidence>.
Твоё эксклюзивное владение: <файлы/каталоги>.
Общие integration files редактирует <owner>; передай ему integration patch.

Реализуй полный контракт пакета, включая failure/rollback paths и применимые
проверки. Пользовательские изменения сохраняй. Не меняй версию приложения.
Не объявляй mocked тест доказательством native поведения. Если зависимость
не реализована, сообщи конкретный blocker и продолжи независимую часть.
Не расширяй scope и не выполняй соседние пакеты без назначения оркестратора.
Заверши отчётом по установленной форме с командами, exit codes и evidence.
```

## Шаблон независимой проверки

```text
Проверь пакет H-XX на baseline <...> по архитектурному контракту и Q-сценариям.
Сначала прочитай итоговый diff и реальные call sites, затем targeted tests.
Проверь обходы policy, failure windows, stale revisions, scopes, undo, module
lifecycle, headless execution и сохранность исходных данных по применимости.
Отдели подтверждённые дефекты от непроверенных гипотез. Для каждого дефекта дай
воспроизведение, затронутый контракт и минимальный способ исправления.
Отдельно перечисли пропущенные evidence и заявленные, но отсутствующие paths.
Не исправляй несвязанный код. Не ставь PASS при незапущенной обязательной проверке.
```

## Инструкция для оркестратора

Следующий текст предназначен для будущего запуска реализации:

```text
Реализуй полный план ИИ-агента Amby из:
- docs/Road/ai-harness-plan.md;
- docs/Road/ai-harness-orchestration.md;
- docs/Road/ai-harness-acceptance.md.

Используй оркестрацию агентов для независимых пакетов. Начни с H-00 и H-01,
сохрани текущее пользовательское рабочее дерево и создай progress ledger.
Не считай наличие прототипа или старую запись в changelog доказательством
готовности. Назначай владельцев файлов, проверяй dependencies и integration.
Веди статусы H-00—H-74, перечисленные в документе, и gates G0—G7.

Продвигайся до полной реализации всех обязательных этапов. После каждого
batch выполняй build и применимые проверки; перед review — npm run verify.
Сгенерированные bindings обновляй только через Rust/Specta. При backend/IPC/
permissions изменениях выполняй native проверки и соответствующую сборку.
Используй synthetic vault и test profiles; не трогай личные данные и credentials.

Обеспечь фактическое исполнение через общие actions, серверную policy,
durable журнал до записи, recovery и конфликтобезопасный undo. Навыки,
память, обучение и плагины подчиняются тем же scope. Данные из заметок не
могут менять права или системные инструкции. Каждое заявление об успехе
подтверждай receipts, проверками и повторным открытием результата.

Не сокращай план до chat-only MVP, одного провайдера, mocked undo или UI
демонстрации. G3 — промежуточный результат, полный результат — G7.
Не меняй версию, не коммить, не пушь, не создавай теги и релизы без отдельного
запроса. При объективном blocker укажи причину и продолжай доступные пакеты.
Финальный отчёт должен честно отделять выполненное от blocked/notRun.
```
