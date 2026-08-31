# Amby — Roadmap стабилизации архитектуры перед 1.0

## Текущее состояние и передача в следующий чат — 2026-08-31

**Фазы 0–7 реализованы. Фаза 7 добавляет headless desktop reliability suite;
нативный UI-driver остаётся отдельным release-gate для Windows/Linux.**
Исходные описания проблем ниже оставлены как контекст; актуальные результаты
отмечены в этом разделе и под заголовками фаз. Подробная история реализации и
проверок: [docs/roadmap-progress.md](docs/roadmap-progress.md).

| Фаза                     | Состояние                           | Результат                                                                                                                                                 |
| ------------------------ | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0 — Baseline             | Выполнена                           | Зафиксированы ветка, исходные проверки и карта модулей.                                                                                                   |
| 1 — Identity             | Реализована                         | `amby-id`, совместимость legacy IDs, миграция v2 с восстановлением v1, диагностика конфликтов без скрытия заметок.                                        |
| 2 — Lossless insertion   | Реализована                         | Вставка одной строки без сериализации YAML; сохранены комментарии, BOM и окончания строк. Выполнялась перед фазой 1 как необходимая основа.               |
| 3 — Incremental indexing | Реализована                         | `mtime_ns`, безопасное обновление кэша SQLite, перечитывание затронутых watcher-файлов даже при одинаковых metadata.                                      |
| 4 — Malformed YAML       | Реализована                         | Текст остаётся в дереве/поиске и редактируется; свойства отключены; незакрытый frontmatter открывается целиком в Source.                                  |
| 5 — Search ranking       | Реализована                         | BM25 возвращается из SQL и остаётся основой итогового score; title bonuses лишь корректируют relevance.                                                   |
| 6 — Query tokenization   | Реализована                         | Единый Unicode-токенайзер разделяет пунктуацию, сохраняет `_` в идентификаторах и не пропускает FTS-синтаксис пользователя.                               |
| 7 — Desktop E2E          | Реализована                         | Headless suite использует временный vault, backend lifecycle, SQLite, atomic writes и watcher invalidation; есть отдельный large-vault regression signal. |
| 8–13                     | Не выполнены в рамках этого roadmap | Storage contracts, security, cleanup и release gates остаются отдельными задачами. Нативный UI-driver на Windows/Linux остаётся частью release-проверки.  |

### Состояние рабочей копии

- Проект: `/Users/paul/Codding/amby-notes`.
- Ветка: `dev`; HEAD: `1d3f0d6213d41ce0dea88266c98ef914c2d34875`.
- Реализация находится в **незакоммиченных изменениях и новых файлах** этой
  рабочей папки. Коммиты и PR для этапов не создавались. При продолжении из
  чистого checkout/worktree эти изменения нужно сначала перенести.
- До roadmap уже были изменения workspace/history/navigation, тестов и audit/release
  документов. Не сбрасывать их и не считать весь `git diff` результатом roadmap.
  Перед продолжением проверить актуальный `git status` и инструкции `AGENTS.md`.
- Этот файл первоначально скопирован с Desktop без изменений; теперь, по запросу
  пользователя, ведётся как актуальный roadmap. Файл-источник на Desktop не менялся.

### Принятые решения, которые важно сохранить

- Generic `id` остаётся пользовательским. Канонический ULID в нём без `amby-id`
  читается как legacy-кандидат; один формат ULID не доказывает происхождение ID.
  Копирование в `amby-id` выполняется только подтверждённой миграцией с backup,
  журналом и rollback. Новые ID записываются только в `amby-id`.
- `amby-conflict:` — ключи кэша для конфликтов ID: текст виден, небезопасные
  записи и изменения свойств заблокированы. `amby-opaque:body:` и
  `amby-opaque:source:` — отдельные ключи по пути для повреждённого YAML: текст
  редактируется, durable properties недоступны. Эти ключи никогда не пишутся в YAML.
