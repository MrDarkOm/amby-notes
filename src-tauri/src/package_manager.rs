//! Package Manager backend for module lifecycle, staging, signature verification,
//! atomic publishing, version tracking, rollback, and uninstallation.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use crate::app_data;
use crate::frontmatter;

// Serialize lifecycle operations so two windows cannot lose version history.
static PACKAGE_GATE: std::sync::Mutex<()> = std::sync::Mutex::new(());
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

/// Private, recoverable publication intent; never trusts paths from disk.
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PendingModulePublish {
    format_version: u8,
    staging_id: String,
    manifest: ModuleManifest,
    previous_meta: Option<ModuleVersionsMeta>,
    next_meta: ModuleVersionsMeta,
}

fn recover_pending_publish(
    root: &Path,
    module_id: &str,
) -> Result<Option<(String, PublishModuleResult)>, String> {
    validate_module_id(module_id)?;
    let module_dir = paths::confine_rel_no_symlinks(root, module_id)?;
    if !module_dir.exists() {
        return Ok(None);
    }
    let journal_path = paths::confine_rel_no_symlinks(&module_dir, "pending-publish.json")?;
    if !journal_path.exists() {
        return Ok(None);
    }
    let journal: PendingModulePublish =
        serde_json::from_slice(&fs::read(&journal_path).map_err(|e| e.to_string())?)
            .map_err(|e| format!("Invalid module publication journal: {e}"))?;
    validate_manifest_fields(&journal.manifest)?;
    validate_manifest_compatibility(root, &journal.manifest)?;
    validate_staging_id(&journal.staging_id)?;
    if journal.format_version != 1 || journal.manifest.id != module_id {
        return Err("Publication journal does not match its module".into());
    }
    if let Some(previous) = &journal.previous_meta {
        validate_versions_fields(previous)?;
    }
    validate_versions_fields(&journal.next_meta)?;
    let version = &journal.manifest.version;
    let mut expected_next = journal.previous_meta.clone().unwrap_or(ModuleVersionsMeta {
        active_version: version.clone(),
        installed_versions: vec![],
    });
    if expected_next.installed_versions.contains(version) {
        return Err("Publication journal attempts to replace an installed version".into());
    }
    expected_next.active_version = version.clone();
    expected_next.installed_versions.push(version.clone());
    if expected_next != journal.next_meta {
        return Err("Invalid version history in publication journal".into());
    }
    // Resolve every journal-derived path before writing or moving anything.
    for old_version in &expected_next.installed_versions {
        validate_module_version(old_version)?;
        paths::confine_rel_no_symlinks(&module_dir, old_version)?;
    }
    let versions_file = paths::confine_rel_no_symlinks(&module_dir, "versions.json")?;
    let current_meta = read_versions_meta(&versions_file, &module_dir)?;
    if current_meta != journal.previous_meta && current_meta.as_ref() != Some(&journal.next_meta) {
        return Err("Version history changed after publication was prepared".into());
    }
    let target = paths::confine_rel_no_symlinks(&module_dir, version)?;
    let staging =
        paths::confine_rel_no_symlinks(root, &format!(".staging/{}", journal.staging_id))?;
    if target.exists() && staging.exists() {
        return Err("Publication target collided with a staged package".into());
    }
    let candidate = if target.exists() { &target } else { &staging };
    if validate_staged_package(candidate)? != journal.manifest {
        return Err("Publication files do not match their journal".into());
    }
    if !target.exists() {
        fs::rename(&staging, &target).map_err(|e| e.to_string())?;
    }
    atomic_write_versions(&versions_file, &journal.next_meta)?;
    fs::remove_file(&journal_path).map_err(|e| e.to_string())?;
    Ok(Some((
        journal.staging_id,
        PublishModuleResult {
            success: true,
            module_id: module_id.into(),
            installed_version: version.clone(),
            previous_version: journal.previous_meta.map(|meta| meta.active_version),
            install_path: target.to_string_lossy().into(),
        },
    )))
}

const MAX_PACKAGE_COMPONENT_LENGTH: usize = 128;

fn validate_package_component(value: &str, field: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > MAX_PACKAGE_COMPONENT_LENGTH {
        return Err(format!("Invalid {field}"));
    }
    if !value.starts_with(|c: char| c.is_ascii_alphanumeric()) || value.ends_with('.') {
        return Err(format!("Invalid {field}"));
    }
    if !value
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || ".-_+".contains(character))
    {
        return Err(format!("Invalid {field}"));
    }
    Ok(())
}

fn validate_module_id(module_id: &str) -> Result<(), String> {
    validate_package_component(module_id, "module id")?;
    validate_relative_package_path(module_id)?;
    if module_id == ".staging" {
        return Err("Invalid module id".to_string());
    }
    Ok(())
}

fn validate_module_version(version: &str) -> Result<(), String> {
    validate_package_component(version, "module version")?;
    parse_strict_version(version)
        .map(|_| ())
        .map_err(|error| format!("Invalid module version: {error}"))
}

fn parse_strict_version(value: &str) -> Result<semver::Version, String> {
    const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
    if value.len() > 128 {
        return Err("Version is too long".into());
    }
    let version = semver::Version::parse(value).map_err(|error| error.to_string())?;
    if [version.major, version.minor, version.patch]
        .into_iter()
        .any(|part| part > MAX_SAFE_INTEGER)
        || version.pre.as_str().split('.').any(|part| {
            !part.is_empty()
                && part.bytes().all(|byte| byte.is_ascii_digit())
                && part
                    .parse::<u64>()
                    .map_or(true, |value| value > MAX_SAFE_INTEGER)
        })
    {
        return Err("Version number exceeds the shared SemVer integer range".into());
    }
    Ok(version)
}

