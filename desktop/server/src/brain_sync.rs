//! Keeps the core's index in step with the Obsidian vaults. Notes are read here, with the vault reader's
//! rules (Markdown only, no symlinks or hidden folders, size limit) and with credential-like lines masked,
//! so the core only ever receives clean text and never reads the disk itself. Same rules as the former
//! server/brain-sync.ts.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::Serialize;
use serde_json::{Value, json};

use crate::core::{CoreLink, core_request};
use crate::hermes::resources::obsidian_vaults;
use crate::js::utf16_len;
use crate::secret_lines::mask_secrets;
use crate::vault::{VaultNote, VaultNotes};

const INTERVAL: Duration = Duration::from_secs(5 * 60);
const RETRY: Duration = Duration::from_secs(30);
const FIRST_RUN: Duration = Duration::from_secs(5);
const MAX_BATCH_UNITS: usize = 512 * 1024;
const MAX_BATCH_NOTES: usize = 100;

#[derive(Serialize, Default, Debug, PartialEq, Eq, Clone, Copy)]
pub struct SyncReport {
    pub vaults: usize,
    pub sent: usize,
    pub removed: usize,
    pub skipped: usize,
    pub failed: usize,
}

/// What decides whether a note changed: cheap to compute without reading it.
fn revision(note: &VaultNote) -> String {
    format!("{}|{}", note.modified_at, note.bytes)
}

/// A title or folder name that looks like a credential is hidden like a note line.
fn masked(name: &str) -> String {
    if mask_secrets(name).hidden.is_empty() { name.to_string() } else { "[nombre oculto]".into() }
}

fn removed(answer: &Value) -> usize {
    answer.get("removed").and_then(Value::as_u64).unwrap_or(0) as usize
}

pub struct BrainSync {
    vault: Arc<VaultNotes>,
    link: CoreLink,
    registry: Option<PathBuf>,
    http: reqwest::Client,
    running: AtomicBool,
}

impl BrainSync {
    pub fn new(vault: Arc<VaultNotes>, link: CoreLink, registry: Option<PathBuf>, http: reqwest::Client) -> Arc<Self> {
        Arc::new(Self { vault, link, registry, http, running: AtomicBool::new(false) })
    }

    /// First run a few seconds after start, then every five minutes; sooner again if the core was not ready.
    pub fn start(self: Arc<Self>) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            let mut wait = FIRST_RUN;
            loop {
                tokio::time::sleep(wait).await;
                wait = match self.sync().await {
                    Ok(report) if report.failed == 0 => INTERVAL,
                    Ok(_) => RETRY,
                    Err(error) => {
                        eprintln!("AgoraOne: índice del cerebro sin actualizar ({error}).");
                        RETRY
                    }
                };
            }
        })
    }

    pub async fn sync(&self) -> anyhow::Result<SyncReport> {
        let mut report = SyncReport::default();
        if self.running.swap(true, Ordering::SeqCst) {
            return Ok(report);
        }
        let result = self.sync_all(&mut report).await;
        self.running.store(false, Ordering::SeqCst);
        result.map(|_| report)
    }

    async fn sync_all(&self, report: &mut SyncReport) -> anyhow::Result<()> {
        let registry = self.registry.clone();
        let vaults = tokio::task::spawn_blocking(move || obsidian_vaults(registry.as_deref())).await?;
        // Vaults that left Obsidian's registry leave the index; not when the registry could not be read.
        if vaults.warnings.is_empty() {
            let keep: Vec<&str> = vaults.vaults.iter().map(|v| v.id.as_str()).collect();
            report.removed += removed(&self.core("/internal/index/sources", Some(json!({ "keep": keep }))).await?);
        }
        // One vault failing (unreadable, rejected batch) must not leave the others unindexed.
        for vault in vaults.vaults.iter().filter(|v| v.available) {
            match self.sync_vault(&vault.id, report).await {
                Ok(()) => report.vaults += 1,
                Err(error) => {
                    report.failed += 1;
                    eprintln!("AgoraOne: no se pudo indexar un vault ({error}).");
                }
            }
        }
        Ok(())
    }

    async fn core(&self, path: &str, body: Option<Value>) -> anyhow::Result<Value> {
        core_request(&self.http, &self.link, path, body.as_ref()).await
    }

    async fn sync_vault(&self, vault_id: &str, report: &mut SyncReport) -> anyhow::Result<()> {
        let (vault, id) = (self.vault.clone(), vault_id.to_string());
        let listed = tokio::task::spawn_blocking(move || vault.list(&id, true)).await??;
        let state = self.core(&format!("/internal/index/state?source={vault_id}"), None).await?;
        let refs = state.get("refs").and_then(Value::as_object).cloned().unwrap_or_default();
        let readable: Vec<&VaultNote> = listed.notes.iter().filter(|n| n.readable).collect();
        report.skipped += listed.notes.len() - readable.len();
        let mut batch: Vec<Value> = Vec::new();
        let mut size = 0;
        for note in readable.iter().filter(|n| refs.get(&n.id).and_then(Value::as_str) != Some(revision(n).as_str())) {
            let (vault, id, note_id) = (self.vault.clone(), vault_id.to_string(), note.id.clone());
            let text = match tokio::task::spawn_blocking(move || vault.read(&id, &note_id, false)).await? {
                Ok(read) => read.content,
                Err(_) => {
                    report.skipped += 1;
                    continue;
                }
            };
            size += utf16_len(&text);
            batch.push(json!({ "ref": note.id, "title": masked(&note.title), "folder": masked(&note.folder), "revision": revision(note), "modifiedAt": note.modified_at, "text": text }));
            if size >= MAX_BATCH_UNITS || batch.len() >= MAX_BATCH_NOTES {
                self.flush(vault_id, &listed.vault.name, &mut batch, report).await?;
                size = 0;
            }
        }
        self.flush(vault_id, &listed.vault.name, &mut batch, report).await?;
        // A truncated walk does not list every note: removing the unlisted ones would empty the index.
        if !listed.truncated {
            let present: std::collections::HashSet<&str> = readable.iter().map(|n| n.id.as_str()).collect();
            let gone: Vec<&String> = refs.keys().filter(|r| !present.contains(r.as_str())).collect();
            if !gone.is_empty() {
                report.removed += removed(&self.core("/internal/index/remove", Some(json!({ "source": vault_id, "refs": gone }))).await?);
            }
        }
        Ok(())
    }

    async fn flush(&self, source: &str, name: &str, batch: &mut Vec<Value>, report: &mut SyncReport) -> anyhow::Result<()> {
        if batch.is_empty() {
            return Ok(());
        }
        let notes = std::mem::take(batch);
        let count = notes.len();
        self.core("/internal/index/notes", Some(json!({ "source": source, "sourceName": name, "notes": notes }))).await?;
        report.sent += count;
        Ok(())
    }
}
