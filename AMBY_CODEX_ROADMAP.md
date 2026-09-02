# AMBY — MASTER IMPLEMENTATION ROADMAP FOR CODEX

## Назначение документа

Этот roadmap предназначен для самостоятельного выполнения Codex в репозитории Amby.

Задача Codex — последовательно довести проект от текущего состояния `dev` до архитектурно стабильной версии, готовой к публичной Beta / 1.0.

Главный приоритет:

```text
DATA INTEGRITY
↓
FILESYSTEM CORRECTNESS
↓
INDEX CORRECTNESS
↓
EDITOR ROUNDTRIP
↓
AUTOSAVE / EXTERNAL CHANGES
↓
TEST COVERAGE
↓
SECURITY
↓
ARCHITECTURAL CLEANUP
↓
NEW FEATURES
```

Новые крупные функции не должны иметь приоритет над сохранностью пользовательских данных.

---

# 0. Глобальные архитектурные инварианты

Codex НЕ должен нарушать следующие правила.

## 0.1. Source of truth

```text
Markdown filesystem = authoritative source of truth
SQLite = disposable derived index
```

SQLite должен быть полностью rebuildable.

Удаление SQLite не должно приводить к потере пользовательских данных.

---

## 0.2. Markdown ownership

Пользователь владеет Markdown.

Amby не должен без необходимости:

- переписывать YAML;
- менять кавычки;
- переставлять properties;
- удалять YAML comments;
- нормализовать неизвестную разметку;
- удалять unsupported Markdown;
- присваивать себе generic metadata fields;
- менять CRLF/LF без необходимости;
- удалять BOM.

---

## 0.3. Unsupported != disposable

Если редактор не понимает конструкцию:

```text
unknown Markdown
HTML
Obsidian syntax
custom directives
future syntax
```

она должна быть сохранена как opaque/raw representation.

---

## 0.4. Не делать premature rewrite

Без отдельного доказанного основания не:

```text
заменять Tauri
заменять Rust
заменять React
заменять Tiptap
заменять CodeMirror
переписывать autosave
переводить source of truth в SQLite
писать собственный Markdown parser с нуля
```

---

# 1. Общий рабочий процесс Codex

Для КАЖДОЙ фазы использовать один и тот же цикл.

## STEP A — Sync

Работать от актуальной:

```bash
git checkout dev
git pull
```

Не предполагать, что roadmap полностью соответствует текущим именам файлов.

Сначала изучить актуальный код.

---

## STEP B — Baseline

Перед изменением выполнить релевантные тесты.

Минимум в конце каждого PR:

```bash
npm run verify:full
```

Для Rust-изменений дополнительно:

```bash
cargo fmt --check
cargo clippy -- -D warnings
cargo test
```

---

## STEP C — Inspect

Перед кодированием определить:

```text
Current behavior
Expected behavior
Root cause
Affected modules
Existing tests
Risk of change
```

---

## STEP D — Test first

Если исправляется bug:

1. Добавить regression test.
2. Убедиться, что test реально воспроизводит проблему.
3. Только затем менять implementation.

---

## STEP E — Minimal implementation

Не делать unrelated cleanup.

Один PR должен решать одну архитектурную проблему или один тесно связанный набор проблем.

---

## STEP F — Verification

После изменения:

1. targeted tests;
2. full module tests;
3. `verify:full`.

---

## STEP G — Report

В конце каждого PR вывести:

```text
Summary
Root cause
Files changed
Tests added
Commands executed
Result
Remaining risks
Out of scope
```

---

# PHASE 0 — Baseline Verification

## Статус

Большая часть уже сделана.

Codex должен только перепроверить состояние и НЕ переделывать рабочий код.

---

## STEP 0.1 — Проверить repository state

```bash
git status
git branch --show-current
git log -5 --oneline
```

Убедиться, что работа идёт от актуальной `dev`.

---

## STEP 0.2 — Запустить baseline

```bash
npm run verify:full
```

Зафиксировать:

```text
PASS
или
pre-existing failures
```

---

## STEP 0.3 — Создать technical checklist

Проверить существование/реализацию:

```text
amby-id
lossless frontmatter
mtime_ns
malformed YAML indexing
BM25 search
query tokenizer
Unicode-safe snippets
desktop reliability tests
```

Если пункт уже реализован и покрыт тестами — не переписывать.

---

## Gate Phase 0

