//! Pure validation for the durable database format.
//!
//! Validation never repairs input and never touches the filesystem. Unknown
//! fields and discriminants are represented by the format layer as opaque JSON;
//! they produce a warning so a caller can keep them visible without silently
//! dropping them.

use std::collections::{HashMap, HashSet};

use ulid::Ulid;

use super::format::{
    AggregateRule, DatabaseManifest, DatabaseTemplateFile, DatabaseViewFile, FieldRef, FileValue,
    FilterNode, GroupRule, PropertyDefinition, PropertyValue, RecordShard, SelectOption,
    StatusOption, YamlSyncBase,
};

pub const MAX_NAME_CHARS: usize = 512;
pub const MAX_TEXT_CHARS: usize = 1_000_000;
pub const MAX_PROPERTIES: usize = 256;
pub const MAX_OPTIONS_PER_PROPERTY: usize = 512;
pub const MAX_VIEWS: usize = 128;
pub const MAX_TEMPLATES: usize = 128;
pub const MAX_RECORD_VALUES: usize = 256;
pub const MAX_RELATION_TARGETS: usize = 1_024;
pub const MAX_MEDIA_ITEMS: usize = 256;
pub const MAX_FILTER_DEPTH: usize = 32;
pub const MAX_FILTER_CONDITIONS: usize = 256;
pub const MAX_FILTER_OPERAND_BYTES: usize = 64 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ValidationCode {
    InvalidFormat,
    InvalidUlid,
    EmptyValue,
    TooLong,
    LimitExceeded,
    DuplicateId,
    DuplicateName,
    InvalidMembership,
    UnsafePath,
    InvalidBinding,
    InvalidConfiguration,
    InvalidValue,
    InvalidDecimal,
    InvalidDate,
    InvalidUrl,
    WrongValueType,
    MissingReference,
    UnknownDiscriminant,
    UnsupportedLayout,
    UnknownLayoutConfig,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ValidationIssue {
    pub code: ValidationCode,
    pub path: String,
    pub message: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ValidationReport {
    pub errors: Vec<ValidationIssue>,
    pub warnings: Vec<ValidationIssue>,
    pub read_only: bool,
}

impl ValidationReport {
    pub fn is_valid(&self) -> bool {
        self.errors.is_empty()
    }

    pub fn is_writable(&self) -> bool {
        self.is_valid() && !self.read_only
    }

    fn error(&mut self, code: ValidationCode, path: impl Into<String>, message: impl Into<String>) {
        self.errors.push(ValidationIssue {
            code,
            path: path.into(),
            message: message.into(),
        });
    }

    fn warning(
        &mut self,
        code: ValidationCode,
        path: impl Into<String>,
        message: impl Into<String>,
    ) {
        self.warnings.push(ValidationIssue {
            code,
            path: path.into(),
            message: message.into(),
        });
    }

    fn read_only_warning(
        &mut self,
        code: ValidationCode,
        path: impl Into<String>,
        message: impl Into<String>,
    ) {
        self.warning(code, path, message);
        self.read_only = true;
    }

    fn merge(&mut self, other: ValidationReport) {
        self.errors.extend(other.errors);
        self.warnings.extend(other.warnings);
        self.read_only |= other.read_only;
    }
}

pub fn validate_manifest(manifest: &DatabaseManifest) -> ValidationReport {
    let mut report = ValidationReport::default();
    validate_header(
        &mut report,
        &manifest.format,
        manifest.format_version,
        "manifest",
    );
    validate_ulid(&mut report, &manifest.database_id, "databaseId");
    validate_name(&mut report, &manifest.name, "name");

    if manifest.membership.kind != "filesystem-descendants" || !manifest.membership.recursive {
        report.error(
            ValidationCode::InvalidMembership,
            "membership",
            "v1 membership must be recursive filesystem-descendants",
        );
    }
    if let Some(cover) = &manifest.cover {
        validate_cover(&mut report, cover);
    }

    if manifest.properties.len() > MAX_PROPERTIES {
        report.error(
            ValidationCode::LimitExceeded,
            "properties",
            format!("at most {MAX_PROPERTIES} properties are supported"),
        );
    }
    let mut property_ids = HashSet::new();
    let mut yaml_keys = HashMap::<String, String>::new();
    for (index, property) in manifest.properties.iter().enumerate() {
        let path = format!("properties[{index}]");
        if let Some(id) = property.id() {
            if !property_ids.insert(id) {
                report.error(
                    ValidationCode::DuplicateId,
                    format!("{path}.id"),
                    "property ID is repeated",
                );
            }
        }
        validate_property(&mut report, property, &path, &mut yaml_keys);
    }

    validate_id_list(&mut report, &manifest.view_order, "viewOrder", MAX_VIEWS);
    validate_id_list(
        &mut report,
        &manifest.template_order,
        "templateOrder",
        MAX_TEMPLATES,
    );
    if let Some(default) = &manifest.default_view_id {
        validate_ulid(&mut report, default, "defaultViewId");
        if !manifest.view_order.iter().any(|id| id == default) {
            report.error(
                ValidationCode::MissingReference,
                "defaultViewId",
                "default view must be listed in viewOrder",
            );
        }
    }
    if let Some(default) = &manifest.default_template_id {
        validate_ulid(&mut report, default, "defaultTemplateId");
        if !manifest.template_order.iter().any(|id| id == default) {
            report.error(
                ValidationCode::MissingReference,
                "defaultTemplateId",
                "default template must be listed in templateOrder",
            );
        }
    }
    report
}

pub fn validate_record(
    record: &RecordShard,
    manifest: Option<&DatabaseManifest>,
) -> ValidationReport {
    let mut report = ValidationReport::default();
    validate_header(&mut report, &record.format, record.format_version, "record");
    validate_ulid(&mut report, &record.database_id, "databaseId");
    validate_ulid(&mut report, &record.note_id, "noteId");
    if record.values.len() > MAX_RECORD_VALUES {
        report.error(
            ValidationCode::LimitExceeded,
            "values",
            format!("at most {MAX_RECORD_VALUES} values are supported"),
        );
    }

    let definitions = manifest.map(property_definitions);
    for (property_id, value) in &record.values {
        validate_ulid(&mut report, property_id, &format!("values.{property_id}"));
        match definitions
            .as_ref()
            .and_then(|map| map.get(property_id.as_str()))
        {
            Some(definition) => validate_property_value(
                &mut report,
                value,
                definition,
                &format!("values.{property_id}"),
            ),
            None if manifest.is_some() => report.warning(
                ValidationCode::MissingReference,
                format!("values.{property_id}"),
                "value references a missing property and is retained as a diagnostic",
            ),
            None => {
                validate_property_value_shape(&mut report, value, &format!("values.{property_id}"))
            }
        }
    }
    for (property_id, base) in &record.yaml_sync_bases {
        validate_ulid(
            &mut report,
            property_id,
            &format!("yamlSyncBases.{property_id}"),
        );
        if let YamlSyncBase::Value { value, .. } = base {
            if let Some(definition) = definitions
                .as_ref()
                .and_then(|map| map.get(property_id.as_str()))
            {
                validate_property_value(
                    &mut report,
                    value,
                    definition,
                    &format!("yamlSyncBases.{property_id}.value"),
                );
            }
        } else if matches!(base, YamlSyncBase::Opaque(_)) {
            report.warning(
                ValidationCode::UnknownDiscriminant,
                format!("yamlSyncBases.{property_id}"),
                "unknown YAML sync base is retained as opaque data",
            );
        }
    }
    report
}

pub fn validate_record_filename(record: &RecordShard, filename_stem: &str) -> ValidationReport {
    let mut report = ValidationReport::default();
    if record.note_id != filename_stem {
        report.error(
            ValidationCode::InvalidValue,
            "noteId",
            "record filename must match noteId",
        );
    }
    report
}

pub fn validate_view(
    view: &DatabaseViewFile,
    manifest: Option<&DatabaseManifest>,
) -> ValidationReport {
    let mut report = ValidationReport::default();
    validate_header(&mut report, &view.format, view.format_version, "view");
    validate_ulid(&mut report, &view.database_id, "databaseId");
    validate_ulid(&mut report, &view.view_id, "viewId");
    validate_name(&mut report, &view.name, "name");
    if !matches!(view.layout.as_str(), "table" | "board" | "list" | "gallery") {
        report.read_only_warning(
            ValidationCode::UnsupportedLayout,
            "layout",
            "unknown layout is retained read-only",
        );
    }
    match view.open_mode.as_str() {
        "sidePeek" | "centerPeek" | "fullPage" => {}
        // DB-10 briefly generated this alias. Keep those app-owned files
        // readable without rewriting user data; new creators use `sidePeek`.
        "inline" => report.warning(
            ValidationCode::InvalidConfiguration,
            "openMode",
            "legacy generated open mode is treated as sidePeek",
        ),
        _ => report.error(
            ValidationCode::InvalidConfiguration,
            "openMode",
            "unknown open mode",
        ),
    }
    if !matches!(view.subitems_mode.as_str(), "nested" | "flat") {
        report.error(
            ValidationCode::InvalidConfiguration,
            "subitemsMode",
            "unknown subitems mode",
        );
    }
    if let Some(density) = &view.density {
        match density.as_str() {
            "compact" | "default" | "tall" => {}
            // Same compatibility rule as `inline`: accept, preserve, and stop
            // generating the historical alias.
            "comfortable" => report.warning(
                ValidationCode::InvalidConfiguration,
                "density",
                "legacy generated density is treated as default",
            ),
            _ => report.error(
                ValidationCode::InvalidConfiguration,
                "density",
                "unknown density",
            ),
        }
    }
    if view.fields.is_empty() {
        report.error(
            ValidationCode::InvalidConfiguration,
            "fields",
            "a view must contain the Title field",
        );
    } else {
        validate_view_fields(&mut report, &view.fields, manifest);
    }
    if let Some(filter) = &view.filter {
        let mut count = 0;
        validate_filter(&mut report, filter, manifest, 0, &mut count, "filter");
    }
    for (index, sort) in view.sorts.iter().enumerate() {
        validate_field_ref(
            &mut report,
            &sort.field,
            manifest,
            &format!("sorts[{index}].field"),
        );
        if !matches!(sort.direction.as_str(), "asc" | "desc") {
            report.error(
                ValidationCode::InvalidConfiguration,
                format!("sorts[{index}].direction"),
                "direction must be asc or desc",
            );
        }
        if !matches!(sort.nulls.as_str(), "first" | "last") {
            report.error(
                ValidationCode::InvalidConfiguration,
                format!("sorts[{index}].nulls"),
                "null placement must be first or last",
            );
        }
    }
    if let Some(group) = &view.group {
        validate_group(&mut report, group, manifest);
    }
    for (index, aggregate) in view.aggregates.iter().enumerate() {
        validate_aggregate(
            &mut report,
            aggregate,
            manifest,
            &format!("aggregates[{index}]"),
        );
    }
    validate_id_list(&mut report, &view.manual_order, "manualOrder", usize::MAX);
    validate_layout_config(&mut report, &view.layout, &view.layout_config);
    report
}

pub fn validate_template(
    template: &DatabaseTemplateFile,
    manifest: Option<&DatabaseManifest>,
) -> ValidationReport {
    let mut report = ValidationReport::default();
    validate_header(
        &mut report,
        &template.format,
        template.format_version,
        "template",
    );
    validate_ulid(&mut report, &template.database_id, "databaseId");
    validate_ulid(&mut report, &template.template_id, "templateId");
    validate_name(&mut report, &template.name, "name");
    if template.body.len() > super::format::MAX_TEMPLATE_BYTES {
        report.error(
            ValidationCode::LimitExceeded,
            "body",
            "template body exceeds the JSON/template size limit",
        );
    }
    if template.body.starts_with("---") {
        report.error(
            ValidationCode::InvalidValue,
            "body",
            "template body must not contain frontmatter",
        );
    }
    let record = RecordShard {
        format: "amby-database-record".to_owned(),
        format_version: 1,
        database_id: template.database_id.clone(),
        note_id: "01J00000000000000000000000".to_owned(),
        values: template.values.clone(),
        yaml_sync_bases: Default::default(),
        extra: Default::default(),
    };
    report.merge(validate_record(&record, manifest));
    report
}

pub fn canonical_decimal(input: &str) -> Result<String, ValidationCode> {
    if input.is_empty() || input.trim() != input {
        return Err(ValidationCode::InvalidDecimal);
    }
    let (negative, unsigned) = match input.as_bytes().first() {
        Some(b'-') => (true, &input[1..]),
        Some(b'+') => (false, &input[1..]),
        _ => (false, input),
    };
    let (mantissa, exponent) = match unsigned.find(['e', 'E']) {
        Some(index) => (&unsigned[..index], parse_exponent(&unsigned[index + 1..])?),
        None => (unsigned, 0_i64),
    };
    let (whole, fraction) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    if whole.is_empty() && fraction.is_empty()
        || !whole.bytes().all(|byte| byte.is_ascii_digit())
        || !fraction.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(ValidationCode::InvalidDecimal);
    }
    let mut digits = format!("{whole}{fraction}");
    let mut decimal_at = i64::try_from(whole.len()).map_err(|_| ValidationCode::InvalidDecimal)?;
    decimal_at = decimal_at
        .checked_add(exponent)
        .ok_or(ValidationCode::InvalidDecimal)?;
    let first_non_zero = digits.bytes().position(|byte| byte != b'0');
    let Some(first_non_zero) = first_non_zero else {
        return Ok("0".to_owned());
    };
    digits.drain(..first_non_zero);
    decimal_at -= i64::try_from(first_non_zero).map_err(|_| ValidationCode::InvalidDecimal)?;
    if digits.len() > MAX_TEXT_CHARS
        || decimal_at < -(MAX_TEXT_CHARS as i64)
        || decimal_at > MAX_TEXT_CHARS as i64 + digits.len() as i64
    {
        return Err(ValidationCode::TooLong);
    }
    while digits.ends_with('0')
        && decimal_at > i64::try_from(digits.len()).map_err(|_| ValidationCode::InvalidDecimal)?
    {
        digits.pop();
    }
    let mut result = if decimal_at <= 0 {
        format!(
            "0.{}{}",
            "0".repeat(usize::try_from(-decimal_at).map_err(|_| ValidationCode::InvalidDecimal)?),
            digits
        )
    } else if decimal_at
        >= i64::try_from(digits.len()).map_err(|_| ValidationCode::InvalidDecimal)?
    {
        let length = i64::try_from(digits.len()).map_err(|_| ValidationCode::InvalidDecimal)?;
        format!(
            "{}{}",
            digits,
            "0".repeat(
                usize::try_from(decimal_at - length).map_err(|_| ValidationCode::InvalidDecimal)?
            )
        )
    } else {
        let index = usize::try_from(decimal_at).map_err(|_| ValidationCode::InvalidDecimal)?;
        format!("{}.{}", &digits[..index], &digits[index..])
    };
    if result.contains('.') {
        while result.ends_with('0') {
            result.pop();
        }
        if result.ends_with('.') {
            result.pop();
        }
    }
    if negative && result != "0" {
        result.insert(0, '-');
    }
    if result.len() > MAX_TEXT_CHARS {
        return Err(ValidationCode::TooLong);
    }
    Ok(result)
}

fn parse_exponent(value: &str) -> Result<i64, ValidationCode> {
    if value.is_empty() {
        return Err(ValidationCode::InvalidDecimal);
    }
    let (negative, digits) = match value.as_bytes().first() {
        Some(b'-') => (true, &value[1..]),
        Some(b'+') => (false, &value[1..]),
        _ => (false, value),
    };
    if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(ValidationCode::InvalidDecimal);
    }
    let parsed = digits
        .parse::<i64>()
        .map_err(|_| ValidationCode::InvalidDecimal)?;
    if negative {
        parsed.checked_neg().ok_or(ValidationCode::InvalidDecimal)
    } else {
        Ok(parsed)
    }
}

