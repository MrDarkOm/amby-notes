//! Package Manager backend for module lifecycle, staging, signature verification,
//! atomic publishing, version tracking, rollback, and uninstallation.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use crate::app_data;
use crate::paths;

pub const OFFICIAL_ED25519_KEY_ID: &str = "amby-official-2026";
pub const OFFICIAL_ED25519_PUBLIC_KEY_HEX: &str =
    "540caa0bdc9a519b774ad2ee4fb3e2278d149ee0ecfaa0d54ba75e6ad66c9dda";

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
pub struct ModuleSignature {
    #[serde(rename = "keyId")]
    pub key_id: String,
    pub sig: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
pub struct ModuleManifest {
    #[serde(rename = "formatVersion")]
    pub format_version: u32,
    pub id: String,
    pub name: String,
    pub version: String,
    pub publisher: String,
    pub kind: String, // "official" | "community"
    #[serde(rename = "minAppVersion")]
    pub min_app_version: String,
    #[serde(rename = "maxAppVersion")]
    pub max_app_version: Option<String>,
    pub entry: String,
    pub permissions: Vec<String>,
    pub checksums: BTreeMap<String, String>,
    pub signature: ModuleSignature,
    pub dependencies: Option<BTreeMap<String, String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
pub struct StagedPackageInfo {
    #[serde(rename = "stagingId")]
    pub staging_id: String,
    pub manifest: ModuleManifest,
    #[serde(rename = "stagingPath")]
    pub staging_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
pub struct InstalledModuleInfo {
    #[serde(rename = "moduleId")]
    pub module_id: String,
    #[serde(rename = "activeVersion")]
    pub active_version: String,
    #[serde(rename = "installedVersions")]
    pub installed_versions: Vec<String>,
    #[serde(rename = "installPath")]
    pub install_path: String,
    #[serde(rename = "entryPath")]
    pub entry_path: String,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
pub struct PublishModuleResult {
    pub success: bool,
    #[serde(rename = "moduleId")]
    pub module_id: String,
    #[serde(rename = "installedVersion")]
    pub installed_version: String,
    #[serde(rename = "previousVersion")]
    pub previous_version: Option<String>,
    #[serde(rename = "installPath")]
    pub install_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
pub struct RollbackModuleResult {
    pub success: bool,
    #[serde(rename = "moduleId")]
    pub module_id: String,
    #[serde(rename = "rolledBackToVersion")]
    pub rolled_back_to_version: String,
    #[serde(rename = "previousVersion")]
    pub previous_version: String,
    #[serde(rename = "activeInstallPath")]
    pub active_install_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ModuleVersionsMeta {
    #[serde(rename = "activeVersion")]
    pub active_version: String,
    #[serde(rename = "installedVersions")]
    pub installed_versions: Vec<String>,
}

pub fn hex_decode(s: &str) -> Result<Vec<u8>, String> {
    let clean = s.trim();
    if !clean.len().is_multiple_of(2) {
        return Err("Hex string length must be even".to_string());
    }
    (0..clean.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&clean[i..i + 2], 16).map_err(|e| e.to_string()))
        .collect()
}

pub fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

pub fn compute_sha256(data: &[u8]) -> String {
    let digest = ring::digest::digest(&ring::digest::SHA256, data);
    hex_encode(digest.as_ref())
}

pub fn verify_ed25519(
    public_key_hex: &str,
    message: &[u8],
    signature_str: &str,
) -> Result<bool, String> {
    let sig_hex = signature_str
        .strip_prefix("ed25519:")
        .unwrap_or(signature_str);
    let sig_bytes = hex_decode(sig_hex).map_err(|e| format!("Invalid signature hex: {e}"))?;
    if sig_bytes.len() != 64 {
        return Ok(false);
    }

    let pubkey_bytes =
        hex_decode(public_key_hex).map_err(|e| format!("Invalid public key hex: {e}"))?;
    if pubkey_bytes.len() != 32 {
        return Ok(false);
    }

    let peer_public_key =
        ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, &pubkey_bytes);
    match peer_public_key.verify(message, &sig_bytes) {
        Ok(()) => Ok(true),
        Err(_) => Ok(false),
    }
}

pub fn canonical_manifest_bytes(manifest: &ModuleManifest) -> Result<Vec<u8>, String> {
    #[derive(serde::Serialize)]
    struct CanonicalManifestPayload<'a> {
        checksums: &'a BTreeMap<String, String>,
        entry: &'a str,
        #[serde(rename = "formatVersion")]
        format_version: u32,
        id: &'a str,
        kind: &'a str,
        #[serde(rename = "maxAppVersion", skip_serializing_if = "Option::is_none")]
        max_app_version: Option<&'a str>,
        #[serde(rename = "minAppVersion")]
        min_app_version: &'a str,
        name: &'a str,
        permissions: &'a [String],
        publisher: &'a str,
        version: &'a str,
    }

