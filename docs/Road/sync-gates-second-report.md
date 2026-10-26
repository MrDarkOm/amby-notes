# Синхронизация: разбор второго прогона ворот

Основание: [GitHub Actions 40203799332](https://github.com/MrDarkOm/amby-notes/actions/runs/40203799332),
код `f8cc8c14cb9d8d8a60868c373139f42e55697aa5`. Это разбор результата, а не разрешение
на синхронизацию настоящих заметок: `GATES_PASSED` остаётся `false`.

## Результат прогона

### Повтор на `20fff98` (26 октября)

[Прогон 40281140178](https://github.com/MrDarkOm/amby-notes/actions/runs/40281140178)
завершил все 64 000 сценариев без ошибок и INFRA; самопроверки симулятора прошли.
Мутации вернули 62 из 64 частей: 1335 пойманы, 45 выжили, 155 не собираются,
таймаутов нет. Части 30 и 31 прерваны остановкой runner, в том числе при повторе
упавших заданий (attempt 2). Ворота остаются незавершёнными.

В обеих частях есть мутация `util::parent`, возвращающая постоянный `Some("")`
или `Some("xyzzy")`. В `ancestors` это вызывает бесконечный цикл с ростом `Vec`.
Это объясняет возможное исчерпание памяти, но журнал runner не доказывает причину
остановки. Добавлен прямой unit-тест `parent_stops_at_the_root_and_removes_one_component`:
он проверяет окончание обхода и удаление одного компонента, выполняется в core lib
до интеграционных сценариев и не вызывает `ancestors` на сломанном `parent`.
Локальный cargo-mutants 27.1.0: baseline зелёный, обе мутации пойманы, таймаутов нет
(2 мутанта за 17 секунд). Рабочий код движка и замороженные тесты не менялись.

Новый выживший вариант `push.rs:714`, замена `&&` на `||` в фильтре
`!base.deleted && base.body_id.is_some()`, равнозначен для допустимого состояния:
`check_header` требует тело у живого файла и отсутствие тела у удалённого объекта.
В этих двух случаях оба условия совпадают. У живой папки тела нет, но она не может
быть базой отправляемого файла с тем же ID (`check_kind_unchanged`); изменения без
тела отбрасываются перед этим фильтром. Новому файлу без записи в `state.items`
оба варианта оставляют `old_size = 0`. Остальные выжившие варианты требуют сверки
с прежней таблицей после получения всех 64 частей; неполный результат не закрывает ворота.

Ниже сохранены результаты исходного прогона `f8cc8c1`.

- Симуляция: 63 998 успешных сценариев из 64 000. Зерно `23390` упало в обоих режимах
  (`quick`, `folders`) с `Unexpected: device 1: the pass ended with Busy` на шаге 19.
- Самопроверка симулятора на четырёх стартовых зёрнах прошла.
- Мутации: 62 из 64 частей вернули результаты: 1272 пойманы, 108 выжили, 150 не собираются,
  таймаутов нет. Части 25 и 26 прерваны остановкой runner; артефакты с них отсутствуют.
  Частичный журнал части 26 содержит ещё два выживших мутанта (`decide.rs:80:55` и
  `sync.rs:423:59`), которые не входят в 108 сводки.
- Итог ворот — не пройдены. Нельзя считать неполную сводку окончательным доказательством.

## Зерно 23390: ошибка классификатора

После аварий и переименований две живые записи временно ссылались на
`Ideas/Deep/AMBYSIM-6.md`. Когда файл исчез, `classify` складывал отсутствующие записи в
таблицу по пути; одна запись вытесняла другую. Для вытесненного идентификатора класс
вообще отсутствовал. Решение принимало отсутствие класса за `Same`, не находило файл и
пропускало запись без удержания курсора. Последующие проходы уже не видели пропущенную
серверную версию 3 и повторно пытались отправить правку с базой 2: сервер неизменно
возвращал конфликт, после пяти попыток движок отвечал `Busy`.

В отдельном коммите сначала добавлены два красных теста `gates_regressions.rs`:
исходный неизменённый сценарий `23390` в обоих режимах. Оба падали по исходной причине.
Исправление завершает классификацию по **всем живым записям**, сохраняя уже найденные
классы и назначая `Deleted` только отсутствующим. Это не меняет формат состояния,
правила слияния или пороги защит. После исправления оба теста зелёные.

Дополнительно локально проверены зёрна `23301..23400` в обоих режимах: 200 успешных
сценариев, без сбоев и повторов транспорта. Это не заменяет новый полный прогон ворот.

## Д75: изменения без увеличения объёма в смешанном коммите

Направленные проверки обнаружили ещё один дефект: `Out.blob.is_some()` означает,
что у записи есть тело, но не означает увеличение занятого места. Переименование
несёт прежнее тело, уменьшение — новое тело меньшего размера. После `507` прежнее
разбиение относило оба случая к росту и задерживало их вместе с новой загрузкой.

В отдельном коммите добавлены красные тесты `quota_rename_regression.rs`. Исправление
сравнивает зашифрованный размер новой версии с размером живой базы, как серверное
правило П56-в: только положительное увеличение относится к росту. Часть без увеличения объёма
отправляется первой; незавершённая запись сохраняется для ожидающей части.
Результат `NoRoom` переносит именно ожидающие изменения, чтобы уже отправленное
переименование не попадало в список `QuotaFull`.

Оба теста после исправления зелёные. Ошибочное ожидание старой версии в тесте
уменьшения исправлено отдельным коммитом `70cc540` с явного согласия владельца
26 октября; остальные проверки этого замороженного теста сохранены.

Отдельный красный тест `quota_split_safety.rs` воспроизвёл перезапись незавершённой
части: два элемента могут ссылаться на одно тело, поэтому уменьшение одного элемента
не всегда уменьшает общий объём. Сервер вправе отказать и части, которую прогноз
считал нерастущей. Раньше результат её повторного `commit` игнорировался, и следующая
часть заменяла запись о незавершённой отправке. Теперь отказ возвращается вызывающему
коду; ожидающий коммит не перезаписывается. Этот тест после исправления зелёный.

## Д13: запись папки, которая раньше была пустой

Мутант `classify.rs:179` оказался не равнозначным. Папка, синхронизированная пустой,
сохраняет запись после появления файлов. При распознавании перемещения `old` содержал
эту запись, но `now` учитывал только новые пустые директории. Запись теперь уже
непустой папки не попадала в сравнение, и перемещение не распознавалось.

В отдельном коммите добавлен красный `classify_survivor.rs`: исходный ID папки
должен сохраниться после перемещения вместе с файлами. Исправление учитывает
соответствующие записи директорий при сравнении деревьев. Тест, существующие
сценарии папок и прежние проверки классификатора после исправления зелёные.

## Выжившие мутации

Номера строк ниже относятся к коду прогона `f8cc8c1`, а не к дальнейшим сдвигам строк.
Криптография, `conflict_set`, `merge` и `stream` не менялись с пробного прогона:
проверено сравнением `eab5655..f8cc8c1`. Обоснования прежнего
[разбора](sync-gates-survivors-report.md#равнозначные-мутанты) сохраняются для тех же
точных замен, а не автоматически для любого мутанта на той же строке.

### Сохранённые обоснования (28)

- `crypto/header.rs:154:9`: замена `||` на `&&` не разрешает путь с начальным/конечным `/`:
  следующая проверка пустых сегментов всё равно возвращает `InvalidPath`.
- `crypto/header.rs:194:40`, `conflict_set.rs:226:40`: `|` и `^` равны для непересекающихся
  старшего и младшего полубайтов.
- `crypto/header.rs:281:9`: `expecting` пишет только описание ошибки serde; наружу эта
  ошибка в `decode_header_json` преобразуется в фиксированный `BAD` независимо от текста.
- `crypto/header.rs:305:9`, `309:9`, `313:9`: парсер JSON из среза не использует
  `visit_string`/`visit_none`; `visit_unit` и `Value::default()` возвращают `Null`.
- `crypto/padme.rs:17:12`: для длины 2 обе ветви дают 2.
- `crypto/recovery_code.rs:30:52`, `42:44`, `42:72`, `133:46`: объединяемые биты не
  пересекаются, `|` и `^` равны. `135:40`: после 32 байт остаётся 4 бита, поэтому внешний
  guard `bits >= 8` исключает запись 33-го байта и при замене `<` на `<=`.
- `merge.rs:112:9`: в проверяемой позиции за последней строкой без `\n` возможна только вставка.
- `merge.rs:172:69`: при несовпадении правило таблицы LCS делает изменённое сравнение
  равносильным исходному.
- `merge.rs:244:17`, `246:21`, `257:18`, `257:22`, `262:19`, `274:27`, `278:18`, `278:22`:
  однострочные места не расширяют правки, закрывающая ограда не продолжает блок,
  умножение на 1 и вычисление границы дают тот же результат (точные причины в прежнем разборе).
- `merge.rs:310:32` (три замены `>`, на `<`, `==`, `>=`): обе стороны расширяются до одного
  и того же места; `341:33`: вычитаемые границы равны, прибавляемое/вычитаемое равно нулю.
- `stream.rs:140:16`: в этой ветви `filled == SEALED_CHUNK_LEN + 1`, поэтому вычитание и
  целочисленное деление оставляют один и тот же один байт.

## Как проверена сила новых тестов

Мутации из артефактов накладывались последовательно на исходный код по точным diff,
каждый раз файл восстанавливался в `finally`. Запускался release-target с новым
направленным тестом: обычный код должен проходить, мутант — падать на утверждении,
а не на сборке. Прежние замороженные тесты не ослаблялись. В новых вспомогательных
функциях убраны только лишние `clone()` для типов `Copy` и применён Rustfmt.

Проверены границы квоты, повтор `413`/`507`/`UNKNOWN_BLOB`, сохранение посторонних
незавершённых загрузок, смена содержимого после обрыва, точное заполнение квоты,
источник равного ограничения, независимые ошибки нескольких записей и диапазон
поддерживаемых версий протокола. Исходные тесты не подменены заглушками сервера:
где нужна редкая последовательность отказов, она задаётся через публичный `Remote`.

Два мутанта из неполного журнала части 26 проверены отдельно: `sync.rs:423:59`
ловится `read_only_survivor` (два запомненных новых формата в следующем проходе),
`decide.rs:80:55` — `known_server_conflict_survivor` (уже известная серверная копия
вне текущей ленты, локально удалённая перед новым конфликтом).

Итоговая таблица точных замен приведена в конце отчёта. Пять прежних обоснований
оказались недостаточными и проверены заново: два `scan.rs:67` различаются на удалённой
нулевой базе и недоступном пустом файле; `apply.rs:707` — на повреждённых base/meta
уже существующего набора; `push.rs:661` — на уборке tombstone между лентой и коммитом;
`sync.rs:318` — на смене deleted у папки той же версии без изменения hash/body.
Все пять пойманы новыми тестами.

## Неизменённые ограничения

При повторе уже сохранённого коммита `507` по Д76/Д7 по-прежнему удерживает его целиком;
последующие пакеты не заменяют эту запись. Расширение разбиения на такой повтор —
отдельное изменение контракта, в этой правке оно не делалось. Новое разбиение относится
к первому достоверно отказанному смешанному пакету и защищает сохранённую запись при
повторном отказе части.

Два прерванных GitHub задания не считаются успешными. После изменения движка нужен
новый **полный** прогон ворот; частичный перезапуск старого кода его не заменяет.
Push/запуск ворот — по разрешению владельца; снятие ограничения настоящих хранилищ —
только после его подтверждения новых полных результатов и подготовки резервной копии.

## Полный перечень 108 выживших замен

Локально: **56 пойманы тестами, 49 равнозначны, 3 заменены исправлением алгоритма**.
Каждая строка соответствует конкретному имени мутанта из `outcomes.json` прогона; одинаковые
координаты с разными операторами не объединены. «Пойман» означает падение утверждения в новом
release-тесте на точном diff мутанта при зелёном исходном коде. Номера строк — из `f8cc8c1`.

| Место                            | Замена                                                                                                      | Итог        | Проверка / причина                                                                                                                                          |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crypto/header.rs:154:9`         | replace \|\| with &&                                                                                        | Равнозначен | Пустой сегмент split отсекает те же абсолютные/завершающиеся slash пути.                                                                                    |
| `crypto/header.rs:194:40`        | replace \| with ^                                                                                           | Равнозначен | Старший и младший полубайты не пересекаются: OR = XOR.                                                                                                      |
| `crypto/header.rs:281:9`         | replace <impl Visitor<'de> for StrictVisitor>::expecting -> fmt::Result with Ok(Default::default())         | Равнозначен | Текст expecting не выходит наружу: любая ошибка serde преобразуется в фиксированный BAD.                                                                    |
| `crypto/header.rs:305:9`         | replace <impl Visitor<'de> for StrictVisitor>::visit_string -> Result<Value, E> with Ok(Default::default()) | Равнозначен | Парсер JSON из среза не вызывает visit_string.                                                                                                              |
| `crypto/header.rs:309:9`         | replace <impl Visitor<'de> for StrictVisitor>::visit_none -> Result<Value, E> with Ok(Default::default())   | Равнозначен | JSON null вызывает visit_unit, не visit_none.                                                                                                               |
| `crypto/header.rs:313:9`         | replace <impl Visitor<'de> for StrictVisitor>::visit_unit -> Result<Value, E> with Ok(Default::default())   | Равнозначен | Value::default() и прежний visit_unit возвращают Null.                                                                                                      |
| `crypto/padme.rs:17:12`          | replace < with <=                                                                                           | Равнозначен | При len=2 exponent=1, mask=0; обе ветви возвращают 2.                                                                                                       |
| `crypto/recovery_code.rs:30:52`  | replace \| with ^                                                                                           | Равнозначен | Объединяемые битовые диапазоны не пересекаются: OR = XOR.                                                                                                   |
| `crypto/recovery_code.rs:42:44`  | replace \| with ^                                                                                           | Равнозначен | Объединяемые битовые диапазоны не пересекаются: OR = XOR.                                                                                                   |
| `crypto/recovery_code.rs:42:72`  | replace \| with ^                                                                                           | Равнозначен | Объединяемые битовые диапазоны не пересекаются: OR = XOR.                                                                                                   |
| `crypto/recovery_code.rs:133:46` | replace \| with ^                                                                                           | Равнозначен | Объединяемые битовые диапазоны не пересекаются: OR = XOR.                                                                                                   |
| `crypto/recovery_code.rs:135:40` | replace < with <=                                                                                           | Равнозначен | После 32 байт остаётся 4 бита; bits>=8 исключает 33-й байт.                                                                                                 |
| `engine/apply.rs:170:36`         | replace && with \|\|                                                                                        | Пойман      | [apply_gate_survivors](../../sync/sim/tests/apply_gate_survivors.rs): `three_independent_swaps_do_not_break_a_cycle_after_the_last_round`                   |
| `engine/apply.rs:170:45`         | replace < with <=                                                                                           | Пойман      | [apply_gate_survivors](../../sync/sim/tests/apply_gate_survivors.rs): `three_independent_swaps_do_not_break_a_cycle_after_the_last_round`                   |
| `engine/apply.rs:298:58`         | replace == with !=                                                                                          | Пойман      | [apply_gate_survivors](../../sync/sim/tests/apply_gate_survivors.rs): `an_acyclic_rename_chain_never_uses_a_swap_name`                                      |
| `engine/apply.rs:299:35`         | replace match guard next == index with true                                                                 | Пойман      | [apply_chain_survivors](../../sync/sim/tests/apply_chain_survivors.rs): `three_rename_chain_does_not_break_a_false_cycle`                                   |
| `engine/apply.rs:299:40`         | replace == with !=                                                                                          | Пойман      | [apply_chain_survivors](../../sync/sim/tests/apply_chain_survivors.rs): `three_rename_chain_does_not_break_a_false_cycle`                                   |
| `engine/apply.rs:303:23`         | replace += with *=                                                                                          | Равнозначен | При допустимом графе переносов цепочка заканчивается, а цикл возвращается к index до защитного счётчика.                                                    |
| `engine/apply.rs:304:26`         | replace > with ==                                                                                           | Равнозначен | При допустимом графе переносов цепочка заканчивается, а цикл возвращается к index до защитного счётчика.                                                    |
| `engine/apply.rs:304:26`         | replace > with >=                                                                                           | Равнозначен | При допустимом графе переносов цепочка заканчивается, а цикл возвращается к index до защитного счётчика.                                                    |
| `engine/apply.rs:452:55`         | replace && with \|\|                                                                                        | Пойман      | [apply_gate_survivors](../../sync/sim/tests/apply_gate_survivors.rs): `a_renamed_md_to_txt_with_two_edits_is_not_merged`                                    |
| `engine/apply.rs:459:31`         | replace && with \|\|                                                                                        | Пойман      | [apply_gate_survivors](../../sync/sim/tests/apply_gate_survivors.rs): `a_renamed_md_to_txt_with_two_edits_is_not_merged`                                    |
| `engine/apply.rs:707:29`         | replace match guard existing == bytes with true                                                             | Пойман      | [conflict_set_repair_survivor](../../sync/sim/tests/conflict_set_repair_survivor.rs): `a_matching_other_file_does_not_hide_a_damaged_base_or_metadata`      |
| `engine/classify.rs:120:24`      | replace == with !=                                                                                          | Равнозначен | Кандидат с файлом уже добавлен из его предков; пустая папка без probe hash не сопоставляется.                                                               |
| `engine/classify.rs:162:37`      | replace && with \|\|                                                                                        | Равнозначен | root не пуст, не старый путь; фиксированный suffix и уникальные пути не дают повторного root.                                                               |
| `engine/classify.rs:162:52`      | replace && with \|\|                                                                                        | Равнозначен | root не пуст, не старый путь; фиксированный suffix и уникальные пути не дают повторного root.                                                               |
| `engine/classify.rs:179:33`      | replace == with !=                                                                                          | Заменён     | Условие заменено; красные `classify_survivor` / `classify_owned_target` → зелёные.                                                                          |
| `engine/conflict_set.rs:226:40`  | replace \| with ^                                                                                           | Равнозначен | Старший и младший полубайты не пересекаются: OR = XOR.                                                                                                      |
| `engine/decide.rs:109:37`        | replace > with >=                                                                                           | Равнозначен | Равная версия не может менять path/deleted: раньше сработает проверка rollback.                                                                             |
| `engine/decide.rs:335:9`         | replace Decider<'a>::no_copy_name with ()                                                                   | Пойман      | [core_survivors](../../sync/sim/tests/core_survivors.rs): `decide_reports_when_every_conflict_copy_name_is_unavailable`                                     |
| `engine/decide.rs:395:49`        | replace > with >=                                                                                           | Равнозначен | Равенство item IDs исключено предшествующим условием other.item_id != srv.item.                                                                             |
| `engine/decide.rs:540:44`        | replace > with >=                                                                                           | Равнозначен | Равенство item IDs исключено предшествующим условием other.item_id != srv.item.                                                                             |
| `engine/decide.rs:559:44`        | replace < with <=                                                                                           | Равнозначен | Равенство item IDs исключено предшествующим условием other.item_id != srv.item.                                                                             |
| `engine/decide.rs:959:23`        | replace == with !=                                                                                          | Равнозначен | Тело условия содержит только комментарий, действий нет.                                                                                                     |
| `engine/decide.rs:1001:13`       | delete match arm Lc::Deleted                                                                                | Равнозначен | Ветка заменяется тем же set_base; touched влияет на исходящие удаления файлов, не папок.                                                                    |
| `engine/decide.rs:1006:25`       | replace match guard renamed with true                                                                       | Равнозначен | create_dir существующей Same-папки идемпотентен; cleanup не удаляет live folder.                                                                            |
| `engine/merge.rs:112:9`          | replace Hunk<'_>::is_insertion -> bool with true                                                            | Равнозначен | После последней строки без LF в сравниваемой позиции возможна только вставка.                                                                               |
| `engine/merge.rs:172:69`         | replace + with *                                                                                            | Равнозначен | Ветка несовпадения LCS: T[i][j]=max(T[i+1][j],T[i][j+1]); сравнения равны.                                                                                  |
| `engine/merge.rs:244:17`         | replace < with <=                                                                                           | Равнозначен | Однострочное место не расширяет правку; закрывающая ограда не продолжает блок.                                                                              |
| `engine/merge.rs:246:21`         | replace < with <=                                                                                           | Равнозначен | Однострочное место не расширяет правку; закрывающая ограда не продолжает блок.                                                                              |
| `engine/merge.rs:257:18`         | replace - with +                                                                                            | Равнозначен | Граница однострочного места совпадает с началом: изменённое расширение не меняет диапазон.                                                                  |
| `engine/merge.rs:257:22`         | replace > with >=                                                                                           | Равнозначен | Граница однострочного места совпадает с началом: изменённое расширение не меняет диапазон.                                                                  |
| `engine/merge.rs:262:19`         | replace + with *                                                                                            | Равнозначен | Дополнительно просматривается закрывающая строка YAML ---; она не создаёт места, затем i совпадает.                                                         |
| `engine/merge.rs:274:27`         | replace + with *                                                                                            | Равнозначен | Конец вычисляется с исходного i и включает его строку; обе формулы дают тот же конец.                                                                       |
| `engine/merge.rs:278:18`         | replace - with +                                                                                            | Равнозначен | Граница однострочного места совпадает с началом: изменённое расширение не меняет диапазон.                                                                  |
| `engine/merge.rs:278:22`         | replace > with >=                                                                                           | Равнозначен | Граница однострочного места совпадает с началом: изменённое расширение не меняет диапазон.                                                                  |
| `engine/merge.rs:310:32`         | replace > with <                                                                                            | Равнозначен | Обе стороны расширяются до одного места; изменённая ветка даёт те же границы.                                                                               |
| `engine/merge.rs:310:32`         | replace > with ==                                                                                           | Равнозначен | Обе стороны расширяются до одного места; изменённая ветка даёт те же границы.                                                                               |
| `engine/merge.rs:310:32`         | replace > with >=                                                                                           | Равнозначен | Обе стороны расширяются до одного места; изменённая ветка даёт те же границы.                                                                               |
| `engine/merge.rs:341:33`         | replace + with -                                                                                            | Равнозначен | last.be == h.be: прибавляемая/вычитаемая разность равна нулю.                                                                                               |
| `engine/push.rs:64:31`           | replace \|\| with &&                                                                                        | Равнозначен | Deleted/unmaterialised не имеют класса Same; Same-папка не является файлом scan.files.                                                                      |
| `engine/push.rs:64:64`           | replace \|\| with &&                                                                                        | Равнозначен | Deleted/unmaterialised не имеют класса Same; Same-папка не является файлом scan.files.                                                                      |
| `engine/push.rs:97:17`           | delete match arm (_, Lc::Same \| Lc::Blocked)                                                               | Равнозначен | Нижняя ветка _=>{} выполняет то же отсутствие действий.                                                                                                     |
| `engine/push.rs:233:57`          | replace && with \|\|                                                                                        | Пойман      | [protocol_survivors](../../sync/sim/tests/protocol_survivors.rs): `push_does_not_skip_a_same_size_different_content_file`                                   |
| `engine/push.rs:460:33`          | replace > with <                                                                                            | Пойман      | [limits_survivors](../../sync/sim/tests/limits_survivors.rs): `ls_replacing_a_body_credits_its_current_sealed_size`                                         |
| `engine/push.rs:460:33`          | replace > with ==                                                                                           | Пойман      | [limits_survivors](../../sync/sim/tests/limits_survivors.rs): `ls_replacing_a_body_credits_its_current_sealed_size`                                         |
| `engine/push.rs:460:33`          | replace > with >=                                                                                           | Равнозначен | Единственное отличие требует version=0 и body Some; новая запись имеет body None, серверная version>=1.                                                     |
| `engine/push.rs:460:37`          | replace && with \|\|                                                                                        | Пойман      | [undelete_credit_survivor](../../sync/sim/tests/undelete_credit_survivor.rs): `an_edited_file_undeleting_a_deleted_base_has_no_replace_credit`              |
| `engine/push.rs:462:17`          | delete match arm (Some(_), old)                                                                             | Пойман      | [limits_survivors](../../sync/sim/tests/limits_survivors.rs): `ls_replacing_a_body_credits_its_current_sealed_size`                                         |
| `engine/push.rs:468:36`          | replace == with !=                                                                                          | Пойман      | [limits_survivors](../../sync/sim/tests/limits_survivors.rs): `ls_resuming_an_exact_pending_upload_works_with_no_free_quota`                                |
| `engine/push.rs:468:54`          | replace && with \|\|                                                                                        | Пойман      | [resume_survivors](../../sync/sim/tests/resume_survivors.rs): `changed_content_does_not_bypass_the_quota_resume_forecast`                                   |
| `engine/push.rs:468:72`          | replace == with !=                                                                                          | Пойман      | [limits_survivors](../../sync/sim/tests/limits_survivors.rs): `ls_resuming_an_exact_pending_upload_works_with_no_free_quota`                                |
| `engine/push.rs:468:90`          | replace == with !=                                                                                          | Пойман      | [limits_survivors](../../sync/sim/tests/limits_survivors.rs): `ls_resuming_an_exact_pending_upload_works_with_no_free_quota`                                |
| `engine/push.rs:472:31`          | replace > with >=                                                                                           | Пойман      | [limits_survivors](../../sync/sim/tests/limits_survivors.rs): `ls_changed_content_waits_for_pending_quota_without_a_new_upload`                             |
| `engine/push.rs:492:31`          | replace == with !=                                                                                          | Пойман      | [limits_survivors](../../sync/sim/tests/limits_survivors.rs): `ls_a_blob_start_413_does_not_set_quota_full`                                                 |
| `engine/push.rs:544:42`          | replace && with \|\|                                                                                        | Пойман      | [resume_survivors](../../sync/sim/tests/resume_survivors.rs): `changed_content_of_an_existing_item_gets_a_new_pending_body`                                 |
| `engine/push.rs:595:64`          | replace match guard reason == code::QUOTA_EXCEEDED with true                                                | Пойман      | [protocol_survivors](../../sync/sim/tests/protocol_survivors.rs): `push_does_not_turn_a_non_quota_blob_rejection_into_quota_full`                           |
| `engine/push.rs:658:74`          | replace > with <                                                                                            | Пойман      | [expired_commit_survivors](../../sync/sim/tests/expired_commit_survivors.rs): `an_undelete_survives_cleanup_between_feed_and_commit`                        |
| `engine/push.rs:658:74`          | replace > with ==                                                                                           | Пойман      | [expired_commit_survivors](../../sync/sim/tests/expired_commit_survivors.rs): `an_undelete_survives_cleanup_between_feed_and_commit`                        |
| `engine/push.rs:658:74`          | replace > with >=                                                                                           | Равнозначен | Конфликт current_version=0/base_version=0 невозможен: отсутствующий item с base 0 создаётся.                                                                |
| `engine/push.rs:661:20`          | delete !                                                                                                    | Пойман      | [expired_commit_survivors](../../sync/sim/tests/expired_commit_survivors.rs): `an_undelete_survives_cleanup_between_feed_and_commit`                        |
| `engine/push.rs:674:32`          | replace < with <=                                                                                           | Пойман      | [protocol_survivors](../../sync/sim/tests/protocol_survivors.rs): `a_commit_413_at_the_server_ceiling_keeps_server_as_the_limit_source`                     |
| `engine/push.rs:674:32`          | replace < with ==                                                                                           | Пойман      | [limits_survivors](../../sync/sim/tests/limits_survivors.rs): `ls_a_413_does_not_mark_a_folder_as_too_large`                                                |
| `engine/push.rs:674:32`          | replace < with >                                                                                            | Пойман      | [limits_survivors](../../sync/sim/tests/limits_survivors.rs): `ls_a_413_does_not_mark_a_folder_as_too_large`                                                |
| `engine/push.rs:687:64`          | replace match guard reason == code::UNKNOWN_BLOB with false                                                 | Пойман      | [limits_survivors](../../sync/sim/tests/limits_survivors.rs): `ls_a_commit_with_a_missing_body_is_rebuilt`                                                  |
| `engine/push.rs:691:61`          | replace == with !=                                                                                          | Пойман      | [unknown_blob_current_survivor](../../sync/sim/tests/unknown_blob_current_survivor.rs): `current_commit_unknown_blob_keeps_other_chunk_upload_during_retry` |
| `engine/push.rs:699:64`          | replace match guard reason == code::QUOTA_EXCEEDED with true                                                | Пойман      | [protocol_survivors](../../sync/sim/tests/protocol_survivors.rs): `a_pending_commit_with_a_non_quota_rejection_is_kept_unchanged`                           |
| `engine/push.rs:706:57`          | replace && with \|\|                                                                                        | Заменён     | Разбиение по приросту заменило blob-предикат; `quota_rename_regression` и `quota_split_safety` красные → зелёные.                                           |
| `engine/push.rs:706:60`          | delete !                                                                                                    | Заменён     | Разбиение по приросту заменило blob-предикат; `quota_rename_regression` и `quota_split_safety` красные → зелёные.                                           |
| `engine/push.rs:750:42`          | replace && with \|\|                                                                                        | Пойман      | [protocol_survivors](../../sync/sim/tests/protocol_survivors.rs): `a_commit_413_at_the_server_ceiling_keeps_server_as_the_limit_source`                     |
| `engine/push.rs:762:5`           | replace mark_too_large with ()                                                                              | Пойман      | [limits_survivors](../../sync/sim/tests/limits_survivors.rs): `ls_a_413_does_not_mark_a_folder_as_too_large`                                                |
| `engine/push.rs:767:42`          | replace && with \|\|                                                                                        | Пойман      | [limits_survivors](../../sync/sim/tests/limits_survivors.rs): `ls_a_413_does_not_mark_a_folder_as_too_large`                                                |
| `engine/push.rs:767:45`          | delete !                                                                                                    | Пойман      | [limits_survivors](../../sync/sim/tests/limits_survivors.rs): `ls_a_commit_413_report_marks_only_bodies_over_the_new_limit`                                 |
| `engine/push.rs:768:79`          | replace > with <                                                                                            | Пойман      | [limits_survivors](../../sync/sim/tests/limits_survivors.rs): `ls_a_commit_413_report_marks_only_bodies_over_the_new_limit`                                 |
| `engine/push.rs:768:79`          | replace > with ==                                                                                           | Пойман      | [limits_survivors](../../sync/sim/tests/limits_survivors.rs): `ls_a_commit_413_report_marks_only_bodies_over_the_new_limit`                                 |
| `engine/push.rs:768:79`          | replace > with >=                                                                                           | Пойман      | [limits_survivors](../../sync/sim/tests/limits_survivors.rs): `ls_a_commit_413_report_marks_only_bodies_over_the_new_limit`                                 |
| `engine/scan.rs:67:32`           | replace && with \|\|                                                                                        | Пойман      | [deleted_scan_survivors](../../sync/sim/tests/deleted_scan_survivors.rs): `a_deleted_zero_size_base_does_not_make_a_new_oversized_file_readable`            |
| `engine/scan.rs:67:60`           | replace && with \|\|                                                                                        | Пойман      | [deleted_scan_survivors](../../sync/sim/tests/deleted_scan_survivors.rs): `a_deleted_zero_size_base_does_not_make_a_new_oversized_file_readable`            |
| `engine/scan.rs:76:16`           | delete !                                                                                                    | Равнозначен | Рекурсивный listing включает директории: каждый непустой каталог отмечен непосредственным ребёнком.                                                         |
| `engine/scan.rs:93:29`           | delete !                                                                                                    | Пойман      | [core_survivors](../../sync/sim/tests/core_survivors.rs): `scan_does_not_read_a_new_oversized_file_just_because_a_listed_file_has_its_size`                 |
| `engine/scan.rs:146:24`          | delete !                                                                                                    | Пойман      | [core_survivors](../../sync/sim/tests/core_survivors.rs): `scan_does_not_read_a_new_oversized_file_just_because_a_listed_file_has_its_size`                 |
| `engine/stream.rs:140:16`        | replace -= with /=                                                                                          | Равнозначен | filled=N+1 и N=SEALED_CHUNK_LEN: (N+1)-N=(N+1)/N=1.                                                                                                         |
| `engine/sync.rs:170:55`          | replace < with >                                                                                            | Пойман      | [protocol_version_survivor](../../sync/sim/tests/protocol_version_survivor.rs): `a_server_supporting_versions_one_through_two_accepts_this_client`          |
| `engine/sync.rs:254:24`          | replace match guard reason == code::BLOB_TOO_LARGE with false                                               | Пойман      | [limits_survivors](../../sync/sim/tests/limits_survivors.rs): `ls_a_pending_commit_rechecks_a_tightened_file_limit`                                         |
| `engine/sync.rs:254:24`          | replace match guard reason == code::BLOB_TOO_LARGE with true                                                | Пойман      | [protocol_survivors](../../sync/sim/tests/protocol_survivors.rs): `a_pending_commit_with_a_non_quota_rejection_is_kept_unchanged`                           |
| `engine/sync.rs:254:31`          | replace == with !=                                                                                          | Пойман      | [limits_survivors](../../sync/sim/tests/limits_survivors.rs): `ls_a_pending_commit_rechecks_a_tightened_file_limit`                                         |
| `engine/sync.rs:261:68`          | replace match guard reason == code::UNKNOWN_BLOB with true                                                  | Пойман      | [limits_survivors](../../sync/sim/tests/limits_survivors.rs): `ls_a_pending_commit_keeps_507_and_reports_only_files`                                        |
| `engine/sync.rs:261:75`          | replace == with !=                                                                                          | Пойман      | [limits_survivors](../../sync/sim/tests/limits_survivors.rs): `ls_a_pending_commit_with_a_missing_body_is_rebuilt`                                          |
| `engine/sync.rs:267:54`          | replace == with !=                                                                                          | Пойман      | [unknown_blob_survivors](../../sync/sim/tests/unknown_blob_survivors.rs): `pending_unknown_blob_preserves_an_unrelated_completed_upload`                    |
| `engine/sync.rs:275:24`          | replace match guard reason == code::QUOTA_EXCEEDED with false                                               | Пойман      | [limits_survivors](../../sync/sim/tests/limits_survivors.rs): `ls_a_pending_commit_keeps_507_and_reports_only_files`                                        |
| `engine/sync.rs:275:24`          | replace match guard reason == code::QUOTA_EXCEEDED with true                                                | Пойман      | [protocol_survivors](../../sync/sim/tests/protocol_survivors.rs): `a_pending_commit_with_a_non_quota_rejection_is_kept_unchanged`                           |
| `engine/sync.rs:275:31`          | replace == with !=                                                                                          | Пойман      | [limits_survivors](../../sync/sim/tests/limits_survivors.rs): `ls_a_pending_commit_keeps_507_and_reports_only_files`                                        |
| `engine/sync.rs:281:42`          | delete !                                                                                                    | Пойман      | [limits_survivors](../../sync/sim/tests/limits_survivors.rs): `ls_a_pending_commit_keeps_507_and_reports_only_files`                                        |
| `engine/sync.rs:281:58`          | replace && with \|\|                                                                                        | Пойман      | [limits_survivors](../../sync/sim/tests/limits_survivors.rs): `ls_a_pending_commit_keeps_507_and_reports_only_files`                                        |
| `engine/sync.rs:318:21`          | replace \|\| with &&                                                                                        | Пойман      | [folder_rollback_survivor](../../sync/sim/tests/folder_rollback_survivor.rs): `a_same_version_folder_with_changed_deleted_flag_stops_before_writes`         |
| `engine/sync.rs:404:56`          | replace == with !=                                                                                          | Пойман      | [protocol_survivors](../../sync/sim/tests/protocol_survivors.rs): `ps_feed_reports_multiple_corrupt_items`                                                  |
| `engine/sync.rs:559:17`          | replace \|\| with &&                                                                                        | Равнозначен | Предварительный edited допускает только живой материализованный файл; эти guards уже ложны.                                                                 |
| `engine/sync.rs:560:17`          | replace \|\| with &&                                                                                        | Равнозначен | Предварительный edited допускает только живой материализованный файл; эти guards уже ложны.                                                                 |
