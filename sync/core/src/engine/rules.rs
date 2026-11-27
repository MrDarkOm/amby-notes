//! Small pure rules of the engine (Р4, Р8): what is not synchronised and when a pass stops.

/// The folders of `.amby/` whose files are synchronised (Р4, З14, Г24, К1); the rest of `.amby/` is
/// not (SYNC-10). The one list: [`is_excluded_path`] keeps them, and the walk of the application
/// (`vault_fs.rs`) enters them and nothing else.
pub const AMBY_SYNCED_FOLDERS: [&str; 5] = [
    "blocks",
    "property-backups",
    "conflicts",
    "properties",
    "archive",
];

/// Is this path excluded from synchronisation without a word (Р4, Д11)? `.git` at any depth;
/// `.obsidian/` and `.trash/` at the root; everything in `.amby/` except `properties.json`,
/// `properties/` (the groups of note properties, З14), `blocks/`, `graph-layout.json`,
/// `property-backups/`, `conflicts/` (Г24) and `archive/` with its `.meta/` records (К1, К8); temporary files
/// `.<name>.amby-tmp-*`; system litter (`.DS_Store`, `._*`, `Thumbs.db`, `desktop.ini`) at any
/// depth. `path` is relative, `/` separators.
pub fn is_excluded_path(path: &str) -> bool {
    // macOS and Windows disks ignore letter case: `.GIT` is `.git` there. Every rule below compares
    // names without case, or a path spelled differently would be written into Git's, Amby's own or
    // another application's folder (SYNC-02). `is_service_path` already did so for `.amby`.
    let lowered = path.to_ascii_lowercase();
    let segments: Vec<&str> = lowered.split('/').collect();
    if segments.contains(&".git") || segments.iter().any(|name| is_short_service_name(name)) {
        return true;
    }
    match segments[0] {
        ".obsidian" | ".trash" => return true,
        ".amby" => {
            let kept = match segments.get(1) {
                None => false,
                Some(&("properties.json" | "graph-layout.json")) => segments.len() == 2,
                Some(folder) if AMBY_SYNCED_FOLDERS.contains(folder) => true,
                Some(_) => false,
            };
            if !kept {
                return true;
            }
        }
        _ => {}
    }
    segments.iter().any(|name| {
        matches!(*name, ".ds_store" | "thumbs.db" | "desktop.ini")
            || name.starts_with("._")
            || is_temporary_name(name)
    })
}

/// A Windows 8.3 short name of a service folder (`GIT~1` for `.git`): the same folder on disk.
fn is_short_service_name(name: &str) -> bool {
    name.split_once('~').is_some_and(|(stem, number)| {
        matches!(stem, "git" | "amby" | "obsidi" | "trash")
            && !number.is_empty()
            && number.bytes().all(|byte| byte.is_ascii_digit())
    })
}

/// `.<name>.amby-tmp-*`: the temporary file next to a target (Р4).
fn is_temporary_name(name: &str) -> bool {
    name.starts_with('.') && name.find(".amby-tmp-").is_some_and(|at| at >= 2)
}

/// Does a pass that would change `count` files of `total` stop and ask? At least `min_files`
/// (20) **and** more than `percent` per cent (10) of `total`: `count >= min_files` and
/// `count * 100 > total * percent`. So 20 of 200 goes on, 21 of 200 and 20 of 199 stop, and 19 of
/// 50 goes on. Р8, О6, Д54.
pub fn mass_change_reached(count: usize, total: usize, min_files: usize, percent: usize) -> bool {
    count >= min_files && (count as u128) * 100 > (total as u128) * (percent as u128)
}
