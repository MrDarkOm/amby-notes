# Amby — технический handoff для продолжения разработки

Дата записи: 2026-08-04
Рабочая ветка: dev
Последний исходный commit до текущего набора изменений: d326f45 fix(layout): keep editor usable in narrow windows

Этот документ нужен для продолжения работы в новом чате или новым разработчиком.
Он описывает фактическое состояние рабочего дерева. Текущий набор изменений ещё
не закоммичен: git status показывает большой набор modified/untracked файлов.
Не выполнять git reset, git checkout или массовое удаление без отдельного
подтверждения.

## 1. Принятые продуктовые решения

Amby — не клон Obsidian и не клон Notion. Это собственный open-source
local-first desktop workspace для личных заметок и проектов, с модульностью для
разных сценариев.

- Markdown-файлы и вложения принадлежат пользователю и являются источником правды.
- SQLite — производный индекс для поиска, тегов, ссылок и графа.
- В Amby есть два равноправных режима одного документа: блочный Live/Read editor
  на Tiptap и Source editor на CodeMirror.
- Git обязателен для версии 1.0, но Git UI пока не реализован.
- Нужен полноценный редактор, а не только просмотр заметок.
- Совместимость с Obsidian желательна, но идеальная совместимость со всеми
  плагинами и форматами не является блокером. Важнее Preservation: неизвестные
  данные нельзя молча уничтожать.
- Collections должны оставаться представлениями над Markdown и Properties, а не
  закрытой database-only моделью.
- .amby/ — служебная metadata-папка Amby: rebuildable index, sidecars, history
  и будущие versioned metadata. .obsidian/, .git/, .trash/ и служебные каталоги
  не должны изменяться при индексации.

Подробная продуктовая формулировка находится в README.md, целевой scope — в
ROADMAP.md.

## 2. Карта проекта

### Frontend

- src/App.tsx — корневое React-приложение, startup/error path и оболочка.
- src/main.tsx — запуск приложения, провайдеры и startup diagnostics.
- src/components/workspace/workspace.tsx — orchestration layer: vault, tabs,
  split, sidebars/panels, link graph, editor props и save/conflict callbacks.
- src/components/workspace/document-editor.tsx — title, Live/Read/Source,
  layer selector, selection handoff и focus mode.
- src/components/workspace/source-editor.tsx — CodeMirror Markdown Source editor.
- src/components/workspace/header-tabs.tsx — tabs, split, focus и window controls.
- src/components/workspace/panel-registry.tsx — workspace panels, Properties,
  backlinks/links, graph, settings и dock layout.
- src/components/workspace/use-doc-store.ts — открытые документы, dirty state,
  patching и saved lifecycle.
- src/components/workspace/use-tab-actions.ts — tab actions, split и close.
- src/components/workspace/use-vault-data.ts — загрузка vault, watcher и refresh.
- src/components/workspace/use-file-actions.ts — create/rename/move/delete,
  preview/refactor и файловые операции.
- src/components/workspace/external-conflict-dialog.tsx — внешний conflict
  workflow.
- src/lib/storage.ts — frontend storage/IPC boundary. Файловая система не должна
  вызываться из UI напрямую.
- src/lib/bindings.ts — generated Specta bindings; вручную не редактировать.
- src/lib/diagnostics.ts, logger.ts, recovery-drafts.ts, per-key-queue.ts —
  diagnostics, recovery drafts и per-file write serialization.
- src/index.css — workspace tokens, editor controls, portals, panels и drag UI.

### Tiptap editor

- src/components/workspace/tiptap/TiptapEditor.tsx — editor lifecycle,
  extensions, serialization, selection mapping и coordination menu.
- markdown.ts — Markdown-it/ProseMirror parser и serializer.
- schema.ts — schema-defining extensions.
- markdown-selection.ts — Source ↔ Live textual selection mapping.
- BlockHandles.tsx — hover Grab/plus, drag/reorder, right-click block menu,
  gutter hit zone и menu coordination.
- BlockActionsPanel.tsx — actions, Turn into, Split into blocks, list type
  conversion, duplicate/delete и insert above/below.
