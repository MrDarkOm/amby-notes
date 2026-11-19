use super::*;

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("amby-layout-{}", ulid::Ulid::generate()));
        fs::create_dir_all(root.join("Db/.ambd/templates")).unwrap();
        let database = "01J00000000000000000000000";
        let template = "01J00000000000000000000001";
        fs::write(root.join("Db/Db.json"), serde_json::to_vec(&json!({
            "format": "amby-database", "formatVersion": 1, "databaseId": database, "name": "Db",
            "properties": [], "viewOrder": [], "templateOrder": [template], "defaultTemplateId": template,
            "future": {"keep": true}
        })).unwrap()).unwrap();
        fs::write(root.join(format!("Db/.ambd/templates/{template}.json")), serde_json::to_vec(&json!({
            "format": "amby-database-template", "formatVersion": 1, "databaseId": database, "templateId": template,
            "name": "Template", "body": "## Body\n", "values": {}, "future": 42
        })).unwrap()).unwrap();
        fs::create_dir_all(root.join("Db/.ambd/assets/01J00000000000000000000002")).unwrap();
        fs::write(
            root.join("Db/.ambd/assets/01J00000000000000000000002/a.png"),
            b"image",
        )
        .unwrap();
        Self(root.canonicalize().unwrap())
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn scan_is_read_only_and_upgrade_preserves_templates_assets_and_unknown_data() {
    let fixture = Fixture::new();
    let path = fixture.0.join("Db/Db.json");
    let original = fs::read(&path).unwrap();
    assert_eq!(scan(&fixture.0).unwrap().pending_databases, 1);
    assert_eq!(fs::read(&path).unwrap(), original);
    assert_eq!(upgrade(&fixture.0).unwrap().pending_databases, 0);
    let manifest = parse_manifest(&fs::read(path).unwrap()).unwrap().value;
    assert_eq!(manifest.format_version, 2);
    assert_eq!(manifest.extra["future"]["keep"], true);
    let templates = manifest.templates().unwrap();
    assert_eq!(templates[0].body, "## Body\n");
    assert_eq!(templates[0].extra["future"], 42);
    assert_eq!(
        fs::read(fixture.0.join("Db/assets/01J00000000000000000000002/a.png")).unwrap(),
        b"image"
    );
    assert!(!fixture
        .0
        .join("Db/.ambd/templates/01J00000000000000000000001.json")
        .exists());
    assert!(upgrade(&fixture.0).is_ok());
    let journal = fs::read_dir(fixture.0.join(JOURNALS))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    assert_eq!(fs::read(journal.join("0.backup")).unwrap(), original);
}

#[test]
fn collision_rejects_the_whole_preflight_without_touching_sources() {
    let fixture = Fixture::new();
    let path = fixture.0.join("Db/Db.json");
    let original = fs::read(&path).unwrap();
    let destination = fixture.0.join("Db/assets/01J00000000000000000000002/a.png");
    fs::create_dir_all(destination.parent().unwrap()).unwrap();
    fs::write(&destination, b"different").unwrap();
    assert!(upgrade(&fixture.0).is_err());
    assert_eq!(fs::read(path).unwrap(), original);
    assert_eq!(fs::read(destination).unwrap(), b"different");
}

#[test]
fn preflight_keeps_unknown_numbers_exact_and_rejects_legacy_record_values() {
    let fixture = Fixture::new();
    let path = fixture.0.join("Db/Db.json");
    let original = fs::read_to_string(&path).unwrap();
    let changed = original.replacen('{', "{\"unknownDecimal\":0.10000000000000000000001,", 1);
    fs::write(&path, &changed).unwrap();
    assert!(upgrade(&fixture.0).is_err());
    assert_eq!(fs::read_to_string(&path).unwrap(), changed);
    fs::write(&path, original.as_bytes()).unwrap();
    fs::create_dir_all(fixture.0.join("Db/.ambd/records")).unwrap();
    fs::write(fixture.0.join("Db/.ambd/records/old.json"), b"legacy data").unwrap();
    assert!(upgrade(&fixture.0).is_err());
    assert_eq!(fs::read_to_string(path).unwrap(), original);
}

#[test]
fn interrupted_publication_can_be_rolled_back_but_a_later_external_edit_is_preserved() {
    let fixture = Fixture::new();
    let mut plan = plan(&fixture.0, &fixture.0.join("Db")).unwrap();
    let directory = fixture.0.join(JOURNALS).join("test");
    fs::create_dir_all(&directory).unwrap();
    for (index, bytes) in plan.originals.iter().enumerate() {
        let source = bytes.clone().unwrap_or_else(|| {
            fs::read(fixture.0.join(&plan.journal.files[index].source)).unwrap()
        });
        fs::write(directory.join(format!("{index}.backup")), source).unwrap();
    }
    fs::write(fixture.0.join("Db/Db.json"), &plan.updated).unwrap();
    rollback(&fixture.0, &directory, &mut plan.journal).unwrap();
    assert_eq!(
        fs::read(fixture.0.join("Db/Db.json")).unwrap(),
        plan.originals[0].as_ref().unwrap().clone()
    );
    fs::write(fixture.0.join("Db/Db.json"), b"external edit").unwrap();
    assert!(rollback(&fixture.0, &directory, &mut plan.journal).is_err());
    assert_eq!(
        fs::read(fixture.0.join("Db/Db.json")).unwrap(),
        b"external edit"
    );
}

#[test]
fn publication_failures_leave_the_original_or_a_complete_converted_database() {
    for nth in 1..=9 {
        let fixture = Fixture::new();
        let original = fs::read(fixture.0.join("Db/Db.json")).unwrap();
        frontmatter::inject_nth_atomic_write_failure(nth, false);
        let result = upgrade(&fixture.0);
        frontmatter::clear_atomic_write_failure();
        if result.is_err() {
            assert_eq!(
                fs::read(fixture.0.join("Db/Db.json")).unwrap(),
                original,
                "failure {nth}"
            );
        } else {
            assert_eq!(scan(&fixture.0).unwrap().pending_databases, 0);
        }
    }
}
