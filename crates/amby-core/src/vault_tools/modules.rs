//! The persisted workspace switches for the domain tools. Match the Standard
//! defaults in the renderer's workspace module configuration.

use std::fs::File;
use std::io::{ErrorKind, Read};
use std::path::Path;

use serde_json::Value;

use crate::note_templates::NOTE_MODULES_REVISION;

#[derive(Clone, Copy)]
pub enum Module {
    Databases,
    Creative,
    Templates,
    Daily,
}

#[derive(Clone, Copy)]
pub struct Modules {
    databases: bool,
    creative: bool,
    templates: bool,
    daily: bool,
}

/// `.amby/workspace.json` as JSON, or `None` when the vault has none yet.
pub fn read_workspace(root: &Path) -> Result<Option<Value>, &'static str> {
    const LIMIT: u64 = 8 * 1024 * 1024;
    let path = crate::durable::guarded_path(root, ".amby/workspace.json", "workspace modules")
        .map_err(|_| "moduleSettingsUnavailable")?;
    match std::fs::symlink_metadata(&path) {
        Ok(meta) if meta.is_file() => {}
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        _ => return Err("moduleSettingsUnavailable"),
    }
    let file = File::open(path).map_err(|_| "moduleSettingsUnavailable")?;
    let mut bytes = Vec::new();
    file.take(LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "moduleSettingsUnavailable")?;
    if bytes.len() as u64 > LIMIT {
        return Err("moduleSettingsUnavailable");
    }
    let bytes = bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(&bytes);
    let workspace: Value =
        serde_json::from_slice(bytes).map_err(|_| "moduleSettingsUnavailable")?;
    if !workspace.is_object() {
        return Err("moduleSettingsUnavailable");
    }
    Ok(Some(workspace))
}

fn minimal(workspace: &Value) -> bool {
    matches!(
        workspace["layout"]["activePresetId"].as_str(),
        Some("minimal" | "simple")
    ) || workspace["profile"]["id"] == "minimal"
}

impl Modules {
    pub fn read(root: &Path) -> Result<Self, &'static str> {
        let Some(workspace) = read_workspace(root)? else {
            return Ok(Self::standard());
        };
        if let Some(modules) = workspace.get("enabledModules") {
            let modules = modules.as_array().ok_or("moduleSettingsUnavailable")?;
            if !modules.iter().all(Value::is_string) {
                return Err("moduleSettingsUnavailable");
            }
            let has = |short: &str| {
                modules.iter().any(|id| {
                    id.as_str()
                        .is_some_and(|id| id == short || id.strip_prefix("amby.") == Some(short))
                })
            };
            // A list saved before the note modules existed gets them, as the renderer does
            // when it reads the file (`readWorkspaceModuleConfig`); a current one is as written.
            let predates = !minimal(&workspace)
                && workspace["profile"]["catalogRevision"]
                    .as_str()
                    .is_none_or(|revision| revision < NOTE_MODULES_REVISION);
            return Ok(Self {
                databases: has("databases"),
                creative: has("creative"),
                templates: predates || has("templates"),
                daily: predates || has("daily"),
            });
        }
        Ok(if minimal(&workspace) {
            Self {
                databases: false,
                creative: false,
                templates: false,
                daily: false,
            }
        } else {
            Self::standard()
        })
    }

    fn standard() -> Self {
        Self {
            databases: true,
            creative: false,
            templates: true,
            daily: true,
        }
    }

    pub fn includes(self, module: Module) -> bool {
        match module {
            Module::Databases => self.databases,
            Module::Creative => self.databases && self.creative,
            Module::Templates => self.templates,
            Module::Daily => self.daily,
        }
    }

    pub fn require(root: &Path, module: Module) -> Result<(), &'static str> {
        if Self::read(root)?.includes(module) {
            Ok(())
        } else {
            Err("moduleDisabled")
        }
    }
}