- BlockInsertPanel.tsx — меню типов блоков для plus и slash.
- BubbleToolbar.tsx — меню форматирования выделения.
- WikiLinkContextMenu.tsx — отдельное меню wikilink.
- tags-wikilinks.ts — tag/wikilink decorations, clickable chips и raw tokens.
- callout-node.ts и CalloutView.tsx — callout node и визуальное представление.
- opaque-html-node.ts и opaque-markdown-node.ts — preservation unknown/raw nodes.
- transclusion-node.tsx и transclusion-context.ts — ![[...]] preview.
- markdown-table.ts — table preservation.
- floating-menu-events.ts — события взаимного закрытия floating surfaces.
- fixtures/ и markdown.test.ts — compatibility fixtures и tests.

### Rust/Tauri

- src-tauri/src/lib.rs — command registration, Tauri setup, watcher state и
  command facade.
- src-tauri/src/vault_index.rs — SQLite index, scan, incremental reload, note
  read/write, tags, search, link graph, IDs и rename/move refactor.
- src-tauri/src/frontmatter.rs — YAML envelope, properties, body replacement,
  BOM/line endings и atomic writes.
- src-tauri/src/history.rs — snapshots, retention и restore.
- src-tauri/src/recycle_bin.rs — reversible trash/restore.
- src-tauri/src/bundle.rs — note bundles/layers и безопасные rename/move.
- src-tauri/src/model.rs — shared Rust models и generated IPC types.
- src-tauri/src/ai.rs — backend AI request/config support.
- src-tauri/capabilities/default.json — Tauri permissions.

### Документация и CI

- docs/vault-format.md — ownership, .amby, IDs, atomic writes, history,
  external changes и rename/move policy.
- docs/markdown-compatibility.md — Markdown compatibility matrix и round-trip
  contract.
- docs/engineering.md — checks, generated bindings, migrations и flags.
- .github/workflows/verify.yml — frontend/Rust checks, bindings, formatting
  baseline и Windows bundle.

## 3. Список внесённых изменений

### 3.1. Документация и product scope

Изменены README.md и ROADMAP.md.

- Зафиксировано позиционирование Amby как open-source local-first hybrid.
- Описана граница между Amby UX и уровнями совместимости A, B и C.
- Markdown, attachments и SQLite разделены по ownership.
- Зафиксированы обязательные для 1.0 Git, Properties, Collections, Canvas,
  recovery и local-first workflow.
- В roadmap отмечены текущее состояние, запланированное, после 1.0 и release
  gates.
- Добавлены риски по data loss, frontmatter, IDs, Canvas, plugins, sync и scope.

### 3.2. Vault safety и файловые операции

Основные файлы: frontmatter.rs, vault_index.rs, history.rs, recycle_bin.rs,
bundle.rs, lib.rs, storage.ts, bindings.ts.

- Markdown body-only read/write не перезаписывает YAML frontmatter при изменении
  текста заметки.
- Добавлены сохранение BOM и dominant LF/CRLF style, sibling temporary file,
  flush/sync и atomic rename.
- Добавлены failure-path tests: оригинал не должен усекаться, temporary file
  должен очищаться.
- Добавлены preflight и подтверждаемая migration для Amby ULID.
  User-managed IDs и duplicate valid IDs не перезаписываются молча.
- SQLite index расширен для incremental create/move/delete/reload, tags, links,
  backlinks, unresolved links, properties и search result.
- Добавлен Rust watcher с guard собственных записей и coalescing внешних событий.
- Добавлены snapshots до записи, retention, restore и read snapshot text.
- Добавлен reversible trash/restore.
- Добавлены conflict copies, manual merge/recovery draft plumbing и conflict
  dialog.
- Добавлены preview/apply refactor для inbound wikilinks, Markdown links и
  JSON/Canvas references при rename/move.
- Добавлена bundle/layer модель и rollback move/rename.
- storage.ts получил IPC wrappers для vault loading, watcher, preflight,
  history, trash, conflict, refactor, layers, assets, Canvas и metadata.
- bindings.ts синхронизирован с Rust commands/models.

### 3.3. Editor и Markdown model

Основные файлы: markdown.ts, schema.ts, TiptapEditor.tsx,
document-editor.tsx, source-editor.tsx, markdown-selection.ts.

- Parser и serializer расширены для callouts, tasks, tables, transclusions,
  tags, wikilinks, Amby blocks, HTML/opaque nodes, math/Mermaid source и safe
  inline styles.