Переходить дальше только если:

- baseline известен;
- текущий код понят;
- existing failures отделены от новых.

---

# PHASE 1 — Note Identity Hardening

## Приоритет

P1

## Цель

Окончательно отделить внутреннюю идентичность Amby от пользовательского generic `id`.

---

# 1.1. Проверить текущую модель

Найти:

```text
AMBY_ID_FIELD
LEGACY_ID_FIELD
note_id()
legacy_id
amby-id
```

Особенно:

```text
src-tauri/src/frontmatter*
src-tauri/src/index/
src-tauri/src/vault/
```

---

# 1.2. Требуемая модель

Trusted identity:

```yaml
amby-id: 01...
```

Generic:

```yaml
id: anything
```

принадлежит пользователю.

---

# 1.3. Не считать произвольный ULID trusted Amby ID

Проблемный сценарий:

```yaml
---
id: 01JABCDEFG...
---
```

Этот ULID может принадлежать другой программе.

Нельзя автоматически считать:

```text
canonical ULID == definitely legacy Amby
```

---

# 1.4. Ввести явное различие identity states

Предпочтительно:

```rust
enum NoteIdentity {
    Amby(Ulid),
    LegacyCandidate(Ulid),
    Missing,
    InvalidAmbyId(String),
    Duplicate(Ulid),
}
```

Конкретная форма может отличаться.

Главное — не смешивать:

```text
trusted Amby identity
```

и:

```text
possible legacy candidate
```

---

# 1.5. Migration policy

Legacy generic `id` с canonical ULID:

```text
не переписывать автоматически при scan
```

Варианты:

### Preferred

```text
legacy candidate
→ note remains indexed/openable
→ assign/migrate amby-id only during controlled migration
→ preserve original generic id
```

Generic `id` НЕ удалять.

---

# 1.6. External user ID

Fixture:

```yaml
---
id: jira-123
---
```

Должно быть:

```text
note indexed
note searchable
note editable
id preserved
Amby uses separate identity
```

---

# 1.7. Duplicate `amby-id`

Две заметки:

```yaml
amby-id: SAME
```

Обе должны:

```text
remain visible
remain openable
receive diagnostic conflict
```

Нельзя silent skip.

---

# 1.8. Tests

Добавить:

```text
generic string id
generic UUID id
generic ULID id
valid amby-id
invalid amby-id
generic id + amby-id
duplicate amby-id
legacy candidate
```

---

## Gate Phase 1

- [ ] Generic `id` не является trusted Amby identity.
- [ ] `amby-id` является authoritative Amby identity.
- [ ] Legacy data не теряется.
- [ ] External IDs сохраняются.
- [ ] Duplicate IDs диагностируются.
- [ ] Tests green.

---

# PHASE 2 — Lossless Frontmatter Identity Operations

## Приоритет

P1

## Статус

Основная реализация уже существует.

Codex должен проверить её и расширить tests при необходимости.

---

# 2.1. Проверить отсутствие YAML reserialization

При вставке:

```yaml
amby-id:
```

нельзя делать:

```text
parse YAML
→ mapping
→ serialize entire mapping
```

---

# 2.2. Требуемый алгоритм

Для существующего valid frontmatter:

```yaml
---
# comment
title: "Hello"
custom: [one, two]
---
```

результат:

```yaml
---
amby-id: ...
# comment
title: "Hello"
custom: [one, two]
---
```

Старый YAML должен остаться byte-preserved кроме вставленной строки.

---

# 2.3. Проверить LF

Fixture LF.

---

# 2.4. Проверить CRLF

Fixture CRLF.

Вставленная строка также CRLF.

---

# 2.5. Проверить BOM

UTF-8 BOM должен сохраняться.

---

# 2.6. Проверить comments

До/после properties.

---

# 2.7. Проверить quotes

```yaml
title: "00123"
foo: "true"
```

не должны нормализоваться.

---

# 2.8. Проверить malformed YAML

Amby не должен автоматически "чинить" YAML serializer-ом.

---

# 2.9. Проверить no-frontmatter case

```markdown
# Hello
```

должен получить новый frontmatter без изменения body.

---

## Gate Phase 2

Все byte-level tests green.

Если уже green — не менять implementation.

---

# PHASE 3 — Incremental Index Correctness

## Приоритет

P1

## Статус

Основная проблема `mtime seconds + size` уже исправлена через high-resolution metadata/watcher invalidation.

