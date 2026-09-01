# Windows: отдельная ручная приёмка Amby Notes

Статус: **PARTIAL**, 1 сентября 2026 года: автоматические core/live-storage,
изолированный полный UI-smoke, сборка MSI/NSIS, точный NSIS
install/launch/uninstall и NTFS race/rollback barriers выполнены. Расширенная
ручная матрица остаётся частичной; недоступные среды явно отмечены BLOCKED.

NSIS install/launch/uninstall passed in an isolated directory on 2026-09-01,
including registry cleanup. The exact installed production executable passed
open/edit/autosave/full close/reopen/readback against a disposable vault. The real
settings directory was restored with both original files matching their preflight
SHA-256 manifest. The exact final artifacts report `NotSigned`: MSI SHA-256
`ADAA5D09A641C7343A84E5B2A28862CA8ECD7DA5994A891B84D722F4BF6CC6BA`, NSIS SHA-256
`BBEDCF0F6FCE7773AE4A98EAFCB003733386BAD2F0A193A992EDFC55E716F984`.
Symlink-тест остановлен системным отказом 1314 (недостаточно привилегий).
Подробности: [remaining-critical-progress.md](remaining-critical-progress.md).
Этот файл — инструкция,
а не свидетельство прохождения. Заполняй результат каждого шага после проверки.
MacOS/APFS, unit-тесты и успешная Windows-сборка не заменяют Windows runtime.

Оставшиеся задачи: [AUDIT_ISSUES.md](../AUDIT_ISSUES.md), особенно MANUAL-05.
Полный исторический протокол MANUAL-01—07: `git show 1d3f0d6:AUDIT_ISSUES.md`.
Контракты: `docs/vault-format.md`, `docs/markdown-compatibility.md`.

## 1. Безопасное окружение

- Используй отдельную Windows VM/тестовую учётную запись и только disposable
  vault. Не открывай рабочие заметки, не используй настоящие API-ключи.
- Отдельный bundle ID **не изолирует** глобальные настройки: приложение использует
  `%LOCALAPPDATA%\Amby\notes`. Отдельная учётная запись изолирует также Credential
  Manager; не переноси сюда пользовательские settings и WebView profile.
- Не форматируй существующие диски ради проверки. Для exFAT/FAT32 используй
  заранее подготовленный пустой носитель или тестовый том. Для сети — только
  выделенную тестовую папку, без чужих данных.
- Сохраняй evidence вне vault, `%TEMP%` и Git. Не удаляй fixture и логи при FAIL.
  Не включай ключи, ответы провайдера, личные пути и чужие записи Credential Manager
  в screenshots/логи. Отключать Defender, Gatekeeper-подобные проверки или UAC
  для прохождения теста не требуется.
- При первом FAIL останови соответствующий пакет, запиши ожидаемое/полученное,
  сохрани копию состояния и заведи отдельное исправление. Не отмечай недоступный
  носитель или неподтверждённую гонку как PASS.

Заполни паспорт проверки:

```text
Дата / проверяющий:
Windows edition, version, build:
Архитектура / CPU / RAM:
Commit / git status / локальные изменения:
Версия Amby / installer SHA-256:
WebView2 version:
Режим: установленная release-сборка / tauri dev:
Vault path (только тестовый):
Evidence path (не TEMP и не vault):
NTFS volume / case-sensitivity:
exFAT volume:
FAT32 volume:
Network protocol / server / mount / hard-link support:
```

## 2. Сборка и установка — WIN-BUILD

Если есть Windows installer **точно проверяемой ревизии**, используй его и
запиши SHA-256. macOS `.dmg` для Windows не подходит.

