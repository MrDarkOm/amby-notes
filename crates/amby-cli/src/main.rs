mod args;
mod config;
mod daily;
mod edit;
mod launch;
mod mcp;
mod mcp_extra;
mod mcp_tools;

use std::env;
use std::fs;
use std::io::{self, Write};
use std::path::Path;
use std::process::ExitCode;

use amby_core::cli_ipc::{self, Action, Payload, Request};
use amby_core::index::read_only::{list_visible, visible_note, ReadVault};
use amby_core::index::{IndexedNote, NoteFilter, PropertyFilter, CONFLICT_PREFIX};
use amby_core::note_edit::EditKind;
use amby_core::structural::{self, Operation};
use amby_core::vault::scan::normalize_rel_path;
use amby_core::vault_tools::{self, properties, Mutation};
use serde_json::{json, Value};

use args::{Command, Options};

const VERSION: &str = env!("CARGO_PKG_VERSION");

struct Error {
    code: &'static str,
    candidates: Vec<String>,
}

impl From<&'static str> for Error {
    fn from(code: &'static str) -> Self {
        Self {
            code,
            candidates: Vec::new(),
        }
    }
}

impl Error {
    fn exit_code(&self) -> u8 {
        match self.code {
            "usage" | "invalidArguments" | "vaultRequired" => 2,
            "vaultNotFound" | "notFound" | "propertyNotFound" => 3,
            "ambiguousNote" | "ambiguousProperty" => 4,
            "accessDenied" | "outsideWriteScope" => 5,
            "alreadyExists" | "revisionConflict" | "mutationConflict" => 6,
            "vaultBusy" | "vaultNotActive" | "recoveryRequired" => 7,
            "invalidEncoding" | "invalidFrontmatter" => 2,
            _ => 1,
        }
    }

