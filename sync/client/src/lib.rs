//! Amby sync: the asynchronous client of the sign-in protocol (docs/sync-plan.md, stage Э4;
//! protocol: appendix Б). It has no dependency on Tauri, so the application and, later, the phone
//! share it. It speaks `/v1/info`, `enroll`, `prelogin`, `login`, `recover`, `keys` and
//! `devices`; the cryptography is `amby-sync-core`.
//!
//! - [`url`]: the address of a server and the `https://` rule (П41);
//! - [`error`]: errors with the machine codes of table Б.0.1 and plain texts;
//! - [`api`]: one method per request, no logic;
//! - [`spaces`]: spaces, bodies, commits, the change feed and notifications (Б.3–Б.6, stage Э4);
//! - [`flows`]: the sign-in flows of the application — create an account, sign in on a new
//!   device, recover by the code — built from the requests and the cryptography.
//!
//! No secret is ever written to a log or an error text: passwords, keys, tokens and the recovery
//! code do not appear in `Debug` or `Display` output (О1).

pub mod api;
pub mod error;
pub mod flows;
pub mod spaces;
pub mod url;

pub use api::{
    DeviceEntry, DeviceToken, EnrollRequest, KeysAnswer, LoginAnswer, Prelogin, RecoverAnswer,
    ReplaceKeysRequest, ServerInfo, Session, SyncClient,
};
pub use error::ClientError;
pub use flows::{
    disconnect_device, enroll_prepared, list_devices, prepare_account, recover_account, sign_in,
    validate_username, Connected, Device, PreparedAccount,
};
pub use spaces::{
    AccountLimits, AccountPlan, AccountSpace, AccountUsage, AccountView, BlobDownload, EventStream,
    NewSpace, ServerEvent, ServerLimits, SpaceEntry,
};
pub use url::ServerUrl;
