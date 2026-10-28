//! The administrator commands as the suite sees them: `user add` (П38, П17, П11).
#![allow(clippy::unwrap_used, clippy::expect_used)]

use amby_sync_conformance::client::{enroll, enroll_with, info, PASSWORD};
use amby_sync_conformance::Target;
use amby_sync_core::crypto::account::{create_account, Argon2Params};
use amby_sync_core::crypto::random::OsRandom;

#[test]
fn user_add_gives_a_one_time_code_for_24_hours() {
    // П38, П17, Р5: a code in Crockford base32, 20 symbols in groups of 4, valid for 24 hours.
    let target = Target::from_env();
    let now = info(&target.api)["time_ms"].as_i64().unwrap();
    let ticket = target.new_ticket();
    assert_eq!(
        ticket.username.len(),
        13,
        "the name is the one that was asked for"
    );
    let groups: Vec<&str> = ticket.enroll_code.split('-').collect();
    assert_eq!(
        groups.len(),
        5,
        "XXXX-XXXX-XXXX-XXXX-XXXX: {}",
        ticket.enroll_code
    );
    for group in groups {
        assert_eq!(group.len(), 4);
        assert!(
            group
                .chars()
                .all(|c| "0123456789ABCDEFGHJKMNPQRSTVWXYZ".contains(c)),
            "the code uses the Crockford alphabet: {}",
            ticket.enroll_code
        );
    }
    let day_ms = 24 * 60 * 60 * 1000;
    let lifetime = ticket.expires_ms - now;
    assert!(
        (day_ms - 120_000..=day_ms + 120_000).contains(&lifetime),
        "the code lives 24 hours, got {lifetime} ms"
    );
}

#[test]
fn two_codes_are_different() {
    // П17: 100 random bits; a repeated code would be a broken generator.
    let target = Target::from_env();
    let first = target.new_ticket();
    let second = target.new_ticket();
    assert_ne!(first.enroll_code, second.enroll_code);
}

#[test]
fn user_add_rejects_bad_names_with_exit_code_2() {
    // П11, П38: ASCII lower case, digits, dot, underscore, dash; 1–64 characters; letter or
    // digit at both ends.
    let target = Target::from_env();
    let too_long = "a".repeat(65);
    for name in [
        "Alice",
        "",
        "a b",
        too_long.as_str(),
        "-a",
        "a-",
        "é",
        ".a",
        "a/b",
    ] {
        match target.try_user_add(name) {
            Err(failure) => assert_eq!(
                failure.exit_code,
                Some(2),
                "`{name}` must be refused with exit code 2: {}",
                failure.message
            ),
            Ok(_) => panic!("the name `{name}` must be refused"),
        }
    }
}

#[test]
fn user_add_accepts_the_edge_names() {
    // П11: the shortest and the longest legal names.
    let target = Target::from_env();
    let mut tail = [0u8; 4];
    amby_sync_core::crypto::random::Random::fill(&mut OsRandom, &mut tail);
    let longest = format!("{}{}", "a".repeat(56), hex::encode(tail));
    assert_eq!(longest.len(), 64);
    let dotted = format!("a.b_c-{}", hex::encode(tail));
    for name in [longest, dotted] {
        target
            .try_user_add(&name)
            .unwrap_or_else(|failure| panic!("`{name}` must be accepted: {}", failure.message));
    }
}

#[test]
fn a_second_user_add_burns_the_first_code() {
    // П17, П38: for a name without a password a new code replaces the old one.
    let target = Target::from_env();
    let first = target.new_ticket();
    let second = target
        .try_user_add(&first.username)
        .expect("a new code for a waiting user");
    assert_ne!(first.enroll_code, second.enroll_code);
    let new = create_account(PASSWORD, &Argon2Params::V1_DEFAULT, &mut OsRandom).unwrap();
    let body = amby_sync_conformance::client::enroll_body(
        &first.username,
        &first.enroll_code,
        &new,
        "device",
    );
    target
        .api
        .post("/v1/auth/enroll", None, body)
        .expect_error(401, "invalid_enroll_code");
    enroll_with(&target, &second.username, &second.enroll_code, PASSWORD);
}