- У закрытого повреждённого frontmatter body-save сохраняет весь YAML envelope
  побайтно. Без закрывающего разделителя доступно явное редактирование полного
  Source; автоматического исправления нет. После исправления YAML нужно сохранить,
  обновить хранилище и заново открыть вкладку. Ключи по пути не гарантируют
  стабильную идентичность после перемещения/исправления.
- `mtime_ns` используется для кэша; даты UI/IPC по-прежнему в секундах. Отдельный
  persistent content hash не добавлен: watcher заставляет перечитывать content,
  а собственные записи сверяются существующим fingerprint. Cold scan может
  пропустить изменение, сделанное при выключенном watcher с восстановлением
  **точного** mtime и размера — это известное ограничение.
- Ошибка чтения/UTF-8 отменяет скан без удаления записей индекса и сохраняет
  события для retry. Предупреждение о YAML не мешает успешной индексации и
  подтверждению обработанных событий.
- Контракты: [vault-format.md](docs/vault-format.md) и
  [markdown-compatibility.md](docs/markdown-compatibility.md).

### Последняя проверка реализации

- TypeScript, ESLint, Prettier, Knip, Rustfmt и strict Clippy прошли.
- После PHASE 5 прошли TypeScript, ESLint, Prettier, Knip, Rustfmt и strict
  Clippy; прошли 407 frontend-тестов в 65 файлах и все шесть тестов
  `index::query`.
- Полный `npm run verify:full` дошёл до Rust-тестов: 184 из 185 прошли, а
  `incremental_native_watcher_refreshes_search_tags_and_links_with_identical_metadata`
  завершился timeout, потому что sandbox не доставил файловое событие. Это
  известное ограничение окружения и не связано с ranking.
- После PHASE 6 и исправления watcher-теста прошли Rustfmt, strict Clippy и
  полный `npm run rust:test`: 189 из 189 тестов. Интеграционный тест использует
  content-aware `PollWatcher`, поскольку нативный notify backend не доставляет
  события из sandbox; production watcher остаётся нативным.
- Настоящий macOS watcher проверен на временном vault, включая одинаковые mtime
  и размер. В sandbox системные события не приходили; интеграционный тест и
  полный Rust-набор прошли вне sandbox.
- Browser smoke реальных DocumentEditor/InfoPanel прошёл: редактируемый body,
  принудительный Source, отключённые свойства, сохранённая блокировка ID-конфликтов.
  Временный стенд удалён, dev server остановлен.
- Native Tauri UI-driver, Windows/Linux и remote CI не подтверждены. Новый
  headless suite проверяет реальный desktop backend и filesystem, но не заменяет
  платформенную проверку WebView/UI.
  Пользовательское хранилище не открывалось и не мигрировалось; разрешения Tauri
  не расширялись. Release gates ниже не считать выполненными автоматически.

### С чего начать в следующем чате

1. Прочитать этот статус, `docs/roadmap-progress.md` и текущие инструкции проекта;
   проверить, что доступны незакоммиченные изменения фаз 0–5.
2. Перейти к PHASE 8: определить contract tests для desktop и browser storage.
3. Не повторять реализацию фаз 1–6. Сохранить новые регрессии в
   `src-tauri/src/index/{identity_tests,incremental_tests,malformed_tests}.rs`
   и `src/components/workspace/editor/note-editing-policy.test.ts`.

---

## Цель

Довести текущую архитектуру Amby до состояния, в котором приложение безопасно работает с существующими Markdown vault без потери данных, корректно сосуществует с Obsidian и другими редакторами, надёжно индексирует внешние изменения и имеет достаточное desktop-level тестирование перед дальнейшим развитием Collections, AI, Git и Canvas.

Главный принцип на всём протяжении работ:

> Markdown-файлы остаются единственным source of truth. SQLite является только производным и полностью восстанавливаемым индексом.

Не менять этот принцип без отдельного архитектурного решения.

---

# Общие правила выполнения

Перед каждым этапом:

