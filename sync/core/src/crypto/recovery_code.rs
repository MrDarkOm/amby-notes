//! The recovery code: 256 random bits as printable Crockford base32 with a checksum
//! (Р5, О3, Ф27–Ф30).

use core::fmt;

use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

use super::error::RecoveryCodeError;
use super::primitives::sha256;
use super::random::Random;

/// Crockford base32: no `I`, `L`, `O`, `U` (Ф27).
const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/// Prefix of the checksum input (Ф29).
const CHECK_PREFIX: &[u8] = b"amby-sync/recovery-check/1";
/// Symbols that carry the 256 bits: 51 full groups and one with a single data bit (Ф28).
const DATA_SYMBOLS: usize = 52;
/// Symbols of the checksum (Ф29).
const CHECK_SYMBOLS: usize = 4;
/// All symbols of a printed code.
const TOTAL_SYMBOLS: usize = DATA_SYMBOLS + CHECK_SYMBOLS;

/// The 52 data symbols (values 0–31) of a code, bits read left to right (Ф28).
fn data_symbols(bytes: &[u8; 32]) -> [u8; DATA_SYMBOLS] {
    let mut symbols = [0u8; DATA_SYMBOLS];
    for (index, symbol) in symbols.iter_mut().enumerate() {
        let bit = index * 5;
        let byte = bit / 8;
        let next = bytes.get(byte + 1).copied().unwrap_or(0);
        let window = (u16::from(bytes[byte]) << 8) | u16::from(next);
        *symbol = ((window >> (11 - bit % 8)) & 31) as u8;
    }
    symbols
}

/// The four checksum symbols: the first 20 bits of the hash, five bits each (Ф29).
fn check_symbols(bytes: &[u8; 32]) -> [u8; CHECK_SYMBOLS] {
    let mut input = Zeroizing::new(Vec::with_capacity(CHECK_PREFIX.len() + 32));
    input.extend_from_slice(CHECK_PREFIX);
    input.extend_from_slice(bytes);
    let hash = sha256(&input);
    let value = (u32::from(hash[0]) << 12) | (u32::from(hash[1]) << 4) | (u32::from(hash[2]) >> 4);
    [
        ((value >> 15) & 31) as u8,
        ((value >> 10) & 31) as u8,
        ((value >> 5) & 31) as u8,
        (value & 31) as u8,
    ]
}

/// The value of one typed symbol after the Crockford corrections (Ф30), if it is one.
fn symbol_value(symbol: char) -> Option<u8> {
    let upper = symbol.to_ascii_uppercase();
    let canonical = match upper {
        'O' => '0',
        'I' | 'L' => '1',
        other => other,
    };
    let byte = u8::try_from(canonical).ok()?;
    ALPHABET
        .iter()
        .position(|&candidate| candidate == byte)
        .map(|position| position as u8)
}

/// The recovery code (Р5). Shown to the user once, in the form `XXXX-XXXX-…` (14 groups).
#[derive(Clone, PartialEq, Eq, Zeroize, ZeroizeOnDrop)]
pub struct RecoveryCode([u8; 32]);

impl RecoveryCode {
    /// Wraps 32 code bytes.
    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    /// The code bytes. Handle with care: copies are not wiped.
    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    /// A new code: 32 bytes drawn from `rng` (Р5, Ф27, Ф31).
    pub fn generate(rng: &mut dyn Random) -> Self {
        let mut bytes = [0u8; 32];
        rng.fill(&mut bytes);
        Self(bytes)
    }

    /// The printable form: 56 uppercase symbols in 14 groups of 4 joined by `-`, with a
    /// 20-bit checksum in the last group (О3, Ф28–Ф30).
    pub fn to_display(&self) -> String {
        let data = Zeroizing::new(data_symbols(&self.0));
        let check = check_symbols(&self.0);
        let mut text = String::with_capacity(TOTAL_SYMBOLS + TOTAL_SYMBOLS / 4 - 1);
        for (index, value) in data.iter().chain(check.iter()).enumerate() {
            if index > 0 && index % 4 == 0 {
                text.push('-');
            }
            text.push(char::from(ALPHABET[usize::from(*value)]));
        }
        text
    }

    /// Reads a code typed or pasted by the user: separators and case are ignored, `O → 0`,
    /// `I` and `L → 1`; any other symbol outside the alphabet, a wrong length, non-zero padding
    /// bits or a wrong checksum is an error (О3, Ф30).
    pub fn parse(text: &str) -> Result<Self, RecoveryCodeError> {
        // Order of Ф30: symbols, length, padding bits, checksum. Only the first 57 values are
        // kept: a longer text is a length error anyway.
        let mut values = Zeroizing::new(Vec::with_capacity(TOTAL_SYMBOLS + 1));
        let mut count = 0usize;
        for symbol in text.chars() {
            if symbol == '-' || symbol.is_whitespace() {
                continue;
            }
            let value = symbol_value(symbol).ok_or(RecoveryCodeError::BadSymbol)?;
            if values.len() <= TOTAL_SYMBOLS {
                values.push(value);
            }
            count += 1;
        }
        if count != TOTAL_SYMBOLS {
            return Err(RecoveryCodeError::BadLength);
        }
        // The last data symbol holds one data bit and four zero bits.
        if values[DATA_SYMBOLS - 1] & 0x0F != 0 {
            return Err(RecoveryCodeError::BadPadding);
        }
        let mut bytes = [0u8; 32];
        let mut accumulator = 0u32;
        let mut bits = 0u32;
        let mut written = 0usize;
        for value in &values[..DATA_SYMBOLS] {
            accumulator = (accumulator << 5) | u32::from(*value);
            bits += 5;
            while bits >= 8 && written < bytes.len() {
                bits -= 8;
                bytes[written] = (accumulator >> bits) as u8;
                written += 1;
            }
            accumulator &= (1 << bits) - 1;
        }
        let code = Self(bytes);
        bytes.zeroize();
        if values[DATA_SYMBOLS..] != check_symbols(&code.0) {
            return Err(RecoveryCodeError::BadChecksum);
        }
        Ok(code)
    }
}

impl fmt::Debug for RecoveryCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "RecoveryCode([redacted])")
    }
}