#[test]
fn user_add_for_a_user_with_a_password_fails_with_exit_code_3() {
    // П17, П38: the account exists; its owner has a password.
    let target = Target::from_env();
    let account = enroll(&target, PASSWORD);
    match target.try_user_add(&account.username) {
        Err(failure) => assert_eq!(failure.exit_code, Some(3), "{}", failure.message),
        Ok(_) => panic!("a user with a password must not get a new code"),
    }
}

#[test]
fn a_removed_user_loses_the_tokens_and_the_name_can_be_made_again() {
    // П38, П6, Р5: old tokens are `unauthorized` (they no longer exist), sign-in looks like an
    // unknown name, and `user add` for the same name makes a new, empty user.
    let target = Target::from_env();
    let account = enroll(&target, PASSWORD);
    let space = account.create_space();
    space.commit_ok(&[space.folder(&amby_sync_conformance::client::new_item(), 0, "Docs")]);
    target
        .admin
        .user_remove(&account.username)
        .unwrap_or_else(|failure| panic!("user remove failed: {}", failure.message));
    account.get("/v1/keys").expect_error(401, "unauthorized");
    account.get("/v1/spaces").expect_error(401, "unauthorized");
    amby_sync_conformance::client::login(
        &target.api,
        &account.username,
        PASSWORD,
        &account.ak,
        "x",
    )
    .expect_error(401, "invalid_credentials");

    let ticket = target
        .try_user_add(&account.username)
        .expect("the name can be made again");
    let again = enroll_with(&target, &ticket.username, &ticket.enroll_code, PASSWORD);
    assert!(again.get("/v1/spaces").expect(200).json()["spaces"]
        .as_array()
        .unwrap()
        .is_empty());
    assert_ne!(again.token, account.token);
    account.get("/v1/keys").expect_error(401, "unauthorized");
}

// ----- the commands of appendix Е (П52, П53), in-process servers with a plans file -----

mod plans_and_spaces {
    use std::sync::Arc;

    use amby_sync_conformance::client::{hex16, new_body, new_item, Account};
    use amby_sync_conformance::{in_process_or_skip, Target};
    use amby_sync_server::AppState;
    use serde_json::{json, Value};

    use super::{enroll, PASSWORD};

    fn plans_text() -> String {
        json!({
            "default_plan": "small",
            "plans": {
                "small": {"title": "Small", "max_spaces": 2, "max_total_bytes": 10_000,
                          "max_file_bytes": 4_000, "history_days": 10, "max_history_bytes": 20_000},
                "big": {"title": "Big", "max_spaces": 5, "max_total_bytes": 100_000},
                "free": {"title": "Free"}
            }
        })
        .to_string()
    }

    fn server() -> Target {
        Target::in_process_with_plans(&plans_text(), |_| {})
    }

    fn show(target: &Target, name: &str) -> Value {
        target
            .cli_ok(&["user", "plan", "show", name, "--json"])
            .json()
    }

    #[test]
    fn user_add_with_a_plan_pins_it_and_without_one_leaves_the_user_on_the_default() {
        // П52, П53.
        let target = server();
        let _ = in_process_or_skip!(target);
        let (pinned, plain) = (target.new_username(), target.new_username());
        target.cli_ok(&["user", "add", &pinned, "--plan", "big"]);
        target.cli_ok(&["user", "add", &plain]);
        assert_eq!(
            show(&target, &pinned)["plan"],
            json!({"name": "big", "title": "Big", "pinned": true})
        );
        assert_eq!(
            show(&target, &plain)["plan"],
            json!({"name": "small", "title": "Small", "pinned": false})
        );
    }