fn parse_dependency_requirement(value: &str) -> Result<semver::VersionReq, String> {
    // Preserve the existing manifest contract: `"1.2.3"` means at least
    // 1.2.3. Explicit comparators use a shared, deliberately narrow grammar.
    if let Ok(exact) = parse_strict_version(value) {
        return semver::VersionReq::parse(&format!(">={exact}"))
            .map_err(|error| format!("Invalid dependency version: {error}"));
    }
    if value == "*" {
        return Ok(semver::VersionReq::STAR);
    }
    if value.is_empty() || value.len() > 1024 || value != value.trim() {
        return Err("Invalid dependency version range".into());
    }
    for part in value.split(' ') {
        let version = [">=", "<=", ">", "<", "=", "^", "~"]
            .into_iter()
            .find_map(|operator| part.strip_prefix(operator))
            .ok_or_else(|| {
                "Dependency comparators require an operator and full version".to_owned()
            })?;
        parse_strict_version(version)?;
    }
    let normalized = value.split(' ').collect::<Vec<_>>().join(", ");
    semver::VersionReq::parse(&normalized)
        .map_err(|error| format!("Invalid dependency version range '{value}': {error}"))
}

fn validate_staging_id(staging_id: &str) -> Result<(), String> {
    validate_package_component(staging_id, "staging id")
}

fn validate_relative_package_path(path: &str) -> Result<(), String> {
    if path.is_empty() || path.contains(['\\', '\0', ':', '<', '>', '"', '|', '?', '*']) {
        return Err(format!("Invalid package path: {path}"));
    }
    for name in path.split('/') {
        let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
        let device = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || ((stem.starts_with("COM") || stem.starts_with("LPT"))
                && stem.len() == 4
                && matches!(stem.as_bytes()[3], b'1'..=b'9'));
        if name.is_empty() || name == "." || name == ".." || name.ends_with(['.', ' ']) || device {
            return Err(format!("Invalid package path component: {path}"));
        }
    }
    Ok(())
}

fn validate_manifest_fields(manifest: &ModuleManifest) -> Result<(), String> {
    if manifest.format_version != 1 {
        return Err(format!(
            "Unsupported formatVersion: {}",
            manifest.format_version
        ));
    }
    validate_module_id(&manifest.id)?;
    validate_module_version(&manifest.version)?;
    if manifest.kind != "official" && manifest.kind != "community" {
        return Err("Manifest kind must be 'official' or 'community'".to_string());
    }
    validate_relative_package_path(&manifest.entry)?;
    if manifest.entry == "manifest.json" {
        return Err("Manifest entry cannot be manifest.json".to_string());
    }
    if manifest.checksums.is_empty() {
        return Err("Manifest must contain file checksums".to_string());
    }
    validate_path_confinement(&manifest.checksums.keys().cloned().collect::<Vec<_>>())?;
    if manifest.checksums.contains_key("manifest.json") {
        return Err("manifest.json cannot be a package file".to_string());
    }
    let min_app_version = parse_strict_version(&manifest.min_app_version)
        .map_err(|error| format!("Invalid minAppVersion: {error}"))?;
    if let Some(max_app_version) = &manifest.max_app_version {
        let max_app_version = parse_strict_version(max_app_version)
            .map_err(|error| format!("Invalid maxAppVersion: {error}"))?;
        if min_app_version.cmp_precedence(&max_app_version).is_gt() {
            return Err("minAppVersion cannot exceed maxAppVersion".to_string());
        }
    }
    if let Some(dependencies) = &manifest.dependencies {
        for (dependency_id, requirement) in dependencies {
            validate_module_id(dependency_id)?;
            if dependency_id == &manifest.id {
                return Err("A module cannot depend on itself".into());
            }
            parse_dependency_requirement(requirement)?;
        }
    }
    Ok(())
}

fn validate_manifest_files(
    manifest: &ModuleManifest,
    files: &BTreeMap<String, String>,
) -> Result<(), String> {
    let file_paths = files.keys().cloned().collect::<Vec<_>>();
    validate_path_confinement(&file_paths)?;
    if files.contains_key("manifest.json") {
        return Err("manifest.json is reserved by the package manager".to_string());
    }
    let checksums = manifest.checksums.keys().collect::<BTreeSet<_>>();
    let actual = files.keys().collect::<BTreeSet<_>>();
    if checksums != actual {
        return Err("Manifest checksums must exactly match package files".to_string());
    }
    if !files.contains_key(&manifest.entry) {
        return Err(format!(
            "Manifest entry file is missing: {}",
            manifest.entry
        ));
    }
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
    Ok(())
}

pub fn hex_decode(s: &str) -> Result<Vec<u8>, String> {
    let clean = s.trim();
    if !clean.is_ascii() {
        return Err("Hex string must contain only ASCII characters".to_string());
    }
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
        validate_relative_package_path(p)?;
    }
    Ok(())
}

pub fn modules_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    // Read root via app_data's app_root helper
    let base = app_data::app_root(app)?;
    let root = base.join("modules");
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    if fs::symlink_metadata(&root)
        .map_err(|e| e.to_string())?
        .file_type()
        .is_symlink()
    {
        return Err("Module root cannot be a symbolic link".to_string());
    }
    Ok(root)
}

pub fn stage_module(
    app: &tauri::AppHandle,
    staging_id: String,
    manifest: ModuleManifest,
    files: BTreeMap<String, String>,
) -> Result<StagedPackageInfo, String> {
    let _guard = PACKAGE_GATE.lock().map_err(|error| error.to_string())?;
    stage_module_at(&modules_root(app)?, staging_id, manifest, files)
}

