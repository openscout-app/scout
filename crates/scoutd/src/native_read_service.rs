use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub const REQUEST_SCHEMA: &str = "openscout.native.read.request/v1";
pub const SNAPSHOT_SCHEMA: &str = "openscout.native.read.snapshot/v1";
pub const EVENT_SCHEMA: &str = "openscout.native.read.event/v1";
const CACHE_SCHEMA: &str = "openscout.native.read.cache/v1";
pub const FEED_CACHE_SCHEMA: &str = "openscout.native.read.feed-cache/v1";
pub const THREAD_CACHE_SCHEMA: &str = "openscout.native.read.thread-cache/v1";
const DEFAULT_LIMIT: usize = 10;
const MAX_AGENT_LIMIT: usize = 100;
pub const MAX_FEED_LIMIT: usize = 160;
pub const MAX_THREAD_MESSAGE_LIMIT: usize = 64;
const MAX_FEED_ARTIFACT_BYTES: u64 = 256 * 1024;
const MAX_THREAD_ARTIFACT_BYTES: u64 = 256 * 1024;
const MAX_THREAD_ARTIFACTS: usize = 32;
// Shared wire limits: packages/runtime/src/broker-journal-framing.ts.
const MAX_JOURNAL_FRAME_BYTES: usize = 16 * 1024 * 1024;
const MAX_JOURNAL_BATCH_ENTRIES: usize = 4096;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeReadRequest {
    #[serde(default)]
    pub request_id: Option<String>,
    pub resource: String,
    #[serde(default)]
    pub mode: NativeReadMode,
    #[serde(default)]
    pub limit: Option<usize>,
    #[serde(default)]
    pub after_sequence: Option<u64>,
    #[serde(default)]
    pub feed_id: Option<String>,
    #[serde(default)]
    pub conversation_id: Option<String>,
}

