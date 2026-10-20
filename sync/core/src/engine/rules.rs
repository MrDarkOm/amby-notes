//! Small pure rules of the engine (Р4, Р8): what is not synchronised and when a pass stops.

/// Is this path excluded from synchronisation without a word (Р4, Д11)? `.git` at any depth;
/// `.obsidian/` and `.trash/` at the root; everything in `.amby/` except `properties.json`,
/// `blocks/`, `graph-layout.json` and `property-backups/`; temporary files
/// `.<name>.amby-tmp-*`; system litter (`.DS_Store`, `._*`, `Thumbs.db`, `desktop.ini`) at any
/// depth. `path` is relative, `/` separators.
pub fn is_excluded_path(_path: &str) -> bool {
    todo!("Р4, Д11: paths that are not synchronised")
}

/// Does a pass that would change `count` files of `total` stop and ask? At least `min_files`
/// (20) **and** more than `percent` per cent (10) of `total`: `count >= min_files` and
/// `count * 100 > total * percent`. So 20 of 200 goes on, 21 of 200 and 20 of 199 stop, and 19 of
/// 50 goes on. Р8, О6, Д54.
pub fn mass_change_reached(
    _count: usize,
    _total: usize,
    _min_files: usize,
    _percent: usize,
) -> bool {
    todo!("Р8, О6, Д54: mass-change threshold")
}