    fn message(&self, ru: bool) -> &'static str {
        let (english, russian) = match self.code {
            "usage" => (
                "Invalid command. Run amby --help.",
                "Неверная команда. Выполните amby --help.",
            ),
            "invalidArguments" => ("Invalid arguments.", "Недопустимые аргументы."),
            "vaultRequired" => (
                "Choose a vault with --vault, AMBY_VAULT or amby vault use.",
                "Укажите хранилище через --vault, AMBY_VAULT или amby vault use.",
            ),
            "vaultNotFound" => (
                "Vault folder is unavailable.",
                "Папка хранилища недоступна.",
            ),
            "notFound" => ("Note or folder not found.", "Заметка или папка не найдена."),
            "ambiguousNote" => (
                "Several notes match. Use a relative path.",
                "Найдено несколько заметок. Укажите относительный путь.",
            ),
            "accessDenied" => (
                "This path is outside the visible vault.",
                "Этот путь вне доступной области хранилища.",
            ),
            "appDataUnavailable" => (
                "Amby preferences are unavailable.",
                "Настройки Amby недоступны.",
            ),
            "desktopUnavailable" => (
                "Could not launch Amby Notes.",
                "Не удалось запустить Amby Notes.",
            ),
            "alreadyExists" => (
                "A file already exists at that path.",
                "Файл по этому пути уже существует.",
            ),
            "revisionConflict" => (
                "The note changed during the operation. Read it again and retry.",
                "Заметка изменилась во время операции. Прочитайте её снова и повторите попытку.",
            ),
            "invalidEncoding" => (
                "Input and note must be UTF-8.",
                "Ввод и заметка должны быть в UTF-8.",
            ),
            "invalidFrontmatter" => (
                "Frontmatter cannot be preserved with this input.",
                "С этим вводом не удаётся сохранить фронтматтер.",
            ),
            "historyFailed" => (
                "Could not save a history snapshot.",
                "Не удалось сохранить снимок истории.",
            ),
            "vaultBusy" => (
                "Vault in use. Close Amby or wait for the other operation to finish.",
                "Хранилище занято. Закройте Amby или дождитесь завершения другой операции.",
            ),
            "vaultNotActive" => (
                "Select this vault in desktop Amby and try again.",
                "Выберите это хранилище в Amby и повторите команду.",
            ),
            "desktopProtocolVersion" => (
                "The running Amby uses a different CLI protocol version.",
                "Запущенный Amby использует другую версию протокола CLI.",
            ),
            "desktopRequestInterrupted" => (
                "Amby did not confirm the result. Check the vault before repeating the command.",
                "Amby не подтвердил результат. Проверьте хранилище перед повтором команды.",
            ),
            "mutationConflict" => (
                "The requested move or rename conflicts with the current vault paths.",
                "Перенос или переименование конфликтует с текущими путями хранилища.",
            ),
            "recoveryRequired" => (
                "Vault recovery is required. Run amby recover.",
                "Требуется восстановление хранилища. Выполните amby recover.",
            ),
            "operationTooLarge" => (
                "The operation exceeds the recovery journal limit.",
                "Операция превышает допустимый размер журнала восстановления.",
            ),
            "propertyNotFound" => (
                "The note has no property with that name.",
                "У заметки нет свойства с таким именем.",
            ),
            "ambiguousProperty" => (
                "Several header keys match that property name.",
                "Этому имени свойства соответствует несколько ключей заголовка.",
            ),
            "propertiesNotMigrated" => (
                "Open this vault in Amby once to enable property edits.",
                "Откройте это хранилище в Amby, чтобы включить изменение свойств.",
            ),
            "propertiesFormatNewer" => (
                "The properties were saved by a newer Amby. Update Amby.",
                "Свойства сохранены более новой версией Amby. Обновите Amby.",
            ),
            "propertiesReadOnly" => (
                "The properties of this note are read-only.",
                "Свойства этой заметки доступны только для чтения.",
            ),
            "noteWithoutId" => (
                "This note has no amby-id. Open it in Amby to style or rename its properties.",
                "У заметки нет amby-id. Откройте её в Amby, чтобы менять оформление или имена свойств.",
            ),
            "propertyRejected" => (
                "Amby could not apply this property change.",
                "Amby не удалось применить это изменение свойства.",
            ),
            "trashUnavailable" => (
                "The system trash is unavailable. Nothing was deleted. Use amby archive instead.",
                "Системная корзина недоступна. Ничего не удалено. Используйте amby archive.",
            ),
            "tooManyNotes" => (
                "The filter finds more than 200 notes. Narrow it.",
                "Фильтр находит больше 200 заметок. Сузьте его.",
            ),
            "attachmentTooLarge" => (
                "The file is larger than the attachment limit.",
                "Файл больше допустимого размера вложения.",
            ),
            "moduleDisabled" => (
                "This module is turned off in the workspace.",
                "Этот модуль отключён в рабочем пространстве.",
            ),
            _ => ("The request failed.", "Не удалось выполнить запрос."),
        };
        if ru {
            russian
        } else {
            english
        }
    }
}

struct Output {
    data: Value,
    text: String,
    /// Non-zero when the command ran but some of its items failed.
    exit: u8,
}

impl Output {
    fn new(data: Value, text: String) -> Self {
        Self {
            data,
            text,
            exit: 0,
        }
    }
}

fn relative(root: &Path, path: &str) -> Result<String, &'static str> {
    let path = Path::new(path)
        .strip_prefix(root)
        .map_err(|_| "accessDenied")?;
    Ok(normalize_rel_path(path))
}

fn note_json(root: &Path, note: &IndexedNote) -> Result<Value, &'static str> {
    Ok(json!({ "id": note.id, "title": note.title, "path": relative(root, &note.path)? }))
}