    #[test]
    fn user_add_with_an_unknown_plan_is_exit_2_and_creates_nobody() {
        // П53: 2 is "an unknown plan or a bad name".
        let target = server();
        let _ = in_process_or_skip!(target);
        let name = target.new_username();
        let output = target.cli(&["user", "add", &name, "--plan", "gold"]);
        assert_eq!(output.code, 2, "{}", output.stderr);
        let list = target.cli_ok(&["user", "list", "--json"]).json();
        assert!(list
            .as_array()
            .unwrap()
            .iter()
            .all(|user| user["username"] != name.as_str()));
    }

    #[test]
    fn plan_set_pins_default_unpins_and_show_tells_the_limits_and_the_usage() {
        // П53: `user plan set <name> <plan>`, `--default`, `show --json`.
        let target = server();
        let _ = in_process_or_skip!(target);
        let account = enroll(&target, PASSWORD);
        let name = account.username.clone();
        let space = account.create_space();
        space.commit_ok(&[space.raw_file(&new_item(), 0, "a.md", 1_500)]);
        target.cli_ok(&["user", "plan", "set", &name, "big"]);
        let shown = show(&target, &name);
        assert_eq!(shown["username"], name.as_str());
        assert_eq!(
            shown["plan"],
            json!({"name": "big", "title": "Big", "pinned": true})
        );
        assert_eq!(shown["limits"]["max_spaces"], 5);
        assert_eq!(shown["limits"]["max_total_bytes"], 100_000);
        assert_eq!(shown["limits"]["max_file_bytes"], Value::Null);
        assert_eq!(shown["usage"]["live_bytes"], 1_500);
        assert_eq!(shown["usage"]["spaces"], 1);
        target.cli_ok(&["user", "plan", "set", &name, "--default"]);
        let back = show(&target, &name);
        assert_eq!(
            back["plan"],
            json!({"name": "small", "title": "Small", "pinned": false})
        );
    }

    #[test]
    fn plan_set_refuses_an_unknown_plan_a_bad_name_and_an_unknown_user() {
        // П52, П53: exit 2 for the plan and the name, 1 for no such user; nothing changes.
        let target = server();
        let _ = in_process_or_skip!(target);
        let account = enroll(&target, PASSWORD);
        let name = account.username.clone();
        assert_eq!(target.cli(&["user", "plan", "set", &name, "gold"]).code, 2);
        assert_eq!(
            target.cli(&["user", "plan", "set", &name, "Big Plan"]).code,
            2
        );
        assert_eq!(
            target.cli(&["user", "plan", "set", "Bad Name", "big"]).code,
            2
        );
        assert_eq!(
            target
                .cli(&["user", "plan", "set", "nobody-here", "big"])
                .code,
            1
        );
        assert_eq!(show(&target, &name)["plan"]["pinned"], false);
    }

    #[test]
    fn without_a_plans_file_no_plan_can_be_set() {
        // П52: no file, no plans: every name is unknown.
        let target = Target::in_process();
        let _ = in_process_or_skip!(target);
        let account = enroll(&target, PASSWORD);
        assert_eq!(
            target
                .cli(&["user", "plan", "set", &account.username, "standard"])
                .code,
            2
        );
        let shown = target
            .cli_ok(&["user", "plan", "show", &account.username, "--json"])
            .json();
        assert_eq!(shown["plan"]["name"], Value::Null);
    }

    #[test]
    fn a_change_of_plan_is_written_to_the_log_without_secrets() {
        // П53: user, the previous plan and the new one; nothing secret on either stream.
        let target = server();
        let _ = in_process_or_skip!(target);
        let account = enroll(&target, PASSWORD);
        target.cli_ok(&["user", "plan", "set", &account.username, "big"]);
        let output = target.cli_ok(&["user", "plan", "set", &account.username, "free"]);
        let log = format!("{}{}", output.stderr, output.stdout);
        for word in [account.username.as_str(), "big", "free"] {
            assert!(log.contains(word), "the log line must name `{word}`: {log}");
        }
        for secret in [&account.token, &hex::encode(account.ak.as_bytes())] {
            assert!(!log.contains(secret.as_str()), "no secret in the log");
        }
    }