1. Изучить связанные существующие тесты.
2. Не удалять текущие проверки ради упрощения реализации.
3. Сначала добавить regression test, который воспроизводит проблему.
4. Затем внести минимально необходимое исправление.
5. После изменения прогнать релевантные unit/integration tests.
6. В конце этапа прогнать полный `verify:full`.
7. Не проводить крупный unrelated refactoring одновременно с correctness fix.
8. Не менять публичное поведение приложения вне явно указанной задачи.
9. Любая операция над пользовательским Markdown должна по возможности быть lossless.
10. Unsupported или неизвестный пользовательский контент нельзя молча удалять или нормализовать.

---

# PHASE 0 — Baseline и фиксация текущего состояния

**Статус: выполнена.** Baseline и карта модулей записаны в `docs/roadmap-progress.md`.

## Цель

Получить воспроизводимую отправную точку перед архитектурными изменениями.

## Задачи

### 0.1. Проверить текущую ветку

Работать от актуальной `dev`.

Убедиться, что локальная ветка синхронизирована с remote.

### 0.2. Запустить полный verification pipeline

Запустить:

```bash
npm run verify:full
```

Зафиксировать все уже существующие ошибки отдельно.

Не смешивать pre-existing failures с регрессиями следующих этапов.

### 0.3. Составить карту затрагиваемых модулей

В первую очередь изучить:

```text
src-tauri/src/frontmatter.rs
src-tauri/src/index/
src-tauri/src/vault/
src-tauri/src/paths.rs
src-tauri/src/watcher.rs
src-tauri/src/history.rs
src-tauri/src/recovery.rs

src/components/workspace/
src/components/workspace/autosave/
src/components/workspace/tiptap/
```

Также найти все места использования поля:

```yaml
id:
```

для идентификации заметки.

## Definition of Done

- `verify:full` выполнен.
- Pre-existing failures записаны.
- Найдены все места чтения/записи Amby note ID.
- Изменений поведения пока нет.

---

# PHASE 1 — Исправить identity model заметок

**Статус: реализована.** Namespaced identity, legacy migration/recovery и конфликтные ID покрыты регрессиями; см. актуальный статус в начале файла.

## Приоритет

P0 / P1

## Проблема

Amby использует generic YAML property:

```yaml
id: 01...
```

в качестве внутреннего идентификатора заметки.

Но `id` является слишком общим пользовательским полем.

Существующий vault вполне может содержать:

```yaml
id: jira-123
```

или:

```yaml
id: article-42
```

Такой Markdown не должен становиться несовместимым с Amby.

## Целевое поведение

Использовать отдельное namespaced-поле:

```yaml
amby-id: 01...
```

Generic:

```yaml
id:
```

должно полностью принадлежать пользователю.

Amby не должен:

- интерпретировать его как собственный ID;
- переписывать его;
- удалять его;
- отказываться индексировать заметку из-за его значения.

## 1.1. Ввести новую константу internal ID

Вынести название поля в одно место:

```rust
const AMBY_ID_FIELD: &str = "amby-id";
```

Не оставлять строковые `"amby-id"` по всему backend.

## 1.2. Обновить frontmatter parsing

Изменить определение Amby identity:

```yaml
amby-id: <canonical ULID>
```

валидный ID.

Все остальные варианты:

```yaml
id: ...
amby-id: invalid
```

обрабатывать отдельно.

Generic `id` полностью игнорировать в identity layer.

## 1.3. Добавить migration старого формата

Существующие Amby vault могут содержать:

```yaml
id: <canonical Amby ULID>
```

Нужна безопасная миграция.

### Правило

Если:

```yaml
id:
```

содержит canonical ULID старого Amby-формата и `amby-id` отсутствует:

можно считать его legacy Amby identity.

Но миграция должна быть максимально осторожной.

Необходимо проверить историю проекта и существующие fixtures, чтобы уменьшить риск принятия чужого ULID за Amby ID.

Предпочтительный вариант:

```text
legacy id обнаружен
→ индексировать как Amby identity
→ при следующей безопасной mutation/snapshot мигрировать к amby-id
```

