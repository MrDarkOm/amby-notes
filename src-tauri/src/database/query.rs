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
    DatabaseAggregateGroup, DatabaseAggregateRequest, DatabaseAggregateResult, DatabaseDiagnostic,
    DatabaseError, DatabaseFieldRef, DatabaseFilterNode, DatabaseQueryRequest, DatabaseQueryResult,
    DatabaseQuerySource, DatabaseRow, DatabaseSortSpec, DatabaseSummary, ProjectionVersion,
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

type AggregateFieldPlan = (
    Option<String>,
    Option<String>,
    Vec<Value>,
    Option<String>,
    Vec<Value>,
);

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
    let (database_title, mut view_spec) = match &request.source {
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
    if let Some(sorts) = &request.sorts {
        view_spec.sorts = sorts.clone();
    }
    if let Some(filter) = &request.filter {
        view_spec.filter = Some(match view_spec.filter.take() {
            Some(saved_filter) => DatabaseFilterNode::Group {
                operator: "and".to_owned(),
                children: vec![saved_filter, filter.clone()],
            },
            None => filter.clone(),
        });
    }
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
    let search_sql = request
        .search
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| compile_search(value, &mut bindings))
        .unwrap_or_else(|| "1 = 1".to_owned());
    let count_bindings = bindings.clone();
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
        "SELECT m.note_id, n.title, m.relative_path, m.parent_note_id, m.depth, m.category_path, COALESCE(r.revision, ''), {sort_keys} FROM db_members m JOIN notes n ON n.id = m.note_id LEFT JOIN db_record_revisions r ON r.database_id = m.database_id AND r.note_id = m.note_id {joins} WHERE m.database_id = ? AND ({filter_sql}) AND ({search_sql}) {cursor_sql} ORDER BY {order}, m.note_id ASC LIMIT ?"
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
    let count_sql = format!(
        "SELECT COUNT(*) FROM db_members m JOIN notes n ON n.id = m.note_id {joins} WHERE m.database_id = ? AND ({filter_sql}) AND ({search_sql})"
    );
    let total_count = conn
        .prepare(&count_sql)
        .and_then(|mut statement| {
            statement.query_row(params_from_iter(count_bindings), |row| row.get::<_, i64>(0))
        })
        .map_err(sql_failure)?
        .max(0) as u64;
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
        total_count,
    })
}