    #[test]
    fn plans_list_counts_the_users_of_every_plan_including_the_default() {
        // П53: how many users are on each plan (pinned or by default).
        let target = server();
        let _ = in_process_or_skip!(target);
        let accounts: Vec<Account> = (0..3).map(|_| enroll(&target, PASSWORD)).collect();
        target.cli_ok(&["user", "plan", "set", &accounts[0].username, "big"]);
        target.cli_ok(&["user", "plan", "set", &accounts[1].username, "big"]);
        let listed = target.cli_ok(&["plans", "list", "--json"]).json();
        assert_eq!(listed["default_plan"], "small");
        let plans = listed["plans"].as_array().unwrap();
        let find = |name: &str| {
            plans
                .iter()
                .find(|plan| plan["name"] == name)
                .unwrap()
                .clone()
        };
        assert_eq!(find("big")["users"], 2);
        assert_eq!(find("big")["pinned_users"], 2);
        assert_eq!(
            find("small")["users"],
            1,
            "the unpinned user is on the default plan"
        );
        assert_eq!(find("small")["pinned_users"], 0);
        assert_eq!(find("free")["users"], 0);
        assert_eq!(find("small")["max_file_bytes"], 4_000);
        assert_eq!(find("small")["title"], "Small");
        let text = target.cli_ok(&["plans", "list"]).stdout;
        assert!(text.contains("small") && text.contains("big") && text.contains("free"));
    }

