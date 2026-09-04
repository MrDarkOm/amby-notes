//! Typed, parameterized read/query engine for the database projection.
//!
//! The renderer supplies field/operator enums and JSON-encoded operands only.
//! Every SQL fragment below is selected from a closed Rust match; user values
//! are always SQLite bind parameters.

use std::collections::HashMap;

use rusqlite::types::Value;
use rusqlite::{params_from_iter, Connection, OptionalExtension};
use serde_json::Value as JsonValue;
use sha2::{Digest, Sha256};

use super::model::{
    DatabaseDiagnostic, DatabaseError, DatabaseFieldRef, DatabaseFilterNode, DatabaseQueryRequest,
    DatabaseQueryResult, DatabaseQuerySource, DatabaseRow, DatabaseSortSpec, DatabaseSummary,
    ProjectionVersion,
};
use crate::database::format::{
    DatabaseViewFile, FieldRef as DurableFieldRef, FilterNode as DurableFilterNode,
};
use crate::database::projection::decimal_sort_key;
use crate::database::validation::canonical_decimal;

const MAX_PAGE_SIZE: u32 = 200;
const MAX_FILTER_DEPTH: usize = 32;
const MAX_FILTER_CONDITIONS: usize = 256;
const MAX_OPERAND_BYTES: usize = 64 * 1024;

#[derive(Debug)]
pub struct QueryFailure {
    pub code: &'static str,
    pub message: String,
}

