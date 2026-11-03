# Безопасность данных и платформы: что осталось

## Ключ подписи модулей (высокая важность)

Приватная часть официального ключа `amby-official-2026` лежит в `scripts/build-modules.mjs` и
`src/lib/modules/package-manager/validator.ts`. Владелец отложил замену 2026-10-02. Замена обязательна до
включения сторонних модулей (`INSTALLED_MODULE_EXECUTION_ENABLED`), публикации пакетов и анонса плагинов.
Также нужно: подпись всего manifest и ограничение размера скачивания во время потока. Подробности:
[../../security-advisories.md](../../security-advisories.md).

## Хвосты протокола записи (из передачи 2026-09/10)

Полный текст: локальный архив, `docs/archive/handoffs/claude-handoff.md`.

- Общий `JournalFile` и исход `recovery-required` вне Relation; блокировка только затронутой базы.
- Тест с убийством процесса в матрице отказов.
- Окно разрешения конфликта при внешней правке; общая защита записи Canvas/Excalidraw.
- Управление карантинными журналами и корзиной (сейчас только уведомление).
- Матрица restart/conflict в настоящем WebView.
- Итоговая независимая приёмка.

## Windows и Linux

- Чек-лист [../../windows-release-checklist.md](../../windows-release-checklist.md): открыты WIN-DATA, WIN-UI,
  WIN-KEY, WIN-PERF.
- Корзина Windows (`SHFileOperationW`) может удалить без предупреждения большие файлы и файлы на сетевых дисках.
- Linux: нативная проверка хранилища отложена ([../../native-storage-contract.md](../../native-storage-contract.md)).

## Производительность

Замеры: [../../performance-baseline.md](../../performance-baseline.md). Не начаты S7.2–S7.4; сначала повторный
замер после инкрементального дерева.
