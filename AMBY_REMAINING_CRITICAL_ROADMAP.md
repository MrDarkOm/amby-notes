# Amby — Remaining Critical Roadmap for Codex

> Протокол выполнения от 2026-08-31 на Windows: [docs/remaining-critical-progress.md](docs/remaining-critical-progress.md).
> Статусы и ограничения указаны там по фактическим запускам; macOS/Linux не считаются проверенными на Windows.

## Назначение

Этот файл содержит **только обязательные оставшиеся работы**, которые важны для correctness, сохранности данных, совместимости Markdown/Obsidian, реального desktop-runtime и честной готовности к Beta/1.0.

Опциональные архитектурные улучшения вынесены в отдельный файл `AMBY_OPTIONAL_RECOMMENDATIONS.md` и не должны выполняться Codex автоматически в рамках этого roadmap.

## Главные инварианты

```text
Markdown filesystem = source of truth
SQLite = полностью rebuildable derived index
```

Amby не должен молча:

- повреждать Markdown;
- нормализовать неизвестный синтаксис;
- переписывать YAML без необходимости;
- удалять YAML comments;
- присваивать себе generic `id`;
- терять unsupported/opaque content;
- терять последнее подтверждённое пользовательское изменение;
- писать/удалять данные за пределами vault;
- скрывать валидный Markdown из-за внутренней metadata Amby.

---

# Общие правила для Codex

Перед каждым PR:

```bash
git checkout dev
git pull
git status
```

Далее:

1. Изучить текущую реализацию и связанные tests.
2. Кратко зафиксировать `Current behavior / Expected behavior / Root cause / Affected files`.
3. Для bug fix сначала добавить regression test.
4. Реализовать минимальное изменение без unrelated refactoring.
5. Запустить targeted tests.
6. Запустить полный verification pipeline.
7. В отчёте указать changed files, tests, commands, remaining risks и out-of-scope.

Финальный gate каждого PR:

```bash
npm run verify:full
```

Для Rust-heavy PR дополнительно:

```bash
cargo fmt --check
cargo clippy -- -D warnings
cargo test
```

---

# PHASE 1 — Чистый baseline

## Приоритет

P0 release gate

## Цель

Получить полностью понятную и воспроизводимую отправную точку перед оставшимися изменениями.

## Шаг 1.1 — Проверить состояние репозитория

```bash
git branch --show-current
git log -5 --oneline
git status
```

Ожидание:

```text
branch = dev
working tree = понятен
```

Не удалять и не перезаписывать unrelated local changes.

## Шаг 1.2 — Запустить полный verification

```bash
npm run verify:full
```

Любой formatting/test/lint failure, вызванный текущей веткой, должен быть устранён до release-work.

## Шаг 1.3 — Зафиксировать baseline

В `docs/roadmap-progress.md` или эквивалентном progress-файле записать:

```text
commit hash
date
verify:full result
frontend tests
Rust tests
known pre-existing failures
```

## Definition of Done

- [x] Актуальный `dev` подтверждён.
- [x] Working tree понятен.
- [x] `verify:full` green либо остались только явно задокументированные unrelated pre-existing failures.
- [x] Нет чисто форматирующих блокеров.

---

# PHASE 2 — Окончательно закрыть note identity

## Приоритет

P1

## Оставшаяся проблема

Generic пользовательский `id`, который случайно является canonical ULID, не должен автоматически становиться trusted Amby identity.

Проблемный пример:

```yaml
---
id: 01JABCDEFGHJKMNPQRSTVWXYZ12
---
```

ULID может принадлежать другой программе.

## Целевая модель

Authoritative Amby identity:

```yaml
amby-id: 01...
```

User-owned metadata:

```yaml
id: anything
```

Generic ULID допустимо распознавать как **legacy migration candidate**, но не как текущую trusted identity без контролируемой миграции.

## Шаг 2.1 — Инвентаризировать identity flow

