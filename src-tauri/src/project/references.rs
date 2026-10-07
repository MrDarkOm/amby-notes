//! The relations of one note, both ways, for the dossier's "Appears in" and "Connections"
//! blocks (`docs/creative-format.md` §10). Computed from the projection on demand and never
//! written into the note.

use rusqlite::{params, Connection};
use serde::Serialize;

use super::model::ProjectError;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum ReferenceDirection {
    /// Another page's relation points at this note.
    In,
    /// This note's own relation points at another page.
    Out,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NoteReference {
    pub direction: ReferenceDirection,
    /// The relation property, in the database of its source.
    pub property_id: String,
    pub property_name: String,
    /// The page on the other end and the database it belongs to.
    pub database_id: Option<String>,
    pub database_name: Option<String>,
    pub note_id: String,
    /// None when the other page is not in the index (deleted or not yet indexed).
    pub title: Option<String>,
}

fn query(
    connection: &Connection,
    direction: ReferenceDirection,
    note_id: &str,
) -> Result<Vec<NoteReference>, ProjectError> {
    // `near` is the note asked about, `far` the one on the other end.
    let (near, far) = match direction {
        ReferenceDirection::Out => ("source", "target"),
        ReferenceDirection::In => ("target", "source"),
    };
    let sql = format!(
        "SELECT e.property_id, p.name, m.database_id, d.name, e.{far}_note_id, n.title
         FROM db_relation_edges e
         JOIN db_properties p ON p.database_id = e.source_database_id AND p.property_id = e.property_id
         LEFT JOIN db_members m ON m.note_id = e.{far}_note_id
         LEFT JOIN db_databases d ON d.database_id = m.database_id
         LEFT JOIN notes n ON n.id = e.{far}_note_id
         WHERE e.{near}_note_id = ?1
         ORDER BY p.position, e.position, n.title"
    );
    let failed =
        |error: rusqlite::Error| ProjectError::failed("projectIndexFailed", error.to_string());
    let mut statement = connection.prepare(&sql).map_err(failed)?;
    let rows = statement
        .query_map(params![note_id], |row| {
            Ok(NoteReference {
                direction,
                property_id: row.get(0)?,
                property_name: row.get(1)?,
                database_id: row.get(2)?,
                database_name: row.get(3)?,
                note_id: row.get(4)?,
                title: row.get(5)?,
            })
        })
        .map_err(failed)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(failed)?;
    Ok(rows)
}

/// Incoming references first, then outgoing, each in the order of the relation properties.
pub fn list_references(
    connection: &Connection,
    note_id: &str,
) -> Result<Vec<NoteReference>, ProjectError> {
    let mut references = query(connection, ReferenceDirection::In, note_id)?;
    references.extend(query(connection, ReferenceDirection::Out, note_id)?);
    Ok(references)
}