Нужно проверить residual edge cases.

---

# 3.1. Проверить schema

Индекс должен использовать high-resolution timestamp.

Не:

```text
seconds only
```

---

# 3.2. Same-size fast modification

Regression:

```text
cat
→
dog
```

одинаковый размер.

Изменение должно быть обнаружено.

---

# 3.3. Watcher-triggered invalidation

Если watcher сообщил modification:

```text
не доверять cached unchanged decision вслепую
```

---

# 3.4. Cold-scan collision

Проверить возможность:

```text
same mtime_ns
same size
different content
```

Если текущий код всё ещё может пропустить это на cold startup, решить:

### Option A

Добавить persistent fast fingerprint.

Например:

```text
BLAKE3
xxHash
```

### Option B

Если риск считается приемлемым:

зафиксировать как documented limitation.

---

# 3.5. Не хешировать весь vault без необходимости

Предпочтительная схема:

```text
metadata clearly changed
→ read/reindex

watcher says changed
→ force recheck

cold startup exact metadata match
→ fast path
```

Content hash использовать только если архитектурно оправдано.

---

# 3.6. Rebuild guarantee

Удаление SQLite и rebuild не должны изменять Markdown.

Добавить test.

---

## Gate Phase 3

- [ ] Same-size edit обнаруживается.
- [ ] Watcher invalidation работает.
- [ ] Rebuild lossless.
- [ ] Residual cold-scan risk либо исправлен, либо документирован.

---

# PHASE 4 — Malformed Frontmatter Graceful Degradation

## Приоритет

P1

## Статус

Основная реализация уже существует.

---

# 4.1. Требуемый behavior

Для:

```yaml
---
tags: [broken,
---
# Important body
```

должно быть:

```text
note visible
body readable
body searchable
links in body indexable
warning available
properties editor limited/disabled
```

---

# 4.2. Нельзя

```text
skip entire note
```

из-за YAML parse error.

---

# 4.3. Test cases

```text
broken array
broken indentation
root scalar
root array
missing close delimiter
valid body after broken YAML
```

---

# 4.4. Не mutate

Indexing malformed YAML не должен изменять файл.

---

## Gate Phase 4

Если tests проходят — phase закрыть без rewrite.

---

# PHASE 5 — Search Ranking

## Приоритет

P2

## Статус

BM25 уже интегрирован.

Нужно только проверить ranking contracts.

---

# 5.1. SQL

Должен использовать:

```sql
bm25(notes_fts)
```

---

# 5.2. Final ranking

BM25 нельзя заменять грубым:

```text
title = 3
content = 1
```

Title bonus должен быть дополнением.

---

# 5.3. Fixtures

Создать predictable corpus:

```text
Apple
Apple pie
Fruit guide
Cooking apple pie
Random
```

Query:

```text
apple
```

Закрепить разумный порядок.

---

# 5.4. Title bonuses

Проверить:

```text
exact title
prefix
substring
body only
```

---

## Gate Phase 5

Ranking tests green.

---

# PHASE 6 — Search Tokenization + Snippet Consistency

## Приоритет

P2

## Эта фаза требует дополнительного исправления

Tokenization уже улучшена, но необходимо сделать snippet/title matching согласованными с FTS query.

---

# 6.1. Проверить tokenizer

Queries:

```text
foo-bar
foo/bar
hello.world
snake_case
C++
C#
node.js
```

---

# 6.2. FTS safety

User query не должен превращаться в arbitrary FTS expression.

Все tokens должны безопасно escape-иться.

---

# 6.3. Исправить snippet mismatch

Сценарий:

```text
query = foo-bar

document:
foo something bar
```

FTS может найти документ как:

```text
foo AND bar
```

Но raw substring:

```text
foo-bar
```

в документе отсутствует.

Snippet всё равно должен существовать.

---

# 6.4. Preferred solution

Использовать SQLite FTS:

```sql
snippet(...)
```

или:

```sql
highlight(...)
```

чтобы snippet строился из реального FTS match.

---

# 6.5. Если FTS snippet неудобен

Использовать тот же normalized token set, что и FTS query.

НЕ писать независимую вторую query-normalization систему.

---

# 6.6. Title matching

Title bonus должен использовать normalized tokens.

Например:

```text
query: foo-bar
title: Foo Bar
```

должен корректно распознаваться.

---

# 6.7. Unicode

