//! Read a point-in-time copy of the SQLite index without opening its shared
//! memory file. SQLite readers normally change WAL read marks in `notes.db-shm`;
//! AI tools promise not to change *any* vault file. The copy lives only in RAM.
//!
//! We validate WAL checksums and apply only committed frames. A second digest
//! of both files detects a concurrent index write/checkpoint; a changing or
//! unusually large index is rejected rather than returning an inconsistent view.
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::Read;
use std::path::Path;

const MAX_INDEX_BYTES: u64 = 512 * 1024 * 1024;
const WAL_MAGIC: u32 = 0x377f0682;
const WAL_VERSION: u32 = 3_007_000;

fn read_file(
    root: &Path,
    name: &str,
    optional: bool,
    limit: u64,
    cancelled: &impl Fn() -> bool,
) -> Result<Option<Vec<u8>>, &'static str> {
    let path = crate::paths::confine_rel_no_symlinks(root, name).map_err(|_| "unavailable")?;
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if optional && error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("unavailable"),
    };
    if !metadata.is_file() {
        return Err("unavailable");
    }
    if metadata.len() > limit {
        return Err("indexTooLarge");
    }
    let mut bytes = Vec::new();
    let mut file = File::open(path).map_err(|_| "unavailable")?;
    let mut chunk = [0u8; 64 * 1024];
    loop {
        if cancelled() {
            return Err("cancelled");
        }
        let count = file.read(&mut chunk).map_err(|_| "unavailable")?;
        if count == 0 {
            break;
        }
        if bytes.len().saturating_add(count) as u64 > limit {
            return Err("indexTooLarge");
        }
        bytes.extend_from_slice(&chunk[..count]);
    }
    Ok(Some(bytes))
}

fn unchanged(
    root: &Path,
    name: &str,
    old: Option<&[u8]>,
    cancelled: &impl Fn() -> bool,
) -> Result<bool, &'static str> {
    // Read in chunks instead of allocating a second copy of a potentially large index.
    let path = crate::paths::confine_rel_no_symlinks(root, name).map_err(|_| "unavailable")?;
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(old.is_none()),
        Err(_) => return Err("unavailable"),
    };
    let Some(old) = old else { return Ok(false) };
    if !metadata.is_file() || metadata.len() != old.len() as u64 {
        return Ok(false);
    }
    let mut file = File::open(path).map_err(|_| "unavailable")?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        if cancelled() {
            return Err("cancelled");
        }
        let read = file.read(&mut buffer).map_err(|_| "unavailable")?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    let mut expected = Sha256::new();
    for chunk in old.chunks(64 * 1024) {
        if cancelled() {
            return Err("cancelled");
        }
        expected.update(chunk);
    }
    Ok(hasher.finalize() == expected.finalize())
}

fn word(bytes: &[u8]) -> u32 {
    u32::from_be_bytes(bytes.try_into().expect("four-byte WAL word"))
}
fn checksum(bytes: &[u8], big_endian: bool, mut value: (u32, u32)) -> (u32, u32) {
    for pair in bytes.chunks_exact(8) {
        let number = |input: &[u8]| {
            if big_endian {
                word(input)
            } else {
                u32::from_le_bytes(input.try_into().expect("four-byte WAL word"))
            }
        };
        value.0 = value
            .0
            .wrapping_add(number(&pair[..4]))
            .wrapping_add(value.1);
        value.1 = value
            .1
            .wrapping_add(number(&pair[4..]))
            .wrapping_add(value.0);
    }
    value
}

#[derive(Clone, PartialEq, Eq)]
struct WalIndexHeader {
    bytes: [u8; 48],
    frames: usize,
    pages: usize,
}

fn native_word(bytes: &[u8]) -> u32 {
    u32::from_ne_bytes(bytes.try_into().expect("four-byte WAL index word"))
}