Не обязательно массово переписывать весь vault при первом открытии.

## 1.4. Обработать конфликт

Если существуют одновременно:

```yaml
id: external-value
amby-id: 01...
```

Amby использует только `amby-id`.

Если:

```yaml
amby-id: invalid-value
```

не уничтожать note и не переписывать поле молча.

Вернуть диагностический статус.

## 1.5. Исправить duplicate ID behavior

Если две заметки имеют одинаковый:

```yaml
amby-id:
```

не терять ни одну заметку полностью из пользовательского интерфейса.

Допустимое поведение:

```text
note indexed with conflict state
identityConflict = duplicate
```

и ограничить только операции, требующие уникального identity.

Минимум — убедиться, что пользователь всё ещё может найти и открыть обе заметки.

## 1.6. Добавить тесты

Обязательные cases:

```yaml
id: jira-123
```

→ note индексируется.

```yaml
id: 01VALIDULID...
```

→ проверить legacy migration behavior.

```yaml
amby-id: 01VALIDULID...
```

→ нормальная заметка.

```yaml
id: foo
amby-id: 01VALIDULID...
```

→ Amby использует `amby-id`.

```yaml
amby-id: broken
```

→ graceful warning, без потери note.

Duplicate `amby-id`:

→ никакого silent deletion.

## Definition of Done

- Generic `id` полностью принадлежит пользователю.
- Новые заметки получают `amby-id`.
- Старые Amby заметки продолжают открываться.
- Existing external `id` не мешает indexing/search.
- Есть regression tests.

---

# PHASE 2 — Сделать вставку Amby ID действительно lossless

**Статус: реализована.** YAML не пересериализуется; сохранение исходных байтов и отказ от небезопасной вставки проверены тестами.

## Приоритет

P1

## Проблема

Текущая первая вставка ID использует:

```rust
serde_yaml parse
→ Mapping
→ serialize
```

Это потенциально меняет пользовательский YAML.

Могут изменяться:

- комментарии;
- кавычки;
- whitespace;
- blank lines;
- formatting;
- некоторые YAML representation details.

Это конфликтует с preservation model проекта.

## 2.1. Запретить YAML reserialization для ID insertion

При наличии корректного YAML mapping:

```yaml
---
title: Test
# user comment
tags: [one, two]
---
```

Amby должен вставить:

```yaml
amby-id: ...
```

не сериализуя остальные свойства.

Пример результата:

```yaml
---
amby-id: 01...
title: Test
# user comment
tags: [one, two]
---
```

Весь старый YAML кроме добавленной строки должен оставаться byte-for-byte идентичным.

## 2.2. Сохранять line ending

Если файл использует:

```text
CRLF
```

вставленная строка тоже должна использовать CRLF.

Если LF — LF.

## 2.3. Сохранять BOM

UTF-8 BOM не должен исчезать.

## 2.4. Не нормализовать delimiters

Frontmatter envelope:

```text
---
...
---
```

не должен перестраиваться без необходимости.

## 2.5. Создавать frontmatter корректно

Если frontmatter отсутствует:

```markdown
# Hello
```

добавить:

```yaml
---
amby-id: ...
---
```

и затем исходный body.

Не менять сам body.

## 2.6. Malformed YAML не чинить автоматически

Если frontmatter существует, но невалиден:

```yaml
---
tags: [one,
---
```

Amby не должен автоматически переписывать его через serializer.

Вернуть диагностический результат.

## 2.7. Tests

Добавить byte-level tests.

Особенно:

```yaml
# comments
'quoted values'
"double quoted"
inline: [a, b]
nested:
  value: 1
```

Проверять, что старый substring сохраняется в точности.

Отдельно:

- LF;
- CRLF;
- BOM;
- empty frontmatter;
- no frontmatter;
- comments before first property;
- comments after property.

## Definition of Done

Любая вставка `amby-id` либо:

1. сохраняет существующий frontmatter losslessly;
2. либо ничего не меняет и возвращает понятную ошибку.

---

# PHASE 3 — Исправить точность incremental indexing

