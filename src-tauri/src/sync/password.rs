//! The rule for the password (Р5): at least 12 characters and a sufficient `zxcvbn` score. The
//! interface shows the verdict while the person types; `prepare_account` and `recover` apply the
//! same rule again, so a weak password never reaches Argon2id.

use zeroize::Zeroizing;
use zxcvbn::feedback::{Suggestion, Warning};

use crate::sync::types::PasswordCheck;

/// The least length of a password, in characters (Р5).
pub const MIN_PASSWORD_LENGTH: usize = 12;
/// The least `zxcvbn` score that is accepted (0–4).
pub const MIN_PASSWORD_SCORE: u8 = 3;
/// How much of a password `zxcvbn` reads: it is slow on long texts, and 100 characters of a
/// random text are far beyond the score that is asked for.
const SCORED_CHARACTERS: usize = 100;

/// The name of a warning for the interface. Explicit, so a change of the library cannot rename
/// what the interface translates.
fn warning_name(warning: Warning) -> &'static str {
    match warning {
        Warning::StraightRowsOfKeysAreEasyToGuess => "straight_rows_of_keys",
        Warning::ShortKeyboardPatternsAreEasyToGuess => "short_keyboard_pattern",
        Warning::RepeatsLikeAaaAreEasyToGuess => "repeats_like_aaa",
        Warning::RepeatsLikeAbcAbcAreOnlySlightlyHarderToGuess => "repeats_like_abcabc",
        Warning::ThisIsATop10Password => "top_ten_password",
        Warning::ThisIsATop100Password => "top_hundred_password",
        Warning::ThisIsACommonPassword => "common_password",
        Warning::ThisIsSimilarToACommonlyUsedPassword => "similar_to_common_password",
        Warning::SequencesLikeAbcAreEasyToGuess => "sequence",
        Warning::RecentYearsAreEasyToGuess => "recent_year",
        Warning::AWordByItselfIsEasyToGuess => "single_word",
        Warning::DatesAreOftenEasyToGuess => "date",
        Warning::NamesAndSurnamesByThemselvesAreEasyToGuess => "name_by_itself",
        Warning::CommonNamesAndSurnamesAreEasyToGuess => "common_name",
    }
}

/// The name of a piece of advice for the interface.
fn suggestion_name(suggestion: Suggestion) -> &'static str {
    match suggestion {
        Suggestion::UseAFewWordsAvoidCommonPhrases => "use_a_few_words",
        Suggestion::NoNeedForSymbolsDigitsOrUppercaseLetters => "no_need_for_symbols",
        Suggestion::AddAnotherWordOrTwo => "add_another_word",
        Suggestion::CapitalizationDoesntHelpVeryMuch => "capitalization_does_not_help",
        Suggestion::AllUppercaseIsAlmostAsEasyToGuessAsAllLowercase => "all_uppercase",
        Suggestion::ReversedWordsArentMuchHarderToGuess => "reversed_words",
        Suggestion::PredictableSubstitutionsDontHelpVeryMuch => "predictable_substitutions",
        Suggestion::UseALongerKeyboardPatternWithMoreTurns => "longer_keyboard_pattern",
        Suggestion::AvoidRepeatedWordsAndCharacters => "avoid_repeats",
        Suggestion::AvoidSequences => "avoid_sequences",
        Suggestion::AvoidRecentYears => "avoid_recent_years",
        Suggestion::AvoidYearsThatAreAssociatedWithYou => "avoid_your_years",
        Suggestion::AvoidDatesAndYearsThatAreAssociatedWithYou => "avoid_your_dates",
    }
}

/// Judges `password`. `user_inputs` are words the password must not be built from (the user
/// name, the host). Only the first 100 characters are scored, as `zxcvbn` advises, so a very
/// long text cannot hang the interface. Does not log anything.
pub fn check_password(password: &str, user_inputs: &[&str]) -> PasswordCheck {
    let length = password.chars().count();
    let scored: Zeroizing<String> =
        Zeroizing::new(password.chars().take(SCORED_CHARACTERS).collect());
    let entropy = zxcvbn::zxcvbn(&scored, user_inputs);
    let score = u8::from(entropy.score());
    let too_short = length < MIN_PASSWORD_LENGTH;
    let feedback = entropy.feedback();
    PasswordCheck {
        ok: !too_short && score >= MIN_PASSWORD_SCORE,
        score,
        length: u32::try_from(length).unwrap_or(u32::MAX),
        min_length: MIN_PASSWORD_LENGTH as u32,
        too_short,
        warning: feedback
            .and_then(|feedback| feedback.warning())
            .map(|warning| warning_name(warning).to_string()),
        suggestions: feedback
            .map(|feedback| {
                feedback
                    .suggestions()
                    .iter()
                    .map(|suggestion| suggestion_name(*suggestion).to_string())
                    .collect()
            })
            .unwrap_or_default(),
    }
}