impl NativeReadRequest {
    pub fn normalized_limit(&self) -> usize {
        let maximum = match self.resource.as_str() {
            "feed" => MAX_FEED_LIMIT,
            "thread" => MAX_THREAD_MESSAGE_LIMIT,
            _ => MAX_AGENT_LIMIT,
        };
        self.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, maximum)
    }

    pub fn request_id(&self) -> &str {
        self.request_id.as_deref().unwrap_or("")
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum NativeReadMode {
    #[default]
    Snapshot,
    Subscribe,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JournalAgent {
    id: String,
    #[serde(default)]
    display_name: String,
    #[serde(default)]
    handle: Option<String>,
    #[serde(default)]
    agent_class: Option<String>,
    #[serde(default)]
    selector: Option<String>,
    #[serde(default)]
    capabilities: Vec<String>,
    #[serde(default)]
    home_node_id: Option<String>,
    #[serde(default)]
    authority_node_id: Option<String>,
    #[serde(default)]
    metadata: Map<String, Value>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JournalEndpoint {
    id: String,
    agent_id: String,
    #[serde(default)]
    harness: Option<String>,
    #[serde(default)]
    transport: Option<String>,
    #[serde(default)]
    state: Option<String>,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    project_root: Option<String>,
    #[serde(default)]
    metadata: Map<String, Value>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JournalNode {
    id: String,
    #[serde(default)]
    name: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JournalFlight {
    id: String,
    target_agent_id: String,
    state: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAgentSummary {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub handle: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_class: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub harness: Option<String>,
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_root: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selector: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transport: Option<String>,
    pub capabilities: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub authority_node_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub home_node_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub harness_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeAgentsSnapshot {
    pub schema: &'static str,
    #[serde(rename = "type")]
    pub event_type: &'static str,
    pub request_id: String,
    pub sequence: u64,
    pub generated_at: u128,
    pub source_updated_at: u128,
    pub source: &'static str,
    pub agents: Vec<NativeAgentSummary>,
    pub has_more: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeReadHeartbeat {
    pub schema: &'static str,
    #[serde(rename = "type")]
    pub event_type: &'static str,
    pub request_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub projection_id: Option<String>,
    pub sequence: u64,
    pub generated_at: u128,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedProjection {
    schema: String,
    sequence: u64,
    generated_at: u128,
    source_updated_at: u128,
    agents: Vec<NativeAgentSummary>,
    // Added to the v1 cache after agent snapshots became retention-bounded.
    // Default keeps caches written by older scoutd builds readable.
    #[serde(default)]
    has_more: bool,
}

#[derive(Clone, Debug, Default)]
struct PublishedProjection {
    sequence: u64,
    generated_at: u128,
    source_updated_at: u128,
    agents: Vec<NativeAgentSummary>,
    has_more: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct NativeFeedArtifact {
    schema: String,
    version: u32,
    projection_id: String,
    projection_version: u32,
    sequence: u64,
    generated_at: u128,
    source_fresh_at: Option<u128>,
    items: Vec<Value>,
    total: usize,
    has_more: bool,
    engaged_feed_id: Option<String>,
    identity_redirects: Vec<Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NativeThreadMessage {
    pub id: String,
    pub actor_id: String,
    pub actor_name: Option<String>,
    pub body: String,
    pub class: String,
    pub created_at: u128,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct NativeThreadArtifact {
    schema: String,
    version: u32,
    projection_id: String,
    projection_version: u32,
    sequence: u64,
    // The feed sequence does not advance for every retained message-body
    // correction. New producers therefore include a digest of the bounded
    // thread page; Option keeps pre-cursor v1 artifacts readable during
    // rolling upgrades.
    #[serde(default)]
    content_cursor: Option<String>,
    feed_id: String,
    entity_kind: String,
    conversation_id: String,
    cursor: Option<String>,
    has_earlier: bool,
    generated_at: u128,
    messages: Vec<NativeThreadMessage>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NativeFeedSnapshot {
    pub schema: &'static str,
    #[serde(rename = "type")]
    pub event_type: &'static str,
    pub request_id: String,
    pub projection_id: String,
    pub projection_version: u32,
    pub sequence: u64,
    pub generated_at: u128,
    pub source_fresh_at: Option<u128>,
    pub items: Vec<Value>,
    pub total: usize,
    pub has_more: bool,
    pub engaged_feed_id: Option<String>,
    pub identity_redirects: Vec<Value>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NativeThreadSnapshot {
    pub schema: &'static str,
    #[serde(rename = "type")]
    pub event_type: &'static str,
    pub request_id: String,
    pub projection_id: String,
    pub projection_version: u32,
    pub sequence: u64,
    pub feed_id: String,
    pub entity_kind: &'static str,
    pub conversation_id: String,
    pub cursor: Option<String>,
    pub has_earlier: bool,
    pub generated_at: u128,
    pub messages: Vec<NativeThreadMessage>,
}

#[derive(Clone, Debug, Default)]
struct PublishedFeedProjection {
    // This is a scoutd-local wake cursor. It deliberately does not reuse the
    // broker sequence because a rebuilt projection lineage may restart at a
    // lower sequence and must still wake subscribers.
    revision: u64,
    artifact: Option<NativeFeedArtifact>,
}

#[derive(Clone, Debug)]
struct PublishedThreadArtifact {
    revision: u64,
    artifact: NativeThreadArtifact,
}

#[derive(Clone, Debug, Default)]
struct PublishedThreadProjection {
    next_revision: u64,
    artifacts: HashMap<String, PublishedThreadArtifact>,
}

#[derive(Clone, Debug)]
pub struct NativeReadService {
    state: Arc<(Mutex<PublishedProjection>, Condvar)>,
    feed_state: Arc<(Mutex<PublishedFeedProjection>, Condvar)>,
    thread_state: Arc<(Mutex<PublishedThreadProjection>, Condvar)>,
}

impl NativeReadService {
    pub fn start(
        journal_path: PathBuf,
        cache_path: PathBuf,
        feed_artifact_path: PathBuf,
        thread_artifact_directory: PathBuf,
        poll_interval: Duration,
    ) -> Self {
        let initial = load_cached_projection(&cache_path).unwrap_or_default();
        let initial_feed = load_feed_artifact(&feed_artifact_path).ok();
        let initial_threads = load_thread_artifacts(&thread_artifact_directory);
        let mut published_threads = PublishedThreadProjection::default();
        for artifact in initial_threads {
            published_threads.next_revision = published_threads.next_revision.saturating_add(1);
            published_threads.artifacts.insert(
                artifact.feed_id.clone(),
                PublishedThreadArtifact {
                    revision: published_threads.next_revision,
                    artifact,
                },
            );
        }
        let service = Self {
            state: Arc::new((Mutex::new(initial), Condvar::new())),
            feed_state: Arc::new((
                Mutex::new(PublishedFeedProjection {
                    revision: u64::from(initial_feed.is_some()),
                    artifact: initial_feed,
                }),
                Condvar::new(),
            )),
            thread_state: Arc::new((Mutex::new(published_threads), Condvar::new())),
        };
        let agent_worker = service.clone();
        thread::Builder::new()
            .name("scoutd-native-read-agents".to_string())
            .spawn(move || {
                run_projection_watcher(agent_worker, journal_path, cache_path, poll_interval)
            })
            .expect("failed to start scoutd native-read projection thread");
        let feed_worker = service.clone();
        thread::Builder::new()
            .name("scoutd-native-read-feed".to_string())
            .spawn(move || {
                run_feed_artifact_watcher(feed_worker, feed_artifact_path, poll_interval)
            })
            .expect("failed to start scoutd native-read feed thread");
        let thread_worker = service.clone();
        thread::Builder::new()
            .name("scoutd-native-read-thread".to_string())
            .spawn(move || {
                run_thread_artifact_watcher(thread_worker, thread_artifact_directory, poll_interval)
            })
            .expect("failed to start scoutd native-read thread artifact thread");
        service
    }

    pub fn snapshot(&self, request: &NativeReadRequest) -> NativeAgentsSnapshot {
        let (lock, _) = &*self.state;
        let projection = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        snapshot_for_projection(&projection, request)
    }

    pub fn wait_for_change(
        &self,
        request: &NativeReadRequest,
        after_sequence: u64,
        timeout: Duration,
    ) -> Option<NativeAgentsSnapshot> {
        let (lock, cvar) = &*self.state;
        let projection = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if projection.sequence > after_sequence {
            return Some(snapshot_for_projection(&projection, request));
        }
        let (projection, _) = cvar
            .wait_timeout_while(projection, timeout, |state| {
                state.sequence <= after_sequence
            })
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        (projection.sequence > after_sequence)
            .then(|| snapshot_for_projection(&projection, request))
    }

    pub fn heartbeat(&self, request: &NativeReadRequest) -> NativeReadHeartbeat {
        let (lock, _) = &*self.state;
        let projection = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        NativeReadHeartbeat {
            schema: EVENT_SCHEMA,
            event_type: "heartbeat",
            request_id: request.request_id().to_string(),
            projection_id: None,
            sequence: projection.sequence,
            generated_at: epoch_ms(),
        }
    }

    pub fn feed_snapshot(&self, request: &NativeReadRequest) -> Option<(u64, NativeFeedSnapshot)> {
        let (lock, _) = &*self.feed_state;
        let projection = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let artifact = projection.artifact.as_ref()?;
        Some((
            projection.revision,
            feed_snapshot_for_artifact(artifact, request),
        ))
    }

    pub fn wait_for_feed_change(
        &self,
        request: &NativeReadRequest,
        after_revision: u64,
        timeout: Duration,
    ) -> Option<(u64, NativeFeedSnapshot)> {
        let (lock, cvar) = &*self.feed_state;
        let projection = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let (projection, _) = cvar
            .wait_timeout_while(projection, timeout, |state| {
                state.revision <= after_revision
            })
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if projection.revision <= after_revision {
            return None;
        }
        let artifact = projection.artifact.as_ref()?;
        Some((
            projection.revision,
            feed_snapshot_for_artifact(artifact, request),
        ))
    }

    pub fn feed_heartbeat(&self, request: &NativeReadRequest) -> Option<NativeReadHeartbeat> {
        let (lock, _) = &*self.feed_state;
        let projection = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let artifact = projection.artifact.as_ref()?;
        Some(NativeReadHeartbeat {
            schema: EVENT_SCHEMA,
            event_type: "heartbeat",
            request_id: request.request_id().to_string(),
            projection_id: Some(artifact.projection_id.clone()),
            sequence: artifact.sequence,
            generated_at: epoch_ms(),
        })
    }

    pub fn thread_snapshot(
        &self,
        request: &NativeReadRequest,
    ) -> Option<(u64, NativeThreadSnapshot)> {
        let feed_id = request.feed_id.as_deref()?;
        let (lock, _) = &*self.thread_state;
        let projection = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let published = projection.artifacts.get(feed_id)?;
        if request
            .conversation_id
            .as_deref()
            .is_some_and(|conversation_id| conversation_id != published.artifact.conversation_id)
        {
            return None;
        }
        Some((
            published.revision,
            thread_snapshot_for_artifact(&published.artifact, request),
        ))
    }

    pub fn wait_for_thread_change(
        &self,
        request: &NativeReadRequest,
        after_revision: u64,
        timeout: Duration,
    ) -> Option<(u64, NativeThreadSnapshot)> {
        let feed_id = request.feed_id.as_deref()?;
        let (lock, cvar) = &*self.thread_state;
        let projection = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let (projection, _) = cvar
            .wait_timeout_while(projection, timeout, |state| {
                state
                    .artifacts
                    .get(feed_id)
                    .map(|published| published.revision <= after_revision)
                    .unwrap_or(true)
            })
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let published = projection.artifacts.get(feed_id)?;
        if published.revision <= after_revision {
            return None;
        }
        Some((
            published.revision,
            thread_snapshot_for_artifact(&published.artifact, request),
        ))
    }

    pub fn thread_heartbeat(&self, request: &NativeReadRequest) -> Option<NativeReadHeartbeat> {
        let feed_id = request.feed_id.as_deref()?;
        let (lock, _) = &*self.thread_state;
        let projection = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let artifact = &projection.artifacts.get(feed_id)?.artifact;
        Some(NativeReadHeartbeat {
            schema: EVENT_SCHEMA,
            event_type: "heartbeat",
            request_id: request.request_id().to_string(),
            projection_id: Some(artifact.projection_id.clone()),
            sequence: artifact.sequence,
            generated_at: epoch_ms(),
        })
    }

    fn publish_feed(&self, artifact: NativeFeedArtifact) {
        let (lock, cvar) = &*self.feed_state;
        let mut state = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let should_publish = match state.artifact.as_ref() {
            None => true,
            Some(current) if current.projection_id == artifact.projection_id => {
                artifact.sequence > current.sequence
            }
            // Sequences are comparable only inside one broker projection
            // lineage. A new lineage is therefore one atomic replacement even
            // when its sequence restarts below the prior value.
            Some(_) => true,
        };
        if !should_publish {
            return;
        }
        state.revision = state.revision.saturating_add(1);
        state.artifact = Some(artifact);
        cvar.notify_all();
    }

    fn reconcile_thread_artifacts(
        &self,
        retained_feed_ids: &HashSet<String>,
        updates: Vec<NativeThreadArtifact>,
    ) {
        let (lock, cvar) = &*self.thread_state;
        let mut state = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut changed = false;
        let previous_len = state.artifacts.len();
        state
            .artifacts
            .retain(|feed_id, _| retained_feed_ids.contains(feed_id));
        changed |= state.artifacts.len() != previous_len;

        for artifact in updates {
            let should_publish = match state.artifacts.get(&artifact.feed_id) {
                None => true,
                Some(current) if current.artifact.projection_id == artifact.projection_id => {
                    artifact.sequence > current.artifact.sequence
                        || (artifact.sequence == current.artifact.sequence
                            && artifact.content_cursor.is_some()
                            && artifact.content_cursor != current.artifact.content_cursor)
                }
                // Thread sequences are comparable only inside one projection
                // lineage. A rebuilt lineage replaces atomically.
                Some(_) => true,
            };
            if !should_publish {
                continue;
            }
            state.next_revision = state.next_revision.saturating_add(1);
            let revision = state.next_revision;
            state.artifacts.insert(
                artifact.feed_id.clone(),
                PublishedThreadArtifact { revision, artifact },
            );
            changed = true;
        }

        while state.artifacts.len() > MAX_THREAD_ARTIFACTS {
            let oldest_feed_id = state
                .artifacts
                .iter()
                .min_by_key(|(_, published)| published.revision)
                .map(|(feed_id, _)| feed_id.clone());
            let Some(feed_id) = oldest_feed_id else {
                break;
            };
            state.artifacts.remove(&feed_id);
            changed = true;
        }
        if changed {
            cvar.notify_all();
        }
    }

    fn publish(
        &self,
        mut agents: Vec<NativeAgentSummary>,
        source_updated_at: u128,
        cache_path: &Path,
    ) {
        let has_more = agents.len() > MAX_AGENT_LIMIT;
        agents.truncate(MAX_AGENT_LIMIT);
        let cached;
        {
            let (lock, cvar) = &*self.state;
            let mut state = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            // Unrelated broker journal traffic (messages, deliveries, etc.) must
            // not wake native agent-list subscribers. The source timestamp is
            // the timestamp of the last change that materially altered this
            // projection, not the journal's latest append of any kind.
            if state.agents == agents && state.has_more == has_more {
                return;
            }
            state.sequence = state.sequence.saturating_add(1);
            state.generated_at = epoch_ms();
            state.source_updated_at = source_updated_at;
            state.agents = agents;
            state.has_more = has_more;
            cached = CachedProjection {
                schema: CACHE_SCHEMA.to_string(),
                sequence: state.sequence,
                generated_at: state.generated_at,
                source_updated_at: state.source_updated_at,
                agents: state.agents.clone(),
                has_more: state.has_more,
            };
            cvar.notify_all();
        }
        if let Err(error) = persist_cached_projection(cache_path, &cached) {
            eprintln!("[scoutd native-read] failed to persist projection: {error}");
        }
    }
}

fn feed_snapshot_for_artifact(
    artifact: &NativeFeedArtifact,
    request: &NativeReadRequest,
) -> NativeFeedSnapshot {
    let limit = request.normalized_limit();
    let items = artifact
        .items
        .iter()
        .take(limit)
        .cloned()
        .collect::<Vec<_>>();
    NativeFeedSnapshot {
        schema: SNAPSHOT_SCHEMA,
        event_type: "feed.snapshot",
        request_id: request.request_id().to_string(),
        projection_id: artifact.projection_id.clone(),
        projection_version: artifact.projection_version,
        sequence: artifact.sequence,
        generated_at: artifact.generated_at,
        source_fresh_at: artifact.source_fresh_at,
        has_more: artifact.has_more || artifact.total > items.len(),
        items,
        total: artifact.total,
        engaged_feed_id: artifact.engaged_feed_id.clone(),
        identity_redirects: artifact.identity_redirects.clone(),
    }
}

fn thread_snapshot_for_artifact(
    artifact: &NativeThreadArtifact,
    request: &NativeReadRequest,
) -> NativeThreadSnapshot {
    let limit = request.normalized_limit();
    let skipped = artifact.messages.len().saturating_sub(limit);
    let messages = artifact.messages[skipped..].to_vec();
    NativeThreadSnapshot {
        schema: SNAPSHOT_SCHEMA,
        event_type: "thread.snapshot",
        request_id: request.request_id().to_string(),
        projection_id: artifact.projection_id.clone(),
        projection_version: artifact.projection_version,
        sequence: artifact.sequence,
        feed_id: artifact.feed_id.clone(),
        entity_kind: "scout_conversation",
        conversation_id: artifact.conversation_id.clone(),
        cursor: messages.first().map(|message| message.id.clone()),
        has_earlier: artifact.has_earlier || skipped > 0,
        generated_at: artifact.generated_at,
        messages,
    }
}

fn load_feed_artifact(path: &Path) -> Result<NativeFeedArtifact, String> {
    let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
    if metadata.len() > MAX_FEED_ARTIFACT_BYTES {
        return Err(format!(
            "feed artifact exceeds {} byte limit",
            MAX_FEED_ARTIFACT_BYTES
        ));
    }
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_FEED_ARTIFACT_BYTES {
        return Err(format!(
            "feed artifact exceeds {} byte limit",
            MAX_FEED_ARTIFACT_BYTES
        ));
    }
    let artifact: NativeFeedArtifact =
        serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    if artifact.schema != FEED_CACHE_SCHEMA || artifact.version != 1 {
        return Err(format!(
            "unsupported feed artifact schema/version: {}/{}",
            artifact.schema, artifact.version
        ));
    }
    if artifact.projection_id.trim().is_empty() {
        return Err("feed artifact projectionId is empty".to_string());
    }
    if artifact.items.len() > MAX_FEED_LIMIT {
        return Err(format!(
            "feed artifact contains {} items; maximum is {}",
            artifact.items.len(),
            MAX_FEED_LIMIT
        ));
    }
    if artifact.total < artifact.items.len() {
        return Err("feed artifact total is smaller than its item count".to_string());
    }
    Ok(artifact)
}

fn load_thread_artifact(path: &Path) -> Result<NativeThreadArtifact, String> {
    let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
    if metadata.len() > MAX_THREAD_ARTIFACT_BYTES {
        return Err(format!(
            "thread artifact exceeds {} byte limit",
            MAX_THREAD_ARTIFACT_BYTES
        ));
    }
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_THREAD_ARTIFACT_BYTES {
        return Err(format!(
            "thread artifact exceeds {} byte limit",
            MAX_THREAD_ARTIFACT_BYTES
        ));
    }
    let artifact: NativeThreadArtifact =
        serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    if artifact.schema != THREAD_CACHE_SCHEMA || artifact.version != 1 {
        return Err(format!(
            "unsupported thread artifact schema/version: {}/{}",
            artifact.schema, artifact.version
        ));
    }
    if artifact.projection_id.trim().is_empty() {
        return Err("thread artifact projectionId is empty".to_string());
    }
    if artifact.content_cursor.as_deref().is_some_and(|cursor| {
        cursor.len() != 64 || !cursor.bytes().all(|byte| byte.is_ascii_hexdigit())
    }) {
        return Err("thread artifact contentCursor is not a SHA-256 digest".to_string());
    }
    if artifact.entity_kind != "scout_conversation" {
        return Err("thread artifact entityKind is not scout_conversation".to_string());
    }
    if artifact.feed_id != format!("conv:{}", artifact.conversation_id) {
        return Err("thread artifact feedId/conversationId identity mismatch".to_string());
    }
    if artifact.messages.len() > MAX_THREAD_MESSAGE_LIMIT {
        return Err(format!(
            "thread artifact contains {} messages; maximum is {}",
            artifact.messages.len(),
            MAX_THREAD_MESSAGE_LIMIT
        ));
    }
    let expected_cursor = artifact.messages.first().map(|message| message.id.as_str());
    if artifact.cursor.as_deref() != expected_cursor {
        return Err("thread artifact cursor does not identify its first message".to_string());
    }
    Ok(artifact)
}

fn thread_artifact_candidates(directory: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(directory) else {
        return Vec::new();
    };
    let mut candidates = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            let name = path.file_name()?.to_str()?;
            if !name.starts_with("native-read-thread-") || !name.ends_with(".json") {
                return None;
            }
            let metadata = entry.metadata().ok()?;
            if !metadata.is_file() || metadata.len() > MAX_THREAD_ARTIFACT_BYTES {
                return None;
            }
            Some((
                path,
                metadata.modified().unwrap_or(UNIX_EPOCH),
                metadata.len(),
            ))
        })
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| {
        right
            .1
            .cmp(&left.1)
            .then_with(|| right.2.cmp(&left.2))
            .then_with(|| left.0.cmp(&right.0))
    });
    candidates
        .into_iter()
        .take(MAX_THREAD_ARTIFACTS)
        .map(|entry| entry.0)
        .collect()
}

fn load_thread_artifacts(directory: &Path) -> Vec<NativeThreadArtifact> {
    let mut seen_feed_ids = HashMap::<String, ()>::new();
    let mut artifacts = Vec::new();
    for path in thread_artifact_candidates(directory) {
        let Ok(artifact) = load_thread_artifact(&path) else {
            continue;
        };
        if seen_feed_ids.insert(artifact.feed_id.clone(), ()).is_some() {
            continue;
        }
        artifacts.push(artifact);
    }
    artifacts
}

fn snapshot_for_projection(
    projection: &PublishedProjection,
    request: &NativeReadRequest,
) -> NativeAgentsSnapshot {
    let limit = request.normalized_limit();
    NativeAgentsSnapshot {
        schema: SNAPSHOT_SCHEMA,
        event_type: "agents.snapshot",
        request_id: request.request_id().to_string(),
        sequence: projection.sequence,
        generated_at: epoch_ms(),
        source_updated_at: projection.source_updated_at,
        source: "broker-journal",
        agents: projection.agents.iter().take(limit).cloned().collect(),
        has_more: projection.has_more || projection.agents.len() > limit,
    }
}

fn load_cached_projection(path: &Path) -> Option<PublishedProjection> {
    let bytes = fs::read(path).ok()?;
    let mut cached: CachedProjection = serde_json::from_slice(&bytes).ok()?;
    if cached.schema != CACHE_SCHEMA {
        return None;
    }
    let overflow = cached.agents.len() > MAX_AGENT_LIMIT;
    cached.agents.truncate(MAX_AGENT_LIMIT);
    Some(PublishedProjection {
        sequence: cached.sequence,
        generated_at: cached.generated_at,
        source_updated_at: cached.source_updated_at,
        agents: cached.agents,
        has_more: cached.has_more || overflow,
    })
}

fn persist_cached_projection(path: &Path, projection: &CachedProjection) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "cache path has no parent".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = path.with_extension(format!("tmp-{}", std::process::id()));
    let payload = serde_json::to_vec(projection).map_err(|error| error.to_string())?;
    fs::write(&temporary, payload).map_err(|error| error.to_string())?;
    fs::rename(&temporary, path).map_err(|error| error.to_string())
}

#[derive(Default)]
struct JournalProjection {
    agents: HashMap<String, JournalAgent>,
    endpoints: HashMap<String, JournalEndpoint>,
    nodes: HashMap<String, JournalNode>,
    flights: HashMap<String, JournalFlight>,
}

impl JournalProjection {
    fn apply_line(&mut self, line: &str) -> bool {
        if line.trim_end_matches('\n').len() > MAX_JOURNAL_FRAME_BYTES {
            return false;
        }
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            return false;
        };
        if value.get("kind").and_then(Value::as_str) == Some("journal.batch") {
            let Some(payload) = value.get("payload").and_then(Value::as_str) else {
                return false;
            };
            let checksum = format!("{:x}", Sha256::digest(payload.as_bytes()));
            if value.get("version").and_then(Value::as_u64) != Some(1)
                || value.get("sha256").and_then(Value::as_str) != Some(checksum.as_str())
            {
                return false;
            }
            // Unknown payload fields can contain JavaScript lone surrogates.
            // Parse only the kind before reducing the native subset; a message
            // body must not make an unrelated agent in this batch disappear.
            #[derive(Deserialize)]
            struct EntryKind {
                kind: String,
            }
            let Ok(entries) = serde_json::from_str::<Vec<&serde_json::value::RawValue>>(payload)
            else {
                return false;
            };
            if entries.is_empty()
                || entries.len() > MAX_JOURNAL_BATCH_ENTRIES
                || value.get("count").and_then(Value::as_u64) != Some(entries.len() as u64)
                || !entries.iter().all(|entry| {
                    serde_json::from_str::<EntryKind>(entry.get())
                        .is_ok_and(|entry| entry.kind != "journal.batch")
                })
            {
                return false;
            }
            // Decode/validate the whole frame before changing this projection.
            let mut changed = false;
            for entry in entries {
                if let Ok(value) = serde_json::from_str::<Value>(entry.get()) {
                    changed |= self.apply_value(value);
                }
            }
            return changed;
        }
        self.apply_value(value)
    }

    fn apply_value(&mut self, value: Value) -> bool {
        match value.get("kind").and_then(Value::as_str) {
            Some("agent.upsert") => {
                if let Some(agent) = value
                    .get("agent")
                    .cloned()
                    .and_then(|entry| serde_json::from_value::<JournalAgent>(entry).ok())
                {
                    self.agents.insert(agent.id.clone(), agent);
                    return true;
                }
            }
            Some("agent.endpoint.upsert") => {
                if let Some(endpoint) = value
                    .get("endpoint")
                    .cloned()
                    .and_then(|entry| serde_json::from_value::<JournalEndpoint>(entry).ok())
                {
                    self.endpoints.insert(endpoint.id.clone(), endpoint);
                    return true;
                }
            }
            Some("agent.endpoint.delete") => {
                if let Some(endpoint_id) = value.get("endpointId").and_then(Value::as_str) {
                    self.endpoints.remove(endpoint_id);
                    return true;
                }
            }
            Some("node.upsert") => {
                if let Some(node) = value
                    .get("node")
                    .cloned()
                    .and_then(|entry| serde_json::from_value::<JournalNode>(entry).ok())
                {
                    self.nodes.insert(node.id.clone(), node);
                    return true;
                }
            }
            Some("flight.record") => {
                if let Some(flight) = value
                    .get("flight")
                    .cloned()
                    .and_then(|entry| serde_json::from_value::<JournalFlight>(entry).ok())
                {
                    self.flights.insert(flight.id.clone(), flight);
                    return true;
                }
            }
            _ => {}
        }
        false
    }

    fn summaries(&self) -> Vec<NativeAgentSummary> {
        let working_agents = self
            .flights
            .values()
            .filter(|flight| {
                matches!(
                    flight.state.as_str(),
                    "queued" | "waking" | "running" | "waiting"
                )
            })
            .map(|flight| flight.target_agent_id.as_str())
            .collect::<std::collections::HashSet<_>>();
        // Endpoint selection is shared by every field below. Index the winner
        // for each agent once so a large retained roster does not rescan the
        // complete endpoint map for every summary row.
        let preferred_endpoints = preferred_endpoints_by_agent(self.endpoints.values());
        let mut summaries = self
            .agents
            .values()
            .filter(|agent| !metadata_bool(&agent.metadata, "staleLocalRegistration"))
            .filter(|agent| !metadata_bool(&agent.metadata, "retiredFromFleet"))
            .map(|agent| {
                let endpoint = preferred_endpoints.get(agent.id.as_str()).copied();
                let endpoint_metadata = endpoint.map(|entry| &entry.metadata);
                let project_root = endpoint
                    .and_then(|entry| entry.project_root.clone())
                    .or_else(|| metadata_string(&agent.metadata, "projectRoot"));
                let project = metadata_string(&agent.metadata, "project")
                    .or_else(|| project_root.as_deref().and_then(project_name));
                let updated_at = latest_timestamp(agent, endpoint);
                NativeAgentSummary {
                    id: agent.id.clone(),
                    name: nonempty(&agent.display_name)
                        .unwrap_or(&agent.id)
                        .to_string(),
                    handle: agent.handle.clone().and_then(nonempty_owned),
                    agent_class: agent.agent_class.clone().and_then(nonempty_owned),
                    harness: endpoint
                        .and_then(|entry| entry.harness.clone())
                        .and_then(nonempty_owned),
                    state: if working_agents.contains(agent.id.as_str()) {
                        "working"
                    } else {
                        "available"
                    }
                    .to_string(),
                    role: metadata_string(&agent.metadata, "role"),
                    project_root,
                    cwd: endpoint
                        .and_then(|entry| entry.cwd.clone())
                        .and_then(nonempty_owned),
                    project,
                    branch: metadata_string(&agent.metadata, "branch").or_else(|| {
                        endpoint_metadata.and_then(|metadata| metadata_string(metadata, "branch"))
                    }),
                    selector: agent
                        .selector
                        .clone()
                        .and_then(nonempty_owned)
                        .or_else(|| metadata_string(&agent.metadata, "selector")),
                    model: endpoint_metadata
                        .and_then(|metadata| metadata_string(metadata, "model"))
                        .or_else(|| metadata_string(&agent.metadata, "model")),
                    transport: endpoint
                        .and_then(|entry| entry.transport.clone())
                        .and_then(nonempty_owned)
                        .or_else(|| metadata_string(&agent.metadata, "transport")),
                    capabilities: agent.capabilities.clone(),
                    authority_node_name: agent
                        .authority_node_id
                        .as_deref()
                        .and_then(|id| self.nodes.get(id))
                        .and_then(|node| node.name.clone()),
                    home_node_name: agent
                        .home_node_id
                        .as_deref()
                        .and_then(|id| self.nodes.get(id))
                        .and_then(|node| node.name.clone()),
                    harness_session_id: endpoint.and_then(resolve_harness_session_id),
                    updated_at,
                    created_at: ["createdAt", "registeredAt"]
                        .iter()
                        .filter_map(|key| metadata_timestamp(&agent.metadata, key))
                        .max(),
                }
            })
            .collect::<Vec<_>>();
        summaries.sort_by(|left, right| {
            right
                .updated_at
                .unwrap_or(0)
                .cmp(&left.updated_at.unwrap_or(0))
                .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
                .then_with(|| left.id.cmp(&right.id))
        });
        summaries
    }
}

fn preferred_endpoints_by_agent<'a>(
    endpoints: impl Iterator<Item = &'a JournalEndpoint>,
) -> HashMap<&'a str, &'a JournalEndpoint> {
    let mut preferred = HashMap::<&'a str, &'a JournalEndpoint>::new();
    for endpoint in endpoints {
        preferred
            .entry(endpoint.agent_id.as_str())
            .and_modify(|current| {
                if compare_endpoint(endpoint, current) == Ordering::Less {
                    *current = endpoint;
                }
            })
            .or_insert(endpoint);
    }
    preferred
}

fn compare_endpoint(left: &JournalEndpoint, right: &JournalEndpoint) -> Ordering {
    let left_tuple = (
        metadata_bool(&left.metadata, "staleLocalRegistration"),
        endpoint_state_rank(left.state.as_deref()),
        std::cmp::Reverse(endpoint_freshness(left)),
        left.id.as_str(),
    );
    let right_tuple = (
        metadata_bool(&right.metadata, "staleLocalRegistration"),
        endpoint_state_rank(right.state.as_deref()),
        std::cmp::Reverse(endpoint_freshness(right)),
        right.id.as_str(),
    );
    left_tuple.cmp(&right_tuple)
}

fn endpoint_state_rank(state: Option<&str>) -> u8 {
    match state {
        Some("active") => 0,
        Some("idle") => 1,
        Some("waiting") => 2,
        Some("offline") => 5,
        _ => 4,
    }
}

fn endpoint_freshness(endpoint: &JournalEndpoint) -> u64 {
    [
        "lastSeenAt",
        "lastEnsuredAt",
        "lastStartedAt",
        "startedAt",
        "lastCompletedAt",
        "lastFailedAt",
    ]
    .iter()
    .filter_map(|key| metadata_timestamp(&endpoint.metadata, key))
    .max()
    .unwrap_or(0)
}

fn latest_timestamp(agent: &JournalAgent, endpoint: Option<&JournalEndpoint>) -> Option<u64> {
    let mut timestamps = ["createdAt", "registeredAt", "updatedAt"]
        .iter()
        .filter_map(|key| metadata_timestamp(&agent.metadata, key))
        .collect::<Vec<_>>();
    if let Some(endpoint) = endpoint {
        timestamps.push(endpoint_freshness(endpoint));
    }
    timestamps.into_iter().filter(|value| *value > 0).max()
}

fn resolve_harness_session_id(endpoint: &JournalEndpoint) -> Option<String> {
    endpoint
        .session_id
        .clone()
        .and_then(nonempty_owned)
        .or_else(|| {
            [
                "externalSessionId",
                "threadId",
                "nativeSessionId",
                "pairingSessionId",
                "runtimeSessionId",
            ]
            .iter()
            .find_map(|key| metadata_string(&endpoint.metadata, key))
        })
}

fn metadata_bool(metadata: &Map<String, Value>, key: &str) -> bool {
    metadata.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn metadata_string(metadata: &Map<String, Value>, key: &str) -> Option<String> {
    metadata
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .and_then(nonempty_owned)
}

fn metadata_timestamp(metadata: &Map<String, Value>, key: &str) -> Option<u64> {
    epoch_value(metadata.get(key)?)
}

fn epoch_value(value: &Value) -> Option<u64> {
    let raw = match value {
        Value::Number(number) => number.as_f64()?,
        Value::String(string) => string.parse::<f64>().ok()?,
        _ => return None,
    };
    if !raw.is_finite() || raw <= 0.0 {
        return None;
    }
    let milliseconds = if raw < 100_000_000_000.0 {
        raw * 1000.0
    } else {
        raw
    };
    Some(milliseconds.round() as u64)
}

fn project_name(path: &str) -> Option<String> {
    Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .map(str::to_string)
        .and_then(nonempty_owned)
}

fn nonempty(value: &str) -> Option<&str> {
    (!value.trim().is_empty()).then_some(value)
}

fn nonempty_owned(value: String) -> Option<String> {
    (!value.trim().is_empty()).then_some(value)
}

fn run_projection_watcher(
    service: NativeReadService,
    journal_path: PathBuf,
    cache_path: PathBuf,
    poll_interval: Duration,
) {
    let mut projection = JournalProjection::default();
    let mut cursor = JournalCursor::default();
    loop {
        match cursor.read_updates(&journal_path, &mut projection) {
            Ok(Some(source_updated_at)) => {
                service.publish(projection.summaries(), source_updated_at, &cache_path);
            }
            Ok(None) => {}
            Err(error) => eprintln!("[scoutd native-read] journal projection failed: {error}"),
        }
        thread::sleep(poll_interval.max(Duration::from_millis(50)));
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct FeedArtifactFingerprint {
    length: u64,
    modified_at_ns: u128,
}

fn run_feed_artifact_watcher(
    service: NativeReadService,
    artifact_path: PathBuf,
    poll_interval: Duration,
) {
    let mut observed_fingerprint = None;
    loop {
        match fs::metadata(&artifact_path) {
            Ok(metadata) => {
                // Atomic replacement changes file identity on every publish.
                // Deliberately key polling by the documented mtime/size pair;
                // embedded projection lineage decides whether decoded content
                // is actually newer.
                let fingerprint = FeedArtifactFingerprint {
                    length: metadata.len(),
                    modified_at_ns: metadata.modified().map(system_time_ns).unwrap_or_default(),
                };
                if observed_fingerprint != Some(fingerprint) {
                    observed_fingerprint = Some(fingerprint);
                    match load_feed_artifact(&artifact_path) {
                        Ok(artifact) => service.publish_feed(artifact),
                        Err(error) => eprintln!(
                            "[scoutd native-read] rejected feed artifact {}: {error}",
                            artifact_path.display()
                        ),
                    }
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                // Missing artifacts never clear a previously usable snapshot.
                // Reset the fingerprint so a re-created file is always read.
                observed_fingerprint = None;
            }
            Err(error) => eprintln!(
                "[scoutd native-read] failed to inspect feed artifact {}: {error}",
                artifact_path.display()
            ),
        }
        thread::sleep(poll_interval.max(Duration::from_millis(50)));
    }
}

fn run_thread_artifact_watcher(
    service: NativeReadService,
    artifact_directory: PathBuf,
    poll_interval: Duration,
) {
    let mut observed_fingerprints = HashMap::<PathBuf, FeedArtifactFingerprint>::new();
    let mut observed_feed_ids = HashMap::<PathBuf, String>::new();
    loop {
        refresh_thread_artifacts(
            &service,
            &artifact_directory,
            &mut observed_fingerprints,
            &mut observed_feed_ids,
        );
        thread::sleep(poll_interval.max(Duration::from_millis(50)));
    }
}

fn refresh_thread_artifacts(
    service: &NativeReadService,
    artifact_directory: &Path,
    observed_fingerprints: &mut HashMap<PathBuf, FeedArtifactFingerprint>,
    observed_feed_ids: &mut HashMap<PathBuf, String>,
) {
    let candidates = thread_artifact_candidates(artifact_directory);
    let candidate_paths = candidates.iter().cloned().collect::<HashSet<_>>();
    observed_fingerprints.retain(|path, _| candidate_paths.contains(path));
    observed_feed_ids.retain(|path, _| candidate_paths.contains(path));

    let mut processed_feed_ids = HashSet::<String>::new();
    let mut updates = Vec::<NativeThreadArtifact>::new();
    for artifact_path in &candidates {
        let Ok(metadata) = fs::metadata(artifact_path) else {
            continue;
        };
        let fingerprint = FeedArtifactFingerprint {
            length: metadata.len(),
            modified_at_ns: metadata.modified().map(system_time_ns).unwrap_or_default(),
        };
        if observed_fingerprints.get(artifact_path) == Some(&fingerprint) {
            if let Some(feed_id) = observed_feed_ids.get(artifact_path) {
                processed_feed_ids.insert(feed_id.clone());
            }
            continue;
        }
        // Remember a malformed replacement until its mtime/size changes so a
        // corrupt file cannot cause a 4Hz parse/log loop. Keep its last valid
        // identity while the file remains in the bounded candidate set.
        observed_fingerprints.insert(artifact_path.clone(), fingerprint);
        match load_thread_artifact(artifact_path) {
            Ok(artifact) if processed_feed_ids.insert(artifact.feed_id.clone()) => {
                observed_feed_ids.insert(artifact_path.clone(), artifact.feed_id.clone());
                updates.push(artifact)
            }
            Ok(artifact) => {
                observed_feed_ids.insert(artifact_path.clone(), artifact.feed_id);
            }
            Err(error) => eprintln!(
                "[scoutd native-read] rejected thread artifact {}: {error}",
                artifact_path.display()
            ),
        }
    }

    let retained_feed_ids = candidates
        .iter()
        .filter_map(|path| observed_feed_ids.get(path))
        .cloned()
        .collect::<HashSet<_>>();
    service.reconcile_thread_artifacts(&retained_feed_ids, updates);
}

#[derive(Default)]
struct JournalCursor {
    inode: Option<u64>,
    offset: u64,
    pending: Vec<u8>,
}

impl JournalCursor {
    fn read_updates(
        &mut self,
        path: &Path,
        projection: &mut JournalProjection,
    ) -> Result<Option<u128>, String> {
        let metadata = match fs::metadata(path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.to_string()),
        };
        let inode = metadata.ino();
        if self.inode != Some(inode) || metadata.len() < self.offset {
            *projection = JournalProjection::default();
            self.offset = 0;
            self.pending.clear();
            self.inode = Some(inode);
        }
        if metadata.len() == self.offset {
            return Ok(None);
        }

        let mut file = File::open(path).map_err(|error| error.to_string())?;
        file.seek(SeekFrom::Start(self.offset))
            .map_err(|error| error.to_string())?;
        let mut bytes = [0_u8; 64 * 1024];
        let mut material_change = false;
        // Bound both allocations and this poll to the captured file length.
        while self.offset < metadata.len() {
            let limit =
                usize::try_from((metadata.len() - self.offset).min(bytes.len() as u64)).unwrap();
            let read = file
                .read(&mut bytes[..limit])
                .map_err(|error| error.to_string())?;
            if read == 0 {
                break;
            }
            for chunk in bytes[..read].split_inclusive(|byte| *byte == b'\n') {
                if self.pending.len() + chunk.len() > MAX_JOURNAL_FRAME_BYTES + 1 {
                    return Err("journal_frame_byte_limit".to_string());
                }
                self.pending.extend_from_slice(chunk);
                self.offset += chunk.len() as u64;
                if chunk.last() == Some(&b'\n') {
                    if let Ok(line) = std::str::from_utf8(&self.pending) {
                        material_change |= projection.apply_line(line);
                    }
                    self.pending.clear();
                }
            }
        }
        Ok(material_change
            .then(|| system_time_ms(metadata.modified().unwrap_or_else(|_| SystemTime::now()))))
    }
}

fn system_time_ms(time: SystemTime) -> u128 {
    time.duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

fn system_time_ns(time: SystemTime) -> u128 {
    time.duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0)
}

fn epoch_ms() -> u128 {
    system_time_ms(SystemTime::now())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn batch(payload: &str, count: usize) -> String {
        serde_json::json!({"kind":"journal.batch", "version":1, "count":count,
            "sha256":format!("{:x}", Sha256::digest(payload.as_bytes())), "payload":payload})
        .to_string()
    }

    #[test]
    fn journal_batch_validates_every_entry_before_applying_any() {
        let payload = r#"[{"kind":"agent.upsert","agent":{"id":"one"}},{"kind":"node.upsert","node":{"id":"node"}}]"#;
        let frame = batch(payload, 2);
        for end in 0..frame.len() {
            let mut projection = JournalProjection::default();
            assert!(!projection.apply_line(&frame[..end]));
            assert!(projection.agents.is_empty());
        }
        let mut projection = JournalProjection::default();
        assert!(!projection.apply_line(&batch(payload, 3)));
        assert!(!projection.apply_line(&frame.replace("one", "two")));
        assert!(projection.agents.is_empty());
        assert!(projection.apply_line(&frame));
        assert!(projection.agents.contains_key("one"));
        assert!(projection.nodes.contains_key("node"));
        assert!(projection.apply_line(r#"{"kind":"agent.upsert","agent":{"id":"legacy"}}"#));
        assert!(projection.agents.contains_key("legacy"));
    }

    #[test]
    fn journal_batch_preserves_native_records_beside_javascript_payloads() {
        let payload = r#"[{"kind":"message.record","message":{"body":"\ud800"}},{"kind":"agent.upsert","agent":{"id":"one"}}]"#;
        let mut projection = JournalProjection::default();
        assert!(projection.apply_line(&batch(payload, 2)));
        assert!(projection.agents.contains_key("one"));
    }

    #[test]
    fn journal_cursor_waits_for_complete_frame_and_keeps_utf8_across_polls() {
        use std::io::Write;
        let path = std::env::temp_dir().join(format!(
            "scout-native-frame-{}-{}",
            std::process::id(),
            epoch_ms()
        ));
        let frame = batch(
            r#"[{"kind":"agent.upsert","agent":{"id":"雪"}},{"kind":"agent.upsert","agent":{"id":"two"}}]"#,
            2,
        ) + "\n";
        let split = frame.find('雪').unwrap() + 1;
        fs::write(&path, &frame.as_bytes()[..split]).unwrap();
        let mut cursor = JournalCursor::default();
        let mut projection = JournalProjection::default();
        assert!(cursor
            .read_updates(&path, &mut projection)
            .unwrap()
            .is_none());
        assert!(projection.agents.is_empty());
        let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(&frame.as_bytes()[split..]).unwrap();
        assert!(cursor
            .read_updates(&path, &mut projection)
            .unwrap()
            .is_some());
        assert!(projection.agents.contains_key("雪"));
        assert!(projection.agents.contains_key("two"));
        assert!(cursor.pending.is_empty());
        assert_eq!(cursor.offset, frame.len() as u64);
        fs::remove_file(path).unwrap();
    }

    fn line(value: Value) -> String {
        serde_json::to_string(&value).unwrap()
    }

    fn feed_artifact(projection_id: &str, sequence: u64, item_count: usize) -> NativeFeedArtifact {
        NativeFeedArtifact {
            schema: FEED_CACHE_SCHEMA.to_string(),
            version: 1,
            projection_id: projection_id.to_string(),
            projection_version: 1,
            sequence,
            generated_at: 1_700_000_000_000,
            source_fresh_at: Some(1_700_000_000_000),
            items: (0..item_count)
                .map(|index| {
                    serde_json::json!({
                        "feedId": format!("conv:{index}"),
                        "entityKind": "scout_conversation",
                    })
                })
                .collect(),
            total: item_count,
            has_more: false,
            engaged_feed_id: Some("conv:0".to_string()),
            identity_redirects: Vec::new(),
        }
    }

    fn thread_artifact(
        projection_id: &str,
        sequence: u64,
        conversation_id: &str,
        message_count: usize,
    ) -> NativeThreadArtifact {
        let messages = (0..message_count)
            .map(|index| NativeThreadMessage {
                id: format!("message-{index}"),
                actor_id: "agent-1".to_string(),
                actor_name: Some("Agent One".to_string()),
                body: format!("message {index}"),
                class: "agent".to_string(),
                created_at: 1_700_000_000_000 + index as u128,
            })
            .collect::<Vec<_>>();
        NativeThreadArtifact {
            schema: THREAD_CACHE_SCHEMA.to_string(),
            version: 1,
            projection_id: projection_id.to_string(),
            projection_version: 1,
            sequence,
            content_cursor: Some(format!("{:064x}", message_count)),
            feed_id: format!("conv:{conversation_id}"),
            entity_kind: "scout_conversation".to_string(),
            conversation_id: conversation_id.to_string(),
            cursor: messages.first().map(|message| message.id.clone()),
            has_earlier: false,
            generated_at: 1_700_000_000_000,
            messages,
        }
    }

    fn empty_service() -> NativeReadService {
        NativeReadService {
            state: Arc::new((Mutex::new(PublishedProjection::default()), Condvar::new())),
            feed_state: Arc::new((
                Mutex::new(PublishedFeedProjection::default()),
                Condvar::new(),
            )),
            thread_state: Arc::new((
                Mutex::new(PublishedThreadProjection::default()),
                Condvar::new(),
            )),
        }
    }

    fn thread_request(conversation_id: &str) -> NativeReadRequest {
        NativeReadRequest {
            request_id: None,
            resource: "thread".to_string(),
            mode: NativeReadMode::Snapshot,
            limit: None,
            after_sequence: None,
            feed_id: Some(format!("conv:{conversation_id}")),
            conversation_id: Some(conversation_id.to_string()),
        }
    }

    fn write_thread_artifact(path: &Path, conversation_id: &str, sequence: u64) {
        write_thread_artifact_with_messages(path, conversation_id, sequence, 1);
    }

    fn write_thread_artifact_with_messages(
        path: &Path,
        conversation_id: &str,
        sequence: u64,
        message_count: usize,
    ) {
        let artifact = thread_artifact("projection-a", sequence, conversation_id, message_count);
        fs::write(path, serde_json::to_vec(&artifact).unwrap()).unwrap();
    }

    fn reconcile_single_thread(service: &NativeReadService, artifact: NativeThreadArtifact) {
        let mut retained_feed_ids = {
            let (lock, _) = &*service.thread_state;
            let state = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            state.artifacts.keys().cloned().collect::<HashSet<_>>()
        };
        retained_feed_ids.insert(artifact.feed_id.clone());
        service.reconcile_thread_artifacts(&retained_feed_ids, vec![artifact]);
    }

    fn native_agent_summary(index: usize, updated_at: u64) -> NativeAgentSummary {
        NativeAgentSummary {
            id: format!("agent-{index:03}"),
            name: format!("Agent {index}"),
            handle: None,
            agent_class: None,
            harness: None,
            state: "available".to_string(),
            role: None,
            project_root: None,
            cwd: None,
            project: None,
            branch: None,
            selector: None,
            model: None,
            transport: None,
            capabilities: Vec::new(),
            authority_node_name: None,
            home_node_name: None,
            harness_session_id: None,
            updated_at: Some(updated_at),
            created_at: None,
        }
    }

    #[test]
    fn projection_filters_stale_agents_and_orders_by_endpoint_freshness() {
        let mut projection = JournalProjection::default();
        projection.apply_line(&line(serde_json::json!({
            "kind": "agent.upsert",
            "agent": {
                "id": "old", "displayName": "Old", "agentClass": "general",
                "capabilities": ["chat"], "metadata": {"staleLocalRegistration": true}
            }
        })));
        for (id, name) in [("one", "One"), ("two", "Two")] {
            projection.apply_line(&line(serde_json::json!({
                "kind": "agent.upsert",
                "agent": {
                    "id": id, "displayName": name, "agentClass": "general",
                    "capabilities": ["chat", "invoke"], "metadata": {"project": "OpenScout"}
                }
            })));
        }
        projection.apply_line(&line(serde_json::json!({
            "kind": "agent.endpoint.upsert",
            "endpoint": {
                "id": "ep-one", "agentId": "one", "harness": "codex", "transport": "codex_app_server",
                "state": "idle", "projectRoot": "/work/one", "metadata": {"lastEnsuredAt": 1000}
            }
        })));
        projection.apply_line(&line(serde_json::json!({
            "kind": "agent.endpoint.upsert",
            "endpoint": {
                "id": "ep-two", "agentId": "two", "harness": "claude", "transport": "tmux",
                "state": "active", "projectRoot": "/work/two", "metadata": {"lastEnsuredAt": 2000}
            }
        })));

        let summaries = projection.summaries();
        assert_eq!(
            summaries
                .iter()
                .map(|agent| agent.id.as_str())
                .collect::<Vec<_>>(),
            ["two", "one"]
        );
        assert_eq!(summaries[0].harness.as_deref(), Some("claude"));
        assert_eq!(summaries[0].project_root.as_deref(), Some("/work/two"));
    }

    #[test]
    fn projection_indexes_each_endpoint_once_and_preserves_preference_order() {
        let mut projection = JournalProjection::default();
        projection.apply_line(&line(serde_json::json!({
            "kind": "agent.upsert",
            "agent": {
                "id": "one", "displayName": "One", "agentClass": "general",
                "capabilities": ["chat"], "metadata": {}
            }
        })));
        for endpoint in [
            serde_json::json!({
                "id": "ep-stale", "agentId": "one", "harness": "stale", "state": "active",
                "metadata": {"staleLocalRegistration": true, "lastSeenAt": 9_000}
            }),
            serde_json::json!({
                "id": "ep-idle", "agentId": "one", "harness": "idle", "state": "idle",
                "metadata": {"lastSeenAt": 8_000}
            }),
            serde_json::json!({
                "id": "ep-active-z", "agentId": "one", "harness": "older", "state": "active",
                "metadata": {"lastSeenAt": 100}
            }),
            serde_json::json!({
                "id": "ep-active-b", "agentId": "one", "harness": "later-id", "state": "active",
                "metadata": {"lastSeenAt": 200}
            }),
            serde_json::json!({
                "id": "ep-active-a", "agentId": "one", "harness": "winner", "state": "active",
                "metadata": {"lastSeenAt": 200}
            }),
            serde_json::json!({
                "id": "ep-other", "agentId": "two", "harness": "codex", "state": "active",
                "metadata": {"lastSeenAt": 300}
            }),
        ] {
            projection.apply_line(&line(serde_json::json!({
                "kind": "agent.endpoint.upsert",
                "endpoint": endpoint
            })));
        }

        let mut endpoint_visits = 0;
        let preferred = preferred_endpoints_by_agent(
            projection
                .endpoints
                .values()
                .inspect(|_| endpoint_visits += 1),
        );
        assert_eq!(endpoint_visits, projection.endpoints.len());
        assert_eq!(
            preferred.get("one").map(|endpoint| endpoint.id.as_str()),
            Some("ep-active-a")
        );
        assert_eq!(
            preferred.get("two").map(|endpoint| endpoint.id.as_str()),
            Some("ep-other")
        );

        let summaries = projection.summaries();
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].harness.as_deref(), Some("winner"));
        assert_eq!(summaries[0].updated_at, Some(200_000));
    }

    #[test]
    fn snapshot_is_bounded_and_reports_more_rows() {
        let service = NativeReadService {
            state: Arc::new((
                Mutex::new(PublishedProjection {
                    sequence: 7,
                    generated_at: 1,
                    source_updated_at: 2,
                    agents: (0..12)
                        .map(|index| native_agent_summary(index, index as u64))
                        .collect(),
                    has_more: false,
                }),
                Condvar::new(),
            )),
            feed_state: Arc::new((
                Mutex::new(PublishedFeedProjection::default()),
                Condvar::new(),
            )),
            thread_state: Arc::new((
                Mutex::new(PublishedThreadProjection::default()),
                Condvar::new(),
            )),
        };
        let request = NativeReadRequest {
            request_id: Some("req-1".to_string()),
            resource: "agents".to_string(),
            mode: NativeReadMode::Snapshot,
            limit: Some(10),
            after_sequence: None,
            feed_id: None,
            conversation_id: None,
        };
        let snapshot = service.snapshot(&request);
        assert_eq!(snapshot.agents.len(), 10);
        assert!(snapshot.has_more);
        assert_eq!(snapshot.sequence, 7);
        assert_eq!(snapshot.request_id, "req-1");
    }

    #[test]
    fn agent_publication_retains_only_the_visible_page_and_ignores_off_page_changes() {
        let directory = std::env::temp_dir().join(format!(
            "scoutd-native-agent-cache-{}-{}",
            std::process::id(),
            epoch_ms()
        ));
        fs::create_dir_all(&directory).unwrap();
        let cache_path = directory.join("native-read-agents-v1.json");
        let service = empty_service();
        let initial = (0..=MAX_AGENT_LIMIT)
            .map(|index| native_agent_summary(index, index as u64))
            .collect::<Vec<_>>();

        service.publish(initial.clone(), 10, &cache_path);
        {
            let (lock, _) = &*service.state;
            let state = lock.lock().unwrap();
            assert_eq!(state.sequence, 1);
            assert_eq!(state.agents.len(), MAX_AGENT_LIMIT);
            assert!(state.has_more);
        }
        let cached: CachedProjection =
            serde_json::from_slice(&fs::read(&cache_path).unwrap()).unwrap();
        assert_eq!(cached.agents.len(), MAX_AGENT_LIMIT);
        assert!(cached.has_more);

        let mut off_page_change = initial.clone();
        off_page_change[MAX_AGENT_LIMIT].name = "Changed below the visible page".to_string();
        service.publish(off_page_change, 20, &cache_path);
        {
            let (lock, _) = &*service.state;
            let state = lock.lock().unwrap();
            assert_eq!(state.sequence, 1);
            assert_eq!(state.source_updated_at, 10);
        }

        service.publish(initial[..MAX_AGENT_LIMIT].to_vec(), 30, &cache_path);
        let (lock, _) = &*service.state;
        let state = lock.lock().unwrap();
        assert_eq!(state.sequence, 2);
        assert!(!state.has_more);
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn legacy_oversized_agent_cache_loads_as_a_bounded_page_with_more_rows() {
        let directory = std::env::temp_dir().join(format!(
            "scoutd-native-agent-legacy-cache-{}-{}",
            std::process::id(),
            epoch_ms()
        ));
        fs::create_dir_all(&directory).unwrap();
        let cache_path = directory.join("native-read-agents-v1.json");
        let agents = (0..=MAX_AGENT_LIMIT)
            .map(|index| native_agent_summary(index, index as u64))
            .collect::<Vec<_>>();
        let legacy = serde_json::json!({
            "schema": CACHE_SCHEMA,
            "sequence": 7,
            "generatedAt": 8,
            "sourceUpdatedAt": 9,
            "agents": agents
        });
        fs::write(&cache_path, serde_json::to_vec(&legacy).unwrap()).unwrap();

        let loaded = load_cached_projection(&cache_path).unwrap();
        assert_eq!(loaded.sequence, 7);
        assert_eq!(loaded.agents.len(), MAX_AGENT_LIMIT);
        assert!(loaded.has_more);
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn feed_snapshot_clamps_to_160_and_forwards_projection_lineage() {
        let service = empty_service();
        let mut artifact = feed_artifact("projection-a", 42, MAX_FEED_LIMIT);
        artifact.total = 200;
        artifact.has_more = true;
        service.publish_feed(artifact);
        let request = NativeReadRequest {
            request_id: Some("req-feed".to_string()),
            resource: "feed".to_string(),
            mode: NativeReadMode::Snapshot,
            limit: Some(1_000),
            after_sequence: None,
            feed_id: None,
            conversation_id: None,
        };

        let (_, snapshot) = service.feed_snapshot(&request).expect("feed snapshot");
        assert_eq!(snapshot.event_type, "feed.snapshot");
        assert_eq!(snapshot.request_id, "req-feed");
        assert_eq!(snapshot.projection_id, "projection-a");
        assert_eq!(snapshot.sequence, 42);
        assert_eq!(snapshot.items.len(), MAX_FEED_LIMIT);
        assert_eq!(snapshot.total, 200);
        assert!(snapshot.has_more);
    }

    #[test]
    fn feed_publication_orders_within_lineage_and_replaces_new_lineage_atomically() {
        let service = empty_service();
        service.publish_feed(feed_artifact("projection-a", 9, 1));
        let request = NativeReadRequest {
            request_id: None,
            resource: "feed".to_string(),
            mode: NativeReadMode::Snapshot,
            limit: None,
            after_sequence: None,
            feed_id: None,
            conversation_id: None,
        };
        let (first_revision, first) = service.feed_snapshot(&request).unwrap();

        service.publish_feed(feed_artifact("projection-a", 8, 1));
        let (ignored_revision, ignored) = service.feed_snapshot(&request).unwrap();
        assert_eq!(ignored_revision, first_revision);
        assert_eq!(ignored.sequence, first.sequence);

        service.publish_feed(feed_artifact("projection-b", 1, 1));
        let (replacement_revision, replacement) = service.feed_snapshot(&request).unwrap();
        assert!(replacement_revision > first_revision);
        assert_eq!(replacement.projection_id, "projection-b");
        assert_eq!(replacement.sequence, 1);
    }

    #[test]
    fn feed_artifact_loader_rejects_wrong_schema_and_too_many_items() {
        let dir = std::env::temp_dir().join(format!(
            "scoutd-native-feed-loader-{}-{}",
            std::process::id(),
            epoch_ms()
        ));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("native-read-feed-v1.json");

        let mut artifact = feed_artifact("projection-a", 1, 1);
        artifact.schema = "wrong".to_string();
        fs::write(&path, serde_json::to_vec(&artifact).unwrap()).unwrap();
        assert!(load_feed_artifact(&path).is_err());

        let artifact = feed_artifact("projection-a", 1, MAX_FEED_LIMIT + 1);
        fs::write(&path, serde_json::to_vec(&artifact).unwrap()).unwrap();
        assert!(load_feed_artifact(&path).is_err());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn thread_snapshot_is_identity_scoped_and_keeps_the_newest_bounded_messages() {
        let service = empty_service();
        reconcile_single_thread(
            &service,
            thread_artifact("projection-a", 12, "conversation-1", 4),
        );
        let request = NativeReadRequest {
            request_id: Some("req-thread".to_string()),
            resource: "thread".to_string(),
            mode: NativeReadMode::Snapshot,
            limit: Some(2),
            after_sequence: None,
            feed_id: Some("conv:conversation-1".to_string()),
            conversation_id: Some("conversation-1".to_string()),
        };

        let (_, snapshot) = service.thread_snapshot(&request).expect("thread snapshot");
        assert_eq!(snapshot.event_type, "thread.snapshot");
        assert_eq!(snapshot.projection_id, "projection-a");
        assert_eq!(snapshot.sequence, 12);
        assert_eq!(snapshot.feed_id, "conv:conversation-1");
        assert_eq!(snapshot.conversation_id, "conversation-1");
        assert_eq!(snapshot.cursor.as_deref(), Some("message-2"));
        assert!(snapshot.has_earlier);
        assert_eq!(
            snapshot
                .messages
                .iter()
                .map(|message| message.id.as_str())
                .collect::<Vec<_>>(),
            ["message-2", "message-3"]
        );

        let mismatched = NativeReadRequest {
            conversation_id: Some("other".to_string()),
            ..request
        };
        assert!(service.thread_snapshot(&mismatched).is_none());
    }

    #[test]
    fn thread_publication_accepts_same_sequence_content_corrections_and_rejects_regression() {
        let service = empty_service();
        let request = NativeReadRequest {
            request_id: None,
            resource: "thread".to_string(),
            mode: NativeReadMode::Snapshot,
            limit: None,
            after_sequence: None,
            feed_id: Some("conv:conversation-1".to_string()),
            conversation_id: None,
        };
        let mut legacy = thread_artifact("projection-a", 9, "conversation-1", 1);
        legacy.content_cursor = None;
        reconcile_single_thread(&service, legacy);
        let (first_revision, first) = service.thread_snapshot(&request).unwrap();

        let mut corrected = thread_artifact("projection-a", 9, "conversation-1", 1);
        corrected.content_cursor = Some(format!("{:064x}", 2));
        corrected.messages[0].body = "corrected body".to_string();
        reconcile_single_thread(&service, corrected.clone());
        let (corrected_revision, corrected_snapshot) = service.thread_snapshot(&request).unwrap();
        assert!(corrected_revision > first_revision);
        assert_eq!(corrected_snapshot.sequence, first.sequence);
        assert_eq!(corrected_snapshot.messages[0].body, "corrected body");

        corrected.generated_at += 1;
        reconcile_single_thread(&service, corrected);
        let (duplicate_revision, duplicate) = service.thread_snapshot(&request).unwrap();
        assert_eq!(duplicate_revision, corrected_revision);
        assert_eq!(duplicate.messages[0].body, "corrected body");

        reconcile_single_thread(
            &service,
            thread_artifact("projection-a", 8, "conversation-1", 1),
        );
        let (ignored_revision, ignored) = service.thread_snapshot(&request).unwrap();
        assert_eq!(ignored_revision, corrected_revision);
        assert_eq!(ignored.sequence, corrected_snapshot.sequence);

        reconcile_single_thread(
            &service,
            thread_artifact("projection-b", 1, "conversation-1", 1),
        );
        let (replacement_revision, replacement) = service.thread_snapshot(&request).unwrap();
        assert!(replacement_revision > corrected_revision);
        assert_eq!(replacement.projection_id, "projection-b");
        assert_eq!(replacement.sequence, 1);
    }

    #[test]
    fn thread_artifact_loader_rejects_observed_or_inconsistent_identity() {
        let dir = std::env::temp_dir().join(format!(
            "scoutd-native-thread-loader-{}-{}",
            std::process::id(),
            epoch_ms()
        ));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("native-read-thread-test.json");

        let mut artifact = thread_artifact("projection-a", 1, "conversation-1", 1);
        artifact.entity_kind = "observed_session".to_string();
        fs::write(&path, serde_json::to_vec(&artifact).unwrap()).unwrap();
        assert!(load_thread_artifact(&path).is_err());

        artifact.entity_kind = "scout_conversation".to_string();
        artifact.feed_id = "conv:other".to_string();
        fs::write(&path, serde_json::to_vec(&artifact).unwrap()).unwrap();
        assert!(load_thread_artifact(&path).is_err());

        artifact.feed_id = "conv:conversation-1".to_string();
        artifact.cursor = Some("not-first".to_string());
        fs::write(&path, serde_json::to_vec(&artifact).unwrap()).unwrap();
        assert!(load_thread_artifact(&path).is_err());

        let mut legacy =
            serde_json::to_value(thread_artifact("projection-a", 1, "conversation-1", 1)).unwrap();
        legacy.as_object_mut().unwrap().remove("contentCursor");
        fs::write(&path, serde_json::to_vec(&legacy).unwrap()).unwrap();
        assert!(load_thread_artifact(&path).is_ok_and(|loaded| loaded.content_cursor.is_none()));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn thread_artifact_refresh_evicts_deleted_files() {
        let dir = std::env::temp_dir().join(format!(
            "scoutd-native-thread-delete-{}-{}",
            std::process::id(),
            epoch_ms()
        ));
        fs::create_dir_all(&dir).unwrap();
        let first_path = dir.join("native-read-thread-first.json");
        let second_path = dir.join("native-read-thread-second.json");
        write_thread_artifact(&first_path, "conversation-first", 1);
        write_thread_artifact(&second_path, "conversation-second", 2);

        let service = empty_service();
        let mut fingerprints = HashMap::new();
        let mut feed_ids = HashMap::new();
        refresh_thread_artifacts(&service, &dir, &mut fingerprints, &mut feed_ids);
        assert!(service
            .thread_snapshot(&thread_request("conversation-first"))
            .is_some());
        assert!(service
            .thread_snapshot(&thread_request("conversation-second"))
            .is_some());

        fs::remove_file(&first_path).unwrap();
        refresh_thread_artifacts(&service, &dir, &mut fingerprints, &mut feed_ids);
        assert!(service
            .thread_snapshot(&thread_request("conversation-first"))
            .is_none());
        assert!(service
            .thread_snapshot(&thread_request("conversation-second"))
            .is_some());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn thread_artifact_refresh_keeps_last_valid_value_for_a_malformed_candidate() {
        let dir = std::env::temp_dir().join(format!(
            "scoutd-native-thread-malformed-{}-{}",
            std::process::id(),
            epoch_ms()
        ));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("native-read-thread-current.json");
        write_thread_artifact(&path, "conversation-current", 7);

        let service = empty_service();
        let mut fingerprints = HashMap::new();
        let mut feed_ids = HashMap::new();
        refresh_thread_artifacts(&service, &dir, &mut fingerprints, &mut feed_ids);
        let request = thread_request("conversation-current");
        let (_, valid_snapshot) = service.thread_snapshot(&request).expect("valid snapshot");

        fs::write(&path, b"{malformed replacement").unwrap();
        refresh_thread_artifacts(&service, &dir, &mut fingerprints, &mut feed_ids);
        let (_, retained_snapshot) = service
            .thread_snapshot(&request)
            .expect("last valid snapshot remains available");
        assert_eq!(retained_snapshot.sequence, valid_snapshot.sequence);
        assert_eq!(retained_snapshot.messages, valid_snapshot.messages);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn thread_artifact_refresh_evicts_files_pruned_from_the_bounded_candidates() {
        let dir = std::env::temp_dir().join(format!(
            "scoutd-native-thread-prune-{}-{}",
            std::process::id(),
            epoch_ms()
        ));
        fs::create_dir_all(&dir).unwrap();
        for index in 0..MAX_THREAD_ARTIFACTS {
            let path = dir.join(format!("native-read-thread-{index:03}.json"));
            write_thread_artifact(&path, &format!("conversation-{index:03}"), index as u64 + 1);
        }
        let service = empty_service();
        let mut fingerprints = HashMap::new();
        let mut feed_ids = HashMap::new();
        refresh_thread_artifacts(&service, &dir, &mut fingerprints, &mut feed_ids);
        let initially_published_feed_ids = {
            let (lock, _) = &*service.thread_state;
            let state = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            state.artifacts.keys().cloned().collect::<HashSet<_>>()
        };
        assert_eq!(initially_published_feed_ids.len(), MAX_THREAD_ARTIFACTS);

        // Ensure the additional files sort ahead of the initial candidate set
        // even on filesystems with coarser modification timestamps.
        thread::sleep(Duration::from_millis(20));
        let total = MAX_THREAD_ARTIFACTS + 5;
        for index in MAX_THREAD_ARTIFACTS..total {
            let path = dir.join(format!("native-read-thread-{index:03}.json"));
            write_thread_artifact_with_messages(
                &path,
                &format!("conversation-{index:03}"),
                index as u64 + 1,
                2,
            );
        }
        let expected_feed_ids = load_thread_artifacts(&dir)
            .into_iter()
            .map(|artifact| artifact.feed_id)
            .collect::<HashSet<_>>();
        assert_eq!(expected_feed_ids.len(), MAX_THREAD_ARTIFACTS);

        refresh_thread_artifacts(&service, &dir, &mut fingerprints, &mut feed_ids);

        let (lock, _) = &*service.thread_state;
        let state = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        assert_eq!(state.artifacts.len(), MAX_THREAD_ARTIFACTS);
        assert_eq!(
            state.artifacts.keys().cloned().collect::<HashSet<_>>(),
            expected_feed_ids
        );
        drop(state);

        let evicted_feed_ids = initially_published_feed_ids
            .difference(&expected_feed_ids)
            .cloned()
            .collect::<Vec<_>>();
        assert_eq!(evicted_feed_ids.len(), 5);
        let pruned_conversation_id = evicted_feed_ids[0]
            .strip_prefix("conv:")
            .expect("feed id prefix");
        assert!(service
            .thread_snapshot(&thread_request(pruned_conversation_id))
            .is_none());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn direct_thread_publication_remains_bounded() {
        let service = empty_service();
        for index in 0..(MAX_THREAD_ARTIFACTS + 5) {
            reconcile_single_thread(
                &service,
                thread_artifact(
                    "projection-a",
                    index as u64 + 1,
                    &format!("conversation-{index:03}"),
                    1,
                ),
            );
        }

        let (lock, _) = &*service.thread_state;
        let state = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        assert_eq!(state.artifacts.len(), MAX_THREAD_ARTIFACTS);
        assert!(!state.artifacts.contains_key("conv:conversation-000"));
        assert!(state.artifacts.contains_key(&format!(
            "conv:conversation-{:03}",
            MAX_THREAD_ARTIFACTS + 4
        )));
    }
}
