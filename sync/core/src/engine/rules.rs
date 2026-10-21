//! Small pure rules of the engine (Р4, Р8): what is not synchronised and when a pass stops.

/// Is this path excluded from synchronisation without a word (Р4, Д11)? `.git` at any depth;
/// `.obsidian/` and `.trash/` at the root; everything in `.amby/` except `properties.json`,
/// `blocks/`, `graph-layout.json` and `property-backups/`; temporary files
/// `.<name>.amby-tmp-*`; system litter (`.DS_Store`, `._*`, `Thumbs.db`, `desktop.ini`) at any
/// depth. `path` is relative, `/` separators.
pub fn is_excluded_path(path: &str) -> bool {
    let segments: Vec<&str> = path.split('/').collect();
    if segments.contains(&".git") {
        return true;
    }
    match segments[0] {
        ".obsidian" | ".trash" => return true,
        ".amby" => {
            let kept = match segments.get(1) {
                None => false,
                Some(&("properties.json" | "graph-layout.json")) => segments.len() == 2,
                Some(&("blocks" | "property-backups")) => true,
                Some(_) => false,
            };
            if !kept {
                return true;
            }
        }
        _ => {}
    }
    segments.iter().any(|name| {
        matches!(*name, ".DS_Store" | "Thumbs.db" | "desktop.ini")
            || name.starts_with("._")
            || is_temporary_name(name)
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
