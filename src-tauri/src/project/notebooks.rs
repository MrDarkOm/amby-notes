//! Notebooks: plain subfolders of the notes base (`docs/creative-format.md` §6).
//!
//! A notebook is nothing but a folder inside the base's folder, so a note's place in one is its
//! `category_path` and it never changes which base the note belongs to or which stories it is
//! linked to. This module only reads folders:
//! - `list_notebooks` lists the folders (an empty notebook has no note to show it), without
//!   following symbolic links and without leaving the base;
//! - `resolve_notebook_dir` turns the folder names a request carries into a folder, refusing
//!   everything that is not an ordinary visible folder of the base, before anything is written.
//!
//! Creating, renaming, moving and deleting go through the vault's own file operations.

use std::fs;
use std::path::{Path, PathBuf};

use super::model::{Notebook, NotebookCatalog, ProjectError};
use super::names::normalize_entry_name;
use crate::database::discovery::find_manifest_path;

/// Deeper folders are left out of a listing.
const MAX_DEPTH: usize = 12;
/// A listing stops reading folders after this many notebooks.
const MAX_NOTEBOOKS: usize = 2000;
/// Folder names the request may carry at most.
const MAX_SEGMENTS: usize = MAX_DEPTH;

fn invalid_notebook(reason: &str) -> ProjectError {
    ProjectError::InvalidParent {
        reason: format!("notebook: {reason}"),
    }
}

/// Whether a visible folder is a notebook. A folder that holds a database of its own, or the
/// folder of a note with a same-named main file (a note with attachments), is not one.
fn is_notebook_dir(path: &Path) -> bool {
    if find_manifest_path(path).is_some() {
        return false;
    }
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    let main = path.join(format!("{name}.md"));
    !fs::symlink_metadata(&main)
        .map(|metadata| metadata.file_type().is_file())
        .unwrap_or(false)
}

fn is_hidden_name(name: &str) -> bool {
    name.starts_with('.') || crate::vault::scan::is_service_directory(name)
}

struct Walk {
    notebooks: Vec<Notebook>,
    truncated: bool,
}

/// Reads one folder: counts what is not a notebook and descends into the notebooks.
fn read_folder(dir: &Path, segments: &[String], walk: &mut Walk) -> u32 {
    let Ok(entries) = fs::read_dir(dir) else {
        return 0;
    };
    let mut items = 0_u32;
    let mut folders: Vec<(String, PathBuf)> = Vec::new();
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            items += 1;
            continue;
        };
        if is_hidden_name(name) {
            continue;
        }
        if file_type.is_dir() && is_notebook_dir(&entry.path()) {
            folders.push((name.to_owned(), entry.path()));
        } else {
            // A file, a link, a note's own folder or a database: something that is not a notebook.
            items += 1;
        }
    }
    folders.sort_by_cached_key(|(name, _)| (name.to_lowercase(), name.clone()));
    for (name, path) in folders {
        if segments.len() >= MAX_DEPTH || walk.notebooks.len() >= MAX_NOTEBOOKS {
            walk.truncated = true;
            continue;
        }
        let mut nested = segments.to_vec();
        nested.push(name);
        let index = walk.notebooks.len();
        walk.notebooks.push(Notebook {
            segments: nested.clone(),
            path: path.to_string_lossy().into_owned(),
            item_count: 0,
        });
        let count = read_folder(&path, &nested, walk);
        walk.notebooks[index].item_count = count;
    }
    items
}

/// The notebooks of a base found in the database projection: its folder comes from the index
/// and must lie inside the vault.
pub fn list_notebooks_of(
    connection: &rusqlite::Connection,
    vault: &Path,
    database_id: &str,
) -> Result<NotebookCatalog, ProjectError> {
    let relative: String = connection
        .query_row(
            "SELECT container_path FROM db_databases WHERE database_id = ?1",
            [database_id],
            |row| row.get(0),
        )
        .map_err(|_| ProjectError::failed("databaseNotFound", "the database was not found"))?;
    let container = crate::paths::confine(vault, &vault.join(&relative))
        .map_err(|error| ProjectError::failed("notebooksUnavailable", error))?;
    // The folder keeps the vault's own spelling, so the paths match the file tree's.
    let spelled = vault.join(&relative);
    let container = if container.canonicalize().ok() == spelled.canonicalize().ok() {
        spelled
    } else {
        container
    };
    list_notebooks(database_id, &container)
}

