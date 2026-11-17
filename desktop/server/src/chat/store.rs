//! Conversations on disk: one 0600 JSON file per conversation in a 0700 folder, replaced atomically, read
//! back only by its owner and only with a valid binding (Luma in the library lobby, or a detected profile).
//! Files written by the former Node server read the same.

use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::library::uuid_v4;

static ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-f0-9-]{36}$").unwrap());
static PROFILE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^profile-[a-f0-9]{24}$").unwrap());
static AGENT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^identity-[a-f0-9]{24}$").unwrap());

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Source {
    pub id: String,
    pub title: String,
    pub revision: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct IdentityFile {
    pub name: String,
    pub revision: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub profile_id: String,
    pub files: Vec<IdentityFile>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Message {
    pub role: String,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub tools: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub sources: Option<Vec<Source>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub identity: Option<Identity>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub id: String,
    pub owner: String,
    pub agent: String,
    pub context: String,
    pub hermes_session_id: String,
    pub messages: Vec<Message>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub profile_id: Option<String>,
}

pub struct Conversations {
    directory: PathBuf,
}

impl Conversations {
    pub fn new(directory: PathBuf) -> Self {
        Self { directory }
    }

    /// A new conversation with Luma, or with a profile's own agent.
    pub fn create(&self, owner: &str, profile: Option<(&str, &str)>) -> std::io::Result<Conversation> {
        let mut conversation = Conversation {
            id: uuid_v4(),
            owner: owner.into(),
            agent: "luma".into(),
            context: "library-lobby".into(),
            hermes_session_id: format!("agora-{}", uuid_v4()),
            messages: vec![],
            profile_id: None,
        };
        if let Some((id, agent)) = profile {
            conversation.profile_id = Some(id.into());
            conversation.agent = agent.into();
            conversation.context = format!("profile-chat:{id}");
        }
        self.save(&conversation)?;
        Ok(conversation)
    }

    pub fn get(&self, id: &str, owner: &str) -> Option<Conversation> {
        if !ID.is_match(id) {
            return None;
        }
        let data: Conversation = serde_json::from_slice(&fs::read(self.directory.join(format!("{id}.json"))).ok()?).ok()?;
        let binding = match &data.profile_id {
            Some(profile) => PROFILE.is_match(profile) && AGENT.is_match(&data.agent) && data.context == format!("profile-chat:{profile}"),
            None => data.agent == "luma" && data.context == "library-lobby",
        };
        (data.owner == owner && binding).then_some(data)
    }

    pub fn save(&self, data: &Conversation) -> std::io::Result<()> {
        crate::platform::create_dir_mode(&self.directory, true, 0o700)?;
        let file = self.directory.join(format!("{}.json", data.id));
        let temporary = self.directory.join(format!("{}.json.{}.tmp", data.id, uuid_v4()));
        let mut handle = crate::platform::create_mode_file(&temporary, false, true, 0o600)?;
        handle.write_all(serde_json::to_string(data)?.as_bytes())?;
        drop(handle);
        fs::rename(temporary, file)
    }
}
