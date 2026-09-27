# Отчёт о выполнении плана производительности и багов Luna

Дата финальной проверки: 11 сентября 2026 года
Ветка: `dev`
Версия приложения: `0.1.2`
Исходная ревизия: `f6775ee`
Окружение: macOS 26.6.2, Apple Silicon, Node.js 24.15.0, npm 11.12.1,
Rust 1.95.0, Cargo 1.95.0.

## Итог

Кодовые задачи плана 01–16 выполнены. После независимой проверки дополнительно
закрыты воспроизведённые дефекты R1–R12: общая сериализация Source/Canvas,
неблокирующий recovery flush, защита старых discard/save, привязка recovery к
vault и generation, ранняя фиксация dirty-state, общий mutation gate,
ограниченная Canvas-работа, адресный workspace, реальные рёбра графа, корректные
recovery-квоты и подготовка индекса вне SQLite mutex.

Изменения не требуют миграции пользовательских Markdown или Canvas-файлов. Не
использовались личные vault, секреты или внешние сервисные доступы. Версия не
изменялась, commit/push не выполнялись.

## Что было исправлено по независимой проверке

| Дефект                                                                     | Исправление и подтверждение                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1. Source/Canvas выпадали из общей сериализации                           | Tiptap, SourceEditor и Canvas регистрируют свои flush-участники. Глобальный flush сначала публикует редакторные буферы, затем recovery и основной autosave. Canvas использует debounce/max-wait и немедленный publish после окончания drag/resize. Регрессии покрыты `source-editor.test.tsx` и `use-canvas-document.test.tsx`. |
| R2. Recovery rejection блокировал основной flush                           | Recovery и основные autosave теперь выполняются через `Promise.allSettled`; ошибка recovery возвращается вызывающему коду после завершения primary participants. Добавлен тест отказа recovery.                                                                                                                                 |
| R3. Старый discard мог удалить новый draft                                 | Очередь хранит номер версии и hash последней опубликованной записи. Discard ждёт in-flight операцию, проверяет, что версия не изменилась, а backend delete использует compare-and-delete по content hash. Добавлены Vitest и Rust regression tests.                                                                             |
| R4. Recovery не был scoped по владельцу                                    | Введён `RecoveryScope(vault, generation)` для очереди, browser fallback и IPC. Rust проверяет активный canonical vault и generation под mutation gate; старый контекст получает отказ и не может читать/удалять новый draft.                                                                                                    |
| R5. Source правка становилась dirty поздно                                 | Source и Canvas вызывают `onContentDirty` сразу при локальной правке, до debounce публикации. Поэтому ошибка основного save сохраняет dirty-state и recovery.                                                                                                                                                                   |
| R6. Не все файловые операции имели общий gate                              | `mutation_gate` согласует activation, migration, move/rename, create/delete/restore, note/file save, recovery, assets, history и database mutations. Read/search пути gate не берут.                                                                                                                                            |
| R7. После первой записи очередь теряла debounce-состояние                  | Queue state сохраняется после успешного save. Последующие правки объединяются в один ожидающий snapshot; завершение старой записи не запускает новый save раньше уже установленного timer/maxWait окна.                                                                                                                         |
| R8. Canvas повторно парсил и сериализовал слишком часто                    | Неизменённый вход парсится один раз; состояние React Flow используется как буфер. Drag/resize кадры не публикуют JSON на каждый event, а checkpoint ограничен timer/maxWait и flush-границами.                                                                                                                                  |
| R9. Изменение документа перерисовывало весь workspace                      | `WorkspaceOrchestration` больше не подписывается на весь `openDocs`. Видимый редактор подключается к своему document selector через `ConnectedCachedDocumentEditor`; Canvas buffers остаются в refs. BlockHandles сохраняет geometry cache, а document-level mousemove больше не выполняет синхронные layout reads.             |
| R10. Graph links имели строковые endpoints при renderer-проверке координат | Topology sync строит `SimLink` с реальными `SimNode` endpoints. D3 обновляет SVG-координаты через refs/RAF без `setTick` на каждый simulation tick. Добавлен тест изменения количества рёбер.                                                                                                                                   |
| R11. Recovery quota измеряла JSON file length и mtime                      | Quota считает `entry.content.len()` и сортирует записи по `saved_at_ms`, сохраняя полную проверку integrity только в read/list/sweep. Recovery I/O дополнительно сериализован одним backend lock.                                                                                                                               |
| R12. FS reads попадали под SQLite mutex                                    | `sync_mutation_result`, path-change sync и wiki-refactor разделены на короткую SQL-фазу сбора, disk-heavy подготовку вне mutex и короткую SQL-фазу применения. После успешного filesystem mutation ошибка индекса оставляет файл и помечает rebuild.                                                                            |