fn choose_note(vault: &ReadVault, reference: &str) -> Result<IndexedNote, Error> {
    let notes = vault.notes()?;
    let root = vault.root();
    let target = reference.replace('\\', "/");
    // A relative path disambiguates a title or duplicated frontmatter ID.
    if let Some(note) = notes
        .iter()
        .find(|note| relative(root, &note.path).is_ok_and(|path| path == target))
    {
        return Ok(note.clone());
    }
    if target.contains('/') || target.starts_with('.') {
        // Preserve an exact visible title containing '/' when present, but
        // reject path-like input naming a service or escaping the vault.
        if !notes.iter().any(|note| note.title == reference) {
            visible_note(root, &target)?;
        }
    }
    let duplicate_prefix = format!("{CONFLICT_PREFIX}{reference}:");
    let mut matches = notes.into_iter().filter(|note| {
        note.id == reference
            || note.id.starts_with(&duplicate_prefix)
            || note.title.to_lowercase() == reference.to_lowercase()
    });
    let first = matches.next().ok_or("notFound")?;
    if let Some(second) = matches.next() {
        let candidates = [first, second]
            .into_iter()
            .chain(matches)
            .map(|note| relative(root, &note.path))
            .collect::<Result<_, _>>()?;
        return Err(Error {
            code: "ambiguousNote",
            candidates,
        });
    }
    Ok(first)
}

fn selected_root(options: &Options) -> Result<std::path::PathBuf, &'static str> {
    let workspaces = config::workspaces();
    config::vault_path(&config::selected(options, &workspaces).ok_or("vaultRequired")?)
}

fn vault_list(options: &Options) -> Output {
    let workspaces = config::workspaces();
    let selected = config::selected(options, &workspaces);
    let mut paths: Vec<_> = workspaces
        .recent
        .into_iter()
        .filter(|record| !record.detached)
        .map(|record| record.path)
        .chain(workspaces.last_opened)
        .chain(selected.clone())
        .collect();
    paths.sort();
    paths.dedup();
    let text = paths
        .iter()
        .map(|path| {
            format!(
                "{}{}\n",
                if selected.as_ref() == Some(path) {
                    "* "
                } else {
                    "  "
                },
                path.display()
            )
        })
        .collect();
    Output::new(json!({ "vaults": paths, "selected": selected }), text)
}