fn validate_header(report: &mut ValidationReport, format: &str, version: u64, path: &str) {
    let expected = match path {
        "manifest" => "amby-database",
        "record" => "amby-database-record",
        "view" => "amby-database-view",
        "template" => "amby-database-template",
        _ => "",
    };
    if format != expected {
        report.error(
            ValidationCode::InvalidFormat,
            format!("{path}.format"),
            format!("expected {expected}"),
        );
    }
    if version != 1 {
        report.error(
            ValidationCode::InvalidFormat,
            format!("{path}.formatVersion"),
            "unsupported format version",
        );
    }
}

fn validate_ulid(report: &mut ValidationReport, value: &str, path: &str) {
    if Ulid::from_string(value)
        .map(|id| id.to_string() == value)
        .unwrap_or(false)
    {
        return;
    }
    report.error(
        ValidationCode::InvalidUlid,
        path,
        "expected a canonical uppercase ULID",
    );
}

fn validate_name(report: &mut ValidationReport, value: &str, path: &str) {
    if value.is_empty() {
        report.error(ValidationCode::EmptyValue, path, "name must not be empty");
    }
    if value.chars().count() > MAX_NAME_CHARS {
        report.error(ValidationCode::TooLong, path, "name is too long");
    }
}

fn validate_cover(report: &mut ValidationReport, cover: &super::format::DatabaseCover) {
    if cover.kind != "asset" {
        report.error(
            ValidationCode::InvalidValue,
            "cover.kind",
            "cover kind must be asset",
        );
    }
    validate_ulid(report, &cover.asset_id, "cover.assetId");
    validate_relative_asset_path(
        report,
        &cover.relative_path,
        "cover.relativePath",
        ".ambd/assets/",
    );
    if cover.mime_type.is_empty() {
        report.error(
            ValidationCode::EmptyValue,
            "cover.mimeType",
            "MIME type must not be empty",
        );
    }
}

