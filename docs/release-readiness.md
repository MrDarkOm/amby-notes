# FINAL-02: готовность релиза на 31 августа 2026 года

Итог: **RELEASE_BLOCKED**. Обновлено после локальных исправлений 31.08.2026.
Финальная проверка выполнена; это отрицательное
решение о production release, а не невыполненная проверка и не новый FAIL
исторических MANUAL-пакетов. Публикация, push и изменение support matrix не
выполнялись. Непроверенная Windows-часть вынесена в отдельный
[Windows-чек-лист](windows-release-checklist.md).

## Проверяемая сборка

- Ветка `dev`: накопленные исправления MANUAL-01—07, PERF-01 и первоначальный
  FINAL-02 зафиксированы checkpoint-коммитом `8d9bf73`. Поверх него проверено
  исправление macOS bundle signing и добавлен regression test.
- macOS 26.6.2 arm64, Apple M5, 16 GiB RAM, APFS; 31.08.2026 EEST.
- `npm run tauri build` создал production `.app` и
  `Amby_0.1.0_aarch64.dmg`; приложение не запускалось в пользовательском профиле.
- SHA-256 DMG:
  `bd27688e7dd63fbfbe7d516879635e6ba74759593aec71157f3e0810d0c41c5a`.
- Сохранённая копия:
  `.release-evidence/2026-08-31/fixes/Amby_0.1.0_aarch64_adhoc.dmg`.
  Это корректно ad-hoc подписанная локальная сборка, **не Developer ID signed /
  notarized distribution-ready релиз**. Первая сборка с SHA-256
  `24f2e6de4396987a5990cd2402ec7039cc72b05ca23b6a6a96e753ae391cda37`
  оставлена в `build/` как историческое evidence ошибки подписи.

## Автоматические проверки

| Проверка                            | Фактический результат                                                           |
| ----------------------------------- | ------------------------------------------------------------------------------- |
| TypeScript, ESLint                  | PASS                                                                            |
| Vitest                              | PASS: 342 теста, 58 файлов после signing regression                             |
| Prettier, Knip, Rustfmt             | PASS; Knip сообщает прежнюю configuration hint `.css`                           |
| Strict Clippy                       | PASS                                                                            |
| Rust tests                          | PASS: 147 тестов; дополнительный bindings export test PASS                      |
| Актуальность генерации bindings     | PASS: повторный экспорт byte-exact, см. ниже                                    |
| `npm run verify` целиком            | **PASS, exit 0**: на checkpoint и повторно после signing fix; bindings без diff |
| Frontend production build           | PASS: `npm run build` выполнен как beforeBuildCommand Tauri                     |
| `npm run audit`                     | PASS: npm 0 vulnerabilities; RustSec без новых блокирующих advisories           |
| Rust warning / exceptions           | Прежний `chacha20 0.10.1` yanked; allowlist не расширялась, review 24.11.2026   |
| `npm run tauri build`               | PASS: release `.app` и arm64 `.dmg`                                             |
| `hdiutil verify`                    | PASS, exit 0; целостность DMG, не подпись приложения                            |
| `codesign --verify --deep --strict` | **PASS, exit 0** после полной ad-hoc подписи bundle                             |
| `git diff --check`                  | PASS                                                                            |

Ранее Tauri не подписывал весь `.app`: оставалась linker/ad-hoc подпись бинарника
без resource seal, strict check возвращал exit 1. Теперь macOS-only config
явно задаёт `bundle.macOS.signingIdentity: "-"`; Tauri подписывает бинарник и
bundle до создания DMG. Подтверждены `Identifier=amby-notes`, hardened runtime,
`Sealed Resources version=2`, strict check exit 0. Regression закрепляет настройку.

