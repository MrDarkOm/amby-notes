# Оркестрация Luna: Debug-режим Amby

Дата: 2026-09-27. Контракт и продуктовый объём: [план](./debug-mode-plan.md).
Доказательства завершения: [приёмка](./debug-mode-acceptance.md).

## Исполнители и правила

Координатор отвечает за contract freeze, интеграцию и итоговый gate. Три
исполнителя используют `gpt-6-luna` с reasoning `high`. Текущий запуск —
subagents в общем рабочем дереве, а не независимые чаты с конфликтующими checkout.

| Исполнитель   | Пакеты                        | Исключительная зона                                                                                                                                 |
| ------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Luna Backend  | D-11/D-12 + native часть D-21 | logging.rs/подмодули, commands/debug.rs, lib.rs регистрация; notes.rs только optional correlation/telemetry; bindings генерация                     |
| Luna Frontend | D-10 + report builder D-41    | logger/tests, lib/debug types/privacy/report, storage debug repository/export, settings store/config только Debug, main.tsx                         |
| Luna UI       | D-30/D-31/D-40/D-50           | settings Debug UI/session/store/tests, shell indicator, locales, Debug CSS под themes                                                               |
| Координатор   | D-00/D-01/D-20/D-21/D-60      | health inspector, autosave/recovery read-only inspection, storage operation instrumentation, close flush, docs/changelog, integration и full checks |

### Общие файлы

`bindings.ts` пишет только Backend через generator. `resources.ts` и Debug CSS
пишет только UI. `updates/upd_next.md` и эти документы пишет только координатор.
Frontend вставляет export debug repository в storage/index.ts; остальные
изменения этого файла делает координатор. Новый конфликт ownership сначала
согласуется сообщением, затем файл передаётся одному owner.

### Порядок запуска

1. D-00: read-only аудит и фиксация текущего dirty diff; не reset/stash/checkout.
2. D-01: общий wire contract и точные экспортируемые API. До него downstream
   может читать код и готовить pure logic, но не придумывать несовместимые типы.
3. W1: Backend DTO/config/collector, Frontend types/privacy/logger, UI pure session
   logic работают параллельно. Backend публикует generated bindings.
4. W2: после types ready — repository/listener/settings и UI соединяются с API;
   координатор внедряет read-only health и operation instrumentation.
5. W3: history/flush/clear, viewer, capture/report/performance. Producer/consumer
   интерфейсы меняются только с подтверждением владельцев.
6. W4: targeted tests и review каждого owner, затем интеграция. Исполнители
   сообщают реальные проверки, ограничения и список файлов.
7. W5: один координатор запускает full build/verify/native. По findings Luna
   получает focused repair пакет; повторяется только оправданная проверка.
8. G6 разрешён лишь после actual evidence. Commit/push/tag/release не входят
   в эту оркестрацию; версия остаётся исходной.

## Задания для повторного запуска

Каждое задание начинается чтением AGENTS.md, плана и приёмки. При продолжении
не повторять выполненное: сначала сверить журнал и фактические файлы/проверки.

### Backend

> Реализуй D-11/D-12 и native D-21. Соблюдай frozen DTO/API плана. Структурированный
> tracing collector очищает поля до stdout/buffer/disk/events. Настройки реально
> меняют threshold; default не пишет на диск. Bounded single writer обеспечивает
> flush/clear/rotation/history, ошибки видны. Health отражает существующее состояние.
> Correlation явная, без process-global current op. Не меняй бизнес-логику
> сохранения. Генерируй bindings, изолируй Rust tests, проверь failure/recovery.
> Не редактируй frontend/docs/changelog и не commit/push/version. Передай файлы,
> команды, результаты и известные ограничения координатору.

### Frontend

> Реализуй D-10 и safe report builder D-41. Logger строго фильтрует все выходы,
> очищает metadata до serialization, использует стабильные event IDs/window/session
> и operation duration. Transport/retry/clear/flush ограничены и показывают ошибки.
> Все I/O идут через storage debug repository с проверкой Specta Results; browser
> ограничения явные. Settings acknowledge и multiwindow не расходятся с Rust.
> Report повторно очищает вход, содержит окружение/health/capture и previewable
> добровольное описание. Не трогай UI/Rust/health/autosave/docs/changelog. Выполни
> focused tests и форматирование, согласуй APIs с другими owners.