    #[test]
    fn plans_check_accepts_a_good_file_and_refuses_a_bad_one_with_a_reason() {
        // П51, П53.
        let target = server();
        let control = in_process_or_skip!(target);
        let dir = tempfile::tempdir().unwrap();
        let good = dir.path().join("good.json");
        let bad = dir.path().join("bad.json");
        std::fs::write(&good, plans_text()).unwrap();
        std::fs::write(&bad, r#"{"plans": {"a": {"max_file_byte": 5}}}"#).unwrap();
        let _ = control;
        target.cli_ok(&["plans", "check"]);
        target.cli_ok(&["plans", "check", good.to_str().unwrap()]);
        let refused = target.cli(&["plans", "check", bad.to_str().unwrap()]);
        assert_ne!(refused.code, 0);
        assert!(
            refused.stderr.contains("max_file_byte"),
            "the reason names the field: {}",
            refused.stderr
        );
        let missing = target.cli(&[
            "plans",
            "check",
            dir.path().join("none.json").to_str().unwrap(),
        ]);
        assert_ne!(missing.code, 0, "a file named on purpose must exist");
    }

    #[test]
    fn plans_check_names_the_pinned_users_whose_plan_the_checked_file_lacks() {
        // П52: a file can be valid and still be a mistake for this server.
        let target = server();
        let _ = in_process_or_skip!(target);
        let account = enroll(&target, PASSWORD);
        target.cli_ok(&["user", "plan", "set", &account.username, "big"]);
        let dir = tempfile::tempdir().unwrap();
        let without_big = dir.path().join("without-big.json");
        std::fs::write(
            &without_big,
            json!({"default_plan": "small", "plans": {"small": {}}}).to_string(),
        )
        .unwrap();
        let refused = target.cli(&["plans", "check", without_big.to_str().unwrap()]);
        assert_ne!(refused.code, 0);
        assert!(
            refused.stderr.contains(&account.username) && refused.stderr.contains("big"),
            "{}",
            refused.stderr
        );
        target.cli_ok(&["plans", "check"]); // the file in force still has `big`
    }

    #[test]
    fn the_start_refused_for_a_lost_plan_is_cured_by_returning_the_default() {
        // П52: after the edit the server would not start; `plans check` says who, and `user
        // plan set <name> --default` cures it without the file.
        let target = server();
        let control = in_process_or_skip!(target);
        let account = enroll(&target, PASSWORD);
        target.cli_ok(&["user", "plan", "set", &account.username, "big"]);
        control.write_plans(&json!({"default_plan": "small", "plans": {"small": {}}}).to_string());
        control.restart();
        let refused = target.cli(&["plans", "check"]);
        assert_ne!(refused.code, 0);
        assert!(
            refused.stderr.contains(&account.username),
            "{}",
            refused.stderr
        );
        target.cli_ok(&["user", "plan", "set", &account.username, "--default"]);
        target.cli_ok(&["plans", "check"]);
        let state = AppState::open(
            control.config(),
            control.clock.clone() as Arc<dyn amby_sync_server::Clock>,
        );
        state.check_plans().expect("the start is allowed again");
    }

    #[test]
    fn user_list_shows_the_plan_and_the_usage() {
        // П53, П7: new fields in `--json`, old ones stay.
        let target = server();
        let _ = in_process_or_skip!(target);
        let account = enroll(&target, PASSWORD);
        let space = account.create_space();
        space.commit_ok(&[space.raw_file(&new_item(), 0, "a.md", 2_000)]);
        space.init_blob(&new_body(), 500).expect(201);
        target.cli_ok(&["user", "plan", "set", &account.username, "big"]);
        let list = target.cli_ok(&["user", "list", "--json"]).json();
        let mine = list
            .as_array()
            .unwrap()
            .iter()
            .find(|user| user["username"] == account.username.as_str())
            .unwrap();
        assert_eq!(mine["plan"], "big");
        assert_eq!(mine["pinned"], true);
        assert_eq!(
            mine["used_bytes"], 2_500,
            "live + pending, the number the quota uses"
        );
        assert_eq!(mine["has_password"], true);
        let text = target.cli_ok(&["user", "list"]).stdout;
        assert!(text.contains(&account.username) && text.contains("big"));
    }

    // ----- spaces (П53) -----

    fn hex_space(space: &amby_sync_conformance::client::Space) -> String {
        hex16(space.id.as_bytes())
    }

    #[test]
    fn space_list_shows_ids_sizes_and_never_the_name() {
        // П53: `space_id`, creation date, `live_bytes`, `history_bytes`; names stay encrypted.
        let target = server();
        let _ = in_process_or_skip!(target);
        let account = enroll(&target, PASSWORD);
        let space = account.create_space_named("Secret Name");
        let item = new_item();
        space.commit_ok(&[space.raw_file(&item, 0, "a.md", 1_000)]);
        space.commit_ok(&[space.raw_file(&item, 1, "a.md", 600)]);
        let output = target.cli_ok(&["space", "list", &account.username, "--json"]);
        let listed = output.json();
        let rows = listed.as_array().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["space_id"], hex_space(&space).as_str());
        assert_eq!(rows[0]["live_bytes"], 600);
        assert_eq!(rows[0]["history_bytes"], 1_000);
        assert!(rows[0]["created_ms"].as_i64().unwrap() > 0);
        assert!(!output.stdout.contains("Secret Name"));
        let plain = target.cli_ok(&["space", "list", &account.username]).stdout;
        assert!(plain.contains(&hex_space(&space)) && !plain.contains("Secret Name"));
        assert_eq!(target.cli(&["space", "list", "nobody-here"]).code, 1);
    }