    let payload = CanonicalManifestPayload {
        checksums: &manifest.checksums,
        entry: &manifest.entry,
        format_version: manifest.format_version,
        id: &manifest.id,
        kind: &manifest.kind,
        max_app_version: manifest.max_app_version.as_deref(),
        min_app_version: &manifest.min_app_version,
        name: &manifest.name,
        permissions: &manifest.permissions,
        publisher: &manifest.publisher,
        version: &manifest.version,
    };

    serde_json::to_vec(&payload).map_err(|e| format!("Failed to serialize canonical manifest: {e}"))
}

pub fn verify_manifest_signature(manifest: &ModuleManifest) -> Result<bool, String> {
    if manifest.kind != "official" {
        return Ok(true);
    }

    if manifest.signature.key_id != OFFICIAL_ED25519_KEY_ID {
        return Ok(false);
    }

    let canonical_bytes = canonical_manifest_bytes(manifest)?;
    verify_ed25519(
        OFFICIAL_ED25519_PUBLIC_KEY_HEX,
        &canonical_bytes,
        &manifest.signature.sig,
    )
}

pub fn validate_path_confinement(paths: &[String]) -> Result<(), String> {
    for p in paths {
        let normalized = p.replace('\\', "/");
        if normalized.starts_with('/')
            || normalized.contains("..")
            || normalized.contains('\0')
            || (normalized.len() >= 2 && normalized.as_bytes()[1] == b':')
        {
            return Err(format!("Path traversal or invalid relative path: {p}"));
        }
    }
    Ok(())
}

pub fn modules_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    // Read root via app_data's app_root helper
    let base = app_data::app_root(app)?;
    let root = base.join("modules");
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    Ok(root)
}

pub fn stage_module(
    app: &tauri::AppHandle,
    staging_id: String,
    manifest: ModuleManifest,
    files: BTreeMap<String, String>,
) -> Result<StagedPackageInfo, String> {
    // 1. Validate manifest fields
    if manifest.format_version != 1 {
        return Err(format!(
            "Unsupported formatVersion: {}",
            manifest.format_version
        ));
    }
    if manifest.id.is_empty()
        || !manifest
            .id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_')
    {
        return Err("Invalid module id".to_string());
    }

    // 2. Validate paths
    let paths: Vec<String> = files.keys().cloned().collect();
    validate_path_confinement(&paths)?;

    // 3. Validate checksums
    for (path, declared_hash) in &manifest.checksums {
        let file_content = files
            .get(path)
            .ok_or_else(|| format!("Declared file missing from package: {path}"))?;
        let computed = compute_sha256(file_content.as_bytes());
        if computed.to_lowercase() != declared_hash.to_lowercase() {
            return Err(format!(
                "Checksum mismatch for file {path}: expected {declared_hash}, got {computed}"
            ));
        }
    }

    // 4. Validate Ed25519 signature
    let sig_valid = verify_manifest_signature(&manifest)?;
    if !sig_valid {
        return Err("Invalid or untrusted Ed25519 package signature".to_string());
    }

    // 5. Write to staging directory
    let root = modules_root(app)?;
    let staging_dir = root.join(".staging").join(&staging_id);
    fs::create_dir_all(&staging_dir).map_err(|e| e.to_string())?;

    for (rel_path, content) in &files {
        let full_path = staging_dir.join(rel_path);
        if let Some(parent) = full_path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::write(&full_path, content).map_err(|e| e.to_string())?;
    }

    // Write manifest
    let manifest_path = staging_dir.join("manifest.json");
    let manifest_bytes = serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?;
    fs::write(&manifest_path, manifest_bytes).map_err(|e| e.to_string())?;

    Ok(StagedPackageInfo {
        staging_id,
        manifest,
        staging_path: staging_dir.to_string_lossy().to_string(),
    })
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct RawPackagePayload {
    #[serde(default, rename = "formatVersion")]
    pub format_version: Option<u32>,
    pub manifest: ModuleManifest,
    pub files: BTreeMap<String, String>,
}

pub async fn download_remote_package(
    app: &tauri::AppHandle,
    url: String,
) -> Result<StagedPackageInfo, String> {
    let parsed_url = reqwest::Url::parse(&url).map_err(|e| format!("Invalid URL: {e}"))?;
    if parsed_url.scheme() != "https"
        && !(parsed_url.scheme() == "http"
            && (parsed_url.host_str() == Some("localhost")
                || parsed_url.host_str() == Some("127.0.0.1")))
    {
        return Err("Only HTTPS package download URLs are allowed".to_string());
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;

    let response = client
        .get(parsed_url)
        .header("User-Agent", "Amby-Notes-Package-Manager")
        .send()
        .await
        .map_err(|e| format!("Network error while fetching package: {e}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "Download failed with HTTP status {}",
            response.status()
        ));
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Failed to read response body: {e}"))?;

    if bytes.len() > 50 * 1024 * 1024 {
        return Err("Package archive exceeds maximum allowed size (50MB)".to_string());
    }

    let payload: RawPackagePayload = serde_json::from_slice(&bytes)
        .map_err(|e| format!("Failed to parse .amby-pkg archive: {e}"))?;

    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let staging_id = format!("remote-{}-{}", payload.manifest.id, millis);

    stage_module(app, staging_id, payload.manifest, payload.files)
}

pub fn publish_module(
    app: &tauri::AppHandle,
    staging_id: String,
    module_id: String,
    version: String,
) -> Result<PublishModuleResult, String> {
    let root = modules_root(app)?;
    let staging_dir = root.join(".staging").join(&staging_id);
    if !staging_dir.is_dir() {
        return Err(format!("Staging directory not found: {staging_id}"));
    }

    let module_dir = root.join(&module_id);
    let target_dir = module_dir.join(&version);
    fs::create_dir_all(&module_dir).map_err(|e| e.to_string())?;

    // If target directory already exists, clear it for atomic replacement
    if target_dir.exists() {
        let _ = fs::remove_dir_all(&target_dir);
    }

    // Atomically move or copy staging dir to target
    if fs::rename(&staging_dir, &target_dir).is_err() {
        // Fallback for cross-filesystem moves
        copy_dir_all(&staging_dir, &target_dir)?;
        let _ = fs::remove_dir_all(&staging_dir);
    }

    // Update versions.json
    let versions_file = module_dir.join("versions.json");
    let mut versions_meta = if versions_file.is_file() {
        let content = fs::read_to_string(&versions_file).unwrap_or_default();
        serde_json::from_str::<ModuleVersionsMeta>(&content).unwrap_or_else(|_| {
            ModuleVersionsMeta {
                active_version: version.clone(),
                installed_versions: Vec::new(),
            }
        })
    } else {
        ModuleVersionsMeta {
            active_version: version.clone(),
            installed_versions: Vec::new(),
        }
    };

    let previous_version = if versions_meta.active_version != version {
        Some(versions_meta.active_version.clone())
    } else {
        None
    };

    if !versions_meta.installed_versions.contains(&version) {
        versions_meta.installed_versions.push(version.clone());
    }
    versions_meta.active_version = version.clone();

    let meta_json = serde_json::to_string_pretty(&versions_meta).map_err(|e| e.to_string())?;
    fs::write(&versions_file, meta_json).map_err(|e| e.to_string())?;

    Ok(PublishModuleResult {
        success: true,
        module_id,
        installed_version: version,
        previous_version,
        install_path: target_dir.to_string_lossy().to_string(),
    })
}

pub fn rollback_module(
    app: &tauri::AppHandle,
    module_id: String,
) -> Result<RollbackModuleResult, String> {
    let root = modules_root(app)?;
    let module_dir = root.join(&module_id);
    let versions_file = module_dir.join("versions.json");

    if !versions_file.is_file() {
        return Err(format!("Module {module_id} has no version history"));
    }

    let content = fs::read_to_string(&versions_file).map_err(|e| e.to_string())?;
    let mut meta = serde_json::from_str::<ModuleVersionsMeta>(&content)
        .map_err(|e| format!("Corrupt version history: {e}"))?;

    let current = meta.active_version.clone();
    let prev = meta
        .installed_versions
        .iter()
        .rev()
        .find(|v| **v != current)
        .cloned()
        .ok_or_else(|| format!("No previous version available for rollback of {module_id}"))?;

    let target_dir = module_dir.join(&prev);
    if !target_dir.is_dir() {
        return Err(format!(
            "Rollback target version directory does not exist: {}",
            target_dir.display()
        ));
    }

    meta.active_version = prev.clone();
    let meta_json = serde_json::to_string_pretty(&meta).map_err(|e| e.to_string())?;
    fs::write(&versions_file, meta_json).map_err(|e| e.to_string())?;

    Ok(RollbackModuleResult {
        success: true,
        module_id,
        rolled_back_to_version: prev,
        previous_version: current,
        active_install_path: target_dir.to_string_lossy().to_string(),
    })
}

pub fn uninstall_module(app: &tauri::AppHandle, module_id: String) -> Result<(), String> {
    let root = modules_root(app)?;
    let module_dir = root.join(&module_id);
    if module_dir.exists() {
        fs::remove_dir_all(&module_dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn list_installed_modules(app: &tauri::AppHandle) -> Result<Vec<InstalledModuleInfo>, String> {
    let root = modules_root(app)?;
    let mut result = Vec::new();

    let entries = match fs::read_dir(&root) {
        Ok(e) => e,
        Err(_) => return Ok(result),
    };

    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }

        let module_dir = entry.path();
        if !module_dir.is_dir() {
            continue;
        }

        let versions_file = module_dir.join("versions.json");
        if !versions_file.is_file() {
            continue;
        }

        let content = fs::read_to_string(&versions_file).unwrap_or_default();
        let meta = match serde_json::from_str::<ModuleVersionsMeta>(&content) {
            Ok(m) => m,
            Err(_) => continue,
        };

        let active_dir = module_dir.join(&meta.active_version);
        let manifest_file = active_dir.join("manifest.json");
        let entry_file = if manifest_file.is_file() {
            let m_content = fs::read_to_string(&manifest_file).unwrap_or_default();
            serde_json::from_str::<ModuleManifest>(&m_content)
                .map(|m| m.entry)
                .unwrap_or_else(|_| "index.js".to_string())
        } else {
            "index.js".to_string()
        };

        let total_size = dir_size(&module_dir);

        result.push(InstalledModuleInfo {
            module_id: name,
            active_version: meta.active_version.clone(),
            installed_versions: meta.installed_versions,
            install_path: active_dir.to_string_lossy().to_string(),
            entry_path: active_dir.join(&entry_file).to_string_lossy().to_string(),
            size_bytes: total_size,
        });
    }

    Ok(result)
}

pub fn get_module_entry_path(app: &tauri::AppHandle, module_id: String) -> Result<String, String> {
    let root = modules_root(app)?;
    let module_dir = root.join(&module_id);
    let versions_file = module_dir.join("versions.json");
    if !versions_file.is_file() {
        return Err(format!("Module {module_id} is not installed"));
    }

    let content = fs::read_to_string(&versions_file).map_err(|e| e.to_string())?;
    let meta = serde_json::from_str::<ModuleVersionsMeta>(&content)
        .map_err(|e| format!("Invalid versions metadata: {e}"))?;

    let active_dir = module_dir.join(&meta.active_version);
    let manifest_file = active_dir.join("manifest.json");
    if !manifest_file.is_file() {
        return Err(format!(
            "Missing manifest.json in active version {}",
            meta.active_version
        ));
    }

    let m_content = fs::read_to_string(&manifest_file).map_err(|e| e.to_string())?;
    let manifest = serde_json::from_str::<ModuleManifest>(&m_content)
        .map_err(|e| format!("Corrupt manifest.json: {e}"))?;

    let entry_path = paths::confine_rel(&active_dir, &manifest.entry)?;
    if !entry_path.is_file() {
        return Err(format!(
            "Module entry file does not exist: {}",
            entry_path.display()
        ));
    }

    Ok(entry_path.to_string_lossy().to_string())
}

fn dir_size(path: &Path) -> u64 {
    let mut size = 0;
    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                size += dir_size(&p);
            } else if let Ok(meta) = p.metadata() {
                size += meta.len();
            }
        }
    }
    size
}

fn copy_dir_all(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(src).map_err(|e| e.to_string())?.flatten() {
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if src_path.is_dir() {
            copy_dir_all(&src_path, &dst_path)?;
        } else {
            fs::copy(&src_path, &dst_path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ed25519_verification_rejects_fake_signature() {
        let msg = b"amby-package-manifest-test-payload";
        // Fake signature: "ed25519:anything" or invalid hex / non-matching
        let fake_sig = "ed25519:anything";
        let res = verify_ed25519(OFFICIAL_ED25519_PUBLIC_KEY_HEX, msg, fake_sig);
        assert!(res.is_err() || res.unwrap() == false);

        let random_hex_sig = "ed25519:00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
        let res2 = verify_ed25519(OFFICIAL_ED25519_PUBLIC_KEY_HEX, msg, random_hex_sig);
        assert_eq!(res2.unwrap(), false);
    }

    #[test]
    fn test_ed25519_verification_accepts_valid_signature() {
        let msg = b"amby-package-manifest-test-payload";
        let valid_sig = "735ae4f2d075181de999ab84ea36fd0f2d5e884f4af7c9541e0aaad3559be7ef576c547fbd653b077aaff2e8adc3144fc866a166d161b28a9d7248a0820a9c0d";
        let res = verify_ed25519(OFFICIAL_ED25519_PUBLIC_KEY_HEX, msg, valid_sig);
        assert_eq!(res.unwrap(), true);
    }

    #[test]
    fn test_path_confinement_rejects_traversals() {
        assert!(validate_path_confinement(&["../outside.js".to_string()]).is_err());
        assert!(validate_path_confinement(&["/root.js".to_string()]).is_err());
        assert!(validate_path_confinement(&["sub/../../escape.js".to_string()]).is_err());
        assert!(validate_path_confinement(&["clean/nested/file.js".to_string()]).is_ok());
    }

    #[test]
    fn test_compute_sha256() {
        let data = b"hello world";
        let hash = compute_sha256(data);
        assert_eq!(
            hash,
            "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
        );
    }

    #[test]
    fn test_verify_real_generated_manifest_signature() {
        let manifest_json = r#"{
            "formatVersion": 1,
            "id": "amby.canvas",
            "name": "Canvas",
            "version": "1.0.0",
            "publisher": "Amby",
            "kind": "official",
            "minAppVersion": "0.1.5",
            "entry": "index.js",
            "permissions": [
                "ui-panel",
                "read-notes",
                "write-notes",
                "vault.read",
                "vault.write"
            ],
            "checksums": {
                "index.js": "41bb65fb42fef1e50ff6715576e0259b9a4c8221c21903877b8fe0cbafe55390"
            },
            "signature": {
                "keyId": "amby-official-2026",
                "sig": "ed25519:9ad45f8e5e0d7cb4ff55d25f4700e918af5a430da7dcf2dbf8b951bc5eb9f1ba82d1243ae1b2aa677a1f0fa148d52092c01070da0ec7c34e3a7ef8dd64fad30a"
            }
        }"#;
        let manifest: ModuleManifest = serde_json::from_str(manifest_json).unwrap();
        let valid = verify_manifest_signature(&manifest).unwrap();
        assert!(valid, "Real generated manifest signature must be valid");
    }
}
