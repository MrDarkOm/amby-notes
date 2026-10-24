//! "The storages of the account" (docs/sync-plan.md, appendix Е, У1–У5): the overview the
//! settings screen shows. Against the real server in the process with a plans file, and against
//! a tiny server that does not know `GET /v1/account` (an older one, Р13).

use std::io::{Read, Write};
use std::net::TcpListener;

use amby_sync_client::{DeviceToken, ServerUrl, SyncClient};
use amby_sync_conformance::client::{enroll, hex16, new_item, random16, seal_space_name, Account};
use amby_sync_conformance::Target;
use amby_sync_core::crypto::keys::AccountKey;
use serde_json::json;

use super::account_types::BoundVault;
use super::space::account_overview;

const PLANS: &str = r#"{
  "default_plan": "small",
  "plans": {
    "small": {"title": "Small", "max_spaces": 2, "max_total_bytes": 10000,
              "max_file_bytes": 4000, "history_days": 10, "max_history_bytes": 8000},
    "free": {"title": "Free"}
  }
}"#;

struct Fixture {
    runtime: tokio::runtime::Runtime,
    target: Target,
    account: Account,
}

impl Fixture {
    fn with(target: Target) -> Self {
        let account = enroll(&target, "a long enough password for tests");
        Self {
            runtime: tokio::runtime::Runtime::new().unwrap(),
            target,
            account,
        }
    }

    fn with_plans() -> Self {
        Self::with(Target::in_process_with_plans(PLANS, |_| {}))
    }

    fn client(&self) -> SyncClient {
        SyncClient::new(&ServerUrl::parse(self.target.api.base(), true).unwrap()).unwrap()
    }

    fn token(&self) -> DeviceToken {
        DeviceToken::new(self.account.token.clone())
    }

    fn ak(&self) -> AccountKey {
        self.account.ak.clone()
    }

    fn overview(
        &self,
        current: Option<[u8; 16]>,
        bound: &[BoundVault],
    ) -> super::account_types::AccountOverview {
        self.runtime
            .block_on(account_overview(
                &self.client(),
                &self.token(),
                &self.ak(),
                current,
                bound,
            ))
            .unwrap()
    }
}

#[test]
fn names_are_opened_and_the_sizes_and_the_plan_come_from_the_server() {
    // У1, У2, У5, П61: the interface gets readable names, the plan and bytes; no key.
    let fx = Fixture::with_plans();
    let work = fx.account.create_space_named("Работа");
    let home = fx.account.create_space_named("Дом");
    work.commit_ok(&[work.raw_file(&new_item(), 0, "a.md", 1_500)]);
    let item = new_item();
    home.commit_ok(&[home.raw_file(&item, 0, "b.md", 700)]);
    home.commit_ok(&[home.raw_file(&item, 1, "b.md", 300)]);

    let overview = fx.overview(None, &[]);
    assert!(overview.limits_known);
    let plan = overview.plan.expect("the server has plans");
    assert_eq!(
        (plan.name.as_str(), plan.title.as_deref()),
        ("small", Some("Small"))
    );
    assert!(!plan.pinned);
    assert_eq!(overview.limits.max_spaces, Some(2));
    assert_eq!(overview.limits.max_total_bytes, Some(10_000));
    assert_eq!(overview.limits.max_file_bytes, Some(4_000));
    assert_eq!(overview.limits.history_days, Some(10));
    assert_eq!(overview.limits.max_history_bytes, Some(8_000));
    assert_eq!(overview.usage.live_bytes, 1_800);
    assert_eq!(overview.usage.history_bytes, 700);
    assert_eq!(overview.usage.spaces, 2);
    assert_eq!(overview.spaces.len(), 2);
    let by_name = |name: &str| {
        overview
            .spaces
            .iter()
            .find(|space| space.name.as_deref() == Some(name))
            .unwrap_or_else(|| panic!("no storage named {name}: {:?}", overview.spaces))
    };
    assert_eq!(by_name("Работа").live_bytes, 1_500);
    assert_eq!(by_name("Работа").history_bytes, 0);
    assert_eq!(by_name("Дом").live_bytes, 300);
    assert_eq!(by_name("Дом").history_bytes, 700);
    assert_eq!(by_name("Работа").space_id, hex16(work.id.as_bytes()));
}

