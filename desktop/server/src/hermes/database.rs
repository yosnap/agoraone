//! Hermes' SQLite files opened read-only (no links, no extensions, query_only) for one callback. No Hermes
//! code is involved: its own constructors run migrations even for listing.

use std::collections::HashSet;
use std::path::Path;
use std::time::Duration;

use rusqlite::types::ValueRef;
use rusqlite::{Connection, OpenFlags, Params};
use serde_json::{Map, Value};

use super::safe_read::within;
use crate::platform::{inspect_path_nofollow, is_same_real_path};

pub struct HermesDb<'a> {
    pub conn: &'a Connection,
}

pub type Row = Map<String, Value>;

impl HermesDb<'_> {
    /// Column names of a table (empty if it does not exist).
    pub fn columns(&self, table: &str) -> HashSet<String> {
        let Ok(mut statement) = self.conn.prepare(&format!("PRAGMA table_info({table})")) else { return HashSet::new() };
        statement.query_map([], |row| row.get::<_, String>(1)).map(|rows| rows.flatten().collect()).unwrap_or_default()
    }

    /// Every row of a query as JSON objects keyed by column name.
    pub fn all(&self, sql: &str, params: impl Params) -> rusqlite::Result<Vec<Row>> {
        let mut statement = self.conn.prepare(sql)?;
        let names: Vec<String> = statement.column_names().map(|name| name.to_string()).collect();
        let rows = statement.query_map(params, |row| {
            let mut out = Map::new();
            for (index, name) in names.iter().enumerate() {
                let value = match row.get_ref(index)? {
                    ValueRef::Null | ValueRef::Blob(_) => Value::Null,
                    ValueRef::Integer(i) => Value::from(i),
                    ValueRef::Real(f) => serde_json::Number::from_f64(f).map(Value::Number).unwrap_or(Value::Null),
                    ValueRef::Text(text) => Value::String(String::from_utf8_lossy(text).into_owned()),
                };
                out.insert(name.clone(), value);
            }
            Ok(out)
        })?;
        rows.collect()
    }

    pub fn get(&self, sql: &str, params: impl Params) -> rusqlite::Result<Option<Row>> {
        Ok(self.all(sql, params)?.into_iter().next())
    }
}

/// Runs `read` on a Hermes database; None if the file does not exist, an error if it is a link, a hard link,
/// outside the root or not readable.
pub fn with_hermes_database<T>(root: &Path, file: &Path, read: impl FnOnce(&HermesDb) -> rusqlite::Result<T>) -> anyhow::Result<Option<T>> {
    if !file.exists() && std::fs::symlink_metadata(file).is_err() {
        return Ok(None);
    }
    let meta = inspect_path_nofollow(file)?;
    if !within(root, file) || !is_same_real_path(file)? || !meta.is_file || meta.nlink != 1 {
        anyhow::bail!("Unavailable");
    }
    let conn = Connection::open_with_flags(file, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)?;
    conn.pragma_update(None, "query_only", "ON")?;
    conn.pragma_update(None, "trusted_schema", "OFF")?;
    conn.busy_timeout(Duration::from_millis(200))?;
    Ok(Some(read(&HermesDb { conn: &conn })?))
}

pub struct DatabaseRows {
    pub rows: Vec<Row>,
    pub supported: bool,
}

/// Declared projects and repositories (projects.db) or session folders (state.db): metadata only.
pub fn read_hermes_database(root: &Path, file: &Path, kind: &str) -> anyhow::Result<DatabaseRows> {
    let read = with_hermes_database(root, file, |db| {
        if kind == "projects" {
            let p = db.columns("projects");
            let r = db.columns("discovered_repos");
            let mut rows = Vec::new();
            if ["id", "name", "primary_path", "archived"].iter().all(|key| p.contains(*key)) {
                rows.extend(db.all("SELECT id, name AS label, primary_path AS path, 'project' AS source FROM projects WHERE archived=0 LIMIT 200", [])?);
            }
            if r.contains("root") && r.contains("label") {
                rows.extend(db.all("SELECT root AS path, label, 'repository' AS source FROM discovered_repos LIMIT 200", [])?);
            }
            return Ok(DatabaseRows { rows, supported: !p.is_empty() || !r.is_empty() });
        }
        let s = db.columns("sessions");
        if !s.contains("cwd") {
            return Ok(DatabaseRows { rows: vec![], supported: false });
        }
        // Metadata only. No messages, model config, prompts or chat identifiers are read.
        let rows = db.all("SELECT DISTINCT cwd AS path, 'workspace' AS source FROM sessions WHERE cwd IS NOT NULL AND cwd != '' LIMIT 200", [])?;
        Ok(DatabaseRows { rows, supported: true })
    })?;
    Ok(read.unwrap_or(DatabaseRows { rows: vec![], supported: false }))
}
