//! Opening a body as a stream (Э3, Ф24, Д68): the same answers as `open_body`, but chunk by
//! chunk into a sink, with bounded memory, and distinguishing a broken connection from damaged
//! data. Red until written.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::io::{Cursor, Read, Write};

use amby_sync_core::crypto::body::{open_body, seal_body};
use amby_sync_core::crypto::keys::{BodyId, SpaceKey};
use amby_sync_core::crypto::primitives::blake3_hash;
use amby_sync_core::crypto::random::OsRandom;
use amby_sync_core::crypto::CryptoError;
use amby_sync_core::engine::stream::{open_body_stream, StreamError};
use proptest::prelude::*;

const CHUNK: usize = 65_536;

fn vk() -> SpaceKey {
    SpaceKey::from_bytes([0x21; 32], 1)
}
fn body_id() -> BodyId {
    BodyId::from_bytes([0x33; 16])
}
fn pattern(len: usize) -> Vec<u8> {
    (0..len)
        .map(|i| ((i * 31 + (i >> 8) * 7 + 7) % 256) as u8)
        .collect()
}
fn seal(content: &[u8]) -> Vec<u8> {
    seal_body(&vk(), &body_id(), content, &mut OsRandom).unwrap()
}

/// What the stream function gave: the written bytes and the verdict.
struct Run {
    written: Vec<u8>,
    max_write: usize,
    result: Result<(), StreamError>,
}

struct Recorder {
    bytes: Vec<u8>,
    max_write: usize,
}
impl Write for Recorder {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.max_write = self.max_write.max(buf.len());
        self.bytes.extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn stream(size: u64, hash: &[u8; 32], sealed: &[u8]) -> Run {
    let mut sink = Recorder {
        bytes: vec![],
        max_write: 0,
    };
    let result = open_body_stream(
        &vk(),
        &body_id(),
        size,
        hash,
        &mut Cursor::new(sealed.to_vec()),
        &mut sink,
    );
    Run {
        written: sink.bytes,
        max_write: sink.max_write,
        result,
    }
}

/// The answer of Э1 and the answer of the stream agree (Д68).
fn assert_agree(size: u64, hash: &[u8; 32], sealed: &[u8], what: &str) {
    let whole = open_body(&vk(), &body_id(), size, hash, sealed);
    let run = stream(size, hash, sealed);
    match (whole, run.result) {
        (Ok(content), Ok(())) => assert_eq!(run.written, content, "{what}: same content"),
        (Err(expected), Err(StreamError::Crypto(got))) => {
            assert_eq!(got, expected, "{what}: same error")
        }
        (a, b) => panic!("{what}: open_body says {a:?}, the stream says {b:?}"),
    }
}

#[test]
fn contents_of_every_edge_size_come_out_byte_for_byte() {
    // Р6, О7, Ф21, Ф24: around the chunk boundaries and the Padmé padding.
    for size in [
        0usize, 1, 15, 16, 17, 255, 65_535, 65_536, 65_537, 131_071, 131_072, 131_073, 200_000,
        1_000_000,
    ] {
        let content = pattern(size);
        let sealed = seal(&content);
        let run = stream(size as u64, &blake3_hash(&content), &sealed);
        run.result.unwrap_or_else(|e| panic!("size {size}: {e}"));
        assert_eq!(run.written, content, "size {size}");
        assert!(
            run.max_write <= CHUNK,
            "size {size}: a write of {} bytes",
            run.max_write
        );
    }
}

struct SpyReader {
    inner: Cursor<Vec<u8>>,
    biggest_request: usize,
}
impl Read for SpyReader {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        self.biggest_request = self.biggest_request.max(buf.len());
        self.inner.read(buf)
    }
}

#[test]
fn the_source_is_never_asked_for_more_than_a_few_chunks_at_once() {
    // Ф24: memory is bounded; a reader that reads the whole body at once would defeat it.
    let content = pattern(600_000);
    let mut source = SpyReader {
        inner: Cursor::new(seal(&content)),
        biggest_request: 0,
    };
    let mut sink = Recorder {
        bytes: vec![],
        max_write: 0,
    };
    open_body_stream(
        &vk(),
        &body_id(),
        600_000,
        &blake3_hash(&content),
        &mut source,
        &mut sink,
    )
    .unwrap();
    assert!(
        source.biggest_request <= 2 * (CHUNK + 16),
        "asked for {} bytes at once",
        source.biggest_request
    );
}

