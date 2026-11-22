use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};

use super::journal::{self, Step};
use super::{Operation, Outcome};
use crate::index::read_only::ReadVault;
use crate::model::{FsMutationResult, PathChange};
use crate::{archive, bundle, durable, frontmatter, paths};

pub(super) fn prepare(
    root: &Path,
    operation: Operation<'_>,
) -> Result<(Outcome, Vec<Step>), &'static str> {
    match operation {
        Operation::Rename { path, name } => relocate(root, path, name, true),
        Operation::Move { path, folder } => relocate(root, path, folder, false),
        Operation::Archive { path } => archive_item(root, path),
        Operation::Restore { path } => restore(root, path),
    }
}

fn relative(root: &Path, path: &Path) -> Result<String, &'static str> {
    durable::relative_string(root, path, "operation").map_err(|_| "accessDenied")
}

fn input_path(root: &Path, path: &str) -> Result<PathBuf, &'static str> {
    let path = path.replace('\\', "/");
    if !journal::visible(&path) {
        return Err("accessDenied");
    }
    let path = durable::guarded_path(root, &path, "operation").map_err(|_| "accessDenied")?;
    if !path.exists() {
        return Err("notFound");
    }
    Ok(path)
}

fn outcome(source: String, destination: String, rewritten_paths: Vec<String>) -> Outcome {
    Outcome {
        source,
        destination,
        rewritten_paths,
        dry_run: false,
    }
}

fn relocate(
    root: &Path,
    source: &str,
    destination: &str,
    rename: bool,
) -> Result<(Outcome, Vec<Step>), &'static str> {
    let mut source = input_path(root, source)?;
    // With Supernotes off a bundle's file is not a handle on the group: its folder is.
    if crate::vault_tools::modules::is_loose_bundle_file(root, &source)? {
        return Err("moduleDisabled");
    }
    // Selecting a bundle folder or its main note means moving the whole item.
    if source.is_dir() {
        if let Some(name) = source.file_name().and_then(|name| name.to_str()) {
            let main = source.join(format!("{name}.md"));
            if main.is_file() {
                source = main;
            }
        }
    }
    let from = bundle::resolve_item_root(root, &source);
    // The existing preview walks a whole tree, so reject symlinks and non-files
    // before invoking it. The journal uses these same byte checks on recovery.
    let from_digest = journal::fingerprint(&from).map_err(|_| "accessDenied")?;
    let target_folder;
    let mut preview: FsMutationResult;
    if rename {
        if bundle::validate_item_name("item", destination).map_err(|_| "invalidArguments")?
            != destination
            || !journal::visible(destination)
        {
            return Err("invalidArguments");
        }
        preview = bundle::preview_rename_item(root, &source, destination)
            .map_err(|_| "mutationConflict")?;
    } else {
        target_folder = if matches!(destination, "." | "") {
            root.into()
        } else {
            input_path(root, destination)?
        };
        if !target_folder.is_dir() {
            return Err("invalidArguments");
        }
        preview = bundle::preview_move_item(root, &source, &target_folder)
            .map_err(|_| "mutationConflict")?;
    }
    let primary = PathBuf::from(preview.primary_path.as_deref().ok_or("unavailable")?);
    let to = if from != source {
        primary.parent().ok_or("invalidArguments")?.to_owned()
    } else {
        primary.clone()
    };
    if from == to {
        return Ok((
            outcome(relative(root, &from)?, relative(root, &to)?, Vec::new()),
            Vec::new(),
        ));
    }
    let target = relative(root, &to)?;
    paths::confine_rel_no_symlinks(root, &target).map_err(|_| "accessDenied")?;
    let mut steps =
        journal::movement_with_digest(root, &from, &to, rename && to.exists(), from_digest)
            .map_err(|_| "accessDenied")?;
    if rename && from.is_dir() {
        // The bundle's files named for the directory follow the root. Folder
        // databases also keep their old named manifests when moving as a unit.
        let old_name = from
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or("invalidArguments")?;
        let extensions: &[&str] = if source != from {
            &["md", "canvas", "excalidraw", "json", "database"]
        } else {
            &["json", "database"]
        };
        for extension in extensions {
            let old_file = format!("{old_name}.{extension}");
            let new_file = format!("{destination}.{extension}");
            let observed = from.join(&old_file);
            if !observed.is_file() {
                continue;
            }
            let observed_target = from.join(&new_file);
            let case_only = bundle::ensure_rename_target_available(&observed, &observed_target)
                .map_err(|_| "mutationConflict")?;
            steps.extend(
                journal::movement(
                    root,
                    &observed,
                    &to.join(&old_file),
                    &to.join(&new_file),
                    case_only,
                )
                .map_err(|_| "accessDenied")?,
            );
            if let Some(change) = preview
                .path_changes
                .iter_mut()
                .find(|change| Path::new(&change.old_path) == observed)
            {
                change.new_path = bundle::path_string(&to.join(new_file));
            }
        }
    }
    if rename && from.is_dir() {
        if let Some(manifest) = crate::database::discovery::find_manifest_path(&from) {
            let old_path = bundle::path_string(&manifest);
            if let Some(change) = preview
                .path_changes
                .iter()
                .find(|change| change.old_path == old_path)
            {
                let before = journal::read_text(&manifest)
                    .map_err(|_| "unavailable")?
                    .ok_or("mutationConflict")?;
                if let Some(after) = bundle::render_manifest_name(before.as_bytes(), destination)
                    .map_err(|_| "unavailable")?
                {
                    steps.push(Step::Rewrite {
                        path: relative(root, Path::new(&change.new_path))?,
                        before,
                        after,
                        snapshot: ulid::Ulid::generate().to_string(),
                    });
                }
            }
        }
    }
    append_rewrites(
        root,
        &preview.path_changes,
        &primary,
        rename.then_some(destination),
        &mut steps,
    )?;
    Ok((
        outcome(
            relative(root, &from)?,
            relative(root, &to)?,
            steps
                .iter()
                .filter_map(|step| {
                    if let Step::Rewrite { path, .. } = step {
                        Some(path.clone())
                    } else {
                        None
                    }
                })
                .collect(),
        ),
        steps,
    ))
}