Обязательные tests:

```text
русский
український
日本語
🔥
mixed English русский
```

---

# 6.8. UTF-8 slicing

Любой manual slicing обязан работать только по valid char boundaries.

---

## Gate Phase 6

- [ ] Tokenizer tested.
- [ ] FTS injection impossible.
- [ ] Snippet соответствует реальному FTS match.
- [ ] Title bonuses используют ту же normalization model.
- [ ] Unicode-safe.

---

# PHASE 7 — Desktop Reliability Tests

## Приоритет

P1 / P2

## Статус

Backend filesystem E2E уже реализован.

Не переписывать его.

---

# 7.1. Существующий suite должен покрывать

```text
save → reopen
rename during save
vault switch
external edit
external rename
external delete
CRLF/BOM
unsupported Markdown
duplicate identity
large vault
```

---

# 7.2. Добавить missing cases

Если отсутствуют:

```text
external create
failed save
failed rename
malformed YAML
external generic id
```

---

# 7.3. Не называть backend test полноценным UI E2E

Существующий Rust suite:

```text
filesystem + index + vault context
```

Это хорошо.

Но он не проверяет:

```text
React
WebView
actual invoke wiring
window lifecycle
native UI
```

Полноценный native UI smoke будет отдельным release gate.

---

## Gate Phase 7

Backend reliability suite стабилен и green.

---

# PHASE 8 — Real Storage Contract Suite

## Приоритет

P2

## Эта фаза ещё требует полноценной реализации

---

# 8.1. Инвентаризация

Найти:

```text
WebStorage / BrowserStorage
DesktopStorage
Tauri commands
storage interfaces
storage tests
```

---

# 8.2. Текущую mocked DesktopAdapter проверку не считать достаточной

Mock:

```ts
vi.spyOn(commands, ...)
```

проверяет delegation.

Он НЕ доказывает storage semantics.

---

# 8.3. Создать reusable contract

Один suite:

```ts
runStorageContract(adapterFactory)
```

---

# 8.4. Contract operations

Обязательно:

```text
create
read
write
overwrite
rename
delete
list
folder create
folder rename
nested note
```

---

# 8.5. Browser adapter

Запустить contract против browser implementation.

---

# 8.6. REAL Tauri-backed adapter

Не mock Tauri commands.

Тест должен доходить до:

```text
real Rust storage
real temp directory
real filesystem
```

---

# 8.7. Isolation

Каждый test:

```text
temp vault
unique ID
cleanup
```

---

# 8.8. Unicode paths

```text
Заметка.md
Нотатка.md
日本語.md
emoji🔥.md
folder with spaces
```

---

# 8.9. Contract errors

Минимальные категории:

```text
not found
already exists
invalid path
operation failed
```

Raw backend error может отличаться.

Application-level semantics — нет.

---

# 8.10. Не включать platform-specific features

В общий contract НЕ включать:

```text
watcher
symlinks
permissions
native dialogs
```

---

# 8.11. CI

Browser suite:

```text
frontend job
```

Tauri suite:

```text
desktop integration job
```

---

## Gate Phase 8

- [ ] Один reusable contract.
- [ ] Browser проходит.
- [ ] Real Tauri проходит.
- [ ] Mock delegation tests могут остаться отдельно.
- [ ] Unicode/nested paths tested.
- [ ] CI integration есть.

---

# PHASE 9 — Filesystem Security Hardening

## Приоритет

P2

---

# 9.1. Инвентаризировать все filesystem calls

Найти:

```text
read
write
rename
copy
remove_file
remove_dir
remove_dir_all
create_dir
canonicalize
metadata
```

---

# 9.2. Создать security matrix

Для каждой функции:

```text
input source
relative/absolute
read/write/delete
vault-scoped?
boundary check?
symlink risk?
```

---

# 9.3. Path traversal

Tests:

```text
../outside.md
../../outside.md
folder/../../../outside.md
```

Windows:

```text
..\outside.md
```

---

# 9.4. Absolute path injection

Если API требует relative path:

```text
/etc/passwd
C:\outside.txt
\\server\share
```

reject.

---

# 9.5. Symlink escape

Structure:

```text
vault/link -> outside/
```

Проверить:

```text
read
write
delete
rename
```

через symlink.

---

# 9.6. Delete — самый высокий приоритет

Каждый:

```rust
remove_dir_all
```

должен быть отдельно audited.