- Добавлены round-trip fixtures и deterministic corpus tests.
- Добавлен Source selection mapping для перехода между редакторами.
- Serialization дебаунсится, а flush происходит при blur/unmount/переключении.
- restoreSourceFormatting учитывает terminal breaks и line-ending style.
- Raw/unknown constructs вынесены в opaque nodes.
- Добавлены более безопасный editor lifecycle, deferred word count и сохранение
  последнего редактирования при закрытии tab.
- Forced Source mode, который показывал ошибочный баннер на обычной callout
  заметке, был убран из document-editor.tsx. Source mode включается вручную.
  Это осознанный UX-компромисс, но preservation contract требует дальнейшей
  доработки и описан в техническом долге.

### 3.4. Wikilinks, tags и backlinks

Основные файлы: tags-wikilinks.ts, WikiLinkContextMenu.tsx, workspace.tsx,
TiptapEditor.tsx, wiki-links.ts.

- Wikilink в Live editor отображается chip/button, а не сырыми скобками.
- Обычный click вызывает переход по ссылке.
- Tooltip использует фактический разрешённый путь файла, а не alias/label.
- Добавлено меню: открыть, изменить файл, переименовать alias, убрать ссылку.
- Raw token сохраняется в документе; Source остаётся местом для прямого
  Markdown editing.
- Tags остаются отдельными визуальными chips и участвуют в hover behavior.

### 3.5. Block UI

Основные файлы: BlockHandles.tsx, BlockActionsPanel.tsx,
BlockInsertPanel.tsx, floating-menu-events.ts, index.css.

- Grab относится к блоку, plus — к gap между соседними блоками.
- Для callout используется один центрированный Grab на контейнере.
- Gutter hit zone расширена левее контентной колонки и слушается на document
  level.
- Drag indicator один и ставится в геометрическую середину gap.
- Открытое Grab menu фиксируется на блоке и не переезжает при движении мыши.
- Однострочный paragraph имеет Turn into. Многострочный paragraph получает
  Split into blocks.
- Split into blocks создаёт sibling paragraphs и сохраняет inline nodes/marks.
- List conversion выполняется одной ProseMirror transaction для Bullet,
  Numbered и Task.
- Правый клик по любому месту draggable block открывает меню уровня Grab.
- Insert above/below создают paragraph и открывают тот же BlockInsertPanel, что
  и plus.
- macOS Ctrl+click перехватывается на capture-phase, чтобы synthetic primary
  mousedown не выделял block и не открывал BubbleToolbar.
- Selection menu подавляется, пока открыто block context menu, и возвращается
  после обычного левоклика.
- BubbleToolbar, wikilink, slash и block menu взаимно закрываются через
  floating-menu-events.ts.
- Добавлена защита от stale/non-HTMLElement nodeDOM после перестройки списка.

### 3.6. Workspace, startup и CI

Изменены App.tsx, main.tsx, workspace/sidebar/header/panel files и index.css.

- Обновлена desktop surface: unified note surface, focus mode, tabs/split,
  dock-aware sidebars, resize feedback и narrow-window behavior.
- Добавлены startup error boundary и diagnostic report без note content,
  абсолютных paths и secrets.
- Добавлены structured frontend/Rust logs.
- Обновлены i18n strings и UI copy.
- Добавлена CI workflow для verify, Clippy, generated bindings, formatting
  baseline и Windows bundle.
- Добавлены package scripts для typecheck/test/rust/build/verify/format.

## 4. Проверка на момент записи

Последняя проверка прошла успешно.

- npm run typecheck — pass.
- npm test — pass: 9 test files, 111 tests.
- npm run build — pass: Vite production build.
- npm run verify — pass по typecheck, lint, test и Rust check.
- npm run rust:check — pass.
- npm run rust:test — pass: 48 Rust tests.
- npm run rust:clippy — pass с -D warnings.
- git diff --check — pass.

npm run lint ошибок не даёт, но сообщает 23 warnings. Production build сообщает
warning о больших chunks больше 500 kB; это не ошибка сборки.

Tauri dev запускался через npm run tauri dev и получает HMR. Полноценного
автоматического E2E набора для editor interactions пока нет.

## 5. Технический долг и аудит

### P1 — закрыть до стабильного editor milestone

