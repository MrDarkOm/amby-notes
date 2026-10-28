//! Error types of the cryptography module.

/// Why a cryptographic operation failed. Nothing is ever returned (or written to disk) together
/// with an error (Р6, С5).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CryptoError {
    /// Parameters outside the accepted limits (Ф8) or an invalid argument such as epoch 0 (Ф3).
    #[error("invalid parameters: {0}")]
    InvalidParams(&'static str),
    /// The authentication tag did not verify: wrong key or password, tampered or swapped data,
    /// a version or an identifier that does not belong to the data (С5, С6, С12).
    #[error("authentication failed")]
    Authentication,
    /// The envelope version byte is not `1` (Ф4, Р13).
    #[error("unsupported envelope version {0}")]
    UnsupportedVersion(u8),
    /// The header `format` is newer than this build understands (Ф19, Р13, С13).
    #[error("header format {0} is newer than supported")]
    UnsupportedFormat(u64),
    /// The bytes are not a valid envelope, body or header (truncated, bad magic, bad JSON, a
    /// repeated JSON key, epoch 0 in `header_envelope_epoch`, ...).
    #[error("malformed data: {0}")]
    Malformed(&'static str),
    /// The epoch stored with the data differs from the epoch of the key, zero included
    /// (Ф18, Ф25).
    #[error("key epoch does not match")]
    EpochMismatch,
    /// The `version` inside the header differs from the version it was opened for (Ф19, Р6).
    #[error("header version does not match")]
    VersionMismatch,
    /// The header padding is not a multiple of 256 bytes or contains non-zero bytes (Ф17).
    #[error("bad header padding")]
    BadPadding,
    /// The decrypted body is not `padme(size)` bytes long (Ф22).
    #[error("body length does not match the header size")]
    LengthMismatch,
    /// The padding after the content is not all zero (Ф22).
    #[error("body padding is not zero")]
    PaddingNotZero,
    /// BLAKE3 of the content differs from `content_hash` of the header (Ф22).
    #[error("content hash does not match")]
    HashMismatch,
    /// The header path is not in Unicode NFC (Ф19, Р9).
    #[error("path is not in NFC")]
    PathNotNfc,
    /// The header path breaks the syntax rules of Ф33: empty, leading or trailing `/`, empty
    /// segment, `.` or `..` segment, `\\`, control characters, longer than 4096 bytes.
    #[error("invalid path")]
    InvalidPath,
    /// A size above 2^62 (Ф26): no panic, no overflow.
    #[error("size is too large")]
    SizeTooLarge,
    /// An unknown header field uses the name of a known one (Ф16).
    #[error("reserved key among unknown header fields: {0}")]
    ReservedKey(String),
}

/// Why a recovery code string was rejected (Ф30, О3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum RecoveryCodeError {
    /// After removing separators the code is not 56 symbols long.
    #[error("recovery code has the wrong length")]
    BadLength,
    /// A symbol is outside the Crockford alphabet (including `U`).
    #[error("recovery code has an invalid symbol")]
    BadSymbol,
    /// The padding bits of the last data symbol are not zero.
    #[error("recovery code has non-zero padding bits")]
    BadPadding,
    /// The checksum does not match: a typo.
    #[error("recovery code checksum does not match")]
    BadChecksum,
}
