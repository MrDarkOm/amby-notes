# Инвентаризация и базовые измерения Amby (MOD-00)

Документ фиксирует результаты инвентаризации кодовой базы Amby 0.1.4 перед переходом к модульной архитектуре 0.1.5 согласно плану `docs/Road/modular-architecture-0.1.5-plan.md`.

## 1. Карта функциональных блоков и зависимостей

| Блок                            | Расположение (Frontend / Backend)                                                                                                                             | Внешние зависимости                              | Статус в целевой архитектуре                                                        |
| :------------------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------ | :----------------------------------------------- | :---------------------------------------------------------------------------------- |
| **Ядро Markdown**               | `src/components/workspace/document-editor.tsx`, `src/components/workspace/tiptap/`, `src/components/workspace/codemirror/`, `src-tauri/src/commands/notes.rs` | Tiptap, ProseMirror, CodeMirror                  | **Ядро** (Минимум)                                                                  |
| **Хранилище и сохранность**     | `src/lib/storage.ts`, `src/components/workspace/autosave/`, `src-tauri/src/frontmatter.rs`, `src-tauri/src/recovery.rs`                                       | Tauri IPC, FS                                    | **Ядро** (Атомарная запись, CAS, recovery drafts, корзина)                          |
| **Файловое дерево и навигация** | `src/components/workspace/tree/`, `src/components/workspace/tabs/`, `src-tauri/src/commands/vault.rs`                                                         | Radix UI, Lucide                                 | **Ядро**                                                                            |
| **Базовый поиск**               | `src/components/workspace/spotlight/`, `src-tauri/src/commands/notes.rs`                                                                                      | SQLite FTS5                                      | **Ядро**                                                                            |
| **Excalidraw (Скетчи)**         | `src/components/workspace/sketch/`, `src/lib/sketch-format.ts`, `src-tauri/src/commands/mutations.rs`                                                         | `@excalidraw/excalidraw` (3.9 MB JS, 195 KB CSS) | **Официальный модуль** (`amby.excalidraw`). Первый кандидат на физическое отделение |
| **Canvas (Холст)**              | `src/components/workspace/canvas/`, `src-tauri/src/commands/mutations.rs`                                                                                     | `@xyflow/react` (169 KB JS)                      | **Официальный модуль** (`amby.canvas`)                                              |
| **История версий**              | `src/components/workspace/history/`, `src-tauri/src/history.rs`                                                                                               | SQLite snapshots                                 | **Официальный модуль** (`amby.history`). Отделяется от crash recovery               |
| **Базы данных**                 | `src/components/workspace/database/`, `src-tauri/src/database/`                                                                                               | SQLite, TanStack Virtual                         | **Официальный модуль** (`amby.databases`). Перенос после стабилизации 0.1.5         |
| **Граф**                        | `src/components/workspace/graph/`                                                                                                                             | `cytoscape` (425 KB JS)                          | **Официальный модуль** (`amby.graph`)                                               |
| **Теги**                        | `src/components/workspace/tags/`, `src-tauri/src/commands/notes.rs`                                                                                           | SQLite index                                     | **Официальный модуль** (`amby.tags`)                                                |
| **Избранное**                   | `src/components/workspace/favorites/`                                                                                                                         | `session.json`                                   | **Официальный модуль** (`amby.favorites`)                                           |
| **Обратные ссылки**             | `src/components/workspace/links/`                                                                                                                             | SQLite link graph                                | **Официальный модуль** (`amby.links`)                                               |
| **AI**                          | `src/components/workspace/ai/`, `src-tauri/src/ai.rs`, `src-tauri/src/credentials.rs`                                                                         | Ollama/OpenAI/Anthropic APIs, OS Keychain        | **Официальный модуль** (`amby.ai`)                                                  |
| **Синхронизация**               | `src/components/workspace/sync/` (в разработке)                                                                                                               | —                                                | **Официальный модуль** (`amby.sync`, статус `preview`)                              |

---

## 2. Анализ связности и паразитных зависимостей