/// The notebooks of the base whose folder is `container`, listed from the disk.
pub fn list_notebooks(
    database_id: &str,
    container: &Path,
) -> Result<NotebookCatalog, ProjectError> {
    let metadata = fs::symlink_metadata(container)
        .map_err(|error| ProjectError::failed("notebooksUnavailable", error.to_string()))?;
    if !metadata.file_type().is_dir() {
        return Err(ProjectError::failed(
            "notebooksUnavailable",
            "the base has no folder",
        ));
    }
    let mut walk = Walk {
        notebooks: Vec::new(),
        truncated: false,
    };
    let root_item_count = read_folder(container, &[], &mut walk);
    Ok(NotebookCatalog {
        database_id: database_id.to_owned(),
        container_path: container.to_string_lossy().into_owned(),
        root_item_count,
        notebooks: walk.notebooks,
        truncated: walk.truncated,
    })
}

/// The folder a request names, checked before any write: every name is a valid folder name that
/// is already what it says (no whitespace to trim, no `..`), every step is an ordinary folder
/// that is not a link, a database or a note's own folder, and the result is inside `container`.
/// An empty list is the base's own folder.
pub fn resolve_notebook_dir(
    container: &Path,
    segments: &[String],
) -> Result<PathBuf, ProjectError> {
    if segments.len() > MAX_SEGMENTS {
        return Err(invalid_notebook("too deep"));
    }
    let mut current = container.to_path_buf();
    for segment in segments {
        let name = normalize_entry_name("notebook", segment)?;
        if &name != segment {
            return Err(ProjectError::InvalidName {
                field: "notebook".to_owned(),
                reason: "invalid".to_owned(),
            });
        }
        current.push(&name);
        let metadata = fs::symlink_metadata(&current)
            .map_err(|_| invalid_notebook("the folder does not exist"))?;
        if !metadata.file_type().is_dir() {
            return Err(invalid_notebook("not an ordinary folder"));
        }
        if !is_notebook_dir(&current) {
            return Err(invalid_notebook("not a notebook"));
        }
    }
    let root = container
        .canonicalize()
        .map_err(|_| invalid_notebook("the base has no folder"))?;
    let resolved = current
        .canonicalize()
        .map_err(|_| invalid_notebook("the folder does not exist"))?;
    if !resolved.starts_with(&root) {
        return Err(invalid_notebook("outside the base"));
    }
    Ok(current)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("amby-notebooks-{name}-{}", ulid::Ulid::generate()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn names(catalog: &NotebookCatalog) -> Vec<String> {
        catalog
            .notebooks
            .iter()
            .map(|notebook| notebook.segments.join("/"))
            .collect()
    }

    #[test]
    fn a_base_is_found_in_the_projection_and_unknown_ones_are_refused() {
        let vault = temp_dir("projection");
        fs::create_dir_all(vault.join("Мастерская/Заметки/Идеи")).unwrap();
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        crate::index::schema::init_schema(&connection).unwrap();
        connection
            .execute(
                "INSERT INTO db_databases (database_id, container_path, name, locked, format_version, manifest_revision, projection_state)
                 VALUES ('db_notes', 'Мастерская/Заметки', 'Заметки', 0, 1, 'r', 'ready')",
                [],
            )
            .unwrap();
        let catalog = list_notebooks_of(&connection, &vault, "db_notes").unwrap();
        assert_eq!(names(&catalog), vec!["Идеи"]);
        assert_eq!(
            catalog.notebooks[0].path,
            vault.join("Мастерская/Заметки/Идеи").to_string_lossy()
        );
        assert!(list_notebooks_of(&connection, &vault, "db_missing").is_err());
        connection
            .execute("UPDATE db_databases SET container_path = '../outside'", [])
            .unwrap();
        assert!(list_notebooks_of(&connection, &vault, "db_notes").is_err());
        fs::remove_dir_all(&vault).ok();
    }

    #[test]
    fn lists_nested_and_empty_notebooks_with_what_lies_in_them() {
        let base = temp_dir("list");
        fs::create_dir_all(base.join("Идеи/Сюжеты")).unwrap();
        fs::create_dir_all(base.join("архив")).unwrap();
        fs::write(base.join("Корень.md"), "x").unwrap();
        fs::write(base.join("Идеи/Первая.md"), "x").unwrap();
        fs::write(base.join("Идеи/.DS_Store"), "x").unwrap();
        fs::create_dir_all(base.join(".ambd")).unwrap();

        let catalog = list_notebooks("db", &base).unwrap();
        assert_eq!(names(&catalog), vec!["архив", "Идеи", "Идеи/Сюжеты"]);
        assert_eq!(catalog.root_item_count, 1);
        let count = |name: &str| {
            catalog
                .notebooks
                .iter()
                .find(|notebook| notebook.segments.join("/") == name)
                .unwrap()
                .item_count
        };
        assert_eq!(count("Идеи"), 1, "the hidden file is not counted");
        assert_eq!(count("Идеи/Сюжеты"), 0);
        assert_eq!(count("архив"), 0);
        assert!(!catalog.truncated);
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn a_database_or_a_note_folder_is_not_a_notebook() {
        let base = temp_dir("kinds");
        fs::create_dir_all(base.join("Блокнот")).unwrap();
        fs::create_dir_all(base.join("Заметка")).unwrap();
        fs::write(base.join("Заметка/Заметка.md"), "x").unwrap();
        fs::write(base.join("Заметка/картинка.png"), "x").unwrap();
        fs::create_dir_all(base.join("Вложенная")).unwrap();
        fs::write(base.join("Вложенная/Вложенная.json"), "{}").unwrap();

        let catalog = list_notebooks("db", &base).unwrap();
        assert_eq!(names(&catalog), vec!["Блокнот"]);
        assert_eq!(
            catalog.root_item_count, 2,
            "the note folder and the database"
        );
        fs::remove_dir_all(&base).ok();
    }

    #[cfg(unix)]
    #[test]
    fn a_listing_does_not_follow_a_symbolic_link_out_of_the_base() {
        use std::os::unix::fs::symlink;
        let outside = temp_dir("outside");
        fs::create_dir_all(outside.join("Чужой")).unwrap();
        let base = temp_dir("links");
        fs::create_dir_all(base.join("Свой")).unwrap();
        symlink(&outside, base.join("Ссылка")).unwrap();
        symlink(base.join("Свой"), base.join("Вторая")).unwrap();

        let catalog = list_notebooks("db", &base).unwrap();
        assert_eq!(names(&catalog), vec!["Свой"]);
        assert_eq!(
            catalog.root_item_count, 2,
            "a link is an item, not a notebook"
        );
        assert!(resolve_notebook_dir(&base, &["Ссылка".to_owned()]).is_err());
        assert!(resolve_notebook_dir(&base, &["Вторая".to_owned()]).is_err());
        fs::remove_dir_all(&base).ok();
        fs::remove_dir_all(&outside).ok();
    }

    #[test]
    fn the_listing_is_bounded() {
        let base = temp_dir("deep");
        let mut path = base.clone();
        for level in 0..(MAX_DEPTH + 3) {
            path.push(format!("n{level}"));
        }
        fs::create_dir_all(&path).unwrap();
        let catalog = list_notebooks("db", &base).unwrap();
        assert_eq!(catalog.notebooks.len(), MAX_DEPTH);
        assert!(catalog.truncated);
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn resolves_only_ordinary_visible_folders_of_the_base() {
        let base = temp_dir("resolve");
        fs::create_dir_all(base.join("Идеи/Сюжеты")).unwrap();
        fs::write(base.join("Файл"), "x").unwrap();
        fs::create_dir_all(base.join("Заметка")).unwrap();
        fs::write(base.join("Заметка/Заметка.md"), "x").unwrap();
        let segs = |list: &[&str]| list.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>();

        assert_eq!(resolve_notebook_dir(&base, &[]).unwrap(), base);
        assert_eq!(
            resolve_notebook_dir(&base, &segs(&["Идеи", "Сюжеты"])).unwrap(),
            base.join("Идеи").join("Сюжеты")
        );
        for bad in [
            segs(&[".."]),
            segs(&["Идеи", ".."]),
            segs(&["../Идеи"]),
            segs(&["Идеи/Сюжеты"]),
            segs(&[""]),
            segs(&[" Идеи"]),
            segs(&["Идеи "]),
            segs(&["Ид:еи"]),
            segs(&[".hidden"]),
            segs(&["CON"]),
            segs(&["Нет такого"]),
            segs(&["Файл"]),
            segs(&["Заметка"]),
            segs(&["Идеи", "Нет"]),
        ] {
            assert!(
                resolve_notebook_dir(&base, &bad).is_err(),
                "{bad:?} must be refused"
            );
        }
        let long = (0..=MAX_SEGMENTS)
            .map(|n| format!("n{n}"))
            .collect::<Vec<_>>();
        assert!(resolve_notebook_dir(&base, &long).is_err());
        fs::remove_dir_all(&base).ok();
    }
}
