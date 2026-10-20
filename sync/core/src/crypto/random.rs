//! The source of randomness (Р12: the core reaches randomness only through an interface).
//!
//! The order in which operations draw bytes is part of the format (Ф31, Ф32): tests feed a
//! scripted stream and check that all of it is spent.

/// A source of random bytes.
pub trait Random {
    /// Fills `dest` with random bytes. Must not fail; an unusable source panics.
    fn fill(&mut self, dest: &mut [u8]);
}

/// Operating-system randomness (`getrandom`), Р6.
#[derive(Debug, Default, Clone, Copy)]
pub struct OsRandom;

impl Random for OsRandom {
    /// Р6: random bytes from the operating system.
    fn fill(&mut self, dest: &mut [u8]) {
        // An unusable operating-system source cannot be worked around: keys made from anything
        // else would be guessable, so stopping is the safe answer.
        getrandom::fill(dest).expect("operating system randomness is unavailable");
    }
}
