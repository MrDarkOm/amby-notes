//! Three-way merge of a Markdown note (appendix Г, К1: Г4–Г19). A pure function of three byte
//! strings: no files, no network, no clock.
//!
//! The merge works on lines (bytes up to and including `\n`, nothing normalised, Г12 п. 1). The
//! edits of each side against the base are found with a longest-common-subsequence diff, widened
//! to whole places (blocks of code, tables, formulas, keys of the YAML header, Г11), and applied
//! together when no two of them overlap. The result is made only of lines of the three inputs, so
//! it can never hold a conflict mark (Г15 е).

use std::cmp::Ordering;

/// The largest base, local or remote version that is merged (Г5): 1 MiB. Larger files go straight to
/// a conflict set.
pub const MERGE_MAX_BYTES: usize = 1024 * 1024;

/// The most cells of the line comparison (lines of the base times lines of a version, after the
/// common beginning and end are cut off) the merge tries (Г12): 25 million. More is "too complex".
pub const MERGE_MAX_CELLS: u64 = 25_000_000;

/// Why a file is not merged but goes to a conflict set (Г5, Г12).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotMergeable {
    /// The path does not end in `.md`, or it is inside `.amby/`.
    NotMarkdown,
    /// A version is not valid UTF-8.
    NotUtf8,
    /// A version contains a `0x00` byte.
    HasNul,
    /// A version is larger than [`MERGE_MAX_BYTES`].
    TooLarge,
    /// The comparison would take more than [`MERGE_MAX_CELLS`] cells.
    TooComplex,
}

/// A place where the two sides edited the same spot: lines `start..end` of the base (Г12 п. 6).
/// A range is the union of the edits that overlap (Г12 п. 5), widened to whole places (Г11). An
/// insertion has `start == end`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Region {
    /// First line of the base in the region (0-based).
    pub start: usize,
    /// One past the last line of the base in the region.
    pub end: usize,
}

/// The answer of [`merge_text`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MergeOutcome {
    /// Every edit of both sides is in the bytes: the unchanged lines of the base byte for byte, the
    /// replacements byte for byte (Г14). Never contains a conflict mark (Г15 е).
    Clean(Vec<u8>),
    /// The sides edited the same place, or a check of Г13 failed. The whole file is a conflict
    /// ("all or nothing", Г12 п. 6); the regions are told in lines of the base, ascending. A
    /// conflict found by the checks of Г13 alone has no region.
    Conflict(Vec<Region>),
    /// The versions cannot be merged at all (Г5, Г12).
    NotMergeable(NotMergeable),
}

/// Is a file at `path` a candidate for merging (Г5)? The path ends in `.md` (any case) and is not
/// inside `.amby/`. Says nothing about the content: see [`merge_text`]. Г5.
pub fn is_mergeable_path(path: &str) -> bool {
    let inside_amby = path == ".amby" || path.starts_with(".amby/");
    let bytes = path.as_bytes();
    let is_md = bytes.len() >= 3 && bytes[bytes.len() - 3..].eq_ignore_ascii_case(b".md");
    is_md && !inside_amby
}

type Line<'a> = &'a [u8];

const BOM: &[u8] = &[0xEF, 0xBB, 0xBF];

fn split_lines(bytes: &[u8]) -> Vec<Line<'_>> {
    let mut out = Vec::new();
    let mut start = 0;
    for (i, b) in bytes.iter().enumerate() {
        if *b == b'\n' {
            out.push(&bytes[start..=i]);
            start = i + 1;
        }
    }
    if start < bytes.len() {
        out.push(&bytes[start..]);
    }
    out
}

fn strip_eol(line: Line<'_>) -> &[u8] {
    let line = line.strip_suffix(b"\n").unwrap_or(line);
    line.strip_suffix(b"\r").unwrap_or(line)
}

fn leading_blanks(line: &[u8], blanks: &[u8]) -> usize {
    line.iter()
        .position(|b| !blanks.contains(b))
        .unwrap_or(line.len())
}

/// An edit of one side: the lines `bs..be` of the base become `repl` (an insertion has `bs == be`).
#[derive(Debug, Clone)]
struct Hunk<'a> {
    bs: usize,
    be: usize,
    /// The same range in the side's own lines.
    ss: usize,
    se: usize,
    repl: Vec<Line<'a>>,
}

impl Hunk<'_> {
    fn is_insertion(&self) -> bool {
        self.be == self.bs
    }

    /// A replacement that ends in a line without `\n` closes the file: nothing may follow it (Г12 п. 5).
    fn closes_file(&self) -> bool {
        self.repl.last().is_some_and(|line| !line.ends_with(b"\n"))
    }

    fn same_edit(&self, other: &Hunk<'_>) -> bool {
        self.bs == other.bs && self.be == other.be && self.repl == other.repl
    }
}