fn stage_module_at(
    root: &Path,
    staging_id: String,
    manifest: ModuleManifest,
    files: BTreeMap<String, String>,
) -> Result<StagedPackageInfo, String> {
    // Retain the legacy IPC argument, but never use it to select a directory.
    validate_staging_id(&staging_id)?;
    let staging_id = format!("stage-{}", ulid::Ulid::generate());
    validate_manifest_fields(&manifest)?;
    validate_manifest_files(&manifest, &files)?;

    // Validate Ed25519 signature before creating any filesystem state.
    let sig_valid = verify_manifest_signature(&manifest)?;
    if !sig_valid {
        return Err("Invalid or untrusted Ed25519 package signature".to_string());
    }

    let staging_parent = paths::confine_rel_no_symlinks(root, ".staging")?;
    fs::create_dir_all(&staging_parent).map_err(|e| e.to_string())?;
    if fs::symlink_metadata(&staging_parent)
        .map_err(|e| e.to_string())?
        .file_type()
        .is_symlink()
    {
        return Err("Module staging root cannot be a symbolic link".to_string());
    }
    let staging_dir = paths::confine_rel_no_symlinks(&staging_parent, &staging_id)?;
    if staging_dir.exists() {
        return Err(format!("Staging directory already exists: {staging_id}"));
    }
    fs::create_dir(&staging_dir).map_err(|e| e.to_string())?;

    let write_result = (|| -> Result<(), String> {
        for (rel_path, content) in &files {
            let full_path = paths::confine_rel_no_symlinks(&staging_dir, rel_path)?;
            if let Some(parent) = full_path.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            frontmatter::atomic_write_bytes_new(&full_path, content.as_bytes())
                .map_err(|error| format!("Cannot create package file: {error:?}"))?;
        }

        let manifest_path = paths::confine_rel_no_symlinks(&staging_dir, "manifest.json")?;
        let manifest_bytes = serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?;
        frontmatter::atomic_write(&manifest_path, &manifest_bytes)
    })();
    if let Err(error) = write_result {
        let _ = fs::remove_dir_all(&staging_dir);
        return Err(error);
    }

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

    stage_module(app, "remote".into(), payload.manifest, payload.files)
}

fn collect_package_files(
    root: &Path,
    current: &Path,
    files: &mut BTreeSet<String>,
) -> Result<(), String> {
    let metadata = fs::symlink_metadata(current).map_err(|e| e.to_string())?;
    if metadata.file_type().is_symlink() {
        return Err(format!(
            "Symbolic links are not allowed in staged packages: {}",
            current.display()
        ));
    }
    if metadata.is_dir() {
        for entry in fs::read_dir(current).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            collect_package_files(root, &entry.path(), files)?;
        }
        return Ok(());
    }
    if !metadata.is_file() {
        return Err(format!(
            "Unsupported staged package entry: {}",
            current.display()
        ));
    }

    let relative = current
        .strip_prefix(root)
        .map_err(|e| e.to_string())?
        .components()
        .map(|part| {
            part.as_os_str()
                .to_str()
                .ok_or_else(|| "Package paths must be UTF-8".to_string())
        })
        .collect::<Result<Vec<_>, _>>()?
        .join("/");
    if relative == "manifest.json" {
        return Ok(());
    }
    validate_relative_package_path(&relative)?;
    files.insert(relative);
    Ok(())
}

fn validate_staged_package(staging_dir: &Path) -> Result<ModuleManifest, String> {
    let manifest_path = paths::confine_rel_no_symlinks(staging_dir, "manifest.json")?;
    let manifest_metadata = fs::symlink_metadata(&manifest_path).map_err(|e| e.to_string())?;
    if manifest_metadata.file_type().is_symlink() || !manifest_metadata.is_file() {
        return Err("Staged package manifest.json must be a regular file".to_string());
    }
    let manifest_content = fs::read_to_string(&manifest_path).map_err(|e| e.to_string())?;
    let manifest: ModuleManifest = serde_json::from_str(&manifest_content)
        .map_err(|e| format!("Invalid staged package manifest: {e}"))?;
    validate_manifest_fields(&manifest)?;
    if !verify_manifest_signature(&manifest)? {
        return Err("Invalid or untrusted Ed25519 package signature".to_string());
    }

    let mut actual_files = BTreeSet::new();
    collect_package_files(staging_dir, staging_dir, &mut actual_files)?;
    let expected_files = manifest.checksums.keys().cloned().collect::<BTreeSet<_>>();
    if actual_files != expected_files {
        return Err("Staged package file set does not match manifest checksums".to_string());
    }
    if !expected_files.contains(&manifest.entry) {
        return Err(format!(
            "Manifest entry file is missing: {}",
            manifest.entry
        ));
    }

    for path in expected_files {
        let file_path = paths::confine_rel_no_symlinks(staging_dir, &path)?;
        let metadata = fs::symlink_metadata(&file_path).map_err(|e| e.to_string())?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(format!("Package file is not a regular file: {path}"));
        }
        let bytes = fs::read(&file_path).map_err(|e| e.to_string())?;
        let expected_hash = manifest
            .checksums
            .get(&path)
            .expect("expected package file is present in manifest");
        let actual_hash = compute_sha256(&bytes);
        if !actual_hash.eq_ignore_ascii_case(expected_hash) {
            return Err(format!(
                "Checksum mismatch for staged file {path}: expected {expected_hash}, got {actual_hash}"
            ));
        }
    }
    Ok(manifest)
}

fn validate_manifest_compatibility(root: &Path, manifest: &ModuleManifest) -> Result<(), String> {
    let current_app_version = parse_strict_version(env!("CARGO_PKG_VERSION"))
        .map_err(|error| format!("Invalid application version: {error}"))?;
    let min_app_version = parse_strict_version(&manifest.min_app_version)
        .map_err(|error| format!("Invalid minAppVersion: {error}"))?;
    if current_app_version.cmp_precedence(&min_app_version).is_lt() {
        return Err(format!(
            "Module {} requires Amby {} or newer (current {})",
            manifest.id, manifest.min_app_version, current_app_version
        ));
    }
    if let Some(max_app_version) = &manifest.max_app_version {
        let max_app_version = parse_strict_version(max_app_version)
            .map_err(|error| format!("Invalid maxAppVersion: {error}"))?;
        if current_app_version.cmp_precedence(&max_app_version).is_gt() {
            return Err(format!(
                "Module {} supports Amby through {} (current {})",
                manifest.id, max_app_version, current_app_version
            ));
        }
    }

    if let Some(dependencies) = &manifest.dependencies {
        for (dependency_id, requirement) in dependencies {
            let module_dir = paths::confine_rel_no_symlinks(root, dependency_id)?;
            let versions_file = paths::confine_rel_no_symlinks(&module_dir, "versions.json")?;
            let meta = read_versions_meta(&versions_file, &module_dir)?.ok_or_else(|| {
                format!("Missing module dependency {dependency_id}@{requirement}")
            })?;
            let active_version = parse_strict_version(&meta.active_version)
                .map_err(|error| format!("Invalid active dependency version: {error}"))?;
            let active_dir = paths::confine_rel_no_symlinks(&module_dir, &meta.active_version)?;
            let dependency_manifest = validate_staged_package(&active_dir)?;
            if dependency_manifest.id != *dependency_id
                || dependency_manifest.version != meta.active_version
            {
                return Err("Dependency manifest does not match its installed identity".into());
            }
            let version_req = parse_dependency_requirement(requirement)?;
            if !version_req.matches(&active_version) {
                return Err(format!(
                    "Unsatisfied module dependency {dependency_id}@{requirement} (installed {})",
                    meta.active_version
                ));
            }
        }
    }
    Ok(())
}