**Статус: реализована.** Добавлены `mtime_ns` и watcher invalidation. Отдельный persistent hash рассмотрен и не потребовался; ограничения cold scan указаны в начале файла.

## Приоритет

P0 / P1

## Проблема

Сейчас unchanged detection основан на:

```text
mtime в секундах
+
size
```

Это допускает false negative.

Два изменения файла в одну секунду при сохранении размера могут остаться незамеченными.

## 3.1. Перейти на high-resolution file timestamp

Не использовать:

```rust
as_secs()
```

Хранить более точную величину.

Предпочтительно nanoseconds:

```text
mtime_ns
```

Если целевая platform/filesystem не гарантирует ns precision, всё равно хранить максимально доступную точность.

## 3.2. Обновить SQLite schema

Добавить новую metadata representation.

При необходимости создать migration.

Не ломать существующую базу.

Помнить:

> SQLite является disposable index.

Поэтому допустима простая migration/rebuild стратегия, если она безопаснее сложной migration.

## 3.3. Рассмотреть content fingerprint

Добавить дешёвый content hash.

Предпочтительно:

- BLAKE3;
- xxHash;
- другой быстрый non-cryptographic fingerprint.

Не использовать SHA-256 без необходимости.

## 3.4. Разделить cold scan и watcher-triggered scan

Рекомендуемая стратегия:

### Cold startup

```text
metadata unchanged
→ быстрый skip
```

### Watcher сообщил modification

Даже при совпавших metadata:

```text
→ перепроверить fingerprint/content
```

Так сохраняется производительность.

## 3.5. Добавить тест exact bug

Создать fixture:

```text
old content = "cat"
new content = "dog"
```

Одинаковый размер.

Имитировать одинаковый coarse timestamp.

Индекс должен обнаружить изменение.

## 3.6. Проверить external editor workflow

Scenario:

```text
Amby открыт
↓
Obsidian меняет note
↓
watcher event
↓
index refresh
↓
search/backlinks/tags отражают новое состояние
```

## Definition of Done

Нельзя получить stale SQLite state только из-за:

```text
same second + same size
```

---

# PHASE 4 — Malformed frontmatter должен деградировать gracefully

**Статус: реализована.** Заметки остаются видимыми и редактируемыми, YAML не исправляется автоматически. Незакрытый envelope редактируется как полный Source.

## Приоритет

P1 / P2

## Проблема

Невалидный YAML сейчас может привести к исключению всей note из индекса.

Это слишком сильная реакция.

Markdown body может быть полностью валиден.

## 4.1. Ввести статус frontmatter

Например:

```rust
enum FrontmatterStatus {
    None,
    Valid,
    Invalid,
}
```

или эквивалентная модель.

## 4.2. Разделить body и properties parsing

При malformed YAML всё равно индексировать:

- path;
- filename;
- title fallback;
- Markdown body;
- body tags;
- wiki links;
- word count;
- search text.

Не индексировать только свойства, которые требуют валидного YAML.

## 4.3. UI warning

Если note имеет malformed frontmatter:

показать ненавязчивое предупреждение.

Пример:

```text
Invalid YAML frontmatter.
The note is still readable, but properties editing is disabled.
```

Не блокировать редактирование Markdown body.

## 4.4. Не исправлять YAML автоматически

Пользовательский YAML должен оставаться untouched.

## 4.5. Tests

Проверить:

- broken list;
- broken indentation;
- root scalar;
- root array;
- missing closing delimiter;
- valid body после malformed YAML.

Search должен находить body.

## Definition of Done

Malformed YAML больше не делает Markdown invisible для Amby.

---

# PHASE 5 — Улучшить search ranking

**Статус: реализована.** Точка входа — `src-tauri/src/index/query.rs::search_notes`.

## Приоритет

P2

## Проблема

SQLite FTS уже рассчитывает BM25, но Rust-level ranking затем почти полностью заменяет его грубым score.

В результате content matches становятся преимущественно alphabetical.

## Реализация

