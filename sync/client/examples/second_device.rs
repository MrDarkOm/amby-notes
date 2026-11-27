//! A second device for the manual check of the connect screen (docs/native-ui-smoke.md, «Синхронизация»).
//!
//! ```text
//! cargo run --manifest-path sync/Cargo.toml -p amby-sync-client --example second_device -- \
//!     http://127.0.0.1:18080 anna "<password>" "Second computer"
//! ```
//!
//! It signs in like a new device, then asks for the list of devices every three seconds and
//! stops with a message when the application disconnects it. The password is read from the
//! command line, so use it only against a server of your own and only for a test account.
#![allow(clippy::print_stdout)]

use std::time::Duration;

use amby_sync_client::{list_devices, sign_in, ServerUrl, SyncClient};

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [url, username, password, device_name] = args.as_slice() else {
        eprintln!("usage: second_device <server address> <user> <password> <device name>");
        std::process::exit(2);
    };
    let url = ServerUrl::parse(url, true).unwrap_or_else(|error| fail("address", &error));
    let client = SyncClient::new(&url).unwrap_or_else(|error| fail("client", &error));
    let connected = sign_in(&client, username, password, device_name)
        .await
        .unwrap_or_else(|error| fail("sign in", &error));
    println!("signed in as \"{device_name}\"; asking for the devices every 3 s (Ctrl-C to stop)");
    loop {
        match list_devices(&client, &connected.session.token, &connected.account_key).await {
            Ok(devices) => {
                let names: Vec<String> = devices
                    .iter()
                    .map(|device| device.name.clone().unwrap_or_else(|| "?".to_string()))
                    .collect();
                println!("devices: {}", names.join(", "));
            }
            Err(error) if error.code() == "token_revoked" => {
                println!("this device was disconnected (token_revoked)");
                return;
            }
            Err(error) => println!("error: {}", error.code()),
        }
        tokio::time::sleep(Duration::from_secs(3)).await;
    }
}

fn fail(what: &str, error: &amby_sync_client::ClientError) -> ! {
    eprintln!("{what}: {} ({})", error.code(), error);
    std::process::exit(1);
}
