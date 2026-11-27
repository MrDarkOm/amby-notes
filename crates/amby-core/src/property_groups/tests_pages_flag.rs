//! The app-owned `amby-pages` flag: written and removed losslessly, outside the property panel.

use super::testkit::*;
use super::*;

#[test]
fn writes_and_removes_the_pages_flag_without_touching_other_bytes() {
    let fx = fx();
    let note = id(1);
    fx.note(&note, "N.md", "tags: [a]  # mine\n");
    set_pages_flag(&fx.conn, &fx.vault, &note, Some(true)).unwrap();
    assert_eq!(
        fx.read("N.md"),
        format!("---\namby-id: {note}\ntags: [a]  # mine\namby-pages: true\n---\nТекст\n")
    );
    set_pages_flag(&fx.conn, &fx.vault, &note, Some(false)).unwrap();
    assert!(fx.read("N.md").contains("\namby-pages: false\n"));
    set_pages_flag(&fx.conn, &fx.vault, &note, None).unwrap();
    assert_eq!(
        fx.read("N.md"),
        format!("---\namby-id: {note}\ntags: [a]  # mine\n---\nТекст\n")
    );
    // Removing an absent flag leaves the file alone.
    set_pages_flag(&fx.conn, &fx.vault, &note, None).unwrap();
    assert_eq!(
        fx.read("N.md"),
        format!("---\namby-id: {note}\ntags: [a]  # mine\n---\nТекст\n")
    );
}

#[test]
fn refuses_a_note_with_a_malformed_header() {
    let fx = fx();
    let note = id(2);
    let text = format!("---\namby-id: {note}\ntitle: [unclosed\n---\nТекст\n");
    fx.note_raw(&note, "Bad.md", &text);
    assert!(set_pages_flag(&fx.conn, &fx.vault, &note, Some(true)).is_err());
    assert_eq!(fx.read("Bad.md"), text);
}