impl QueryFailure {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

#[derive(Clone, Copy)]
enum SortKeyKind {
    Blob,
}

struct SortPlan {
    expression: String,
    join_sql: String,
    property_id: Option<String>,
    direction: &'static str,
    key_kind: SortKeyKind,
}

struct Cursor {
    epoch: String,
    seq: u64,
    query_hash: String,
    last_sort_key: Vec<u8>,
    last_note_id: String,
    direction: String,
}

struct RawRow {
    note_id: String,
    title: String,
    relative_path: String,
    parent_note_id: Option<String>,
    depth: usize,
    category_path: Vec<String>,
    sort_key: Vec<u8>,
    row_revision: String,
}

pub fn query_database(
    conn: &Connection,
    request: &DatabaseQueryRequest,
) -> Result<DatabaseQueryResult, QueryFailure> {
    if request.page.limit == 0 || request.page.limit > MAX_PAGE_SIZE {
        return Err(QueryFailure::new(
            "invalidPage",
            format!("page limit must be between 1 and {MAX_PAGE_SIZE}"),
        ));
    }
    if ulid::Ulid::from_string(&request.database_id).is_err() {
        return Err(QueryFailure::new(
            "invalidDatabaseId",
            "databaseId must be a canonical ULID",
        ));
    }
    let projection = projection_version(conn)?;
    let (database_title, view_spec) = match &request.source {
        DatabaseQuerySource::Inline { spec } => {
            (database_name(conn, &request.database_id)?, spec.clone())
        }
        DatabaseQuerySource::SavedView {
            view_id,
            expected_revision,
        } => {
            let row = conn
                .query_row(
                    "SELECT name, revision, query_json FROM db_views WHERE database_id = ?1 AND view_id = ?2",
                    [request.database_id.as_str(), view_id.as_str()],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                        ))
                    },
                )
                .map_err(sql_failure)?;
            if let Some(expected_revision) = expected_revision {
                if expected_revision != &row.1 {
                    return Err(QueryFailure::new(
                        "viewRevisionConflict",
                        "saved view changed before query execution",
                    ));
                }
            }
            let view = serde_json::from_str::<DatabaseViewFile>(&row.2).map_err(|error| {
                QueryFailure::new(
                    "brokenView",
                    format!("saved view is not queryable: {error}"),
                )
            })?;
            (Some(row.0), query_spec_from_view(view))
        }
    };
    let database_name = database_title
        .or_else(|| database_name(conn, &request.database_id).ok().flatten())
        .ok_or_else(|| QueryFailure::new("databaseNotFound", "database was not found"))?;
    let query_hash = query_hash(request, &view_spec)?;
    let cursor = request
        .page
        .cursor
        .as_deref()
        .map(|value| decode_cursor(value, &projection, &query_hash))
        .transpose()?;
    let sort = sort_plan(conn, &request.database_id, &view_spec.sorts)?;
    if let Some(cursor) = &cursor {
        if cursor.direction != sort.direction {
            return Err(QueryFailure::new(
                "staleCursor",
                "cursor sort direction is stale",
            ));
        }
    }

    let mut bindings = Vec::new();
    if let Some(property_id) = &sort.property_id {
        bindings.push(Value::Text(property_id.clone()));
    }
    bindings.push(Value::Text(request.database_id.clone()));
    let filter_sql = if let Some(filter) = &view_spec.filter {
        compile_filter(conn, &request.database_id, filter, 0, &mut 0, &mut bindings)?
    } else {
        "1 = 1".to_owned()
    };
    let cursor_sql = if let Some(cursor) = &cursor {
        bindings.push(Value::Blob(cursor.last_sort_key.clone()));
        bindings.push(Value::Text(cursor.last_note_id.clone()));
        let comparison = if sort.direction == "asc" { ">" } else { "<" };
        format!(
            " AND (({expr}) {comparison} ? OR (({expr}) = ? AND m.note_id {comparison} ?))",
            expr = sort.expression,
        )
    } else {
        String::new()
    };
    // The cursor predicate has two sort-key placeholders but the binding list
    // currently contains one key. Insert the duplicate before note ID.
    if cursor.is_some() {
        let note_id = bindings.pop().expect("cursor note id");
        let sort_key = bindings.pop().expect("cursor sort key");
        bindings.push(sort_key.clone());
        bindings.push(sort_key);
        bindings.push(note_id);
    }
    let limit_index = bindings.len() + 1;
    bindings.push(Value::Integer(i64::from(request.page.limit) + 1));
    let sort_key_expression = match sort.key_kind {
        SortKeyKind::Blob => format!("COALESCE(CAST(({}) AS BLOB), X'')", sort.expression),
    };
    let sql = format!(
        "SELECT m.note_id, n.title, m.relative_path, m.parent_note_id, m.depth, m.category_path, {sort_key}, COALESCE(r.revision, '') FROM db_members m JOIN notes n ON n.id = m.note_id LEFT JOIN db_record_revisions r ON r.database_id = m.database_id AND r.note_id = m.note_id {join_sql} WHERE m.database_id = ? AND ({filter}) {cursor} ORDER BY ({expr}) {direction}, m.note_id {direction} LIMIT ?{limit_index}",
        filter = filter_sql,
        cursor = cursor_sql,
        sort_key = sort_key_expression,
        expr = sort.expression,
        direction = sort.direction,
        join_sql = sort.join_sql,
    );
    let mut statement = conn.prepare(&sql).map_err(sql_failure)?;
    let mut rows = statement
        .query(params_from_iter(bindings))
        .map_err(sql_failure)?;
    let mut raw_rows = Vec::new();
    while let Some(row) = rows.next().map_err(sql_failure)? {
        let sort_key = match sort.key_kind {
            SortKeyKind::Blob => row.get::<_, Vec<u8>>(6).unwrap_or_default(),
        };
        raw_rows.push(RawRow {
            note_id: row.get(0).map_err(sql_failure)?,
            title: row.get(1).map_err(sql_failure)?,
            relative_path: row.get(2).map_err(sql_failure)?,
            parent_note_id: row.get(3).map_err(sql_failure)?,
            depth: row.get::<_, i64>(4).map_err(sql_failure)?.max(0) as usize,
            category_path: serde_json::from_str(&row.get::<_, String>(5).map_err(sql_failure)?)
                .unwrap_or_default(),
            sort_key,
            row_revision: row.get(7).map_err(sql_failure)?,
        });
    }
    let has_next = raw_rows.len() > request.page.limit as usize;
    raw_rows.truncate(request.page.limit as usize);
    let values = load_values(conn, &request.database_id, &raw_rows)?;
    let rows = raw_rows
        .iter()
        .map(|row| DatabaseRow {
            note_id: row.note_id.clone(),
            title: row.title.clone(),
            relative_path: row.relative_path.clone(),
            parent_note_id: row.parent_note_id.clone(),
            depth: row.depth,
            category_path: row.category_path.clone(),
            values_json: values
                .get(&row.note_id)
                .cloned()
                .unwrap_or_else(|| "{}".to_owned()),
            row_revision: row.row_revision.clone(),
        })
        .collect::<Vec<_>>();
    let next_cursor = has_next
        .then(|| {
            rows.last().map(|row| {
                encode_cursor(&Cursor {
                    epoch: projection.epoch.clone(),
                    seq: projection.seq,
                    query_hash: query_hash.clone(),
                    last_sort_key: raw_rows
                        .last()
                        .map(|raw| raw.sort_key.clone())
                        .unwrap_or_default(),
                    last_note_id: row.note_id.clone(),
                    direction: sort.direction.to_owned(),
                })
            })
        })
        .flatten();
    Ok(DatabaseQueryResult {
        database: DatabaseSummary {
            database_id: request.database_id.clone(),
            title: database_name,
            views: Vec::new(),
            diagnostics: Vec::new(),
        },
        projection,
        rows,
        next_cursor,
        diagnostics: load_diagnostics(conn, &request.database_id)?,
    })
}