#[test]
fn the_open_vault_and_the_vaults_of_this_computer_are_matched_to_the_spaces() {
    // У1: "Это хранилище" and "Привязано на этом компьютере: <имя папки>" — the name only.
    let fx = Fixture::with_plans();
    let first = fx.account.create_space_named("Первое");
    let second = fx.account.create_space_named("Второе");
    let bound = [BoundVault {
        folder: "Notes".into(),
        space_id: *first.id.as_bytes(),
    }];
    let overview = fx.overview(Some(*second.id.as_bytes()), &bound);
    let row = |space: &amby_sync_conformance::client::Space| {
        overview
            .spaces
            .iter()
            .find(|row| row.space_id == hex16(space.id.as_bytes()))
            .unwrap()
            .clone()
    };
    assert_eq!(row(&first).bound_folder.as_deref(), Some("Notes"));
    assert!(!row(&first).this_vault);
    assert!(row(&second).this_vault);
    assert_eq!(row(&second).bound_folder, None);
}

#[test]
fn a_pinned_user_shows_the_pinned_plan() {
    let fx = Fixture::with_plans();
    fx.target
        .cli_ok(&["user", "plan", "set", &fx.account.username, "free"]);
    let overview = fx.overview(None, &[]);
    let plan = overview.plan.unwrap();
    assert_eq!(plan.name, "free");
    assert!(plan.pinned);
    assert_eq!(overview.limits.max_spaces, None);
    assert_eq!(overview.limits.max_total_bytes, None);
}

#[test]
fn a_server_without_plans_has_no_plan_and_only_its_ceilings() {
    // У2: "Свой сервер: без ограничений" is the interface's reading of "no plan, no limits".
    let fx = Fixture::with(Target::in_process());
    let overview = fx.overview(None, &[]);
    assert!(overview.limits_known);
    assert!(overview.plan.is_none());
    assert_eq!(overview.limits.max_spaces, None);
    assert_eq!(overview.limits.max_total_bytes, None);
}

#[test]
fn a_name_that_does_not_open_does_not_break_the_list() {
    // У1: "Название недоступно" is the interface's reading of `name: None`.
    let fx = Fixture::with_plans();
    fx.account.create_space_named("Читается");
    // a space whose name was sealed with the key of another account
    let (id, _vk, mut body) = fx.account.new_space_request("x");
    let stranger = enroll(&fx.target, "another long enough password");
    body["name_enc"] = json!(seal_space_name(&stranger.ak, id.as_bytes(), "Чужой"));
    fx.account.post("/v1/spaces", body).expect(201);
    let overview = fx.overview(None, &[]);
    let mut names: Vec<Option<String>> = overview.spaces.iter().map(|s| s.name.clone()).collect();
    names.sort();
    assert_eq!(names, vec![None, Some("Читается".to_string())]);
    assert_eq!(overview.usage.spaces, 2);
}

/// A server that knows the listing of spaces and does not know `GET /v1/account` (answers 404).
fn old_server(listing: String) -> (String, std::thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = format!("http://{}", listener.local_addr().unwrap());
    let handle = std::thread::spawn(move || {
        listener.set_nonblocking(false).unwrap();
        // The test makes at most a few requests; the thread ends when the listener is dropped
        // with the test (accept fails) or after 4 requests.
        for stream in listener.incoming().take(4) {
            let Ok(mut stream) = stream else { return };
            let mut buffer = [0u8; 4096];
            let read = stream.read(&mut buffer).unwrap_or(0);
            let head = String::from_utf8_lossy(&buffer[..read]).to_string();
            let (status, body) = if head.starts_with("GET /v1/spaces ") {
                ("200 OK", listing.clone())
            } else {
                (
                    "404 Not Found",
                    r#"{"error":{"code":"not_found","message":"not found"}}"#.to_string(),
                )
            };
            let _ = write!(
                stream,
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
        }
    });
    (address, handle)
}

#[test]
fn a_server_without_the_account_request_gives_an_overview_without_limits_and_keeps_the_list() {
    // Р13, У5: the section is "no limits"; the spaces still come from the listing.
    let target = Target::in_process();
    let account = enroll(&target, "a long enough password for tests");
    let id = random16();
    let listing = json!({"spaces": [{
        "space_id": hex16(&id),
        "name_enc": seal_space_name(&account.ak, &id, "Старый сервер"),
        "key_epoch": 1,
        "wrapped_vk": "ab".repeat(73),
        "seq": 3,
        "created_ms": 1_760_000_000_000i64,
    }]})
    .to_string();
    let (address, server) = old_server(listing);
    let client = SyncClient::new(&ServerUrl::parse(&address, true).unwrap()).unwrap();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let overview = runtime
        .block_on(account_overview(
            &client,
            &DeviceToken::new(account.token.clone()),
            &account.ak,
            None,
            &[],
        ))
        .unwrap();
    assert!(!overview.limits_known);
    assert!(overview.plan.is_none());
    assert_eq!(overview.limits.max_total_bytes, None);
    assert_eq!(overview.spaces.len(), 1);
    assert_eq!(overview.spaces[0].name.as_deref(), Some("Старый сервер"));
    drop(server);
}
