//! A deleted body is not quota credit for an edited file that beats the deletion (Д32, П56-б).
#![allow(clippy::unwrap_used, clippy::expect_used)]

#[macro_use]
mod common;
use common::*;

use amby_sync_core::crypto::padme::sealed_body_len;
use serde_json::json;

fn an_edited_file_undeleting_a_deleted_base_has_no_replace_credit(_b: EngineBuilder) {
    let quota = sealed_body_len(4).unwrap() + sealed_body_len(100).unwrap() - 1;
    let plans = json!({
        "default_plan": "free",
        "plans": {
            "free": {},
            "narrow": { "max_total_bytes": quota }
        }
    })
    .to_string();
    let w = World::new(Engine::boxed, WorldOptions::new(2).plans(&plans));

    w.save(0, "A.md", "base");
    w.save(0, "Keep.md", "keep");
    w.pass(0);
    w.pass(1);

    let edited = vec![b'x'; 100];
    w.dev(0).fs.user_write("A.md", &edited);
    w.dev(1).fs.user_delete("A.md");
    w.pass(1);

    // The old body is now a tombstoned version, not live replace credit. Leave one byte less
    // than the new body needs after the still-live Keep.md is accounted for.
    w.set_plan("narrow");
    let report = w.pass(0);

    assert!(report.limits.quota_full);
    assert_eq!(w.remote_calls(0, RemoteKind::BlobStart), 0);
    assert_eq!(w.dev(0).fs.content("A.md"), Some(edited));
    assert_eq!(w.server_files().get("Keep.md"), Some(&b"keep".to_vec()));
    assert!(!w.server_files().contains_key("A.md"));
    let versions = w.versions_at("A.md");
    assert!(
        versions[0].header.deleted,
        "the server deletion remains current"
    );
}

real_only!(an_edited_file_undeleting_a_deleted_base_has_no_replace_credit);
