//! The persisted workspace switches for the domain tools. Match the Standard
//! defaults in the renderer's workspace module configuration.

use std::fs::File;
use std::io::{ErrorKind, Read};
use std::path::Path;

use serde_json::Value;

#[derive(Clone, Copy)]
pub enum Module {
    Databases,
    Creative,
}

#[derive(Clone, Copy)]
pub struct Modules {
    databases: bool,
    creative: bool,
}

impl Modules {
    pub fn read(root: &Path) -> Result<Self, &'static str> {
        const LIMIT: u64 = 8 * 1024 * 1024;
        let path = crate::durable::guarded_path(root, ".amby/workspace.json", "workspace modules")
            .map_err(|_| "moduleSettingsUnavailable")?;
        match std::fs::symlink_metadata(&path) {
            Ok(meta) if meta.is_file() => {}
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Self::standard()),
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
        if let Some(modules) = workspace.get("enabledModules") {
            let modules = modules.as_array().ok_or("moduleSettingsUnavailable")?;
            if !modules.iter().all(Value::is_string) {
                return Err("moduleSettingsUnavailable");
            }
            return Ok(Self {
                databases: modules
                    .iter()
                    .any(|id| matches!(id.as_str(), Some("databases" | "amby.databases"))),
                creative: modules
                    .iter()
                    .any(|id| matches!(id.as_str(), Some("creative" | "amby.creative"))),
            });
        }
        let minimal = matches!(
            workspace["layout"]["activePresetId"].as_str(),
            Some("minimal" | "simple")
        ) || workspace["profile"]["id"] == "minimal";
        Ok(if minimal {
            Self {
                databases: false,
                creative: false,
            }
        } else {
            Self::standard()
        })
    }

    fn standard() -> Self {
        Self {
            databases: true,
            creative: false,
        }
    }

    pub fn includes(self, module: Module) -> bool {
        match module {
            Module::Databases => self.databases,
            Module::Creative => self.databases && self.creative,
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