Найти:

```text
AMBY_ID_FIELD
LEGACY_ID_FIELD
legacy_id
note_id
amby-id
canonical ULID
duplicate id
```

Проверить минимум:

```text
src-tauri/src/frontmatter*
src-tauri/src/index/
src-tauri/src/vault/
```

Проследить путь от frontmatter parser до index identity.

## Шаг 2.2 — Ввести явные identity states

Не использовать один `Option<String>` для разных смыслов.

Допустимая модель:

```rust
enum ParsedNoteIdentity {
    TrustedAmby(Ulid),
    LegacyCandidate(Ulid),
    Missing,
    InvalidAmbyId(String),
}
```

Точное название не важно.

Главный invariant:

```text
LegacyCandidate != TrustedAmby
```

## Шаг 2.3 — Изменить authoritative selection

Правила:

1. Валидный `amby-id` — authoritative.
2. Generic `id` полностью остаётся пользовательским.
3. Generic canonical ULID может стать только `LegacyCandidate`.
4. Ordinary scan не должен молча превращать `LegacyCandidate` в current Amby identity.

## Шаг 2.4 — Безопасная legacy migration

Предпочтительная модель:

```text
legacy candidate найден
→ note остаётся visible/searchable/openable
→ generic id остаётся byte-preserved
→ amby-id назначается только через контролируемый migration path
→ generic id не удаляется
```

Не делать массовый rewrite vault только потому, что встречены ULID в generic `id`.

## Шаг 2.5 — Сохранить совместимость со старым Amby

Если в репозитории есть надёжный маркер, доказывающий происхождение legacy ID от старого Amby — использовать его.

Если такого маркера нет, предпочтение отдавать:

```text
safe candidate + explicit migration
```

а не присвоению чужого metadata.

## Шаг 2.6 — Duplicate `amby-id`

Две заметки с одинаковым trusted `amby-id` должны обе оставаться:

```text
visible
openable
searchable where possible
```

и получать diagnostic conflict.

Нельзя silently skip одну из них.

## Шаг 2.7 — Regression tests

Обязательные cases:

```yaml
id: jira-123
```

→ user-owned, note indexed.

```yaml
id: 550e8400-e29b-41d4-a716-446655440000
```

→ user-owned.

```yaml
id: 01JABCDEFGHJKMNPQRSTVWXYZ12
```

→ **не trusted Amby identity автоматически**.

```yaml
amby-id: 01J...
```

→ authoritative.

```yaml
id: external-value
amby-id: 01J...
```

→ `id` preserved, `amby-id` authoritative.

Также:

- invalid `amby-id`;
- duplicate `amby-id`;
- explicit legacy migration.

## Шаг 2.8 — Почистить stale fixtures

Обычные современные test fixtures должны использовать `amby-id`.

Generic `id` оставлять только в явно названных tests:

```text
external-id
legacy-id
migration
compatibility
```

## Definition of Done

- [x] Generic `id` user-owned.
- [x] Generic canonical ULID не trusted автоматически.
- [x] `amby-id` authoritative.
- [x] Старые Amby notes имеют безопасный migration path.
- [x] Duplicate trusted IDs дают diagnostic, а не исчезновение note.
- [x] External canonical ULID покрыт regression test.
- [x] Generic `id` byte-preserved.

---

# PHASE 3 — Унифицировать FTS, title match и snippet

## Приоритет

P2

## Оставшаяся проблема

FTS уже может интерпретировать:

```text
foo-bar
```

как два query terms:

```text
foo AND bar
```

Но title/snippet logic может продолжать искать буквальный `foo-bar`.

Получается:

```text
FTS = MATCH
title/snippet = NO MATCH
```

## Шаг 3.1 — Централизовать query normalization

Найти существующий tokenizer/query builder и сформировать единое внутреннее представление, например:

```rust
struct SearchQuery {
    raw: String,
    terms: Vec<String>,
    fts_expression: String,
}
```