#[test]
fn every_kind_of_damage_gives_the_answer_open_body_gives() {
    // Р6, С5, Ф22–Ф25, Д68: tampering with each region.
    let content = pattern(200_000);
    let hash = blake3_hash(&content);
    let sealed = seal(&content);
    let size = content.len() as u64;
    let mut cases: Vec<(String, Vec<u8>)> = vec![];
    for (name, at) in [
        ("magic", 0),
        ("version", 8),
        ("epoch", 10),
        ("nonce prefix", 20),
        ("first chunk", 40),
        ("second chunk", CHUNK + 100),
        ("last chunk", sealed.len() - 30),
        ("last tag", sealed.len() - 1),
    ] {
        let mut bad = sealed.clone();
        bad[at] ^= 0x01;
        cases.push((format!("a flipped byte in the {name}"), bad));
    }
    let mut longer = sealed.clone();
    longer.push(0);
    cases.push(("an extra byte".into(), longer));
    cases.push((
        "the last byte missing".into(),
        sealed[..sealed.len() - 1].to_vec(),
    ));
    cases.push(("only the preamble".into(), sealed[..32].to_vec()));
    cases.push(("nothing".into(), vec![]));
    cases.push(("cut in the preamble".into(), sealed[..20].to_vec()));
    cases.push((
        "the last chunk dropped".into(),
        sealed[..32 + 2 * (CHUNK + 16)].to_vec(),
    ));
    let mut twice = sealed[..32 + CHUNK + 16].to_vec();
    twice.extend_from_slice(&sealed[32..32 + CHUNK + 16]);
    twice.extend_from_slice(&sealed[32 + 2 * (CHUNK + 16)..]);
    cases.push(("the first chunk twice".into(), twice));
    let mut swapped = sealed.clone();
    let (a, b) = (32, 32 + CHUNK + 16);
    let first: Vec<u8> = sealed[a..a + CHUNK + 16].to_vec();
    let second: Vec<u8> = sealed[b..b + CHUNK + 16].to_vec();
    swapped[a..a + CHUNK + 16].copy_from_slice(&second);
    swapped[b..b + CHUNK + 16].copy_from_slice(&first);
    cases.push(("two chunks swapped".into(), swapped));
    for (what, bad) in cases {
        assert_agree(size, &hash, &bad, &what);
        assert!(
            stream(size, &hash, &bad).result.is_err(),
            "{what} must be refused"
        );
    }
}

#[test]
fn wrong_header_values_give_the_answer_open_body_gives() {
    // Ф22, С5: a size or a hash that does not fit the decrypted body.
    let content = pattern(70_000);
    let hash = blake3_hash(&content);
    let sealed = seal(&content);
    assert_agree(70_001, &hash, &sealed, "size one too big");
    assert_agree(69_999, &hash, &sealed, "size one too small");
    assert_agree(0, &hash, &sealed, "size zero");
    assert_agree(1u64 << 62, &hash, &sealed, "huge size");
    assert_agree((1u64 << 62) + 1, &hash, &sealed, "size above 2^62");
    let mut wrong = hash;
    wrong[0] ^= 1;
    assert_agree(70_000, &wrong, &sealed, "wrong hash");
    let error = stream(70_000, &wrong, &sealed).result.unwrap_err();
    assert!(error.to_string().contains("hash"), "{error}");
}

#[test]
fn another_key_body_id_or_epoch_does_not_open_it() {
    // Р5, Р6, Ф20, Ф25.
    let content = pattern(1000);
    let hash = blake3_hash(&content);
    let sealed = seal(&content);
    for (key, id) in [
        (SpaceKey::from_bytes([0x22; 32], 1), body_id()),
        (vk(), BodyId::from_bytes([0x34; 16])),
        (SpaceKey::from_bytes([0x21; 32], 2), body_id()),
    ] {
        let mut sink = Recorder {
            bytes: vec![],
            max_write: 0,
        };
        let got = open_body_stream(
            &key,
            &id,
            1000,
            &hash,
            &mut Cursor::new(sealed.clone()),
            &mut sink,
        );
        let expected = open_body(&key, &id, 1000, &hash, &sealed).unwrap_err();
        assert!(matches!(got, Err(StreamError::Crypto(e)) if e == expected));
    }
}

#[test]
fn no_byte_of_an_unauthenticated_chunk_is_ever_written() {
    // Р6, С5, Ф24: damage in the third chunk may leave the first two in the sink, never any of
    // the third.
    let content = pattern(3 * CHUNK + 10);
    let mut sealed = seal(&content);
    sealed[32 + 2 * (CHUNK + 16) + 5] ^= 1;
    let run = stream(content.len() as u64, &blake3_hash(&content), &sealed);
    assert!(run.result.is_err());
    assert!(
        run.written.len() <= 2 * CHUNK,
        "{} bytes were written",
        run.written.len()
    );
    assert_eq!(
        run.written,
        content[..run.written.len()],
        "what was written is the true prefix"
    );
}

