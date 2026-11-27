//! The reference three-way line merge of the simulation (docs/sync-plan.md, appendix Г, Г5–Г15):
//! the mini-engine merges with it, and the checks of the simulation use it as an oracle. It is
//! written separately from `sync/core/src/engine/merge.rs` (which is `todo!()` until the engine of
//! stage Э4б is written), plain and slow. It was run against `sync/core/tests/engine_merge*.rs`
//! to show that those tests can be satisfied.

use std::cmp::Ordering;

pub const MAX_BYTES: usize = 1024 * 1024;
pub const MAX_CELLS: u64 = 25_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotMergeable {
    NotUtf8,
    HasNul,
    TooLarge,
    TooComplex,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Clean(Vec<u8>),
    Conflict(Vec<(usize, usize)>),
    NotMergeable(NotMergeable),
}

type Line<'a> = &'a [u8];

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

#[derive(Debug, Clone)]
struct Hunk<'a> {
    bs: usize,
    be: usize,
    ss: usize,
    se: usize,
    repl: Vec<Line<'a>>,
}

/// Hunks turning `base` into `side`, or `None` if the comparison is too big.
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
    if (b.len() as u64) * (s.len() as u64) > MAX_CELLS {
        return None;
    }
    // LCS table
    let (n, m) = (b.len(), s.len());
    let mut table = vec![0u32; (n + 1) * (m + 1)];
    let at = |i: usize, j: usize| i * (m + 1) + j;
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            table[at(i, j)] = if b[i] == s[j] {
                table[at(i + 1, j + 1)] + 1
            } else {
                table[at(i + 1, j)].max(table[at(i, j + 1)])
            };
        }
    }
    let mut pairs: Vec<(usize, usize)> = Vec::new();
    let (mut i, mut j) = (0, 0);
    while i < n && j < m {
        if b[i] == s[j] {
            pairs.push((i + pre, j + pre));
            i += 1;
            j += 1;
        } else if table[at(i + 1, j)] >= table[at(i, j + 1)] {
            i += 1;
        } else {
            j += 1;
        }
    }
    // pairs plus sentinels give the gaps
    let mut hunks = Vec::new();
    let (mut pb, mut ps) = (0usize, 0usize);
    let mut all: Vec<(usize, usize)> = (0..pre).map(|k| (k, k)).collect();
    all.extend(pairs);
    all.extend((0..suf).map(|k| (base.len() - suf + k, side.len() - suf + k)));
    all.push((base.len(), side.len()));
    for (mb, ms) in all {
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

fn is_header_start(lines: &[Line<'_>]) -> Option<usize> {
    if lines.is_empty() || strip_eol(lines[0]) != b"---" {
        return None;
    }
    (1..lines.len()).find(|&k| matches!(strip_eol(lines[k]), b"---" | b"..."))
}

fn fence_open(line: Line<'_>) -> Option<(u8, usize)> {
    let t = strip_eol(line);
    let trimmed = t.iter().position(|b| *b != b' ').unwrap_or(t.len());
    if trimmed > 3 {
        return None;
    }
    let rest = &t[trimmed..];
    let c = *rest.first()?;
    if c != b'`' && c != b'~' {
        return None;
    }
    let run = rest.iter().take_while(|b| **b == c).count();
    if run >= 3 {
        Some((c, run))
    } else {
        None
    }
}

fn fence_close(line: Line<'_>, c: u8, len: usize) -> bool {
    let t = strip_eol(line);
    let trimmed = t.iter().position(|b| *b != b' ').unwrap_or(t.len());
    if trimmed > 3 {
        return false;
    }
    let rest = &t[trimmed..];
    let run = rest.iter().take_while(|b| **b == c).count();
    run >= len && rest[run..].iter().all(|b| *b == b' ' || *b == b'\t')
}

/// Atomic multi-line places of the base (Г11): (start, end) ranges.
fn atoms(lines: &[Line<'_>]) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut i = 0;
    if let Some(close) = is_header_start(lines) {
        let mut k = 1;
        while k < close {
            let mut e = k + 1;
            while e < close {
                let t = lines[e];
                let cont = t.first().map_or(true, |b| {
                    *b == b' ' || *b == b'\t' || *b == b'\n' || *b == b'\r'
                }) || t.starts_with(b"- ");
                if cont {
                    e += 1;
                } else {
                    break;
                }
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
            continue;
        }
        let t = strip_eol(lines[i]);
        let ts = t
            .iter()
            .position(|b| *b != b' ' && *b != b'\t')
            .unwrap_or(t.len());
        if t[ts..].first() == Some(&b'|') {
            let mut e = i + 1;
            while e < lines.len() {
                let u = strip_eol(lines[e]);
                let us = u
                    .iter()
                    .position(|b| *b != b' ' && *b != b'\t')
                    .unwrap_or(u.len());
                if u[us..].first() == Some(&b'|') {
                    e += 1;
                } else {
                    break;
                }
            }
            if e - i > 1 {
                out.push((i, e));
            }
            i = e;
            continue;
        }
        if strip_eol(lines[i]).trim_ascii() == b"$$" {
            if let Some(off) = lines[i + 1..]
                .iter()
                .position(|l| strip_eol(l).trim_ascii() == b"$$")
            {
                let end = i + 1 + off + 1;
                out.push((i, end));
                i = end;
                continue;
            }
        }
        i += 1;
    }
    out
}

fn widen<'a>(
    hunks: Vec<Hunk<'a>>,
    groups: &[(usize, usize)],
    base: &[Line<'a>],
    side: &[Line<'a>],
) -> Vec<Hunk<'a>> {
    let mut widened: Vec<Hunk<'a>> = Vec::new();
    for h in hunks {
        let (mut s, mut e) = (h.bs, h.be);
        loop {
            let mut changed = false;
            for &(gs, ge) in groups {
                let hit = if e > s {
                    gs < e && s < ge
                } else {
                    gs < s && s < ge
                };
                if hit && (gs < s || ge > e) {
                    s = s.min(gs);
                    e = e.max(ge);
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
    // same side hunks that now overlap are one hunk
    widened.sort_by_key(|h| (h.bs, h.be));
    let mut merged: Vec<Hunk<'a>> = Vec::new();
    for h in widened {
        if let Some(last) = merged.last_mut() {
            let overlap = if last.be > last.bs && h.be > h.bs {
                h.bs < last.be
            } else if last.be == last.bs && h.be == h.bs {
                h.bs == last.bs
            } else if last.be == last.bs {
                last.bs > h.bs && last.bs < h.be
            } else {
                h.bs > last.bs && h.bs < last.be
            };
            if overlap {
                let e = last.be.max(h.be);
                let se = h.se + (e - h.be);
                last.be = e;
                last.se = se.max(last.se);
                last.repl = side[last.ss..last.se].to_vec();
                continue;
            }
        }
        merged.push(h);
    }
    let _ = base;
    merged
}

/// A replacement that ends with a line without `\n` closes the file: nothing may follow it.
fn open_end(h: &Hunk<'_>) -> bool {
    h.repl.last().is_some_and(|l| !l.ends_with(b"\n"))
}

fn intersects(a: &Hunk<'_>, b: &Hunk<'_>) -> bool {
    let by_range = match (a.be > a.bs, b.be > b.bs) {
        (true, true) => a.bs < b.be && b.bs < a.be,
        (false, false) => a.bs == b.bs,
        (false, true) => b.bs < a.bs && a.bs < b.be,
        (true, false) => a.bs < b.bs && b.bs < a.be,
    };
    by_range
        || (open_end(a) && b.be == b.bs && b.bs == a.be)
        || (open_end(b) && a.be == a.bs && a.bs == b.be)
}

fn top_level_keys(lines: &[Line<'_>]) -> Vec<Vec<u8>> {
    let Some(close) = is_header_start(lines) else {
        return Vec::new();
    };
    let mut keys = Vec::new();
    for l in &lines[1..close] {
        let t = strip_eol(l);
        if t.is_empty() || t[0] == b' ' || t[0] == b'\t' || t[0] == b'-' || t[0] == b'#' {
            continue;
        }
        if let Some(colon) = t.iter().position(|b| *b == b':') {
            keys.push(t[..colon].to_vec());
        }
    }
    keys
}

fn duplicate_keys(lines: &[Line<'_>]) -> usize {
    let keys = top_level_keys(lines);
    let mut count = 0;
    for (i, k) in keys.iter().enumerate() {
        if !keys[..i].contains(k) && keys[i + 1..].contains(k) {
            count += 1;
        }
    }
    count
}

fn identity(lines: &[Line<'_>]) -> Option<Vec<u8>> {
    let close = is_header_start(lines)?;
    lines[1..close]
        .iter()
        .find(|l| l.starts_with(b"amby-id:"))
        .map(|l| l.to_vec())
}

/// Merges `local` and `remote` against `base` by the rules of appendix Г.
pub fn merge(base: &[u8], local: &[u8], remote: &[u8]) -> Outcome {
    for v in [base, local, remote] {
        if v.len() > MAX_BYTES {
            return Outcome::NotMergeable(NotMergeable::TooLarge);
        }
    }
    for v in [base, local, remote] {
        if std::str::from_utf8(v).is_err() {
            return Outcome::NotMergeable(NotMergeable::NotUtf8);
        }
    }
    for v in [base, local, remote] {
        if v.contains(&0) {
            return Outcome::NotMergeable(NotMergeable::HasNul);
        }
    }
    if local == remote || remote == base {
        return Outcome::Clean(local.to_vec());
    }
    if local == base {
        return Outcome::Clean(remote.to_vec());
    }
    const BOM: &[u8] = &[0xEF, 0xBB, 0xBF];
    let (bb, lb, rb) = (
        base.starts_with(BOM),
        local.starts_with(BOM),
        remote.starts_with(BOM),
    );
    let bom = if lb == rb {
        lb
    } else if lb == bb {
        rb
    } else {
        lb
    };
    let strip = |v: &'_ [u8], has: bool| if has { v[3..].to_vec() } else { v.to_vec() };
    let (base_t, local_t, remote_t) = (strip(base, bb), strip(local, lb), strip(remote, rb));
    let (bl, ll, rl) = (
        split_lines(&base_t),
        split_lines(&local_t),
        split_lines(&remote_t),
    );
    let (Some(lh), Some(rh)) = (diff(&bl, &ll), diff(&bl, &rl)) else {
        return Outcome::NotMergeable(NotMergeable::TooComplex);
    };
    let groups = atoms(&bl);
    let lh = widen(lh, &groups, &bl, &ll);
    let rh = widen(rh, &groups, &bl, &rl);

    if identity(&ll) != identity(&bl) || identity(&rl) != identity(&bl) {
        return Outcome::Conflict(Vec::new());
    }

    // identical hunks are taken once
    let same = |a: &Hunk<'_>, b: &Hunk<'_>| a.bs == b.bs && a.be == b.be && a.repl == b.repl;
    let mut regions: Vec<(usize, usize)> = Vec::new();
    for a in &lh {
        for b in &rh {
            if intersects(a, b) && !same(a, b) {
                regions.push((a.bs.min(b.bs), a.be.max(b.be)));
            }
        }
    }
    if !regions.is_empty() {
        regions.sort();
        let mut union: Vec<(usize, usize)> = Vec::new();
        for r in regions {
            if let Some(last) = union.last_mut() {
                let overlaps = if last.1 > last.0 && r.1 > r.0 {
                    r.0 < last.1
                } else if last.1 == last.0 && r.1 == r.0 {
                    r.0 == last.0
                } else if last.1 == last.0 {
                    last.0 > r.0 && last.0 < r.1
                } else {
                    r.0 > last.0 && r.0 < last.1
                };
                if overlaps {
                    last.1 = last.1.max(r.1);
                    continue;
                }
            }
            union.push(r);
        }
        return Outcome::Conflict(union);
    }
    // apply
    let mut all: Vec<&Hunk<'_>> = Vec::new();
    for h in &lh {
        all.push(h);
    }
    for h in &rh {
        if !lh.iter().any(|a| same(a, h)) {
            all.push(h);
        }
    }
    all.sort_by(|a, b| (a.bs, a.be).cmp(&(b.bs, b.be)).then(Ordering::Equal));
    let mut out_lines: Vec<Line<'_>> = Vec::new();
    let mut pos = 0;
    for h in all {
        out_lines.extend_from_slice(&bl[pos..h.bs]);
        out_lines.extend_from_slice(&h.repl);
        pos = h.be;
    }
    out_lines.extend_from_slice(&bl[pos..]);
    if duplicate_keys(&out_lines) > duplicate_keys(&bl) {
        return Outcome::Conflict(Vec::new());
    }
    let mut out = Vec::new();
    if bom {
        out.extend_from_slice(BOM);
    }
    for l in out_lines {
        out.extend_from_slice(l);
    }
    Outcome::Clean(out)
}