Не создавать второй независимый tokenizer.

## Шаг 3.2 — Предпочесть FTS5 `snippet()` / `highlight()`

Исследовать использование:

```sql
snippet(...)
highlight(...)
```

Предпочтительная модель:

```text
один FTS MATCH
→ те же термы
→ тот же snippet/highlight semantics
```

## Шаг 3.3 — Если custom snippet обязателен

Использовать тот же `terms`, который применяет FTS.

Не использовать raw query substring как отдельную semantics.

## Шаг 3.4 — Нормализовать title matching

Сценарий:

```text
query = foo-bar
title = Foo Bar
```

должен обрабатываться осознанно и стабильно.

Закрепить правила:

```text
exact normalized title
prefix
all query terms present
substring
body only
```

BM25 должен оставаться частью final ranking.

## Шаг 3.5 — Главный regression test

```text
Title: Foo Bar
Body: foo something bar
Query: foo-bar
```

Ожидание:

- result найден;
- title match корректен по заданной policy;
- snippet существует;
- snippet основан на реально matched terms;
- нет raw-literal mismatch.

## Шаг 3.6 — Punctuation matrix

Обязательные queries:

```text
foo-bar
foo/bar
hello.world
node.js
snake_case
C++
C#
```

Для каждого зафиксировать intended behavior тестом.

## Шаг 3.7 — Unicode matrix

```text
русский
український
日本語
🔥
English русский
```

Проверить:

```text
no panic
valid UTF-8 slicing
useful snippet
stable result
```

## Шаг 3.8 — FTS syntax safety

Проверить ввод:

```text
"
*
(
)
:
AND
OR
NEAR
```

Ожидание:

```text
нет query syntax injection
нет неожиданных SQLite FTS errors
```

## Definition of Done

- [x] Один normalization model.
- [x] `foo-bar` mismatch закрыт.
- [x] Title bonus использует normalized semantics.
- [x] Snippet использует те же matched terms.
- [x] BM25 сохранён.
- [x] Unicode tests green.
- [x] FTS syntax safety tests green.

---

# PHASE 4 — Завершить REAL storage contract

## Приоритет

P1/P2

## Проблема

Browser semantic contract уже полезен.

Desktop tests с mocked generated Tauri commands проверяют delegation, но не доказывают:

```text
Desktop storage abstraction
→ real Tauri boundary
→ Rust
→ temp vault
→ filesystem
```

## Шаг 4.1 — Сохранить browser contract

Не переписывать working suite.

Минимальные операции:

```text
create
read
write
overwrite
rename
delete
list
create folder
rename folder
nested note
Unicode path/content
spaces
missing item
collision
```

## Шаг 4.2 — Оставить mocked Desktop tests отдельно

Переименовать/документировать их как:

```text
DesktopAdapter delegation tests
```

Они полезны, но это не live contract.

## Шаг 4.3 — Создать live Tauri contract harness

Нужен путь, который действительно достигает Rust storage и real temp filesystem.

Допустимо:

- Tauri integration harness;
- native test window/test bridge;
- другой существующий в проекте способ реального invoke.

Нельзя заменять команды `vi.spyOn()` и считать это live contract.

## Шаг 4.4 — Запустить один semantic suite против двух adapters

```text
Browser adapter
Live Tauri-backed adapter
```

Platform-specific вещи не включать в общий contract.

## Шаг 4.5 — Isolation

Каждый live test:

```text
unique temp vault
order-independent
automatic cleanup
```

## Шаг 4.6 — Error contract

Application/adapter boundary должен различать минимум:

```text
not found
already exists/conflict
invalid path
operation failed
```

Raw strings browser/Rust могут различаться.

## Шаг 4.7 — Platform execution policy

Сейчас закрыть live contract на текущей доступной ОС.

Windows прогнать позже в отдельном Windows gate.

Linux явно deferred.