fn run(command: Command, options: &Options, ru: bool) -> Result<Output, Error> {
    use Command::*;
    let root = match command {
        Help => {
            let heading = if ru {
                "Использование"
            } else {
                "Usage"
            };
            let text = format!(
                "{heading}: amby [--vault PATH] [--json] COMMAND\n\
                \n  vault list | vault use PATH\n  ls [FOLDER]\n  cat NOTE\n  search [QUERY] [--tag TAG]... [--property NAME[=VALUE]]... [--folder FOLDER] [--limit N]\n\
                \x20 links NOTE | backlinks NOTE\n  tags\n  open NOTE\n  new PATH | append NOTE | write NOTE [--file PATH] [--dry-run]\n\
                \x20 prop list NOTE\n  prop set NOTE NAME [VALUE]... [--type TYPE]\n  prop style NOTE NAME [--type TYPE] [--icon ICON] [--settings JSON]\n\
                \x20 prop rename NOTE NAME NEW_NAME | prop delete NOTE NAME | prop order NOTE NAME...\n\
                \x20 info NOTE | orphans [--folder FOLDER] | unresolved [--folder FOLDER]\n\
                \x20 attachments NOTE | attach NOTE FILE [--name NAME] [--no-link]\n\
                \x20 bulk set NAME [VALUE]... | bulk move FOLDER  FILTERS (--dry-run | --yes)\n  rename PATH NAME | move PATH FOLDER\n  archive PATH | archive list | restore PATH\n\
                \x20 delete PATH [--dry-run]\n  recover\n  mcp [--allow-write[=FOLDER]]\n\
                \x20 templates | new PATH --template NAME [--dry-run]\n\
                \x20 daily [append] [--date YYYY-MM-DD] [--folder FOLDER] [--template NAME] [--file PATH] [--dry-run]\n"
            );
            return Ok(Output::new(json!({ "usage": text }), text));
        }
        Version => {
            return Ok(Output::new(
                json!({ "version": VERSION }),
                format!("amby {VERSION}\n"),
            ))
        }
        VaultList => return Ok(vault_list(options)),
        VaultUse(path) => {
            let root = config::vault_path(&path)?;
            config::remember(&root)?;
            return Ok(Output::new(
                json!({ "vault": root }),
                format!("{}\n", root.display()),
            ));
        }
        Mcp => return Err("usage".into()),
        _ => selected_root(options)?,
    };
    if let List(folder) = command {
        let folder = folder.replace('\\', "/");
        let entries = list_visible(&root, &folder)?;
        let text = entries
            .iter()
            .map(|(name, is_dir)| {
                format!(
                    "{}{}\n",
                    name.escape_debug(),
                    if *is_dir { "/" } else { "" }
                )
            })
            .collect();
        let entries: Vec<_> = entries.into_iter().map(|(name, is_dir)| {
            json!({ "name": name, "kind": if is_dir { "folder" } else { "note" } })
        }).collect();
        return Ok(Output::new(
            json!({ "path": folder, "entries": entries }),
            text,
        ));
    }
    if let Edit { kind, note } = command {
        let path = if kind == EditKind::New || visible_note(&root, &note.replace('\\', "/")).is_ok()
        {
            note
        } else {
            let vault = ReadVault::open(&root)?;
            relative(&root, &choose_note(&vault, &note)?.path)?
        };
        let result = match &options.template {
            Some(template) => {
                daily::new_from_template(&root, None, &path, template, options.dry_run, false)?
            }
            None => {
                let content = edit::read_input(options.file.as_deref())?;
                edit::execute(&root, None, kind, &path, &content, options.dry_run, false)?
            }
        };
        let text = result
            .diff
            .clone()
            .unwrap_or_else(|| format!("{}\n", result.path.escape_debug()));
        return Ok(Output::new(json!(result), text));
    }
    if let Delete(path) = &command {
        let request = Mutation::Delete { path: path.clone() };
        let result = if options.dry_run {
            vault_tools::preview(&root, "", &request).map_err(Error::from)?
        } else {
            mcp_tools::execute(&root, "", request).map_err(|code| Error::from(known_code(&code)))?
        };
        let mut text = format!(
            "{}\n",
            result["path"].as_str().unwrap_or_default().escape_debug()
        );
        for path in result["affectedPaths"].as_array().into_iter().flatten() {
            text.push_str(&format!(
                "  {}\n",
                path.as_str().unwrap_or_default().escape_debug()
            ));
        }
        return Ok(Output::new(result, text));
    }
    if let Prop(property) = command {
        return run_prop(&root, property, options);
    }
    if let Templates = command {
        let listing = daily::list(&root)?;
        let text = listing["templates"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|template| {
                format!(
                    "{}\n",
                    template["name"].as_str().unwrap_or_default().escape_debug()
                )
            })
            .collect();
        return Ok(Output::new(listing, text));
    }
    if let Daily { append } = command {
        let moment = match &options.date {
            Some(date) => daily::Moment::on(date).ok_or("usage")?,
            None => daily::Moment::now(),
        };
        let text = if append {
            Some(edit::read_input(options.file.as_deref())?)
        } else {
            None
        };
        let request = daily::Daily {
            moment,
            folder: options.folder.as_deref(),
            template: options.template.as_deref(),
            append: text.as_deref(),
            dry_run: options.dry_run,
        };
        let result = daily::daily(&root, None, request, false)?;
        let text = result["diff"].as_str().map_or_else(
            || {
                format!(
                    "{}\n",
                    result["path"].as_str().unwrap_or_default().escape_debug()
                )
            },
            str::to_owned,
        );
        return Ok(Output::new(result, text));
    }
    if let Bulk(op) = command {
        return run_bulk(&root, op, options);
    }
    if let Attach { note, file } = &command {
        let vault = ReadVault::open(&root)?;
        let path = if visible_note(&root, &note.replace('\\', "/")).is_ok() {
            note.replace('\\', "/")
        } else {
            relative(&root, &choose_note(&vault, note)?.path)?
        };
        drop(vault);
        let name = match &options.name {
            Some(name) => name.clone(),
            None => file
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .ok_or("invalidArguments")?,
        };
        let result = mcp_tools::attach(
            &root,
            &root,
            &path,
            &name,
            vault_tools::attachments::Source::File(file),
            !options.no_link,
            false,
        )?;
        let text = format!(
            "{}\n",
            result["path"].as_str().unwrap_or_default().escape_debug()
        );
        return Ok(Output::new(result, text));
    }
    let operation = match &command {
        Rename { path, name } => Operation::Rename { path, name },
        Move { path, folder } => Operation::Move { path, folder },
        Archive(path) => Operation::Archive { path },
        Restore(path) => Operation::Restore { path },
        ArchiveList => {
            let entries = structural::archive_list(&root)?;
            let text = entries
                .iter()
                .map(|entry| format!("{}\n", entry.id.escape_debug()))
                .collect();
            return Ok(Output::new(json!({ "entries": entries }), text));
        }
        Recover => {
            let recovered = match structural::recover(&root) {
                Err("vaultBusy") => match request_desktop(&root, Action::Recover)? {
                    Payload::Recovery(recovered) => recovered,
                    _ => return Err("desktopRequestInterrupted".into()),
                },
                other => other?,
            };
            let text = match (ru, recovered) {
                (true, true) => "Операция восстановлена.\n",
                (false, true) => "Operation recovered.\n",
                (true, false) => "Проверка журналов завершена.\n",
                (false, false) => "Journal check completed.\n",
            };
            return Ok(Output::new(json!({ "recovered": recovered }), text.into()));
        }
        _ => return run_read(command, &ReadVault::open(&root)?, options),
    };
    let result = match structural::execute(&root, operation, options.dry_run) {
        Err("vaultBusy") => match request_desktop(&root, operation.into())? {
            Payload::Mutation(outcome) => outcome,
            _ => return Err("desktopRequestInterrupted".into()),
        },
        other => other?,
    };
    let mut text = format!(
        "{} → {}\n",
        result.source.escape_debug(),
        result.destination.escape_debug()
    );
    text.extend(
        result
            .rewritten_paths
            .iter()
            .map(|path| format!("  {}\n", path.escape_debug())),
    );
    Ok(Output::new(json!(result), text))
}