- SQL возвращает `bm25(notes_fts) AS rank`; Rust преобразует отрицательный FTS5
  rank в сохраняющий направление integer `SearchResult.score` без изменения IPC.
- Exact title, title-prefix и title-contains получают bounded bonus к score.
  Итоговая сортировка остаётся по combined relevance, с path как
  детерминированным tie-breaker.
- Добавлены fixtures для `Apple`, `Apple pie`, `Cooking`, `Fruit`, `Random`, а
  также русского, украинского, emoji и mixed English/русский текста.

## 5.1. Возвращать BM25 rank из SQL

Пример:

```sql
SELECT
    ...,
    bm25(notes_fts) AS rank
```

## 5.2. Не уничтожать FTS relevance

Финальный ranking должен учитывать BM25.

Добавить bonuses:

```text
exact title match
title starts with query
title contains query
```

Но они должны модифицировать relevance, а не полностью её заменять.

## 5.3. Создать ranking fixtures

Набор заметок:

```text
Apple
Apple pie
Cooking
Fruit
Random
```

Запрос:

```text
apple
```

Проверить ожидаемый порядок.

## 5.4. Проверить кириллицу

Обязательно:

```text
русский
український
emoji 🔥
mixed English/русский
```

---

# PHASE 6 — Исправить query tokenization

## Приоритет

P2

## Проблема

Символы punctuation сейчас могут просто удаляться.

Например:

```text
foo-bar
```

может превращаться в:

```text
foobar
```

вместо двух токенов.

## 6.1. Сделать единый tokenizer

Не просто:

```rust
filter(is_alphanumeric)
```

а разбивать query на meaningful tokens.

Примеры:

```text
foo-bar → foo, bar
foo/bar → foo, bar
hello.world → hello, world
```

## 6.2. Определить поведение специальных запросов

Проверить:

```text
C++
C#
node.js
file-name
foo/bar
snake_case
```

Не обязательно поддерживать каждый случай идеально, но поведение должно быть осознанным и протестированным.

## 6.3. Не допускать FTS syntax injection/error

Вход пользователя не должен напрямую становиться произвольным FTS expression.

## Definition of Done

Search query normalization имеет отдельные unit tests и одинаково работает с Unicode.

---

# PHASE 7 — Desktop E2E reliability suite

## Приоритет

P1 / P2

## Цель

Проверять реальные cross-layer сценарии:

```text
React
→ Tauri IPC
→ Rust
→ filesystem
→ watcher
→ index
→ frontend
```

Browser localStorage fallback не считается полноценной заменой этих тестов.

## 7.1. Создать небольшой E2E framework

Не строить огромную инфраструктуру.

Нужны smoke/integration tests для самых опасных flows.

## 7.2. Обязательные сценарии

### Save lifecycle

```text
edit
→ autosave
→ close
→ reopen
→ content preserved
```

### Rename during autosave

```text
edit
→ save in-flight
→ rename
→ final content only in correct file
```

### Vault switching

```text
dirty note
→ switch vault
→ correct flush/persist behavior
```

### External edit

```text
Amby open
→ external process modifies file
→ watcher
→ index/UI update
```

### External delete

UI корректно реагирует.

### External rename

Нет phantom old file.

### Unsupported Markdown

```text
open
→ edit supported region
→ save
```

unsupported block остаётся lossless.

### CRLF + BOM

Roundtrip без нормализации.

### Malformed YAML

Body доступен.

### Duplicate `amby-id`

Нет потери файлов.

### External `id`

```yaml
id: jira-123
```

полностью сохраняется.

### Crash/interrupted write

Проверить recovery/history guarantees там, где возможно.

## 7.3. Large vault smoke test

Создать synthetic vault:

```text
1k notes
5k notes
10k notes
```

Измерить:

- initial scan;
- reopen;
- one-file update;
- search latency.

Это пока не performance benchmark gate, а regression signal.

## Definition of Done

Критические user flows проверяются на настоящем filesystem/Tauri backend, а не только browser mock.

---