Не ставить зелёную галочку платформе, где тест реально не запускался.

## Definition of Done

- [x] Один reusable storage contract.
- [x] Browser green.
- [x] Live Tauri/Rust/filesystem green на текущей ОС.
- [x] Mocked Desktop delegation tests отделены по смыслу.
- [x] Temp vault isolation есть.
- [x] Unicode/nested paths green.
- [x] Error semantics определены.
- [x] Windows отмечен как pending until real Windows run.
- [x] Linux deferred.

---

# PHASE 5 — Довести compatibility vault до полного критического corpus

## Приоритет

P1 перед 1.0

## Шаг 5.1 — Сделать coverage inventory

Сопоставить существующие fixtures с матрицей:

```text
plain Markdown
frontmatter
YAML comments
single quotes
double quotes
inline YAML
nested YAML
generic id
external canonical ULID
amby-id
duplicate amby-id
malformed YAML
LF
CRLF
UTF-8 BOM
Russian
Ukrainian
Japanese
emoji
wikilink
wikilink alias
wikilink heading
embed
raw HTML
tables
code fences
unknown/custom fenced block
unsupported/opaque syntax
```

Не создавать дубликаты, если эквивалентный fixture уже есть.

## Шаг 5.2 — Добавить отсутствующие high-value cases

Минимум убедиться в наличии:

```text
wikilink alias
wikilink heading
embed
raw HTML
unknown/custom block
YAML comments
mixed quotes
реальный CRLF fixture
реальный UTF-8 BOM fixture
external canonical ULID в generic id
```

## Шаг 5.3 — Byte-preserving rebuild

Test:

```text
copy fixture vault
snapshot bytes
delete SQLite/index
rebuild
compare every Markdown file byte-for-byte
```

Ожидание:

```text
zero Markdown mutations
```

## Шаг 5.4 — Rich editor roundtrip

Для notes с unsupported/opaque syntax:

```text
open
изменить только supported paragraph
save
```

Opaque source должен сохраниться согласно project guarantees.

## Шаг 5.5 — Identity insertion roundtrip

Valid frontmatter без `amby-id`:

```text
assign Amby identity
```

Ожидание:

```text
только необходимая вставка amby-id
comments/quotes/format preserved
```

## Шаг 5.6 — Malformed YAML

Ожидание:

```text
body readable/searchable
file not auto-repaired
rebuild does not mutate bytes
```

## Definition of Done

- [x] Critical interoperability corpus полный.
- [x] Rebuild byte-preserving.
- [x] Unsupported content переживает supported-region edit.
- [x] External IDs остаются user-owned.
- [x] CRLF/BOM fixtures реальные на уровне bytes.
- [x] Corpus автоматизирован где это разумно.

---

# PHASE 6 — Failure / recovery completion

## Приоритет

P1

## Цель

Доказать, что Amby безопасно падает на ошибках filesystem и не сообщает ложный success.

## Шаг 6.1 — Save failure

Инъецировать или симулировать write failure.

Ожидание:

```text
original data не silently corrupted
document остаётся dirty/unsaved
error surfaced
retry возможен
```

## Шаг 6.2 — Final replace failure

Сценарий atomic write:

```text
temp write succeeds
final replace/rename fails
```

Ожидание:

```text
original file usable
operation not reported as success
temp cleanup/recovery deterministic
```

## Шаг 6.3 — Rename collision/failure

Ожидание:

```text
old filesystem path remains valid
frontend state не притворяется успешным rename
autosave mapping remains correct
```

## Шаг 6.4 — External change vs pending save

Проверить текущую conflict/revision policy.

Amby не должен молча перетирать уже известное более новое external state вопреки собственной policy.

## Шаг 6.5 — Existing recovery mechanisms

Для каждого существующего механизма добавить минимум один smoke test:

```text
history snapshot
recovery
recycle bin
```

Не создавать новые subsystems, если существующие уже решают задачу.