## Остальные пункты плана 01–16

- Безопасный helper асинхронных подписок закрывает позднюю регистрацию listener,
  rejection и повторный cleanup.
- Selection Markdown вычисляется лениво при смене режима с предварительным flush
  Tiptap; unknown Markdown/YAML и line endings сохраняются.
- Скрытые вкладки и document subscriptions изолированы; callbacks дерева и
  drag-state адресны и сравниваются в memo comparator.
- Откреплённые панели используют задержку скрытия и отмену при возврате курсора.
- Quick Open ранжирует весь набор по имени и относительному пути и ограничивает
  отрисовку выдачей; таблица обновляет виртуальный диапазон не чаще одного RAF.
- Запись заметки индексируется из подготовленных tags/links и точных
  опубликованных bytes без повторного чтения Markdown после save; revision и
  watcher fingerprint используют ту же версию bytes.
- Move/rename сохраняют preview reuse, rollback, collision/no-replace,
  watcher-сигналы, bundle/layer semantics и точечное обновление индекса.
- Граф владеет составом topology через React, а координатами SVG — через D3 и
  DOM refs; cleanup останавливает simulation и RAF.

## Автоматическая проверка

## Дополнительное исправление: автофокус переименования новой заметки

Независимо воспроизведённый сценарий создания заметки показал, что строка
успевала получить только фокусную обводку: поле имени находилось внутри
интерактивного `<button>`, а WebKit/Tauri сразу отправлял ему `blur`. Поэтому
режим переименования закрывался до ввода текста.

Исправлено следующее:

- `TreeNode` теперь рендерит редактируемую строку отдельным контейнером без
  вложенного интерактивного элемента.
- После монтирования поля выполняется отложенный `focus()` и выделяется весь
  текст (`selectionStart = 0`, `selectionEnd = длина названия`).
- Создание из контекстного меню запускается после его закрытия и восстановления
  фокуса Radix, поэтому меню больше не перехватывает фокус нового поля.
- Вложенное контекстное меню строки останавливает событие до общего меню панели,
  поэтому создание из меню папки или другой заметки больше не конкурирует с
  созданием в корне.
- Триггер переименования сопоставляется как по стабильному ID, так и по пути и
  повторяется после обновления виртуализированного дерева; фиксированный таймаут
  больше не снимает его раньше watcher-обновления, когда индекс ещё не успел
  вернуть ID новой заметки.
- Добавлены regression-тесты `sidebar-tree.test.tsx`, проверяющие наличие поля,
  активный фокус, полное выделение названия, path-fallback и вложенное меню;
  component-тесты также проверяют создание через контекстное меню для листа,
  заметки-контейнера и папки.

Проверка этого исправления: целевые тесты дерева — 12 тестов успешно.

Финальные результаты:

- `npm run verify` — все этапы прошли до финального `bindings:check`: version
  sync, TypeScript, ESLint, 88 Vitest-файлов и 511 тестов, Prettier, Knip,
  Rustfmt, strict Clippy и Rust tests успешны. Финальная команда закономерно
  возвращает non-zero, пока сгенерированный `src/lib/bindings.ts` отличается от
  HEAD из-за текущего IPC-изменения; файл перед этим обновлён экспортирующим
  Rust-тестом и не редактировался вручную. После включения generated diff в
  commit этот check будет зелёным.