fn read_versions_meta(
    versions_file: &Path,
    module_dir: &Path,
) -> Result<Option<ModuleVersionsMeta>, String> {
    let metadata = match fs::symlink_metadata(versions_file) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("Module versions metadata cannot be a symbolic link".to_string());
    }
    let content = fs::read_to_string(versions_file).map_err(|e| e.to_string())?;
    let meta = serde_json::from_str::<ModuleVersionsMeta>(&content)
        .map_err(|e| format!("Corrupt version history: {e}"))?;
    validate_versions_fields(&meta)?;
    for version in &meta.installed_versions {
        let version_dir = paths::confine_rel_no_symlinks(module_dir, version)?;
        if !version_dir.is_dir() {
            return Err(format!(
                "Installed module version directory does not exist: {version}"
            ));
        }
    }
    Ok(Some(meta))
}

fn validate_versions_fields(meta: &ModuleVersionsMeta) -> Result<(), String> {
    validate_module_version(&meta.active_version)?;
    if meta.installed_versions.is_empty() || !meta.installed_versions.contains(&meta.active_version)
    {
        return Err("Version history has no active installed version".into());
    }
    let mut unique = BTreeSet::new();
    for version in &meta.installed_versions {
        validate_module_version(version)?;
        if !unique.insert(version) {
            return Err("Duplicate installed module version".into());
        }
    }
    Ok(())
}

fn atomic_write_versions(versions_file: &Path, meta: &ModuleVersionsMeta) -> Result<(), String> {
    let meta_json = serde_json::to_string_pretty(meta).map_err(|e| e.to_string())?;
    frontmatter::atomic_write(versions_file, &meta_json)
}

pub fn publish_module(
    app: &tauri::AppHandle,
    staging_id: String,
    module_id: String,
    version: String,
) -> Result<PublishModuleResult, String> {
    let _guard = PACKAGE_GATE.lock().map_err(|error| error.to_string())?;
    publish_module_at(&modules_root(app)?, staging_id, module_id, version)
}

fn publish_module_at(
    root: &Path,
    staging_id: String,
    module_id: String,
    version: String,
) -> Result<PublishModuleResult, String> {
    publish_module_with_writer(root, staging_id, module_id, version, atomic_write_versions)
}

fn publish_module_with_writer(
    root: &Path,
    staging_id: String,
    module_id: String,
    version: String,
    write_meta: impl FnOnce(&Path, &ModuleVersionsMeta) -> Result<(), String>,
) -> Result<PublishModuleResult, String> {
    validate_staging_id(&staging_id)?;
    validate_module_id(&module_id)?;
    validate_module_version(&version)?;
    if let Some((recovered_staging_id, recovered)) = recover_pending_publish(root, &module_id)? {
        if recovered_staging_id == staging_id && recovered.installed_version == version {
            return Ok(recovered);
        }
    }
    let staging_parent = paths::confine_rel_no_symlinks(root, ".staging")?;
    let staging_dir = paths::confine_rel_no_symlinks(&staging_parent, &staging_id)?;
    if !staging_dir.is_dir() {
        return Err(format!("Staging directory not found: {staging_id}"));
    }
    let staged_manifest = validate_staged_package(&staging_dir)?;
    if staged_manifest.id != module_id || staged_manifest.version != version {
        return Err("Publish arguments do not match the staged package manifest".to_string());
    }
    validate_manifest_compatibility(root, &staged_manifest)?;

    let module_dir = paths::confine_rel_no_symlinks(root, &module_id)?;
    if module_dir.exists() {
        let metadata = fs::symlink_metadata(&module_dir).map_err(|e| e.to_string())?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(format!("Module path is not a directory: {module_id}"));
        }
    } else {
        fs::create_dir(&module_dir).map_err(|e| e.to_string())?;
    }
    let versions_file = paths::confine_rel_no_symlinks(&module_dir, "versions.json")?;
    let existing_meta = read_versions_meta(&versions_file, &module_dir)?;
    if existing_meta.is_none()
        && fs::read_dir(&module_dir)
            .map_err(|e| e.to_string())?
            .next()
            .is_some()
    {
        return Err(format!(
            "Module directory has no valid version history: {module_id}"
        ));
    }
    let target_dir = paths::confine_rel_no_symlinks(&module_dir, &version)?;
    if target_dir.exists() {
        return Err(format!(
            "Module version is already installed: {module_id}@{version}"
        ));
    }

    let mut versions_meta = existing_meta.clone().unwrap_or(ModuleVersionsMeta {
        active_version: version.clone(),
        installed_versions: Vec::new(),
    });
    let previous_version = if versions_meta.installed_versions.is_empty() {
        None
    } else if versions_meta.active_version != version {
        Some(versions_meta.active_version.clone())
    } else {
        None
    };
    if !versions_meta.installed_versions.contains(&version) {
        versions_meta.installed_versions.push(version.clone());
    }
    versions_meta.active_version = version.clone();

    let journal_path = paths::confine_rel_no_symlinks(&module_dir, "pending-publish.json")?;
    let journal = PendingModulePublish {
        format_version: 1,
        staging_id: staging_id.clone(),
        manifest: staged_manifest,
        previous_meta: existing_meta,
        next_meta: versions_meta.clone(),
    };
    frontmatter::atomic_write(
        &journal_path,
        &serde_json::to_string_pretty(&journal).map_err(|e| e.to_string())?,
    )?;
    // Both paths live on the same filesystem; do not fall back to a partially
    // visible recursive copy. PACKAGE_GATE serializes app callers and we reject
    // existing versions above, but pathname checks cannot exclude an external
    // process creating/swapping the target after that check (see paths.rs).
    fs::rename(&staging_dir, &target_dir).map_err(|error| error.to_string())?;
    if let Err(error) = write_meta(&versions_file, &versions_meta) {
        // Atomic writes can fail while syncing *after* publication. Retain the
        // complete version either way: deleting it could break active metadata.
        // Old versions remain available; report the ambiguous outcome honestly.
        return Err(format!(
            "Version files retained at {} after metadata write failure: {error}",
            target_dir.display()
        ));
    }

    fs::remove_file(&journal_path).map_err(|e| e.to_string())?;
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
    let _guard = PACKAGE_GATE.lock().map_err(|error| error.to_string())?;
    rollback_module_at(&modules_root(app)?, module_id)
}