## Definition of Done

- [x] Save failure не выглядит как success.
- [x] Latest user data остаётся recoverable.
- [x] Final replace failure не уничтожает оригинал молча.
- [x] Rename failure не рассинхронизирует storage/UI identity.
- [x] External conflict behavior покрыт тестом.
- [x] History/recovery/recycle имеют smoke coverage.

---

# PHASE 7 — Настоящий native desktop smoke на текущей ОС

## Приоритет

P1 перед Beta/1.0

## Цель

Закрыть крупнейшую непроверенную цепочку:

```text
React/WebView
→ real Tauri invoke
→ Rust
→ filesystem/index
→ event/reload
→ real UI
```

Backend E2E недостаточен для этого gate.

## Шаг 7.1 — Запускать реальный Tauri app

Не browser fallback.

## Шаг 7.2 — Critical smoke scenarios

### Lifecycle

```text
launch
open vault
open note
edit
save/autosave
close app
reopen
verify latest content
```

### Rename

```text
edit
rename note
close
reopen
verify final path/content
```

### Vault switch

```text
dirty/edit state
switch vault
verify no silent data loss
```

### External edit

```text
app open
external process edits vault file
verify reconciliation according to product policy
```

### External create

Новый `.md` должен появиться согласно watcher policy.

### External rename

Не должно оставаться phantom stale entry.

### External delete

Tab/tree/index должны reconciliate безопасно.

## Шаг 7.3 — Переиспользовать infrastructure Phase 4

Если live storage contract уже использует native test bridge/window, переиспользовать его.

Не строить два тяжёлых automation framework.

## Шаг 7.4 — Ограничить suite

Цель:

```text
10–20 critical native scenarios
```

Не сотни flaky visual tests.

Фокус — data/lifecycle, не pixel-perfect UI.

## Шаг 7.5 — Текущая платформа

Закрыть текущую доступную платформу полностью.

Если работа выполняется на macOS:

```text
macOS native smoke = NOW
Windows = later dedicated pass
Linux = deferred
```

## Definition of Done

- [x] Real Tauri/WebView runtime tested.
- [x] Save/reopen green.
- [x] Rename lifecycle green.
- [x] Vault switch dirty-state green.
- [x] External create/edit/rename/delete green.
- [x] Tests действительно доходят до Rust/filesystem.
- [x] Current platform green.

---

# PHASE 8 — macOS release closure

**Исключено из текущего выполнения по прямому указанию пользователя от
2026-09-01. Незавершённые пункты этой фазы не интерпретируются как Windows/core
FAIL.**

## Приоритет

P1 если macOS сейчас основная доступная ОС

## Шаг 8.1 — Production build

Собрать production artifact штатной командой проекта.

Записать:

```text
command
commit
artifact
architecture
result
```

## Шаг 8.2 — Проверить production artifact

Не только dev mode.

```text
launch
open existing vault
edit
save
close/reopen
```

## Шаг 8.3 — Compatibility vault на production build

Открыть corpus, выполнить representative edits, проверить отсутствие corruption.

## Шаг 8.4 — External editor

При работающем production Amby проверить реальным external editor/script:

```text
edit
create
rename
delete
```

## Шаг 8.5 — Security smoke

Запустить platform-supported regression tests:

```text
path traversal
symlink escape
```

## Шаг 8.6 — Зафиксировать platform gate

В release checklist:

```text
macOS: GREEN
commit:
date:
architecture:
known limitations:
```

## Definition of Done

- [ ] Production build green.
- [ ] Production binary critical smoke green.
- [ ] Compatibility vault green.
- [ ] External editor flow green.
- [ ] Platform security regressions green.
- [ ] Status задокументирован.

---

# PHASE 9 — Windows closure pass

## Приоритет

P1 перед заявлением Windows 1.0 support

## Когда выполнять

Позже на реальной Windows-машине.

Не блокировать текущую core/macOS работу из-за отсутствующей Windows среды.