fn request_desktop(root: &Path, action: Action) -> Result<Payload, Error> {
    let profile = config::app_data()?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|_| "unavailable")?;
    let request = Request {
        version: cli_ipc::VERSION,
        vault: root.to_owned(),
        action,
    };
    runtime
        .block_on(cli_ipc::dispatch(&profile, request))
        .map_err(|code| {
            match code.as_str() {
                "invalidArguments" => "invalidArguments",
                "accessDenied" => "accessDenied",
                "notFound" => "notFound",
                "mutationConflict" => "mutationConflict",
                "operationTooLarge" => "operationTooLarge",
                "recoveryRequired" => "recoveryRequired",
                "vaultBusy" => "vaultBusy",
                "vaultNotActive" => "vaultNotActive",
                "desktopProtocolVersion" => "desktopProtocolVersion",
                "desktopRequestInterrupted" => "desktopRequestInterrupted",
                _ => "unavailable",
            }
            .into()
        })
}

fn run_read(command: Command, vault: &ReadVault, options: &Options) -> Result<Output, Error> {
    let root = vault.root();
    let filter = search_filter(
        match &command {
            Command::Search(query) => query.clone(),
            _ => None,
        },
        options,
    );
    match command {
        Command::Cat(reference) => {
            let note = choose_note(vault, &reference)?;
            let path = relative(root, &note.path)?;
            let content =
                fs::read_to_string(visible_note(root, &path)?).map_err(|_| "unavailable")?;
            Ok(Output::new(
                json!({ "note": note_json(root, &note)?, "content": content }),
                content,
            ))
        }
        Command::Orphans | Command::Unresolved => {
            let limit = options.limit.unwrap_or(1000);
            let listing = if matches!(command, Command::Orphans) {
                vault.orphans(&filter.folder, limit)?
            } else {
                vault.unresolved(&filter.folder, limit)?
            };
            let text = if matches!(command, Command::Orphans) {
                listing["notes"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|note| {
                        format!(
                            "{}\n",
                            note["path"].as_str().unwrap_or_default().escape_debug()
                        )
                    })
                    .collect()
            } else {
                listing["links"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|link| {
                        format!(
                            "{}\t[[{}]]\n",
                            link["source"].as_str().unwrap_or_default().escape_debug(),
                            link["target"].as_str().unwrap_or_default().escape_debug()
                        )
                    })
                    .collect()
            };
            Ok(Output::new(listing, text))
        }
        Command::Info(reference) => {
            let note = choose_note(vault, &reference)?;
            let info = vault.info(&note)?;
            let text = format!(
                "{}\nid\t{}\nsize\t{}\nwords\t{}\ntags\t{}\nlinks\t{} out, {} in, {} unresolved\nproperties\t{}\nattachments\t{} ({} missing)\n",
                info["path"].as_str().unwrap_or_default().escape_debug(),
                info["noteId"].as_str().unwrap_or("-"),
                info["size"],
                info["words"],
                info["tags"].as_array().into_iter().flatten().filter_map(Value::as_str).collect::<Vec<_>>().join(", "),
                info["links"]["outgoing"],
                info["links"]["incoming"],
                info["links"]["unresolved"],
                info["properties"],
                info["attachments"]["count"],
                info["attachments"]["missing"],
            );
            Ok(Output::new(info, text))
        }
        Command::Attachments(reference) => {
            let note = choose_note(vault, &reference)?;
            let path = relative(root, &note.path)?;
            let file = visible_note(root, &path)?;
            let content = fs::read_to_string(&file).map_err(|_| "invalidEncoding")?;
            let attachments = vault_tools::attachments::list(root, &file, &content);
            let text = attachments
                .iter()
                .map(|item| {
                    format!(
                        "{}\t{}{}\n",
                        item.path.escape_debug(),
                        item.kind,
                        if item.exists { "" } else { "\tmissing" }
                    )
                })
                .collect();
            Ok(Output::new(
                json!({ "note": path, "attachments": attachments }),
                text,
            ))
        }
        Command::Search(_) => {
            let mut text = String::new();
            let mut results = Vec::new();
            for hit in vault.find(&filter)? {
                let path = relative(root, &hit.note.path)?;
                text.push_str(&format!(
                    "{}\t{}\n",
                    path.escape_debug(),
                    hit.note.title.escape_debug()
                ));
                results.push(
                    json!({ "path": path, "title": hit.note.title, "id": hit.note.id,
                    "snippet": hit.snippet, "score": hit.score, "matchType": hit.match_type }),
                );
            }
            Ok(Output::new(json!({ "results": results }), text))
        }
        Command::Links { note, incoming } => {
            let note = choose_note(vault, &note)?;
            let mut text = String::new();
            let mut results = Vec::new();
            for link in vault.links(&note.id, incoming)? {
                let path = link
                    .other
                    .as_ref()
                    .map(|note| relative(root, &note.path))
                    .transpose()?;
                text.push_str(&format!(
                    "{}\n",
                    path.as_deref().unwrap_or(&link.target).escape_debug()
                ));
                results.push(json!({ "path": path, "id": link.other.as_ref().map(|note| &note.id),
                    "title": link.other.as_ref().map(|note| &note.title), "target": link.target, "label": link.label }));
            }
            Ok(Output::new(
                json!({ "note": note_json(root, &note)?, "links": results }),
                text,
            ))
        }
        Command::Tags => {
            let tags = vault.tags()?;
            let text = tags
                .iter()
                .map(|entry| format!("#{}\t{}\n", entry.tag.escape_debug(), entry.notes.len()))
                .collect();
            let tags = tags
                .into_iter()
                .map(|entry| {
                    let notes = entry
                        .notes
                        .iter()
                        .map(|note| note_json(root, note))
                        .collect::<Result<Vec<_>, _>>()?;
                    Ok(json!({ "tag": entry.tag, "count": notes.len(), "notes": notes }))
                })
                .collect::<Result<Vec<_>, &'static str>>()?;
            Ok(Output::new(json!({ "tags": tags }), text))
        }
        Command::Open(reference) => {
            let note = choose_note(vault, &reference)?;
            let path = relative(root, &note.path)?;
            visible_note(root, &path)?;
            launch::open(root, &path)?;
            Ok(Output::new(
                json!({ "note": note_json(root, &note)?, "requested": true }),
                format!("{path}\n"),
            ))
        }
        _ => Err("usage".into()),
    }
}

