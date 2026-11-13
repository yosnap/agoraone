//! Everything AgoraOne reads from Hermes' data folder: the catalog of profiles, a profile's identity files,
//! activity, the summary and the MCP tools Hermes cached. Read only, with the same protections as before.

pub mod activity;
pub mod activity_log;
pub mod catalog;
pub mod database;
pub mod location;
pub mod mcp_tools;
pub mod resources;
pub mod routes;
pub mod safe_read;
pub mod summary;