fn validate_id_list(report: &mut ValidationReport, values: &[String], path: &str, limit: usize) {
    if values.len() > limit {
        report.error(ValidationCode::LimitExceeded, path, "too many IDs");
    }
    let mut seen = HashSet::new();
    for (index, value) in values.iter().enumerate() {
        validate_ulid(report, value, &format!("{path}[{index}]"));
        if !seen.insert(value) {
            report.error(
                ValidationCode::DuplicateId,
                format!("{path}[{index}]"),
                "ID is repeated",
            );
        }
    }
}

fn validate_property(
    report: &mut ValidationReport,
    property: &PropertyDefinition,
    path: &str,
    yaml_keys: &mut HashMap<String, String>,
) {
    macro_rules! common {
        ($fields:expr, $kind:expr) => {{
            validate_ulid(report, &$fields.id, &format!("{path}.id"));
            validate_name(report, &$fields.name, &format!("{path}.name"));
            if !matches!(
                $fields.page_visibility.as_str(),
                "alwaysShow" | "hideWhenEmpty" | "alwaysHide"
            ) {
                report.error(
                    ValidationCode::InvalidConfiguration,
                    format!("{path}.pageVisibility"),
                    "unknown page visibility",
                );
            }
            if let Some(binding) = &$fields.yaml_binding {
                if binding.direction != "twoWay"
                    || binding.key.is_empty()
                    || binding.key == "amby-id"
                {
                    report.error(
                        ValidationCode::InvalidBinding,
                        format!("{path}.yamlBinding"),
                        "invalid YAML binding",
                    );
                }
                if let Some(previous) = yaml_keys.insert(binding.key.clone(), $fields.id.clone()) {
                    if previous != $fields.id {
                        report.error(
                            ValidationCode::DuplicateName,
                            format!("{path}.yamlBinding.key"),
                            "two properties bind the same YAML key",
                        );
                    }
                }
                if !matches!(
                    $kind,
                    "text"
                        | "number"
                        | "checkbox"
                        | "date"
                        | "select"
                        | "multiSelect"
                        | "status"
                        | "url"
                ) {
                    report.error(
                        ValidationCode::InvalidBinding,
                        format!("{path}.yamlBinding"),
                        "this property type cannot bind to YAML",
                    );
                }
            }
        }};
    }
    match property {
        PropertyDefinition::Text(fields) => common!(fields, "text"),
        PropertyDefinition::Number(fields) => {
            common!(fields, "number");
            if !matches!(
                fields.config.format.as_str(),
                "number" | "percent" | "currency"
            ) {
                report.error(
                    ValidationCode::InvalidConfiguration,
                    format!("{path}.config.format"),
                    "unknown number format",
                );
            }
            if fields.config.format == "currency"
                && fields.config.currency.as_deref().unwrap_or("").is_empty()
            {
                report.error(
                    ValidationCode::InvalidConfiguration,
                    format!("{path}.config.currency"),
                    "currency format requires a currency code",
                );
            }
        }
        PropertyDefinition::Checkbox(fields) => common!(fields, "checkbox"),
        PropertyDefinition::Date(fields) => common!(fields, "date"),
        PropertyDefinition::Select(fields) => {
            common!(fields, "select");
            validate_select_options(report, &fields.config.options, path);
        }
        PropertyDefinition::MultiSelect(fields) => {
            common!(fields, "multiSelect");
            validate_select_options(report, &fields.config.options, path);
        }
        PropertyDefinition::Status(fields) => {
            common!(fields, "status");
            if fields.config.options.len() > MAX_OPTIONS_PER_PROPERTY {
                report.error(
                    ValidationCode::LimitExceeded,
                    format!("{path}.config.options"),
                    "too many options",
                );
            }
            validate_options(report, &fields.config.options, path, |option| {
                matches!(option.group.as_str(), "notStarted" | "inProgress" | "done")
            });
        }
        PropertyDefinition::Url(fields) => common!(fields, "url"),
        PropertyDefinition::Files(fields) => {
            common!(fields, "files");
            if fields.config.max_items == Some(0) {
                report.error(
                    ValidationCode::InvalidConfiguration,
                    format!("{path}.config.maxItems"),
                    "maxItems must be positive or null",
                );
            }
        }
        PropertyDefinition::Relation(fields) => {
            common!(fields, "relation");
            validate_ulid(
                report,
                &fields.config.target_database_id,
                &format!("{path}.config.targetDatabaseId"),
            );
            if fields.config.max_items.is_some_and(|value| value != 1) {
                report.error(
                    ValidationCode::InvalidConfiguration,
                    format!("{path}.config.maxItems"),
                    "relation maxItems must be 1 or null",
                );
            }
            if let Some(inverse) = &fields.config.inverse_property_id {
                validate_ulid(report, inverse, &format!("{path}.config.inversePropertyId"));
            }
        }
        PropertyDefinition::Opaque(_) => report.warning(
            ValidationCode::UnknownDiscriminant,
            path,
            "unknown property definition is retained as opaque data",
        ),
    }
}