/// The stable code for an error returned by the desktop or a shared operation.
fn known_code(code: &str) -> &'static str {
    const CODES: &[&str] = &[
        "invalidArguments",
        "accessDenied",
        "outsideWriteScope",
        "notFound",
        "alreadyExists",
        "mutationConflict",
        "operationTooLarge",
        "recoveryRequired",
        "vaultBusy",
        "vaultNotActive",
        "desktopProtocolVersion",
        "desktopRequestInterrupted",
        "revisionConflict",
        "invalidEncoding",
        "invalidFrontmatter",
        "historyFailed",
        "propertyNotFound",
        "ambiguousProperty",
        "propertiesNotMigrated",
        "propertiesFormatNewer",
        "propertiesReadOnly",
        "noteWithoutId",
        "propertyRejected",
        "trashUnavailable",
        "moduleDisabled",
        "appDataUnavailable",
    ];
    CODES
        .iter()
        .find(|known| **known == code)
        .copied()
        .unwrap_or("unavailable")
}

fn properties_text(listing: &Value) -> String {
    listing["properties"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|property| {
            let value = match property["items"].as_array() {
                Some(items) if !items.is_empty() => items
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(", "),
                _ => property["value"].as_str().unwrap_or_default().to_owned(),
            };
            format!(
                "{}\t{}\t{}\n",
                property["name"].as_str().unwrap_or_default().escape_debug(),
                property["type"].as_str().unwrap_or_default(),
                value.escape_debug()
            )
        })
        .collect()
}