`TeamIdentifier` по-прежнему не задан: ad-hoc не создаёт доверие Apple.
Developer ID signing/notarization остаются отдельным этапом; системная защита
не отключалась. Tauri поддерживает настоящую identity через
`APPLE_SIGNING_IDENTITY` либо release config override; секреты не хранятся в Git.
См. [официальную инструкцию Tauri](https://v2.tauri.app/distribute/sign/macos/).

## Bindings и подготовка изменений

Generated diff нужен: Rust экспортирует `restore_deleted_note`, тип
`RestoreDeletedNoteRequest` и `NoteReadOutcome.source`; frontend использует их
для безопасного восстановления удалённой заметки. Команда зарегистрирована в
`specta_builder`. Удаление этого diff вернуло бы устаревшую IPC-границу.

`src/lib/bindings.ts` не редактировался вручную; повторный экспорт не изменил
SHA-256 `c7a1ae82235a41ed90a642eb3413cfe0df8414c25b18410096a3592942e66efa`.
Прежний ненулевой `verify` был обусловлен сравнением с Git index, не генератором.
Ни check, ни generated файл не ослаблялись/стирались; файл не стейджился отдельно
только ради зелёного результата.

По явному запросу пользователя создан checkpoint `8d9bf73`: backend, storage
boundary, generated bindings, UI/lifecycle fixes, связанные тесты и документы
включены вместе (64 файла). На нём `npm run verify` завершился exit 0.
Дополнительно проверен signing fix: 342 Vitest, 147 Rust, полный verify exit 0.

Push в `https://github.com/MrDarkOm/amby-notes.git`, ветку `dev`, остановлен
auto-review как чувствительная передача кода во внешний remote; требуется
явное подтверждение этого destination/payload. Повтор через другой транспорт
или force push не выполнялся. Удалённый CI для этих изменений не подтверждён.

Классы накопленных изменений для просмотра:

- MANUAL-01/02: close lifecycle/capability, watcher rename/delete, explicit
  no-replace restore и полный source template через IPC.
- MANUAL-03: recovery-aware session loading, Canvas load deduplication,
  сохранение BOM/CRLF и dirty state.
- MANUAL-04/05: history retention/restore integrity, filesystem no-replace
  fallback и collision regressions.
- MANUAL-06: native media-drop mapping, split control, pending-save lifecycle.
- MANUAL-07: native keyring backends, credential read-back, settings errors,
  безопасная классификация AI ошибок и регрессии.
- PERF-01/FINAL-02: результаты измерений, Windows checklist и release decision.

Эта группировка не заменяет независимый code review. Сам FINAL-02 добавил
документы и ignore-правило; последующее исправление меняет только macOS build
configuration и regression test, не storage/runtime логику или permissions.

## Evidence ручной приёмки

| Пакет     | Исторический результат                                | Что проверено сейчас                                                                                              |
| --------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| MANUAL-01 | PASS по подробному журналу и наблюдениям пользователя | Указанный `amby-manual-liPGgV` и terminal log отсутствуют; raw evidence не перепроверен                           |
| MANUAL-02 | PASS после fix/retest                                 | `amby-manual-Vt4mp6` и `manual-02-final-pass.txt` отсутствуют                                                     |
| MANUAL-03 | PASS после recovery fixes                             | `manual-03-retest.txt` и указанные ранние fixtures/screenshots отсутствуют; записи журнала сохранены              |
| MANUAL-04 | PASS                                                  | `manual-04-retest.txt` отсутствует; позднее переиспользованный vault не заменяет прежний manifest checkpoint      |
| MANUAL-05 | PARTIAL: macOS/APFS PASS, остальные среды BLOCKED     | `manual-05-macos.txt` отсутствует; Windows/exFAT/FAT/network runtime по-прежнему не выполнен                      |
| MANUAL-06 | PASS на macOS                                         | Доступны итоговый отчёт, выбранные screenshots и связанные fixtures; скопированы в локальный архив                |
| MANUAL-07 | PASS на macOS                                         | Доступны итоговый отчёт, store/restart/delete/whitespace/settings JSON, 24 AI IPC cases и три UI error результата |
| PERF-01   | PASS на macOS/APFS                                    | Два отчёта 1k/10k, сырые timings/IPC traces, manifest, integrity record и screenshots доступны и сохранены        |

Причина и момент исчезновения ранних файлов не установлены. Исторические PASS
не переписаны задним числом, но полная независимая сверка первичного evidence
MANUAL-01—05 сейчас невозможна. Перед production release нужны найденный архив
оригинальных результатов или новый изолированный runtime-прогон недоступных
data-safety доказательств. Unit-тесты и пересказ журнала не названы новым runtime PASS.

## PERF-01: решение для release gate

Для проверенного synthetic диапазона до 10 000 заметок примерно по 3,9 KB на
macOS/APFS PERF-01 **не является блокером**: smoke прошёл, median warm
name/content/tag на 10k — 3/24/21 ms; UI с debounce — 230/258/259 ms.
Первичная index+tree активация — 6,63 s плюс 0,888 s preflight.

Это не SLO и не benchmark холодного диска; ОС-кэш не очищался. Большие документы,
другая нагрузка, Windows и другие filesystems не подтверждены. Cancellation
означает отбрасывание устаревшего UI response, не прерывание backend SQL.

## Что блокирует production release

1. Не восстановлен/не повторён отсутствующий raw evidence ранних data-safety
   пакетов. Журнал содержит исторические PASS, но не заменяет потерянные артефакты.
2. Windows, exFAT, FAT32 и network-часть MANUAL-05 не проверены. Вынос в отдельный
   файл переносит работу, **не исключает платформы из заявленной поддержки**.
3. Полная локальная ad-hoc подпись исправлена, но доверенная production
   Developer ID signing/notarization требует identity и отдельного release
   workflow. Push и удалённые проверки также ожидают подтверждённого доступа.

Linux runtime, macOS Intel и Windows ARM64 этим прогоном также не подтверждены;
не распространять на них результаты macOS arm64 автоматически.

## Где лежат результаты

- `AUDIT_ISSUES.md`: итог FINAL-02 и следующий шаг.
- `docs/windows-release-checklist.md`: самостоятельный Windows-протокол.
- `.release-evidence/2026-08-31/`: локальный архив вне `%TEMP%`/`/private/tmp`,
  исключённый из Git правилом `/.release-evidence/`.
  `inventory.json` содержит наличие/отсутствие исходного evidence и SHA-256 копий;
  `source-snapshot.json` — HEAD и hashes изменённых файлов.
- `checkpoint.patch`: подготовленный локальный diff всех накопленных tracked и
  untracked исходников/тестов/документов. Это не commit и не независимый review;
  не применять поверх того же рабочего дерева. Перед фиксацией проверить состав.
- `final/`: verify/audit/build/DMG/signing logs и снимки документов.
- `manual/`, `perf/`: отобранное доступное evidence без пользовательских vaults
  и секретов. Исходные временные каталоги не удалялись.
- `build/`: исторический DMG первой сборки с ошибкой resource seal.
- `fixes/`: новые verify/build/signing/DMG logs и исправленный ad-hoc DMG;
  предыдущие артефакты не перезаписываются.

Архив не является резервной копией на другом физическом носителе. Его можно
скопировать в своё защищённое хранилище после проверки состава; не добавлять
его, `.amby`, vault data, `dist` или `src-tauri/target` в Git.

После push, Windows-прогона, восстановления evidence и решения Developer ID signing
повторить FINAL-02. До этого `RELEASE_READY` не установлен.