/// Run an aggregate against the filtered projection. The query returns one
/// row per group and never transfers the source rows to the renderer.
pub fn aggregate_database(
    conn: &Connection,
    request: &DatabaseAggregateRequest,
) -> Result<DatabaseAggregateResult, QueryFailure> {
    if request.limit == 0 || request.limit > 256 {
        return Err(QueryFailure::new(
            "invalidAggregateLimit",
            "aggregate limit must be between 1 and 256",
        ));
    }
    let (spec, database_title) = match &request.source {
        DatabaseQuerySource::Inline { spec } => (spec.clone(), None),
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
            if expected_revision
                .as_deref()
                .is_some_and(|revision| revision != row.1)
            {
                return Err(QueryFailure::new(
                    "viewRevisionConflict",
                    "saved view changed before aggregation",
                ));
            }
            let view = serde_json::from_str::<DatabaseViewFile>(&row.2).map_err(|error| {
                QueryFailure::new(
                    "brokenView",
                    format!("saved view is not queryable: {error}"),
                )
            })?;
            (query_spec_from_view(view), Some(row.0))
        }
    };
    let _database_name = database_title
        .or_else(|| database_name(conn, &request.database_id).ok().flatten())
        .ok_or_else(|| QueryFailure::new("databaseNotFound", "database was not found"))?;
    if let Some(search) = request
        .search
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        // Keep the temporary search independent from the durable view.
        let _ = search;
    }

    let (category_type, category_expr, mut bindings, label_expr, label_bindings) =
        aggregate_field_plan(conn, &request.database_id, request.category.as_ref())?;
    let (measure_expr, measure_bindings) = aggregate_measure_plan(
        conn,
        &request.database_id,
        request.measure.as_ref(),
        &request.aggregation,
    )?;
    bindings.extend(measure_bindings);
    bindings.push(Value::Text(request.database_id.clone()));
    let filter_sql = if let Some(filter) = &spec.filter {
        compile_filter(conn, &request.database_id, filter, 0, &mut 0, &mut bindings)?
    } else {
        "1 = 1".to_owned()
    };
    let search_sql = request
        .search
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| compile_search(value, &mut bindings))
        .unwrap_or_else(|| "1 = 1".to_owned());
    bindings.extend(label_bindings);
    let label_expression = label_expr.unwrap_or_else(|| "base.category_key".to_owned());
    let category_expression = category_expr.unwrap_or_else(|| "NULL".to_owned());
    let value_expression = match request.aggregation.as_str() {
        "count" => "NULL".to_owned(),
        "sum" => "CAST(SUM(CAST(base.measure_value AS REAL)) AS TEXT)".to_owned(),
        "average" => "CAST(AVG(CAST(base.measure_value AS REAL)) AS TEXT)".to_owned(),
        "min" => "MIN(base.measure_value)".to_owned(),
        "max" => "MAX(base.measure_value)".to_owned(),
        _ => unreachable!("aggregate_measure_plan validates the measure"),
    };
    let sql = format!(
        "WITH base AS (SELECT m.note_id, {category_expression} AS category_key, {measure_expr} AS measure_value FROM db_members m JOIN notes n ON n.id = m.note_id WHERE m.database_id = ? AND ({filter_sql}) AND ({search_sql})) SELECT COALESCE(base.category_key, '__empty__') AS category_key, COALESCE({label_expression}, '') AS category_label, COUNT(DISTINCT base.note_id), {value_expression}, SUM(COUNT(DISTINCT base.note_id)) OVER () FROM base GROUP BY base.category_key ORDER BY COUNT(DISTINCT base.note_id) DESC, category_key ASC LIMIT ?"
    );
    bindings.push(Value::Integer(i64::from(request.limit)));
    let mut statement = conn.prepare(&sql).map_err(sql_failure)?;
    let mut rows = statement
        .query(params_from_iter(bindings))
        .map_err(sql_failure)?;
    let mut groups = Vec::new();
    let mut complete_count = 0;
    while let Some(row) = rows.next().map_err(sql_failure)? {
        groups.push(DatabaseAggregateGroup {
            key: row.get(0).map_err(sql_failure)?,
            label: row.get(1).map_err(sql_failure)?,
            count: row.get::<_, i64>(2).map_err(sql_failure)?.max(0) as u64,
            value: row.get(3).map_err(sql_failure)?,
        });
        complete_count = row.get::<_, i64>(4).map_err(sql_failure)?.max(0) as u64;
    }
    let total_count = complete_count;
    let mut warnings = Vec::new();
    if category_type.as_deref() == Some("multiSelect") {
        warnings.push("Multi-select groups are limited to the first projected option".to_owned());
    }
    Ok(DatabaseAggregateResult {
        database_id: request.database_id.clone(),
        groups,
        total_count,
        warnings,
    })
}

fn aggregate_field_plan(
    conn: &Connection,
    database_id: &str,
    field: Option<&DatabaseFieldRef>,
) -> Result<AggregateFieldPlan, QueryFailure> {
    let Some(field) = field else {
        return Ok((None, None, Vec::new(), None, Vec::new()));
    };
    match field {
        DatabaseFieldRef::System { field } => {
            let expression = match field.as_str() {
                "title" => "n.title".to_owned(),
                "path" => "m.relative_path".to_owned(),
                "depth" => "CAST(m.depth AS TEXT)".to_owned(),
                "parent" => "m.parent_note_id".to_owned(),
                _ => {
                    return Err(QueryFailure::new(
                        "invalidAggregateField",
                        "unknown category field",
                    ));
                }
            };
            Ok((
                Some("system".to_owned()),
                Some(expression),
                Vec::new(),
                None,
                Vec::new(),
            ))
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
                .ok_or_else(|| QueryFailure::new("missingReference", "aggregate property is missing"))?;
            if property_type == "multiSelect" {
                return Err(QueryFailure::new(
                    "unsupportedAggregateField",
                    "multi-select grouping requires a dedicated group query",
                ));
            }
            let column = match property_type.as_str() {
                "number" => "decimal_value",
                "checkbox" => "CAST(bool_value AS TEXT)",
                "date" => "date_start",
                "select" | "status" => "option_id",
                "text" | "url" => "text_value",
                _ => {
                    return Err(QueryFailure::new(
                        "invalidAggregateField",
                        "property cannot be a category",
                    ));
                }
            };
            let expression = format!(
                "(SELECT {column} FROM db_values cv WHERE cv.database_id = m.database_id AND cv.note_id = m.note_id AND cv.property_id = ?)"
            );
            let (label_expr, label_bindings) = if matches!(
                property_type.as_str(),
                "select" | "status"
            ) {
                (
                    Some("(SELECT o.name FROM db_options o WHERE o.database_id = ? AND o.property_id = ? AND o.option_id = base.category_key)".to_owned()),
                    vec![Value::Text(database_id.to_owned()), Value::Text(property_id.clone())],
                )
            } else {
                (None, Vec::new())
            };
            Ok((
                Some(property_type),
                Some(expression),
                vec![Value::Text(property_id.clone())],
                label_expr,
                label_bindings,
            ))
        }
    }
}