Для сборки из исходников нужны Git, Node 22.12+ и npm 10+, Rust MSVC toolchain,
Microsoft C++ Build Tools с Desktop development with C++ и WebView2.
Для MSI может потребоваться системный компонент VBScript. Актуальные шаги:
[официальные prerequisites Tauri](https://v2.tauri.app/start/prerequisites/#windows)
(проверены при составлении 31.08.2026). Это prerequisites Tauri, не обещание
поддержки Amby на любой версии Windows.

В PowerShell из **свежего checkout согласованного checkpoint-коммита**:

```powershell
git rev-parse HEAD
git status --short
node --version
npm --version
rustc -Vv
rustup show active-toolchain
npm ci
npm run verify
npm run audit:npm
npm run tauri build
```

Проверяй `$LASTEXITCODE` сразу после каждой команды; при ненулевом коде остановись.
`verify` уже включает Rust tests и bindings export. В нём ожидается exit 0;
если bindings отличаются, сохрани diff и проверь ревизию — не стирай и не
стейджи файл только ради зелёного результата.
`audit:rust` в репозитории использует Bash: при доступных Git Bash и cargo-audit
выполни `npm run audit:rust` и сохрани результат; иначе запиши BLOCKED для этого
шага. Не добавляй новые advisory exceptions. Linux CI audit не заменяет runtime.

- [x] **WIN-BUILD.1** Все доступные команды завершились успешно; логи сохранены.
- [x] **WIN-BUILD.2** Выбранный `.msi`/NSIS `.exe` из
      `src-tauri/target/release/bundle/` устанавливается и запускается в тестовом
      профиле. Отдельно запиши, какой тип installer проверен.
- [ ] **WIN-BUILD.3** Первое окно не пустое; можно выбрать тестовый vault,
      создать заметку, сохранить и прочитать её после полного перезапуска.
- [x] **WIN-BUILD.4** Зафиксирована подпись (`NotSigned`); отдельный SmartScreen
      warning-flow не запускался. Успешная
      сборка сама по себе не доказывает доверенную подпись или безопасную установку.

## 3. Минимальные fixtures и снимки состояния

Создай через Amby заметки `CaseNote`, папку `CaseFolder` с дочерней заметкой и
заметку `CaseBundle`. В последней включи Canvas/Sketch и вложенную заметку, чтобы
получился bundle с main Markdown, `.canvas`, `.excalidraw` и child. Дождись save.
Для ссылок создай отдельную заметку с wikilink на `CaseNote`.

После закрытия приложения скопируй тестовый vault в отдельную backup-папку.
Сохрани список относительных путей и SHA-256 исходных файлов. `.amby` фиксируй
отдельно: index/session могут меняться без изменения исходных заметок.
Один и тот же набор проверяй на каждой заявляемой filesystem.

Пример безопасной фиксации hashes в PowerShell; переменные указывают только на
созданные для проверки папки, не на диск целиком:

```powershell
$testVault = Read-Host 'Полный путь disposable vault'
$testEvidence = Read-Host 'Полный путь существующей папки evidence вне vault'
$resolvedVault = (Resolve-Path -LiteralPath $testVault).Path.TrimEnd('\')
if (-not (Test-Path -LiteralPath $testEvidence -PathType Container)) {
  throw 'Создай отдельную папку evidence и повтори'
}
$sourceFiles = Get-ChildItem -LiteralPath $resolvedVault -File -Recurse -Force |
  Where-Object { $_.FullName -notmatch '[\\/]\.amby[\\/]' }
$sourceFiles | ForEach-Object {
  [PSCustomObject]@{
    Path = $_.FullName.Substring($resolvedVault.Length + 1)
    Bytes = $_.Length
    SHA256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
  }
} | Export-Csv -LiteralPath (Join-Path $testEvidence ('hashes-' + [Guid]::NewGuid() + '.csv')) -NoTypeInformation -Encoding UTF8
```

После rename сравнивай hash соответствующего файла по ожидаемому новому пути.
У inbound wikilink допускается только ожидаемое изменение target; для него
проверь точный diff и наличие pre-refactor snapshot. Не требуй неизменности
всего vault после операции, которая намеренно меняет ссылку.

## 4. Filesystem portability — обязательное продолжение MANUAL-05

| Шаг       | Где выполнить            | Действие и критерий PASS                                                                                                                                                                                                                                                                                                     |
| --------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WIN-FS.1  | Windows / NTFS           | В UI переименовать `CaseNote` → `casenote` → `CaseNote`. На диске ровно одна заметка с нужным регистром, stable ID и body сохранены; вкладка и ссылка открывают правильную заметку.                                                                                                                                          |
| WIN-FS.2  | Windows / NTFS           | Аналогично `CaseFolder` → `casefolder` → `CaseFolder`. Все children доступны, их ID/content неизменны; дерево не дублируется после restart.                                                                                                                                                                                  |
| WIN-FS.3  | Windows / NTFS           | Аналогично переименовать bundle. Container, main Markdown, Canvas и Excalidraw согласованно меняют basename; children/assets сохранены. Все слои открываются после restart.                                                                                                                                                  |
| WIN-FS.4a | Каждая заявляемая FS     | Заранее создать target с sentinel `DO-NOT-OVERWRITE-WIN`. Попробовать rename/create/import в занятый путь. Допустим безопасный отказ или выбор другого имени по контракту операции; sentinel byte-exact, исходник цел. Это только pre-existing collision, не race.                                                           |
| WIN-FS.4b | Каждая заявляемая FS     | **PASS для NTFS 2026-09-01.** Отдельно проверить target, появившийся **между проверкой и публикацией**. Нужен воспроизводимый timing trace/barrier в изолированном тестовом драйвере. Чужой target остаётся byte-exact; операция не подтверждает overwrite; своих temp/reservation не оставляет. Другие FS остаются BLOCKED. |
| WIN-FS.5  | Windows / NTFS           | **PASS 2026-09-01.** Воспроизвести отказ в середине bundle rename и rollback: после успешного первого шага заблокировать следующий шаг контролируемым fault injection/точечным sharing lock. Вернуться должны все исходные имена и bytes, без смешанного container/main/sidecars.                                            |
| WIN-FS.6  | Реальный exFAT           | Создать заметку, импортировать файл и изображение, переоткрыть, сравнить bytes. Повторить WIN-FS.4a/4b; проверить фактический fallback без hard links, а не выводить его из успешного NTFS-теста.                                                                                                                            |
| WIN-FS.7  | Реальный FAT32           | Отдельно повторить WIN-FS.6; использовать небольшие файлы, не проверять 100MB лимит на многогигабайтных fixtures.                                                                                                                                                                                                            |
| WIN-FS.8  | Выделенный SMB/NFS mount | Записать фактические свойства share/hard-link support, повторить create/import/collision и restart. Для конфигурации без hard links отдельно подтвердить fallback. Если такой mount недоступен, BLOCKED. Не отключать общую сеть ради сбоя.                                                                                  |

Для WIN-FS.4b/5 **не меняй production-код наугад** и не пытайся многократным
ручным кликом выдать preflight collision за гонку. При отсутствии готового
драйвера передай эти два шага агенту на Windows с требованием временных
барьеров в копии проекта и реальных файловых операций. Existing Rust tests
`case_only`, `rollback`, `no_replace` полезны как регрессии, но не закрывают эти
ручные строки сами по себе. Сохрани injection diff и timing log с результатом.

Фактический NTFS-прогон 2026-09-01 использовал test-only thread-local barriers,
которые отсутствуют в release-сборке. `target_created_at_publish_barrier_is_never_replaced`
создал чужой target непосредственно перед hard-link publication: операция вернула
`AlreadyExists`, sentinel остался byte-exact, в каталоге остался ровно один файл.
`bundle_rename_failure_after_first_inner_step_rolls_back_every_file` успешно
переименовал main внутри уже перемещённого container, затем ввёл ошибку перед
вторым inner step: old container/main/Canvas/Excalidraw/child вернулись с исходными
bytes, нового container и временных siblings нет. Evidence:
`.release-evidence/windows-fs-boundaries.log` и
`.release-evidence/windows-fs-boundaries-rollback.log`; injection находится
только под `cfg(test)` в `frontmatter.rs` и `bundle/execute.rs`.

## 5. Windows data-safety smoke

Это перенос проверок на Windows, не новый PASS старых macOS-пакетов.
Подробные альтернативные ветки доступны в MANUAL-разделах исторического
протокола: `git show 1d3f0d6:AUDIT_ISSUES.md`.

- [ ] **WIN-DATA.1 / MANUAL-01:** открыть одну заметку в двух окнах. Чистое окно
      получает изменения; при конкурирующих unsaved edits появляется conflict.
      Проверить accept external, explicit local save и manual merge; не терять
      вторую версию молча. Закрытие одного окна не ломает watcher другого.
- [ ] **WIN-DATA.2 / MANUAL-02:** внешние edit/rename/delete в disposable vault
      отражаются в дереве. Dirty документ не закрывается и не перезаписывается
      молча. Explicit restore deleted note сохраняет ID/frontmatter; если путь
      уже занят sentinel-файлом, восстановление отказывается его перезаписывать.
- [ ] **WIN-DATA.3 / MANUAL-03:** изменить заметку и немедленно закрыть окно/
      переключить vault. После reopen текст сохранён. Отдельно в тестовом
      профиле проверить crash между durable draft и save; завершать только точно
      выбранный PID тестового Amby. Без доказанного интервала — BLOCKED.
- [ ] **WIN-DATA.4 / MANUAL-03:** при restart отличается recovery draft — есть
      явный выбор accept/decline. Проверить обе ветки и failure/retry; draft не
      исчезает до успешного save. Повторить для Canvas. Windows folder Read-only
      checkbox не считается доказательством запрета записи: нужна проверенная
      ограниченная ACL/контролируемая ошибка только в тестовой папке.
- [ ] **WIN-DATA.5 / MANUAL-03:** fixture с UTF-8 BOM, CRLF, unknown YAML и
      пустыми строками в конце. После обычного save и восстановления ровно один
      BOM в byte 0, ожидаемые CRLF и YAML сохранены. Без редактирования hash тот же;
      после редактирования сравниваются отдельно неизменяемые части.
- [ ] **WIN-DATA.6 / MANUAL-04:** history preview/restore работает, перед restore
      создан snapshot текущей версии. Corrupted snapshot не восстанавливается.
      Explicit cleanup сохраняет последние 20 версий каждой заметки и согласует
      manifest/files. Учитывай 10-минутное coalescing autosaves: быстрое печатание
      не создаёт 21 независимый snapshot. Interrupted cleanup — отдельный
      controlled сценарий, иначе BLOCKED.
- [ ] **WIN-DATA.7:** удаление через Amby переносит данные в vault-local
      `.amby/trash`; restore возвращает main и слои. Системная корзина не является
      достаточным evidence. Полную `.amby` не удалять: properties/history/recovery
      не равнозначны одному rebuildable index.

## 6. Windows UI, credentials и search smoke

- [ ] **WIN-UI.1 / MANUAL-06:** Explorer → editor batch file + image + image
      вставляется в исходном порядке, включая пустой хвост редактора. Проверить
      обычный и используемый scaled DPI. Hash импортированных assets совпадает.
- [ ] **WIN-UI.2:** закрыть вкладку во время column resize, не закрывая всё
      приложение; отпустить мышь. Guide/label исчезают, редактор другой заметки
      работает. Self/descendant tree drop безопасно отклонён, допустимый move работает.
- [ ] **WIN-UI.3:** Quick Open различает одинаковые имена; split не создаёт
      две editable-панели одного file ID. Close/reopen до autosave сохраняет
      dirty buffer и все последующие edits; dirty снимается только после save.
- [ ] **WIN-KEY.1 / MANUAL-07:** в тестовом профиле создать модель и сохранить
      **синтетический** ключ без отправки запроса провайдеру. После полного
      restart key остаётся доступен и masked; settings содержит credential ID,
      не secret. Проверить только созданную тестовую запись Credential Manager
      сервиса `com.ambynotes.ai`, не экспортировать чужие записи.
- [ ] **WIN-KEY.2:** whitespace-only update и Delete удаляют тестовый credential;
      после restart secret отсутствует, reference не остаётся висячим.
- [ ] **WIN-KEY.3:** controlled settings write failure виден в UI, старый файл
      сохранён. Controlled AI network/timeout/HTTP errors не содержат secret,
      request content или provider response body. Использовать локальный stub,
      не реальные платные вызовы; неизвестную ветку записать NOT RUN.
- [ ] **WIN-PERF:** на synthetic vaults 1k/10k измерить первый и повторные
      name/content/tag запросы, задержку ввода и выдачи. Проверить limit 50,
      debounce, clear-before-dispatch и отсутствие read-all IPC fan-out.
      Старый ответ не заменяет новый; физическая отмена backend SQL сейчас не
      реализована. Не переносить macOS ms в Windows-результаты.

## 7. Итог и передача результата

Для каждой строки сохрани запись (галочка без записи недостаточна):

```text
Шаг: WIN-...
Среда / filesystem / commit:
Статус: PASS | FAIL | BLOCKED | NOT RUN | NOT_APPLICABLE
Действия / ожидалось:
Получено:
Evidence: относительные имена log/screenshot/before-after hashes
Доказательство timing/failure boundary, если требуется:
Примечание / issue:
```

| Раздел             | Итог 2026-09-01                                                                                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| WIN-BUILD          | PARTIAL: build/install/open/edit/save/restart/uninstall PASS; clean create-note в установленной сборке и signed/SmartScreen flow не доказаны.                                  |
| WIN-FS.1—5 / NTFS  | PARTIAL: 4b/5 PASS с реальными файлами и barriers; case-only file/folder/bundle и collision проходят Rust tests, но новый UI-прогон не был виден automation API.               |
| WIN-FS.6 / exFAT   | BLOCKED: подготовленного disposable exFAT volume нет.                                                                                                                          |
| WIN-FS.7 / FAT32   | BLOCKED: подготовленного disposable FAT32 volume нет.                                                                                                                          |
| WIN-FS.8 / network | BLOCKED: выделенного SMB/NFS mount нет.                                                                                                                                        |
| WIN-DATA           | PARTIAL: native UI external/conflict/recovery smoke и backend failure/history/trash/BOM contracts PASS; multi-window, crash window и ACL UI branches не доказаны.              |
| WIN-UI             | PARTIAL: media order/DPI, resize cleanup, tree transaction, Quick Open/split/dirty contracts проходят tests; полный ручной пакет не повторён.                                  |
| WIN-KEY            | PARTIAL: реальный synthetic Credential Manager store/masked readback/exact backend read/delete PASS, остаточных test credentials нет; UI model/settings branches не повторены. |
| WIN-PERF           | PARTIAL: Windows 1k/10k backend scan/reopen/update/search PASS; WebView input latency и resident memory не измерены.                                                           |

Закрой тестовые процессы, удали только созданные тестовые credentials через UI,
сохрани fixture/evidence до приёмки. Не удаляй их автоматически и не коммить
vault/секреты/установщики. Верни заполненную копию этого файла и безопасные логи.

`MANUAL-05` может стать PASS только для реально проверенной матрицы. Прохождение
NTFS не закрывает exFAT/FAT32/network. Windows x64 не подтверждает Windows ARM64.
Готовность общего релиза определяется отдельным повтором FINAL-02 после анализа
результатов; этот чек-лист сам не меняет заявленную поддержку платформ.