fn append_rewrites(
    root: &Path,
    changes: &[PathChange],
    primary: &Path,
    new_name: Option<&str>,
    steps: &mut Vec<Step>,
) -> Result<(), &'static str> {
    let catalog = ReadVault::open(root)?;
    let rewrites = catalog.plan_rewrites(changes).map_err(|_| "unavailable")?;
    let old_paths: HashMap<&Path, &Path> = changes
        .iter()
        .map(|item| (Path::new(&item.new_path), Path::new(&item.old_path)))
        .collect();
    let mut writes = BTreeMap::new();
    for rewrite in rewrites {
        if !journal::refactor_path(&relative(root, &rewrite.source_path)?) {
            continue;
        }
        let source = old_paths
            .get(rewrite.source_path.as_path())
            .copied()
            .unwrap_or(&rewrite.source_path);
        let source = durable::guarded_path(root, &relative(root, source)?, "rewrite")
            .map_err(|_| "accessDenied")?;
        let before = journal::read_text(&source)
            .map_err(|_| "unavailable")?
            .ok_or("mutationConflict")?;
        let Some(after) = crate::index::refactor::render_rewrite(&rewrite, &before) else {
            continue;
        };
        if before != after {
            writes.insert(rewrite.source_path, (before, after));
        }
    }
    // Update the explicit Amby title of a renamed page without reserializing YAML.
    if let (Some(name), Some(old)) = (new_name, old_paths.get(primary)) {
        if crate::vault::scan::is_markdown(primary) {
            let (before, after) = if let Some(pair) = writes.remove(primary) {
                pair
            } else {
                let text = journal::read_text(old)
                    .map_err(|_| "unavailable")?
                    .ok_or("mutationConflict")?;
                (text.clone(), text)
            };
            let next = if frontmatter::parse_markdown(&after).display_title.is_some() {
                frontmatter::replace_yaml_binding_lossless(
                    &after,
                    frontmatter::AMBY_TITLE_FIELD,
                    &name.into(),
                )
                .unwrap_or(after)
            } else {
                after
            };
            if before != next {
                writes.insert(primary.to_owned(), (before, next));
            }
        }
    }
    for (path, (before, after)) in writes {
        steps.push(Step::Rewrite {
            path: relative(root, &path)?,
            before,
            after,
            snapshot: ulid::Ulid::generate().to_string(),
        });
    }
    let history = changes
        .iter()
        .filter_map(|change| {
            let old = relative(root, Path::new(&change.old_path)).ok()?;
            let new = relative(root, Path::new(&change.new_path)).ok()?;
            (old != new && journal::visible(&old) && journal::visible(&new)).then_some((old, new))
        })
        .collect::<Vec<_>>();
    if !history.is_empty() {
        steps.push(Step::History { changes: history });
    }
    Ok(())
}