1. **Excalidraw ⟷ Canvas**:
   - `src/components/workspace/sketch/sketch-editor.tsx` импортировал `ToolbarButton` из `canvas/canvas-toolbar.tsx`.
   - `sketch-editor.tsx` импортировал `CanvasNotePickerModal` из `canvas/canvas-note-picker-modal.tsx`.
   - `sketch-editor.tsx` импортировал `toRelativeVaultPath` из `canvas/canvas-markdown.ts`.
   - _Решение в MOD-01_: вынос этих компонентов в нейтральные модули `src/components/workspace/common/` и `src/lib/paths.ts` для обеспечения полной автономности Excalidraw без установленного Canvas.

2. **История версий ⟷ Аварийное восстановление (Crash Recovery)**:
   - В `src-tauri/src/history.rs` и `src-tauri/src/commands/history.rs` смешаны функции пользовательских снимков (snapshots, retention, cleanup) и критические механизмы сохранности ядра (`save_recovery`, `read_recovery`, `delete_recovery`, `list_recovery`, `list_trash`, `restore_trash`).
   - _Решение для MOD-07_: разделение на уровне Rust — аварийные recovery drafts и корзина остаются в ядре (`recovery.rs`, `recycle_bin.rs`), а пользовательские снимки версий переходят в провайдер модуля `amby.history`.

3. **Базы данных ⟷ Workspace**:
   - Обработка `.ambd` файлов и создание строк базы данных имеют прямые ветки в `use-layers.ts` и `workspace-orchestration.tsx`.
   - _Решение для MOD-08_: переход через абстракцию `FileHandler` и `DocumentLayer` в Module Host API.

---

## 3. Базовые измерения (Baseline Metrics — 0.1.4)

### 3.1. Frontend Chunks (`dist/`)

- Общий размер папки `dist/`: **12 MB**
- Крупнейшие vendor-чанки:
  - `vendor-excalidraw`: **4,054 KB JS** (1,408 KB gzip) + **195 KB CSS** (~35% всего фронтенда!)
  - `index-*.js` (основное приложение): **890 KB** (246 KB gzip)
  - `chunk-FOHPRMQF-*.js` (shared icons/ui): **647 KB** (143 KB gzip)
  - `vendor-ui`: **559 KB** (152 KB gzip)
  - `cytoscape.esm`: **425 KB** (138 KB gzip) (модуль Graph)
  - `vendor-emoji-data`: **419 KB** (82 KB gzip)
  - `vendor-tiptap`: **408 KB** (131 KB gzip)
  - `vendor-codemirror-core` + `vendor-codemirror-language`: **486 KB** (174 KB gzip)
  - `katex`: **253 KB** (77 KB gzip)
  - `document-editor`: **246 KB** (69 KB gzip)
  - `vendor-xyflow`: **169 KB** (56 KB gzip) (модуль Canvas)

### 3.2. Rust Backend

- Количество IPC команд в `src-tauri/src/lib.rs`: **75 команд**
- Время компиляции (`dev` profile, warm cache): **~4.3s**
- Модули в `src-tauri/src/`: 20 модулей (`ai`, `app_data`, `bundle`, `commands`, `credentials`, `database`, `frontmatter`, `history`, `index`, `model`, `paths`, `property_store`, `recovery`, `recycle_bin`, `state`, `system_recycle_bin`, `vault`, `vault_context`, `vault_index`, `watcher`).

### 3.3. Тесты

- Frontend тесты: **107 файлов, 663 теста** (время выполнения ~4.1s)

---

## 4. Граница минимального ядра (Target Minimal Core)

В минимальной сборке Amby без установленных модулей остаются:

1. Запуск Tauri, главное окно, меню macOS/Windows, канонизация путей.
2. Проводник файлов (дерево, создание, переименование, удаление в корзину, перемещение).
3. Вкладки и модель буферов документов.
4. Редакторы Markdown: Source (CodeMirror) и Live Preview (Tiptap).
5. Механизмы сохранности: атомарная запись, CAS, защита от перезаписи внешних изменений, recovery drafts, `.amby/trash/`.
6. Базовый поиск по именам и тексту заметок.
7. Настройки приложения, переключение тем и языков.
8. Подсистема модулей: Module Host, реестр установленных пакетов, capability broker, безопасный режим.

Все остальные функции (Excalidraw, Canvas, Databases, History, Graph, Tags, Favorites, Links, AI, Sync) являются модулями с независимым жизненным циклом.