## Шаг 9.1 — Проверить тот же candidate commit

```bash
git checkout dev
git pull
```

Желательно тестировать тот же release-candidate commit, который уже green по core/macOS.

## Шаг 9.2 — Full verification

```bash
npm run verify:full
```

## Шаг 9.3 — Production installer/build

Собрать реальный Windows installer/artifact.

Установить и запустить.

## Шаг 9.4 — Native smoke

Повторить critical suite:

```text
open vault
edit/save
close/reopen
rename
vault switch
external create
external edit
external rename
external delete
```

## Шаг 9.5 — Windows filesystem cases

Обязательные проверки:

```text
backslash paths
drive letters
absolute-path rejection for vault-relative API
UNC policy
case-insensitive collisions where relevant
reserved names where applicable
atomic replacement behavior
```

Не обещать поддержку path-form, если продукт её не поддерживает — документировать policy.

## Шаг 9.6 — Windows symlink tests

Запустить, если permissions/environment позволяют.

Если нет:

```text
record skipped reason
не ставить ложную green галочку конкретному test
```

## Шаг 9.7 — Compatibility vault

Особенно проверить:

```text
CRLF
BOM
Unicode
generic id
amby-id
opaque syntax
```

## Шаг 9.8 — Зафиксировать Windows gate

```text
Windows: GREEN
commit:
date:
Windows version:
architecture:
installer tested:
known limitations:
```

Фактический gate 2026-09-01:

```text
Windows: PARTIAL (production installed-runtime launch requires explicit settings-isolation approval)
commit: 974ff43 (verified committed candidate; gate-record synchronization follows)
date: 2026-09-01
Windows version: 25H2, build 26200.9168
architecture: AMD64
installer tested: exact NSIS install/uninstall, SHA-256 BBEDCF0F6FCE7773AE4A98EAFCB003733386BAD2F0A193A992EDFC55E716F984
known limitations: NotSigned; privileged symlink test blocked by OS 1314; no prepared exFAT/FAT32/SMB media
```

## Definition of Done

- [x] Windows `verify:full` green.
- [ ] Installer builds/installs/launches.
- [x] Native lifecycle smoke green.
- [x] Windows path cases green.
- [x] Compatibility vault green.
- [x] External editor flow green.
- [x] Windows gate recorded honestly as PARTIAL.

---

# PHASE 10 — Linux platform gate

## Статус

**DEFERRED по решению пользователя.**

Нельзя отмечать Linux green без реального запуска.

Если Linux будет заявлен как supported 1.0 platform — выполнить позднее:

```text
verify:full
production build/package
native smoke
external filesystem operations
compatibility vault
symlink security
case-sensitive filesystem behavior
```

Если Linux release откладывается, support matrix/release notes должны это честно указывать.

---

# PHASE 11 — Performance baseline

## Приоритет

P2

## Цель

Получить воспроизводимый baseline без выдуманных hard limits.

## Шаг 11.1 — Synthetic vaults

Использовать существующий generator:

```text
1k
5k
10k notes
```

## Шаг 11.2 — Measurements

Минимум:

```text
cold initial scan
warm reopen
single-note reindex
representative search latency
```

Memory — желательно, но можно вынести отдельно, если текущий harness не умеет стабильно измерять.

## Шаг 11.3 — Reference machine

Записать:

```text
machine
CPU
RAM
OS
build mode
commit
```

Не сравнивать числа разных машин как равнозначные.

## Шаг 11.4 — Сохранить baseline

`docs/performance-baseline.md`:

```text
commit
machine
vault size
metrics
notes
```

## Шаг 11.5 — Не вводить произвольные blockers

Release blocker только при явно неприемлемой работе или серьёзной доказанной регрессии.

## Definition of Done

- [x] 1k recorded.
- [x] 5k recorded.
- [x] 10k recorded.
- [x] Cold/warm/reindex/search metrics записаны.
- [x] Reference machine documented.