fn database_name(conn: &Connection, database_id: &str) -> Result<Option<String>, QueryFailure> {
    conn.query_row(
        "SELECT name FROM db_databases WHERE database_id = ?1",
        [database_id],
        |row| row.get(0),
    )
    .optional()
    .map_err(sql_failure)
}

fn projection_version(conn: &Connection) -> Result<ProjectionVersion, QueryFailure> {
    let epoch = metadata(conn, "database_projection_epoch")?.ok_or_else(|| {
        QueryFailure::new("projectionUnavailable", "database projection is not built")
    })?;
    let seq = metadata(conn, "database_projection_seq")?
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or_else(|| {
            QueryFailure::new(
                "projectionUnavailable",
                "database projection sequence is invalid",
            )
        })?;
    Ok(ProjectionVersion { epoch, seq })
}

fn metadata(conn: &Connection, key: &str) -> Result<Option<String>, QueryFailure> {
    conn.query_row(
        "SELECT value FROM index_metadata WHERE key = ?1",
        [key],
        |row| row.get(0),
    )
    .optional()
    .map_err(sql_failure)
}

fn sort_plan(
    conn: &Connection,
    database_id: &str,
    sorts: &[DatabaseSortSpec],
) -> Result<SortPlan, QueryFailure> {
    let sort = sorts.first();
    let direction = match sort.map(|sort| sort.direction.as_str()) {
        None | Some("asc") => "asc",
        Some("desc") => "desc",
        Some(_) => {
            return Err(QueryFailure::new(
                "invalidSort",
                "sort direction must be asc or desc",
            ))
        }
    };
    let Some(sort) = sort else {
        return Ok(SortPlan {
            expression: "m.title_sort_key".to_owned(),
            join_sql: String::new(),
            property_id: None,
            direction,
            key_kind: SortKeyKind::Blob,
        });
    };
    if !matches!(sort.nulls.as_str(), "first" | "last") {
        return Err(QueryFailure::new(
            "invalidSort",
            "null placement must be first or last",
        ));
    }
    let (expression, join_sql, property_id) = match &sort.field {
        DatabaseFieldRef::System { field } => match field.as_str() {
            "title" => ("m.title_sort_key".to_owned(), String::new(), None),
            "path" => (
                "CAST(m.relative_path AS BLOB)".to_owned(),
                String::new(),
                None,
            ),
            "depth" => ("printf('%020d', m.depth)".to_owned(), String::new(), None),
            "parent" => (
                "COALESCE(CAST(m.parent_note_id AS BLOB), X'')".to_owned(),
                String::new(),
                None,
            ),
            _ => {
                return Err(QueryFailure::new(
                    "invalidSortField",
                    "unknown system sort field",
                ))
            }
        },
        DatabaseFieldRef::Property { property_id } => {
            let property_type = conn
                .query_row(
                    "SELECT property_type FROM db_properties WHERE database_id = ?1 AND property_id = ?2",
                    [database_id, property_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(sql_failure)?
                .ok_or_else(|| QueryFailure::new("missingReference", "sort property is missing"))?;
            let expression = match property_type.as_str() {
                "number" => "sort_value.decimal_sort_key",
                "date" => "printf('%020d', sort_value.date_start_key)",
                "checkbox" => "printf('%d', sort_value.bool_value)",
                "select" | "status" => "CAST(sort_value.option_id AS BLOB)",
                _ => "sort_value.text_sort_key",
            };
            (
                expression.to_owned(),
                "LEFT JOIN db_values sort_value ON sort_value.database_id = m.database_id AND sort_value.note_id = m.note_id AND sort_value.property_id = ?".to_owned(),
                Some(property_id.clone()),
            )
        }
    };
    Ok(SortPlan {
        expression,
        join_sql,
        property_id,
        direction,
        key_kind: SortKeyKind::Blob,
    })
}

fn compile_filter(
    conn: &Connection,
    database_id: &str,
    filter: &DatabaseFilterNode,
    depth: usize,
    conditions: &mut usize,
    bindings: &mut Vec<Value>,
) -> Result<String, QueryFailure> {
    if depth > MAX_FILTER_DEPTH {
        return Err(QueryFailure::new("filterTooDeep", "filter AST is too deep"));
    }
    match filter {
        DatabaseFilterNode::Group { operator, children } => {
            let join = match operator.as_str() {
                "and" => " AND ",
                "or" => " OR ",
                _ => return Err(QueryFailure::new("invalidFilter", "unknown group operator")),
            };
            if children.is_empty() || children.len() > MAX_FILTER_CONDITIONS {
                return Err(QueryFailure::new(
                    "invalidFilter",
                    "filter group width is invalid",
                ));
            }
            let mut compiled = Vec::with_capacity(children.len());
            for child in children {
                compiled.push(compile_filter(
                    conn,
                    database_id,
                    child,
                    depth + 1,
                    conditions,
                    bindings,
                )?);
            }
            Ok(format!("({})", compiled.join(join)))
        }
        DatabaseFilterNode::Condition {
            field,
            operator,
            value,
        } => {
            *conditions += 1;
            if *conditions > MAX_FILTER_CONDITIONS {
                return Err(QueryFailure::new(
                    "filterTooWide",
                    "filter has too many conditions",
                ));
            }
            let operand = value.as_deref().map(parse_operand).transpose()?;
            compile_condition(conn, database_id, field, operator, operand, bindings)
        }
    }
}

fn compile_condition(
    conn: &Connection,
    database_id: &str,
    field: &DatabaseFieldRef,
    operator: &str,
    operand: Option<JsonValue>,
    bindings: &mut Vec<Value>,
) -> Result<String, QueryFailure> {
    match field {
        DatabaseFieldRef::System { field } => {
            compile_system_condition(field, operator, operand, bindings)
        }
        DatabaseFieldRef::Property { property_id } => {
            let property_type = conn
                .query_row(
                    "SELECT property_type FROM db_properties WHERE database_id = ?1 AND property_id = ?2",
                    [database_id, property_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(sql_failure)?
                .ok_or_else(|| QueryFailure::new("missingReference", "filter property is missing"))?;
            compile_property_condition(
                property_type.as_str(),
                property_id,
                operator,
                operand,
                bindings,
            )
        }
    }
}

fn compile_system_condition(
    field: &str,
    operator: &str,
    operand: Option<JsonValue>,
    bindings: &mut Vec<Value>,
) -> Result<String, QueryFailure> {
    let column = match field {
        "title" => "n.title",
        "path" => "m.relative_path",
        "depth" => "m.depth",
        "parent" => "m.parent_note_id",
        _ => {
            return Err(QueryFailure::new(
                "invalidFilterField",
                "unknown system filter field",
            ))
        }
    };
    match operator {
        "isEmpty" => Ok(format!("({column} IS NULL OR {column} = '')")),
        "isNotEmpty" => Ok(format!("({column} IS NOT NULL AND {column} <> '')")),
        "equals" | "notEquals" | "contains" | "startsWith" => {
            let value = operand_string(operand)?;
            let (expression, bind_value) = match operator {
                "contains" => (
                    format!("{column} LIKE ? ESCAPE '\\\\'"),
                    format!("%{}%", like_escape(&value)),
                ),
                "startsWith" => (
                    format!("{column} LIKE ? ESCAPE '\\\\'"),
                    format!("{}%", like_escape(&value)),
                ),
                _ => (
                    format!(
                        "{column} {} ?",
                        if operator == "equals" { "=" } else { "<>" }
                    ),
                    value,
                ),
            };
            bindings.push(Value::Text(bind_value));
            Ok(expression)
        }
        "greaterThan" | "lessThan" => {
            let value = operand_i64(operand)?;
            bindings.push(Value::Integer(value));
            Ok(format!(
                "{column} {} ?",
                if operator == "greaterThan" { ">" } else { "<" }
            ))
        }
        _ => Err(QueryFailure::new(
            "invalidOperator",
            "operator is not supported for system field",
        )),
    }
}

fn compile_property_condition(
    property_type: &str,
    property_id: &str,
    operator: &str,
    operand: Option<JsonValue>,
    bindings: &mut Vec<Value>,
) -> Result<String, QueryFailure> {
    let value_column = match property_type {
        "text" | "url" => "text_value",
        "number" => "decimal_value",
        "checkbox" => "bool_value",
        "select" | "status" => "option_id",
        _ => "canonical_json",
    };
    let exists = format!(
        "EXISTS (SELECT 1 FROM db_values v WHERE v.database_id = m.database_id AND v.note_id = m.note_id AND v.property_id = ? AND v.{value_column}"
    );
    match operator {
        "isEmpty" => {
            bindings.push(Value::Text(property_id.to_owned()));
            Ok("NOT EXISTS (SELECT 1 FROM db_values v WHERE v.database_id = m.database_id AND v.note_id = m.note_id AND v.property_id = ?)".to_owned())
        }
        "isNotEmpty" => {
            bindings.push(Value::Text(property_id.to_owned()));
            Ok("EXISTS (SELECT 1 FROM db_values v WHERE v.database_id = m.database_id AND v.note_id = m.note_id AND v.property_id = ?)".to_owned())
        }
        "equals" | "notEquals" => {
            bindings.push(Value::Text(property_id.to_owned()));
            let operand = property_operand(property_type, operand)?;
            bindings.push(operand);
            let comparator = if operator == "equals" { "=" } else { "<>" };
            Ok(format!("{exists} {comparator} ?)"))
        }
        "contains" | "startsWith" if matches!(property_type, "text" | "url") => {
            bindings.push(Value::Text(property_id.to_owned()));
            let operand = operand_string(operand)?;
            bindings.push(Value::Text(if operator == "contains" {
                format!("%{}%", like_escape(&operand))
            } else {
                format!("{}%", like_escape(&operand))
            }));
            Ok(format!("{exists} LIKE ? ESCAPE '\\\\')"))
        }
        "greaterThan" | "lessThan" if property_type == "number" => {
            let operand = operand_string(operand)?;
            let decimal = canonical_decimal(&operand).map_err(|_| {
                QueryFailure::new("invalidOperand", "number operand is not exact decimal")
            })?;
            let Some(key) = decimal_sort_key(&decimal) else {
                return Err(QueryFailure::new(
                    "invalidOperand",
                    "number operand has no sort key",
                ));
            };
            bindings.push(Value::Text(property_id.to_owned()));
            bindings.push(Value::Blob(key));
            let comparator = if operator == "greaterThan" { ">" } else { "<" };
            Ok(format!(
                "EXISTS (SELECT 1 FROM db_values v WHERE v.database_id = m.database_id AND v.note_id = m.note_id AND v.property_id = ? AND v.decimal_sort_key {comparator} ?)"
            ))
        }
        _ => Err(QueryFailure::new(
            "invalidOperator",
            format!("operator {operator} is not supported for property type {property_type}"),
        )),
    }
}

fn property_operand(
    property_type: &str,
    operand: Option<JsonValue>,
) -> Result<Value, QueryFailure> {
    match property_type {
        "checkbox" => operand
            .and_then(|value| value.as_bool())
            .map(|value| Value::Integer(value as i64))
            .ok_or_else(|| QueryFailure::new("invalidOperand", "checkbox operand must be boolean")),
        _ => Ok(Value::Text(operand_string(operand)?)),
    }
}

fn parse_operand(raw: &str) -> Result<JsonValue, QueryFailure> {
    if raw.len() > MAX_OPERAND_BYTES {
        return Err(QueryFailure::new(
            "operandTooLarge",
            "filter operand is too large",
        ));
    }
    serde_json::from_str(raw).map_err(|error| {
        QueryFailure::new("invalidOperand", format!("operand is not JSON: {error}"))
    })
}

fn operand_string(operand: Option<JsonValue>) -> Result<String, QueryFailure> {
    let value =
        operand.ok_or_else(|| QueryFailure::new("invalidOperand", "operator needs a value"))?;
    value
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| QueryFailure::new("invalidOperand", "operand must be a JSON string"))
}

fn operand_i64(operand: Option<JsonValue>) -> Result<i64, QueryFailure> {
    let value =
        operand.ok_or_else(|| QueryFailure::new("invalidOperand", "operator needs a value"))?;
    value
        .as_i64()
        .ok_or_else(|| QueryFailure::new("invalidOperand", "operand must be an integer"))
}

fn like_escape(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

fn query_hash(
    request: &DatabaseQueryRequest,
    spec: &super::model::DatabaseQuerySpec,
) -> Result<String, QueryFailure> {
    let encoded = serde_json::to_vec(&(request.database_id.as_str(), spec))
        .map_err(|error| QueryFailure::new("queryHash", error.to_string()))?;
    let digest = Sha256::digest(encoded);
    Ok(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn encode_cursor(cursor: &Cursor) -> String {
    let value = serde_json::json!({
        "epoch": cursor.epoch,
        "seq": cursor.seq,
        "queryHash": cursor.query_hash,
        "lastSortKey": cursor.last_sort_key,
        "lastNoteId": cursor.last_note_id,
        "direction": cursor.direction,
    });
    let bytes = serde_json::to_vec(&value).unwrap_or_default();
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn decode_cursor(
    encoded: &str,
    projection: &ProjectionVersion,
    query_hash: &str,
) -> Result<Cursor, QueryFailure> {
    if !encoded.len().is_multiple_of(2) || encoded.len() > 64 * 1024 {
        return Err(QueryFailure::new("staleCursor", "cursor is malformed"));
    }
    let mut bytes = Vec::with_capacity(encoded.len() / 2);
    for pair in encoded.as_bytes().chunks_exact(2) {
        let text = std::str::from_utf8(pair)
            .map_err(|_| QueryFailure::new("staleCursor", "cursor is not hexadecimal"))?;
        bytes.push(
            u8::from_str_radix(text, 16)
                .map_err(|_| QueryFailure::new("staleCursor", "cursor is not hexadecimal"))?,
        );
    }
    let value: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|_| QueryFailure::new("staleCursor", "cursor JSON is invalid"))?;
    let cursor = Cursor {
        epoch: value
            .get("epoch")
            .and_then(JsonValue::as_str)
            .unwrap_or_default()
            .to_owned(),
        seq: value
            .get("seq")
            .and_then(JsonValue::as_u64)
            .unwrap_or_default(),
        query_hash: value
            .get("queryHash")
            .and_then(JsonValue::as_str)
            .unwrap_or_default()
            .to_owned(),
        last_sort_key: value
            .get("lastSortKey")
            .and_then(JsonValue::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(JsonValue::as_u64)
                    .map(|value| value as u8)
                    .collect()
            })
            .unwrap_or_default(),
        last_note_id: value
            .get("lastNoteId")
            .and_then(JsonValue::as_str)
            .unwrap_or_default()
            .to_owned(),
        direction: value
            .get("direction")
            .and_then(JsonValue::as_str)
            .unwrap_or_default()
            .to_owned(),
    };
    if cursor.epoch != projection.epoch
        || cursor.seq != projection.seq
        || cursor.query_hash != query_hash
    {
        return Err(QueryFailure::new(
            "staleCursor",
            "cursor belongs to another projection or query",
        ));
    }
    if cursor.last_note_id.is_empty() || cursor.direction.is_empty() {
        return Err(QueryFailure::new("staleCursor", "cursor is incomplete"));
    }
    Ok(cursor)
}

fn query_spec_from_view(view: DatabaseViewFile) -> super::model::DatabaseQuerySpec {
    super::model::DatabaseQuerySpec {
        filter: view.filter.map(filter_from_durable),
        sorts: view
            .sorts
            .into_iter()
            .map(|sort| DatabaseSortSpec {
                field: field_from_durable(sort.field),
                direction: sort.direction,
                nulls: sort.nulls,
            })
            .collect(),
    }
}

fn field_from_durable(field: DurableFieldRef) -> DatabaseFieldRef {
    match field {
        DurableFieldRef::System { field, .. } => DatabaseFieldRef::System { field },
        DurableFieldRef::Property { property_id, .. } => DatabaseFieldRef::Property { property_id },
        DurableFieldRef::Opaque(_) => DatabaseFieldRef::System {
            field: "invalid".to_owned(),
        },
    }
}

fn filter_from_durable(filter: DurableFilterNode) -> DatabaseFilterNode {
    match filter {
        DurableFilterNode::Group {
            operator, children, ..
        } => DatabaseFilterNode::Group {
            operator,
            children: children.into_iter().map(filter_from_durable).collect(),
        },
        DurableFilterNode::Condition {
            field,
            operator,
            value,
            ..
        } => DatabaseFilterNode::Condition {
            field: field_from_durable(field),
            operator,
            value: value.map(|value| value.to_string()),
        },
        DurableFilterNode::Opaque(_) => DatabaseFilterNode::Condition {
            field: DatabaseFieldRef::System {
                field: "invalid".to_owned(),
            },
            operator: "invalid".to_owned(),
            value: None,
        },
    }
}

fn load_values(
    conn: &Connection,
    database_id: &str,
    rows: &[RawRow],
) -> Result<HashMap<String, String>, QueryFailure> {
    if rows.is_empty() {
        return Ok(HashMap::new());
    }
    let placeholders = (0..rows.len()).map(|_| "?").collect::<Vec<_>>().join(",");
    let sql = format!(
        "SELECT note_id, property_id, canonical_json FROM db_values WHERE database_id = ? AND note_id IN ({placeholders})"
    );
    let mut bindings = vec![Value::Text(database_id.to_owned())];
    bindings.extend(rows.iter().map(|row| Value::Text(row.note_id.clone())));
    let mut statement = conn.prepare(&sql).map_err(sql_failure)?;
    let mut query = statement
        .query(params_from_iter(bindings))
        .map_err(sql_failure)?;
    let mut values = HashMap::<String, serde_json::Map<String, JsonValue>>::new();
    while let Some(row) = query.next().map_err(sql_failure)? {
        let note_id: String = row.get(0).map_err(sql_failure)?;
        let property_id: String = row.get(1).map_err(sql_failure)?;
        let canonical: String = row.get(2).map_err(sql_failure)?;
        let value = serde_json::from_str(&canonical).unwrap_or(JsonValue::String(canonical));
        values
            .entry(note_id)
            .or_default()
            .insert(property_id, value);
    }
    values
        .into_iter()
        .map(|(note_id, values)| {
            serde_json::to_string(&values)
                .map(|value| (note_id, value))
                .map_err(|error| QueryFailure::new("serialization", error.to_string()))
        })
        .collect()
}

fn load_diagnostics(
    conn: &Connection,
    database_id: &str,
) -> Result<Vec<DatabaseDiagnostic>, QueryFailure> {
    let mut statement = conn
        .prepare(
            "SELECT code, severity, details_json FROM db_diagnostics WHERE scope_key = ?1 OR scope_kind = 'vault' ORDER BY diagnostic_id",
        )
        .map_err(sql_failure)?;
    let rows = statement
        .query_map([database_id], |row| {
            let details: JsonValue = serde_json::from_str::<String>(&row.get::<_, String>(2)?)
                .ok()
                .and_then(|value| serde_json::from_str(&value).ok())
                .unwrap_or(JsonValue::Null);
            Ok(DatabaseDiagnostic {
                code: row.get(0)?,
                severity: row.get(1)?,
                path: details
                    .get("path")
                    .and_then(JsonValue::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                message: details
                    .get("message")
                    .and_then(JsonValue::as_str)
                    .unwrap_or_default()
                    .to_owned(),
            })
        })
        .map_err(sql_failure)?;
    rows.map(|row| row.map_err(sql_failure)).collect()
}

fn sql_failure(error: rusqlite::Error) -> QueryFailure {
    QueryFailure::new("queryFailed", error.to_string())
}

impl From<QueryFailure> for DatabaseError {
    fn from(error: QueryFailure) -> Self {
        DatabaseError::Failed {
            code: error.code.to_owned(),
            message: error.message,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::model::{DatabaseFilterNode, DatabasePageRequest, DatabaseQuerySpec};
    use crate::index::schema::init_schema;
    use rusqlite::params;

    fn connection() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        conn.execute(
            "INSERT INTO db_databases (database_id, container_path, name, locked, format_version, manifest_revision, projection_state) VALUES ('01J00000000000000000000000', 'Database', 'Database', 0, 1, 'manifest', 'healthy')",
            [],
        )
        .unwrap();
        for (id, title) in [
            ("01J00000000000000000000001", "Alpha"),
            ("01J00000000000000000000002", "Beta"),
            ("01J00000000000000000000003", "Gamma"),
        ] {
            conn.execute(
                "INSERT INTO notes (id, path, title, mtime, size, content, word_count, created_at, updated_at) VALUES (?1, ?2, ?3, 0, 0, '', 0, 0, 0)",
                params![id, format!("{title}.md"), title],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO db_members (database_id, note_id, relative_path, category_path, depth, title_sort_key) VALUES ('01J00000000000000000000000', ?1, ?2, '[]', 0, ?3)",
                params![id, format!("{title}.md"), title.to_lowercase().into_bytes()],
            )
            .unwrap();
        }
        conn.execute(
            "INSERT INTO index_metadata (key, value) VALUES ('database_projection_epoch', '01J00000000000000000000009'), ('database_projection_seq', '0')",
            [],
        )
        .unwrap();
        conn
    }

    fn request(
        filter: Option<DatabaseFilterNode>,
        page: DatabasePageRequest,
    ) -> DatabaseQueryRequest {
        DatabaseQueryRequest {
            expected_generation: 1,
            database_id: "01J00000000000000000000000".to_owned(),
            source: DatabaseQuerySource::Inline {
                spec: DatabaseQuerySpec {
                    filter,
                    sorts: Vec::new(),
                },
            },
            page,
        }
    }

    #[test]
    fn keyset_pagination_has_no_duplicates() {
        let conn = connection();
        let first = query_database(
            &conn,
            &request(
                None,
                DatabasePageRequest {
                    limit: 2,
                    cursor: None,
                },
            ),
        )
        .unwrap();
        assert_eq!(
            first
                .rows
                .iter()
                .map(|row| row.title.as_str())
                .collect::<Vec<_>>(),
            ["Alpha", "Beta"]
        );
        let second = query_database(
            &conn,
            &request(
                None,
                DatabasePageRequest {
                    limit: 2,
                    cursor: first.next_cursor,
                },
            ),
        )
        .unwrap();
        assert_eq!(
            second
                .rows
                .iter()
                .map(|row| row.title.as_str())
                .collect::<Vec<_>>(),
            ["Gamma"]
        );
    }

    #[test]
    fn filter_operands_are_bound_and_fts_or_sql_syntax_is_not_executed() {
        let conn = connection();
        let filter = DatabaseFilterNode::Condition {
            field: DatabaseFieldRef::System {
                field: "title".to_owned(),
            },
            operator: "equals".to_owned(),
            value: Some("\"Alpha' OR 1=1 --\"".to_owned()),
        };
        let result = query_database(
            &conn,
            &request(
                Some(filter),
                DatabasePageRequest {
                    limit: 20,
                    cursor: None,
                },
            ),
        )
        .unwrap();
        assert!(result.rows.is_empty());
    }

    #[test]
    fn cursor_is_invalidated_by_projection_epoch() {
        let conn = connection();
        let first = query_database(
            &conn,
            &request(
                None,
                DatabasePageRequest {
                    limit: 1,
                    cursor: None,
                },
            ),
        )
        .unwrap();
        conn.execute(
            "UPDATE index_metadata SET value = '01J0000000000000000000000A' WHERE key = 'database_projection_epoch'",
            [],
        )
        .unwrap();
        let error = query_database(
            &conn,
            &request(
                None,
                DatabasePageRequest {
                    limit: 1,
                    cursor: first.next_cursor,
                },
            ),
        )
        .unwrap_err();
        assert_eq!(error.code, "staleCursor");
    }
}