/// Do the ranges of two edits overlap (Г12 п. 5)? Touching is not overlapping.
fn ranges_overlap(a: (usize, usize), b: (usize, usize)) -> bool {
    match (a.1 > a.0, b.1 > b.0) {
        (true, true) => a.0 < b.1 && b.0 < a.1,
        (false, false) => a.0 == b.0,
        (false, true) => b.0 < a.0 && a.0 < b.1,
        (true, false) => a.0 < b.0 && b.0 < a.1,
    }
}

/// The edits that turn `base` into `side`, or `None` when the comparison is too big (Г12 п. 7).
fn diff<'a>(base: &[Line<'a>], side: &[Line<'a>]) -> Option<Vec<Hunk<'a>>> {
    let mut pre = 0;
    while pre < base.len() && pre < side.len() && base[pre] == side[pre] {
        pre += 1;
    }
    let mut suf = 0;
    while suf < base.len() - pre
        && suf < side.len() - pre
        && base[base.len() - 1 - suf] == side[side.len() - 1 - suf]
    {
        suf += 1;
    }
    let (b, s) = (&base[pre..base.len() - suf], &side[pre..side.len() - suf]);
    if (b.len() as u64) * (s.len() as u64) > MERGE_MAX_CELLS {
        return None;
    }
    let (n, m) = (b.len(), s.len());
    let width = m + 1;
    let mut table = vec![0u32; (n + 1) * width];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            table[i * width + j] = if b[i] == s[j] {
                table[(i + 1) * width + j + 1] + 1
            } else {
                table[(i + 1) * width + j].max(table[i * width + j + 1])
            };
        }
    }
    // Matched pairs (base line, side line), the common beginning and end included.
    let mut pairs: Vec<(usize, usize)> = (0..pre).map(|k| (k, k)).collect();
    let (mut i, mut j) = (0, 0);
    while i < n && j < m {
        if b[i] == s[j] {
            pairs.push((i + pre, j + pre));
            i += 1;
            j += 1;
        } else if table[(i + 1) * width + j] >= table[i * width + j + 1] {
            i += 1;
        } else {
            j += 1;
        }
    }
    pairs.extend((0..suf).map(|k| (base.len() - suf + k, side.len() - suf + k)));
    pairs.push((base.len(), side.len()));

    let mut hunks = Vec::new();
    let (mut pb, mut ps) = (0usize, 0usize);
    for (mb, ms) in pairs {
        if mb > pb || ms > ps {
            hunks.push(Hunk {
                bs: pb,
                be: mb,
                ss: ps,
                se: ms,
                repl: side[ps..ms].to_vec(),
            });
        }
        pb = mb + 1;
        ps = ms + 1;
    }
    Some(hunks)
}