fn index_header(root: &Path) -> Result<Option<WalIndexHeader>, &'static str> {
    let path = crate::paths::confine_rel_no_symlinks(root, ".amby/notes.db-shm")
        .map_err(|_| "unavailable")?;
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("unavailable"),
    };
    if !metadata.is_file() || metadata.len() < 96 {
        return Err("unavailable");
    }
    // SQLite reserves lock bytes starting at offset 120. Read only its two
    // documented 48-byte header copies, never the lock-byte region.
    let mut bytes = [0u8; 96];
    File::open(path)
        .map_err(|_| "unavailable")?
        .read_exact(&mut bytes)
        .map_err(|_| "unavailable")?;
    if bytes[..48] != bytes[48..] || bytes[12] != 1 || native_word(&bytes[..4]) != WAL_VERSION {
        return Err("unavailable");
    }
    let sum = checksum(&bytes[..40], cfg!(target_endian = "big"), (0, 0));
    if sum != (native_word(&bytes[40..44]), native_word(&bytes[44..48])) {
        return Err("unavailable");
    }
    Ok(Some(WalIndexHeader {
        bytes: bytes[..48].try_into().expect("WAL index header"),
        frames: native_word(&bytes[16..20]) as usize,
        pages: native_word(&bytes[20..24]) as usize,
    }))
}

fn apply_wal(
    database: &mut Vec<u8>,
    wal: &[u8],
    page_size: usize,
    index: &WalIndexHeader,
    cancelled: &impl Fn() -> bool,
) -> Result<(), &'static str> {
    if index.frames == 0 {
        return Ok(());
    }
    if wal.len() < 32 {
        return Err("unavailable");
    }
    let magic = word(&wal[0..4]);
    if magic & !1 != WAL_MAGIC
        || word(&wal[4..8]) != WAL_VERSION
        || word(&wal[8..12]) as usize != page_size
    {
        return Err("unavailable");
    }
    let big_endian = magic & 1 != 0;
    if index.bytes[32..40] != wal[16..24] || index.bytes[13] != u8::from(big_endian) {
        return Err("unavailable");
    }
    let mut sum = checksum(&wal[..24], big_endian, (0, 0));
    if sum != (word(&wal[24..28]), word(&wal[28..32])) {
        return Err("unavailable");
    }
    let frame_size = 24 + page_size;
    let mut valid_frames = Vec::new();
    for frame in wal[32..].chunks_exact(frame_size).take(index.frames) {
        if cancelled() {
            return Err("cancelled");
        }
        let page = word(&frame[..4]) as usize;
        if page == 0 || frame[8..16] != wal[16..24] {
            return Err("unavailable");
        }
        sum = checksum(&frame[..8], big_endian, sum);
        sum = checksum(&frame[24..], big_endian, sum);
        if sum != (word(&frame[16..20]), word(&frame[20..24])) {
            return Err("unavailable");
        }
        let commit_pages = word(&frame[4..8]) as usize;
        valid_frames.push((page, commit_pages, &frame[24..]));
    }
    if valid_frames.len() != index.frames
        || valid_frames.last().map(|frame| frame.1) != Some(index.pages)
        || sum
            != (
                native_word(&index.bytes[24..28]),
                native_word(&index.bytes[28..32]),
            )
    {
        return Err("unavailable");
    }
    for (page, commit_pages, contents) in valid_frames {
        if cancelled() {
            return Err("cancelled");
        }
        let end = page.checked_mul(page_size).ok_or("unavailable")?;
        if end as u64 > MAX_INDEX_BYTES {
            return Err("unavailable");
        }
        if database.len() < end {
            database.resize(end, 0);
        }
        database[end - page_size..end].copy_from_slice(contents);
        if commit_pages != 0 {
            let size = commit_pages.checked_mul(page_size).ok_or("unavailable")?;
            if size as u64 > MAX_INDEX_BYTES {
                return Err("unavailable");
            }
            database.resize(size, 0);
        }
    }
    Ok(())
}