    #[test]
    fn space_remove_without_yes_is_refused_and_removes_nothing() {
        // П53: irreversible, so `--yes` is required (exit 2, as `user remove`).
        let target = server();
        let _ = in_process_or_skip!(target);
        let account = enroll(&target, PASSWORD);
        let space = account.create_space();
        let output = target.cli(&["space", "remove", &account.username, &hex_space(&space)]);
        assert_eq!(output.code, 2, "{}", output.stderr);
        assert_eq!(
            account.get("/v1/spaces").expect(200).json()["spaces"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn space_remove_deletes_the_space_its_versions_and_bodies_and_nobody_elses() {
        // П53, Е.9: gone from the listing, from `versions`, `blobs` and the disk; another space of
        // the same user and the space of another user are untouched; the tokens still work.
        let target = server();
        let control = in_process_or_skip!(target);
        let account = enroll(&target, PASSWORD);
        let (doomed, kept) = (account.create_space_named("Doomed"), account.create_space());
        let (stranger_account, stranger) = {
            let a = enroll(&target, PASSWORD);
            let s = a.create_space();
            (a, s)
        };
        let item = new_item();
        let first = doomed.raw_file(&item, 0, "a.md", 1_000);
        let first_body = first.body.unwrap();
        doomed.commit_ok(&[first]);
        doomed.commit_ok(&[doomed.raw_file(&item, 1, "a.md", 700)]);
        doomed.init_blob(&new_body(), 300).expect(201);
        kept.commit_ok(&[kept.raw_file(&new_item(), 0, "k.md", 400)]);
        stranger.commit_ok(&[stranger.raw_file(&new_item(), 0, "s.md", 500)]);
        let kept_body = kept.all_changes(0).len();
        let listed = account.get("/v1/spaces").expect(200).json();
        let name_enc = listed["spaces"][0]["name_enc"]
            .as_str()
            .unwrap()
            .to_string();
        let wrapped = listed["spaces"][0]["wrapped_vk"]
            .as_str()
            .unwrap()
            .to_string();
        let rows = |table: &str| -> i64 {
            control.sql(|conn| {
                conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
                    .unwrap()
            })
        };
        let (blobs_before, versions_before) = (rows("blobs"), rows("versions"));
        assert_eq!((blobs_before, versions_before), (5, 4));

        let output = target.cli_ok(&[
            "space",
            "remove",
            &account.username,
            &hex_space(&doomed),
            "--yes",
        ]);
        let log = format!("{}{}", output.stdout, output.stderr);
        assert!(
            log.contains(&hex_space(&doomed)),
            "the log names the space: {log}"
        );
        for secret in [name_enc.as_str(), wrapped.as_str(), account.token.as_str()] {
            assert!(!log.contains(secret), "no secret in the log");
        }
        let after = account.get("/v1/spaces").expect(200).json();
        assert_eq!(after["spaces"].as_array().unwrap().len(), 1);
        assert_eq!(after["spaces"][0]["space_id"], hex_space(&kept).as_str());
        doomed.changes(0, None).expect_error(404, "not_found");
        doomed.download(&first_body).expect_error(404, "not_found");
        assert_eq!(rows("blobs"), blobs_before - 3);
        assert_eq!(rows("versions"), versions_before - 2);
        let doomed_dir = control.data_dir().join("blobs").join(hex_space(&doomed));
        assert!(!doomed_dir.exists(), "the body files of the space are gone");
        assert_eq!(kept.all_changes(0).len(), kept_body);
        assert_eq!(stranger.all_changes(0).len(), 1);
        assert_eq!(stranger_account.overview()["usage"]["live_bytes"], 500);
        assert_eq!(account.overview()["usage"]["live_bytes"], 400);
    }

    #[test]
    fn space_remove_for_an_unknown_space_or_the_space_of_another_user_is_exit_1() {
        // П53, П6.
        let target = server();
        let _ = in_process_or_skip!(target);
        let (me, other) = (enroll(&target, PASSWORD), enroll(&target, PASSWORD));
        let theirs = other.create_space();
        let output = target.cli(&[
            "space",
            "remove",
            &me.username,
            &hex_space(&theirs),
            "--yes",
        ]);
        assert_eq!(output.code, 1, "{}", output.stderr);
        let missing = target.cli(&["space", "remove", &me.username, &"ab".repeat(16), "--yes"]);
        assert_eq!(missing.code, 1);
        assert_eq!(
            other.get("/v1/spaces").expect(200).json()["spaces"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn removing_a_space_frees_a_slot_of_the_plan() {
        // П53, Е.10-3: the way out of `space_limit` before the app has a delete button (Э5).
        let target = server();
        let _ = in_process_or_skip!(target);
        let account = enroll(&target, PASSWORD);
        let (first, _second) = (account.create_space(), account.create_space());
        account
            .post("/v1/spaces", account.new_space_request("Third").2)
            .expect_error(403, "space_limit");
        target.cli_ok(&[
            "space",
            "remove",
            &account.username,
            &hex_space(&first),
            "--yes",
        ]);
        account.create_space();
    }
}