fn rollback_module_at(root: &Path, module_id: String) -> Result<RollbackModuleResult, String> {
    validate_module_id(&module_id)?;
    recover_pending_publish(root, &module_id)?;
    let module_dir = paths::confine_rel_no_symlinks(root, &module_id)?;
    let versions_file = paths::confine_rel_no_symlinks(&module_dir, "versions.json")?;

    if !versions_file.is_file() {
        return Err(format!("Module {module_id} has no version history"));
    }

    let mut meta = read_versions_meta(&versions_file, &module_dir)?
        .ok_or_else(|| format!("Module {module_id} has no version history"))?;

    let current = meta.active_version.clone();
    let prev = meta
        .installed_versions
        .iter()
        .rev()
        .find(|v| **v != current)
        .cloned()
        .ok_or_else(|| format!("No previous version available for rollback of {module_id}"))?;

    let target_dir = paths::confine_rel_no_symlinks(&module_dir, &prev)?;
    if !target_dir.is_dir() {
        return Err(format!(
            "Rollback target version directory does not exist: {}",
            target_dir.display()
        ));
    }

    let manifest = validate_staged_package(&target_dir)?;
    if manifest.id != module_id || manifest.version != prev {
        return Err("Rollback target manifest does not match its installed path".to_string());
    }
    validate_manifest_compatibility(root, &manifest)?;
    meta.active_version = prev.clone();
    atomic_write_versions(&versions_file, &meta)?;

    Ok(RollbackModuleResult {
        success: true,
        module_id,
        rolled_back_to_version: prev,
        previous_version: current,
        active_install_path: target_dir.to_string_lossy().to_string(),
    })
}

pub fn uninstall_module(app: &tauri::AppHandle, module_id: String) -> Result<(), String> {
    let _guard = PACKAGE_GATE.lock().map_err(|error| error.to_string())?;
    uninstall_module_at(&modules_root(app)?, module_id)
}