fn aggregate_measure_plan(
    conn: &Connection,
    database_id: &str,
    field: Option<&DatabaseFieldRef>,
    aggregation: &str,
) -> Result<(String, Vec<Value>), QueryFailure> {
    if aggregation == "count" {
        return Ok(("NULL".to_owned(), Vec::new()));
    }
    if !matches!(aggregation, "sum" | "average" | "min" | "max") {
        return Err(QueryFailure::new(
            "invalidAggregateMeasure",
            "measure must be count, sum, average, min, or max",
        ));
    }
    let Some(DatabaseFieldRef::Property { property_id }) = field else {
        return Err(QueryFailure::new(
            "invalidAggregateMeasure",
            "numeric aggregation requires a number property field",
        ));
    };
    let property_type = conn
        .query_row(
            "SELECT property_type FROM db_properties WHERE database_id = ?1 AND property_id = ?2",
            [database_id, property_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(sql_failure)?
        .ok_or_else(|| QueryFailure::new("missingReference", "measure property is missing"))?;
    if property_type != "number" {
        return Err(QueryFailure::new(
            "invalidAggregateMeasure",
            "numeric aggregation requires a number property",
        ));
    }
    Ok((
        "(SELECT decimal_value FROM db_values mv WHERE mv.database_id = m.database_id AND mv.note_id = m.note_id AND mv.property_id = ?)".to_owned(),
        vec![Value::Text(property_id.clone())],
    ))
}

fn compile_search(value: &str, bindings: &mut Vec<Value>) -> String {
    let pattern = format!("%{}%", like_escape(value));
    // Search is deliberately restricted to indexed titles and user-facing
    // property text. All values are bound; `%`, `_` and quotes remain data.
    bindings.push(Value::Text(pattern.clone()));
    bindings.push(Value::Text(pattern));
    "(n.title LIKE ? ESCAPE '\\' COLLATE NOCASE OR EXISTS (SELECT 1 FROM db_values_fts f WHERE f.database_id = m.database_id AND f.note_id = m.note_id AND f.searchable_text LIKE ? ESCAPE '\\' COLLATE NOCASE))".to_owned()
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
            ));
        }
    };
    let nulls = match sort.nulls.as_str() {
        "first" => "first",
        "last" => "last",
        _ => {
            return Err(QueryFailure::new(
                "invalidSort",
                "null placement must be first or last",
            ));
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
                    ));
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
                    ));
                }
            };
            let expression = if matches!(property_type.as_str(), "select" | "status") {
                format!("CAST({alias}.{column} AS BLOB)")
            } else {
                format!("{alias}.{column}")
            };
            (
                expression,
                format!(
                    "LEFT JOIN db_values {alias} ON {alias}.database_id = m.database_id AND {alias}.note_id = m.note_id AND {alias}.property_id = ?"
                ),
                Some(property_id.clone()),
            )
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
            ));
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
        "date" => "date_start_key",
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
        "contains" if matches!(property_type, "select" | "status") => {
            bindings.push(Value::Text(property_id.to_owned()));
            let operand = operand_string(operand)?;
            bindings.push(Value::Text(operand));
            Ok(format!("{exists} = ?)"))
        }
        "contains" if matches!(property_type, "multiSelect" | "multiselect") => {
            bindings.push(Value::Text(property_id.to_owned()));
            let operand = operand_string(operand)?;
            bindings.push(Value::Text(operand));
            Ok("EXISTS (SELECT 1 FROM db_value_options vo WHERE vo.database_id = m.database_id AND vo.note_id = m.note_id AND vo.property_id = ? AND vo.option_id = ?)".to_owned())
        }
        "contains" if property_type == "relation" => {
            bindings.push(Value::Text(property_id.to_owned()));
            let operand = operand_string(operand)?;
            bindings.push(Value::Text(operand));
            Ok("EXISTS (SELECT 1 FROM db_relation_edges re WHERE re.source_database_id = m.database_id AND re.source_note_id = m.note_id AND re.property_id = ? AND re.target_note_id = ?)".to_owned())
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
        "greaterThan" | "lessThan" if property_type == "date" => {
            let operand = operand_string(operand)?;
            let (key, _) = super::projection::date_key(&operand);
            let Some(key) = key else {
                return Err(QueryFailure::new(
                    "invalidOperand",
                    "date operand is not valid date",
                ));
            };
            bindings.push(Value::Text(property_id.to_owned()));
            bindings.push(Value::Integer(key));
            let comparator = if operator == "greaterThan" { ">" } else { "<" };
            Ok(format!(
                "EXISTS (SELECT 1 FROM db_values v WHERE v.database_id = m.database_id AND v.note_id = m.note_id AND v.property_id = ? AND v.date_start_key {comparator} ?)"
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
            .and_then(|value| match value {
                JsonValue::Bool(b) => Some(b),
                JsonValue::String(s) => match s.trim().to_lowercase().as_str() {
                    "true" | "1" => Some(true),
                    "false" | "0" => Some(false),
                    _ => None,
                },
                JsonValue::Number(n) => n.as_i64().map(|v| v != 0),
                _ => None,
            })
            .map(|value| Value::Integer(value as i64))
            .ok_or_else(|| QueryFailure::new("invalidOperand", "checkbox operand must be boolean")),
        "date" => {
            let (key, _) = super::projection::date_key(&operand_string(operand)?);
            key.map(Value::Integer).ok_or_else(|| {
                QueryFailure::new("invalidOperand", "date operand is not valid date")
            })
        }
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
    let encoded = serde_json::to_vec(&(
        request.database_id.as_str(),
        request.search.as_deref().unwrap_or_default(),
        spec,
    ))
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
    let (pairs, remainder) = encoded.as_bytes().as_chunks::<2>();
    debug_assert!(remainder.is_empty());
    for pair in pairs {
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

    // Dynamically resolve reciprocal relation edges for two-way relations
    if let Ok(mut stmt) = conn.prepare(
        "SELECT property_id, config_json FROM db_properties WHERE database_id = ?1 AND property_type = 'relation'",
    ) {
        let relation_props = stmt
            .query_map([database_id], |row| {
                let prop_id: String = row.get(0)?;
                let config_json: String = row.get(1)?;
                Ok((prop_id, config_json))
            })
            .ok()
            .into_iter()
            .flat_map(|mapped| mapped.filter_map(Result::ok))
            .filter_map(|(prop_id, config_json)| {
                let config: serde_json::Value = serde_json::from_str(&config_json).ok()?;
                let inverse_id = config.get("inversePropertyId")?.as_str()?.to_owned();
                Some((prop_id, inverse_id))
            })
            .collect::<Vec<_>>();

        for (prop_id, inverse_id) in relation_props {
            let edge_sql = format!(
                "SELECT target_note_id, source_note_id FROM db_relation_edges WHERE property_id = ? AND target_note_id IN ({placeholders}) AND target_state != 'missing' ORDER BY position"
            );
            let mut edge_bindings = vec![Value::Text(inverse_id)];
            edge_bindings.extend(rows.iter().map(|row| Value::Text(row.note_id.clone())));
            if let Ok(mut edge_stmt) = conn.prepare(&edge_sql) {
                if let Ok(mut edge_rows) = edge_stmt.query(params_from_iter(edge_bindings)) {
                    while let Ok(Some(edge_row)) = edge_rows.next() {
                        let target_note_id: String = edge_row.get(0).unwrap_or_default();
                        let source_note_id: String = edge_row.get(1).unwrap_or_default();
                        if !target_note_id.is_empty() && !source_note_id.is_empty() {
                            let row_vals = values.entry(target_note_id).or_default();
                            let entry = row_vals.entry(prop_id.clone()).or_insert_with(|| {
                                serde_json::json!({
                                    "type": "relation",
                                    "targetNoteIds": []
                                })
                            });
                            if let Some(targets) = entry.get_mut("targetNoteIds").and_then(JsonValue::as_array_mut) {
                                let val = JsonValue::String(source_note_id);
                                if !targets.contains(&val) {
                                    targets.push(val);
                                }
                            }
                        }
                    }
                }
            }
        }
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
            search: None,
            sorts: None,
            filter: None,
        }
    }

    #[test]
    fn aggregate_count_is_calculated_before_pagination() {
        let conn = connection();
        let result = aggregate_database(
            &conn,
            &DatabaseAggregateRequest {
                expected_generation: 1,
                database_id: "01J00000000000000000000000".to_owned(),
                source: DatabaseQuerySource::Inline {
                    spec: DatabaseQuerySpec {
                        filter: None,
                        sorts: Vec::new(),
                    },
                },
                category: None,
                measure: None,
                aggregation: "count".to_owned(),
                search: None,
                limit: 1,
            },
        )
        .unwrap();
        assert_eq!(result.total_count, 3);
        assert_eq!(result.groups.len(), 1);
        assert_eq!(result.groups[0].count, 3);
    }

    #[test]
    fn temporary_filter_is_combined_with_inline_view_filter() {
        let conn = connection();
        let mut request = request(
            Some(DatabaseFilterNode::Condition {
                field: DatabaseFieldRef::System {
                    field: "title".to_owned(),
                },
                operator: "startsWith".to_owned(),
                value: Some(serde_json::json!("A").to_string()),
            }),
            DatabasePageRequest {
                limit: 10,
                cursor: None,
            },
        );
        request.filter = Some(DatabaseFilterNode::Condition {
            field: DatabaseFieldRef::System {
                field: "title".to_owned(),
            },
            operator: "equals".to_owned(),
            value: Some(serde_json::json!("Beta").to_string()),
        });

        let result = query_database(&conn, &request).unwrap();

        assert!(result.rows.is_empty());
        assert_eq!(result.total_count, 0);
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

    #[test]
    fn st09_date_multiselect_relation_filters() {
        let conn = connection();

        // 1. Test date filters
        let (d1, _) = crate::database::projection::date_key("2026-01-01");
        let (d2, _) = crate::database::projection::date_key("2026-06-01");
        let (d3, _) = crate::database::projection::date_key("2026-12-01");
        property(
            &conn,
            "date",
            &[
                Some(serde_json::json!({ "dateKey": d1.unwrap() })),
                Some(serde_json::json!({ "dateKey": d2.unwrap() })),
                Some(serde_json::json!({ "dateKey": d3.unwrap() })),
            ],
        );

        for (operator, operand, expected) in [
            ("equals", "2026-06-01", vec!["Beta"]),
            ("notEquals", "2026-06-01", vec!["Alpha", "Gamma"]),
            ("greaterThan", "2026-05-01", vec!["Beta", "Gamma"]),
            ("lessThan", "2026-05-01", vec!["Alpha"]),
        ] {
            let req = request(
                Some(DatabaseFilterNode::Condition {
                    field: DatabaseFieldRef::Property {
                        property_id: "date".to_owned(),
                    },
                    operator: operator.to_owned(),
                    value: Some(serde_json::json!(operand).to_string()),
                }),
                DatabasePageRequest {
                    limit: 10,
                    cursor: None,
                },
            );
            assert_eq!(all_pages(&conn, req), expected, "date operator {operator}");
        }

        // 2. Test multiselect filter (contains)
        conn.execute(
            "INSERT INTO db_properties (database_id, property_id, position, name, property_type, page_visibility, config_json) VALUES ('01J00000000000000000000000', 'tags', 1, 'tags', 'multiselect', 'alwaysShow', '{}')",
            [],
        ).unwrap();
        // Alpha: opt_a, opt_b
        // Beta: opt_b, opt_c
        // Gamma: opt_c
        for (note_id, opt_id) in [
            ("01J00000000000000000000001", "opt_a"),
            ("01J00000000000000000000001", "opt_b"),
            ("01J00000000000000000000002", "opt_b"),
            ("01J00000000000000000000002", "opt_c"),
            ("01J00000000000000000000003", "opt_c"),
        ] {
            conn.execute(
                "INSERT INTO db_values (database_id, note_id, property_id, value_type, canonical_json, source_revision) VALUES ('01J00000000000000000000000', ?1, 'tags', 'multiselect', '[]', 'record')",
                params![note_id],
            ).ok();
            conn.execute(
                "INSERT INTO db_value_options (database_id, note_id, property_id, option_id, position) VALUES ('01J00000000000000000000000', ?1, 'tags', ?2, 0)",
                params![note_id, opt_id],
            ).unwrap();
        }

        for (operand, expected) in [
            ("opt_a", vec!["Alpha"]),
            ("opt_b", vec!["Alpha", "Beta"]),
            ("opt_c", vec!["Beta", "Gamma"]),
        ] {
            let req = request(
                Some(DatabaseFilterNode::Condition {
                    field: DatabaseFieldRef::Property {
                        property_id: "tags".to_owned(),
                    },
                    operator: "contains".to_owned(),
                    value: Some(serde_json::json!(operand).to_string()),
                }),
                DatabasePageRequest {
                    limit: 10,
                    cursor: None,
                },
            );
            assert_eq!(
                all_pages(&conn, req),
                expected,
                "multiselect contains {operand}"
            );
        }

        // 3. Test relation filter (contains)
        conn.execute(
            "INSERT INTO db_properties (database_id, property_id, position, name, property_type, page_visibility, config_json) VALUES ('01J00000000000000000000000', 'rel', 2, 'rel', 'relation', 'alwaysShow', '{}')",
            [],
        ).unwrap();
        // Alpha -> Beta (01J00000000000000000000002)
        // Gamma -> Beta (01J00000000000000000000002)
        for note_id in ["01J00000000000000000000001", "01J00000000000000000000003"] {
            conn.execute(
                "INSERT INTO db_values (database_id, note_id, property_id, value_type, canonical_json, source_revision) VALUES ('01J00000000000000000000000', ?1, 'rel', 'relation', '[]', 'record')",
                params![note_id],
            ).ok();
            conn.execute(
                "INSERT INTO db_relation_edges (source_database_id, source_note_id, property_id, target_note_id, position, target_state) VALUES ('01J00000000000000000000000', ?1, 'rel', '01J00000000000000000000002', 0, 'linked')",
                params![note_id],
            ).unwrap();
        }

        let req = request(
            Some(DatabaseFilterNode::Condition {
                field: DatabaseFieldRef::Property {
                    property_id: "rel".to_owned(),
                },
                operator: "contains".to_owned(),
                value: Some(serde_json::json!("01J00000000000000000000002").to_string()),
            }),
            DatabasePageRequest {
                limit: 10,
                cursor: None,
            },
        );
        assert_eq!(
            all_pages(&conn, req),
            vec!["Alpha", "Gamma"],
            "relation contains target"
        );
    }
    #[test]
    fn review_canonical_multi_select_filter_is_accepted() {
        let mut bindings = Vec::new();
        let result = compile_property_condition(
            "multiSelect",
            "p",
            "contains",
            Some(serde_json::json!("option-id")),
            &mut bindings,
        );
        assert!(result.is_ok(), "canonical type rejected: {result:?}");
    }
    #[test]
    fn review_checkbox_filter_sent_by_frontend_is_accepted() {
        let mut bindings = Vec::new();
        let result = compile_property_condition(
            "checkbox",
            "p",
            "equals",
            Some(serde_json::json!("true")),
            &mut bindings,
        );
        assert!(result.is_ok(), "frontend operand rejected: {result:?}");
    }
    #[test]
    fn review_select_filter_sent_by_frontend_is_accepted() {
        let mut bindings = Vec::new();
        let result = compile_property_condition(
            "select",
            "p",
            "contains",
            Some(serde_json::json!("option-id")),
            &mut bindings,
        );
        assert!(result.is_ok(), "frontend operator rejected: {result:?}");
    }
}
