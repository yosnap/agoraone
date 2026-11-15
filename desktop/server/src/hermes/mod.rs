//! Everything AgoraOne reads from Hermes' data folder: the catalog of profiles, a profile's identity files,
//! activity, the summary and the MCP tools Hermes cached; and the writes the user confirms from a profile's
//! sheet (identity files, skills, tasks, kanban and MCP calls by hand), with the same protections as before.

pub mod activity;
pub mod activity_log;
pub mod catalog;
pub mod database;
pub mod location;
pub mod manage;
pub mod mcp_call;
pub mod mcp_tools;
pub mod profile_editor;
pub mod python;
pub mod resources;
pub mod routes;
pub mod safe_read;
pub mod skills;
pub mod summary;
pub mod work;
pub mod write_routes;