struct CutReader {
    data: Vec<u8>,
    pos: usize,
    cut: usize,
}
impl Read for CutReader {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.pos >= self.cut {
            return Err(std::io::Error::new(
                std::io::ErrorKind::ConnectionReset,
                "cut",
            ));
        }
        let end = (self.pos + buf.len()).min(self.cut).min(self.data.len());
        let n = end - self.pos;
        buf[..n].copy_from_slice(&self.data[self.pos..end]);
        self.pos = end;
        Ok(n)
    }
}

#[test]
fn a_cut_connection_is_a_read_error_not_an_authentication_error() {
    // С1, С5, Д68: the two must not be confused.
    let content = pattern(300_000);
    let sealed = seal(&content);
    for cut in [0, 10, 31, 32, 1000, CHUNK + 16 + 32, sealed.len() - 1] {
        let mut sink = Recorder {
            bytes: vec![],
            max_write: 0,
        };
        let mut source = CutReader {
            data: sealed.clone(),
            pos: 0,
            cut,
        };
        let got = open_body_stream(
            &vk(),
            &body_id(),
            300_000,
            &blake3_hash(&content),
            &mut source,
            &mut sink,
        );
        assert!(
            matches!(got, Err(StreamError::Read(_))),
            "cut at {cut}: {got:?}"
        );
    }
}

#[test]
fn a_failing_sink_is_a_write_error() {
    // С4, Д68: a full disk while writing.
    struct Full;
    impl Write for Full {
        fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
            Err(std::io::Error::other("no space left on device"))
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let content = pattern(100_000);
    let got = open_body_stream(
        &vk(),
        &body_id(),
        100_000,
        &blake3_hash(&content),
        &mut Cursor::new(seal(&content)),
        &mut Full,
    );
    assert!(matches!(got, Err(StreamError::Write(_))), "{got:?}");
}

#[test]
fn damaged_padding_is_refused_like_open_body_does() {
    // Ф22: the padding after the content must be zeros. Built by hand: authentic chunks, but the
    // padding differs. The oracle is `open_body`, which refuses it with `PaddingNotZero`.
    use amby_sync_core::crypto::primitives::hkdf_sha256;
    use chacha20poly1305::aead::stream::EncryptorBE32;
    use chacha20poly1305::aead::Payload;
    use chacha20poly1305::{KeyInit, XChaCha20Poly1305};
    let content = pattern(1000);
    let padded_len = amby_sync_core::crypto::padme::padme(1000).unwrap() as usize;
    assert!(padded_len > 1000, "this size has padding");
    let mut padded = content.clone();
    padded.resize(padded_len, 0);
    *padded.last_mut().unwrap() = 1;
    let mut info = b"amby-sync/body/1".to_vec();
    info.extend_from_slice(body_id().as_bytes());
    let key = hkdf_sha256(&[], vk().as_bytes(), &info, 32).unwrap();
    let cipher = XChaCha20Poly1305::new(key.as_slice().into());
    let mut preamble = b"AMBYBODY".to_vec();
    preamble.push(1);
    preamble.extend_from_slice(&1u32.to_be_bytes());
    preamble.extend_from_slice(&[0x55; 19]);
    let encryptor = EncryptorBE32::from_aead(cipher, (&[0x55u8; 19]).into());
    let sealed_chunk = encryptor
        .encrypt_last(Payload {
            msg: &padded,
            aad: &preamble,
        })
        .unwrap();
    let mut sealed = preamble;
    sealed.extend_from_slice(&sealed_chunk);
    let hash = blake3_hash(&content);
    let whole = open_body(&vk(), &body_id(), 1000, &hash, &sealed);
    assert_eq!(
        whole,
        Err(CryptoError::PaddingNotZero),
        "the hand-made body is authentic"
    );
    assert_agree(1000, &hash, &sealed, "non-zero padding");
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(48))]

    #[test]
    fn the_stream_and_open_body_always_agree(
        content in proptest::collection::vec(any::<u8>(), 0..150_000),
        flip in proptest::option::of((any::<prop::sample::Index>(), 1u8..=255)),
        cut in proptest::option::of(any::<prop::sample::Index>()),
    ) {
        let hash = blake3_hash(&content);
        let mut sealed = seal(&content);
        if let Some((at, mask)) = flip {
            let i = at.index(sealed.len());
            sealed[i] ^= mask;
        }
        if let Some(at) = cut {
            let i = at.index(sealed.len() + 1);
            sealed.truncate(i);
        }
        assert_agree(content.len() as u64, &hash, &sealed, "random damage");
    }

    #[test]
    fn arbitrary_bytes_are_never_a_body(bytes in proptest::collection::vec(any::<u8>(), 0..2000), size in any::<u64>()) {
        let run = stream(size, &[0; 32], &bytes);
        prop_assert!(run.result.is_err());
    }
}
