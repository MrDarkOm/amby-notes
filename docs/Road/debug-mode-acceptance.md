# Приёмка Debug-режима Amby

Дата: 2026-09-27. Связаны [план](./debug-mode-plan.md) и
[оркестрация](./debug-mode-orchestration.md). Реализация завершена; итоговый G6
имеет два явно названных ограничения. Автотест pure logic не заменяет проверку
native save dialog/IPC. `auto` означает подтверждение автотестом, `manual` —
фактически выполненный сценарий, `partial` — оставшаяся ручная проверка.

| ID  | Сценарий                                                     | Результат и evidence                                                                                                                                                        |
| --- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q01 | Debug off/threshold во всех sinks, изменение без restart     | auto + native IPC: threshold/config tests, реальные native события                                                                                                          |
| Q02 | File opt-in, bootstrap без записи                            | auto + native IPC: файл отсутствует до включения; file/history/flush после включения; browser switch disabled                                                               |
| Q03 | Нет автоматических path/title/content/secret/raw error/stack | auto + native IPC + manual JSON: allowlists, pseudonyms, повторная очистка report; native synthetic labels отсутствуют                                                      |
| Q04 | Unknown/circular/huge metadata, bounded serialization        | auto: privacy/logger/report tests; unknown event превращается в diagnostic.invalid_event, unknown subsystem исключён                                                        |
| Q05 | Visible IPC/transport failures, applied config               | auto + manual: Result.error/retry tests, native settings status соответствует открытым vault/watcher/index; исчерпывающий multiwindow failure smoke — partial               |
| Q06 | FE/Rust note correlation, duration/outcome, исходные bytes   | auto + native IPC: read/write/index связаны operationId; сохранённый текст совпадает с fixture                                                                              |
| Q07 | Bounded ring/queue/dropped, workload 10k                     | auto: stress/store/session tests; лимиты и потери проверены. Процент latency overhead не измерялся                                                                          |
| Q08 | File/rotate/clear failure не даёт ложный успех               | auto Rust: writer failure/rotation/bounds; native success path. OS readonly UI failure smoke — partial                                                                      |
| Q09 | Clear с queued writes, screen отдельно persistent history    | auto + native IPC: linearized writer clear, in-flight transport generation test, disk clear; simultaneous two-window UI clear — partial                                     |
| Q10 | Bounded flush перед export/close, save не отменяется         | auto: stuck config/native IPC timeout, observer errors, autosave regression; native export flush success                                                                    |
| Q11 | Retained history после restart, лимиты и повреждённые записи | auto Rust + native IPC; manual перезапуск synthetic profile показывает прежние события                                                                                      |
| Q12 | Реальное состояние main workspace в detached settings        | auto + manual native: 1 open/1 Live Preview, 8 modules, vault open/watcher running/index ready; bridge передаёт только aggregates. Полный dirty/conflict UI smoke — partial |
| Q13 | Inspect не save/flush/change state, Source-only причины      | auto: health/recovery/autosave inspection tests, existing compatibility fixtures; инспекция ограничена по количеству и объёму                                               |
| Q14 | Filters/search/expand/pause/virtualization                   | auto + manual browser: все tabs, видимый первый ряд, раскрытие, поиск без результата, pause/resume; grouping покрыта pure tests                                             |
| Q15 | Capture после dialog close, marker/stop/limits               | auto + manual browser: start/marker/close/reopen/stop, timestamped marker в preview; 5 min/5000 и потери проверены tests                                                    |
| Q16 | Preview = export, cancel ≠ success, нет отправки             | auto + manual native: Escape save dialog без saved notice; success создаёт JSON schema 1; createdAt совпадает с cached preview, health и privacy проверены чтением файла    |
| Q17 | Safe startup report без workspace                            | auto: diagnostics/startup report tests; намеренный native startup crash не вызывался (partial manual)                                                                       |
| Q18 | Реальные avg/p50/p95/max, queue vs execute, empty            | auto + manual browser: quantile/timing tests; без измерений отображаются прочерки и объяснение                                                                              |
| Q19 | Browser fallback, честные native-only ограничения            | manual browser: console/capture/report работают; file/history/delete disabled с пояснением. Скачанный browser artifact не подтверждён: IAB download event не доступен       |
| Q20 | Localization/theme boundaries, permissions narrow            | auto: полный localization/theme guard и format gates; новых разрешений эта реализация не добавляет                                                                          |
| Q21 | Listener lifecycle/retry/dedupe/stable timestamps            | auto: dispose/reinit/partial registration, transport retry, native dedupe; native two-window health request/response manual                                                 |
| Q22 | Existing autosave/conflict/Markdown/native regressions       | 802 Vitest и 364 Rust passed. Native storage 10/11; все три Debug-сценария passed. Trash regression имеет отдельное ограничение ниже                                        |