fn archive_item(root: &Path, path: &str) -> Result<(Outcome, Vec<Step>), &'static str> {
    let source = input_path(root, path)?;
    let source = if crate::vault_tools::modules::is_loose_bundle_file(root, &source)? {
        source
    } else {
        bundle::resolve_item_root(root, &source)
    };
    let source_relative = relative(root, &source)?;
    paths::confine_rel_no_symlinks(root, ".amby/archive/.meta").map_err(|_| "accessDenied")?;
    let wanted =
        durable::guarded_path(root, &format!(".amby/archive/{source_relative}"), "archive")
            .map_err(|_| "accessDenied")?;
    let target = free_at(&wanted)?;
    let archive_id = relative(&archive::archive_root(root), &target)?;
    let mut steps =
        journal::movement(root, &source, &source, &target, false).map_err(|_| "accessDenied")?;
    let mut payloads = Vec::new();
    archive::files_below(&source, &source, &mut payloads);
    if source.is_file() {
        payloads.push(String::new());
    }
    let timestamp = archive::now_ms();
    for payload in payloads {
        let path = if payload.is_empty() {
            archive_id.clone()
        } else {
            format!("{archive_id}/{payload}")
        };
        let record = archive::ArchiveMeta {
            path,
            archived_at_ms: timestamp,
            extra: Default::default(),
        };
        let after = String::from_utf8(record.to_bytes()).map_err(|_| "unavailable")?;
        steps.push(Step::ArchiveRecord {
            path: format!(".amby/archive/.meta/{}.json", ulid::Ulid::generate()),
            before: None,
            after: Some(after),
        });
    }
    Ok((outcome(source_relative, archive_id, Vec::new()), steps))
}

fn free_at(wanted: &Path) -> Result<PathBuf, &'static str> {
    let name = wanted
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("invalidArguments")?;
    Ok(paths::free_path(
        wanted.parent().ok_or("invalidArguments")?,
        name,
    ))
}

fn restore(root: &Path, path: &str) -> Result<(Outcome, Vec<Step>), &'static str> {
    let id = path.replace('\\', "/");
    if !journal::visible(&id) {
        return Err("accessDenied");
    }
    let source = durable::guarded_path(root, &format!(".amby/archive/{id}"), "restore")
        .map_err(|_| "accessDenied")?;
    if !source.exists() {
        return Err("notFound");
    }
    let target = if source.is_file() {
        archive::restore_places(root, &id)
            .map_err(|_| "mutationConflict")?
            .1
    } else {
        let wanted = durable::guarded_path(root, &id, "restore").map_err(|_| "accessDenied")?;
        free_at(&wanted)?
    };
    let mut steps =
        journal::movement(root, &source, &source, &target, false).map_err(|_| "accessDenied")?;
    paths::confine_rel_no_symlinks(root, ".amby/archive/.meta").map_err(|_| "accessDenied")?;
    for meta in archive::meta_files(root) {
        if archive::read_meta(&meta).is_some_and(|record| {
            record.path == id || source.is_dir() && Path::new(&record.path).starts_with(&id)
        }) {
            let Some(before) = journal::read_text(&meta).map_err(|_| "unavailable")? else {
                continue;
            };
            steps.push(Step::ArchiveRecord {
                path: relative(root, &meta)?,
                before: Some(before),
                after: None,
            });
        }
    }
    Ok((outcome(id, relative(root, &target)?, Vec::new()), steps))
}