fn validate_select_options(report: &mut ValidationReport, options: &[SelectOption], path: &str) {
    if options.len() > MAX_OPTIONS_PER_PROPERTY {
        report.error(
            ValidationCode::LimitExceeded,
            format!("{path}.config.options"),
            "too many options",
        );
    }
    validate_options(report, options, path, |_| true);
}

fn validate_options<T, F>(report: &mut ValidationReport, options: &[T], path: &str, valid: F)
where
    T: OptionLike,
    F: Fn(&T) -> bool,
{
    let mut ids = HashSet::new();
    let mut names = HashSet::new();
    for (index, option) in options.iter().enumerate() {
        validate_ulid(
            report,
            option.id(),
            &format!("{path}.config.options[{index}].id"),
        );
        validate_name(
            report,
            option.name(),
            &format!("{path}.config.options[{index}].name"),
        );
        if !ids.insert(option.id()) {
            report.error(
                ValidationCode::DuplicateId,
                format!("{path}.config.options[{index}].id"),
                "option ID is repeated",
            );
        }
        if !names.insert(option.name()) {
            report.error(
                ValidationCode::DuplicateName,
                format!("{path}.config.options[{index}].name"),
                "option name is repeated",
            );
        }
        if option.color().is_empty() {
            report.error(
                ValidationCode::EmptyValue,
                format!("{path}.config.options[{index}].color"),
                "option color must not be empty",
            );
        }
        if !valid(option) {
            report.error(
                ValidationCode::InvalidConfiguration,
                format!("{path}.config.options[{index}].group"),
                "unknown status group",
            );
        }
    }
}