fn run_prop(root: &Path, property: args::Prop, options: &Options) -> Result<Output, Error> {
    use args::Prop;
    let vault = ReadVault::open(root)?;
    let note = match &property {
        Prop::List(note)
        | Prop::Set { note, .. }
        | Prop::Style { note, .. }
        | Prop::Rename { note, .. }
        | Prop::Delete { note, .. }
        | Prop::Order { note, .. } => note,
    };
    let path = if visible_note(root, &note.replace('\\', "/")).is_ok() {
        note.replace('\\', "/")
    } else {
        relative(root, &choose_note(&vault, note)?.path)?
    };
    let request = match property {
        Prop::List(_) => {
            let listing = vault.properties(&path)?;
            let text = properties_text(&listing);
            return Ok(Output::new(listing, text));
        }
        Prop::Set { name, values, .. } => {
            let value = match values.as_slice() {
                [] => Value::Null,
                [one] => Value::String(one.clone()),
                many => json!(many),
            };
            Mutation::SetProperty(properties::SetProperty {
                path,
                name,
                value,
                property_type: options.property_type.clone(),
            })
        }
        Prop::Style { name, .. } => {
            let settings = options
                .settings
                .as_deref()
                .map(serde_json::from_str::<Value>)
                .transpose()
                .map_err(|_| "invalidArguments")?;
            Mutation::SetPropertyAppearance(properties::PropertyAppearance {
                path,
                name,
                property_type: options.property_type.clone(),
                icon: options.icon.clone(),
                settings,
            })
        }
        Prop::Rename { name, new_name, .. } => Mutation::RenameProperty {
            path,
            name,
            new_name,
        },
        Prop::Delete { name, .. } => Mutation::DeleteProperty { path, name },
        Prop::Order { names, .. } => Mutation::ReorderProperties { path, names },
    };
    drop(vault);
    let listing =
        mcp_tools::execute(root, "", request).map_err(|code| Error::from(known_code(&code)))?;
    let text = properties_text(&listing);
    Ok(Output::new(listing, text))
}

