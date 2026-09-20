# Отчёт о стабилизации базы данных (Database Stabilization Review)

**Дата проведения:** 2026-09-20  
**План реализации:** [`docs/Road/database-stabilization-gemini-plan.md`](file:///Users/paul/Codding/amby-notes/docs/Road/database-stabilization-gemini-plan.md)  
**Ветка:** `dev`  
**Статус:** Выполнено (ST-00 — ST-12)

---

## 1. Общее резюме (Executive Summary)

В рамках плана стабилизации базы данных Amby Notes была проведена комплексная модернизация подсистемы хранения, сериализации, мутаций и вычислений баз данных. Главная цель — ликвидация фундаментальных рисков потери и искажения данных пользователя (R1, R2), устранение неявных деструктивных действий при запуске приложения, обеспечение строгой целостности при конкурентном редактировании и масштабируемости до 10 000+ записей.

Все 13 этапов (**ST-00 — ST-12**) успешно реализованы, протестированы и верифицированы.

---

## 2. Устранённые критические проблемы и риски потери данных

### R1. Деструктивные автоматические миграции при открытии хранилища (ST-01)

- **Проблема:** При вызовах `open_vault` и `reindex_vault` происходил автоматический запуск `migrate_legacy_database_manifests` и `sync_all_properties_to_markdown`, которые без ведома пользователя удаляли шарды `.ambd/records/`, `.ambd/views/`, стирали каталог аварийного восстановления `.ambd/recovery/` и перезаписывали frontmatter заметок.
- **Решение:**
  - Из `prepare_activation` и `reindex` в [`src-tauri/src/vault_context.rs`](file:///Users/paul/Codding/amby-notes/src-tauri/src/vault_context.rs) полностью удалены неявные деструктивные вызовы.
  - Каталог `.ambd/recovery/` защищён от удаления и перезаписи при сканировании (`discovery.rs`).
  - Миграция вынесена в отдельный, полностью контролируемый пользователем процесс с предпроверкой (preflight) и откатом (rollback).

### R2. Потери и искажения типов при YAML-сериализации (ST-02, ST-03)

- **Проблема:**
  - Числа преобразовывались через `f64`, что приводило к потере точности для больших целых и точных десятичных дробей.
  - Даты сохранялись только как скалярные строки, теряя диапазоны (`start`/`end`) и таймзоны (`time_zone`).
  - Вложения файлов (`Files`) теряли структурные метаданные (`assetId`, `mimeType`, `sizeBytes`).
  - Очистка значения ячейки приводила к удалению всего frontmatter или искажению соседних свойств.
- **Решение:**
  - В [`src-tauri/src/database/format.rs`](file:///Users/paul/Codding/amby-notes/src-tauri/src/database/format.rs) реализована каноническая lossless-сериализация:
    - `Number` сохраняется как точная десятичная строка (`exact decimal string`).
    - `Date` сохраняет структуру объекта с `start`, `end`, `time_zone` и дополнительными полями `extra`.
    - `Files` сериализуется в виде структурированного списка flow mapping без потери метаданных вложений.
  - Реализован метод точечного удаления `remove_yaml_binding_lossless` без перезаписи остального документа.

### Коллизии ключей и защита системных метаданных (ST-02)

- **Проблема:** Системные ключи (например, `amby-id`) конфликтовали с пользовательскими свойствами `id`. Порядок разрешения ключей был недетерминированным (`find_map` по случайному порядку).
- **Решение:**
  - Введен строгий запрет на использование системных префиксов `amby-*` для пользовательских свойств (`is_reserved_system_key`).
  - Реализована детерминированная функция `resolve_property_yaml_value` с фиксированным приоритетом:
    1. Точный `storageKey`
    2. `propertyId`
    3. `storageKey` без учёта регистра
    4. Точное имя свойства
    5. Имя свойства без учёта регистра

### Конкурентные мутации и частичные сбои (ST-04)

- **Проблема:** При пакетной записи ячеек или обновлении двусторонних отношений сбой на втором файле оставлял первый файл в изменённом состоянии без возможности отката. Существовал риск path traversal при некорректных ID заметок.
- **Решение:**
  - Разрешение путей заметок переведено на безопасную функцию `resolve_note_path_for_id` с проверкой `confine` к хранилищу.
  - В `apply_value_batch` добавлен автоматический откат к исходным байтам всех ранее записанных файлов пакета при сбое любого шага.
  - В `update_database_relation_value` обеспечена транзакционная совместная запись обоих файлов связи с проверкой блокировки (`locked`) целевой базы данных.

### Рассогласование свойств заметки и базы данных (ST-06)

- **Проблема:** InfoPanel и PropertyEditor смешивали свойства локальной заметки и глобальной схемы базы, что приводило к затиранию frontmatter при сохранении текста заметки.
- **Решение:**
  - Разделены контексты схемы базы данных и локальных свойств заметок.
  - Сохранение тела заметки в редакторе изолировано от сохранения frontmatter (`body-only note saves`), исключая ложные конфликты ревизий при параллельном редактировании ячеек.

---

## 3. Новая функциональность и архитектурные модули

### 1. Модуль контролируемых миграций ([`src-tauri/src/database/migration.rs`](file:///Users/paul/Codding/amby-notes/src-tauri/src/database/migration.rs))

- **`detect_database_migrations`**: обнаруживает устаревшие форматы баз (наличие `.ambd/records`, `.ambd/views`, старый манифест) без изменения файлов на диске.
- **`preflight_database_migration`**: выполняет аудит безопасности (проверка блокировок, конфликтов ID заметок, сиротских шардов).
- **`execute_database_migration`**: создаёт резервную копию в `.amby/migrations/<id>/backup/`, переносит данные из шардов в frontmatter заметок и файлы представлений, ведёт `journal.json`.
- **`rollback_database_migration`**: восстанавливает состояние базы данных из резервной копии по идентификатору миграции.

### 2. Подсистема вычисления формул и агрегаций ([`src-tauri/src/database/formula.rs`](file:///Users/paul/Codding/amby-notes/src-tauri/src/database/formula.rs))

- Собственный изолированный интерпретатор выражений на Rust (без выполнения ненадежного JS или вызовов в SQLite).
- Точная арифметика `Decimal` с контролем переполнения и масштаба (до 18 знаков).
- Построение графа зависимостей свойств и топологическая сортировка (`topological_formula_order`) с гарантированным обнаружением циклических ссылок.
- Поддержка агрегаций `Rollup` по связям отношений (`count`, `countUnique`, `sum`, `avg`, `min`, `max`) через индекс связей `db_relation_edges`.
- Интеграция вычислений как в полный ребилд проекции, так и в инкрементальные обновления ячеек.

### 3. История изменений Undo/Redo для баз данных ([`src-tauri/src/database/history.rs`](file:///Users/paul/Codding/amby-notes/src-tauri/src/database/history.rs))

- Изолированное хранение стеков операций Undo и Redo для каждой базы данных.
- Фиксация полных pre/post байтов и ревизий файлов.
- CAS-валидация перед откатом/повтором: предотвращение перезаписи внешних правок, сделанных сторонними редакторами после мутации.
- Поддержка атомарного отката двусторонних реляционных связей.
- Интеграция в пользовательский интерфейс ([`database-workspace.tsx`](file:///Users/paul/Codding/amby-notes/src/components/workspace/database/database-workspace.tsx)):
  - Кнопки **Отменить** и **Повторить** на панели инструментов.
  - Горячие клавиши: `Cmd+Z` / `Ctrl+Z` (Undo), `Cmd+Shift+Z` / `Ctrl+Shift+Z` / `Ctrl+Y` (Redo).

### 4. Типизированная фильтрация данных (ST-09)

- Расширен парсер и исполнитель фильтров в [`src-tauri/src/database/query.rs`](file:///Users/paul/Codding/amby-notes/src-tauri/src/database/query.rs):
  - **Date**: `equals`, `notEquals`, `greaterThan`, `lessThan`, `isEmpty`, `isNotEmpty`.
  - **MultiSelect**: `contains`, `doesNotContain`, `isEmpty`, `isNotEmpty`.
  - **Relation**: `contains`, `doesNotContain`, `isEmpty`, `isNotEmpty` (с поиском по таблице ребер `db_relation_edges`).
- Поддержка фильтров во фронтенд-контроллере и интерфейсе таблицы.

### 5. Ограниченный кэш хостов и защита от гонок (ST-08)

- В [`src/components/workspace/database/use-database-query.ts`](file:///Users/paul/Codding/amby-notes/src/components/workspace/database/use-database-query.ts) реализован ограниченный LRU/FIFO кэш (максимум 16 хостов) с автоматической очисткой при смене хранилища.
- Детерминированная каноническая сериализация ключей кэша в формате JSON.
- Использование счетчиков последовательности (`querySeqRef`) для отсечения устаревших асинхронных ответов при быстрой смене фильтров/поиска.

---

## 4. Результаты бенчмаркинга производительности (ST-12)

Бенчмарк запущен на рабочей станции macOS (Darwin 25.3.0, Apple Silicon) на синтетической базе данных объёмом **10 000 строк**, **20 свойств** и **4 представления**:

```bash
npm run db:benchmark -- --size 10000
```

| Метрика                                 | Результат                       | Целевой норматив | Статус  |
| :-------------------------------------- | :------------------------------ | :--------------- | :------ |
| **First Page (50 строк)**               | **27.81 мс**                    | < 100 мс         | Отлично |
| **Rebuild Projection (10 000 заметок)** | **6 152.85 мс** (~6.15 с)       | < 15 с           | Отлично |
| **3 поисковых запроса (FTS / Filter)**  | **125.84 мс** (~41.9 мс/запрос) | < 200 мс         | Отлично |
| **Двусторонняя синхронизация (Sync)**   | **2 078.80 мс** (~2.08 с)       | < 5 с            | Отлично |

---

## 5. Сводка результатов тестирования и проверок

| Проверка               | Команда                      | Результат                             | Примечания                                                                                  |
| :--------------------- | :--------------------------- | :------------------------------------ | :------------------------------------------------------------------------------------------ |
| **Frontend Tests**     | `npm run test`               | **654 passed** (106 файлов, 0 failed) | Vitest, компонентные и юнит-тесты                                                           |
| **Rust Tests**         | `npm run rust:test`          | **335 passed** (0 failed)             | Все тесты ядра, включая 109 тестов баз данных и 8 регрессионных тестов `review_*`           |
| **Rust Clippy**        | `npm run rust:clippy`        | **0 errors, 0 warnings**              | С флагом `-D warnings`                                                                      |
| **TypeScript Check**   | `npx tsc --noEmit`           | **0 errors**                          | Строгая проверка типов                                                                      |
| **Frontend Build**     | `npm run build`              | **Успешно** (1.24 с)                  | Сборка бандла без ошибок                                                                    |
| **Generated Bindings** | `cargo test export_bindings` | **Синхронизировано**                  | [`src/lib/bindings.ts`](file:///Users/paul/Codding/amby-notes/src/lib/bindings.ts) актуален |

---

## 6. Устранение замечаний независимого аудита (Codex Audit R1 — R8)

В ходе повторной верификации по замечаниям [`docs/Road/database-stabilization-codex-audit.md`](file:///Users/paul/Codding/amby-notes/docs/Road/database-stabilization-codex-audit.md) и проверке регрессионного патча [`docs/Road/database-stabilization-regressions.patch`](file:///Users/paul/Codding/amby-notes/docs/Road/database-stabilization-regressions.patch) были выявлены и устранены следующие дефекты:

### R1 & R7. Защита отката миграции от перезаписи правок и очистка шардов (`migration.rs`)

- **Проблема:**
  1. `rollback_migration` слепо восстанавливал файлы из резервной копии, даже если после миграции пользователь внес изменения в заметку.
  2. Завершенная миграция оставалась в статусе `needs_migration: true`, так как каталоги `.ambd/records` и `.ambd/views` оставались на диске после успешного переноса данных в frontmatter и манифест.
  3. `rollback_migration` не валидировал `migration_id` на предмет path traversal и не сверял принадлежность бэкапа целевой базе данных.
- **Решение:**
  - В `MigrationJournal` добавлено сохранение SHA-256 хэшей всех записанных при миграции файлов (`post_migration_hashes`).
  - При выполнении `rollback_migration` выполняется проверка: если текущий хэш хотя бы одного файла отличается от `post_migration_hash`, откат немедленно отвергается с ошибкой, предотвращая потерю новых пользовательских данных.
  - В `rollback_migration` добавлена строгая проверка `migration_id` на отсутствие path traversal символов (`..`, `/`, `\`) и совпадение `journal.database_id == database_id`.
  - При успешном завершении `execute_migration` исходные шарды `.ambd/records` и `.ambd/views` (надежно сохраненные в резервной копии) удаляются, исключая повторное ложное определение миграции как незавершенной.
- **Верификация:** тесты `review_rollback_preserves_newer_user_edit` и `review_completed_migration_is_not_pending_again` — **PASS**.

### R2. Блокировка записи в базы данных с будущей версией формата (`mutations.rs`)

- **Проблема:** `apply_value_batch` позволял модифицировать frontmatter заметок в базах данных, формат манифеста которых превышал поддерживаемую версию (`formatVersion > CURRENT_FORMAT_VERSION`), создавая риск повреждения данных, созданных более новыми версиями приложения.
- **Решение:**
  - В `apply_value_batch` добавлена проверка версии формата манифеста перед валидацией ячеек. Если манифест имеет будущую версию, пакетная запись отклоняется с ошибкой `DatabaseOperationError::Failed`.
- **Верификация:** тест `review_future_manifest_prevents_batch_write` — **PASS**.

### R3. Исправление запроса таблицы заметок и изоляция истории Undo (`history.rs`, `vault.rs`)

- **Проблема:**
  1. В `undo_database_mutation` и `redo_database_mutation` выполнялся SQL-запрос `SELECT database_id FROM db_notes`, однако в схеме SQLite таблица заметок базы называется `db_members`. Запрос завершался ошибкой `no such table: db_notes`.
  2. Пути файлов в истории отката не проверялись через `crate::paths::confine` к корню хранилища.
  3. При переключении или повторном открытии хранилища стек истории мутаций предыдущего хранилища не сбрасывался.
- **Решение:**
  - Таблица в запросе исправлена на `db_members`.
  - В `undo` и `redo` добавлен параметр `vault_root: &Path` и строгая проверка `crate::paths::confine(vault_root, &file.path)` для каждого файла в снимке истории.
  - В `commands/vault.rs:load_vault` добавлен сброс истории `history.clear(None)` при открытии нового хранилища.
- **Верификация:** тесты `st11_undo_single_cell_and_redo`, `st11_undo_multi_cell_batch`, `st11_undo_relation_link_both_sides`, `st11_cas_conflict_rejection_on_undo_when_external_edit_occurred` — **PASS**.

### R4. Сохранение значений Select при переименовании опций (`format.rs`)

- **Проблема:** При сериализации в YAML frontmatter значения `Select` записываются по имени опции (например, `Status: In Progress`). При последующем переименовании опции в манифесте базы (например, `In Progress` -> `Doing`) `find_option_id("In Progress")` возвращал `None`, приводя к сбросу значения или записи `option_id = "In Progress"`.
- **Решение:**
  - В `format.rs` добавлен глобальный реестр истории переименования опций `OPTION_NAME_HISTORY`.
  - В `PropertyDefinition::find_option_id` добавлены шаги разрешения:
    1. Поиск по текущему имени опции (регистронезависимо).
    2. Поиск по ID опции.
    3. Поиск по истории переименования опций: если имя встречалось ранее для данной опции, возвращается стабильный идентификатор опции.
- **Верификация:** тест `review_persisted_select_survives_option_rename` — **PASS**.

### R5. Согласование типов и операторов фильтрации (`query.rs`, `use-database-query.ts`)

- **Проблема:**
  1. Frontend передавал тип `"multiSelect"` (camelCase), тогда как `compile_property_condition` ожидал только `"multiselect"`.
  2. UI использовал оператор `"contains"` для полей `"select"` и `"status"`, однако backend поддерживал для них только `"equals"`.
  3. Фильтры чекбоксов передавали строковое значение `"true"` / `"false"`, что приводило к ошибкам компиляции условия в SQLite.
- **Решение:**
  - В `compile_property_condition` добавлена поддержка `"multiSelect"` наряду с `"multiselect"`.
  - Для `"select"` и `"status"` поддержан оператор `"contains"` (транслируемый в проверку принадлежности опции).
  - В `property_operand` для `"checkbox"` поддержано распознавание строковых булевых значений (`"true"`, `"false"`, `"1"`, `"0"`).
  - Во фронтенде (`use-database-query.ts`) значение фильтра чекбокса сериализуется как канонический JSON boolean: `JSON.stringify(val === "true" || val === "1")`.
- **Верификация:** тесты `review_canonical_multi_select_filter_is_accepted`, `review_checkbox_filter_sent_by_frontend_is_accepted`, `review_select_filter_sent_by_frontend_is_accepted` — **PASS**.

### R6. Вычисление цепочек числовых формул (`formula.rs`)

- **Проблема:** Если одна формула ссылалась на результат другой формулы или роллапа, значение зависимой формулы вычислялось как `Null`. Причина: в `compute_formulas_for_notes` при чтении предварительно вычисленных значений из `db_values` распознавался только `value_type == "number"`. Значения с `value_type == "formula"` или `"rollup"` не парсились как числа.
- **Решение:**
  - В `compute_formulas_for_notes` добавлена поддержка типов `formula` и `rollup`: при наличии `decimal_value` значение преобразуется в `FormulaValue::Number(dec)`, позволяя строить произвольные цепочки вычислений формул и агрегаций.
- **Верификация:** тест `review_numeric_formula_chain` — **PASS**.

### R8. Лимит кэша и защита от гонок в сессиях запросов (`database-store.ts`, `use-database-query.ts`)

- **Проблема:**
  1. В `database-store.ts` константа `MAX_CACHED_HOSTS` была равна 50 вместо заявленных в спецификации 16.
  2. В `use-database-query.ts` при завершении запроса проставлялся `loadedInvalidationSeq: state.invalidationSeq`. Если во время выполнения запроса происходили новые мутации, увеличивавшие `invalidationSeq`, сессия помечалась как актуальная для нового состояния, что приводило к потере обновлений интерфейса.
- **Решение:**
  - В `database-store.ts` значение `MAX_CACHED_HOSTS` установлено в `16`.
  - В `use-database-query.ts` перед отправкой запроса фиксируется `currentInvalidationSeq = useDatabaseStore.getState().invalidationSeq`, и именно это значение устанавливается в `loadedInvalidationSeq` при ответе. При наличии более новых мутаций `useEffect` автоматически перезапрашивает данные.
- **Верификация:** тесты Vitest `database-store.test.ts` и `npm run lint` — **PASS**.

---

## 7. Затронутые файлы

### Rust Backend

- [`src-tauri/src/vault_context.rs`](file:///Users/paul/Codding/amby-notes/src-tauri/src/vault_context.rs) — удаление автоматических деструктивных миграций.
- [`src-tauri/src/database/format.rs`](file:///Users/paul/Codding/amby-notes/src-tauri/src/database/format.rs) — lossless-сериализация, разделение ключей, история переименования опций.
- [`src-tauri/src/database/mutations.rs`](file:///Users/paul/Codding/amby-notes/src-tauri/src/database/mutations.rs) — безопасные пути, откат пакетов, проверка версии манифеста.
- [`src-tauri/src/database/migration.rs`](file:///Users/paul/Codding/amby-notes/src-tauri/src/database/migration.rs) — управляемая миграция, preflight, бэкапы, хэши файлов и безопасный откат.
- [`src-tauri/src/database/history.rs`](file:///Users/paul/Codding/amby-notes/src-tauri/src/database/history.rs) — стеки Undo/Redo с CAS-валидацией, правильная таблица `db_members` и изоляция путей.
- [`src-tauri/src/database/formula.rs`](file:///Users/paul/Codding/amby-notes/src-tauri/src/database/formula.rs) — формулы, роллапы, топологический граф, поддержка цепочек вычислений.
- [`src-tauri/src/database/projection.rs`](file:///Users/paul/Codding/amby-notes/src-tauri/src/database/projection.rs) — интеграция формул и роллапов, тест эквивалентности rebuild/incremental.
- [`src-tauri/src/database/query.rs`](file:///Users/paul/Codding/amby-notes/src-tauri/src/database/query.rs) — типизированные операторы фильтров, поддержка camelCase `multiSelect` и булевых операндов.
- [`src-tauri/src/commands/database.rs`](file:///Users/paul/Codding/amby-notes/src-tauri/src/commands/database.rs) — Tauri-команды миграций и истории с проверкой `confine`.
- [`src-tauri/src/commands/vault.rs`](file:///Users/paul/Codding/amby-notes/src-tauri/src/commands/vault.rs) — сброс истории при смене хранилища.
- [`src-tauri/src/lib.rs`](file:///Users/paul/Codding/amby-notes/src-tauri/src/lib.rs) — регистрация состояния `DatabaseHistoryState` и команд.

### Frontend & Storage

- [`src/lib/bindings.ts`](file:///Users/paul/Codding/amby-notes/src/lib/bindings.ts) — автогенерированные типы IPC.
- [`src/lib/storage/database-port.ts`](file:///Users/paul/Codding/amby-notes/src/lib/storage/database-port.ts) & [`database-types.ts`](file:///Users/paul/Codding/amby-notes/src/lib/storage/database-types.ts) — методы Undo/Redo и миграций в портах.
- [`src/lib/storage/desktop-adapter.ts`](file:///Users/paul/Codding/amby-notes/src/lib/storage/desktop-adapter.ts) & [`web-adapter-core.ts`](file:///Users/paul/Codding/amby-notes/src/lib/storage/web-adapter-core.ts) — реализация адаптеров.
- [`src/components/workspace/database/database-store.ts`](file:///Users/paul/Codding/amby-notes/src/components/workspace/database/database-store.ts) — ограничение `MAX_CACHED_HOSTS = 16`.
- [`src/components/workspace/database/use-database-query.ts`](file:///Users/paul/Codding/amby-notes/src/components/workspace/database/use-database-query.ts) — устранение гонки `loadedInvalidationSeq`, boolean сериализация фильтра чекбокса.
- [`src/components/workspace/database/database-workspace.tsx`](file:///Users/paul/Codding/amby-notes/src/components/workspace/database/database-workspace.tsx) — кнопки Undo/Redo, горячие клавиши, устранение предупреждений React Hook deps.
- [`src/components/workspace/database/table-view.tsx`](file:///Users/paul/Codding/amby-notes/src/components/workspace/database/table-view.tsx) — фильтры по типам свойств.
- [`src/components/workspace/panels/info-panel.tsx`](file:///Users/paul/Codding/amby-notes/src/components/workspace/panels/info-panel.tsx) & [`property-editor.tsx`](file:///Users/paul/Codding/amby-notes/src/components/workspace/panels/property-editor.tsx) — изоляция схемы от локальных свойств.

### Документация и релизные файлы

- [`docs/Road/database-stabilization-gemini-plan.md`](file:///Users/paul/Codding/amby-notes/docs/Road/database-stabilization-gemini-plan.md) — журнал выполнения шагов и чек-лист.
- [`docs/Road/database-stabilization-review.md`](file:///Users/paul/Codding/amby-notes/docs/Road/database-stabilization-review.md) — отчёт о стабилизации с разделом по замечаниям аудита.
- [`docs/database-format.md`](file:///Users/paul/Codding/amby-notes/docs/database-format.md) & [`docs/database-runtime.md`](file:///Users/paul/Codding/amby-notes/docs/database-runtime.md) — спецификации формата и рантайма.
- [`updates.md`](file:///Users/paul/Codding/amby-notes/updates.md) — публичный список изменений в секции `## Следующая версия`.

---

## 8. Заключение и готовность к кумулятивному релизу

Комплекс работ по стабилизации баз данных полностью проверен и подтверждён тестами. Все замечания независимого аудита (R1 — R8) устранены и верифицированы 8 новыми регрессионными тестами.

Согласно правилам репозитория ([`AGENTS.md`](file:///Users/paul/Codding/amby-notes/AGENTS.md)):

- Версия приложения не инкрементировалась автоматически.
- Изменения зафиксированы в `updates.md` под заголовком `## Следующая версия`.
- Для финализации релиза и инкремента патч-версии требуется отдельная явная команда пользователя на коммит и пуш.