1. Preservation contract расходится с текущим UX. Документация описывает строгий
   Source-only guard для неподдерживаемой разметки, но forced guard был убран,
   чтобы обычные callout notes не показывали ошибочный banner. Нужно выбрать и
   реализовать единый вариант: строгая проверка byte-exact round-trip или
   token-level preservation unsupported constructs. Нельзя оставлять это неявным,
   потому что unsupported Markdown может нормализоваться при сохранении.

2. BlockHandles.tsx слишком большой и stateful. В одном компоненте находятся
   hover tracking, geometry, document listeners, drag engine, autoscroll, ghost,
   context menu, insert menu и ProseMirror transactions. Следующий шаг —
   вынести useBlockHover, useBlockDrag и BlockHandlePortal.

3. Нет component/E2E tests для Mac Ctrl+click, context menu, fixed panel, drag
   indicator, list conversion, selection bubble и insert above/below. Parser
   tests этого не заменяют.

4. Прямые ProseMirror transactions требуют invariants и focused tests для nested
   list, task attrs, callout, selection mapping и stale positions.

### P2 — закрыть до release candidate

- 23 ESLint warnings, включая missing dependencies в BlockHandles, TiptapEditor,
  document-editor и workspace. Возможны stale closures в callbacks/menu.
- Floating menu coordination основана на string events. При росте surfaces нужен
  typed coordinator/context с owner и close reason.
- Новые editor/context labels частично не локализованы.
- List conversion пересоздаёт attrs; нужна политика для ordered start,
  checked task items, nested list attrs и custom metadata.
- Wikilink resolver пока возвращает string path; нужны состояния resolved,
  ambiguous и missing для aliases, anchors, bundles и rename.
- Source ↔ Live serialization не оформлена как одна save transaction с source
  stamp, parser result, serialization result, conflict check и recovery point.
- Properties пока read-only. Нужны safe YAML editing, unknown keys/comments/order
  preservation и preview changes.
- Watcher/index требуют burst, Git checkout, same-size rewrite, rename/move
  chain, stale mtime и 10k/100k vault integration tests.

### P3 — release engineering

- Frontend chunks больше 500 kB: нужен code splitting/lazy loading plan.
- Formatting baseline пока non-blocking; touched files нужно прогнать через
  Prettier/Rustfmt отдельным formatting-only change.
- Нет полного Windows/macOS/Linux smoke matrix на чистых системах.
- Git UI не реализован, хотя Git принят как обязательный 1.0 release gate.
- Нет законченного Collections engine, editable Properties, Templates/Daily
  Notes/task dashboard и полного Amby Canvas editor.
- Нет security audit Tauri permissions, path traversal/symlink, asset protocol,
  AI data flow и future plugin boundary.

## 6. Что не следует считать готовым

- Git integration только принято как требование.
- Properties пока в основном read-only.
- Collections/table/list/board engine и persisted views не завершены.
- Public plugin API отсутствует; есть только internal module seam.
- E2EE sync, self-hosting и collaboration отложены после 1.0.
- Полный Excalidraw round-trip/editor — отдельный scope.
- Canvas сейчас foundation, не финальный 1.0 editor.
- Автоматический lossless Source-only guard не совпадает полностью с текущим
  поведением и требует отдельного решения.

## 7. Правильный порядок продолжения

1. Согласовать Preservation guard и привести код с
   docs/markdown-compatibility.md к одному контракту.
2. Добавить editor interaction tests на block menu, drag, list conversion,
   selection/bubble и Mac context click.
3. Разделить BlockHandles.tsx на hover/drag/menu части без изменения UX.
4. Исправить missing-dependency warnings в недавно изменённых hooks.
5. Локализовать новые editor/context actions.
6. Затем переходить к Properties editor, Collections и Git baseline по roadmap.

## 8. Команды для нового чата

    git status --short
    git diff --stat

    npm run typecheck
    npm run lint
    npm test
    npm run build

    npm run rust:check
    npm run rust:test
    npm run rust:clippy

    npm run verify
    npm run tauri dev

Перед изменениями сначала читать этот файл, AGENTS.md, docs/engineering.md,
docs/vault-format.md, docs/markdown-compatibility.md и соответствующий раздел
ROADMAP.md. Проверять git status до и после работы: текущая ветка содержит
намеренные незакоммиченные изменения пользователя и предыдущих задач.