---

# PHASE 12 — Final release gate

## Приоритет

P0

## Шаг 12.1 — Clean tree

```bash
git status
```

Нет accidental release changes.

## Шаг 12.2 — Full verification

```bash
npm run verify:full
```

Candidate commit обязан быть green.

## Шаг 12.3 — Data integrity gate

- [x] Generic `id` user-owned.
- [x] Generic canonical ULID не trusted автоматически.
- [x] `amby-id` authoritative.
- [x] Legacy migration safe.
- [x] Duplicate identity diagnostic.
- [x] YAML comments preserved.
- [x] Quotes preserved.
- [x] CRLF preserved.
- [x] BOM preserved.
- [x] Unsupported Markdown preserved.
- [x] Malformed YAML не скрывает body.

## Шаг 12.4 — Search gate

- [x] BM25 участвует в ranking.
- [x] Tokenization deterministic.
- [x] Title/snippet semantics совпадают с FTS semantics.
- [x] Unicode-safe.
- [x] Punctuation cases tested.
- [x] FTS syntax input safe.

## Шаг 12.5 — Storage gate

- [x] Browser contract green.
- [x] Live Tauri contract green на текущей ОС.
- [x] Windows live contract green после Windows pass.
- [x] SQLite rebuild byte-safe.
- [x] External filesystem changes reconcile.

## Шаг 12.6 — Failure/recovery gate

- [x] Save failure safe.
- [x] Final replace failure safe.
- [x] Rename failure safe.
- [x] External conflict tested.
- [x] History/recovery/recycle smoke green.

## Шаг 12.7 — Security gate

- [x] Traversal read blocked.
- [x] Traversal write blocked.
- [x] Traversal delete blocked.
- [x] Symlink vault escape handled according to policy (junction test green;
      privileged symlink test skipped with recorded Windows error 1314).
- [x] Recursive delete guarded.
- [x] AI endpoint restrictions green.
- [x] Credentials not leaked by tested IPC/error paths.
- [x] No committed secrets (staged added-line secret-pattern scan green).

## Шаг 12.8 — Platform gate

### macOS

- [ ] Green.

Excluded from this execution by the user's instruction.

### Windows

- [ ] Green после реального Windows pass.

### Linux

Выбрать честно одно:

```text
[ ] Green
или
[x] Deferred / not claimed for this release
```

## Шаг 12.9 — Release blockers

Любой из следующих пунктов блокирует release:

```text
possible user data loss
silent Markdown corruption
silent YAML corruption
latest autosave loss
note hidden because of Amby metadata
unrecoverable source/index divergence
vault boundary escape
credential exposure
production native build cannot complete critical workflow
```

## Шаг 12.10 — Feature freeze

После green candidate:

```text
NO large features
NO speculative refactors
NO aesthetic architecture cleanup
```

Разрешены только:

```text
release blockers
bug fixes
test fixes
build fixes
documentation corrections
```

---

# Рекомендуемый порядок PR

```text
PR 1 — authoritative identity vs external canonical ULID
PR 2 — cleanup identity test fixtures
PR 3 — FTS/title/snippet semantic unification
PR 4 — live Tauri storage contract harness
PR 5 — compatibility-vault corpus completion
PR 6 — save/rename/recovery failure tests
PR 7 — native desktop smoke harness/current platform
PR 8 — macOS production closure
PR 9 — performance baseline completion
PR 10 — final release checklist synchronization
```

Позже на Windows:

```text
PR/verification 11 — Windows production + native smoke + path cases
```

Linux:

```text
deferred platform verification
```

---

# Codex stopping rule

Когда все обязательные phases этого файла закрыты для реально заявленных платформ, Codex должен **остановиться** и выдать final report.

Он не должен автоматически переходить к architecture cleanup, module splitting или speculative improvements.

Для этого существует отдельный файл рекомендаций.
