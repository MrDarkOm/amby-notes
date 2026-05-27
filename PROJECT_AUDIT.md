# Amby Notes — глубокий аудит проекта

> Дата: 2026-05-26 · Область: безопасность, зависимости, архитектура, паритет с Obsidian, тулинг/CI.
> Документ описывает **что есть сейчас** и **что предлагается**. Часть пунктов из предыдущей сессии уже сделана — см. [§8](#8-что-уже-сделано-в-этой-сессии).

---

## Оглавление
1. [Краткая сводка (TL;DR)](#1-краткая-сводка-tldr)
2. [Безопасность](#2-безопасность)
3. [Зависимости: что лишнее, что добавить](#3-зависимости-что-лишнее-что-добавить)
4. [Архитектура: как пересобрать для оптимизации](#4-архитектура-как-пересобрать-для-оптимизации)
5. [Паритет с Obsidian: чего не хватает](#5-паритет-с-obsidian-чего-не-хватает)
6. [Тулинг, CI и проверки (вопрос про CLAUDE.md)](#6-тулинг-ci-и-проверки)
7. [Приоритетная дорожная карта](#7-приоритетная-дорожная-карта)
8. [Что уже сделано в этой сессии](#8-что-уже-сделано-в-этой-сессии)

Обозначения серьёзности: 🔴 высокая · 🟠 средняя · 🟡 низкая.

---

## 1. Краткая сводка (TL;DR)

**Сильные стороны.** Чёткое разделение процессов (Rust ↔ React), SQLite-индекс с ULID, атомарная запись файлов (temp+rename), блочный Notion-подобный редактор (slash-меню, block-handles) — это уже *за пределами* дефолтного Obsidian. Code-splitting вендоров настроен.

**Главные проблемы (по убыванию важности):**
1. 🔴 **Чрезмерные права файловой системы и asset-протокола** — приложение имеет рекурсивный доступ ко всему `$HOME`, `Desktop`, `Documents`, а `asset:`-протокол открыт на `**/*`. Кастомные команды `read_file`/`write_file` берут произвольный абсолютный путь без привязки к хранилищу.
2. 🔴 **Нет тулинга качества**: нет ESLint, Prettier, тест-раннера фронтенда, CI, pre-commit хуков, `cargo clippy`/`fmt`. Единственная защита — `tsc` и 12 Rust-тестов.
3. 🟠 **Мёртвый код и зависимости**: ~36 из 55 shadcn-компонентов и ~10 npm-пакетов не используются. Конфликт peer-deps (React 19 ↔ `@emoji-mart/react`) ломает `npm install` без `--legacy-peer-deps`.
4. 🟠 **`serde_yaml` заброшен** (архивирован автором) — нужен поддерживаемый аналог.
5. 🟠 **God-компоненты**: `workspace.tsx` (1654 стр.), `lib.rs` (1325 стр.), `panel-registry.tsx` (627 стр.).
6. 🟡 **Пробелы паритета с Obsidian**: нет daily notes, шаблонов, outline-панели, редактора свойств, тем, настроек-UI, локального графа, эмбедов `![[...]]`, экспорта.

---

## 2. Безопасность

### 2.1 🔴 Слишком широкий доступ к файловой системе

`src-tauri/capabilities/default.json`:
```json
"fs:scope-home-recursive",
"fs:scope-desktop-recursive",
"fs:scope-document-recursive"
```
Это даёт фронтенду (через плагин `fs`, используемый для `watch`) рекурсивный доступ ко **всему** домашнему каталогу, рабочему столу и документам. Если в webview попадёт XSS, атакующий читает/пишет почти любые пользовательские файлы.

**Рекомендация:** убрать статические `*-recursive` скоупы. Выдавать доступ **динамически** к выбранному хранилищу в момент открытия:
```rust
use tauri_plugin_fs::FsExt;
// после того как пользователь выбрал vault:
app.fs_scope().allow_directory(&vault_path, true)?;
```
Так `watch` продолжит работать, но только в пределах открытого vault.

### 2.2 🔴 Asset-протокол открыт на весь диск

`tauri.conf.json`:
```json
"assetProtocol": { "enable": true, "scope": ["**/*"] }
```
`asset://`/`https://asset.localhost` может загрузить **любой** файл на диске. Нужно для картинок-вложений, но скоуп должен быть ограничен. **Рекомендация:** сузить до подпапок хранилища (`**/assets/**`, либо динамический скоуп на vault, как в 2.1).

### 2.3 🔴 Команды с произвольным путём (path traversal / arbitrary FS)

В `lib.rs` команды принимают **сырой абсолютный путь** и не проверяют, что он внутри хранилища:
- `read_file(path)` ([lib.rs:797](src-tauri/src/lib.rs)), `write_file(path, content)` ([lib.rs:802](src-tauri/src/lib.rs))
- `create_file(path)`, `create_folder(path)`, `open_in_explorer(path)`, `import_asset(source_path)`

Кастомные команды **не подчиняются** скоупам плагина `fs` — у них полный доступ процесса. То есть это обходной путь мимо всех ограничений из 2.1/2.2.

**Рекомендация (defense-in-depth):** ввести единый guard и прогонять через него все пути:
```rust
fn confine(vault: &Path, candidate: &Path) -> Result<PathBuf, String> {
    let v = vault.canonicalize().map_err(|e| e.to_string())?;
    let c = candidate.canonicalize().map_err(|e| e.to_string())?;
    if c.starts_with(&v) { Ok(c) } else { Err("Path escapes vault".into()) }
}
```
Все FS-команды должны принимать `vault_path` + относительный/проверяемый путь и вызывать `confine` до любых операций. Это закрывает и XSS-вектор, и случайные баги.

### 2.4 🟠 Санитизация Markdown → HTML

Редактор поддерживает inline-HTML (`<span style=...>`, `<u>`) при раунд-трипе (`tiptap/markdown.ts`). Контент заметок — недоверенный (можно получить чужой vault). ProseMirror парсит в схему (не сырой `innerHTML`), что снижает риск, но проходящий HTML/`style` стоит явно валидировать (whitelisting тегов/атрибутов). **CSP уже хорошая** (`script-src 'self'`, `connect-src 'self'` — нет внешних/inline-скриптов), так что импакт XSS ограничен, но DOM-based проблемы возможны.

### 2.5 🟠 `serde_yaml` заброшен

`Cargo.toml`: `serde_yaml = "0.9"`. Крейт **архивирован** автором (больше не поддерживается, не получает фиксов). **Рекомендация:** мигрировать на поддерживаемый `serde_yaml_ng` или `serde_yml`. Парсинг frontmatter — единственное место использования (`frontmatter.rs`), миграция точечная.

### 2.6 🟡 Прочее

- `atomic_write` ([frontmatter.rs:100](src-tauri/src/frontmatter.rs)) использует фиксированное имя `*.amby-tmp` — при гонке двух записей в один файл возможна коллизия temp-файла. Дебаунс фронтенда это маскирует; для надёжности добавить уникальный суффикс (pid/rand).
- Нет `npm audit` / `cargo audit` в процессе — уязвимости транзитивных зависимостей не отслеживаются.

### Сводка безопасности

| # | Проблема | Серьёзность | Фикс |
|---|----------|-------------|------|
| 2.1 | Рекурсивный FS-скоуп на весь `$HOME` | 🔴 | Динамический скоуп на vault |
| 2.2 | `assetProtocol` = `**/*` | 🔴 | Сузить до vault/assets |
| 2.3 | Команды с произвольным путём | 🔴 | `confine()`-guard на все пути |
| 2.4 | HTML в Markdown без явной санитизации | 🟠 | Whitelist тегов/атрибутов |
| 2.5 | `serde_yaml` заброшен | 🟠 | → `serde_yaml_ng` |
| 2.6 | temp-коллизии, нет audit | 🟡 | Уникальный temp, `cargo/npm audit` в CI |

---

## 3. Зависимости: что лишнее, что добавить

### 3.1 Мёртвые npm-пакеты (0 импортов в коде приложения)

Проверено грепом по `src/` (исключая обёртки `src/components/ui/`):

| Пакет | Назначение | Статус |
|-------|-----------|--------|
| `embla-carousel-react` | карусель | ❌ не используется |
| `input-otp` | ввод OTP | ❌ |
| `react-day-picker` | календарь | ❌ |
| `react-hook-form` | формы | ❌ |
| `sonner` | тосты (есть свой `ui/toast`) | ❌ |
| `react-resizable-panels` | ресайз-панели (есть свой `ResizeHandle`) | ❌ |
| `recharts` | графики | ✅ уже удалён в этой сессии |
| `vaul` | drawer | ❌ (вероятно; перепроверить) |
| `@radix-ui/react-{accordion, aspect-ratio, avatar, hover-card, menubar, navigation-menu, progress, radio-group, slider}` | примитивы под неиспользуемые `ui/` | ❌ (их обёртки не импортируются) |

**Используются (оставить):** все `@codemirror/*`, `@tiptap/*`, `@emoji-mart/*` + `emoji-mart`, `@xyflow/react`, `d3-force`, `markdown-it`, `prosemirror-markdown`, `lucide-react`, `clsx`/`class-variance-authority`/`tailwind-merge`, `cmdk` (1 импорт), `next-themes` (1 импорт), а также radix-примитивы под живые обёртки (`dialog, dropdown-menu, context-menu, tooltip, popover, scroll-area, collapsible, separator, label, toast, toggle, slot`).

### 3.2 Мёртвые shadcn-компоненты

**~36 из 55** файлов в `src/components/ui/` не импортируются кодом приложения (используются только ~19: `button, dialog, separator, context-menu, input, dropdown-menu, toast, label, tooltip, toggle, textarea, skeleton, sheet, scroll-area, popover, command, collapsible` + хуки `use-toast`, `use-mobile`). Остальные (`accordion, alert, alert-dialog, aspect-ratio, avatar, badge, breadcrumb, calendar, card, carousel, checkbox, drawer, empty, field, form, hover-card, input-otp, kbd, menubar, navigation-menu, pagination, progress, radio-group, resizable, select, sidebar, sonner, spinner, switch, table, tabs, toggle-group, …`) — мёртвый scaffolding из shadcn-инициализации.

> ⚠️ Vite **tree-shake'ит** их из бандла, так что на рантайм влияние ~0. Польза удаления — чистота исходников, скорость `tsc`, меньше поверхность для багов/уязвимостей.

**Рекомендация:** не удалять вручную (легко ошибиться), а прогнать инструмент:
```bash
npx knip            # покажет неиспользуемые файлы, экспорты и зависимости
# или: npx depcheck  # только зависимости
```
и удалить по отчёту. Затем зафиксировать `knip` в CI как защиту от повторного накопления.

### 3.3 🟠 Конфликт peer-dependencies

`npm install`/`npm uninstall` падает: `@emoji-mart/react@^1.1.1` требует React 16–18, а проект на **React 19**. Сейчас дерево держится только на `--legacy-peer-deps`. **Рекомендация:** добавить в `package.json`:
```json
"overrides": { "@emoji-mart/react": { "react": "$react", "react-dom": "$react-dom" } }
```
либо перейти на поддерживающий React 19 пикер эмодзи (`frimousse`, или собственный лёгкий пикер). Это уберёт хрупкость установки.

### 3.4 Что стоит добавить

| Пакет / технология | Зачем |
|--------------------|-------|
| `@tanstack/react-virtual` | виртуализация дерева и больших списков (для больших хранилищ) |
| `zustand` (или `jotai`) | заменить 20+ `useState` + ref-хаки в `workspace.tsx` на нормальный store |
| `tauri-specta` + `specta` | автогенерация TS-типов из Rust-команд → типобезопасный IPC вместо ручных интерфейсов в `storage.ts` |
| `notify` (Rust) | нативный файловый watcher в бэкенде + инкрементальное обновление индекса (вместо фронтового `watch` → полный reload) |
| `r2d2` + `r2d2_sqlite` | пул соединений SQLite вместо `open_connection` на каждый вызов |
| `vitest` + `@testing-library/react` | юнит-тесты фронтенда (сейчас 0) |
| `serde_yaml_ng` | замена заброшенному `serde_yaml` |

---

## 4. Архитектура: как пересобрать для оптимизации

### 4.1 Фронтенд

1. **Разбить god-компонент `workspace.tsx` (1654 стр.).** Вынести в хуки:
   - `useVault()` — открытие/переключение/список хранилищ, restore из localStorage.
   - `useDocuments()` — `openDocs`, загрузка, автосейв, unsaved-трекинг.
   - `useTabs()` — вкладки, история, навигация back/forward.
   - `useActivityBar()` — кнопки активити-бара, DnD, активные панели.
   - `useLinkGraph()` — построение/обновление графа.
   `Workspace` остаётся тонким оркестратором.
2. **Ввести store (Zustand).** Сейчас состояние размазано по ~20 `useState` + `openDocsRef`/`saveTimerRef` (ref-хаки для стабилизации замыканий — признак протечки модели). Store уберёт prop-drilling (`panelRenderProps` тащит 18+ полей) и ref-костыли.
3. **Разнести `panel-registry.tsx` (627 стр.)** по файлу на панель: `panels/files.tsx`, `tags.tsx`, `favorites.tsx`, `info.tsx`, `links.tsx`.
4. **Ленивая загрузка тяжёлых редакторов.** Вендоры уже в отдельных чанках, но импортируются статически. Обернуть в `React.lazy` + `Suspense`: `CanvasEditor` (@xyflow), `GraphTabView` (d3), `SourceEditor` (CodeMirror). Это снизит первоначальный JS (сейчас основной чанк `index.js` ~851 КБ).
5. **Типобезопасный IPC.** Ручные интерфейсы в `storage.ts` дублируют Rust-структуры и расходятся при изменениях. `tauri-specta` генерирует типы и клиент из Rust.

### 4.2 Бэкенд

1. **Разбить `lib.rs` (1325 стр.)** на модули команд: `commands/vault.rs`, `commands/fs_ops.rs`, `commands/assets.rs`, `commands/layers.rs`. `vault_index.rs` оставить.
2. **Модуль безопасности путей** (`paths.rs`) с `confine()` (см. [2.3](#23--команды-с-произвольным-путём-path-traversal--arbitrary-fs)) — единая точка валидации.
3. **Нативный watcher (`notify`)** в Rust: при изменении файла обновлять только его запись в индексе (`upsert_note_index`) и слать событие во фронтенд, вместо текущей схемы «фронтовый `watch` → полный `load_vault`».
4. **Пул соединений SQLite** (`r2d2_sqlite`): сейчас `open_connection()` открывает новое соединение + прогоняет PRAGMA на каждый вызов. Пул уберёт оверхед, особенно с возросшей конкуренцией (после перевода команд в `async`).
5. **Кеш парсинга:** уже сделана инкрементальная индексация по mtime (см. §8); следующий шаг — отдавать дерево из БД без повторного `scan_tree_dir` по диску в `build_tree`.

### 4.3 Бандл/сборка

- `index.js` ~851 КБ (gzip 278 КБ) — после ленивой загрузки (4.1.4) уменьшится.
- Включить `build.chunkSizeWarningLimit` осознанно и/или добавить визуализатор (`rollup-plugin-visualizer`) в dev для контроля.

---

## 5. Паритет с Obsidian: чего не хватает

### 5.1 Что уже есть (часто — на уровне Obsidian или лучше)

| Возможность | Статус |
|-------------|--------|
| Live + Source режимы Markdown | ✅ Tiptap + CodeMirror |
| Wiki-ссылки `[[...]]`, клик, авто-создание | ✅ |
| Бэклинки (счётчик/панель) | ✅ базово (`InfoPanel`/`LinksPanel`) |
| Теги + панель тегов | ✅ |
| Глобальный граф связей | ✅ (d3-force) |
| Canvas (формат Obsidian Canvas JSON) | ✅ (@xyflow) |
| Поиск по имени/контенту | ✅ базово |
| Быстрое открытие (quick switcher) | ✅ `QuickOpenModal` |
| Избранное/закладки | ✅ |
| Блочный редактор (slash-меню, drag-handles) | ✅ **лучше дефолта Obsidian** |
| Callouts `> [!NOTE]` | ✅ |
| Вложения (drag&drop, вставка картинок) | ✅ |
| Слои заметки (canvas/database/sketch) | 🟡 концепт **за пределами** Obsidian (canvas готов, db/sketch — заглушки) |

### 5.2 Чего не хватает до «полного Obsidian»

| Возможность | Приоритет | Заметка |
|-------------|-----------|---------|
| **Трансклюзия заметок** `![[note]]` | 🔴 | в slash-меню есть блоки категории `embed` (медиа), но Obsidian-стиль встраивания заметок не подтверждён — вероятно отсутствует |
| **Ссылки на заголовки/блоки** `[[note#h]]`, `[[note^id]]` | 🔴 | `normalize` отбрасывает `#` — резолва нет |
| **Outline-панель** (заголовки документа) | 🟠 | стандартная панель Obsidian |
| **Редактор свойств** (frontmatter UI) | 🟠 | сейчас frontmatter только хранит `id` |
| **Daily Notes** | 🟠 | ядро рабочих процессов Obsidian |
| **Шаблоны (Templates)** | 🟠 | вставка шаблонов в новые заметки |
| **Командная палитра** (полная, со всеми командами + хоткеи) | 🟠 | сейчас только quick-open/search |
| **Настройки-UI** | 🟠 | сейчас настройки в localStorage без экрана настроек |
| **Темы / кастомный CSS** | 🟠 | инфраструктура есть (`theme-provider.tsx` на `next-themes`), но приложение тёмное без UI переключения тем |
| **Локальный граф** (вокруг текущей заметки) | 🟡 | есть только глобальный |
| **Несвязанные упоминания** (unlinked mentions) | 🟡 | |
| **Экспорт (PDF/HTML)** | 🟡 | |
| **История версий** | 🟡 | |
| **Сплит-вью / несколько панелей редактора** | 🟡 | есть вкладки, но не произвольный сплит |
| **Синхронизация** (git-/файловая) | 🟡 | |
| **Мобильная версия** | 🟡 | Tauri mobile возможен, но не настроен |
| **Плагины / API расширений** | 🟡 | главный «moat» Obsidian; «лучше Obsidian» = либо мощные встроенные фичи, либо своя система расширений |

### 5.3 «Лучше, чем Obsidian»

Дифференциаторы, на которые стоит делать ставку (они уже частично есть):
- **Блочный редактор Notion-стиля** поверх Markdown-файлов (Obsidian этого не даёт из коробки).
- **Слои заметки** (canvas/database/sketch рядом с `.md`) — доделать database (таблица/представления) и sketch (Excalidraw).
- **Нативная скорость** (Rust + SQLite-индекс) — уже заложено; добить инкрементальностью и нативным watcher’ом.

---

## 6. Тулинг, CI и проверки

> Это ответ на вопрос про **CLAUDE.md** и «как добавить проверки».

### 6.1 Что есть и чего нет

| Проверка | Сейчас |
|----------|--------|
| TypeScript typecheck | ✅ `tsc` (в `npm run build`) |
| Rust компиляция | ✅ `cargo check` |
| Rust тесты | ✅ 12 тестов |
| ESLint | ❌ нет |
| Prettier | ❌ нет (CLAUDE.md прямо говорит «match surrounding style») |
| Тесты фронтенда | ❌ нет (нет `npm test`) |
| `cargo clippy` / `cargo fmt` | ❌ нет |
| CI (GitHub Actions) | ❌ нет `.github/` |
| Pre-commit хуки | ❌ нет |
| `npm audit` / `cargo audit` | ❌ нет |

### 6.2 Что добавить

1. **ESLint + Prettier** (flat config, `typescript-eslint`, `eslint-plugin-react-hooks`). Скрипты:
   ```jsonc
   "lint": "eslint .",
   "format": "prettier --write .",
   "format:check": "prettier --check ."
   ```
   В коде много `// eslint-disable-next-line react-hooks/exhaustive-deps` — линтер сделает эти решения явными и контролируемыми.
2. **Vitest** для фронтенда: начать с чистых утилит (`extractWikiLinks`, `buildLinkGraph`, markdown round-trip `markdownToDoc`/`docToMarkdown`).
3. **Rust:** `cargo clippy -- -D warnings` и `cargo fmt --check`.
4. **CI (`.github/workflows/ci.yml`)** на push/PR:
   ```yaml
   jobs:
     frontend: { steps: [ npm ci, npm run lint, npm run format:check, tsc --noEmit, vitest run, npm run build ] }
     rust:     { steps: [ cargo fmt --check, cargo clippy -D warnings, cargo test ] }
   ```
   Учесть `--legacy-peer-deps` (или fix из [3.3](#33--конфликт-peer-dependencies)) для `npm ci`.
5. **Pre-commit** (`lefthook` или `husky`+`lint-staged`): `prettier`/`eslint` по staged-файлам, `cargo fmt`.
6. **Аудит зависимостей:** `npm audit` + `cargo audit` (через `actions` или локально), `knip` против мёртвого кода.

### 6.3 Что дописать в CLAUDE.md

Добавить раздел «Quality gates», чтобы агент/разработчик гонял проверки перед «готово»:
```md
## Quality gates (run before claiming work done)
- Frontend: `npm run lint && npm run format:check && npm run build` (build = tsc + vite)
- Frontend tests: `npm run test` (vitest)
- Rust: `cd src-tauri && cargo fmt --check && cargo clippy -- -D warnings && cargo test`
- Security-sensitive change to FS/commands/capabilities: вручную проверить confine() и скоупы;
  собрать `npm run tauri dev` и проверить и десктоп-путь, и браузерный fallback.
```
Также стоит занести в CLAUDE.md решённые в этой сессии инварианты: «sync инкрементальный по mtime», «`resolve_links` авторитетный (clear-then-resolve)», «тяжёлые команды — `async` + `spawn_blocking`».

---

## 7. Приоритетная дорожная карта

**Этап A — Безопасность (сначала).**
1. Динамический FS-скоуп на vault, сузить `assetProtocol` (2.1, 2.2).
2. `confine()`-guard на все path-команды (2.3).
3. Миграция с `serde_yaml` (2.5), санитизация HTML (2.4).

**Этап B — Тулинг/CI.**
4. ESLint + Prettier + Vitest + clippy/fmt.
5. GitHub Actions CI + pre-commit; обновить CLAUDE.md (§6.3).
6. `knip`/`depcheck` → удалить мёртвые пакеты и `ui/`-компоненты; fix peer-deps (3.3).

**Этап C — Архитектура.**
7. Zustand-store + разбиение `workspace.tsx` на хуки.
8. `tauri-specta` (типобезопасный IPC), разбить `lib.rs`.
9. Нативный watcher (`notify`) + пул соединений; ленивые редакторы.
10. Виртуализация дерева (`@tanstack/react-virtual`).

**Этап D — Паритет с Obsidian.**
11. Эмбеды/трансклюзия + ссылки на заголовки/блоки.
12. Outline-панель, редактор свойств, командная палитра, настройки-UI.
13. Daily notes, шаблоны, темы; локальный граф.
14. Доделать слои database/sketch (дифференциатор).

---

## 8. Что уже сделано в этой сессии

Эти пункты из плана оптимизации **уже реализованы и проверены** (`cargo test` — 12 тестов; `npm run build`):

- **Бэкенд:** инкрементальная индексация по mtime; `resolve_links` вне горячего пути автосейва + авторитетный clear-then-resolve; `list_tags` одним JOIN; тяжёлые команды `async` + WAL/`busy_timeout`.
- **Фронтенд:** дебаунс сериализации Markdown (200 мс, с flush на blur/unmount); устранён каскад перерисовок при наборе (мемоизация `displayTreeItems`/`currentProperties`); rAF для ресайз-хэндлов; LOD-куллинг подписей графа; **удалён `recharts`**.

Не сделано осознанно (требует запущенного приложения для проверки): виртуализация дерева, оптимистичные мутации. Подробнее — в истории сессии и плане `~/.claude/plans/`.