trait OptionLike {
    fn id(&self) -> &str;
    fn name(&self) -> &str;
    fn color(&self) -> &str;
}
impl OptionLike for SelectOption {
    fn id(&self) -> &str {
        &self.id
    }
    fn name(&self) -> &str {
        &self.name
    }
    fn color(&self) -> &str {
        &self.color
    }
}
impl OptionLike for StatusOption {
    fn id(&self) -> &str {
        &self.id
    }
    fn name(&self) -> &str {
        &self.name
    }
    fn color(&self) -> &str {
        &self.color
    }
}

fn property_definitions(manifest: &DatabaseManifest) -> HashMap<&str, &PropertyDefinition> {
    manifest
        .properties
        .iter()
        .filter_map(|property| property.id().map(|id| (id, property)))
        .collect()
}

fn validate_property_value(
    report: &mut ValidationReport,
    value: &PropertyValue,
    definition: &PropertyDefinition,
    path: &str,
) {
    let expected = definition.kind();
    let actual = value.kind();
    if actual != expected {
        report.error(
            ValidationCode::WrongValueType,
            path,
            format!("value type {actual} does not match property type {expected}"),
        );
        return;
    }
    validate_property_value_shape(report, value, path);
    match (definition, value) {
        (PropertyDefinition::Number(_), PropertyValue::Number { decimal, .. })
            if canonical_decimal(decimal).is_err() =>
        {
            report.error(
                ValidationCode::InvalidDecimal,
                path,
                "number must be a canonical decimal string",
            );
        }
        (
            PropertyDefinition::Date(fields),
            PropertyValue::Date {
                start,
                end,
                time_zone,
                ..
            },
        ) => validate_date_value(
            report,
            start,
            end.as_deref(),
            time_zone.as_deref(),
            fields.config.include_time,
            fields.config.allow_range,
            path,
        ),
        (PropertyDefinition::Select(fields), PropertyValue::Select { option_id, .. }) => {
            validate_option_reference(report, option_id, &fields.config.options, path)
        }
        (
            PropertyDefinition::MultiSelect(fields),
            PropertyValue::MultiSelect { option_ids, .. },
        ) => validate_option_ids(report, option_ids, &fields.config.options, path),
        (PropertyDefinition::Status(fields), PropertyValue::Status { option_id, .. }) => {
            validate_option_reference(report, option_id, &fields.config.options, path)
        }
        (
            PropertyDefinition::Relation(fields),
            PropertyValue::Relation {
                target_note_ids, ..
            },
        ) => {
            if target_note_ids.len() > MAX_RELATION_TARGETS
                || fields
                    .config
                    .max_items
                    .is_some_and(|max| target_note_ids.len() > usize::from(max))
            {
                report.error(
                    ValidationCode::LimitExceeded,
                    path,
                    "too many relation targets",
                );
            }
            validate_unique_ulids(report, target_note_ids, path);
        }
        _ => {}
    }
}

fn validate_property_value_shape(report: &mut ValidationReport, value: &PropertyValue, path: &str) {
    match value {
        PropertyValue::Text { value, .. } if value.chars().count() > MAX_TEXT_CHARS => {
            report.error(ValidationCode::TooLong, path, "value is too long");
        }
        PropertyValue::Url { value, .. } => {
            if value.chars().count() > MAX_TEXT_CHARS {
                report.error(ValidationCode::TooLong, path, "value is too long");
            }
            if !is_valid_url(value) {
                report.error(
                    ValidationCode::InvalidUrl,
                    path,
                    "URL must contain a valid non-empty scheme",
                );
            }
        }
        PropertyValue::MultiSelect { option_ids, .. } => {
            validate_unique_ulids(report, option_ids, path)
        }
        PropertyValue::Relation {
            target_note_ids, ..
        } => validate_unique_ulids(report, target_note_ids, path),
        PropertyValue::Files { items, .. } => {
            if items.len() > MAX_MEDIA_ITEMS {
                report.error(ValidationCode::LimitExceeded, path, "too many media items");
            }
            for (index, item) in items.iter().enumerate() {
                validate_file_value(report, item, &format!("{path}.items[{index}]"));
            }
        }
        PropertyValue::Opaque(_) => report.warning(
            ValidationCode::UnknownDiscriminant,
            path,
            "unknown property value is retained as opaque data",
        ),
        _ => {}
    }
}

fn is_valid_url(value: &str) -> bool {
    if value.is_empty() || value.chars().any(char::is_whitespace) {
        return false;
    }
    let Some((scheme, rest)) = value.split_once(':') else {
        return false;
    };
    !scheme.is_empty()
        && scheme.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphabetic()
                || index > 0 && (byte.is_ascii_digit() || matches!(byte, b'+' | b'-' | b'.'))
        })
        && !rest.is_empty()
}

fn validate_file_value(report: &mut ValidationReport, value: &FileValue, path: &str) {
    validate_ulid(report, &value.asset_id, &format!("{path}.assetId"));
    if value.kind != "asset" {
        report.error(
            ValidationCode::InvalidValue,
            format!("{path}.kind"),
            "file kind must be asset",
        );
    }
    validate_relative_asset_path(
        report,
        &value.relative_path,
        &format!("{path}.relativePath"),
        "assets/",
    );
    validate_name(report, &value.name, &format!("{path}.name"));
    if value.mime_type.is_empty() {
        report.error(
            ValidationCode::EmptyValue,
            format!("{path}.mimeType"),
            "MIME type must not be empty",
        );
    }
}

fn validate_relative_asset_path(
    report: &mut ValidationReport,
    path: &str,
    field: &str,
    required_prefix: &str,
) {
    let unsafe_path = path.is_empty()
        || path.starts_with('/')
        || path.starts_with('\\')
        || path.contains('\\')
        || path.contains("://")
        || path
            .split('/')
            .any(|segment| segment.is_empty() || segment == ".." || segment == ".")
        || path.as_bytes().get(1) == Some(&b':')
        || !path.starts_with(required_prefix);
    if unsafe_path {
        report.error(
            ValidationCode::UnsafePath,
            field,
            "asset path must stay inside the database asset directory",
        );
    }
}

