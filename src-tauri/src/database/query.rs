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

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
enum SortKey {
    Null,
    Blob(Vec<u8>),
    Integer(i64),
}

impl SortKey {
    fn binding(&self) -> Value {
        match self {
            Self::Null => Value::Null,
            Self::Blob(value) => Value::Blob(value.clone()),
            Self::Integer(value) => Value::Integer(*value),
        }
    }
}

struct SortPlan {
    expression: String,
    join_sql: String,
    property_id: Option<String>,
    direction: &'static str,
    nulls: &'static str,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Cursor {
    epoch: String,
    seq: u64,
    query_hash: String,
    last_sort_keys: Vec<SortKey>,
    last_note_id: String,
}

struct RawRow {
    note_id: String,
    title: String,
    relative_path: String,
    parent_note_id: Option<String>,
    depth: usize,
    category_path: Vec<String>,
    sort_keys: Vec<SortKey>,
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
    let sorts = sort_plans(conn, &request.database_id, &view_spec.sorts)?;
    if cursor
        .as_ref()
        .is_some_and(|cursor| cursor.last_sort_keys.len() != sorts.len())
    {
        return Err(QueryFailure::new(
            "staleCursor",
            "cursor sort keys are incomplete",
        ));
    }

    let mut bindings = sorts
        .iter()
        .filter_map(|sort| sort.property_id.as_ref().map(|id| Value::Text(id.clone())))
        .collect::<Vec<_>>();
    bindings.push(Value::Text(request.database_id.clone()));
    let filter_sql = if let Some(filter) = &view_spec.filter {
        compile_filter(conn, &request.database_id, filter, 0, &mut 0, &mut bindings)?
    } else {
        "1 = 1".to_owned()
    };
    let cursor_sql = cursor
        .as_ref()
        .map(|cursor| format!(" AND ({})", cursor_predicate(&sorts, cursor, &mut bindings)))
        .unwrap_or_default();
    bindings.push(Value::Integer(i64::from(request.page.limit) + 1));
    let sort_keys = sorts
        .iter()
        .map(|sort| sort.expression.as_str())
        .collect::<Vec<_>>()
        .join(", ");
    let joins = sorts
        .iter()
        .map(|sort| sort.join_sql.as_str())
        .collect::<Vec<_>>()
        .join(" ");
    let order = sorts
        .iter()
        .map(|sort| {
            format!(
                "{} {} NULLS {}",
                sort.expression, sort.direction, sort.nulls
            )
        })
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "SELECT m.note_id, n.title, m.relative_path, m.parent_note_id, m.depth, m.category_path, COALESCE(r.revision, ''), {sort_keys} FROM db_members m JOIN notes n ON n.id = m.note_id LEFT JOIN db_record_revisions r ON r.database_id = m.database_id AND r.note_id = m.note_id {joins} WHERE m.database_id = ? AND ({filter_sql}) {cursor_sql} ORDER BY {order}, m.note_id ASC LIMIT ?"
    );
    let mut statement = conn.prepare(&sql).map_err(sql_failure)?;
    let mut rows = statement
        .query(params_from_iter(bindings))
        .map_err(sql_failure)?;
    let mut raw_rows = Vec::new();
    while let Some(row) = rows.next().map_err(sql_failure)? {
        let sort_keys = (0..sorts.len())
            .map(
                |index| match row.get::<_, Value>(7 + index).map_err(sql_failure)? {
                    Value::Null => Ok(SortKey::Null),
                    Value::Blob(value) => Ok(SortKey::Blob(value)),
                    Value::Integer(value) => Ok(SortKey::Integer(value)),
                    _ => Err(QueryFailure::new("queryFailed", "unexpected sort key type")),
                },
            )
            .collect::<Result<Vec<_>, _>>()?;
        raw_rows.push(RawRow {
            note_id: row.get(0).map_err(sql_failure)?,
            title: row.get(1).map_err(sql_failure)?,
            relative_path: row.get(2).map_err(sql_failure)?,
            parent_note_id: row.get(3).map_err(sql_failure)?,
            depth: row.get::<_, i64>(4).map_err(sql_failure)?.max(0) as usize,
            category_path: serde_json::from_str(&row.get::<_, String>(5).map_err(sql_failure)?)
                .unwrap_or_default(),
            sort_keys,
            row_revision: row.get(6).map_err(sql_failure)?,
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
                    last_sort_keys: raw_rows
                        .last()
                        .map(|raw| raw.sort_keys.clone())
                        .unwrap_or_default(),
                    last_note_id: row.note_id.clone(),
                })
            })
        })
        .flatten();
    Ok(DatabaseQueryResult {
        database: DatabaseSummary {
            database_id: request.database_id.clone(),
            title: database_name,
            icon: None,
            attached_note_id: None,
            manifest_revision: String::new(),
            locked: false,
            properties: Vec::new(),
            views: Vec::new(),
            templates: Vec::new(),
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

/// Compare each key only after all earlier keys are equal. `IS` deliberately
/// treats two NULL keys as equal; their placement is independent of direction.
fn cursor_predicate(sorts: &[SortPlan], cursor: &Cursor, bindings: &mut Vec<Value>) -> String {
    let mut branches = Vec::new();
    for index in 0..=sorts.len() {
        let mut terms = Vec::new();
        for (sort, key) in sorts.iter().zip(&cursor.last_sort_keys).take(index) {
            terms.push(format!("{} IS ?", sort.expression));
            bindings.push(key.binding());
        }
        if let Some(sort) = sorts.get(index) {
            let key = &cursor.last_sort_keys[index];
            if matches!(key, SortKey::Null) {
                terms.push(if sort.nulls == "first" {
                    format!("{} IS NOT NULL", sort.expression)
                } else {
                    "0".to_owned()
                });
            } else {
                let comparator = if sort.direction == "asc" { ">" } else { "<" };
                let comparison = format!("{} {comparator} ?", sort.expression);
                bindings.push(key.binding());
                terms.push(if sort.nulls == "last" {
                    format!("({comparison} OR {} IS NULL)", sort.expression)
                } else {
                    comparison
                });
            }
        } else {
            terms.push("m.note_id > ?".to_owned());
            bindings.push(Value::Text(cursor.last_note_id.clone()));
        }
        branches.push(format!("({})", terms.join(" AND ")));
    }
    branches.join(" OR ")
}

fn sort_plans(
    conn: &Connection,
    database_id: &str,
    sorts: &[DatabaseSortSpec],
) -> Result<Vec<SortPlan>, QueryFailure> {
    if sorts.len() > 32 {
        return Err(QueryFailure::new(
            "invalidSort",
            "at most 32 sort rules are allowed",
        ));
    }
    if sorts.is_empty() {
        return Ok(vec![SortPlan {
            expression: "m.title_sort_key".to_owned(),
            join_sql: String::new(),
            property_id: None,
            direction: "asc",
            nulls: "last",
        }]);
    }
    sorts
        .iter()
        .enumerate()
        .map(|(index, sort)| sort_plan(conn, database_id, sort, index))
        .collect()
}

fn sort_plan(
    conn: &Connection,
    database_id: &str,
    sort: &DatabaseSortSpec,
    index: usize,
) -> Result<SortPlan, QueryFailure> {
    let direction = match sort.direction.as_str() {
        "asc" => "asc",
        "desc" => "desc",
        _ => {
            return Err(QueryFailure::new(
                "invalidSort",
                "sort direction must be asc or desc",
            ))
        }
    };
    let nulls = match sort.nulls.as_str() {
        "first" => "first",
        "last" => "last",
        _ => {
            return Err(QueryFailure::new(
                "invalidSort",
                "null placement must be first or last",
            ))
        }
    };
    let (expression, join_sql, property_id) = match &sort.field {
        DatabaseFieldRef::System { field } => {
            let expression = match field.as_str() {
                "title" => "m.title_sort_key",
                "path" => "CAST(m.relative_path AS BLOB)",
                "depth" => "m.depth",
                "parent" => "CAST(m.parent_note_id AS BLOB)",
                _ => {
                    return Err(QueryFailure::new(
                        "invalidSortField",
                        "unknown system sort field",
                    ))
                }
            };
            (expression.to_owned(), String::new(), None)
        }
        DatabaseFieldRef::Property { property_id } => {
            let property_type = conn.query_row(
                "SELECT property_type FROM db_properties WHERE database_id = ?1 AND property_id = ?2",
                [database_id, property_id], |row| row.get::<_, String>(0),
            ).optional().map_err(sql_failure)?
                .ok_or_else(|| QueryFailure::new("missingReference", "sort property is missing"))?;
            let alias = format!("sort_value_{index}");
            let column = match property_type.as_str() {
                "number" => "decimal_sort_key",
                "date" => "date_start_key",
                "checkbox" => "bool_value",
                "select" | "status" => "option_id",
                "text" | "url" => "text_sort_key",
                _ => {
                    return Err(QueryFailure::new(
                        "invalidSortField",
                        "property type does not support sorting",
                    ))
                }
            };
            let expression = if matches!(property_type.as_str(), "select" | "status") {
                format!("CAST({alias}.{column} AS BLOB)")
            } else {
                format!("{alias}.{column}")
            };
            (expression,
                format!("LEFT JOIN db_values {alias} ON {alias}.database_id = m.database_id AND {alias}.note_id = m.note_id AND {alias}.property_id = ?"),
                Some(property_id.clone()))
        }
    };
    Ok(SortPlan {
        expression,
        join_sql,
        property_id,
        direction,
        nulls,
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
                    format!("{column} LIKE ? ESCAPE '\\'"),
                    format!("%{}%", like_escape(&value)),
                ),
                "startsWith" => (
                    format!("{column} LIKE ? ESCAPE '\\'"),
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
        "number" => "decimal_sort_key",
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
            Ok(format!("{exists} LIKE ? ESCAPE '\\')"))
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
        "number" => decimal_sort_key(&operand_string(operand)?)
            .map(Value::Blob)
            .ok_or_else(|| {
                QueryFailure::new("invalidOperand", "number operand is not exact decimal")
            }),
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
    let bytes = serde_json::to_vec(cursor).unwrap_or_default();
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
    let cursor: Cursor = serde_json::from_slice(&bytes)
        .map_err(|_| QueryFailure::new("staleCursor", "cursor JSON is invalid"))?;
    if cursor.epoch != projection.epoch
        || cursor.seq != projection.seq
        || cursor.query_hash != query_hash
    {
        return Err(QueryFailure::new(
            "staleCursor",
            "cursor belongs to another projection or query",
        ));
    }
    if cursor.last_note_id.is_empty() || cursor.last_sort_keys.is_empty() {
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
            let details: JsonValue = serde_json::from_str(&row.get::<_, String>(2)?)
                .ok()
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

    fn property(conn: &Connection, kind: &str, values: &[Option<JsonValue>]) {
        conn.execute(
            "INSERT INTO db_properties (database_id, property_id, position, name, property_type, page_visibility, config_json) VALUES ('01J00000000000000000000000', ?1, 0, ?1, ?1, 'alwaysShow', '{}')",
            [kind],
        ).unwrap();
        for (index, value) in values.iter().enumerate() {
            let Some(value) = value else { continue };
            let decimal = value.get("decimal").and_then(JsonValue::as_str);
            conn.execute(
                "INSERT INTO db_values (database_id, note_id, property_id, value_type, canonical_json, text_value, text_sort_key, decimal_value, decimal_sort_key, bool_value, date_start_key, source_revision) VALUES ('01J00000000000000000000000', ?1, ?2, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'record')",
                params![
                    format!("01J0000000000000000000000{}", index + 1), kind,
                    value.to_string(), value.get("value").and_then(JsonValue::as_str),
                    value.get("value").and_then(JsonValue::as_str).map(|value| value.to_lowercase().into_bytes()),
                    decimal, decimal.and_then(decimal_sort_key),
                    value.get("checked").and_then(JsonValue::as_bool).map(i64::from),
                    value.get("dateKey").and_then(JsonValue::as_i64),
                ],
            ).unwrap();
        }
    }

    fn sorted_request(kind: &str, direction: &str, nulls: &str) -> DatabaseQueryRequest {
        let mut request = request(
            None,
            DatabasePageRequest {
                limit: 1,
                cursor: None,
            },
        );
        request.source = DatabaseQuerySource::Inline {
            spec: DatabaseQuerySpec {
                filter: None,
                sorts: vec![DatabaseSortSpec {
                    field: DatabaseFieldRef::Property {
                        property_id: kind.to_owned(),
                    },
                    direction: direction.to_owned(),
                    nulls: nulls.to_owned(),
                }],
            },
        };
        request
    }

    fn all_pages(conn: &Connection, mut request: DatabaseQueryRequest) -> Vec<String> {
        let mut titles = Vec::new();
        for _ in 0..10 {
            let page = query_database(conn, &request).unwrap();
            titles.extend(page.rows.into_iter().map(|row| row.title));
            request.page.cursor = page.next_cursor;
            if request.page.cursor.is_none() {
                return titles;
            }
        }
        panic!("pagination did not terminate");
    }

    #[test]
    fn typed_pagination_preserves_nulls_and_every_row_in_both_directions() {
        for (kind, low, high) in [
            (
                "number",
                serde_json::json!({"decimal":"-1.23"}),
                serde_json::json!({"decimal":"-1.2"}),
            ),
            (
                "text",
                serde_json::json!({"value":""}),
                serde_json::json!({"value":"z"}),
            ),
            (
                "checkbox",
                serde_json::json!({"checked":false}),
                serde_json::json!({"checked":true}),
            ),
            (
                "date",
                serde_json::json!({"dateKey":-200}),
                serde_json::json!({"dateKey":-100}),
            ),
        ] {
            let conn = connection();
            property(&conn, kind, &[None, Some(high), Some(low)]);
            for (direction, nulls, expected) in [
                ("asc", "first", vec!["Alpha", "Gamma", "Beta"]),
                ("asc", "last", vec!["Gamma", "Beta", "Alpha"]),
                ("desc", "first", vec!["Alpha", "Beta", "Gamma"]),
                ("desc", "last", vec!["Beta", "Gamma", "Alpha"]),
            ] {
                assert_eq!(
                    all_pages(&conn, sorted_request(kind, direction, nulls)),
                    expected,
                    "{kind} {direction} nulls {nulls}"
                );
            }
        }
    }

    #[test]
    fn pagination_applies_secondary_sorts_before_the_note_id_tie_breaker() {
        for values in [vec![], vec![Some(serde_json::json!({"value":"same"})); 3]] {
            let conn = connection();
            property(&conn, "text", &values);
            let mut request = sorted_request("text", "asc", "last");
            let DatabaseQuerySource::Inline { spec } = &mut request.source else {
                unreachable!()
            };
            spec.sorts.push(DatabaseSortSpec {
                field: DatabaseFieldRef::System {
                    field: "title".to_owned(),
                },
                direction: "desc".to_owned(),
                nulls: "last".to_owned(),
            });
            assert_eq!(all_pages(&conn, request), ["Gamma", "Beta", "Alpha"]);
        }
    }

    #[test]
    fn number_filters_use_exact_normalized_values() {
        let conn = connection();
        property(
            &conn,
            "number",
            &[
                Some(serde_json::json!({"decimal":"-1.200"})),
                Some(serde_json::json!({"decimal":"-1.23"})),
                Some(serde_json::json!({"decimal":"90071992547409931234567890.125"})),
            ],
        );
        for (operator, operand, expected) in [
            ("equals", "-12e-1", vec!["Alpha"]),
            ("notEquals", "-1.2", vec!["Beta", "Gamma"]),
            ("lessThan", "-1.2", vec!["Beta"]),
            (
                "greaterThan",
                "90071992547409931234567890.12",
                vec!["Gamma"],
            ),
        ] {
            let request = request(
                Some(DatabaseFilterNode::Condition {
                    field: DatabaseFieldRef::Property {
                        property_id: "number".to_owned(),
                    },
                    operator: operator.to_owned(),
                    value: Some(serde_json::json!(operand).to_string()),
                }),
                DatabasePageRequest {
                    limit: 1,
                    cursor: None,
                },
            );
            assert_eq!(all_pages(&conn, request), expected);
        }
        let invalid = request(
            Some(DatabaseFilterNode::Condition {
                field: DatabaseFieldRef::Property {
                    property_id: "number".to_owned(),
                },
                operator: "equals".to_owned(),
                value: Some(serde_json::json!("not a number").to_string()),
            }),
            DatabasePageRequest {
                limit: 1,
                cursor: None,
            },
        );
        assert_eq!(
            query_database(&conn, &invalid).unwrap_err().code,
            "invalidOperand"
        );
    }

    #[test]
    fn malformed_cursor_keys_are_rejected_instead_of_silently_truncated() {
        let conn = connection();
        let mut request = request(
            None,
            DatabasePageRequest {
                limit: 1,
                cursor: None,
            },
        );
        let first = query_database(&conn, &request).unwrap();
        let projection = projection_version(&conn).unwrap();
        let DatabaseQuerySource::Inline { spec } = &request.source else {
            unreachable!()
        };
        let hash = query_hash(&request, spec).unwrap();
        let cursor = decode_cursor(&first.next_cursor.unwrap(), &projection, &hash).unwrap();
        for keys in [
            serde_json::json!([]),
            serde_json::json!([{"Blob":[256]}]),
            serde_json::json!([{"Blob":[-1]}]),
        ] {
            let mut value = serde_json::to_value(&cursor).unwrap();
            value["lastSortKeys"] = keys;
            request.page.cursor = Some(
                serde_json::to_vec(&value)
                    .unwrap()
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect(),
            );
            assert_eq!(
                query_database(&conn, &request).unwrap_err().code,
                "staleCursor"
            );
        }
    }

    #[test]
    fn text_filters_treat_like_metacharacters_as_literal_text() {
        let conn = connection();
        property(
            &conn,
            "text",
            &[
                Some(serde_json::json!({"value":"100%_\\done"})),
                Some(serde_json::json!({"value":"100xxdone"})),
            ],
        );
        conn.execute(
            "UPDATE notes SET title = '100%_\\done' WHERE title = 'Alpha'",
            [],
        )
        .unwrap();
        for field in [
            DatabaseFieldRef::System {
                field: "title".to_owned(),
            },
            DatabaseFieldRef::Property {
                property_id: "text".to_owned(),
            },
        ] {
            for (operator, operand) in [("contains", "%_\\"), ("startsWith", "100%_\\")] {
                let page = query_database(
                    &conn,
                    &request(
                        Some(DatabaseFilterNode::Condition {
                            field: field.clone(),
                            operator: operator.to_owned(),
                            value: Some(serde_json::json!(operand).to_string()),
                        }),
                        DatabasePageRequest {
                            limit: 20,
                            cursor: None,
                        },
                    ),
                )
                .unwrap();
                assert_eq!(page.rows.len(), 1);
                assert_eq!(page.rows[0].title, "100%_\\done");
            }
        }
    }

    #[test]
    fn diagnostics_retain_their_source_path_and_message() {
        let conn = connection();
        conn.execute("INSERT INTO db_diagnostics (diagnostic_id, scope_kind, scope_key, code, severity, details_json, first_seen_at, last_seen_at) VALUES ('diagnostic', 'vault', 'Database/ambd.json', 'brokenManifest', 'error', ?1, 0, 0)",
            [serde_json::json!({"path":"Database/ambd.json", "message":"Invalid JSON"}).to_string()]).unwrap();
        let page = query_database(
            &conn,
            &request(
                None,
                DatabasePageRequest {
                    limit: 20,
                    cursor: None,
                },
            ),
        )
        .unwrap();
        assert_eq!(page.diagnostics[0].path, "Database/ambd.json");
        assert_eq!(page.diagnostics[0].message, "Invalid JSON");
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
