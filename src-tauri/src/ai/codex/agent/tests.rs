//! Prompt framing for agent mode. Written before the implementation and frozen.

use super::*;

fn message(role: &str, content: &str) -> AiMessage {
    AiMessage {
        role: role.into(),
        content: content.into(),
    }
}

fn position(haystack: &str, needle: &str) -> usize {
    haystack
        .find(needle)
        .unwrap_or_else(|| panic!("{needle:?} not found in {haystack:?}"))
}

#[test]
fn the_context_comes_first_then_the_turns_in_order() {
    let prompt = prompt_for(
        &[
            message("user", "first question"),
            message("assistant", "first answer"),
            message("user", "second question"),
        ],
        Some("NOTE CONTEXT"),
    );
    let order = [
        position(&prompt, "NOTE CONTEXT"),
        position(&prompt, "first question"),
        position(&prompt, "first answer"),
        position(&prompt, "second question"),
    ];
    assert!(order.windows(2).all(|pair| pair[0] < pair[1]), "{order:?}");
}

#[test]
fn every_message_appears_exactly_once_with_its_role() {
    let prompt = prompt_for(
        &[
            message("user", "ONE"),
            message("assistant", "TWO"),
            message("user", "THREE"),
        ],
        None,
    );
    for text in ["ONE", "TWO", "THREE"] {
        assert_eq!(prompt.matches(text).count(), 1, "{text}");
    }
    assert!(prompt.contains("User:") && prompt.contains("Assistant:"));
}

#[test]
fn a_missing_or_blank_context_is_left_out() {
    let none = prompt_for(&[message("user", "hi")], None);
    let blank = prompt_for(&[message("user", "hi")], Some("  \n "));
    assert_eq!(none, blank);
    assert!(!none.to_lowercase().contains("context:"));
}

#[test]
fn the_prompt_ends_by_asking_for_the_answer_to_the_last_user_message() {
    let prompt = prompt_for(&[message("user", "hi")], None);
    let tail = prompt.trim_end().lines().last().unwrap().to_lowercase();
    assert!(tail.contains("answer") && tail.contains("last"), "{tail:?}");
}

#[test]
fn a_single_message_is_not_wrapped_in_a_transcript() {
    let prompt = prompt_for(&[message("user", "just this")], None);
    assert!(prompt.contains("just this"));
    assert!(!prompt.contains("Assistant:"));
}

#[test]
fn the_context_is_labelled_as_data_not_instructions() {
    let prompt = prompt_for(&[message("user", "hi")], Some("NOTE CONTEXT"));
    let label_end = position(&prompt, "NOTE CONTEXT");
    let label = prompt[..label_end].to_lowercase();
    assert!(label.contains("context"), "{label:?}");
    assert!(
        label.contains("data") && label.contains("not instructions"),
        "{label:?}"
    );
}