pub(super) struct IndexSnapshot {
    // Fields drop in declaration order: SQLite closes before its borrowed image.
    connection: rusqlite::Connection,
    _image: Vec<u8>,
}

impl std::ops::Deref for IndexSnapshot {
    type Target = rusqlite::Connection;
    fn deref(&self) -> &Self::Target {
        &self.connection
    }
}

pub(super) fn open(
    root: &Path,
    cancelled: impl Fn() -> bool,
) -> Result<IndexSnapshot, &'static str> {
    let mut captured = None;
    for _ in 0..3 {
        let index = index_header(root)?;
        let db = read_file(root, ".amby/notes.db", false, MAX_INDEX_BYTES, &cancelled)?
            .ok_or("unavailable")?;
        let wal = read_file(
            root,
            ".amby/notes.db-wal",
            true,
            MAX_INDEX_BYTES - db.len() as u64,
            &cancelled,
        )?;
        if unchanged(root, ".amby/notes.db", Some(&db), &cancelled)?
            && unchanged(root, ".amby/notes.db-wal", wal.as_deref(), &cancelled)?
            && index_header(root)? == index
        {
            captured = Some((db, wal, index));
            break;
        }
    }
    let (mut db, wal, index) = captured.ok_or("unavailable")?;
    if db.len() < 100 || &db[..16] != b"SQLite format 3\0" {
        return Err("unavailable");
    }
    let encoded = u16::from_be_bytes([db[16], db[17]]) as usize;
    let page_size = if encoded == 1 { 65_536 } else { encoded };
    if !(512..=65_536).contains(&page_size)
        || !page_size.is_power_of_two()
        || db.len() % page_size != 0
    {
        return Err("unavailable");
    }
    match (wal, index) {
        (Some(wal), Some(index)) => apply_wal(&mut db, &wal, page_size, &index, &cancelled)?,
        (None, Some(index)) if index.frames != 0 => return Err("unavailable"),
        (Some(wal), None) if !wal.is_empty() => return Err("unavailable"),
        _ => (),
    }
    if db.len() < 100 {
        return Err("unavailable");
    }
    if cancelled() {
        return Err("cancelled");
    }
    // An in-memory database has no WAL file. The image now contains all
    // committed pages, so its header must use rollback-journal format.
    db[18] = 1;
    db[19] = 1;
    let connection = rusqlite::Connection::open_in_memory().map_err(|_| "unavailable")?;
    // SAFETY: The Vec's allocation is stable when the Vec moves into the
    // returned wrapper. SQLite sees it read-only and the connection is dropped
    // before the Vec, so SQLite never outlives or frees the borrowed buffer.
    unsafe {
        let result = rusqlite::ffi::sqlite3_deserialize(
            connection.handle(),
            c"main".as_ptr(),
            db.as_mut_ptr(),
            db.len() as i64,
            db.len() as i64,
            rusqlite::ffi::SQLITE_DESERIALIZE_READONLY,
        );
        if result != rusqlite::ffi::SQLITE_OK {
            return Err("unavailable");
        }
    }
    Ok(IndexSnapshot {
        connection,
        _image: db,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (std::path::PathBuf, rusqlite::Connection) {
        let root = std::env::temp_dir().join(format!("amby-ai-index-{}", ulid::Ulid::generate()));
        fs::create_dir(&root).unwrap();
        let conn = crate::index::open_connection(&root).unwrap();
        (root, conn)
    }
    fn insert(conn: &rusqlite::Connection, id: &str, body: &str) {
        conn.execute("INSERT INTO notes (id,path,title,mtime,size,content,word_count,created_at,updated_at) VALUES (?1,?1,?1,0,0,?2,1,0,0)", rusqlite::params![id, body]).unwrap();
    }
    fn count(index: &rusqlite::Connection) -> i64 {
        index
            .query_row("SELECT count(*) FROM notes", [], |row| row.get(0))
            .unwrap()
    }
    #[test]
    fn committed_wal_uncommitted_changes_and_checkpoint_match_sqlite() {
        let (root, conn) = fixture();
        insert(&conn, "a", "first searchable");
        assert_eq!(count(&open(&root, || false).unwrap()), 1);
        conn.execute_batch("BEGIN; INSERT INTO notes (id,path,title,mtime,size,content,word_count,created_at,updated_at) VALUES ('b','b','b',0,0,'second',1,0,0);").unwrap();
        assert_eq!(count(&open(&root, || false).unwrap()), 1);
        conn.execute_batch("COMMIT").unwrap();
        let snapshot = open(&root, || false).unwrap();
        assert_eq!(count(&snapshot), 2);
        assert_eq!(
            crate::index::search_notes(&snapshot, &root, "searchable")
                .unwrap()
                .len(),
            1
        );
        drop(snapshot);
        conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
            .unwrap();
        assert_eq!(count(&open(&root, || false).unwrap()), 2);
        insert(&conn, "c", "third");
        assert_eq!(count(&open(&root, || false).unwrap()), 3);
        drop(conn);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn corrupted_frame_is_refused_and_cancellation_is_observed() {
        let (root, conn) = fixture();
        insert(&conn, "a", "text");
        let index = index_header(&root).unwrap().unwrap();
        assert!(index.frames > 0);
        let mut db = read_file(&root, ".amby/notes.db", false, MAX_INDEX_BYTES, &|| false)
            .unwrap()
            .unwrap();
        let mut wal = read_file(&root, ".amby/notes.db-wal", false, MAX_INDEX_BYTES, &|| {
            false
        })
        .unwrap()
        .unwrap();
        let page_size = word(&wal[8..12]) as usize;
        wal[32 + 24] ^= 1;
        assert_eq!(
            apply_wal(&mut db, &wal, page_size, &index, &|| false),
            Err("unavailable")
        );
        assert!(matches!(open(&root, || true), Err("cancelled")));
        drop(conn);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn snapshots_match_sqlite_across_page_sizes_updates_deletes_and_checkpoints() {
        for page_size in [1024, 4096, 65_536] {
            let root =
                std::env::temp_dir().join(format!("amby-ai-pages-{}", ulid::Ulid::generate()));
            fs::create_dir_all(root.join(".amby")).unwrap();
            let conn = rusqlite::Connection::open(root.join(".amby/notes.db")).unwrap();
            conn.execute_batch(&format!(
                "PRAGMA page_size={page_size}; PRAGMA journal_mode=WAL;"
            ))
            .unwrap();
            crate::index::init_schema(&conn).unwrap();
            for number in 0..12 {
                insert(
                    &conn,
                    &format!("note-{number}"),
                    &format!("word-{number} {}", "x".repeat(number * 700)),
                );
                if number % 3 == 0 {
                    conn.execute_batch("PRAGMA wal_checkpoint(PASSIVE)")
                        .unwrap();
                }
                let snapshot = open(&root, || false).unwrap();
                assert_eq!(count(&snapshot), number as i64 + 1);
            }
            conn.execute("UPDATE notes SET content='changed' WHERE id='note-4'", [])
                .unwrap();
            conn.execute("DELETE FROM notes WHERE id='note-5'", [])
                .unwrap();
            let snapshot = open(&root, || false).unwrap();
            let rows = |db: &rusqlite::Connection| {
                let mut statement = db
                    .prepare("SELECT id, content FROM notes ORDER BY id")
                    .unwrap();
                statement
                    .query_map([], |row| {
                        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                    })
                    .unwrap()
                    .map(Result::unwrap)
                    .collect::<Vec<_>>()
            };
            assert_eq!(rows(&snapshot), rows(&conn));
            drop(snapshot);
            drop(conn);
            fs::remove_dir_all(root).unwrap();
        }
    }
}