---

# 9.7. Rename

Запретить:

```text
inside → outside
inside → symlink outside
```

---

# 9.8. Import/copy

Разделить semantics:

```text
source may be external
destination must be safe
```

---

# 9.9. Archive extraction

Если есть:

проверить:

```text
../../outside
```

Zip Slip-style entries.

---

# 9.10. TOCTOU

Искать:

```text
validate
await
mutate
```

Зафиксировать risks.

Не обязательно делать полный capability rewrite.

---

## Gate Phase 9

Все очевидные vault escape paths закрыты tests.

---

# PHASE 10 — Backend Module Cleanup

## Приоритет

P3

Только после correctness/security phases.

---

# 10.1. Frontmatter module

Цель:

```text
frontmatter/
  mod.rs
  parse.rs
  properties.rs
  identity.rs
  envelope.rs
```

---

# 10.2. Generic FS helpers

```text
fs/
  atomic_write.rs
  text_format.rs
```

---

# 10.3. Responsibilities

### parse.rs

```text
frontmatter detection
range calculation
parse status
```

### properties.rs

```text
user properties
```

### identity.rs

```text
amby-id
legacy identity
migration
```

### envelope.rs

```text
lossless raw operations
```

---

# 10.4. AI module

Цель:

```text
ai/
  mod.rs
  config.rs
  security.rs
  client.rs
  types.rs
```

---

# 10.5. Не делать provider framework без необходимости

Не вводить десятки traits ради будущего.

---

# 10.6. Refactor sequence

Перемещать маленькими шагами.

После каждого:

```bash
cargo test
```

---

## Gate Phase 10

Behavior unchanged, tests green, modules имеют понятные responsibilities.

---

# PHASE 11 — Frontend Application Layer

## Приоритет

P3

---

# 11.1. Найти orchestration hotspots

Искать user actions, которые трогают одновременно:

```text
storage
autosave
tabs
tree
vault
editor
index
```

---

# 11.2. Основные use-cases

```text
renameDocument
deleteDocument
closeDocument
openDocument
switchVault
```

---

# 11.3. Не начинать с классов

Сначала обычные use-case functions.

---

# 11.4. Создать application layer

Например:

```text
src/application/
  documents/
  vault/
  errors/
```

---

# 11.5. Rename Document

Централизовать:

```text
pending save
storage rename
autosave remap
tab update
tree update
active document
```

---

# 11.6. Failure handling

Если rename failed:

```text
UI остаётся на old path
autosave key не повреждён
tree не врёт
```

---

# 11.7. Switch Vault

Use-case должен владеть:

```text
flush dirty buffers
detach old subscriptions
open new vault
load state
attach watcher
```

---

# 11.8. Failure during switch

Не оставлять half-switched state.

---

# 11.9. Close/Delete

Централизовать autosave + tabs + storage sequencing.

---

# 11.10. Error normalization

Создать небольшой application error model.

Не сложный framework.

---

# 11.11. Tests

Mock dependencies.

Проверять не JSX, а orchestration sequence.

---

## Gate Phase 11

UI знает меньше о storage/autosave implementation details.

---

# PHASE 12 — Architecture Documentation

## Приоритет

P3

---

# 12.1. Обновить README structure

Она должна соответствовать реальному repository.

---

# 12.2. Architecture diagram

```text
React
↓
Application layer
↓
Storage / IPC
↓
Tauri commands
↓
Rust services
↓
Filesystem
↓
SQLite index
```

---

# 12.3. Source-of-truth

Явно документировать:

```text
Markdown authoritative
SQLite rebuildable
```

---

# 12.4. `amby-id`

Документировать:

```yaml
amby-id:
```

и generic `id` ownership.

---

# 12.5. Preservation policy

Документировать:

```text
unknown syntax preserved
comments preserved
opaque nodes preserved
```

---

# 12.6. Dual editor

```text
Tiptap = structured
CodeMirror = source
```

---

# 12.7. Browser vs desktop

Объяснить ограничения browser fallback.

---

# 12.8. Testing

Все реальные команды должны быть актуальны.

---

## Gate Phase 12

Новый contributor может понять core architecture из документации.

---

# PHASE 13 — Compatibility Vault

## Приоритет

P1 перед 1.0

Создать постоянный fixture:

```text
fixtures/compatibility-vault/
```

---

# 13.1. Fixtures

Добавить:

```text
plain markdown
frontmatter
comments
single quotes
double quotes
CRLF
BOM
Unicode
Russian
Ukrainian
Japanese
emoji
wikilinks
wikilink alias
wikilink heading
embeds
HTML
tables
code blocks
custom YAML
generic id
amby-id
duplicate amby-id
malformed YAML
unsupported syntax
```

---

# 13.2. Roundtrip suite

Для каждой note:

```text
open
modify known region
save
```

Проверить expected preserved parts.

---

# 13.3. Rebuild

Удалить SQLite.

Rebuild.

Markdown fixtures не должны измениться.

---

## Gate Phase 13

Compatibility vault green на всех поддерживаемых платформах.

---

# PHASE 14 — Native Desktop Smoke / UI E2E

## Приоритет

P1 перед 1.0

Существующие Rust desktop tests недостаточны для проверки WebView/Tauri wiring.

---

# 14.1. Минимальный native smoke

Проверить настоящим app binary:

```text
launch
open vault
open note
edit
save
close
reopen
```

---

# 14.2. Rename

Через UI:

```text
edit
rename
close
reopen
```

---

# 14.3. External edit

При запущенном UI внешний process изменяет файл.

UI должен корректно reconciliate state.

---

# 14.4. External rename/delete/create

Минимальные smoke scenarios.

---

# 14.5. Vault switch

Через реальный UI.

---

# 14.6. Не строить огромный E2E framework

Нужно 10–20 critical scenarios.

Не сотни flaky UI tests.

---

## Gate Phase 14

Critical native flows работают на реальном app binary.

---

# PHASE 15 — Performance Baseline

## Приоритет

P2

---

# 15.1. Synthetic vault generator

Размеры:

```text
1k
5k
10k
```

---

# 15.2. Variability

Notes должны иметь:

```text
folders
tags
wikilinks
different body sizes
Unicode
```

---

# 15.3. Measure

```text
initial scan
warm open
single-note reindex
search latency
memory after open
```

---

# 15.4. Пока не ставить произвольные hard limits

Сначала baseline.

---

# 15.5. Сохранить результаты

```text
docs/performance-baseline.md
```

---

## Gate Phase 15

Есть воспроизводимый baseline для будущих regression checks.

---

# PHASE 16 — Formal Release Gates

## Приоритет

P0 для Beta / 1.0

Создать:

```text
docs/release-1.0-checklist.md
```

---

# GATE A — Data Integrity

- [ ] `amby-id` authoritative.
- [ ] generic `id` user-owned.
- [ ] Legacy migration safe.
- [ ] Duplicate IDs diagnostic.
- [ ] YAML comments preserved.
- [ ] Quotes preserved.
- [ ] CRLF preserved.
- [ ] BOM preserved.
- [ ] Unsupported Markdown preserved.

---

# GATE B — Index

- [ ] same-size update detected.
- [ ] external watcher update works.
- [ ] malformed YAML searchable.
- [ ] SQLite rebuild safe.
- [ ] rebuild does not mutate Markdown.

---

# GATE C — Search

- [ ] BM25 final ranking.
- [ ] title bonus correct.
- [ ] punctuation tokenizer correct.
- [ ] snippets consistent with FTS.
- [ ] Russian.
- [ ] Ukrainian.
- [ ] Unicode.
- [ ] emoji.

---

# GATE D — Autosave

- [ ] normal autosave.
- [ ] rename during save.
- [ ] switch vault dirty note.
- [ ] close app dirty note.
- [ ] save failure remains dirty.

---

# GATE E — External editor

- [ ] edit.
- [ ] rename.
- [ ] delete.
- [ ] create.

---

# GATE F — Recovery

- [ ] atomic write failure.
- [ ] failed rename.
- [ ] failed save.
- [ ] history snapshot.
- [ ] recovery.
- [ ] recycle bin.

---

# GATE G — Filesystem Security

- [ ] traversal read blocked.
- [ ] traversal write blocked.
- [ ] traversal delete blocked.
- [ ] symlink escape blocked.
- [ ] recursive delete guarded.

---

# GATE H — AI Security

- [ ] private endpoint restrictions.
- [ ] link-local restrictions.
- [ ] redirect policy.
- [ ] timeout.
- [ ] response-size limit.
- [ ] credentials not leaked.

---

# GATE I — Platform

## Windows