# PHASE 8 — Storage contract tests

## Приоритет

P2

## Цель

Browser storage и Tauri storage должны соблюдать одинаковые application-level invariants.

## 8.1. Определить общий contract

Например:

```text
create
read
write
rename
delete
list
open vault
properties
```

## 8.2. Запускать один suite против разных adapters

```text
BrowserStorage
TauriStorage
```

Но platform-specific semantics можно тестировать отдельно.

## 8.3. Не пытаться сделать localStorage filesystem

Browser adapter нужен для UI development, а не для симуляции symlink/watcher behavior.

---

# PHASE 9 — Усилить filesystem security

## Приоритет

P2 / P3

Не блокировать 1.0, если нет конкретного exploit path, но постепенно улучшить.

## 9.1. Провести аудит path validation

Особенно операции:

```text
validate path
↓
filesystem mutation
```

Искать TOCTOU между проверкой и использованием.

## 9.2. Проверить symlink scenarios

Особенно:

- rename;
- delete;
- copy;
- attachment operations;
- vault boundaries.

## 9.3. Где разумно — переходить к handle/capability-based operations

Не делать полный rewrite filesystem layer одним PR.

---

# PHASE 10 — Архитектурный cleanup после correctness fixes

## Приоритет

P3

Только после Phase 1–8.

## 10.1. Разделить `frontmatter.rs`

Целевая структура примерно:

```text
frontmatter/
  mod.rs
  parse.rs
  properties.rs
  identity.rs
  envelope.rs
```

Filesystem utility вынести:

```text
fs/
  atomic_write.rs
  text_format.rs
```

## 10.2. Разделить `ai.rs`

Пример:

```text
ai/
  mod.rs
  config.rs
  security.rs
  client.rs
  providers/
```

Не проводить rewrite AI behavior.

Цель — separation of responsibilities.

## 10.3. Сохранить текущий autosave coordinator

Не заменять его простым debounce-save.

Текущая версия/versioning/generation модель является полезной частью архитектуры.

Refactor допускается только при сохранении существующих guarantees и tests.

---

# PHASE 11 — Усилить frontend application layer

## Приоритет

P3

## Цель

Не допустить превращения Workspace в центр всей бизнес-логики по мере роста приложения.

## 11.1. Ввести application controllers/use-cases

Пример направления:

```text
DocumentController
VaultController
WorkspaceController
WindowController
```

или аналогичные сервисы.

UI должен инициировать:

```text
document.rename()
document.save()
vault.switch()
workspace.open()
```

вместо ручного координирования нескольких stores и IPC calls.

## 11.2. Не делать hook explosion

Не превращать один большой файл в 40 маленьких hooks без архитектурного выигрыша.

Разделение должно идти по ответственности, а не LOC.

---

# PHASE 12 — Обновить документацию

## Приоритет

P3

Обновить README architecture section согласно реальной структуре backend.

Сейчас документация должна отражать:

```text
commands/
index/
vault/
bundle/
frontmatter
watcher
history
recovery
...
```

Также задокументировать:

```yaml
amby-id:
```

и preservation policy.

---

# PHASE 13 — Release gates перед Beta/1.0

Не считать проект готовым к 1.0, пока не выполнены следующие условия.

Отметки ниже отражают только подтверждённые результаты на 2026-08-31.
Локальные проверки изменённых путей не заменяют desktop E2E и cross-platform CI.

## Data integrity

- [x] generic `id` не принадлежит Amby;
- [x] используется `amby-id`;
- [x] legacy IDs имеют безопасный migration path;
- [x] ID insertion lossless;
- [x] CRLF сохраняется в проверенных путях вставки ID и сохранения;
- [x] BOM сохраняется в проверенных путях вставки ID и сохранения;
- [x] YAML comments не уничтожаются при вставке ID и body-save закрытого envelope;
- [ ] unsupported Markdown roundtrip безопасен.

## Index