fn validate_unique_ulids(report: &mut ValidationReport, values: &[String], path: &str) {
    let mut seen = HashSet::new();
    for (index, value) in values.iter().enumerate() {
        validate_ulid(report, value, &format!("{path}[{index}]"));
        if !seen.insert(value) {
            report.error(
                ValidationCode::DuplicateId,
                format!("{path}[{index}]"),
                "ID is repeated",
            );
        }
    }
}

fn validate_option_reference<T: OptionLike>(
    report: &mut ValidationReport,
    value: &str,
    options: &[T],
    path: &str,
) {
    if !options.iter().any(|option| option.id() == value) {
        report.warning(
            ValidationCode::MissingReference,
            path,
            "missing option is retained as a diagnostic value",
        );
    }
}

fn validate_option_ids<T: OptionLike>(
    report: &mut ValidationReport,
    values: &[String],
    options: &[T],
    path: &str,
) {
    validate_unique_ulids(report, values, path);
    for value in values {
        validate_option_reference(report, value, options, path);
    }
}

fn validate_date_value(
    report: &mut ValidationReport,
    start: &str,
    end: Option<&str>,
    time_zone: Option<&str>,
    include_time: bool,
    allow_range: bool,
    path: &str,
) {
    let start_value = if include_time {
        parse_datetime(start)
    } else {
        parse_date(start).map(DateValue::Date)
    };
    let Some(start_value) = start_value else {
        report.error(ValidationCode::InvalidDate, path, "invalid date value");
        return;
    };
    if time_zone.is_some_and(|zone| zone.is_empty() || zone.chars().any(char::is_whitespace)) {
        report.error(ValidationCode::InvalidDate, path, "invalid IANA timezone");
    }
    if let Some(end) = end {
        if !allow_range {
            report.error(
                ValidationCode::InvalidDate,
                path,
                "date range is disabled for this property",
            );
        }
        let end_value = if include_time {
            parse_datetime(end)
        } else {
            parse_date(end).map(DateValue::Date)
        };
        let Some(end_value) = end_value else {
            report.error(ValidationCode::InvalidDate, path, "invalid date range end");
            return;
        };
        if end_value < start_value {
            report.error(
                ValidationCode::InvalidDate,
                path,
                "date range end precedes start",
            );
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum DateValue {
    Date((i32, u32, u32)),
    Instant(i64, u32),
}

fn parse_date(value: &str) -> Option<(i32, u32, u32)> {
    if value.len() != 10
        || !value.as_bytes().iter().all(u8::is_ascii)
        || value.as_bytes().get(4) != Some(&b'-')
        || value.as_bytes().get(7) != Some(&b'-')
    {
        return None;
    }
    let year = value[0..4].parse().ok()?;
    let month = value[5..7].parse().ok()?;
    let day = value[8..10].parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=days_in_month(year, month)).contains(&day) {
        return None;
    }
    Some((year, month, day))
}

fn parse_datetime(value: &str) -> Option<DateValue> {
    if value.len() < 20
        || !value.as_bytes().get(..19)?.iter().all(u8::is_ascii)
        || value.as_bytes().get(10) != Some(&b'T')
        || value.as_bytes().get(13) != Some(&b':')
        || value.as_bytes().get(16) != Some(&b':')
    {
        return None;
    }
    let date = parse_date(&value[..10])?;
    let hour: i64 = value[11..13].parse().ok()?;
    let minute: i64 = value[14..16].parse().ok()?;
    let second: i64 = value[17..19].parse().ok()?;
    if hour > 23 || minute > 59 || second > 59 {
        return None;
    }
    let mut index = 19;
    let mut nanos = 0_u32;
    if value.as_bytes().get(index) == Some(&b'.') {
        index += 1;
        let start = index;
        while value.as_bytes().get(index).is_some_and(u8::is_ascii_digit) {
            index += 1;
        }
        if index == start || index - start > 9 {
            return None;
        }
        let mut fraction = value[start..index].to_owned();
        while fraction.len() < 9 {
            fraction.push('0');
        }
        nanos = fraction.parse().ok()?;
    }
    let offset = match value.as_bytes().get(index) {
        Some(b'Z') if index + 1 == value.len() => 0_i64,
        Some(sign @ (b'+' | b'-'))
            if index + 6 == value.len() && value.as_bytes().get(index + 3) == Some(&b':') =>
        {
            let hours: i64 = value[index + 1..index + 3].parse().ok()?;
            let minutes: i64 = value[index + 4..index + 6].parse().ok()?;
            if hours > 23 || minutes > 59 {
                return None;
            }
            let seconds = hours * 3600 + minutes * 60;
            if *sign == b'-' {
                -seconds
            } else {
                seconds
            }
        }
        _ => return None,
    };
    let days = days_from_civil(date.0, date.1, date.2);
    Some(DateValue::Instant(
        days * 86_400 + hour * 3_600 + minute * 60 + second - offset,
        nanos,
    ))
}

fn days_in_month(year: i32, month: u32) -> u32 {
    match month {
        2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

fn days_from_civil(year: i32, month: u32, day: u32) -> i64 {
    let year = i64::from(year) - i64::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month = i64::from(month);
    let day_of_year = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + i64::from(day) - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146097 + day_of_era - 719468
}

fn validate_view_fields(
    report: &mut ValidationReport,
    fields: &[super::format::ViewField],
    manifest: Option<&DatabaseManifest>,
) {
    let first = &fields[0].field;
    let legacy_flat_title = matches!(first, FieldRef::Opaque(serde_json::Value::String(field)) if field == "title")
        && fields[0]
            .extra
            .get("kind")
            .and_then(serde_json::Value::as_str)
            == Some("system");
    if !matches!(first, FieldRef::System { field, .. } if field == "title") && !legacy_flat_title {
        report.error(
            ValidationCode::InvalidConfiguration,
            "fields[0]",
            "Title must be the first field",
        );
    }
    if !fields[0].visible || !fields[0].frozen {
        report.error(
            ValidationCode::InvalidConfiguration,
            "fields[0]",
            "Title must be visible and frozen",
        );
    }
    let mut seen = HashSet::new();
    for (index, field) in fields.iter().enumerate() {
        validate_field_ref(
            report,
            &field.field,
            manifest,
            &format!("fields[{index}].field"),
        );
        let key = serde_json::to_string(&field.field).unwrap_or_default();
        if !seen.insert(key) {
            report.warning(
                ValidationCode::DuplicateId,
                format!("fields[{index}]"),
                "field is repeated",
            );
        }
        if field
            .width
            .is_some_and(|width| !(40..=2_000).contains(&width))
        {
            report.error(
                ValidationCode::InvalidConfiguration,
                format!("fields[{index}].width"),
                "field width is out of range",
            );
        }
    }
}

fn validate_field_ref(
    report: &mut ValidationReport,
    field: &FieldRef,
    manifest: Option<&DatabaseManifest>,
    path: &str,
) {
    match field {
        FieldRef::System { field, .. }
            if matches!(
                field.as_str(),
                "title"
                    | "created"
                    | "modified"
                    | "path"
                    | "tags"
                    | "backlinks"
                    | "wordCount"
                    | "parent"
                    | "subitems"
            ) => {}
        FieldRef::System { .. } => report.error(
            ValidationCode::MissingReference,
            path,
            "unknown system field",
        ),
        FieldRef::Property { property_id, .. } => {
            validate_ulid(report, property_id, &format!("{path}.propertyId"));
            if manifest.is_some_and(|manifest| {
                !manifest
                    .properties
                    .iter()
                    .any(|property| property.id() == Some(property_id))
            }) {
                report.warning(
                    ValidationCode::MissingReference,
                    path,
                    "missing property reference is retained",
                );
            }
        }
        FieldRef::Opaque(_) => report.warning(
            ValidationCode::UnknownDiscriminant,
            path,
            "unknown field reference is retained as opaque data",
        ),
    }
}

fn validate_filter(
    report: &mut ValidationReport,
    node: &FilterNode,
    manifest: Option<&DatabaseManifest>,
    depth: usize,
    count: &mut usize,
    path: &str,
) {
    if depth > MAX_FILTER_DEPTH {
        report.error(
            ValidationCode::LimitExceeded,
            path,
            "filter AST is too deep",
        );
        return;
    }
    match node {
        FilterNode::Group {
            operator, children, ..
        } => {
            if !matches!(operator.as_str(), "and" | "or") {
                report.error(
                    ValidationCode::InvalidConfiguration,
                    format!("{path}.operator"),
                    "filter group operator must be and/or",
                );
            }
            if children.is_empty() {
                report.error(
                    ValidationCode::InvalidConfiguration,
                    format!("{path}.children"),
                    "filter group must not be empty",
                );
            }
            for (index, child) in children.iter().enumerate() {
                validate_filter(
                    report,
                    child,
                    manifest,
                    depth + 1,
                    count,
                    &format!("{path}.children[{index}]"),
                );
            }
        }
        FilterNode::Condition {
            field,
            operator,
            value,
            ..
        } => {
            *count += 1;
            if *count > MAX_FILTER_CONDITIONS {
                report.error(
                    ValidationCode::LimitExceeded,
                    path,
                    "too many filter conditions",
                );
                return;
            }
            validate_field_ref(report, field, manifest, &format!("{path}.field"));
            if let Some(value) = value {
                if serde_json::to_vec(value)
                    .map(|bytes| bytes.len() > MAX_FILTER_OPERAND_BYTES)
                    .unwrap_or(true)
                {
                    report.error(
                        ValidationCode::LimitExceeded,
                        format!("{path}.value"),
                        "filter operand is too large",
                    );
                }
            }
            if let Some(kind) = field_kind(field, manifest) {
                if !operator_allowed(kind, operator) {
                    report.error(
                        ValidationCode::InvalidConfiguration,
                        format!("{path}.operator"),
                        "operator is not valid for this field type",
                    );
                }
            }
        }
        FilterNode::Opaque(_) => report.warning(
            ValidationCode::UnknownDiscriminant,
            path,
            "unknown filter node is retained as opaque data",
        ),
    }
}

fn field_kind<'a>(field: &'a FieldRef, manifest: Option<&'a DatabaseManifest>) -> Option<&'a str> {
    let FieldRef::Property { property_id, .. } = field else {
        return Some("system");
    };
    manifest?
        .properties
        .iter()
        .find(|property| property.id() == Some(property_id))
        .map(PropertyDefinition::kind)
}

fn operator_allowed(kind: &str, operator: &str) -> bool {
    match kind {
        "text" | "url" => matches!(
            operator,
            "is" | "isNot" | "contains" | "startsWith" | "isEmpty" | "isNotEmpty"
        ),
        "number" | "date" => matches!(
            operator,
            "equals" | "notEquals" | "gt" | "gte" | "lt" | "lte" | "isEmpty" | "isNotEmpty"
        ),
        "checkbox" => matches!(operator, "is" | "isNot" | "isEmpty" | "isNotEmpty"),
        "select" | "status" | "multiSelect" | "relation" | "files" => matches!(
            operator,
            "is" | "isNot" | "contains" | "isEmpty" | "isNotEmpty"
        ),
        "system" => matches!(
            operator,
            "is" | "isNot"
                | "contains"
                | "startsWith"
                | "isEmpty"
                | "isNotEmpty"
                | "equals"
                | "notEquals"
                | "gt"
                | "gte"
                | "lt"
                | "lte"
        ),
        _ => true,
    }
}

fn validate_group(
    report: &mut ValidationReport,
    group: &GroupRule,
    manifest: Option<&DatabaseManifest>,
) {
    validate_field_ref(report, &group.field, manifest, "group.field");
    if let FieldRef::Property { property_id, .. } = &group.field {
        if let Some(property) = manifest.and_then(|manifest| {
            manifest
                .properties
                .iter()
                .find(|property| property.id() == Some(property_id))
        }) {
            if !matches!(property.kind(), "select" | "status") {
                report.error(
                    ValidationCode::InvalidConfiguration,
                    "group.field",
                    "only Select or Status can group a view",
                );
            }
        }
    } else {
        report.error(
            ValidationCode::InvalidConfiguration,
            "group.field",
            "group must reference a Select or Status property",
        );
    }
}

fn validate_aggregate(
    report: &mut ValidationReport,
    aggregate: &AggregateRule,
    manifest: Option<&DatabaseManifest>,
    path: &str,
) {
    validate_field_ref(report, &aggregate.field, manifest, &format!("{path}.field"));
    if !matches!(
        aggregate.function.as_str(),
        "count" | "sum" | "average" | "min" | "max"
    ) {
        report.error(
            ValidationCode::InvalidConfiguration,
            format!("{path}.function"),
            "unknown aggregate function",
        );
    }
}

fn validate_layout_config(report: &mut ValidationReport, layout: &str, config: &serde_json::Value) {
    let Some(object) = config.as_object() else {
        report.read_only_warning(
            ValidationCode::UnknownLayoutConfig,
            "layoutConfig",
            "layout config is not an object",
        );
        return;
    };
    let allowed: &[&str] = match layout {
        "table" => &["columnBorders", "rowHeight", "frozenBoundary"],
        "board" => &["groupPropertyId", "cardFields", "coverVisible"],
        "list" => &["secondaryFields", "indentation"],
        "gallery" => &["cardSize", "fieldList", "previewSource"],
        _ => return,
    };
    for key in object.keys() {
        if !allowed.contains(&key.as_str()) {
            report.read_only_warning(
                ValidationCode::UnknownLayoutConfig,
                format!("layoutConfig.{key}"),
                "unknown layout config is retained read-only",
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::format::{parse_manifest, parse_record, DatabaseCover};

    fn manifest() -> DatabaseManifest {
        let raw = br#"{
          "format":"amby-database","formatVersion":1,
          "databaseId":"01J00000000000000000000000","name":"Characters","locked":false,
          "membership":{"kind":"filesystem-descendants","recursive":true},
          "properties":[{"id":"01J00000000000000000000001","name":"Score","type":"number","pageVisibility":"alwaysShow","yamlBinding":null,"config":{"format":"number","currency":null}}],
          "viewOrder":[],"defaultViewId":null,"templateOrder":[],"defaultTemplateId":null
        }"#;
        parse_manifest(raw).unwrap().value
    }

    #[test]
    fn decimal_validation_is_exact_and_never_uses_float() {
        assert_eq!(canonical_decimal("00012.3400").unwrap(), "12.34");
        assert_eq!(canonical_decimal("1.2e3").unwrap(), "1200");
        assert_eq!(canonical_decimal("-0.000").unwrap(), "0");
        assert_eq!(
            canonical_decimal("999999999999999999999999999999.01").unwrap(),
            "999999999999999999999999999999.01"
        );
        assert_eq!(canonical_decimal("1e1000000"), Err(ValidationCode::TooLong));
        assert!(canonical_decimal("1.2.3").is_err());
    }

    #[test]
    fn rejects_unsafe_asset_paths_and_invalid_values() {
        let mut value = manifest();
        value.cover = Some(DatabaseCover {
            kind: "asset".to_owned(),
            asset_id: "01J00000000000000000000003".to_owned(),
            relative_path: "../escape.png".to_owned(),
            mime_type: "image/png".to_owned(),
            extra: Default::default(),
        });
        let report = validate_manifest(&value);
        assert!(!report.is_valid());

        let record = parse_record(br#"{
          "format":"amby-database-record","formatVersion":1,
          "databaseId":"01J00000000000000000000000","noteId":"01J00000000000000000000001",
          "values":{"01J00000000000000000000001":{"type":"number","decimal":"1e999999999999999999999"}}
        }"#).unwrap();
        let report = validate_record(&record.value, Some(&manifest()));
        assert!(report
            .errors
            .iter()
            .any(|issue| issue.code == ValidationCode::InvalidDecimal));
    }

    #[test]
    fn filter_operator_is_checked_against_property_type() {
        let value = manifest();
        let raw = serde_json::json!({
          "format":"amby-database-view","formatVersion":1,
          "databaseId":"01J00000000000000000000000","viewId":"01J00000000000000000000002","name":"All",
          "layout":"table","openMode":"sidePeek","subitemsMode":"nested","density":null,
          "fields":[{"field":{"kind":"system","field":"title"},"visible":true,"width":null,"frozen":true}],
          "filter":{"kind":"condition","field":{"kind":"property","propertyId":"01J00000000000000000000001"},"operator":"contains","value":"x"},
          "sorts":[],"group":null,"manualOrder":[],"aggregates":[],"layoutConfig":{}
        });
        let view: DatabaseViewFile = serde_json::from_value(raw).unwrap();
        let report = validate_view(&view, Some(&value));
        assert!(report
            .errors
            .iter()
            .any(|issue| issue.code == ValidationCode::InvalidConfiguration));
    }

    #[test]
    fn unsupported_layout_is_read_only_but_unknown_filter_is_opaque() {
        let raw = serde_json::json!({
          "format":"amby-database-view","formatVersion":1,"databaseId":"01J00000000000000000000000","viewId":"01J00000000000000000000002","name":"Future","layout":"calendar","openMode":"sidePeek","subitemsMode":"nested","density":null,"fields":[{"field":{"kind":"system","field":"title"},"visible":true,"width":null,"frozen":true}],"filter":{"kind":"future","payload":1},"sorts":[],"group":null,"manualOrder":[],"aggregates":[],"layoutConfig":{}
        });
        let view: DatabaseViewFile = serde_json::from_value(raw).unwrap();
        let report = validate_view(&view, None);
        assert!(report.read_only);
        assert!(report
            .warnings
            .iter()
            .any(|issue| issue.code == ValidationCode::UnknownDiscriminant));
    }

    #[test]
    fn accepts_legacy_view_defaults_generated_by_db_10() {
        let raw = serde_json::json!({
          "format":"amby-database-view","formatVersion":1,
          "databaseId":"01J00000000000000000000000","viewId":"01J00000000000000000000002","name":"Table",
          "layout":"table","openMode":"inline","subitemsMode":"nested","density":"comfortable",
          "fields":[{"kind":"system","field":"title","visible":true,"width":null,"frozen":true}],
          "filter":null,"sorts":[],"group":null,"manualOrder":[],"aggregates":[],"layoutConfig":{}
        });
        let view: DatabaseViewFile = serde_json::from_value(raw).unwrap();
        let report = validate_view(&view, None);
        assert!(report.errors.is_empty());
        assert_eq!(report.warnings.len(), 3);
    }
}