/// The YAML header (Г11 п. 5): the index of its closing line, when the first line is `---` and a
/// closing `---` or `...` follows.
fn header_close(lines: &[Line<'_>]) -> Option<usize> {
    if lines.first().map(|l| strip_eol(l)) != Some(b"---") {
        return None;
    }
    (1..lines.len()).find(|&k| matches!(strip_eol(lines[k]), b"---" | b"..."))
}

/// The opening of a fenced block of code: the fence character and its length.
fn fence_open(line: Line<'_>) -> Option<(u8, usize)> {
    let text = strip_eol(line);
    if leading_blanks(text, b" ") > 3 {
        return None;
    }
    let rest = &text[leading_blanks(text, b" ")..];
    let c = *rest.first()?;
    if c != b'`' && c != b'~' {
        return None;
    }
    let run = rest.iter().take_while(|b| **b == c).count();
    (run >= 3).then_some((c, run))
}

fn fence_close(line: Line<'_>, c: u8, len: usize) -> bool {
    let text = strip_eol(line);
    if leading_blanks(text, b" ") > 3 {
        return false;
    }
    let rest = &text[leading_blanks(text, b" ")..];
    let run = rest.iter().take_while(|b| **b == c).count();
    run >= len && rest[run..].iter().all(|b| *b == b' ' || *b == b'\t')
}

fn starts_with_pipe(line: Line<'_>) -> bool {
    let text = strip_eol(line);
    text[leading_blanks(text, b" \t")..].first() == Some(&b'|')
}

/// The places of the base that count as one unit (Г11): `(start, end)` in lines, ascending.
fn places(lines: &[Line<'_>]) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut i = 0;
    if let Some(close) = header_close(lines) {
        let mut k = 1;
        while k < close {
            let mut e = k + 1;
            while e < close {
                let line = lines[e];
                let continues = line
                    .first()
                    .is_none_or(|b| matches!(*b, b' ' | b'\t' | b'\n' | b'\r'))
                    || line.starts_with(b"- ");
                if !continues {
                    break;
                }
                e += 1;
            }
            if e - k > 1 {
                out.push((k, e));
            }
            k = e;
        }
        i = close + 1;
    }
    while i < lines.len() {
        if let Some((c, len)) = fence_open(lines[i]) {
            let mut e = i + 1;
            while e < lines.len() && !fence_close(lines[e], c, len) {
                e += 1;
            }
            let end = (e + 1).min(lines.len());
            out.push((i, end));
            i = end;
        } else if starts_with_pipe(lines[i]) {
            let mut e = i + 1;
            while e < lines.len() && starts_with_pipe(lines[e]) {
                e += 1;
            }
            if e - i > 1 {
                out.push((i, e));
            }
            i = e;
        } else if strip_eol(lines[i]).trim_ascii() == b"$$" {
            match lines[i + 1..]
                .iter()
                .position(|l| strip_eol(l).trim_ascii() == b"$$")
            {
                Some(off) => {
                    let end = i + 1 + off + 1;
                    out.push((i, end));
                    i = end;
                }
                None => i += 1,
            }
        } else {
            i += 1;
        }
    }
    out
}

/// Widens each edit to the whole places it touches (Г11 п. 4) and joins the edits of the same
/// side that now overlap.
fn widen<'a>(hunks: Vec<Hunk<'a>>, places: &[(usize, usize)], side: &[Line<'a>]) -> Vec<Hunk<'a>> {
    let mut widened: Vec<Hunk<'a>> = Vec::new();
    for h in hunks {
        let (mut s, mut e) = (h.bs, h.be);
        loop {
            let mut changed = false;
            for &(ps, pe) in places {
                let hit = if e > s {
                    ps < e && s < pe
                } else {
                    ps < s && s < pe
                };
                if hit && (ps < s || pe > e) {
                    s = s.min(ps);
                    e = e.max(pe);
                    changed = true;
                }
            }
            if !changed {
                break;
            }
        }
        let ss = h.ss - (h.bs - s);
        let se = h.se + (e - h.be);
        widened.push(Hunk {
            bs: s,
            be: e,
            ss,
            se,
            repl: side[ss..se].to_vec(),
        });
    }
    widened.sort_by_key(|h| (h.bs, h.be));
    let mut joined: Vec<Hunk<'a>> = Vec::new();
    for h in widened {
        if let Some(last) = joined.last_mut() {
            if ranges_overlap((last.bs, last.be), (h.bs, h.be)) {
                last.be = last.be.max(h.be);
                last.se = (h.se + (last.be - h.be)).max(last.se);
                last.repl = side[last.ss..last.se].to_vec();
                continue;
            }
        }
        joined.push(h);
    }
    joined
}

/// Do two edits of different sides conflict (Г12 п. 5)?
fn conflicts(a: &Hunk<'_>, b: &Hunk<'_>) -> bool {
    ranges_overlap((a.bs, a.be), (b.bs, b.be))
        || (a.closes_file() && b.is_insertion() && b.bs == a.be)
        || (b.closes_file() && a.is_insertion() && a.bs == b.be)
}

/// The top-level keys of the YAML header, in order (Г13 б).
fn header_keys(lines: &[Line<'_>]) -> Vec<Vec<u8>> {
    let Some(close) = header_close(lines) else {
        return Vec::new();
    };
    let mut keys = Vec::new();
    for line in &lines[1..close] {
        let text = strip_eol(line);
        if text.is_empty() || matches!(text[0], b' ' | b'\t' | b'-' | b'#') {
            continue;
        }
        if let Some(colon) = text.iter().position(|b| *b == b':') {
            keys.push(text[..colon].to_vec());
        }
    }
    keys
}

/// How many keys of the header occur more than once.
fn repeated_keys(lines: &[Line<'_>]) -> usize {
    let keys = header_keys(lines);
    keys.iter()
        .enumerate()
        .filter(|(i, k)| !keys[..*i].contains(k) && keys[*i + 1..].contains(k))
        .count()
}

/// The `amby-id` line of the header (Г13 а).
fn identity_line<'a>(lines: &[Line<'a>]) -> Option<Line<'a>> {
    let close = header_close(lines)?;
    lines[1..close]
        .iter()
        .copied()
        .find(|l| l.starts_with(b"amby-id:"))
}

/// Merges the edits of `local` and `remote` made to `base`: the three-way merge by lines of
/// appendix Г. Checks the content first (UTF-8, no `0x00`, sizes: Г5) and answers
/// [`MergeOutcome::NotMergeable`] when it cannot be merged. Pure and deterministic (Г18). Г4–Г15.
pub fn merge_text(base: &[u8], local: &[u8], remote: &[u8]) -> MergeOutcome {
    let all = [base, local, remote];
    if all.iter().any(|v| v.len() > MERGE_MAX_BYTES) {
        return MergeOutcome::NotMergeable(NotMergeable::TooLarge);
    }
    if all.iter().any(|v| std::str::from_utf8(v).is_err()) {
        return MergeOutcome::NotMergeable(NotMergeable::NotUtf8);
    }
    if all.iter().any(|v| v.contains(&0)) {
        return MergeOutcome::NotMergeable(NotMergeable::HasNul);
    }
    // Г13: the short ways come before any check of the result.
    if local == remote || remote == base {
        return MergeOutcome::Clean(local.to_vec());
    }
    if local == base {
        return MergeOutcome::Clean(remote.to_vec());
    }
    // Г14: the BOM is taken off before the merge and put back after it.
    let (base_bom, local_bom, remote_bom) = (
        base.starts_with(BOM),
        local.starts_with(BOM),
        remote.starts_with(BOM),
    );
    let bom = if local_bom == remote_bom {
        local_bom
    } else if local_bom == base_bom {
        remote_bom
    } else {
        local_bom
    };
    let text = |v: &'_ [u8], has_bom: bool| {
        if has_bom {
            v[BOM.len()..].to_vec()
        } else {
            v.to_vec()
        }
    };
    let (base_text, local_text, remote_text) = (
        text(base, base_bom),
        text(local, local_bom),
        text(remote, remote_bom),
    );
    let (base_lines, local_lines, remote_lines) = (
        split_lines(&base_text),
        split_lines(&local_text),
        split_lines(&remote_text),
    );
    let (Some(local_hunks), Some(remote_hunks)) = (
        diff(&base_lines, &local_lines),
        diff(&base_lines, &remote_lines),
    ) else {
        return MergeOutcome::NotMergeable(NotMergeable::TooComplex);
    };
    let units = places(&base_lines);
    let local_hunks = widen(local_hunks, &units, &local_lines);
    let remote_hunks = widen(remote_hunks, &units, &remote_lines);

    // Г13 а: the identity of a note is never changed silently.
    let base_id = identity_line(&base_lines);
    if identity_line(&local_lines) != base_id || identity_line(&remote_lines) != base_id {
        return MergeOutcome::Conflict(Vec::new());
    }

    let mut regions: Vec<(usize, usize)> = Vec::new();
    for a in &local_hunks {
        for b in &remote_hunks {
            if conflicts(a, b) && !a.same_edit(b) {
                regions.push((a.bs.min(b.bs), a.be.max(b.be)));
            }
        }
    }
    if !regions.is_empty() {
        regions.sort_unstable();
        let mut union: Vec<(usize, usize)> = Vec::new();
        for r in regions {
            match union.last_mut() {
                Some(last) if ranges_overlap(*last, r) => last.1 = last.1.max(r.1),
                _ => union.push(r),
            }
        }
        return MergeOutcome::Conflict(
            union
                .into_iter()
                .map(|(start, end)| Region { start, end })
                .collect(),
        );
    }

    // Both sides' edits, the identical ones once, in order of their start (Г12 п. 5).
    let mut all_hunks: Vec<&Hunk<'_>> = local_hunks.iter().collect();
    all_hunks.extend(
        remote_hunks
            .iter()
            .filter(|h| !local_hunks.iter().any(|a| a.same_edit(h))),
    );
    all_hunks.sort_by(|a, b| (a.bs, a.be).cmp(&(b.bs, b.be)).then(Ordering::Equal));
    let mut merged: Vec<Line<'_>> = Vec::new();
    let mut at = 0;
    for h in all_hunks {
        merged.extend_from_slice(&base_lines[at..h.bs]);
        merged.extend_from_slice(&h.repl);
        at = h.be;
    }
    merged.extend_from_slice(&base_lines[at..]);
    // Г13 б: both sides added the same key in different places.
    if repeated_keys(&merged) > repeated_keys(&base_lines) {
        return MergeOutcome::Conflict(Vec::new());
    }
    let mut out = Vec::new();
    if bom {
        out.extend_from_slice(BOM);
    }
    for line in merged {
        out.extend_from_slice(line);
    }
    MergeOutcome::Clean(out)
}