- [x] нет second-resolution mtime bug;
- [ ] external edits reliably detected на всех целевых платформах (macOS watcher integration пройден);
- [x] malformed YAML не скрывает body;
- [x] duplicate IDs диагностируются;
- [ ] SQLite полностью rebuildable.

## Search

- [ ] BM25 участвует в final ranking;
- [ ] Unicode search покрыт тестами;
- [ ] punctuation queries имеют нормальное поведение;
- [ ] snippet generation Unicode-safe.

## Desktop reliability

- [ ] autosave + rename E2E;
- [ ] external edit E2E;
- [ ] external delete E2E;
- [ ] vault switch E2E;
- [ ] crash/recovery smoke tests;
- [x] actual filesystem tested на временных macOS vault; Windows/Linux ещё не проверены.

## CI

- [ ] `verify:full` green;
- [ ] Windows green;
- [ ] macOS green;
- [ ] Linux green;
- [x] generated IPC bindings current; ожидается коммит с Rust-типами, повторная генерация побайтно совпала.

---

# Что НЕ делать сейчас

До завершения базовой стабилизации не начинать большие архитектурные rewrites.

Не нужно:

```text
переносить source of truth в SQLite
заменять Rust backend
заменять Tauri
заменять Tiptap
удалять CodeMirror
переписывать autosave
создавать собственный Markdown parser с нуля
```

Текущая общая архитектура проекта достаточно хорошая.

---

# Приоритет выполнения

Если времени мало, выполнять строго в следующем порядке:

## Tier 1 — обязательно

1. `id` → `amby-id`
2. lossless ID insertion
3. high-resolution index change detection
4. malformed frontmatter graceful handling
5. regression tests для всего выше

## Tier 2 — перед публичной beta

6. BM25 final ranking
7. query tokenizer
8. desktop E2E suite
9. storage contracts

## Tier 3 — после стабилизации

10. filesystem security hardening
11. split крупных Rust modules
12. frontend controllers
13. README/docs cleanup

---

# Рекомендуемый порядок PR

Не собирать всё в один гигантский PR.

Оптимально:

```text
PR 1 — introduce amby-id + compatibility tests

PR 2 — lossless frontmatter identity insertion

PR 3 — index metadata precision + migration

PR 4 — malformed frontmatter graceful indexing

PR 5 — search ranking + tokenizer

PR 6 — desktop E2E foundation

PR 7 — core reliability E2E scenarios

PR 8 — storage contract tests

PR 9 — filesystem security hardening

PR 10 — frontmatter module decomposition

PR 11 — AI module decomposition

PR 12 — frontend orchestration cleanup

PR 13 — documentation update
```

Каждый PR должен быть independently reviewable и по возможности не менять несколько архитектурных областей одновременно.

---

# Инструкция Codex по выполнению каждого PR

Для каждого пункта roadmap:

1. Сначала изучить текущую реализацию и связанные тесты.
2. Кратко описать root cause.
3. Указать затрагиваемые файлы.
4. Добавить failing regression test.
5. Реализовать минимальное исправление.
6. Не проводить unrelated cleanup.
7. Запустить локальные релевантные проверки.
8. Запустить полный verification pipeline.
9. В финальном отчёте указать:
   - что было изменено;
   - почему;
   - какие edge cases покрыты;
   - какие тесты добавлены;
   - какие команды проверки прошли;
   - что сознательно осталось вне scope.

---

# Финальная архитектурная цель

После выполнения roadmap Amby должен удовлетворять следующему принципу:

```text
Пользователь может взять существующий Markdown/Obsidian vault,
открыть его в Amby,
работать одновременно через другие Markdown tools,
а затем перестать использовать Amby,
не обнаружив, что приложение присвоило себе его данные,
сломало неизвестную разметку,
изменило YAML без необходимости
или спрятало часть заметок из-за внутренних требований Amby.
```

И только после достижения этого состояния стоит активно строить сверху:

```text
Collections
Databases
Git sync
AI workflows
advanced Canvas
plugin ecosystem
```

Потому что все эти возможности будут зависеть от надёжности identity, indexing и preservation layer.
