use std::env;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::args::Options;

const MAX_CONFIG_BYTES: u64 = 1024 * 1024;

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspaces {
    pub last_opened: Option<PathBuf>,
    #[serde(default)]
    pub recent: Vec<VaultRecord>,
}

#[derive(Deserialize)]
pub struct VaultRecord {
    pub path: PathBuf,
    #[serde(default)]
    pub detached: bool,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Choice {
    schema_version: u32,
    vault: PathBuf,
}

pub fn app_data() -> Result<PathBuf, &'static str> {
    let root = env::var_os("AMBY_APP_DATA_DIR")
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .or_else(|| dirs::data_local_dir().map(|dir| dir.join("Amby").join("notes")));
    root.ok_or("appDataUnavailable")
}

fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Option<T> {
    if !fs::symlink_metadata(path).ok()?.is_file() {
        return None;
    }
    let mut data = Vec::new();
    File::open(path)
        .ok()?
        .take(MAX_CONFIG_BYTES + 1)
        .read_to_end(&mut data)
        .ok()?;
    if data.len() as u64 > MAX_CONFIG_BYTES {
        return None;
    }
    serde_json::from_slice(&data).ok()
}

pub fn workspaces() -> Workspaces {
    app_data()
        .ok()
        .and_then(|root| read_json(&root.join("workspaces.json")))
        .unwrap_or_default()
}

pub fn vault_path(path: &Path) -> Result<PathBuf, &'static str> {
    let path = path.canonicalize().map_err(|_| "vaultNotFound")?;
    if path.is_dir() && path.to_str().is_some() {
        Ok(path)
    } else {
        Err("vaultNotFound")
    }
}

pub fn selected(options: &Options, workspaces: &Workspaces) -> Option<PathBuf> {
    options
        .vault
        .clone()
        .or_else(|| {
            env::var_os("AMBY_VAULT")
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
        })
        .or_else(|| {
            let file = app_data().ok()?.join("cli.json");
            let choice: Choice = read_json(&file)?;
            (choice.schema_version == 1).then_some(choice.vault)
        })
        .or_else(|| workspaces.last_opened.clone())
}

pub fn remember(path: &Path) -> Result<(), &'static str> {
    let root = app_data()?;
    fs::create_dir_all(&root).map_err(|_| "appDataUnavailable")?;
    let bytes = serde_json::to_vec_pretty(&Choice {
        schema_version: 1,
        vault: path.into(),
    })
    .map_err(|_| "appDataUnavailable")?;
    amby_core::atomic_fs::atomic_write_bytes(&root.join("cli.json"), &bytes)
        .map_err(|_| "appDataUnavailable")
}