fn uninstall_module_at(root: &Path, module_id: String) -> Result<(), String> {
    validate_module_id(&module_id)?;
    let module_dir = paths::confine_rel_no_symlinks(root, &module_id)?;
    if module_dir.exists() {
        let metadata = fs::symlink_metadata(&module_dir).map_err(|e| e.to_string())?;
        if metadata.file_type().is_symlink() {
            return Err("Refusing to uninstall a symbolic-link module directory".to_string());
        }
        fs::remove_dir_all(&module_dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn list_installed_modules(app: &tauri::AppHandle) -> Result<Vec<InstalledModuleInfo>, String> {
    let _guard = PACKAGE_GATE.lock().map_err(|error| error.to_string())?;
    list_installed_modules_at(&modules_root(app)?)
}

fn list_installed_modules_at(root: &Path) -> Result<Vec<InstalledModuleInfo>, String> {
    let mut result = Vec::new();
    for entry in fs::read_dir(root).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        if name == ".staging"
            || entry
                .file_type()
                .map_err(|error| error.to_string())?
                .is_file()
        {
            continue;
        }
        // Corrupt installations must not yield executable paths or recurse
        // through attacker-controlled aliases during size calculation.
        let info = installed_module_at(root, &name)?;
        result.push(info);
    }
    Ok(result)
}

pub fn get_module_entry_path(app: &tauri::AppHandle, module_id: String) -> Result<String, String> {
    let _guard = PACKAGE_GATE.lock().map_err(|error| error.to_string())?;
    get_module_entry_path_at(&modules_root(app)?, module_id)
}

fn get_module_entry_path_at(root: &Path, module_id: String) -> Result<String, String> {
    Ok(installed_module_at(root, &module_id)?.entry_path)
}

fn installed_module_at(root: &Path, module_id: &str) -> Result<InstalledModuleInfo, String> {
    validate_module_id(module_id)?;
    recover_pending_publish(root, module_id)?;
    let module_dir = paths::confine_rel_no_symlinks(root, module_id)?;
    let versions_file = paths::confine_rel_no_symlinks(&module_dir, "versions.json")?;
    let meta = read_versions_meta(&versions_file, &module_dir)?
        .ok_or_else(|| format!("Module {module_id} is not installed"))?;
    let active_dir = paths::confine_rel_no_symlinks(&module_dir, &meta.active_version)?;
    let manifest = validate_staged_package(&active_dir)?;
    if manifest.id != module_id || manifest.version != meta.active_version {
        return Err("Installed manifest does not match its module and version".into());
    }
    validate_manifest_compatibility(root, &manifest)?;
    let entry_path = paths::confine_rel_no_symlinks(&active_dir, &manifest.entry)?;
    Ok(InstalledModuleInfo {
        module_id: module_id.into(),
        active_version: meta.active_version,
        installed_versions: meta.installed_versions,
        install_path: active_dir.to_string_lossy().into(),
        entry_path: entry_path.to_string_lossy().into(),
        size_bytes: dir_size(&module_dir),
    })
}

fn dir_size(path: &Path) -> u64 {
    let mut size = 0;
    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            let p = entry.path();
            if let Ok(meta) = fs::symlink_metadata(&p) {
                if meta.is_dir() {
                    size += dir_size(&p);
                } else if meta.is_file() {
                    size += meta.len();
                }
            }
        }
    }
    size
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("amby-package-test-{}", ulid::Ulid::generate()));
            fs::create_dir(&root).unwrap();
            Self(root.canonicalize().unwrap())
        }
        fn stage(&self, version: &str) -> StagedPackageInfo {
            let (manifest, files) = payload(version);
            stage_module_at(&self.0, "client-hint".into(), manifest, files).unwrap()
        }
        fn publish(&self, version: &str) {
            let stage = self.stage(version);
            publish_module_at(
                &self.0,
                stage.staging_id,
                "example.plugin".into(),
                version.into(),
            )
            .unwrap();
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn payload(version: &str) -> (ModuleManifest, BTreeMap<String, String>) {
        let files: BTreeMap<String, String> = BTreeMap::from([(
            "lib/index.js".into(),
            format!("export const version = '{version}';"),
        )]);
        let manifest = ModuleManifest {
            format_version: 1,
            id: "example.plugin".into(),
            name: "Example".into(),
            version: version.into(),
            publisher: "Example".into(),
            kind: "community".into(),
            min_app_version: "0.1.5".into(),
            max_app_version: None,
            entry: "lib/index.js".into(),
            permissions: vec![],
            checksums: files
                .iter()
                .map(|(path, content)| (path.clone(), compute_sha256(content.as_bytes())))
                .collect(),
            signature: ModuleSignature {
                key_id: "".into(),
                sig: "".into(),
            },
            dependencies: None,
        };
        (manifest, files)
    }

    #[test]
    fn package_lifecycle_preserves_versions_and_resolves_verified_entry() {
        let root = Fixture::new();
        let first = root.stage("1.0.0");
        let second = root.stage("1.0.0");
        assert_ne!(first.staging_id, "client-hint");
        assert_ne!(first.staging_id, second.staging_id);
        publish_module_at(
            &root.0,
            first.staging_id,
            "example.plugin".into(),
            "1.0.0".into(),
        )
        .unwrap();
        let original =
            fs::read(get_module_entry_path_at(&root.0, "example.plugin".into()).unwrap()).unwrap();
        assert!(publish_module_at(
            &root.0,
            second.staging_id,
            "example.plugin".into(),
            "1.0.0".into()
        )
        .is_err());
        assert_eq!(
            fs::read(get_module_entry_path_at(&root.0, "example.plugin".into()).unwrap()).unwrap(),
            original
        );
        root.publish("1.1.0-beta.1+build");
        let info = list_installed_modules_at(&root.0).unwrap().remove(0);
        assert_eq!(info.installed_versions, ["1.0.0", "1.1.0-beta.1+build"]);
        assert_eq!(info.active_version, "1.1.0-beta.1+build");
        rollback_module_at(&root.0, "example.plugin".into()).unwrap();
        assert_eq!(
            fs::read(get_module_entry_path_at(&root.0, "example.plugin".into()).unwrap()).unwrap(),
            original
        );
        uninstall_module_at(&root.0, "example.plugin".into()).unwrap();
        assert!(list_installed_modules_at(&root.0).unwrap().is_empty());
    }

    #[test]
    fn invalid_identifiers_and_aliased_package_paths_are_rejected() {
        let root = Fixture::new();
        for bad in [
            "",
            "..",
            "../escape",
            "/absolute",
            "C:\\escape",
            "x/y",
            ".staging",
        ] {
            assert!(uninstall_module_at(&root.0, bad.into()).is_err(), "{bad}");
            assert!(rollback_module_at(&root.0, bad.into()).is_err(), "{bad}");
            assert!(
                get_module_entry_path_at(&root.0, bad.into()).is_err(),
                "{bad}"
            );
        }
        for bad in ["", "1", "1.2", "01.2.3", "../1.0.0", "1.0.0/child"] {
            assert!(validate_module_version(bad).is_err(), "{bad}");
        }
        for bad in [
            "a//b", "a/./b", "a/../b", "a/", "C:stream", "a\\b", "a/NUL.js", "a/file.", "a/file ",
        ] {
            assert!(validate_relative_package_path(bad).is_err(), "{bad}");
        }
        for invalid in ["éé", "0é0", "💥", "0g"] {
            assert!(hex_decode(invalid).is_err());
        }
    }

    #[test]
    fn staging_requires_exact_file_set_and_a_declared_entry() {
        let root = Fixture::new();
        let (manifest, mut files) = payload("1.0.0");
        files.insert("extra.js".into(), "extra".into());
        assert!(stage_module_at(&root.0, "hint".into(), manifest.clone(), files).is_err());
        let (_, files) = payload("1.0.0");
        let mut bad = manifest;
        bad.entry = "missing.js".into();
        assert!(stage_module_at(&root.0, "hint".into(), bad, files).is_err());
        assert!(fs::read_dir(&root.0).unwrap().next().is_none());
    }

    #[test]
    fn publish_revalidates_identity_and_staged_bytes_before_switching_version() {
        let root = Fixture::new();
        root.publish("1.0.0");
        let history = root.0.join("example.plugin/versions.json");
        let original = fs::read(&history).unwrap();
        let staged = root.stage("2.0.0");
        assert!(publish_module_at(
            &root.0,
            staged.staging_id.clone(),
            "different.plugin".into(),
            "2.0.0".into()
        )
        .is_err());
        fs::write(
            Path::new(&staged.staging_path).join("lib/index.js"),
            "changed",
        )
        .unwrap();
        assert!(publish_module_at(
            &root.0,
            staged.staging_id,
            "example.plugin".into(),
            "2.0.0".into()
        )
        .is_err());
        assert_eq!(fs::read(&history).unwrap(), original);
        assert!(!root.0.join("example.plugin/2.0.0").exists());
    }

    #[test]
    fn corrupted_history_and_entry_are_never_exposed_as_executable_paths() {
        let root = Fixture::new();
        root.publish("1.0.0");
        let entry = get_module_entry_path_at(&root.0, "example.plugin".into()).unwrap();
        fs::write(&entry, "tampered").unwrap();
        assert!(get_module_entry_path_at(&root.0, "example.plugin".into()).is_err());
        assert!(list_installed_modules_at(&root.0).is_err());
        let history = root.0.join("example.plugin/versions.json");
        let corrupt = br#"{"activeVersion":"../../outside","installedVersions":["../../outside"]}"#;
        fs::write(&history, corrupt).unwrap();
        assert!(get_module_entry_path_at(&root.0, "example.plugin".into()).is_err());
        assert!(rollback_module_at(&root.0, "example.plugin".into()).is_err());
        let stage = root.stage("2.0.0");
        assert!(publish_module_at(
            &root.0,
            stage.staging_id,
            "example.plugin".into(),
            "2.0.0".into()
        )
        .is_err());
        assert_eq!(fs::read(&history).unwrap(), corrupt);
    }

    #[test]
    fn first_install_can_retry_the_consumed_staging_handle_after_metadata_failure() {
        let root = Fixture::new();
        let stage = root.stage("1.0.0");
        assert!(publish_module_with_writer(
            &root.0,
            stage.staging_id.clone(),
            "example.plugin".into(),
            "1.0.0".into(),
            |_, _| Err("injected failure".into())
        )
        .is_err());
        assert!(!Path::new(&stage.staging_path).exists());
        publish_module_at(
            &root.0,
            stage.staging_id,
            "example.plugin".into(),
            "1.0.0".into(),
        )
        .unwrap();
        let info = list_installed_modules_at(&root.0).unwrap().remove(0);
        assert_eq!(info.active_version, "1.0.0");
        assert!(!root.0.join("example.plugin/pending-publish.json").exists());
    }

    #[test]
    fn recovery_rejects_a_tampered_publication_journal_without_rewriting_history() {
        let root = Fixture::new();
        root.publish("1.0.0");
        let history = root.0.join("example.plugin/versions.json");
        let before = fs::read(&history).unwrap();
        let stage = root.stage("2.0.0");
        assert!(publish_module_with_writer(
            &root.0,
            stage.staging_id,
            "example.plugin".into(),
            "2.0.0".into(),
            |_, _| Err("injected failure".into())
        )
        .is_err());
        let journal_path = root.0.join("example.plugin/pending-publish.json");
        let mut journal: PendingModulePublish =
            serde_json::from_slice(&fs::read(&journal_path).unwrap()).unwrap();
        journal.manifest.version = "../../outside".into();
        fs::write(&journal_path, serde_json::to_vec(&journal).unwrap()).unwrap();
        assert!(get_module_entry_path_at(&root.0, "example.plugin".into()).is_err());
        assert_eq!(fs::read(&history).unwrap(), before);
    }

    #[test]
    fn recovery_validates_previous_history_even_after_next_metadata_was_published() {
        let root = Fixture::new();
        root.publish("1.0.0");
        let stage = root.stage("2.0.0");
        assert!(publish_module_with_writer(
            &root.0,
            stage.staging_id,
            "example.plugin".into(),
            "2.0.0".into(),
            |path, meta| {
                atomic_write_versions(path, meta)?;
                Err("injected failure after metadata publication".into())
            }
        )
        .is_err());
        let history = root.0.join("example.plugin/versions.json");
        let before = fs::read(&history).unwrap();
        let path = root.0.join("example.plugin/pending-publish.json");
        let mut journal: PendingModulePublish =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        journal.previous_meta.as_mut().unwrap().active_version = "../../outside".into();
        fs::write(&path, serde_json::to_vec(&journal).unwrap()).unwrap();
        let before_journal = fs::read(&path).unwrap();
        assert!(get_module_entry_path_at(&root.0, "example.plugin".into()).is_err());
        assert_eq!(fs::read(&history).unwrap(), before);
        assert_eq!(fs::read(&path).unwrap(), before_journal);
    }

    #[test]
    fn failed_metadata_publication_retains_old_and_new_version_files() {
        for published in [false, true] {
            let root = Fixture::new();
            root.publish("1.0.0");
            let stage = root.stage("2.0.0");
            let result = publish_module_with_writer(
                &root.0,
                stage.staging_id,
                "example.plugin".into(),
                "2.0.0".into(),
                |path, meta| {
                    if published {
                        atomic_write_versions(path, meta)?;
                    }
                    Err("injected metadata write/sync failure".into())
                },
            );
            assert!(result.unwrap_err().contains("retained"));
            assert!(root.0.join("example.plugin/1.0.0/lib/index.js").is_file());
            assert!(root.0.join("example.plugin/2.0.0/lib/index.js").is_file());
            let entry = get_module_entry_path_at(&root.0, "example.plugin".into()).unwrap();
            assert!(entry.contains("2.0.0"));
            assert!(!root.0.join("example.plugin/pending-publish.json").exists());
        }
    }

    #[cfg(unix)]
    #[test]
    fn symlink_aliases_cannot_publish_read_rollback_or_delete_another_package() {
        use std::os::unix::fs::symlink;
        let root = Fixture::new();
        root.publish("1.0.0");
        let target = root.0.join("example.plugin");
        symlink(&target, root.0.join("alias.plugin")).unwrap();
        assert!(uninstall_module_at(&root.0, "alias.plugin".into()).is_err());
        assert!(get_module_entry_path_at(&root.0, "alias.plugin".into()).is_err());
        assert!(rollback_module_at(&root.0, "alias.plugin".into()).is_err());
        assert!(list_installed_modules_at(&root.0).is_err());
        assert!(target.join("1.0.0/lib/index.js").is_file());
        let stage = root.stage("2.0.0");
        let staging = root.0.join(".staging");
        symlink(&stage.staging_path, staging.join("alias")).unwrap();
        assert!(publish_module_at(
            &root.0,
            "alias".into(),
            "example.plugin".into(),
            "2.0.0".into()
        )
        .is_err());
        let entry = Path::new(&stage.staging_path).join("lib/index.js");
        fs::remove_file(&entry).unwrap();
        symlink(target.join("1.0.0/lib/index.js"), &entry).unwrap();
        assert!(publish_module_at(
            &root.0,
            stage.staging_id,
            "example.plugin".into(),
            "2.0.0".into()
        )
        .is_err());
    }

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

    #[derive(serde::Deserialize)]
    struct VersionCorpus {
        #[serde(rename = "validVersions")]
        valid_versions: Vec<String>,
        #[serde(rename = "invalidVersions")]
        invalid_versions: Vec<String>,
        comparisons: Vec<VersionComparison>,
        #[serde(rename = "minimumRequirements")]
        minimum_requirements: Vec<VersionRequirementCase>,
        ranges: Vec<VersionRequirementCase>,
        #[serde(rename = "invalidRequirements")]
        invalid_requirements: Vec<String>,
        #[serde(rename = "validModuleIds")]
        valid_module_ids: Vec<String>,
        #[serde(rename = "invalidModuleIds")]
        invalid_module_ids: Vec<String>,
    }

    #[derive(serde::Deserialize)]
    struct VersionComparison {
        left: String,
        right: String,
        order: i8,
    }

    #[derive(serde::Deserialize)]
    struct VersionRequirementCase {
        requirement: String,
        #[serde(rename = "satisfiedBy")]
        satisfied_by: Vec<String>,
        #[serde(rename = "rejectedBy")]
        rejected_by: Vec<String>,
    }

    #[test]
    fn semver_matches_shared_version_corpus() {
        let corpus: VersionCorpus =
            serde_json::from_str(include_str!("../../tests/fixtures/package-versions.json"))
                .unwrap();
        for id in corpus.valid_module_ids {
            assert!(validate_module_id(&id).is_ok(), "{id}");
        }
        for id in corpus.invalid_module_ids {
            assert!(validate_module_id(&id).is_err(), "{id}");
        }
        for version in corpus.valid_versions {
            assert!(parse_strict_version(&version).is_ok(), "{version}");
        }
        for version in corpus.invalid_versions {
            assert!(parse_strict_version(&version).is_err(), "{version}");
        }
        for comparison in corpus.comparisons {
            let left = semver::Version::parse(&comparison.left).unwrap();
            let right = semver::Version::parse(&comparison.right).unwrap();
            assert_eq!(left.cmp_precedence(&right) as i8, comparison.order);
        }
        for requirement_case in corpus.minimum_requirements.into_iter().chain(corpus.ranges) {
            let requirement = parse_dependency_requirement(&requirement_case.requirement).unwrap();
            for version in requirement_case.satisfied_by {
                assert!(requirement.matches(&semver::Version::parse(&version).unwrap()));
            }
            for version in requirement_case.rejected_by {
                assert!(!requirement.matches(&semver::Version::parse(&version).unwrap()));
            }
        }
        for requirement in corpus.invalid_requirements {
            assert!(
                parse_dependency_requirement(&requirement).is_err(),
                "{requirement}"
            );
        }
    }

    #[test]
    fn manifest_requirements_are_checked_at_the_backend_boundary() {
        let mut manifest = payload("1.0.0").0;
        manifest.min_app_version = "99.0.0".into();
        assert!(validate_manifest_compatibility(&Fixture::new().0, &manifest).is_err());

        let root = Fixture::new();
        root.publish("1.0.0");
        let mut dependent = payload("2.0.0").0;
        dependent.dependencies = Some(BTreeMap::from([("missing.module".into(), "1.0.0".into())]));
        assert!(validate_manifest_compatibility(&root.0, &dependent).is_err());
    }

    #[test]
    fn app_compatibility_ignores_build_metadata() {
        let root = Fixture::new();
        let mut manifest = payload("1.0.0").0;
        manifest.min_app_version = format!("{}+zzz", env!("CARGO_PKG_VERSION"));
        manifest.max_app_version = Some(format!("{}+aaa", env!("CARGO_PKG_VERSION")));
        validate_manifest_fields(&manifest).unwrap();
        validate_manifest_compatibility(&root.0, &manifest).unwrap();
    }

    #[test]
    fn compatibility_and_dependencies_guard_publication_rollback_and_entry() {
        let root = Fixture::new();
        let publish = |manifest: ModuleManifest, files: BTreeMap<String, String>| {
            let id = manifest.id.clone();
            let version = manifest.version.clone();
            let staged = stage_module_at(&root.0, "client".into(), manifest, files).unwrap();
            publish_module_at(&root.0, staged.staging_id, id, version)
        };
        let (mut incompatible, files) = payload("1.0.0");
        incompatible.min_app_version = "99.0.0".into();
        assert!(publish(incompatible, files).is_err());
        assert!(!root.0.join("example.plugin/versions.json").exists());

        root.publish("1.0.0");
        let (mut dependent, files) = payload("1.0.0");
        dependent.id = "dependent.plugin".into();
        dependent.dependencies = Some(BTreeMap::from([(
            "example.plugin".into(),
            ">=2.0.0 <3.0.0".into(),
        )]));
        assert!(publish(dependent.clone(), files.clone()).is_err());
        root.publish("2.0.0");
        publish(dependent, files).unwrap();
        assert!(get_module_entry_path_at(&root.0, "dependent.plugin".into()).is_ok());

        let (mut next, files) = payload("2.0.0");
        next.id = "dependent.plugin".into();
        publish(next, files).unwrap();
        rollback_module_at(&root.0, "example.plugin".into()).unwrap();
        // Rolling back the dependent would reactivate an unsatisfied requirement.
        assert!(rollback_module_at(&root.0, "dependent.plugin".into()).is_err());
        assert_eq!(
            installed_module_at(&root.0, "dependent.plugin")
                .unwrap()
                .active_version,
            "2.0.0"
        );

        root.publish("2.1.0");
        rollback_module_at(&root.0, "dependent.plugin".into()).unwrap();
        uninstall_module_at(&root.0, "example.plugin".into()).unwrap();
        assert!(get_module_entry_path_at(&root.0, "dependent.plugin".into()).is_err());
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