### UI

> Реализуй D-30/D-31/D-40/D-50. Четыре раздела Debug используют реальные logger,
> health и report APIs. Виртуализация/лимиты, поиск и фильтры, operation drill-down,
> история, группировка, pause display, clear screen отдельно delete history.
> Capture живёт независимо dialog, ограничен 5 минутами/5000 events, имеет markers,
> stop и preview/export через storage. Performance показывает реальные duration
> samples, потери и отсутствие данных явно. Все строки ru/en в resources, static
> visuals в themes. No direct bindings/raw data. Не трогай foundation/Rust/docs.

### Координатор

> Сохрани весь исходный dirty diff. Интегрируй только этот scope, собери read-only
> health из существующих stores/coordinators, внедри operation timing без изменения
> семантики данных. Проверь privacy/locking/IPC/config/export/native вручную и
> автотестами. Обнови changelog и evidence. Не объявляй непроверенные сценарии passed.

## Журнал текущего запуска

| Пакет               | Статус                    | Evidence                                                                                 |
| ------------------- | ------------------------- | ---------------------------------------------------------------------------------------- |
| D-00                | completed                 | Code audit; baseline logger/diagnostics 10/10 passed                                     |
| D-01                | completed                 | Frozen contract v1, owners назначены; пользователь подтвердил implementation             |
| D-10                | completed                 | Privacy/threshold/transport/listener tests; bounded flush/retry/clear                    |
| D-11/D-12           | completed                 | Rust tests, native Debug IPC 3/3, generated bindings воспроизводимы                      |
| D-20/D-21           | completed                 | Pure health/autosave tests; main → settings bridge; native note correlation              |
| D-30/D-31/D-40/D-50 | completed                 | Browser и native smoke; capture/session/quantile/store tests                             |
| D-41                | completed                 | Native export cancel/success; exported timestamp совпадает с preview; privacy inspection |
| D-60                | verified_with_limitations | 802 Vitest + 364 Rust passed; native storage 10/11; ограничения G6 в acceptance          |

Статусы обновляются по фактическому результату. Наличие документа/компонента
само по себе не завершает пакет.

Интеграционный review дополнительно исправил строгую проверку event/subsystem
codes, гонки clear с in-flight transport, bounded flush, дедупликацию native
retry, позднюю инициализацию listeners, виртуализацию при переключении tabs и
состояние отдельного окна настроек. Native test harness получил те же managed
database states, что production; тестовый профиль и app-data изолированы.

Реализация завершена. G6 не объявлен полностью зелёным: проверка bindings требует
чистого Git diff, а один существующий сценарий native trash расходится с текущей
реализацией удаления. Данные, результаты и непроверенные ручные сценарии явно
описаны в приёмке. Commit/push/version/release не выполнялись.

## Завершение приёмки и упрощение интерфейса

Пользователь запросил завершить оставшиеся проверки и сделать Debug понятнее.
Продолжение выполняют те же три Luna (`gpt-6-luna`, high) в том же `dev` checkout.

| Пакет | Owner         | Задание                                                                                                                                 | Статус      |
| ----- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| D-61  | Luna Frontend | Проверять свежесть bindings через временный export, без Git clean требования или записи рабочего файла                                  | in_progress |
| D-62  | Luna Backend  | Исправить delete согласно vault-local trash контракту; native regression и Debug failure/concurrent clear                               | in_progress |
| D-63  | Luna UI       | Понятные названия/пояснения, обзор с действиями, последовательная запись проблемы, технические фильтры/удаление в дополнительных блоках | in_progress |
| D-64  | Координатор   | Multiwindow clear/store race tests, startup recovery UI tests, browser/native smoke, итоговые gates/evidence                            | in_progress |

Проверка trash выявила расхождение production поведения с текущими
`AGENTS.md`/`docs/vault-format.md`: тест не ослабляется под невосстановимое в Amby
удаление. Правка production ограничена использованием established vault-local
recycle helpers и проверкой восстановления/ошибок. Bindings checker сравнивает
реальную генерацию, а не отключает stale detection.

UX сохраняет четыре раздела, но показывает назначение и доступный следующий шаг.
Raw event codes остаются в деталях и поиске. Текущая запись проблемы независима
от сохранённого журнала; delete action явно описывает свой scope.