- `npm run build` — успешно; production frontend bundle собран Vite без ошибок
  (2 901 модуль).
- `cargo test --manifest-path src-tauri/Cargo.toml` — 274 passed, 0 failed,
  1 ignored.
- `AMBY_E2E_LARGE_VAULT_SIZE=1000 npm run test:e2e:large` — успешно: initial
  scan 221.68 ms, reopen 51.16 ms, one-file update 44.29 ms, search 358.58 µs.
- `AMBY_E2E_LARGE_VAULT_SIZE=5000 npm run test:e2e:large` — успешно: initial
  scan 1.138 s, reopen 310.27 ms, one-file update 242.21 ms, search 695.75 µs.
- Эти timings — измерение текущей ревизии на синтетическом backend-сценарии,
  а не сравнение before/after: сопоставимая исходная линия до исправлений не
  была сохранена в предыдущем сеансе.
- `git diff --check` — успешно; ручных изменений `src/lib/bindings.ts` нет,
  bindings regenerated Rust test’ом.
- `npm run knip` — только существующая configuration hint для `.css`, без
  unused exports.

Добавленные регрессии отдельно проверяют Source flush без blur, Canvas flush и
ограничение parse/resize, graph topology, recovery coalescing, failure path и
CAS-safe discard. Backend tests дополнительно покрывают compare-and-delete,
rollback, generation boundaries и сохранение файла при ошибке индекса.

## Native и ручные проверки

Изменения затрагивают Tauri IPC, Rust commands и activation, поэтому native
сборка учитывалась отдельно. Проверка `npm run tauri build -- --bundles app`
собирает `Amby.app`; полный bundle pipeline ранее доходил до стандартной
DMG-обёртки, но её Finder/AppleScript шаг и notarization недоступны в текущем
headless sandbox без Apple credentials. Это ограничение упаковочного окружения,
а не ошибка TypeScript/Rust или native application bundle.

После финального исправления выполнен чистый перезапуск `npm run tauri dev`.
Окно Amby открылось, dev-сервер и native-процесс работают; после чистого запуска
новая ошибка React-hook не воспроизводится. В журнале остаётся только прежнее
предупреждение `window_state.restore_failed`, не связанное с созданием заметок.
Интерактивный сценарий меню корня, папки и заметки зафиксирован целевыми
component/regression-тестами, поскольку автоматизированное AX-управление
вложенным Tauri WebView в текущем окружении недоступно.

`npm run test:storage:live` успешно собрал frozen native-contract bundle и Rust
процесс, но сам GUI-contract не вернул `AMBY_NATIVE_RESULT` в headless-сеансе и
завершён вручную после timeout. Это не засчитано как passing native-contract
test; лог сохранён в `.release-evidence/native-contract.log`, а временные
`.release-evidence`-артефакты не являются частью исходных данных.

В доступной среде не выполнен достоверный интерактивный Performance trace
настоящего Tauri WebView: не удалось получить AX-окно для ручного измерения.
Поэтому отчёт не приписывает исправлениям числовые FPS, long tasks, React
commits, IPC latency или длительность SQLite lock. Backend smoke создавал и
удалял собственные временные vault на 1 000 и 5 000 заметок; личные данные не
использовались. Canvas-карточки и графовые узлы в отдельный интерактивный
профиль не создавались.

Оставшаяся проверка — ручной cross-platform сценарий на macOS/Windows/Linux и
DevTools Performance trace на синтетическом vault. Она не блокирует готовность
кодовых исправлений и автоматических data-safety regression tests, но должна
быть выполнена отдельно перед утверждением измеренных UX-метрик.

## Публичная фиксация

- Контракт recovery и flush-периодика зафиксированы в
  `docs/vault-format.md`.
- Накопленные пользовательские изменения добавлены в `updates.md` под
  `## Следующая версия`.
- Этот файл является отдельным полным отчётом о выполненных изменениях и
  проверках.