- [ ] build
- [ ] installer
- [ ] open/edit/save
- [ ] rename
- [ ] external edit

## macOS

- [ ] build
- [ ] open/edit/save
- [ ] rename
- [ ] external edit

## Linux

- [ ] build
- [ ] open/edit/save
- [ ] rename
- [ ] external edit

---

# GATE J — CI

```bash
npm run verify:full
```

Green.

Также:

- [ ] TypeScript
- [ ] ESLint
- [ ] Prettier
- [ ] Vitest
- [ ] Knip
- [ ] rustfmt
- [ ] Clippy
- [ ] cargo test
- [ ] IPC bindings
- [ ] storage contracts
- [ ] desktop reliability
- [ ] native smoke
- [ ] builds/installers

---

# PHASE 17 — Release Candidate

## Приоритет

Final

---

# 17.1. Feature freeze

После входа в RC:

```text
NO new large features
```

---

# 17.2. Разрешены только

```text
bug fixes
release blockers
documentation corrections
test fixes
build fixes
```

---

# 17.3. RC workflow

```text
dev
↓
feature freeze
↓
release candidate
↓
full verification
↓
compatibility vault
↓
native smoke
↓
platform checks
↓
release
```

---

# Release blockers

Следующие проблемы ОБЯЗАНЫ блокировать 1.0:

```text
possible data loss
silent Markdown corruption
silent YAML corruption
latest autosave loss
note inaccessible because of Amby metadata
non-recoverable index divergence
vault filesystem escape
credential exposure
```

---

# Не являются автоматическим blocker

```text
minor animation issue
small visual inconsistency
non-critical search ranking imperfection
unfinished future Collections
missing plugin ecosystem
minor internal code organization issue
```

---

# Рекомендуемое разбиение на PR

Codex НЕ должен делать весь roadmap одним commit.

## Correctness

```text
PR 1 — legacy identity hardening
PR 2 — FTS snippet/title normalization
PR 3 — index residual correctness tests
PR 4 — malformed/frontmatter regression completion
```

## Storage / reliability

```text
PR 5 — storage contract framework
PR 6 — browser storage contract
PR 7 — real Tauri storage contract
PR 8 — missing desktop reliability scenarios
```

## Security

```text
PR 9 — filesystem path traversal hardening
PR 10 — symlink/delete/rename hardening
```

## Architecture

```text
PR 11 — frontmatter module decomposition
PR 12 — fs utilities extraction
PR 13 — AI module decomposition
PR 14 — frontend application layer foundation
PR 15 — rename use-case
PR 16 — vault switch use-case
PR 17 — close/delete/open use-cases
```

## Release preparation

```text
PR 18 — documentation sync
PR 19 — compatibility vault
PR 20 — native desktop smoke suite
PR 21 — performance baseline
PR 22 — release checklist / CI gates
```

---

# Codex autonomous decision rules

Codex может самостоятельно принимать небольшие технические решения, если соблюдены следующие условия.

## Можно самостоятельно

```text
выбрать имя helper
выбрать место небольшого internal type
выбрать fixture structure
добавить regression tests
реорганизовать private helper
выбрать BLAKE3/xxHash после сравнения текущих dependencies
```

---

## Нельзя самостоятельно менять

Без отдельного архитектурного основания:

```text
source-of-truth model
public file format
amby-id semantics
autosave guarantees
vault ownership model
editor architecture
sync model
supported platform policy
```

---

# Правило при обнаружении новой проблемы

Если Codex во время работы обнаружил новый bug:

### Если это data-loss/security P0/P1

Остановить текущий feature work.

Добавить:

```text
root cause
reproduction
severity
recommended fix
```

и исправить до продолжения.

### Если P2/P3

Создать отдельный TODO/issue и не раздувать текущий PR.

---

# Финальное состояние проекта

После выполнения roadmap должно быть истинно:

```text
Пользователь может взять существующий Markdown/Obsidian vault,
открыть его в Amby,
редактировать заметки,
параллельно использовать другой Markdown-редактор,
закрывать и открывать Amby,
переименовывать и перемещать файлы,
а затем полностью перестать использовать Amby —
и его Markdown останется валидным,
понятным другим приложениям,
не повреждённым и не привязанным к внутренней базе Amby.
```

После этого архитектура готова для активного развития:

```text
Collections
Databases
Git sync
AI workflows
advanced Canvas
plugin system
```

без накопления нового фундаментального техдолга.
