# FINAL-02: готовность релиза на 31 августа 2026 года

Итог: **RELEASE_BLOCKED**. Финальная проверка выполнена; это отрицательное
решение о production release, а не невыполненная проверка и не новый FAIL
исторических MANUAL-пакетов. Публикация, push и изменение support matrix не
выполнялись. Непроверенная Windows-часть вынесена в отдельный
[Windows-чек-лист](windows-release-checklist.md).

## Проверяемая сборка

- Ветка `dev`, baseline `9294076` + накопленные исправления MANUAL-01—07 и
  PERF-01. На момент проверки это рабочее дерево, не checkpoint-коммит.
- macOS 26.6.2 arm64, Apple M5, 16 GiB RAM, APFS; 31.08.2026 EEST.
- `npm run tauri build` создал production `.app` и
  `Amby_0.1.0_aarch64.dmg`; приложение не запускалось в пользовательском профиле.
- SHA-256 DMG:
  `24f2e6de4396987a5990cd2402ec7039cc72b05ca23b6a6a96e753ae391cda37`.
- Сохранённая копия: `.release-evidence/2026-08-31/build/Amby_0.1.0_aarch64.dmg`.
  Это локальный результат сборки, **не подписанный distribution-ready релиз**.

## Автоматические проверки

| Проверка                            | Фактический результат                                                                  |
| ----------------------------------- | -------------------------------------------------------------------------------------- |
| TypeScript, ESLint                  | PASS                                                                                   |
| Vitest                              | PASS: 341 тест, 57 файлов                                                              |
| Prettier, Knip, Rustfmt             | PASS; Knip сообщает прежнюю configuration hint `.css`                                  |
| Strict Clippy                       | PASS                                                                                   |
| Rust tests                          | PASS: 147 тестов; дополнительный bindings export test PASS                             |
| Актуальность генерации bindings     | PASS: повторный экспорт byte-exact, см. ниже                                           |
| `npm run verify` целиком            | **FAIL, exit 1**: последний `git diff --exit-code` видит накопленный diff bindings     |
| Frontend production build           | PASS: `npm run build` выполнен как beforeBuildCommand Tauri                            |
| `npm run audit`                     | PASS: npm 0 vulnerabilities; RustSec без новых блокирующих advisories                  |
| Rust warning / exceptions           | Прежний `chacha20 0.10.1` yanked; allowlist не расширялась, review 24.11.2026          |
| `npm run tauri build`               | PASS: release `.app` и arm64 `.dmg`                                                    |
| `hdiutil verify`                    | PASS, exit 0; целостность DMG, не подпись приложения                                   |
| `codesign --verify --deep --strict` | **FAIL, exit 1**: `code has no resources but signature indicates they must be present` |
| `git diff --check`                  | PASS                                                                                   |

Подпись бинарника — linker/ad-hoc; `TeamIdentifier` не задан, resource seal
отсутствует. Developer ID signing и notarization этим прогоном не подтверждены.
Не переименовывать это в успешную строгую проверку подписи и не предлагать
отключение системной защиты вместо release signing workflow.

## Bindings и подготовка изменений

Generated diff нужен: Rust экспортирует `restore_deleted_note`, тип
`RestoreDeletedNoteRequest` и `NoteReadOutcome.source`; frontend использует их
для безопасного восстановления удалённой заметки. Команда зарегистрирована в
`specta_builder`. Удаление этого diff вернуло бы устаревшую IPC-границу.

`src/lib/bindings.ts` не редактировался вручную; повторный экспорт не изменил
SHA-256 `c7a1ae82235a41ed90a642eb3413cfe0df8414c25b18410096a3592942e66efa`.
Ненулевой `verify` обусловлен сравнением с Git index, а не ошибкой генератора.
Ни check, ни generated файл не ослаблялись/стирались; файл не стейджился отдельно
только ради зелёного результата.

Для checkpoint необходимо совместно включить backend, storage boundary,
generated bindings, UI/lifecycle fixes, связанные тесты и документацию.
Локальный checkpoint-коммит запрошен отдельно; без подтверждения коммит и push
не выполняются. После checkpoint повторить `npm run verify` и записать exit 0.

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

Эта группировка не заменяет отдельный независимый code review. Текущая задача
не меняла runtime-код: добавлены release-документы и ignore-правило для evidence.

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

1. `verify` ещё не даёт exit 0 для зафиксированного checkpoint исходников.
2. Не восстановлен/не повторён отсутствующий raw evidence ранних data-safety
   пакетов. Журнал содержит исторические PASS, но не заменяет потерянные артефакты.
3. Windows, exFAT, FAT32 и network-часть MANUAL-05 не проверены. Вынос в отдельный
   файл переносит работу, **не исключает платформы из заявленной поддержки**.
4. Строгая проверка подписи `.app` не проходит; production signing/notarization
   требует отдельного release workflow и соответствующих разрешений/identity.

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
- `build/`: сохранённый DMG указанного SHA-256.

Архив не является резервной копией на другом физическом носителе. Его можно
скопировать в своё защищённое хранилище после проверки состава; не добавлять
его, `.amby`, vault data, `dist` или `src-tauri/target` в Git.

После checkpoint, Windows-прогона, восстановления evidence и решения signing
повторить FINAL-02. До этого `RELEASE_READY` не установлен.