fn search_filter(query: Option<String>, options: &Options) -> NoteFilter {
    NoteFilter {
        query,
        tags: options.tags.clone(),
        properties: options
            .properties
            .iter()
            .map(|condition| match condition.split_once('=') {
                Some((name, value)) => PropertyFilter {
                    name: name.to_owned(),
                    value: Some(value.to_owned()),
                },
                None => PropertyFilter {
                    name: condition.clone(),
                    value: None,
                },
            })
            .collect(),
        folder: options
            .folder
            .as_deref()
            .unwrap_or_default()
            .replace('\\', "/")
            .trim_matches('/')
            .to_owned(),
        limit: options.limit.unwrap_or(50),
    }
}

fn run_bulk(root: &Path, op: args::Bulk, options: &Options) -> Result<Output, Error> {
    let op = match op {
        args::Bulk::Set { name, values } => mcp_tools::BulkOp::Set {
            name,
            value: match values.as_slice() {
                [] => Value::Null,
                [one] => Value::String(one.clone()),
                many => json!(many),
            },
            property_type: options.property_type.clone(),
        },
        args::Bulk::Move { folder } => mcp_tools::BulkOp::Move {
            folder: folder.replace('\\', "/").trim_matches('/').to_owned(),
        },
    };
    let filter = search_filter(options.query.clone(), options);
    let result = mcp_tools::bulk(root, "", filter, &op, options.dry_run)
        .map_err(|code| Error::from(known_code(&code)))?;
    let mut text = String::new();
    for note in result["notes"].as_array().into_iter().flatten() {
        let path = note["path"]
            .as_str()
            .unwrap_or_default()
            .escape_debug()
            .to_string();
        match note["error"].as_str() {
            Some(error) => text.push_str(&format!("{path}\t{error}\n")),
            None => text.push_str(&format!("{path}\n")),
        }
    }
    let failed = result["failed"].as_u64().unwrap_or(0);
    let mut output = Output::new(result, text);
    if failed > 0 {
        output.exit = 8;
    }
    Ok(output)
}

fn write_json(out: &mut impl Write, value: Value) -> io::Result<()> {
    serde_json::to_writer(&mut *out, &value)?;
    out.write_all(b"\n")
}

fn main() -> ExitCode {
    let (options, command) = args::parse(env::args_os().skip(1));
    let ru = ["LC_ALL", "LC_MESSAGES", "LANG"]
        .into_iter()
        .find_map(|key| env::var(key).ok().filter(|locale| !locale.is_empty()))
        .is_some_and(|locale| locale.split(['_', '-', '.']).next() == Some("ru"));
    let is_mcp = matches!(command, Ok(Command::Mcp));
    let result = match command {
        Ok(Command::Mcp) => selected_root(&options)
            .map_err(Error::from)
            .and_then(|root| {
                mcp::serve(
                    root,
                    options.write_access.as_ref(),
                    io::stdin().lock(),
                    io::stdout().lock(),
                )
                .map(|()| Output::new(Value::Null, String::new()))
                .map_err(Error::from)
            }),
        Ok(command) => run(command, &options, ru),
        Err(code) => Err(code.into()),
    };
    let mut out = io::stdout().lock();
    match result {
        Ok(reply) => {
            let written = if options.json && !is_mcp {
                write_json(
                    &mut out,
                    json!({ "schemaVersion": 1, "ok": true, "data": reply.data }),
                )
            } else {
                out.write_all(reply.text.as_bytes())
            };
            if written.is_ok() {
                ExitCode::from(reply.exit)
            } else {
                ExitCode::FAILURE
            }
        }
        Err(error) => {
            if options.json && !is_mcp {
                let _ = write_json(
                    &mut out,
                    json!({ "schemaVersion": 1, "ok": false,
                    "error": { "code": error.code, "candidates": error.candidates } }),
                );
            } else {
                let mut err = io::stderr().lock();
                let _ = writeln!(err, "{}", error.message(ru));
                for path in &error.candidates {
                    let _ = writeln!(err, "  {}", path.escape_debug());
                }
            }
            ExitCode::from(error.exit_code())
        }
    }
}