## Проверки текущего запуска

- Baseline до реализации: logger + diagnostics — 2 suites, 10 tests passed.
- Финальный `npm run verify`: TypeScript, ESLint, Prettier, knip, Rustfmt,
  строгий project Clippy проходят; Vitest — 129 files/802 tests passed;
  Rust — 364 passed, 2 ignored, 0 failed. В ESLint остаётся предупреждение
  `settings-modules.tsx:381` об `activeModules`, существовавшее в исходном diff.
- Последний шаг verify, `bindings:check`, возвращает nonzero из-за
  `git diff --exit-code src/lib/bindings.ts`: новые generated IPC bindings ещё
  не staged/committed. Генератор успешно выполнен повторно; SHA-256 до и после
  одинаков: `c0a675cb56352f65a871ae755190a32cb0f27f2b6befb8160b12b805d2cfb076`.
  Это подтверждает воспроизводимость файла, но не делает Git clean gate зелёным.
  Чужие staged/unstaged изменения не переставлялись ради проверки.
- `npm run test:storage:live`: 10/11 passed, включая **3/3 новых Debug**
  сценария на реальном Tauri IPC. Один существующий тест
  `history and recycle restore preserve the native note` падает на
  `Delete entered vault-local recycle bin`: текущая реализация отправляет
  fixture в системную корзину, тест ожидает vault-local recycle bin.
  Удаление было изменено в исходном рабочем дереве и не входит в эту задачу;
  baseline этого native теста отдельно не запускался, поэтому не утверждается,
  что он падал до начала работы.
- Финальные `npm run build` и `npm run tauri build -- --no-bundle` — passed.
  Native release binary собран; подписанные установщики и публикация не выполнялись.
  Vite сообщает о размере крупных chunks и ineffective dynamic import; это
  предупреждения сборки, без ошибок TypeScript или bundling.

## Ручная проверка

Browser Vite fallback: четыре раздела, narrow viewport, виртуальный журнал,
поиск/детали/pause, запись/marker/закрытие/reopen/stop, JSON preview, empty
performance, native-only hints. Во время smoke исправлены detached settings
heading, hidden force-mounted report tab и измерение virtualizer после смены tab.

Native проверен отдельным `native-ui` profile в ignored `.release-evidence/`,
с synthetic Smoke A/B, собственными app-data/webview и временным app bundle.
Личный vault и установленное приложение не использовались. Test harness приведён
к production managed state, чтобы проверки действительно открывали vault.
После проверки main → settings bridge реальный Overview показывал 1 документ,
1 Live Preview, 8 модулей, работающий watcher и готовый index.

Экспортированный `debug-smoke-report-20260927.json` в synthetic profile:
schema 1, `createdAt=2026-09-27T12:55:50.791Z` совпадает с preview, 10 событий,
health из main window. Автоматические поля не содержат raw synthetic path,
`Smoke A`, `Lifecycle.md` или `Compatibility`. Save dialog cancel не показывает
«Отчёт сохранён»; success показывает его только после создания файла.
JSON содержит disclosure включённых/исключённых полей; автоматической отправки нет.

Не выполнены отдельные ручные сценарии: DevTools/folder opening, deliberately
failed native disk/export, dirty note с внешним удалением во время Debug UI,
simultaneous two-window clear и startup crash. Соответствующие pure/backend
failure и сохранность данных покрыты тестами; UI evidence не подменяется этим.

## Gates

G0–G4: реализация и перечисленные auto/manual evidence готовы, partial UI
сценарии указаны выше. G5: duration correctness и bounded workload подтверждены,
измерение относительного slowdown остаётся невыполненным. G6:
**verified_with_limitations**, из-за clean bindings diff и native trash regression.
Commit/push/tag/release/version bump не выполнялись.
