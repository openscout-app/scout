use scoutd::native_read_service::{
    NativeReadMode, NativeReadRequest, NativeReadService,
    REQUEST_SCHEMA as NATIVE_READ_REQUEST_SCHEMA,
};
use scoutd::repo_service;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::env;
use std::fs;
use std::io::{Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{FileTypeExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const CAPABILITIES_SCHEMA: &str = "openscout.probe.capabilities/v1";
const REQUEST_SCHEMA: &str = "openscout.probe.request/v1";
const SNAPSHOT_SCHEMA: &str = "openscout.probe.snapshot/v1";
const ERROR_SCHEMA: &str = "openscout.probe.error/v1";
const REPO_SCAN_SCHEMA: &str = "openscout.repo.scan/v1";
const REPO_DIFF_SCHEMA: &str = "openscout.repo.diff/v1";
const REPO_RESPONSE_SCHEMA: &str = "openscout.repo.response/v1";
const EXEC_REQUEST_SCHEMA: &str = "openscout.exec.request/v1";
const EXEC_RESPONSE_SCHEMA: &str = "openscout.exec.response/v1";
const REPO_SCAN_CAPABILITY_ID: &str = "repo.scan";
const REPO_DIFF_CAPABILITY_ID: &str = "repo.diff";
const TAILSCALE_STATUS_ID: &str = "tailscale.status";
const GIT_BUILD_INFO_ID: &str = "git.buildInfo";
const GIT_REV_PARSE_ID: &str = "git.revParse";
const GIT_DIFF_SHORTSTAT_ID: &str = "git.diffShortstat";
const GIT_STATUS_PORCELAIN_ID: &str = "git.statusPorcelain";
const GIT_MERGE_BASE_ID: &str = "git.mergeBase";
const GIT_LOG_LAST_COMMIT_UNIX_ID: &str = "git.logLastCommitUnix";
const GIT_WORKTREE_LIST_PORCELAIN_ID: &str = "git.worktreeListPorcelain";
const PS_RUNTIME_ID: &str = "ps.runtime";
const PS_DISCOVERY_ID: &str = "ps.discovery";
const PS_CWD_ID: &str = "ps.cwd";
const NET_LISTENERS_ID: &str = "net.listeners";
const TMUX_SESSIONS_ID: &str = "tmux.sessions";
/// One `list-sessions` row per session, tab-delimited because a window name or
/// pane title can hold "|". The pane title is last, so a tab inside it folds
/// back into it. `#{host}` is read only to recognize tmux's default pane title
/// and is never reported. Mirrors `TMUX_SESSION_LIST_FORMAT` in the runtime.
const TMUX_SESSION_LIST_FORMAT: &str = "#{session_name}\t#{session_windows}\t#{session_attached}\t#{session_created}\t#{session_activity}\t#{pane_current_command}\t#{pane_current_path}\t#{window_name}\t#{host}\t#{pane_title}";
const TMUX_SESSION_FIELD_COUNT: usize = 10;
/// Rows from before window names and titles: seven "|"-delimited fields.
const LEGACY_TMUX_SESSION_FIELD_COUNT: usize = 7;
const TMUX_PANES_ID: &str = "tmux.panes";
const ZELLIJ_SESSIONS_ID: &str = "zellij.sessions";
const TAILSCALE_STATUS_TTL_MS: u64 = 30_000;
const GIT_BUILD_INFO_TTL_MS: u64 = 60_000;
const GIT_CATALOG_TTL_MS: u64 = 60_000;
const PS_RUNTIME_TTL_MS: u64 = 5_000;
const PS_DISCOVERY_TTL_MS: u64 = 1_000;
const PS_CWD_TTL_MS: u64 = 5_000;
const NET_LISTENERS_TTL_MS: u64 = 5_000;
const TMUX_TTL_MS: u64 = 5_000;
const ZELLIJ_TTL_MS: u64 = 5_000;
const DEFAULT_TAILSCALE_TIMEOUT: Duration = Duration::from_millis(1_500);
const DEFAULT_GIT_TIMEOUT: Duration = Duration::from_millis(1_500);
const DEFAULT_PS_TIMEOUT: Duration = Duration::from_millis(1_500);
const DEFAULT_LSOF_TIMEOUT: Duration = Duration::from_millis(1_500);
const DEFAULT_TMUX_PROBE_TIMEOUT: Duration = Duration::from_millis(1_500);
const DEFAULT_ZELLIJ_PROBE_TIMEOUT: Duration = Duration::from_millis(1_500);
const DEFAULT_REPO_JOB_TIMEOUT: Duration = Duration::from_millis(20_000);
const DEFAULT_REPO_JOB_RESPONSE_CAP_BYTES: usize = 8 * 1024 * 1024;
const DEFAULT_PS_DISCOVERY_MAX_ROWS: usize = 4_096;
const PS_DISCOVERY_MAX_COMMAND_CHARS: usize = 1_024;
const DEFAULT_TMUX_CAPTURE_MAX_BYTES: usize = 4 * 1024 * 1024;
const DEFAULT_PROBE_CACHE_MAX_ENTRIES: usize = 4_096;
const DEFAULT_PROBE_CACHE_IDLE_TTL: Duration = Duration::from_secs(10 * 60);
const MAX_REQUESTED_PROBE_TIMEOUT: Duration = Duration::from_millis(30_000);
const DEFAULT_REPO_JOB_WORKERS: usize = 4;
const DEFAULT_REPO_JOB_QUEUE: usize = 32;
const DEFAULT_EXEC_JOB_WORKERS: usize = 4;
const DEFAULT_EXEC_JOB_QUEUE: usize = 32;
const DEFAULT_CONNECTION_WORKERS: usize = 32;
const DEFAULT_CONNECTION_QUEUE: usize = 64;
const DEFAULT_CONNECTION_IO_TIMEOUT: Duration = Duration::from_millis(5_000);
const DEFAULT_NATIVE_READ_SUBSCRIPTION_WORKERS: usize = 16;
const DEFAULT_NATIVE_READ_POLL_INTERVAL: Duration = Duration::from_secs(1);
const NATIVE_READ_PEER_CHECK_INTERVAL: Duration = Duration::from_millis(250);
const NATIVE_READ_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(15);
const REQUEST_READ_CAP_BYTES: u64 = 8 * 1024 * 1024;
const DAEMON_VERSION: &str = env!("CARGO_PKG_VERSION");
#[cfg(test)]
const TEST_PANIC_PROBE_ID: &str = "__test.panic";

const EXEC_VERBS: &[&str] = &[
    "tmux.sendKeys",
    "tmux.sendKeysLiteral",
    "tmux.loadBuffer",
    "tmux.pasteBuffer",
    "tmux.deleteBuffer",
    "tmux.killSession",
    "tmux.newSession",
    "tmux.detachClient",
    "tailscale.cert",
    "reveal.open",
];

#[derive(Clone, Debug)]
pub struct ProbeServerOptions {
    pub socket_path: PathBuf,
    pub tailscale_bin: String,
    pub git_bin: String,
    pub tmux_bin: String,
    pub zellij_bin: String,
    pub ps_bin: String,
    pub lsof_bin: String,
    pub tailscale_status_fixture: Option<PathBuf>,
    pub tailscale_timeout: Duration,
    pub git_timeout: Duration,
    pub ps_timeout: Duration,
    pub lsof_timeout: Duration,
    pub tmux_probe_timeout: Duration,
    pub zellij_probe_timeout: Duration,
    pub ps_discovery_max_rows: usize,
    pub probe_cache_max_entries: usize,
    pub probe_cache_idle_ttl: Duration,
    pub repo_job_timeout: Duration,
    pub repo_job_response_cap_bytes: usize,
    pub repo_job_workers: usize,
    pub repo_job_queue: usize,
    pub exec_job_workers: usize,
    pub exec_job_queue: usize,
    pub connection_workers: usize,
    pub connection_queue: usize,
    pub connection_io_timeout: Duration,
    pub native_read_enabled: bool,
    pub native_read_journal_path: PathBuf,
    pub native_read_cache_path: PathBuf,
    pub native_read_feed_artifact_path: PathBuf,
    pub native_read_thread_artifact_directory: PathBuf,
    pub native_read_poll_interval: Duration,
    pub native_read_subscription_workers: usize,
}

impl ProbeServerOptions {
    pub fn from_env(socket_path: PathBuf) -> Self {
        let control_home = env_nonempty("OPENSCOUT_CONTROL_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                PathBuf::from(env_nonempty("HOME").unwrap_or_else(|| ".".to_string()))
                    .join(".openscout/control-plane")
            });
        Self {
            socket_path,
            tailscale_bin: env_nonempty("OPENSCOUT_TAILSCALE_BIN")
                .unwrap_or_else(|| "tailscale".to_string()),
            git_bin: env_nonempty("OPENSCOUT_GIT_BIN").unwrap_or_else(|| "git".to_string()),
            tmux_bin: env_nonempty("OPENSCOUT_TMUX_BIN").unwrap_or_else(|| "tmux".to_string()),
            zellij_bin: env_nonempty("OPENSCOUT_ZELLIJ_BIN")
                .unwrap_or_else(|| "zellij".to_string()),
            ps_bin: env_nonempty("OPENSCOUT_PS_BIN").unwrap_or_else(|| "ps".to_string()),
            lsof_bin: env_nonempty("OPENSCOUT_LSOF_BIN").unwrap_or_else(|| "lsof".to_string()),
            tailscale_status_fixture: env_nonempty("OPENSCOUT_TAILSCALE_STATUS_JSON")
                .map(PathBuf::from),
            tailscale_timeout: env_duration_ms("OPENSCOUT_TAILSCALE_STATUS_TIMEOUT_MS")
                .unwrap_or(DEFAULT_TAILSCALE_TIMEOUT),
            git_timeout: env_duration_ms("OPENSCOUT_GIT_CATALOG_TIMEOUT_MS")
                .unwrap_or(DEFAULT_GIT_TIMEOUT),
            ps_timeout: env_duration_ms("OPENSCOUT_PS_PROBE_TIMEOUT_MS")
                .unwrap_or(DEFAULT_PS_TIMEOUT),
            lsof_timeout: env_duration_ms("OPENSCOUT_LSOF_PROBE_TIMEOUT_MS")
                .unwrap_or(DEFAULT_LSOF_TIMEOUT),
            tmux_probe_timeout: env_duration_ms("OPENSCOUT_TMUX_PROBE_TIMEOUT_MS")
                .unwrap_or(DEFAULT_TMUX_PROBE_TIMEOUT),
            zellij_probe_timeout: env_duration_ms("OPENSCOUT_ZELLIJ_PROBE_TIMEOUT_MS")
                .unwrap_or(DEFAULT_ZELLIJ_PROBE_TIMEOUT),
            ps_discovery_max_rows: env_usize("OPENSCOUT_PS_DISCOVERY_MAX_ROWS")
                .unwrap_or(DEFAULT_PS_DISCOVERY_MAX_ROWS)
                .max(1),
            probe_cache_max_entries: env_usize("OPENSCOUT_PROBE_CACHE_MAX_ENTRIES")
                .unwrap_or(DEFAULT_PROBE_CACHE_MAX_ENTRIES)
                .max(1),
            probe_cache_idle_ttl: env_duration_ms("OPENSCOUT_PROBE_CACHE_IDLE_TTL_MS")
                .unwrap_or(DEFAULT_PROBE_CACHE_IDLE_TTL),
            repo_job_timeout: env_duration_ms("OPENSCOUT_REPO_JOB_TIMEOUT_MS")
                .unwrap_or(DEFAULT_REPO_JOB_TIMEOUT),
            repo_job_response_cap_bytes: env_usize("OPENSCOUT_REPO_JOB_RESPONSE_MAX_BYTES")
                .unwrap_or(DEFAULT_REPO_JOB_RESPONSE_CAP_BYTES),
            repo_job_workers: env_usize("OPENSCOUT_REPO_JOB_WORKERS")
                .unwrap_or(DEFAULT_REPO_JOB_WORKERS)
                .max(1),
            repo_job_queue: env_usize("OPENSCOUT_REPO_JOB_QUEUE").unwrap_or(DEFAULT_REPO_JOB_QUEUE),
            exec_job_workers: env_usize("OPENSCOUT_EXEC_JOB_WORKERS")
                .unwrap_or(DEFAULT_EXEC_JOB_WORKERS)
                .max(1),
            exec_job_queue: env_usize("OPENSCOUT_EXEC_JOB_QUEUE").unwrap_or(DEFAULT_EXEC_JOB_QUEUE),
            connection_workers: env_usize("OPENSCOUT_PROBE_CONNECTION_WORKERS")
                .unwrap_or(DEFAULT_CONNECTION_WORKERS)
                .max(1),
            connection_queue: env_usize("OPENSCOUT_PROBE_CONNECTION_QUEUE")
                .unwrap_or(DEFAULT_CONNECTION_QUEUE),
            connection_io_timeout: env_duration_ms("OPENSCOUT_PROBE_CONNECTION_IO_TIMEOUT_MS")
                .unwrap_or(DEFAULT_CONNECTION_IO_TIMEOUT),
            native_read_enabled: env_nonempty("OPENSCOUT_NATIVE_READ_DISABLED").as_deref()
                != Some("1"),
            native_read_journal_path: control_home.join("broker-journal.jsonl"),
            native_read_cache_path: env_nonempty("OPENSCOUT_NATIVE_READ_CACHE")
                .map(PathBuf::from)
                .unwrap_or_else(|| control_home.join("native-read-agents-v1.json")),
            native_read_feed_artifact_path: env_nonempty("OPENSCOUT_NATIVE_READ_FEED_ARTIFACT")
                .map(PathBuf::from)
                .unwrap_or_else(|| control_home.join("native-read-feed-v1.json")),
            native_read_thread_artifact_directory: env_nonempty(
                "OPENSCOUT_NATIVE_READ_THREAD_ARTIFACT_DIRECTORY",
            )
            .map(PathBuf::from)
            .unwrap_or_else(|| control_home.join("native-read-threads-v1")),
            native_read_poll_interval: env_duration_ms("OPENSCOUT_NATIVE_READ_POLL_MS")
                .unwrap_or(DEFAULT_NATIVE_READ_POLL_INTERVAL),
            native_read_subscription_workers: env_usize(
                "OPENSCOUT_NATIVE_READ_SUBSCRIPTION_WORKERS",
            )
            .unwrap_or(DEFAULT_NATIVE_READ_SUBSCRIPTION_WORKERS)
            .max(1),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct ProbeServerStatus {
    #[serde(rename = "socketPath")]
    pub socket_path: String,
    #[serde(rename = "socketExists")]
    pub socket_exists: bool,
    pub reachable: bool,
    #[serde(rename = "daemonVersion")]
    pub daemon_version: Option<String>,
    pub families: Vec<ProbeCapability>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ProbeCapability {
    #[serde(rename = "probeId")]
    pub probe_id: String,
    #[serde(rename = "schemaVersion")]
    pub schema_version: u32,
    #[serde(rename = "ttlMs")]
    pub ttl_ms: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ExecVerbCapability {
    pub verb: String,
    #[serde(rename = "schemaVersion")]
    pub schema_version: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct JsonError {
    code: String,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    timed_out: Option<bool>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct ProbeSnapshotResponse {
    schema: String,
    #[serde(rename = "probeId")]
    probe_id: String,
    key: Option<String>,
    #[serde(rename = "generatedAt")]
    generated_at: u128,
    #[serde(rename = "ttlMs")]
    ttl_ms: u64,
    value: Value,
    error: Option<JsonError>,
    #[serde(rename = "daemonVersion")]
    daemon_version: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct RepoJobResponse {
    schema: String,
    operation: String,
    #[serde(rename = "generatedAt")]
    generated_at: u128,
    value: Value,
    error: Option<JsonError>,
    #[serde(rename = "daemonVersion")]
    daemon_version: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct ExecResponse {
    schema: String,
    verb: String,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    value: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<JsonError>,
    #[serde(rename = "daemonVersion")]
    daemon_version: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RepoOperation {
    Scan,
    Diff,
}

impl RepoOperation {
    fn capability_id(self) -> &'static str {
        match self {
            Self::Scan => REPO_SCAN_CAPABILITY_ID,
            Self::Diff => REPO_DIFF_CAPABILITY_ID,
        }
    }
}

#[derive(Debug, Deserialize)]
struct ProbeRequest {
    #[serde(rename = "schema")]
    _schema: String,
    #[serde(rename = "probeId")]
    probe_id: Option<String>,
    key: Option<String>,
    #[serde(rename = "maxAgeMs")]
    max_age_ms: Option<u64>,
    #[serde(rename = "opTimeoutMs")]
    op_timeout_ms: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct ExecRequest {
    verb: Option<String>,
    #[serde(default)]
    args: Value,
}

#[derive(Debug)]
struct ProbeFailure {
    code: String,
    message: String,
    timed_out: bool,
}

#[derive(Debug)]
struct CommandResult {
    stdout: String,
    stderr: String,
}

#[derive(Debug)]
struct CommandFailure {
    code: String,
    message: String,
    timed_out: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Hash)]
struct ProbeCacheKey {
    probe_id: String,
    key: Option<String>,
}

#[derive(Clone, Debug)]
struct StaticGitBuildMetadata {
    commit: Option<String>,
    boot_branch: Option<String>,
    metadata_at: u128,
}

#[derive(Clone, Debug, Deserialize)]
struct GitRevParseKey {
    #[serde(rename = "repoRoot")]
    repo_root: String,
    kind: String,
    #[serde(default)]
    r#ref: Option<String>,
    #[serde(default)]
    quiet: Option<bool>,
}

#[derive(Clone, Debug, Deserialize)]
struct GitDiffShortstatKey {
    #[serde(rename = "repoRoot")]
    repo_root: String,
    selector: GitDiffSelectorKey,
    #[serde(default)]
    paths: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
struct GitStatusPorcelainKey {
    #[serde(rename = "repoRoot")]
    repo_root: String,
    version: String,
    #[serde(default)]
    branch: Option<bool>,
    #[serde(default)]
    z: Option<bool>,
    #[serde(rename = "untrackedMode", default)]
    untracked_mode: Option<String>,
    #[serde(default)]
    paths: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
struct GitMergeBaseKey {
    #[serde(rename = "repoRoot")]
    repo_root: String,
    #[serde(rename = "baseRef")]
    base_ref: String,
    #[serde(rename = "compareRef")]
    compare_ref: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind")]
enum GitDiffSelectorKey {
    #[serde(rename = "unstaged")]
    Unstaged,
    #[serde(rename = "staged")]
    Staged,
    #[serde(rename = "fromRef")]
    FromRef { r#ref: String },
    #[serde(rename = "twoRefs")]
    TwoRefs {
        #[serde(rename = "baseRef")]
        base_ref: String,
        #[serde(rename = "compareRef")]
        compare_ref: String,
    },
    #[serde(rename = "range")]
    Range {
        notation: String,
        #[serde(rename = "baseRef")]
        base_ref: String,
        #[serde(rename = "compareRef")]
        compare_ref: String,
    },
}

#[derive(Clone, Debug, Deserialize)]
struct TmuxPaneProbeKey {
    kind: String,
    #[serde(rename = "socketPath")]
    socket_path: String,
    target: String,
    start: Option<String>,
    end: Option<String>,
    #[serde(rename = "joinWrapped")]
    join_wrapped: Option<bool>,
    #[serde(rename = "maxBytes")]
    max_bytes: Option<usize>,
}

#[derive(Clone, Debug)]
struct ProbeCacheEntry {
    snapshot: Option<ProbeSnapshotResponse>,
    in_flight: bool,
    last_access: Instant,
}

impl ProbeCacheEntry {
    fn new(now: Instant) -> Self {
        Self {
            snapshot: None,
            in_flight: false,
            last_access: now,
        }
    }
}

#[derive(Debug, Default)]
struct ProbeEngineState {
    entries: HashMap<ProbeCacheKey, ProbeCacheEntry>,
    git_static: HashMap<String, StaticGitBuildMetadata>,
}

impl ProbeEngineState {
    fn evict_probe_cache(&mut self, now: Instant, idle_ttl: Duration, max_entries: usize) {
        self.entries.retain(|_, entry| {
            entry.in_flight || now.duration_since(entry.last_access) <= idle_ttl
        });

        let max_entries = max_entries.max(1);
        while self.entries.len() > max_entries {
            let Some(oldest_key) = self
                .entries
                .iter()
                .filter(|(_, entry)| !entry.in_flight)
                .min_by_key(|(_, entry)| entry.last_access)
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            self.entries.remove(&oldest_key);
        }
    }
}

#[derive(Debug, Default)]
struct JobLimiterState {
    active: usize,
    queued: usize,
}

#[derive(Clone, Debug)]
struct JobLimiter {
    label: &'static str,
    max_active: usize,
    max_queue: usize,
    state: Arc<(Mutex<JobLimiterState>, Condvar)>,
}

#[derive(Debug)]
struct JobPermit {
    state: Arc<(Mutex<JobLimiterState>, Condvar)>,
}

impl Drop for JobPermit {
    fn drop(&mut self) {
        let (lock, cvar) = &*self.state;
        let mut state = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        state.active = state.active.saturating_sub(1);
        cvar.notify_one();
    }
}

impl JobLimiter {
    fn new(label: &'static str, max_active: usize, max_queue: usize) -> Self {
        Self {
            label,
            max_active: max_active.max(1),
            max_queue,
            state: Arc::new((Mutex::new(JobLimiterState::default()), Condvar::new())),
        }
    }

    fn acquire(&self) -> Result<JobPermit, ProbeFailure> {
        let (lock, cvar) = &*self.state;
        let mut state = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.active < self.max_active {
            state.active += 1;
            return Ok(JobPermit {
                state: Arc::clone(&self.state),
            });
        }
        if state.queued >= self.max_queue {
            return Err(ProbeFailure {
                code: "busy".to_string(),
                message: format!(
                    "{} queue is full (active={}, queued={}, maxQueue={})",
                    self.label, state.active, state.queued, self.max_queue
                ),
                timed_out: false,
            });
        }
        state.queued += 1;
        loop {
            state = cvar
                .wait(state)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if state.active < self.max_active {
                state.queued = state.queued.saturating_sub(1);
                state.active += 1;
                return Ok(JobPermit {
                    state: Arc::clone(&self.state),
                });
            }
        }
    }
}

#[derive(Clone, Debug)]
struct ProbeEngine {
    options: ProbeServerOptions,
    state: Arc<(Mutex<ProbeEngineState>, Condvar)>,
    repo_jobs: JobLimiter,
    exec_jobs: JobLimiter,
    native_subscription_jobs: JobLimiter,
    native_reads: Option<NativeReadService>,
}

impl ProbeEngine {
    fn new(options: ProbeServerOptions) -> Self {
        let repo_jobs =
            JobLimiter::new("repo job", options.repo_job_workers, options.repo_job_queue);
        let exec_jobs =
            JobLimiter::new("exec job", options.exec_job_workers, options.exec_job_queue);
        // Long-lived native subscriptions must never occupy the general probe
        // connection pool. This class is intentionally fail-fast (no queue),
        // leaving snapshot/probe/repo/exec requests independently available.
        let native_subscription_jobs = JobLimiter::new(
            "native read subscription",
            options.native_read_subscription_workers,
            0,
        );
        let native_reads = options.native_read_enabled.then(|| {
            NativeReadService::start(
                options.native_read_journal_path.clone(),
                options.native_read_cache_path.clone(),
                options.native_read_feed_artifact_path.clone(),
                options.native_read_thread_artifact_directory.clone(),
                options.native_read_poll_interval,
            )
        });
        Self {
            options,
            state: Arc::new((Mutex::new(ProbeEngineState::default()), Condvar::new())),
            repo_jobs,
            exec_jobs,
            native_subscription_jobs,
            native_reads,
        }
    }

    fn capabilities(&self) -> Vec<ProbeCapability> {
        served_capabilities()
    }

    fn snapshot(
        &self,
        probe_id: &str,
        key: Option<String>,
        max_age_ms: Option<u64>,
        op_timeout_ms: Option<u64>,
    ) -> ProbeSnapshotResponse {
        let ttl_ms = probe_ttl_ms(probe_id).unwrap_or(0);
        let normalized_key = match normalize_probe_key(probe_id, key) {
            Ok(value) => value,
            Err(error) => return error_snapshot(probe_id, None, ttl_ms, error),
        };
        if !is_supported_probe(probe_id) {
            return error_snapshot(
                probe_id,
                normalized_key,
                ttl_ms,
                ProbeFailure {
                    code: "unknown_probe".to_string(),
                    message: format!("unknown probeId: {probe_id}"),
                    timed_out: false,
                },
            );
        }

        let cache_key = ProbeCacheKey {
            probe_id: probe_id.to_string(),
            key: normalized_key.clone(),
        };

        loop {
            let (lock, cvar) = &*self.state;
            let mut state = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            let now = Instant::now();
            state.evict_probe_cache(
                now,
                self.options.probe_cache_idle_ttl,
                self.options.probe_cache_max_entries,
            );
            let entry = state
                .entries
                .entry(cache_key.clone())
                .or_insert_with(|| ProbeCacheEntry::new(now));
            entry.last_access = now;
            if let Some(snapshot) = entry.snapshot.as_ref() {
                if snapshot_is_fresh_for(snapshot, max_age_ms.unwrap_or(ttl_ms)) {
                    return snapshot.clone();
                }
            }
            if entry.in_flight {
                let guard = cvar
                    .wait(state)
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                drop(guard);
                continue;
            }
            entry.in_flight = true;
            break;
        }

        let probe_result = catch_unwind(AssertUnwindSafe(|| {
            self.run_probe(probe_id, normalized_key.clone(), op_timeout_ms)
        }));
        let snapshot = match probe_result {
            Ok(Ok(value)) => ProbeSnapshotResponse {
                schema: SNAPSHOT_SCHEMA.to_string(),
                probe_id: probe_id.to_string(),
                key: normalized_key.clone(),
                generated_at: epoch_ms(),
                ttl_ms,
                value,
                error: None,
                daemon_version: DAEMON_VERSION.to_string(),
            },
            Ok(Err(error)) => error_snapshot(probe_id, normalized_key.clone(), ttl_ms, error),
            Err(_) => error_snapshot(
                probe_id,
                normalized_key.clone(),
                ttl_ms,
                ProbeFailure {
                    code: "panic".to_string(),
                    message: format!("{probe_id} panicked while serving a probe snapshot"),
                    timed_out: false,
                },
            ),
        };

        let (lock, cvar) = &*self.state;
        let mut state = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let now = Instant::now();
        {
            let entry = state
                .entries
                .entry(cache_key)
                .or_insert_with(|| ProbeCacheEntry::new(now));
            entry.snapshot = Some(snapshot.clone());
            entry.in_flight = false;
            entry.last_access = now;
        }
        state.evict_probe_cache(
            now,
            self.options.probe_cache_idle_ttl,
            self.options.probe_cache_max_entries,
        );
        cvar.notify_all();
        snapshot
    }

    fn run_repo_job(&self, operation: RepoOperation, input: Value) -> RepoJobResponse {
        let result = match self.repo_jobs.acquire() {
            Ok(_permit) => {
                run_repo_operation_with_timeout(operation, input, self.options.repo_job_timeout)
            }
            Err(error) => Err(error),
        };
        match result {
            Ok(value) => repo_job_response(operation, value, None),
            Err(error) => repo_job_response(
                operation,
                Value::Null,
                Some(JsonError {
                    code: error.code,
                    message: error.message,
                    timed_out: if error.timed_out { Some(true) } else { None },
                }),
            ),
        }
    }

    fn run_exec_job(&self, verb: String, args: Value) -> ExecResponse {
        let result = match self.exec_jobs.acquire() {
            Ok(_permit) => self.run_exec_verb(&verb, args),
            Err(error) => Err(error),
        };
        match result {
            Ok(value) => exec_response(&verb, true, Some(value), None),
            Err(error) => exec_response(
                &verb,
                false,
                None,
                Some(JsonError {
                    code: error.code,
                    message: error.message,
                    timed_out: if error.timed_out { Some(true) } else { None },
                }),
            ),
        }
    }

    fn run_exec_verb(&self, verb: &str, args: Value) -> Result<Value, ProbeFailure> {
        if !EXEC_VERBS.contains(&verb) {
            return Err(ProbeFailure {
                code: "unknown_verb".to_string(),
                message: format!("unknown exec verb: {verb}"),
                timed_out: false,
            });
        }
        let object = args.as_object().ok_or_else(|| ProbeFailure {
            code: "invalid_request".to_string(),
            message: format!("{verb} args must be an object"),
            timed_out: false,
        })?;
        match verb {
            "tmux.sendKeys" => self.exec_tmux_send_keys(object),
            "tmux.sendKeysLiteral" => self.exec_tmux_send_keys_literal(object),
            "tmux.loadBuffer" => self.exec_tmux_load_buffer(object),
            "tmux.pasteBuffer" => self.exec_tmux_paste_buffer(object),
            "tmux.deleteBuffer" => self.exec_tmux_delete_buffer(object),
            "tmux.killSession" => self.exec_tmux_kill_session(object),
            "tmux.newSession" => self.exec_tmux_new_session(object),
            "tmux.detachClient" => self.exec_tmux_detach_client(object),
            "tailscale.cert" => self.exec_tailscale_cert(object),
            "reveal.open" => self.exec_reveal_open(object),
            _ => Err(ProbeFailure {
                code: "unknown_verb".to_string(),
                message: format!("unknown exec verb: {verb}"),
                timed_out: false,
            }),
        }
    }

    fn exec_tmux_send_keys(&self, args: &Map<String, Value>) -> Result<Value, ProbeFailure> {
        let target = required_tmux_target(args, "target")?;
        let keys = required_string_array(args, "keys", validate_tmux_key)?;
        if keys.is_empty() {
            return Err(invalid_args("tmux.sendKeys requires at least one key"));
        }
        let mut command_args = tmux_socket_prefix(args)?;
        command_args.extend(["send-keys".to_string(), "-t".to_string(), target]);
        command_args.extend(keys);
        self.run_exec_command_json(
            &self.options.tmux_bin,
            command_args,
            None,
            args,
            ExecVerbLimits::tmux(),
        )
    }

    fn exec_tmux_send_keys_literal(
        &self,
        args: &Map<String, Value>,
    ) -> Result<Value, ProbeFailure> {
        let target = required_tmux_target(args, "target")?;
        let text = required_bounded_string(args, "text", 128 * 1024, allow_text_payload)?;
        let mut command_args = tmux_socket_prefix(args)?;
        command_args.extend([
            "send-keys".to_string(),
            "-t".to_string(),
            target,
            "-l".to_string(),
            text,
        ]);
        self.run_exec_command_json(
            &self.options.tmux_bin,
            command_args,
            None,
            args,
            ExecVerbLimits::tmux(),
        )
    }

    fn exec_tmux_load_buffer(&self, args: &Map<String, Value>) -> Result<Value, ProbeFailure> {
        let buffer_name = required_buffer_name(args, "bufferName")?;
        let content =
            required_bounded_string(args, "content", 4 * 1024 * 1024, allow_text_payload)?;
        let mut command_args = tmux_socket_prefix(args)?;
        command_args.extend([
            "load-buffer".to_string(),
            "-b".to_string(),
            buffer_name,
            "-".to_string(),
        ]);
        self.run_exec_command_json(
            &self.options.tmux_bin,
            command_args,
            Some(content.into_bytes()),
            args,
            ExecVerbLimits::tmux_large_input(),
        )
    }

    fn exec_tmux_paste_buffer(&self, args: &Map<String, Value>) -> Result<Value, ProbeFailure> {
        let buffer_name = required_buffer_name(args, "bufferName")?;
        let target = required_tmux_target(args, "target")?;
        let flags = optional_string(args, "flags").unwrap_or_else(|| "-dpr".to_string());
        validate_tmux_paste_flags(&flags)?;
        let mut command_args = tmux_socket_prefix(args)?;
        command_args.extend([
            "paste-buffer".to_string(),
            flags,
            "-b".to_string(),
            buffer_name,
            "-t".to_string(),
            target,
        ]);
        self.run_exec_command_json(
            &self.options.tmux_bin,
            command_args,
            None,
            args,
            ExecVerbLimits::tmux(),
        )
    }

    fn exec_tmux_delete_buffer(&self, args: &Map<String, Value>) -> Result<Value, ProbeFailure> {
        let buffer_name = required_buffer_name(args, "bufferName")?;
        let mut command_args = tmux_socket_prefix(args)?;
        command_args.extend(["delete-buffer".to_string(), "-b".to_string(), buffer_name]);
        self.run_exec_command_json(
            &self.options.tmux_bin,
            command_args,
            None,
            args,
            ExecVerbLimits::tmux(),
        )
    }

    fn exec_tmux_kill_session(&self, args: &Map<String, Value>) -> Result<Value, ProbeFailure> {
        let target = required_tmux_target(args, "target")?;
        let mut command_args = tmux_socket_prefix(args)?;
        command_args.extend(["kill-session".to_string(), "-t".to_string(), target]);
        self.run_exec_command_json(
            &self.options.tmux_bin,
            command_args,
            None,
            args,
            ExecVerbLimits::tmux(),
        )
    }

    fn exec_tmux_detach_client(&self, args: &Map<String, Value>) -> Result<Value, ProbeFailure> {
        let session_name = required_tmux_target(args, "sessionName")?;
        let mut command_args = tmux_socket_prefix(args)?;
        command_args.extend(["detach-client".to_string(), "-s".to_string(), session_name]);
        self.run_exec_command_json(
            &self.options.tmux_bin,
            command_args,
            None,
            args,
            ExecVerbLimits::tmux(),
        )
    }

    fn exec_tmux_new_session(&self, args: &Map<String, Value>) -> Result<Value, ProbeFailure> {
        let session_name = required_tmux_target(args, "sessionName")?;
        let command = required_bounded_string(args, "command", 16 * 1024, allow_tmux_command)?;
        let mut command_args = tmux_socket_prefix(args)?;
        command_args.push("new-session".to_string());
        let detached = optional_bool(args, "detached").unwrap_or(true);
        let print_pane = optional_bool(args, "printPane").unwrap_or(false);
        if detached && print_pane {
            command_args.push("-dP".to_string());
        } else {
            if detached {
                command_args.push("-d".to_string());
            }
            if print_pane {
                command_args.push("-P".to_string());
            }
        }
        if let Some(window_name) = optional_string(args, "windowName") {
            validate_tmux_window_name(&window_name)?;
            command_args.extend(["-n".to_string(), window_name]);
        }
        if let Some(columns) = optional_u16(args, "columns") {
            command_args.extend(["-x".to_string(), columns.to_string()]);
        }
        if let Some(rows) = optional_u16(args, "rows") {
            command_args.extend(["-y".to_string(), rows.to_string()]);
        }
        if let Some(format) = optional_string(args, "format") {
            validate_tmux_format(&format)?;
            command_args.extend(["-F".to_string(), format]);
        }
        command_args.extend(["-s".to_string(), session_name]);
        if let Some(cwd) = optional_string(args, "cwd") {
            validate_absolute_path(&cwd, "cwd")?;
            command_args.extend(["-c".to_string(), cwd]);
        }
        command_args.push(command);
        // If this starts the tmux server, the server's global env is this
        // process's env: start it without scoutd's instance/service env.
        let limits = ExecVerbLimits::tmux_new_session();
        let timeout = requested_timeout(args, limits.default_timeout, limits.max_timeout)?;
        match run_capped_command_full(
            &self.options.tmux_bin,
            &command_args,
            None,
            None,
            &[],
            TMUX_SERVER_STRIPPED_ENV_KEYS,
            timeout,
            limits.max_stdout_bytes,
            limits.max_stderr_bytes,
        ) {
            Ok(output) => Ok(json!({
                "stdout": output.stdout,
                "stderr": output.stderr,
                "exitCode": 0,
            })),
            Err(error) => Err(command_failure_to_exec(error, &self.options.tmux_bin)),
        }
    }

    fn exec_tailscale_cert(&self, args: &Map<String, Value>) -> Result<Value, ProbeFailure> {
        let cert_file = required_bounded_string(args, "certFile", 4096, |value| {
            validate_absolute_path(value, "certFile")
        })?;
        let key_file = required_bounded_string(args, "keyFile", 4096, |value| {
            validate_absolute_path(value, "keyFile")
        })?;
        let hostname = required_bounded_string(args, "hostname", 253, validate_hostname)?;
        let command_args = vec![
            "cert".to_string(),
            "--cert-file".to_string(),
            cert_file,
            "--key-file".to_string(),
            key_file,
            hostname,
        ];
        self.run_exec_command_json(
            &self.options.tailscale_bin,
            command_args,
            None,
            args,
            ExecVerbLimits::tailscale_cert(),
        )
    }

    fn exec_reveal_open(&self, args: &Map<String, Value>) -> Result<Value, ProbeFailure> {
        let target_path = required_bounded_string(args, "targetPath", 4096, |value| {
            validate_absolute_path(value, "targetPath")
        })?;
        let mode = required_bounded_string(args, "mode", 32, validate_reveal_mode)?;
        let (command, command_args) = match mode.as_str() {
            "darwinReveal" => ("open".to_string(), vec!["-R".to_string(), target_path]),
            "darwinOpen" => ("open".to_string(), vec![target_path]),
            "xdgOpen" => ("xdg-open".to_string(), vec![target_path]),
            "windowsSelect" => (
                "explorer.exe".to_string(),
                vec![format!("/select,{target_path}")],
            ),
            _ => return Err(invalid_args("unsupported reveal.open mode")),
        };
        self.run_exec_command_json(
            &command,
            command_args,
            None,
            args,
            ExecVerbLimits::reveal_open(),
        )
    }

    fn run_exec_command_json(
        &self,
        command: &str,
        args: Vec<String>,
        stdin: Option<Vec<u8>>,
        request_args: &Map<String, Value>,
        limits: ExecVerbLimits,
    ) -> Result<Value, ProbeFailure> {
        let timeout = requested_timeout(request_args, limits.default_timeout, limits.max_timeout)?;
        match run_capped_command_with_input(
            command,
            &args,
            stdin.as_deref(),
            None,
            timeout,
            limits.max_stdout_bytes,
            limits.max_stderr_bytes,
        ) {
            Ok(output) => Ok(json!({
                "stdout": output.stdout,
                "stderr": output.stderr,
                "exitCode": 0,
            })),
            Err(error) => Err(command_failure_to_exec(error, command)),
        }
    }

    fn run_probe(
        &self,
        probe_id: &str,
        key: Option<String>,
        op_timeout_ms: Option<u64>,
    ) -> Result<Value, ProbeFailure> {
        match probe_id {
            #[cfg(test)]
            TEST_PANIC_PROBE_ID => panic!("intentional test probe panic"),
            TAILSCALE_STATUS_ID => self.run_tailscale_status(op_timeout_ms),
            GIT_BUILD_INFO_ID => {
                let repo_root = key.ok_or_else(|| ProbeFailure {
                    code: "invalid_request".to_string(),
                    message: "git.buildInfo requires a repo root key".to_string(),
                    timed_out: false,
                })?;
                self.run_git_build_info(&repo_root, op_timeout_ms)
            }
            GIT_REV_PARSE_ID => {
                let key = key.ok_or_else(|| ProbeFailure {
                    code: "invalid_request".to_string(),
                    message: "git.revParse requires a typed key".to_string(),
                    timed_out: false,
                })?;
                self.run_git_rev_parse(&key, op_timeout_ms)
            }
            GIT_DIFF_SHORTSTAT_ID => {
                let key = key.ok_or_else(|| ProbeFailure {
                    code: "invalid_request".to_string(),
                    message: "git.diffShortstat requires a typed key".to_string(),
                    timed_out: false,
                })?;
                self.run_git_diff_shortstat(&key, op_timeout_ms)
            }
            GIT_STATUS_PORCELAIN_ID => {
                let key = key.ok_or_else(|| ProbeFailure {
                    code: "invalid_request".to_string(),
                    message: "git.statusPorcelain requires a typed key".to_string(),
                    timed_out: false,
                })?;
                self.run_git_status_porcelain(&key, op_timeout_ms)
            }
            GIT_MERGE_BASE_ID => {
                let key = key.ok_or_else(|| ProbeFailure {
                    code: "invalid_request".to_string(),
                    message: "git.mergeBase requires a typed key".to_string(),
                    timed_out: false,
                })?;
                self.run_git_merge_base(&key, op_timeout_ms)
            }
            GIT_LOG_LAST_COMMIT_UNIX_ID => {
                let repo_root = key.ok_or_else(|| ProbeFailure {
                    code: "invalid_request".to_string(),
                    message: "git.logLastCommitUnix requires a repo root key".to_string(),
                    timed_out: false,
                })?;
                self.run_git_log_last_commit_unix(&repo_root, op_timeout_ms)
            }
            GIT_WORKTREE_LIST_PORCELAIN_ID => {
                let repo_root = key.ok_or_else(|| ProbeFailure {
                    code: "invalid_request".to_string(),
                    message: "git.worktreeListPorcelain requires a repo root key".to_string(),
                    timed_out: false,
                })?;
                self.run_git_worktree_list_porcelain(&repo_root, op_timeout_ms)
            }
            PS_RUNTIME_ID => self.run_ps_runtime(op_timeout_ms),
            PS_DISCOVERY_ID => self.run_ps_discovery(op_timeout_ms),
            PS_CWD_ID => {
                let pid = key.ok_or_else(|| ProbeFailure {
                    code: "invalid_request".to_string(),
                    message: "ps.cwd requires a pid key".to_string(),
                    timed_out: false,
                })?;
                self.run_ps_cwd(&pid, op_timeout_ms)
            }
            NET_LISTENERS_ID => {
                let port = key.ok_or_else(|| ProbeFailure {
                    code: "invalid_request".to_string(),
                    message: "net.listeners requires a port key".to_string(),
                    timed_out: false,
                })?;
                self.run_net_listeners(&port, op_timeout_ms)
            }
            TMUX_SESSIONS_ID => {
                let socket_path = key.unwrap_or_else(|| "default".to_string());
                self.run_tmux_sessions(&socket_path, op_timeout_ms)
            }
            TMUX_PANES_ID => {
                let pane_key = key.ok_or_else(|| ProbeFailure {
                    code: "invalid_request".to_string(),
                    message: "tmux.panes requires a pane key".to_string(),
                    timed_out: false,
                })?;
                self.run_tmux_panes(&pane_key, op_timeout_ms)
            }
            ZELLIJ_SESSIONS_ID => {
                let socket_dir = key.unwrap_or_else(default_zellij_socket_dir);
                self.run_zellij_sessions(&socket_dir, op_timeout_ms)
            }
            _ => Err(ProbeFailure {
                code: "unknown_probe".to_string(),
                message: format!("unknown probeId: {probe_id}"),
                timed_out: false,
            }),
        }
    }

    fn run_tailscale_status(&self, op_timeout_ms: Option<u64>) -> Result<Value, ProbeFailure> {
        let timeout = effective_probe_timeout(self.options.tailscale_timeout, op_timeout_ms);
        let raw = if let Some(fixture_path) = self.options.tailscale_status_fixture.as_ref() {
            match fs::read_to_string(fixture_path) {
                Ok(value) => value,
                Err(_) => return Ok(Value::Null),
            }
        } else {
            match run_capped_command(
                &self.options.tailscale_bin,
                &["status", "--json"],
                None,
                timeout,
                4 * 1024 * 1024,
                256 * 1024,
            ) {
                Ok(output) => output.stdout,
                Err(error) if is_domain_unavailable_command_error(&error) => {
                    return Ok(Value::Null)
                }
                Err(error) => return Err(command_failure_to_probe(error, TAILSCALE_STATUS_ID)),
            }
        };
        let parsed: Value = serde_json::from_str(&raw).map_err(|error| ProbeFailure {
            code: "parse_error".to_string(),
            message: format!("failed to parse tailscale status JSON: {error}"),
            timed_out: false,
        })?;
        Ok(summarize_tailscale_status(&parsed))
    }

    fn run_git_build_info(
        &self,
        repo_root: &str,
        op_timeout_ms: Option<u64>,
    ) -> Result<Value, ProbeFailure> {
        let timeout = effective_probe_timeout(self.options.git_timeout, op_timeout_ms);
        let metadata = self.load_static_git_metadata(repo_root, timeout)?;
        let branch = self.git_value(repo_root, &["rev-parse", "--abbrev-ref", "HEAD"], timeout)?;
        let dirty_status = self.git_output(repo_root, &["status", "--porcelain"], timeout)?;
        Ok(json!({
            "repoRoot": repo_root,
            "commit": metadata.commit,
            "bootBranch": metadata.boot_branch,
            "branch": branch.or(metadata.boot_branch.clone()),
            "dirty": dirty_status.as_ref().map(|value| !value.trim().is_empty()),
            "metadataAt": metadata.metadata_at,
            "statusAt": epoch_ms(),
        }))
    }

    fn load_static_git_metadata(
        &self,
        repo_root: &str,
        timeout: Duration,
    ) -> Result<StaticGitBuildMetadata, ProbeFailure> {
        {
            let (lock, _) = &*self.state;
            let state = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            if let Some(metadata) = state.git_static.get(repo_root) {
                return Ok(metadata.clone());
            }
        }
        let metadata = StaticGitBuildMetadata {
            commit: self.git_value(repo_root, &["rev-parse", "--short", "HEAD"], timeout)?,
            boot_branch: self.git_value(
                repo_root,
                &["rev-parse", "--abbrev-ref", "HEAD"],
                timeout,
            )?,
            metadata_at: epoch_ms(),
        };
        let (lock, _) = &*self.state;
        let mut state = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        Ok(state
            .git_static
            .entry(repo_root.to_string())
            .or_insert_with(|| metadata.clone())
            .clone())
    }

    fn git_output(
        &self,
        repo_root: &str,
        args: &[&str],
        timeout: Duration,
    ) -> Result<Option<String>, ProbeFailure> {
        let mut command_args = vec!["-C", repo_root];
        command_args.extend(args.iter().copied());
        match run_capped_command(
            &self.options.git_bin,
            &command_args,
            None,
            timeout,
            256 * 1024,
            64 * 1024,
        ) {
            Ok(output) => Ok(Some(output.stdout)),
            Err(error) if is_domain_unavailable_command_error(&error) => Ok(None),
            Err(error) => Err(command_failure_to_probe(error, GIT_BUILD_INFO_ID)),
        }
    }

    fn git_value(
        &self,
        repo_root: &str,
        args: &[&str],
        timeout: Duration,
    ) -> Result<Option<String>, ProbeFailure> {
        Ok(self
            .git_output(repo_root, args, timeout)?
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()))
    }

    fn run_git_rev_parse(
        &self,
        key: &str,
        op_timeout_ms: Option<u64>,
    ) -> Result<Value, ProbeFailure> {
        let parsed: GitRevParseKey = serde_json::from_str(key).map_err(|error| ProbeFailure {
            code: "invalid_request".to_string(),
            message: format!("invalid git.revParse key: {error}"),
            timed_out: false,
        })?;
        let args = git_rev_parse_args(&parsed)?;
        match self.run_git_catalog_command(
            &parsed.repo_root,
            &args,
            256 * 1024,
            GIT_REV_PARSE_ID,
            op_timeout_ms,
        ) {
            Ok(output) => Ok(trimmed_string_value(output.as_deref())),
            Err(error) => Err(error),
        }
    }

    fn run_git_diff_shortstat(
        &self,
        key: &str,
        op_timeout_ms: Option<u64>,
    ) -> Result<Value, ProbeFailure> {
        let parsed: GitDiffShortstatKey =
            serde_json::from_str(key).map_err(|error| ProbeFailure {
                code: "invalid_request".to_string(),
                message: format!("invalid git.diffShortstat key: {error}"),
                timed_out: false,
            })?;
        let args = git_diff_shortstat_args(&parsed)?;
        match self.run_git_catalog_command(
            &parsed.repo_root,
            &args,
            256 * 1024,
            GIT_DIFF_SHORTSTAT_ID,
            op_timeout_ms,
        ) {
            Ok(output) => Ok(trimmed_string_value(output.as_deref())),
            Err(error) => Err(error),
        }
    }

    fn run_git_status_porcelain(
        &self,
        key: &str,
        op_timeout_ms: Option<u64>,
    ) -> Result<Value, ProbeFailure> {
        let parsed: GitStatusPorcelainKey =
            serde_json::from_str(key).map_err(|error| ProbeFailure {
                code: "invalid_request".to_string(),
                message: format!("invalid git.statusPorcelain key: {error}"),
                timed_out: false,
            })?;
        let args = git_status_porcelain_args(&parsed)?;
        match self.run_git_catalog_command(
            &parsed.repo_root,
            &args,
            1024 * 1024,
            GIT_STATUS_PORCELAIN_ID,
            op_timeout_ms,
        ) {
            Ok(output) => Ok(output.map(Value::String).unwrap_or(Value::Null)),
            Err(error) => Err(error),
        }
    }

    fn run_git_merge_base(
        &self,
        key: &str,
        op_timeout_ms: Option<u64>,
    ) -> Result<Value, ProbeFailure> {
        let parsed: GitMergeBaseKey = serde_json::from_str(key).map_err(|error| ProbeFailure {
            code: "invalid_request".to_string(),
            message: format!("invalid git.mergeBase key: {error}"),
            timed_out: false,
        })?;
        let args = git_merge_base_args(&parsed)?;
        match self.run_git_catalog_command(
            &parsed.repo_root,
            &args,
            256 * 1024,
            GIT_MERGE_BASE_ID,
            op_timeout_ms,
        ) {
            Ok(output) => Ok(trimmed_string_value(output.as_deref())),
            Err(error) => Err(error),
        }
    }

    fn run_git_log_last_commit_unix(
        &self,
        repo_root: &str,
        op_timeout_ms: Option<u64>,
    ) -> Result<Value, ProbeFailure> {
        let args = vec![
            "log".to_string(),
            "-1".to_string(),
            "--format=%ct".to_string(),
        ];
        match self.run_git_catalog_command(
            repo_root,
            &args,
            64 * 1024,
            GIT_LOG_LAST_COMMIT_UNIX_ID,
            op_timeout_ms,
        ) {
            Ok(output) => Ok(trimmed_string_value(output.as_deref())),
            Err(error) => Err(error),
        }
    }

    fn run_git_worktree_list_porcelain(
        &self,
        repo_root: &str,
        op_timeout_ms: Option<u64>,
    ) -> Result<Value, ProbeFailure> {
        let args = vec![
            "worktree".to_string(),
            "list".to_string(),
            "--porcelain".to_string(),
        ];
        match self.run_git_catalog_command(
            repo_root,
            &args,
            1024 * 1024,
            GIT_WORKTREE_LIST_PORCELAIN_ID,
            op_timeout_ms,
        ) {
            Ok(output) => Ok(output.map(Value::String).unwrap_or(Value::Null)),
            Err(error) => Err(error),
        }
    }

    fn run_git_catalog_command(
        &self,
        repo_root: &str,
        args: &[String],
        max_stdout_bytes: usize,
        probe_id: &str,
        op_timeout_ms: Option<u64>,
    ) -> Result<Option<String>, ProbeFailure> {
        let mut command_args = vec!["-C".to_string(), canonical_repo_root(repo_root)];
        command_args.extend(args.iter().cloned());
        let timeout = effective_probe_timeout(self.options.git_timeout, op_timeout_ms);
        match run_capped_command_with_input(
            &self.options.git_bin,
            &command_args,
            None,
            None,
            timeout,
            max_stdout_bytes,
            64 * 1024,
        ) {
            Ok(output) => Ok(Some(output.stdout)),
            Err(error) if is_domain_unavailable_command_error(&error) => Ok(None),
            Err(error) => Err(command_failure_to_probe(error, probe_id)),
        }
    }

    fn run_tmux_sessions(
        &self,
        socket_path: &str,
        op_timeout_ms: Option<u64>,
    ) -> Result<Value, ProbeFailure> {
        let timeout = effective_probe_timeout(self.options.tmux_probe_timeout, op_timeout_ms);
        // `-u` keeps the tabs in the format: tmux prints them as "_" without a
        // UTF-8 locale, and a daemon can run without one.
        let mut args = vec!["-u".to_string()];
        args.extend(tmux_socket_args(
            socket_path,
            &["list-sessions", "-F", TMUX_SESSION_LIST_FORMAT],
        ));
        match run_capped_command_with_input(
            &self.options.tmux_bin,
            &args,
            None,
            None,
            timeout,
            512 * 1024,
            64 * 1024,
        ) {
            Ok(output) => Ok(Value::Array(parse_tmux_session_list(&output.stdout))),
            Err(error) if is_domain_unavailable_command_error(&error) => Ok(Value::Array(vec![])),
            Err(error) => Err(command_failure_to_probe(error, TMUX_SESSIONS_ID)),
        }
    }

    fn run_zellij_sessions(
        &self,
        socket_dir: &str,
        op_timeout_ms: Option<u64>,
    ) -> Result<Value, ProbeFailure> {
        let timeout = effective_probe_timeout(self.options.zellij_probe_timeout, op_timeout_ms);
        match run_capped_command_with_env(
            &self.options.zellij_bin,
            &["list-sessions"],
            &[("ZELLIJ_SOCKET_DIR", socket_dir)],
            timeout,
            512 * 1024,
            64 * 1024,
        ) {
            Ok(output) => Ok(Value::Array(parse_zellij_session_list(&output.stdout))),
            Err(error) if is_domain_unavailable_command_error(&error) => Ok(Value::Array(vec![])),
            Err(error) => Err(command_failure_to_probe(error, ZELLIJ_SESSIONS_ID)),
        }
    }

    fn run_tmux_panes(&self, key: &str, op_timeout_ms: Option<u64>) -> Result<Value, ProbeFailure> {
        let parsed: TmuxPaneProbeKey = serde_json::from_str(key).map_err(|error| ProbeFailure {
            code: "invalid_request".to_string(),
            message: format!("invalid tmux.panes key: {error}"),
            timed_out: false,
        })?;
        if parsed.kind == "detail" {
            return self.run_tmux_pane_detail(&parsed, op_timeout_ms);
        }
        if parsed.kind == "capture" {
            return self.run_tmux_pane_capture(&parsed, op_timeout_ms);
        }
        Err(ProbeFailure {
            code: "invalid_request".to_string(),
            message: format!("unsupported tmux.panes key kind: {}", parsed.kind),
            timed_out: false,
        })
    }

    fn run_tmux_pane_detail(
        &self,
        parsed: &TmuxPaneProbeKey,
        op_timeout_ms: Option<u64>,
    ) -> Result<Value, ProbeFailure> {
        let timeout = effective_probe_timeout(self.options.tmux_probe_timeout, op_timeout_ms);
        // `-u` keeps the tabs in the format: tmux prints them as "_" without a
        // UTF-8 locale, and a daemon can run without one.
        let mut args = vec!["-u".to_string()];
        args.extend(tmux_socket_args(
            &parsed.socket_path,
            &[
                "display-message",
                "-p",
                "-t",
                parsed.target.as_str(),
                "#{pane_pid}\t#{pane_tty}\t#{pane_current_path}",
            ],
        ));
        match run_capped_command_with_input(
            &self.options.tmux_bin,
            &args,
            None,
            None,
            timeout,
            64 * 1024,
            64 * 1024,
        ) {
            Ok(output) => Ok(parse_tmux_pane_detail(&output.stdout).unwrap_or(Value::Null)),
            Err(error) if is_domain_unavailable_command_error(&error) => Ok(Value::Null),
            Err(error) => Err(command_failure_to_probe(error, TMUX_PANES_ID)),
        }
    }

    fn run_tmux_pane_capture(
        &self,
        parsed: &TmuxPaneProbeKey,
        op_timeout_ms: Option<u64>,
    ) -> Result<Value, ProbeFailure> {
        let timeout = effective_probe_timeout(self.options.tmux_probe_timeout, op_timeout_ms);
        let start = parsed.start.as_deref().unwrap_or("0");
        let end = parsed.end.as_deref().unwrap_or("-");
        let mut suffix = vec!["capture-pane", "-p"];
        if parsed.join_wrapped.unwrap_or(true) {
            suffix.push("-J");
        }
        suffix.extend(["-t", parsed.target.as_str(), "-S", start, "-E", end]);
        let args = tmux_socket_args(&parsed.socket_path, &suffix);
        let max_stdout = parsed
            .max_bytes
            .unwrap_or(1024 * 1024)
            .min(DEFAULT_TMUX_CAPTURE_MAX_BYTES);
        match run_capped_command_with_input(
            &self.options.tmux_bin,
            &args,
            None,
            None,
            timeout,
            max_stdout,
            64 * 1024,
        ) {
            Ok(output) => Ok(json!({ "body": output.stdout })),
            Err(error) if is_domain_unavailable_command_error(&error) => Ok(Value::Null),
            Err(error) => Err(command_failure_to_probe(error, TMUX_PANES_ID)),
        }
    }

    fn run_ps_runtime(&self, op_timeout_ms: Option<u64>) -> Result<Value, ProbeFailure> {
        let timeout = effective_probe_timeout(self.options.ps_timeout, op_timeout_ms);
        let rows = match run_capped_command(
            &self.options.ps_bin,
            &["-axo", "pid=,ppid=,pgid=,tty=,comm="],
            None,
            timeout,
            4 * 1024 * 1024,
            128 * 1024,
        ) {
            Ok(output) => parse_process_rows(&output.stdout),
            Err(error) if is_domain_unavailable_command_error(&error) => Vec::new(),
            Err(error) => return Err(command_failure_to_probe(error, PS_RUNTIME_ID)),
        };
        let command_rows = match run_capped_command(
            &self.options.ps_bin,
            &["-axo", "pid=,ppid=,pgid=,tty=,command="],
            None,
            timeout,
            8 * 1024 * 1024,
            128 * 1024,
        ) {
            Ok(output) => parse_process_command_rows(&output.stdout),
            Err(error) if is_domain_unavailable_command_error(&error) => Vec::new(),
            Err(error) => return Err(command_failure_to_probe(error, PS_RUNTIME_ID)),
        };
        Ok(json!({
            "rows": rows,
            "commandRows": command_rows,
        }))
    }

    fn run_ps_discovery(&self, op_timeout_ms: Option<u64>) -> Result<Value, ProbeFailure> {
        let timeout = effective_probe_timeout(self.options.ps_timeout, op_timeout_ms);
        match run_capped_command(
            &self.options.ps_bin,
            &["-axww", "-o", "pid=,ppid=,etime=,command="],
            None,
            timeout,
            32 * 1024 * 1024,
            128 * 1024,
        ) {
            Ok(output) => Ok(process_discovery_snapshot(
                parse_process_discovery_rows(&output.stdout),
                self.options.ps_discovery_max_rows,
            )),
            Err(error) if is_domain_unavailable_command_error(&error) => Ok(
                process_discovery_snapshot(Vec::new(), self.options.ps_discovery_max_rows),
            ),
            Err(error) => Err(command_failure_to_probe(error, PS_DISCOVERY_ID)),
        }
    }

    fn run_ps_cwd(&self, key: &str, op_timeout_ms: Option<u64>) -> Result<Value, ProbeFailure> {
        let Some(pid) = positive_u32(key) else {
            return Ok(Value::Null);
        };
        let pid_arg = pid.to_string();
        let timeout = effective_probe_timeout(self.options.lsof_timeout, op_timeout_ms);
        match run_capped_command(
            &self.options.lsof_bin,
            &["-a", "-p", pid_arg.as_str(), "-d", "cwd", "-Fn"],
            None,
            timeout,
            64 * 1024,
            64 * 1024,
        ) {
            Ok(output) => Ok(parse_lsof_cwd(&output.stdout)
                .map(Value::String)
                .unwrap_or(Value::Null)),
            Err(error) if is_domain_unavailable_command_error(&error) => Ok(Value::Null),
            Err(error) => Err(command_failure_to_probe(error, PS_CWD_ID)),
        }
    }

    fn run_net_listeners(
        &self,
        key: &str,
        op_timeout_ms: Option<u64>,
    ) -> Result<Value, ProbeFailure> {
        let Some(port) = positive_u32(key) else {
            return Ok(json!({ "port": 0, "pid": Value::Null }));
        };
        let port_arg = format!("-iTCP:{port}");
        let timeout = effective_probe_timeout(self.options.lsof_timeout, op_timeout_ms);
        match run_capped_command(
            &self.options.lsof_bin,
            &["-nP", port_arg.as_str(), "-sTCP:LISTEN", "-Fp"],
            None,
            timeout,
            64 * 1024,
            64 * 1024,
        ) {
            Ok(output) => Ok(json!({
                "port": port,
                "pid": parse_lsof_listener_pid(&output.stdout),
            })),
            Err(error) if is_domain_unavailable_command_error(&error) => Ok(json!({
                "port": port,
                "pid": Value::Null,
            })),
            Err(error) => Err(command_failure_to_probe(error, NET_LISTENERS_ID)),
        }
    }
}

pub fn serve(options: ProbeServerOptions) -> Result<(), String> {
    prepare_socket_path(&options.socket_path)?;
    let listener = UnixListener::bind(&options.socket_path).map_err(|error| {
        format!(
            "failed to bind probe socket {}: {error}",
            options.socket_path.display()
        )
    })?;
    fs::set_permissions(&options.socket_path, fs::Permissions::from_mode(0o600)).map_err(
        |error| {
            format!(
                "failed to set probe socket mode {}: {error}",
                options.socket_path.display()
            )
        },
    )?;
    eprintln!("[scoutd probes] serving {}", options.socket_path.display());

    let engine = ProbeEngine::new(options);
    let connection_jobs = JobLimiter::new(
        "probe connection",
        engine.options.connection_workers,
        engine.options.connection_queue,
    );
    for stream in listener.incoming() {
        match stream {
            Ok(mut stream) => {
                let permit = match connection_jobs.acquire() {
                    Ok(permit) => permit,
                    Err(error) => {
                        let response = error_response(&error.code, &error.message);
                        if let Ok(payload) = serde_json::to_vec(&response) {
                            let _ = stream.write_all(&payload);
                            let _ = stream.write_all(b"\n");
                        }
                        continue;
                    }
                };
                let engine = engine.clone();
                thread::spawn(move || {
                    if let Err(error) = handle_connection(stream, engine, permit) {
                        eprintln!("[scoutd probes] connection failed: {error}");
                    }
                });
            }
            Err(error) => eprintln!("[scoutd probes] accept failed: {error}"),
        }
    }
    Ok(())
}

pub fn probe_server_status(socket_path: &Path) -> ProbeServerStatus {
    let socket_exists = socket_path.exists();
    match request_capabilities(socket_path, Duration::from_millis(500)) {
        Ok((daemon_version, families)) => ProbeServerStatus {
            socket_path: socket_path.to_string_lossy().to_string(),
            socket_exists,
            reachable: true,
            daemon_version: Some(daemon_version),
            families,
            error: None,
        },
        Err(error) => ProbeServerStatus {
            socket_path: socket_path.to_string_lossy().to_string(),
            socket_exists,
            reachable: false,
            daemon_version: None,
            families: Vec::new(),
            error: Some(error),
        },
    }
}

fn request_capabilities(
    socket_path: &Path,
    timeout: Duration,
) -> Result<(String, Vec<ProbeCapability>), String> {
    let mut stream = UnixStream::connect(socket_path).map_err(|error| error.to_string())?;
    stream
        .set_read_timeout(Some(timeout))
        .map_err(|error| error.to_string())?;
    stream
        .set_write_timeout(Some(timeout))
        .map_err(|error| error.to_string())?;
    stream
        .write_all(br#"{"schema":"openscout.probe.capabilities/v1"}"#)
        .map_err(|error| error.to_string())?;
    let _ = stream.shutdown(std::net::Shutdown::Write);
    let mut raw = String::new();
    stream
        .read_to_string(&mut raw)
        .map_err(|error| error.to_string())?;
    let value: Value = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
    let schema = value
        .get("schema")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if schema != CAPABILITIES_SCHEMA {
        return Err(format!("unexpected probe capabilities schema: {schema}"));
    }
    let daemon_version = value
        .get("daemonVersion")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string();
    let families = serde_json::from_value::<Vec<ProbeCapability>>(
        value
            .get("families")
            .cloned()
            .unwrap_or(Value::Array(Vec::new())),
    )
    .map_err(|error| error.to_string())?;
    Ok((daemon_version, families))
}

fn handle_connection(
    mut stream: UnixStream,
    engine: ProbeEngine,
    connection_permit: JobPermit,
) -> Result<(), String> {
    let timeout = engine.options.connection_io_timeout;
    stream
        .set_read_timeout(Some(timeout))
        .map_err(|error| error.to_string())?;
    stream
        .set_write_timeout(Some(timeout))
        .map_err(|error| error.to_string())?;
    let bytes = read_one_request(&mut stream)?;
    let response = if bytes.len() as u64 > REQUEST_READ_CAP_BYTES {
        error_response("request_too_large", "probe request exceeded the read limit")
    } else {
        match parse_request(&bytes) {
            Ok(ParsedRequest::Capabilities) => capabilities_response(engine.capabilities()),
            Ok(ParsedRequest::Probe(request)) => {
                let probe_id = request.probe_id.unwrap_or_default();
                match serde_json::to_value(engine.snapshot(
                    &probe_id,
                    request.key,
                    request.max_age_ms,
                    request.op_timeout_ms,
                )) {
                    Ok(value) => value,
                    Err(error) => error_response("serialize_error", &error.to_string()),
                }
            }
            Ok(ParsedRequest::Repo(request)) => {
                match serde_json::to_value(engine.run_repo_job(request.operation, request.body)) {
                    Ok(value) => value,
                    Err(error) => repo_job_error_response(
                        request.operation,
                        "serialize_error",
                        &error.to_string(),
                        false,
                    ),
                }
            }
            Ok(ParsedRequest::Exec(request)) => {
                let verb = request.verb.unwrap_or_default();
                match serde_json::to_value(engine.run_exec_job(verb.clone(), request.args)) {
                    Ok(value) => value,
                    Err(error) => {
                        exec_error_response(&verb, "serialize_error", &error.to_string(), false)
                    }
                }
            }
            Ok(ParsedRequest::NativeRead(request)) => {
                if request.mode == NativeReadMode::Subscribe
                    && matches!(request.resource.as_str(), "agents" | "feed" | "thread")
                {
                    let native_permit = match engine.native_subscription_jobs.acquire() {
                        Ok(permit) => permit,
                        Err(error) => {
                            return write_json_line(
                                &mut stream,
                                &error_response(&error.code, &error.message),
                                engine.options.repo_job_response_cap_bytes,
                            );
                        }
                    };
                    // Parsing and admission occur under the general connection
                    // permit. Once admitted, the dedicated native permit owns
                    // the long-lived stream and the global pool is released.
                    drop(connection_permit);
                    let result = handle_native_read_connection(&mut stream, &engine, request);
                    drop(native_permit);
                    return result;
                }
                return handle_native_read_connection(&mut stream, &engine, request);
            }
            Err(error) => error_response(&error.code, &error.message),
        }
    };
    let payload =
        serialize_response_with_cap(response, engine.options.repo_job_response_cap_bytes)?;
    stream
        .write_all(&payload)
        .map_err(|error| error.to_string())?;
    stream.write_all(b"\n").map_err(|error| error.to_string())?;
    Ok(())
}

fn handle_native_read_connection(
    stream: &mut UnixStream,
    engine: &ProbeEngine,
    request: NativeReadRequest,
) -> Result<(), String> {
    let Some(service) = engine.native_reads.as_ref() else {
        return write_json_line(
            stream,
            &error_response(
                "native_read_unavailable",
                "native read projection is disabled",
            ),
            engine.options.repo_job_response_cap_bytes,
        );
    };

    match request.resource.as_str() {
        "agents" => handle_native_agents_connection(stream, engine, service, &request),
        "feed" => handle_native_feed_connection(stream, engine, service, &request),
        "thread" => handle_native_thread_connection(stream, engine, service, &request),
        _ => write_json_line(
            stream,
            &error_response(
                "unsupported_resource",
                &format!("unsupported native read resource: {}", request.resource),
            ),
            engine.options.repo_job_response_cap_bytes,
        ),
    }
}

fn handle_native_agents_connection(
    stream: &mut UnixStream,
    engine: &ProbeEngine,
    service: &NativeReadService,
    request: &NativeReadRequest,
) -> Result<(), String> {
    let initial = service.snapshot(request);
    write_json_line(
        stream,
        &serde_json::to_value(&initial).map_err(|error| error.to_string())?,
        engine.options.repo_job_response_cap_bytes,
    )?;
    if request.mode != NativeReadMode::Subscribe {
        return Ok(());
    }

    // The first frame is always a complete bounded snapshot, so it resets the
    // subscriber cursor even if the daemon restarted with a lower sequence.
    let mut sequence = initial.sequence;
    let mut last_heartbeat = Instant::now();
    loop {
        if native_read_peer_closed(stream)? {
            return Ok(());
        }
        if let Some(snapshot) =
            service.wait_for_change(request, sequence, NATIVE_READ_PEER_CHECK_INTERVAL)
        {
            sequence = snapshot.sequence;
            write_json_line(
                stream,
                &serde_json::to_value(snapshot).map_err(|error| error.to_string())?,
                engine.options.repo_job_response_cap_bytes,
            )?;
        } else if last_heartbeat.elapsed() >= NATIVE_READ_HEARTBEAT_INTERVAL {
            write_json_line(
                stream,
                &serde_json::to_value(service.heartbeat(request))
                    .map_err(|error| error.to_string())?,
                engine.options.repo_job_response_cap_bytes,
            )?;
            last_heartbeat = Instant::now();
        }
    }
}

fn handle_native_feed_connection(
    stream: &mut UnixStream,
    engine: &ProbeEngine,
    service: &NativeReadService,
    request: &NativeReadRequest,
) -> Result<(), String> {
    let Some((mut revision, initial)) = service.feed_snapshot(request) else {
        return write_json_line(
            stream,
            &error_response(
                "native_read_unavailable",
                "native feed artifact is unavailable",
            ),
            engine.options.repo_job_response_cap_bytes,
        );
    };
    write_json_line(
        stream,
        &serde_json::to_value(&initial).map_err(|error| error.to_string())?,
        engine.options.repo_job_response_cap_bytes,
    )?;
    if request.mode != NativeReadMode::Subscribe {
        return Ok(());
    }

    let mut last_heartbeat = Instant::now();
    loop {
        if native_read_peer_closed(stream)? {
            return Ok(());
        }
        if let Some((next_revision, snapshot)) =
            service.wait_for_feed_change(request, revision, NATIVE_READ_PEER_CHECK_INTERVAL)
        {
            revision = next_revision;
            write_json_line(
                stream,
                &serde_json::to_value(snapshot).map_err(|error| error.to_string())?,
                engine.options.repo_job_response_cap_bytes,
            )?;
        } else if last_heartbeat.elapsed() >= NATIVE_READ_HEARTBEAT_INTERVAL {
            if let Some(heartbeat) = service.feed_heartbeat(request) {
                write_json_line(
                    stream,
                    &serde_json::to_value(heartbeat).map_err(|error| error.to_string())?,
                    engine.options.repo_job_response_cap_bytes,
                )?;
            }
            last_heartbeat = Instant::now();
        }
    }
}

fn handle_native_thread_connection(
    stream: &mut UnixStream,
    engine: &ProbeEngine,
    service: &NativeReadService,
    request: &NativeReadRequest,
) -> Result<(), String> {
    let Some(feed_id) = request
        .feed_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    else {
        return write_json_line(
            stream,
            &error_response("invalid_request", "thread reads require an explicit feedId"),
            engine.options.repo_job_response_cap_bytes,
        );
    };
    if feed_id.starts_with("obs:") {
        return write_json_line(
            stream,
            &error_response(
                "thread_not_available",
                "observed sessions use the native session/tail detail path",
            ),
            engine.options.repo_job_response_cap_bytes,
        );
    }
    let Some(expected_conversation_id) = feed_id
        .strip_prefix("conv:")
        .filter(|value| !value.is_empty())
    else {
        return write_json_line(
            stream,
            &error_response(
                "invalid_request",
                "thread feedId must identify a Scout conversation",
            ),
            engine.options.repo_job_response_cap_bytes,
        );
    };
    if request
        .conversation_id
        .as_deref()
        .is_some_and(|conversation_id| conversation_id != expected_conversation_id)
    {
        return write_json_line(
            stream,
            &error_response(
                "invalid_request",
                "thread feedId and conversationId do not match",
            ),
            engine.options.repo_job_response_cap_bytes,
        );
    }

    let Some((mut revision, initial)) = service.thread_snapshot(request) else {
        return write_json_line(
            stream,
            &error_response(
                "thread_not_available",
                "native thread artifact is unavailable for this Scout conversation",
            ),
            engine.options.repo_job_response_cap_bytes,
        );
    };
    write_json_line(
        stream,
        &serde_json::to_value(&initial).map_err(|error| error.to_string())?,
        engine.options.repo_job_response_cap_bytes,
    )?;
    if request.mode != NativeReadMode::Subscribe {
        return Ok(());
    }

    let mut last_heartbeat = Instant::now();
    loop {
        if native_read_peer_closed(stream)? {
            return Ok(());
        }
        if let Some((next_revision, snapshot)) =
            service.wait_for_thread_change(request, revision, NATIVE_READ_PEER_CHECK_INTERVAL)
        {
            revision = next_revision;
            write_json_line(
                stream,
                &serde_json::to_value(snapshot).map_err(|error| error.to_string())?,
                engine.options.repo_job_response_cap_bytes,
            )?;
        } else if last_heartbeat.elapsed() >= NATIVE_READ_HEARTBEAT_INTERVAL {
            if let Some(heartbeat) = service.thread_heartbeat(request) {
                write_json_line(
                    stream,
                    &serde_json::to_value(heartbeat).map_err(|error| error.to_string())?,
                    engine.options.repo_job_response_cap_bytes,
                )?;
            }
            last_heartbeat = Instant::now();
        }
    }
}

fn native_read_peer_closed(stream: &UnixStream) -> Result<bool, String> {
    let mut byte = [0_u8; 1];
    let received = unsafe {
        libc::recv(
            stream.as_raw_fd(),
            byte.as_mut_ptr().cast(),
            byte.len(),
            libc::MSG_PEEK | libc::MSG_DONTWAIT,
        )
    };
    if received == 0 {
        return Ok(true);
    }
    if received > 0 {
        return Ok(false);
    }
    let error = std::io::Error::last_os_error();
    if error.kind() == std::io::ErrorKind::WouldBlock {
        Ok(false)
    } else {
        Err(error.to_string())
    }
}

fn write_json_line(
    stream: &mut UnixStream,
    value: &Value,
    response_cap_bytes: usize,
) -> Result<(), String> {
    let payload = serialize_response_with_cap(value.clone(), response_cap_bytes)?;
    stream
        .write_all(&payload)
        .map_err(|error| error.to_string())?;
    stream.write_all(b"\n").map_err(|error| error.to_string())
}

fn read_one_request(stream: &mut UnixStream) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 8192];
    loop {
        let read = stream
            .read(&mut buffer)
            .map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        bytes.extend_from_slice(&buffer[..read]);
        if let Some(index) = bytes.iter().position(|byte| *byte == b'\n') {
            bytes.truncate(index);
            break;
        }
        if bytes.len() as u64 > REQUEST_READ_CAP_BYTES {
            break;
        }
    }
    Ok(bytes)
}

#[derive(Debug)]
enum ParsedRequest {
    Capabilities,
    Probe(ProbeRequest),
    Repo(RepoJobRequest),
    Exec(ExecRequest),
    NativeRead(NativeReadRequest),
}

#[derive(Debug)]
struct RepoJobRequest {
    operation: RepoOperation,
    body: Value,
}

fn parse_request(bytes: &[u8]) -> Result<ParsedRequest, ProbeFailure> {
    let value: Value = serde_json::from_slice(bytes).map_err(|error| ProbeFailure {
        code: "invalid_json".to_string(),
        message: format!("malformed probe request JSON: {error}"),
        timed_out: false,
    })?;
    let schema = value
        .get("schema")
        .and_then(Value::as_str)
        .ok_or_else(|| ProbeFailure {
            code: "invalid_request".to_string(),
            message: "probe request missing schema".to_string(),
            timed_out: false,
        })?;
    match schema {
        CAPABILITIES_SCHEMA => Ok(ParsedRequest::Capabilities),
        REQUEST_SCHEMA => {
            let request: ProbeRequest =
                serde_json::from_value(value).map_err(|error| ProbeFailure {
                    code: "invalid_request".to_string(),
                    message: format!("invalid probe request: {error}"),
                    timed_out: false,
                })?;
            if request
                .probe_id
                .as_deref()
                .unwrap_or_default()
                .trim()
                .is_empty()
            {
                return Err(ProbeFailure {
                    code: "invalid_request".to_string(),
                    message: "probe request missing probeId".to_string(),
                    timed_out: false,
                });
            }
            Ok(ParsedRequest::Probe(request))
        }
        REPO_SCAN_SCHEMA => Ok(ParsedRequest::Repo(RepoJobRequest {
            operation: RepoOperation::Scan,
            body: value,
        })),
        REPO_DIFF_SCHEMA => Ok(ParsedRequest::Repo(RepoJobRequest {
            operation: RepoOperation::Diff,
            body: value,
        })),
        EXEC_REQUEST_SCHEMA => {
            let request: ExecRequest =
                serde_json::from_value(value).map_err(|error| ProbeFailure {
                    code: "invalid_request".to_string(),
                    message: format!("invalid exec request: {error}"),
                    timed_out: false,
                })?;
            if request
                .verb
                .as_deref()
                .unwrap_or_default()
                .trim()
                .is_empty()
            {
                return Err(ProbeFailure {
                    code: "invalid_request".to_string(),
                    message: "exec request missing verb".to_string(),
                    timed_out: false,
                });
            }
            Ok(ParsedRequest::Exec(request))
        }
        NATIVE_READ_REQUEST_SCHEMA => {
            let request: NativeReadRequest =
                serde_json::from_value(value).map_err(|error| ProbeFailure {
                    code: "invalid_request".to_string(),
                    message: format!("invalid native read request: {error}"),
                    timed_out: false,
                })?;
            if request.resource.trim().is_empty() {
                return Err(ProbeFailure {
                    code: "invalid_request".to_string(),
                    message: "native read request missing resource".to_string(),
                    timed_out: false,
                });
            }
            Ok(ParsedRequest::NativeRead(request))
        }
        other => Err(ProbeFailure {
            code: "unsupported_schema".to_string(),
            message: format!("unsupported probe request schema: {other}"),
            timed_out: false,
        }),
    }
}

fn capabilities_response(families: Vec<ProbeCapability>) -> Value {
    json!({
        "schema": CAPABILITIES_SCHEMA,
        "daemonVersion": DAEMON_VERSION,
        "families": families,
        "verbs": served_exec_capabilities(),
    })
}

fn served_capabilities() -> Vec<ProbeCapability> {
    vec![
        ProbeCapability {
            probe_id: TAILSCALE_STATUS_ID.to_string(),
            schema_version: 1,
            ttl_ms: TAILSCALE_STATUS_TTL_MS,
        },
        ProbeCapability {
            probe_id: GIT_BUILD_INFO_ID.to_string(),
            schema_version: 1,
            ttl_ms: GIT_BUILD_INFO_TTL_MS,
        },
        ProbeCapability {
            probe_id: GIT_REV_PARSE_ID.to_string(),
            schema_version: 1,
            ttl_ms: GIT_CATALOG_TTL_MS,
        },
        ProbeCapability {
            probe_id: GIT_DIFF_SHORTSTAT_ID.to_string(),
            schema_version: 1,
            ttl_ms: GIT_CATALOG_TTL_MS,
        },
        ProbeCapability {
            probe_id: GIT_STATUS_PORCELAIN_ID.to_string(),
            schema_version: 1,
            ttl_ms: GIT_CATALOG_TTL_MS,
        },
        ProbeCapability {
            probe_id: GIT_MERGE_BASE_ID.to_string(),
            schema_version: 1,
            ttl_ms: GIT_CATALOG_TTL_MS,
        },
        ProbeCapability {
            probe_id: GIT_LOG_LAST_COMMIT_UNIX_ID.to_string(),
            schema_version: 1,
            ttl_ms: GIT_CATALOG_TTL_MS,
        },
        ProbeCapability {
            probe_id: GIT_WORKTREE_LIST_PORCELAIN_ID.to_string(),
            schema_version: 1,
            ttl_ms: GIT_CATALOG_TTL_MS,
        },
        ProbeCapability {
            probe_id: PS_RUNTIME_ID.to_string(),
            schema_version: 1,
            ttl_ms: PS_RUNTIME_TTL_MS,
        },
        ProbeCapability {
            probe_id: PS_DISCOVERY_ID.to_string(),
            schema_version: 1,
            ttl_ms: PS_DISCOVERY_TTL_MS,
        },
        ProbeCapability {
            probe_id: PS_CWD_ID.to_string(),
            schema_version: 1,
            ttl_ms: PS_CWD_TTL_MS,
        },
        ProbeCapability {
            probe_id: NET_LISTENERS_ID.to_string(),
            schema_version: 1,
            ttl_ms: NET_LISTENERS_TTL_MS,
        },
        ProbeCapability {
            probe_id: TMUX_SESSIONS_ID.to_string(),
            schema_version: 3,
            ttl_ms: TMUX_TTL_MS,
        },
        ProbeCapability {
            probe_id: TMUX_PANES_ID.to_string(),
            schema_version: 1,
            ttl_ms: TMUX_TTL_MS,
        },
        ProbeCapability {
            probe_id: ZELLIJ_SESSIONS_ID.to_string(),
            schema_version: 1,
            ttl_ms: ZELLIJ_TTL_MS,
        },
        ProbeCapability {
            probe_id: REPO_SCAN_CAPABILITY_ID.to_string(),
            schema_version: 1,
            ttl_ms: 0,
        },
        ProbeCapability {
            probe_id: REPO_DIFF_CAPABILITY_ID.to_string(),
            schema_version: 1,
            ttl_ms: 0,
        },
    ]
}

fn served_exec_capabilities() -> Vec<ExecVerbCapability> {
    EXEC_VERBS
        .iter()
        .map(|verb| ExecVerbCapability {
            verb: (*verb).to_string(),
            schema_version: 1,
        })
        .collect()
}

fn error_response(code: &str, message: &str) -> Value {
    json!({
        "schema": ERROR_SCHEMA,
        "error": {
            "code": code,
            "message": message,
        },
        "daemonVersion": DAEMON_VERSION,
    })
}

fn repo_job_response(
    operation: RepoOperation,
    value: Value,
    error: Option<JsonError>,
) -> RepoJobResponse {
    RepoJobResponse {
        schema: REPO_RESPONSE_SCHEMA.to_string(),
        operation: operation.capability_id().to_string(),
        generated_at: epoch_ms(),
        value,
        error,
        daemon_version: DAEMON_VERSION.to_string(),
    }
}

fn repo_job_error_response(
    operation: RepoOperation,
    code: &str,
    message: &str,
    timed_out: bool,
) -> Value {
    serde_json::to_value(repo_job_response(
        operation,
        Value::Null,
        Some(JsonError {
            code: code.to_string(),
            message: message.to_string(),
            timed_out: if timed_out { Some(true) } else { None },
        }),
    ))
    .unwrap_or_else(|_| error_response(code, message))
}

fn exec_response(
    verb: &str,
    ok: bool,
    value: Option<Value>,
    error: Option<JsonError>,
) -> ExecResponse {
    ExecResponse {
        schema: EXEC_RESPONSE_SCHEMA.to_string(),
        verb: verb.to_string(),
        ok,
        value,
        error,
        daemon_version: DAEMON_VERSION.to_string(),
    }
}

fn exec_error_response(verb: &str, code: &str, message: &str, timed_out: bool) -> Value {
    serde_json::to_value(exec_response(
        verb,
        false,
        None,
        Some(JsonError {
            code: code.to_string(),
            message: message.to_string(),
            timed_out: if timed_out { Some(true) } else { None },
        }),
    ))
    .unwrap_or_else(|_| error_response(code, message))
}

fn run_repo_operation_with_timeout(
    operation: RepoOperation,
    input: Value,
    timeout: Duration,
) -> Result<Value, ProbeFailure> {
    if timeout.is_zero() {
        return Err(ProbeFailure {
            code: "timeout".to_string(),
            message: "repo job timed out after 0ms".to_string(),
            timed_out: true,
        });
    }
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let result = match operation {
            RepoOperation::Scan => repo_service::scan_value(input),
            RepoOperation::Diff => repo_service::diff_value(input),
        };
        let _ = sender.send(result);
    });
    match receiver.recv_timeout(timeout) {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(message)) => Err(ProbeFailure {
            code: "invalid_request".to_string(),
            message,
            timed_out: false,
        }),
        Err(mpsc::RecvTimeoutError::Timeout) => Err(ProbeFailure {
            code: "timeout".to_string(),
            message: format!("repo job timed out after {}ms", timeout.as_millis()),
            timed_out: true,
        }),
        Err(mpsc::RecvTimeoutError::Disconnected) => Err(ProbeFailure {
            code: "worker".to_string(),
            message: "repo job worker exited without a response".to_string(),
            timed_out: false,
        }),
    }
}

fn serialize_response_with_cap(
    response: Value,
    repo_response_cap: usize,
) -> Result<Vec<u8>, String> {
    let mut payload = serde_json::to_vec(&response).map_err(|error| error.to_string())?;
    if payload.len() <= repo_response_cap {
        return Ok(payload);
    }
    let operation = response
        .get("operation")
        .and_then(Value::as_str)
        .and_then(repo_operation_from_capability_id);
    if response.get("schema").and_then(Value::as_str) == Some(REPO_RESPONSE_SCHEMA) {
        let operation = operation.unwrap_or(RepoOperation::Scan);
        let capped = repo_job_error_response(
            operation,
            "output_cap",
            &format!("repo job response exceeded {repo_response_cap} bytes"),
            false,
        );
        payload = serde_json::to_vec(&capped).map_err(|error| error.to_string())?;
    } else if response.get("schema").and_then(Value::as_str) == Some(SNAPSHOT_SCHEMA) {
        let probe_id = response
            .get("probeId")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string();
        let key = response
            .get("key")
            .and_then(Value::as_str)
            .map(|value| value.to_string());
        let ttl_ms = response.get("ttlMs").and_then(Value::as_u64).unwrap_or(0);
        let capped = ProbeSnapshotResponse {
            schema: SNAPSHOT_SCHEMA.to_string(),
            probe_id,
            key,
            generated_at: epoch_ms(),
            ttl_ms,
            value: Value::Null,
            error: Some(JsonError {
                code: "output_cap".to_string(),
                message: format!("probe snapshot response exceeded {repo_response_cap} bytes"),
                timed_out: Some(false),
            }),
            daemon_version: DAEMON_VERSION.to_string(),
        };
        payload = serde_json::to_vec(&capped).map_err(|error| error.to_string())?;
    }
    Ok(payload)
}

fn repo_operation_from_capability_id(value: &str) -> Option<RepoOperation> {
    match value {
        REPO_SCAN_CAPABILITY_ID => Some(RepoOperation::Scan),
        REPO_DIFF_CAPABILITY_ID => Some(RepoOperation::Diff),
        _ => None,
    }
}

fn error_snapshot(
    probe_id: &str,
    key: Option<String>,
    ttl_ms: u64,
    error: ProbeFailure,
) -> ProbeSnapshotResponse {
    ProbeSnapshotResponse {
        schema: SNAPSHOT_SCHEMA.to_string(),
        probe_id: probe_id.to_string(),
        key,
        generated_at: epoch_ms(),
        ttl_ms,
        value: Value::Null,
        error: Some(JsonError {
            code: error.code,
            message: error.message,
            timed_out: if error.timed_out { Some(true) } else { None },
        }),
        daemon_version: DAEMON_VERSION.to_string(),
    }
}

fn snapshot_is_fresh_for(snapshot: &ProbeSnapshotResponse, max_age_ms: u64) -> bool {
    if max_age_ms == 0 {
        return false;
    }
    epoch_ms().saturating_sub(snapshot.generated_at) <= u128::from(max_age_ms)
}

fn is_supported_probe(probe_id: &str) -> bool {
    #[cfg(test)]
    if probe_id == TEST_PANIC_PROBE_ID {
        return true;
    }
    matches!(
        probe_id,
        TAILSCALE_STATUS_ID
            | GIT_BUILD_INFO_ID
            | GIT_REV_PARSE_ID
            | GIT_DIFF_SHORTSTAT_ID
            | GIT_STATUS_PORCELAIN_ID
            | GIT_MERGE_BASE_ID
            | GIT_LOG_LAST_COMMIT_UNIX_ID
            | GIT_WORKTREE_LIST_PORCELAIN_ID
            | PS_RUNTIME_ID
            | PS_DISCOVERY_ID
            | PS_CWD_ID
            | NET_LISTENERS_ID
            | TMUX_SESSIONS_ID
            | TMUX_PANES_ID
            | ZELLIJ_SESSIONS_ID
    )
}

fn probe_ttl_ms(probe_id: &str) -> Option<u64> {
    #[cfg(test)]
    if probe_id == TEST_PANIC_PROBE_ID {
        return Some(1_000);
    }
    match probe_id {
        TAILSCALE_STATUS_ID => Some(TAILSCALE_STATUS_TTL_MS),
        GIT_BUILD_INFO_ID => Some(GIT_BUILD_INFO_TTL_MS),
        GIT_REV_PARSE_ID
        | GIT_DIFF_SHORTSTAT_ID
        | GIT_STATUS_PORCELAIN_ID
        | GIT_MERGE_BASE_ID
        | GIT_LOG_LAST_COMMIT_UNIX_ID
        | GIT_WORKTREE_LIST_PORCELAIN_ID => Some(GIT_CATALOG_TTL_MS),
        PS_RUNTIME_ID => Some(PS_RUNTIME_TTL_MS),
        PS_DISCOVERY_ID => Some(PS_DISCOVERY_TTL_MS),
        PS_CWD_ID => Some(PS_CWD_TTL_MS),
        NET_LISTENERS_ID => Some(NET_LISTENERS_TTL_MS),
        TMUX_SESSIONS_ID | TMUX_PANES_ID => Some(TMUX_TTL_MS),
        ZELLIJ_SESSIONS_ID => Some(ZELLIJ_TTL_MS),
        _ => None,
    }
}

fn normalize_probe_key(
    probe_id: &str,
    key: Option<String>,
) -> Result<Option<String>, ProbeFailure> {
    match probe_id {
        TAILSCALE_STATUS_ID => Ok(None),
        PS_RUNTIME_ID | PS_DISCOVERY_ID => Ok(None),
        TMUX_SESSIONS_ID => {
            let normalized = key
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or("default");
            Ok(Some(normalized.to_string()))
        }
        ZELLIJ_SESSIONS_ID => {
            let normalized = key
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .unwrap_or_else(default_zellij_socket_dir);
            Ok(Some(normalized))
        }
        GIT_BUILD_INFO_ID => {
            let raw_key = key
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| ProbeFailure {
                    code: "invalid_request".to_string(),
                    message: "git.buildInfo requires a repo root key".to_string(),
                    timed_out: false,
                })?;
            Ok(Some(canonical_repo_root(raw_key)))
        }
        GIT_REV_PARSE_ID | GIT_DIFF_SHORTSTAT_ID | GIT_STATUS_PORCELAIN_ID | GIT_MERGE_BASE_ID => {
            let normalized = key
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| ProbeFailure {
                    code: "invalid_request".to_string(),
                    message: format!("{probe_id} requires a typed key"),
                    timed_out: false,
                })?;
            Ok(Some(normalized.to_string()))
        }
        GIT_LOG_LAST_COMMIT_UNIX_ID | GIT_WORKTREE_LIST_PORCELAIN_ID => {
            let raw_key = key
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| ProbeFailure {
                    code: "invalid_request".to_string(),
                    message: format!("{probe_id} requires a repo root key"),
                    timed_out: false,
                })?;
            Ok(Some(canonical_repo_root(raw_key)))
        }
        PS_CWD_ID => {
            let normalized = key
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| ProbeFailure {
                    code: "invalid_request".to_string(),
                    message: "ps.cwd requires a pid key".to_string(),
                    timed_out: false,
                })?;
            Ok(Some(normalized.to_string()))
        }
        NET_LISTENERS_ID => {
            let normalized = key
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| ProbeFailure {
                    code: "invalid_request".to_string(),
                    message: "net.listeners requires a port key".to_string(),
                    timed_out: false,
                })?;
            Ok(Some(normalized.to_string()))
        }
        TMUX_PANES_ID => {
            let normalized = key
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| ProbeFailure {
                    code: "invalid_request".to_string(),
                    message: "tmux.panes requires a pane key".to_string(),
                    timed_out: false,
                })?;
            Ok(Some(normalized.to_string()))
        }
        _ => Ok(key),
    }
}

fn validate_git_ref(value: &str, label: &str) -> Result<String, ProbeFailure> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(ProbeFailure {
            code: "invalid_request".to_string(),
            message: format!("{label} is required"),
            timed_out: false,
        });
    }
    if trimmed.starts_with('-') {
        return Err(ProbeFailure {
            code: "invalid_request".to_string(),
            message: format!("{label} must not start with '-'"),
            timed_out: false,
        });
    }
    if trimmed.contains('\0') {
        return Err(ProbeFailure {
            code: "invalid_request".to_string(),
            message: format!("{label} contains a NUL byte"),
            timed_out: false,
        });
    }
    Ok(trimmed.to_string())
}

fn validate_git_pathspec(value: &str, label: &str) -> Result<String, ProbeFailure> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(ProbeFailure {
            code: "invalid_request".to_string(),
            message: format!("{label} is required"),
            timed_out: false,
        });
    }
    if trimmed.starts_with('-') {
        return Err(ProbeFailure {
            code: "invalid_request".to_string(),
            message: format!("{label} must not start with '-'"),
            timed_out: false,
        });
    }
    if trimmed.contains('\0') {
        return Err(ProbeFailure {
            code: "invalid_request".to_string(),
            message: format!("{label} contains a NUL byte"),
            timed_out: false,
        });
    }
    Ok(trimmed.to_string())
}

fn git_rev_parse_args(input: &GitRevParseKey) -> Result<Vec<String>, ProbeFailure> {
    let args = match input.kind.as_str() {
        "showToplevel" => vec!["rev-parse", "--show-toplevel"],
        "gitDir" => vec!["rev-parse", "--git-dir"],
        "gitCommonDir" => vec!["rev-parse", "--git-common-dir"],
        "isInsideWorkTree" => vec!["rev-parse", "--is-inside-work-tree"],
        "shortHead" => vec!["rev-parse", "--short", "HEAD"],
        "abbrevRefHead" => vec!["rev-parse", "--abbrev-ref", "HEAD"],
        "upstreamSymbolicFullName" => {
            vec![
                "rev-parse",
                "--abbrev-ref",
                "--symbolic-full-name",
                "@{upstream}",
            ]
        }
        "verifyCommit" => {
            let ref_value =
                validate_git_ref(input.r#ref.as_deref().unwrap_or_default(), "git verify ref")?;
            let mut args = vec!["rev-parse", "--verify"];
            if input.quiet.unwrap_or(false) {
                args.push("--quiet");
            }
            args.push("--end-of-options");
            return Ok(args
                .into_iter()
                .map(str::to_string)
                .chain(std::iter::once(format!("{ref_value}^{{commit}}")))
                .collect());
        }
        other => {
            return Err(ProbeFailure {
                code: "invalid_request".to_string(),
                message: format!("unsupported git.revParse kind: {other}"),
                timed_out: false,
            })
        }
    };
    Ok(args.into_iter().map(str::to_string).collect())
}

fn git_diff_selector_args(selector: &GitDiffSelectorKey) -> Result<Vec<String>, ProbeFailure> {
    match selector {
        GitDiffSelectorKey::Unstaged => Ok(vec![]),
        GitDiffSelectorKey::Staged => Ok(vec!["--cached".to_string()]),
        GitDiffSelectorKey::FromRef { r#ref } => Ok(vec![
            "--end-of-options".to_string(),
            validate_git_ref(r#ref, "git diff ref")?,
        ]),
        GitDiffSelectorKey::TwoRefs {
            base_ref,
            compare_ref,
        } => Ok(vec![
            "--end-of-options".to_string(),
            validate_git_ref(base_ref, "git diff base ref")?,
            validate_git_ref(compare_ref, "git diff compare ref")?,
        ]),
        GitDiffSelectorKey::Range {
            notation,
            base_ref,
            compare_ref,
        } => {
            let operator = match notation.as_str() {
                "dotdot" => "..",
                "ellipsis" => "...",
                other => {
                    return Err(ProbeFailure {
                        code: "invalid_request".to_string(),
                        message: format!("unsupported git diff range notation: {other}"),
                        timed_out: false,
                    })
                }
            };
            Ok(vec![
                "--end-of-options".to_string(),
                format!(
                    "{}{operator}{}",
                    validate_git_ref(base_ref, "git diff base ref")?,
                    validate_git_ref(compare_ref, "git diff compare ref")?
                ),
            ])
        }
    }
}

fn git_diff_shortstat_args(input: &GitDiffShortstatKey) -> Result<Vec<String>, ProbeFailure> {
    let mut args = vec!["diff".to_string(), "--shortstat".to_string()];
    args.extend(git_diff_selector_args(&input.selector)?);
    if !input.paths.is_empty() {
        args.push("--".to_string());
        for (index, path) in input.paths.iter().enumerate() {
            args.push(validate_git_pathspec(
                path,
                &format!("git pathspec {}", index + 1),
            )?);
        }
    }
    Ok(args)
}

fn git_status_porcelain_args(input: &GitStatusPorcelainKey) -> Result<Vec<String>, ProbeFailure> {
    let version = match input.version.as_str() {
        "v1" | "v2" => input.version.as_str(),
        other => {
            return Err(ProbeFailure {
                code: "invalid_request".to_string(),
                message: format!("unsupported git status porcelain version: {other}"),
                timed_out: false,
            })
        }
    };
    let mut args = vec!["status".to_string(), format!("--porcelain={version}")];
    if input.branch.unwrap_or(false) {
        args.push("--branch".to_string());
    }
    if input.z.unwrap_or(false) {
        args.push("-z".to_string());
    }
    if let Some(mode) = input.untracked_mode.as_deref() {
        match mode {
            "normal" => args.push("-unormal".to_string()),
            other => {
                return Err(ProbeFailure {
                    code: "invalid_request".to_string(),
                    message: format!("unsupported git status untrackedMode: {other}"),
                    timed_out: false,
                })
            }
        }
    }
    if !input.paths.is_empty() {
        args.push("--".to_string());
        for (index, path) in input.paths.iter().enumerate() {
            args.push(validate_git_pathspec(
                path,
                &format!("git pathspec {}", index + 1),
            )?);
        }
    }
    Ok(args)
}

fn git_merge_base_args(input: &GitMergeBaseKey) -> Result<Vec<String>, ProbeFailure> {
    Ok(vec![
        "merge-base".to_string(),
        "--end-of-options".to_string(),
        validate_git_ref(&input.base_ref, "git merge-base base ref")?,
        validate_git_ref(&input.compare_ref, "git merge-base compare ref")?,
    ])
}

fn trimmed_string_value(value: Option<&str>) -> Value {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| Value::String(value.to_string()))
        .unwrap_or(Value::Null)
}

fn positive_u32(value: &str) -> Option<u32> {
    value.trim().parse::<u32>().ok().filter(|value| *value > 0)
}

fn normalize_tty(value: Option<&str>) -> Value {
    let normalized = value
        .unwrap_or_default()
        .trim()
        .strip_prefix("/dev/")
        .unwrap_or_else(|| value.unwrap_or_default().trim())
        .trim();
    if normalized.is_empty() || normalized == "??" || normalized == "?" {
        Value::Null
    } else {
        Value::String(normalized.to_string())
    }
}

fn parse_process_number(value: Option<&str>) -> Option<u32> {
    value
        .unwrap_or_default()
        .parse::<u32>()
        .ok()
        .filter(|value| *value > 0)
}

fn parse_process_rows(output: &str) -> Vec<Value> {
    output
        .lines()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let pid = parse_process_number(parts.next())?;
            let ppid = parse_process_number(parts.next())?;
            let pgid = parse_process_number(parts.next())?;
            let tty = normalize_tty(parts.next());
            let comm = parts.collect::<Vec<_>>().join(" ");
            if comm.is_empty() {
                return None;
            }
            Some(json!({
                "pid": pid,
                "ppid": ppid,
                "pgid": pgid,
                "comm": comm,
                "tty": tty,
            }))
        })
        .collect()
}

fn parse_process_command_rows(output: &str) -> Vec<Value> {
    output
        .lines()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let pid = parse_process_number(parts.next())?;
            let ppid = parse_process_number(parts.next())?;
            let pgid = parse_process_number(parts.next())?;
            let tty = normalize_tty(parts.next());
            let command = parts.collect::<Vec<_>>().join(" ");
            let (command, _) = truncate_chars(&command, PS_DISCOVERY_MAX_COMMAND_CHARS);
            let comm = command.split_whitespace().next().unwrap_or_default();
            if comm.is_empty() || command.is_empty() {
                return None;
            }
            Some(json!({
                "pid": pid,
                "ppid": ppid,
                "pgid": pgid,
                "comm": comm,
                "tty": tty,
                "command": command,
            }))
        })
        .collect()
}

fn take_token(input: &str) -> Option<(&str, &str)> {
    let trimmed = input.trim_start();
    if trimmed.is_empty() {
        return None;
    }
    let end = trimmed
        .char_indices()
        .find_map(|(index, ch)| ch.is_whitespace().then_some(index))
        .unwrap_or(trimmed.len());
    let token = &trimmed[..end];
    let rest = &trimmed[end..];
    Some((token, rest))
}

fn parse_process_discovery_rows(output: &str) -> Vec<Value> {
    output
        .lines()
        .filter_map(|line| {
            let (pid_raw, rest) = take_token(line)?;
            let (ppid_raw, rest) = take_token(rest)?;
            let (etime, rest) = take_token(rest)?;
            let pid = parse_process_number(Some(pid_raw))?;
            let ppid = parse_process_number(Some(ppid_raw))?;
            let command = rest.trim();
            if etime.is_empty() || command.is_empty() {
                return None;
            }
            Some(json!({
                "pid": pid,
                "ppid": ppid,
                "etime": etime,
                "command": command,
            }))
        })
        .collect()
}

fn truncate_chars(value: &str, max_chars: usize) -> (String, bool) {
    let mut out = String::new();
    let mut count = 0;
    for ch in value.chars() {
        if count >= max_chars {
            return (out, true);
        }
        out.push(ch);
        count += 1;
    }
    (out, false)
}

fn process_discovery_snapshot(rows: Vec<Value>, max_rows: usize) -> Value {
    let total_count = rows.len();
    let mut command_truncated = false;
    let capped = rows
        .into_iter()
        .take(max_rows)
        .map(|row| {
            let Value::Object(mut object) = row else {
                return row;
            };
            if let Some(command) = object.get("command").and_then(Value::as_str) {
                let (trimmed, truncated) = truncate_chars(command, PS_DISCOVERY_MAX_COMMAND_CHARS);
                if truncated {
                    command_truncated = true;
                    object.insert("command".to_string(), Value::String(trimmed));
                }
            }
            Value::Object(object)
        })
        .collect::<Vec<_>>();
    let returned_count = capped.len();
    json!({
        "rows": capped,
        "truncated": total_count > returned_count || command_truncated,
        "totalCount": total_count,
        "returnedCount": returned_count,
    })
}

fn parse_lsof_cwd(output: &str) -> Option<String> {
    output.lines().find_map(|line| {
        line.strip_prefix('n')
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    })
}

fn parse_lsof_listener_pid(output: &str) -> Value {
    for line in output.lines() {
        let Some(pid) = line.strip_prefix('p').and_then(positive_u32) else {
            continue;
        };
        return json!(pid);
    }
    Value::Null
}

fn tmux_socket_args(socket_path: &str, suffix: &[&str]) -> Vec<String> {
    let mut args = Vec::new();
    let socket = socket_path.trim();
    if !socket.is_empty() && socket != "default" {
        args.push("-S".to_string());
        args.push(socket.to_string());
    }
    args.extend(suffix.iter().map(|value| (*value).to_string()));
    args
}

fn split_delimited_line(line: &str, delimiter: char, field_count: usize) -> Vec<String> {
    let mut parts = line
        .split(delimiter)
        .map(str::to_string)
        .collect::<Vec<_>>();
    if parts.len() <= field_count {
        return parts;
    }
    let rest = parts
        .drain(field_count - 1..)
        .collect::<Vec<_>>()
        .join(&delimiter.to_string());
    parts.push(rest);
    parts
}

fn parse_nonnegative_integer(value: Option<&String>, fallback: u64) -> u64 {
    value
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(fallback)
}

fn optional_trimmed_string(value: Option<&String>) -> Value {
    value
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(|value| Value::String(value.to_string()))
        .unwrap_or(Value::Null)
}

fn first_host_label(value: &str) -> &str {
    value.split('.').next().unwrap_or(value)
}

fn is_bare_host_name(value: &str) -> bool {
    value.split('.').all(|label| {
        !label.is_empty()
            && label
                .chars()
                .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-')
    })
}

/// The pane title to report, or null when it is tmux's default. tmux titles a
/// new pane with the host name at the time, so the match ignores case and the
/// domain suffix: a pane titled "box.local" still matches a host that is now
/// "box.lan". Mirrors `reportedTmuxPaneTitle` in the runtime.
fn reported_tmux_pane_title(title: Option<&String>, host: Option<&String>) -> Value {
    let Some(cleaned) = title
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    else {
        return Value::Null;
    };
    let reported = Value::String(cleaned.to_string());
    let Some(host_name) = host
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty())
    else {
        return reported;
    };
    let lowered = cleaned.to_lowercase();
    if lowered == host_name {
        return Value::Null;
    }
    if is_bare_host_name(&lowered) && first_host_label(&lowered) == first_host_label(&host_name) {
        return Value::Null;
    }
    reported
}

fn parse_tmux_session_list(output: &str) -> Vec<Value> {
    output
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() {
                return None;
            }
            // A tab row is never split on "|": its window name or title may hold one.
            let fields = if line.contains('\t') {
                split_delimited_line(line, '\t', TMUX_SESSION_FIELD_COUNT)
            } else {
                split_delimited_line(line, '|', LEGACY_TMUX_SESSION_FIELD_COUNT)
            };
            let name = fields.first()?.to_string();
            if name.is_empty() {
                return None;
            }
            let created_at = fields
                .get(3)
                .and_then(|value| value.parse::<u64>().ok())
                .filter(|value| *value > 0)
                .map(Value::from)
                .unwrap_or(Value::Null);
            let activity_at = fields
                .get(4)
                .and_then(|value| value.parse::<u64>().ok())
                .filter(|value| *value > 0)
                .map(Value::from)
                .unwrap_or(Value::Null);
            Some(json!({
                "name": name,
                "windows": parse_nonnegative_integer(fields.get(1), 1),
                "attached": parse_nonnegative_integer(fields.get(2), 0),
                "createdAt": created_at,
                "activityAt": activity_at,
                "currentCommand": optional_trimmed_string(fields.get(5)),
                "currentPath": optional_trimmed_string(fields.get(6)),
                "windowName": optional_trimmed_string(fields.get(7)),
                "paneTitle": reported_tmux_pane_title(fields.get(9), fields.get(8)),
            }))
        })
        .collect()
}

fn strip_ansi(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = String::with_capacity(value.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == 0x1b && index + 1 < bytes.len() && bytes[index + 1] == b'[' {
            index += 2;
            while index < bytes.len() {
                let byte = bytes[index];
                index += 1;
                if (0x40..=0x7e).contains(&byte) {
                    break;
                }
            }
            continue;
        }
        let Some(ch) = value[index..].chars().next() else {
            break;
        };
        out.push(ch);
        index += ch.len_utf8();
    }
    out
}

fn parse_zellij_session_list(output: &str) -> Vec<Value> {
    strip_ansi(output)
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() {
                return None;
            }
            let name = line.split_whitespace().next()?.to_string();
            if name.is_empty() {
                return None;
            }
            let exited = line
                .split_whitespace()
                .any(|token| token.eq_ignore_ascii_case("EXITED"));
            Some(json!({
                "name": name,
                "state": if exited { "exited" } else { "live" },
                "raw": line,
            }))
        })
        .collect()
}

fn parse_tmux_pane_detail(output: &str) -> Option<Value> {
    let trimmed = output.trim();
    let fields = trimmed.split('\t').collect::<Vec<_>>();
    let pane_pid = parse_process_number(fields.first().copied())?;
    let pane_tty = fields
        .get(1)
        .map(|value| {
            value
                .trim()
                .strip_prefix("/dev/")
                .unwrap_or(value.trim())
                .trim()
        })
        .filter(|value| !value.is_empty())?;
    let pane_current_path = fields
        .get(2)
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(|value| Value::String(value.to_string()))
        .unwrap_or(Value::Null);
    Some(json!({
        "panePid": pane_pid,
        "paneTty": pane_tty,
        "paneCurrentPath": pane_current_path,
    }))
}

fn default_zellij_socket_dir() -> String {
    env_nonempty("ZELLIJ_SOCKET_DIR")
        .or_else(|| env_nonempty("OPENSCOUT_ZELLIJ_SOCKET_DIR"))
        .or_else(|| env_nonempty("HOME").map(|home| format!("{home}/.openscout/zellij-sockets")))
        .unwrap_or_else(|| ".openscout/zellij-sockets".to_string())
}

fn summarize_tailscale_status(status: &Value) -> Value {
    let backend_state = status.get("BackendState").and_then(Value::as_str);
    let running = backend_state
        .map(|value| value.trim().eq_ignore_ascii_case("running"))
        .unwrap_or(false);
    let health = status
        .get("Health")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(|value| Value::String(value.to_string()))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    json!({
        "backendState": backend_state,
        "running": running,
        "health": health,
        "peers": parse_tailscale_peers(status),
        "self": parse_tailscale_self(status),
    })
}

fn parse_tailscale_peers(status: &Value) -> Value {
    let Some(peers) = status.get("Peer").and_then(Value::as_object) else {
        return Value::Array(Vec::new());
    };
    Value::Array(
        peers
            .iter()
            .map(|(fallback_id, peer)| {
                let id = string_field(peer, "ID").unwrap_or_else(|| fallback_id.clone());
                let name = string_field(peer, "HostName")
                    .or_else(|| string_field(peer, "DNSName"))
                    .unwrap_or_else(|| fallback_id.clone());
                let mut map = Map::new();
                map.insert("id".to_string(), Value::String(id));
                map.insert("name".to_string(), Value::String(name));
                insert_string_if_present(&mut map, "dnsName", string_field(peer, "DNSName"));
                map.insert(
                    "addresses".to_string(),
                    string_array_field(peer, "TailscaleIPs"),
                );
                map.insert(
                    "online".to_string(),
                    Value::Bool(peer.get("Online").and_then(Value::as_bool).unwrap_or(false)),
                );
                insert_string_if_present(&mut map, "hostName", string_field(peer, "HostName"));
                insert_string_if_present(&mut map, "os", string_field(peer, "OS"));
                map.insert("tags".to_string(), string_array_field(peer, "Tags"));
                Value::Object(map)
            })
            .collect(),
    )
}

fn parse_tailscale_self(status: &Value) -> Value {
    let Some(self_node) = status.get("Self") else {
        return Value::Null;
    };
    let id = string_field(self_node, "ID")
        .or_else(|| string_field(self_node, "DNSName"))
        .or_else(|| string_field(self_node, "HostName"))
        .unwrap_or_else(|| "self".to_string());
    let name = string_field(self_node, "HostName")
        .or_else(|| string_field(self_node, "DNSName"))
        .unwrap_or_else(|| "self".to_string());
    let mut map = Map::new();
    map.insert("id".to_string(), Value::String(id));
    map.insert("name".to_string(), Value::String(name));
    insert_string_if_present(&mut map, "dnsName", string_field(self_node, "DNSName"));
    map.insert(
        "addresses".to_string(),
        string_array_field(self_node, "TailscaleIPs"),
    );
    map.insert(
        "online".to_string(),
        Value::Bool(
            self_node
                .get("Online")
                .and_then(Value::as_bool)
                .unwrap_or(true),
        ),
    );
    insert_string_if_present(&mut map, "hostName", string_field(self_node, "HostName"));
    insert_string_if_present(&mut map, "os", string_field(self_node, "OS"));
    if let Some(tailnet) = status.get("CurrentTailnet") {
        insert_string_if_present(&mut map, "tailnetName", string_field(tailnet, "Name"));
        insert_string_if_present(
            &mut map,
            "magicDnsSuffix",
            string_field(tailnet, "MagicDNSSuffix"),
        );
    }
    Value::Object(map)
}

fn string_field(value: &Value, field: &str) -> Option<String> {
    value.get(field).and_then(Value::as_str).map(str::to_string)
}

fn string_array_field(value: &Value, field: &str) -> Value {
    Value::Array(
        value
            .get(field)
            .and_then(Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .map(|value| Value::String(value.to_string()))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default(),
    )
}

fn insert_string_if_present(map: &mut Map<String, Value>, field: &str, value: Option<String>) {
    if let Some(value) = value {
        map.insert(field.to_string(), Value::String(value));
    }
}

fn canonical_repo_root(raw_path: &str) -> String {
    let mut current = realpath_or_resolved(&directory_or_parent(Path::new(raw_path)));
    loop {
        if current.join(".git").exists() {
            return realpath_or_resolved(&current).to_string_lossy().to_string();
        }
        let Some(parent) = current.parent() else {
            return realpath_or_resolved(&directory_or_parent(Path::new(raw_path)))
                .to_string_lossy()
                .to_string();
        };
        if parent == current {
            return realpath_or_resolved(&directory_or_parent(Path::new(raw_path)))
                .to_string_lossy()
                .to_string();
        }
        current = parent.to_path_buf();
    }
}

fn directory_or_parent(path: &Path) -> PathBuf {
    let resolved = if path.is_absolute() {
        path.to_path_buf()
    } else {
        env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    };
    match fs::metadata(&resolved) {
        Ok(metadata) if metadata.is_dir() => resolved,
        Ok(_) => resolved
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| resolved.clone()),
        Err(_) => resolved,
    }
}

fn realpath_or_resolved(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

#[derive(Clone, Copy, Debug)]
struct ExecVerbLimits {
    default_timeout: Duration,
    max_timeout: Duration,
    max_stdout_bytes: usize,
    max_stderr_bytes: usize,
}

impl ExecVerbLimits {
    fn tmux() -> Self {
        Self {
            default_timeout: Duration::from_millis(2_000),
            max_timeout: Duration::from_millis(5_000),
            max_stdout_bytes: 64 * 1024,
            max_stderr_bytes: 64 * 1024,
        }
    }

    fn tmux_large_input() -> Self {
        Self {
            default_timeout: Duration::from_millis(5_000),
            max_timeout: Duration::from_millis(10_000),
            max_stdout_bytes: 64 * 1024,
            max_stderr_bytes: 64 * 1024,
        }
    }

    fn tmux_new_session() -> Self {
        Self {
            default_timeout: Duration::from_millis(5_000),
            max_timeout: Duration::from_millis(10_000),
            max_stdout_bytes: 64 * 1024,
            max_stderr_bytes: 64 * 1024,
        }
    }

    fn tailscale_cert() -> Self {
        Self {
            default_timeout: Duration::from_millis(30_000),
            max_timeout: Duration::from_millis(30_000),
            max_stdout_bytes: 512 * 1024,
            max_stderr_bytes: 512 * 1024,
        }
    }

    fn reveal_open() -> Self {
        Self {
            default_timeout: Duration::from_millis(1_500),
            max_timeout: Duration::from_millis(5_000),
            max_stdout_bytes: 64 * 1024,
            max_stderr_bytes: 64 * 1024,
        }
    }
}

fn invalid_args(message: &str) -> ProbeFailure {
    ProbeFailure {
        code: "invalid_request".to_string(),
        message: message.to_string(),
        timed_out: false,
    }
}

fn optional_string(args: &Map<String, Value>, key: &str) -> Option<String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn optional_bool(args: &Map<String, Value>, key: &str) -> Option<bool> {
    args.get(key).and_then(Value::as_bool)
}

fn optional_u16(args: &Map<String, Value>, key: &str) -> Option<u16> {
    args.get(key)
        .and_then(Value::as_u64)
        .filter(|value| *value > 0 && *value <= u64::from(u16::MAX))
        .map(|value| value as u16)
}

fn required_bounded_string<F>(
    args: &Map<String, Value>,
    key: &str,
    max_len: usize,
    validate: F,
) -> Result<String, ProbeFailure>
where
    F: Fn(&str) -> Result<(), ProbeFailure>,
{
    let value = args
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| invalid_args(&format!("missing string arg: {key}")))?
        .to_string();
    if value.is_empty() || value.len() > max_len {
        return Err(invalid_args(&format!(
            "{key} length is outside the allowed range"
        )));
    }
    if value.contains('\0')
        || value
            .chars()
            .any(|ch| ch.is_control() && ch != '\n' && ch != '\t')
    {
        return Err(invalid_args(&format!("{key} contains a control character")));
    }
    validate(&value)?;
    Ok(value)
}

fn required_string_array<F>(
    args: &Map<String, Value>,
    key: &str,
    validate: F,
) -> Result<Vec<String>, ProbeFailure>
where
    F: Fn(&str) -> Result<(), ProbeFailure>,
{
    let values = args
        .get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| invalid_args(&format!("missing array arg: {key}")))?;
    if values.len() > 64 {
        return Err(invalid_args(&format!("{key} has too many entries")));
    }
    let mut out = Vec::with_capacity(values.len());
    for value in values {
        let string = value
            .as_str()
            .ok_or_else(|| invalid_args(&format!("{key} entries must be strings")))?;
        if string.is_empty() || string.len() > 128 || string.contains('\0') {
            return Err(invalid_args(&format!(
                "{key} entry is outside the allowed range"
            )));
        }
        validate(string)?;
        out.push(string.to_string());
    }
    Ok(out)
}

fn required_tmux_target(args: &Map<String, Value>, key: &str) -> Result<String, ProbeFailure> {
    required_bounded_string(args, key, 160, validate_tmux_target)
}

fn required_buffer_name(args: &Map<String, Value>, key: &str) -> Result<String, ProbeFailure> {
    required_bounded_string(args, key, 160, validate_tmux_buffer_name)
}

fn tmux_socket_prefix(args: &Map<String, Value>) -> Result<Vec<String>, ProbeFailure> {
    let Some(socket_path) = optional_string(args, "socketPath") else {
        return Ok(Vec::new());
    };
    validate_absolute_path(&socket_path, "socketPath")?;
    Ok(vec!["-S".to_string(), socket_path])
}

fn effective_probe_timeout(default_timeout: Duration, op_timeout_ms: Option<u64>) -> Duration {
    match op_timeout_ms {
        None => default_timeout,
        Some(ms) => Duration::from_millis(ms.max(1)).min(MAX_REQUESTED_PROBE_TIMEOUT),
    }
}

fn requested_timeout(
    args: &Map<String, Value>,
    default_timeout: Duration,
    max_timeout: Duration,
) -> Result<Duration, ProbeFailure> {
    let requested = args
        .get("timeoutMs")
        .and_then(Value::as_u64)
        .map(Duration::from_millis)
        .unwrap_or(default_timeout);
    if requested.is_zero() {
        return Err(ProbeFailure {
            code: "timeout".to_string(),
            message: "exec verb timed out after 0ms".to_string(),
            timed_out: true,
        });
    }
    Ok(requested.min(max_timeout))
}

fn validate_tmux_target(value: &str) -> Result<(), ProbeFailure> {
    validate_no_shell_meta(value, "tmux target")?;
    if value.len() > 160
        || !value.chars().all(|ch| {
            ch.is_ascii_alphanumeric()
                || matches!(ch, '_' | '-' | '.' | ':' | '@' | '%' | '+' | '=' | '/')
        })
    {
        return Err(invalid_args("tmux target contains unsupported characters"));
    }
    Ok(())
}

fn validate_tmux_buffer_name(value: &str) -> Result<(), ProbeFailure> {
    validate_no_shell_meta(value, "tmux buffer name")?;
    if !value.chars().all(|ch| {
        ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.' | ':' | '@' | '%' | '+' | '=')
    }) {
        return Err(invalid_args(
            "tmux buffer name contains unsupported characters",
        ));
    }
    Ok(())
}

fn validate_tmux_key(value: &str) -> Result<(), ProbeFailure> {
    validate_no_shell_meta(value, "tmux key")?;
    if value.starts_with('-') {
        return Err(invalid_args("tmux key must not start with '-'"));
    }
    if value.chars().all(|ch| {
        ch.is_ascii_alphanumeric()
            || matches!(
                ch,
                '_' | '-' | '.' | ':' | '@' | '%' | '+' | '=' | '/' | '[' | ']'
            )
    }) {
        return Ok(());
    }
    Err(invalid_args("tmux key contains unsupported characters"))
}

fn validate_tmux_window_name(value: &str) -> Result<(), ProbeFailure> {
    validate_no_shell_meta(value, "tmux window name")?;
    if value.len() <= 80
        && value.chars().all(|ch| {
            ch.is_ascii_alphanumeric()
                || matches!(ch, '_' | '-' | '.' | ':' | '@' | '%' | '+' | '=')
        })
    {
        return Ok(());
    }
    Err(invalid_args(
        "tmux window name contains unsupported characters",
    ))
}

fn validate_tmux_paste_flags(value: &str) -> Result<(), ProbeFailure> {
    match value {
        "-dpr" | "-dp" | "-dr" | "-d" | "-p" | "-r" => Ok(()),
        _ => Err(invalid_args("unsupported tmux paste-buffer flags")),
    }
}

fn validate_tmux_format(value: &str) -> Result<(), ProbeFailure> {
    match value {
        "#{pane_id}" => Ok(()),
        _ => Err(invalid_args("unsupported tmux format string")),
    }
}

fn allow_text_payload(value: &str) -> Result<(), ProbeFailure> {
    if value.contains('\0') {
        return Err(invalid_args("text payload contains NUL"));
    }
    Ok(())
}

fn allow_tmux_command(value: &str) -> Result<(), ProbeFailure> {
    if value.contains('\0') || value.trim().is_empty() {
        return Err(invalid_args("tmux command is empty or contains NUL"));
    }
    Ok(())
}

fn validate_absolute_path(value: &str, field: &str) -> Result<(), ProbeFailure> {
    if value.contains('\0') || value.contains('\n') || value.contains('\r') {
        return Err(invalid_args(&format!(
            "{field} contains an unsupported character"
        )));
    }
    if !Path::new(value).is_absolute() {
        return Err(invalid_args(&format!("{field} must be absolute")));
    }
    Ok(())
}

fn validate_hostname(value: &str) -> Result<(), ProbeFailure> {
    if value.ends_with('.') || value.starts_with('.') || value.contains("..") {
        return Err(invalid_args("hostname must be a normalized DNS name"));
    }
    if !value
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '.')
    {
        return Err(invalid_args("hostname contains unsupported characters"));
    }
    for label in value.split('.') {
        if label.is_empty() || label.len() > 63 || label.starts_with('-') || label.ends_with('-') {
            return Err(invalid_args("hostname label is invalid"));
        }
    }
    Ok(())
}

fn validate_reveal_mode(value: &str) -> Result<(), ProbeFailure> {
    match value {
        "darwinReveal" | "darwinOpen" | "xdgOpen" | "windowsSelect" => Ok(()),
        _ => Err(invalid_args("unsupported reveal.open mode")),
    }
}

fn validate_no_shell_meta(value: &str, label: &str) -> Result<(), ProbeFailure> {
    if value.chars().any(|ch| {
        matches!(
            ch,
            ';' | '&'
                | '|'
                | '`'
                | '$'
                | '<'
                | '>'
                | '"'
                | '\''
                | '\\'
                | '('
                | ')'
                | '{'
                | '}'
                | '*'
                | '?'
                | '!'
                | '\n'
                | '\r'
                | '\t'
                | ' '
        )
    }) {
        return Err(invalid_args(&format!(
            "{label} contains shell metacharacters"
        )));
    }
    Ok(())
}

fn run_capped_command(
    command: &str,
    args: &[&str],
    cwd: Option<&Path>,
    timeout: Duration,
    max_stdout_bytes: usize,
    max_stderr_bytes: usize,
) -> Result<CommandResult, CommandFailure> {
    run_capped_command_with_input(
        command,
        &args
            .iter()
            .map(|value| (*value).to_string())
            .collect::<Vec<_>>(),
        None,
        cwd,
        timeout,
        max_stdout_bytes,
        max_stderr_bytes,
    )
}

fn run_capped_command_with_env(
    command: &str,
    args: &[&str],
    envs: &[(&str, &str)],
    timeout: Duration,
    max_stdout_bytes: usize,
    max_stderr_bytes: usize,
) -> Result<CommandResult, CommandFailure> {
    run_capped_command_with_input_and_env(
        command,
        &args
            .iter()
            .map(|value| (*value).to_string())
            .collect::<Vec<_>>(),
        None,
        None,
        envs,
        timeout,
        max_stdout_bytes,
        max_stderr_bytes,
    )
}

fn run_capped_command_with_input(
    command: &str,
    args: &[String],
    stdin: Option<&[u8]>,
    cwd: Option<&Path>,
    timeout: Duration,
    max_stdout_bytes: usize,
    max_stderr_bytes: usize,
) -> Result<CommandResult, CommandFailure> {
    run_capped_command_with_input_and_env(
        command,
        args,
        stdin,
        cwd,
        &[],
        timeout,
        max_stdout_bytes,
        max_stderr_bytes,
    )
}

/// Instance-derived env (packages/runtime/src/instance.ts
/// OPENSCOUT_USER_SPAWN_STRIPPED_ENV_KEYS). A tmux server keeps the env of the
/// process that started it as its global env for every later pane, so scoutd
/// never hands it its own service env (explicit prod instance, ports, labels).
pub(crate) const TMUX_SERVER_STRIPPED_ENV_KEYS: &[&str] = &[
    "OPENSCOUT_INSTANCE",
    "OPENSCOUT_INSTANCE_EXPLICIT",
    "OPENSCOUT_INSTANCE_ROOT",
    "OPENSCOUT_INSTANCE_PORT_BASE",
    "OPENSCOUT_INSTANCE_MESH",
    "OPENSCOUT_HOME",
    "OPENSCOUT_CONTROL_HOME",
    "OPENSCOUT_SUPPORT_DIRECTORY",
    "OPENSCOUT_RELAY_HUB",
    "OPENSCOUT_SCOUT_HOME",
    "OPENSCOUT_PAIRING_HOME",
    "OPENSCOUT_PAIRING_DIR",
    "SCOUT_PAIRING_HOME",
    "OPENSCOUT_BROKER_SOCKET_PATH",
    "OPENSCOUT_APP_SOCKET",
    "OPENSCOUT_PROBES_SOCKET",
    "OPENSCOUT_BROKER_PORT",
    "OPENSCOUT_LISTENING_PORT",
    "OPENSCOUT_WEB_PORT",
    "SCOUT_WEB_PORT",
    "OPENSCOUT_WEB_TERMINAL_RELAY_PORT",
    "OPENSCOUT_PAIRING_PORT",
    "SCOUT_PAIRING_PORT",
    "OPENSCOUT_JETSTREAM_PORT",
    "OPENSCOUT_JETSTREAM_MONITOR_PORT",
    "OPENSCOUT_NODE_NAME",
    "OPENSCOUT_NODE_QUALIFIER",
    "OPENSCOUT_NODE_ID",
    "OPENSCOUT_SERVICE_LABEL",
    "OPENSCOUT_BROKER_SERVICE_LABEL",
    "OPENSCOUT_BROKER_SERVICE_MODE",
    "OPENSCOUT_PARENT_PID",
    "OPENSCOUT_BROKER_HOST",
    "OPENSCOUT_BROKER_URL",
    "OPENSCOUT_BROKER_INTERNAL_URL",
    "OPENSCOUT_ADVERTISE_SCOPE",
    "OPENSCOUT_NETWORK_DISCOVERY_ENABLED",
    "OPENSCOUT_MESH_RENDEZVOUS_URL",
    "OPENSCOUT_MESH_SEEDS",
    "OPENSCOUT_MESH_DISCOVERY_INTERVAL_MS",
    "OPENSCOUT_RUNTIME_PACKAGE_DIR",
    "OPENSCOUT_CHAT_HOME",
    "OPENSCOUT_ZELLIJ_SOCKET_DIR",
    "OPENSCOUT_JETSTREAM_HOME",
    "OPENSCOUT_PAIRING_RUNTIME_STATE_PATH",
    "OPENSCOUT_CLIENT_INSTANCE",
];

fn run_capped_command_with_input_and_env(
    command: &str,
    args: &[String],
    stdin: Option<&[u8]>,
    cwd: Option<&Path>,
    envs: &[(&str, &str)],
    timeout: Duration,
    max_stdout_bytes: usize,
    max_stderr_bytes: usize,
) -> Result<CommandResult, CommandFailure> {
    run_capped_command_full(
        command,
        args,
        stdin,
        cwd,
        envs,
        &[],
        timeout,
        max_stdout_bytes,
        max_stderr_bytes,
    )
}

#[allow(clippy::too_many_arguments)]
fn run_capped_command_full(
    command: &str,
    args: &[String],
    stdin: Option<&[u8]>,
    cwd: Option<&Path>,
    envs: &[(&str, &str)],
    env_removes: &[&str],
    timeout: Duration,
    max_stdout_bytes: usize,
    max_stderr_bytes: usize,
) -> Result<CommandResult, CommandFailure> {
    let mut command_builder = Command::new(command);
    command_builder
        .args(args)
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(cwd) = cwd {
        command_builder.current_dir(cwd);
    }
    for (key, value) in envs {
        command_builder.env(key, value);
    }
    for key in env_removes {
        command_builder.env_remove(key);
    }
    let mut child = command_builder.spawn().map_err(|error| CommandFailure {
        code: error
            .raw_os_error()
            .map(|_| "spawn".to_string())
            .unwrap_or_else(|| "spawn".to_string()),
        message: format!("{command}: {error}"),
        timed_out: false,
    })?;

    if let Some(input) = stdin {
        let Some(mut child_stdin) = child.stdin.take() else {
            return Err(CommandFailure {
                code: "io".to_string(),
                message: format!("{command}: stdin pipe unavailable"),
                timed_out: false,
            });
        };
        child_stdin
            .write_all(input)
            .map_err(|error| CommandFailure {
                code: "io".to_string(),
                message: format!("{command}: failed to write stdin: {error}"),
                timed_out: false,
            })?;
    }

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdout_reader = stdout.map(|mut stdout| {
        thread::spawn(move || read_limited(&mut stdout, max_stdout_bytes, "stdout"))
    });
    let stderr_reader = stderr.map(|mut stderr| {
        thread::spawn(move || read_limited(&mut stderr, max_stderr_bytes, "stderr"))
    });

    let status = wait_child_with_timeout(&mut child, timeout).map_err(|error| CommandFailure {
        code: "wait".to_string(),
        message: error,
        timed_out: false,
    })?;
    let stdout = join_reader(stdout_reader)??;
    let stderr = join_reader(stderr_reader)??;

    if let Some(status) = status {
        if status.success() {
            return Ok(CommandResult {
                stdout: String::from_utf8_lossy(&stdout).to_string(),
                stderr: String::from_utf8_lossy(&stderr).to_string(),
            });
        }
        let stderr_text = String::from_utf8_lossy(&stderr).trim().to_string();
        return Err(CommandFailure {
            code: "exit".to_string(),
            message: if stderr_text.is_empty() {
                format!("{command} exited with {}", status.code().unwrap_or(1))
            } else {
                stderr_text
            },
            timed_out: false,
        });
    }

    let _ = child.kill();
    let _ = child.wait();
    Err(CommandFailure {
        code: "timeout".to_string(),
        message: format!("{command} timed out after {}ms", timeout.as_millis()),
        timed_out: true,
    })
}

fn wait_child_with_timeout(
    child: &mut Child,
    timeout: Duration,
) -> Result<Option<std::process::ExitStatus>, String> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
            return Ok(Some(status));
        }
        if Instant::now() >= deadline {
            return Ok(None);
        }
        thread::sleep(Duration::from_millis(10));
    }
}

fn read_limited<R: Read>(
    reader: &mut R,
    max_bytes: usize,
    stream_name: &'static str,
) -> Result<Vec<u8>, CommandFailure> {
    let mut bytes = Vec::new();
    let mut buf = [0_u8; 8192];
    loop {
        let read = reader.read(&mut buf).map_err(|error| CommandFailure {
            code: "io".to_string(),
            message: error.to_string(),
            timed_out: false,
        })?;
        if read == 0 {
            return Ok(bytes);
        }
        bytes.extend_from_slice(&buf[..read]);
        if bytes.len() > max_bytes {
            return Err(CommandFailure {
                code: "output_cap".to_string(),
                message: format!("probe {stream_name} exceeded {max_bytes} bytes"),
                timed_out: false,
            });
        }
    }
}

fn join_reader(
    handle: Option<thread::JoinHandle<Result<Vec<u8>, CommandFailure>>>,
) -> Result<Result<Vec<u8>, CommandFailure>, CommandFailure> {
    match handle {
        Some(handle) => handle.join().map_err(|_| CommandFailure {
            code: "thread".to_string(),
            message: "probe output reader panicked".to_string(),
            timed_out: false,
        }),
        None => Ok(Ok(Vec::new())),
    }
}

fn is_domain_unavailable_command_error(error: &CommandFailure) -> bool {
    matches!(error.code.as_str(), "spawn" | "exit")
}

fn command_failure_to_probe(error: CommandFailure, probe_id: &str) -> ProbeFailure {
    ProbeFailure {
        code: error.code,
        message: format!("Probe {probe_id} failed: {}", error.message),
        timed_out: error.timed_out,
    }
}

fn command_failure_to_exec(error: CommandFailure, command: &str) -> ProbeFailure {
    ProbeFailure {
        code: error.code,
        message: format!("Exec command {command} failed: {}", error.message),
        timed_out: error.timed_out,
    }
}

fn prepare_socket_path(socket_path: &Path) -> Result<(), String> {
    if let Some(parent) = socket_path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "failed to create probe socket directory {}: {error}",
                parent.display()
            )
        })?;
        let _ = fs::set_permissions(parent, fs::Permissions::from_mode(0o700));
    }
    match fs::symlink_metadata(socket_path) {
        Ok(metadata) => {
            if metadata.file_type().is_socket() {
                let _ = fs::remove_file(socket_path);
                Ok(())
            } else {
                Err(format!(
                    "probe socket path exists and is not a socket: {}",
                    socket_path.display()
                ))
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "failed to inspect probe socket {}: {error}",
            socket_path.display()
        )),
    }
}

fn epoch_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

fn env_nonempty(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn env_duration_ms(name: &str) -> Option<Duration> {
    env_nonempty(name)
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .map(Duration::from_millis)
}

fn env_usize(name: &str) -> Option<usize> {
    env_nonempty(name).and_then(|value| value.parse::<usize>().ok())
}

#[cfg(test)]
mod tests {
    use super::{
        serialize_response_with_cap, serve, ProbeCacheKey, ProbeEngine, ProbeServerOptions,
        CAPABILITIES_SCHEMA, DEFAULT_NATIVE_READ_POLL_INTERVAL, ERROR_SCHEMA, PS_CWD_ID,
        SNAPSHOT_SCHEMA, TEST_PANIC_PROBE_ID,
    };
    use scoutd::repo_service;
    use serde_json::json;
    use serde_json::Value;
    use std::fs::{self, OpenOptions};
    use std::io::{BufRead, BufReader, Read, Write};
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::UnixStream;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::thread;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    fn unique_temp_dir(prefix: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0);
        let dir = PathBuf::from("/tmp").join(format!("{prefix}-{}-{nanos}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_executable(path: &Path, body: &str) {
        fs::write(path, body).unwrap();
        let mut permissions = fs::metadata(path).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(path, permissions).unwrap();
    }

    fn native_feed_artifact(projection_id: &str, sequence: u64, item_count: usize) -> Value {
        json!({
            "schema": "openscout.native.read.feed-cache/v1",
            "version": 1,
            "projectionId": projection_id,
            "projectionVersion": 1,
            "sequence": sequence,
            "generatedAt": 1_700_000_000_000_u64 + sequence,
            "sourceFreshAt": 1_700_000_000_000_u64 + sequence,
            "items": (0..item_count).map(|index| json!({
                "feedId": format!("conv:{projection_id}:{sequence}:{index}"),
                "entityKind": "scout_conversation",
                "conversationId": format!("conversation-{index}"),
                "title": format!("Conversation {index}"),
                "lastActivityAt": 1_700_000_000_000_u64 + index as u64,
            })).collect::<Vec<_>>(),
            "total": item_count,
            "hasMore": false,
            "engagedFeedId": format!("conv:{projection_id}:{sequence}:0"),
            "identityRedirects": [],
        })
    }

    fn replace_native_feed_artifact(path: &Path, artifact: &Value) {
        let temporary = path.with_extension(format!("tmp-{}", std::process::id()));
        fs::write(&temporary, serde_json::to_vec(artifact).unwrap()).unwrap();
        fs::rename(temporary, path).unwrap();
    }

    fn native_thread_artifact(
        projection_id: &str,
        sequence: u64,
        conversation_id: &str,
        message_count: usize,
    ) -> Value {
        json!({
            "schema": "openscout.native.read.thread-cache/v1",
            "version": 1,
            "projectionId": projection_id,
            "projectionVersion": 1,
            "sequence": sequence,
            "feedId": format!("conv:{conversation_id}"),
            "entityKind": "scout_conversation",
            "conversationId": conversation_id,
            "cursor": (message_count > 0).then(|| "message-0"),
            "hasEarlier": false,
            "generatedAt": 1_700_000_000_000_u64 + sequence,
            "messages": (0..message_count).map(|index| json!({
                "id": format!("message-{index}"),
                "actorId": "agent-1",
                "actorName": "Agent One",
                "body": format!("message {index}"),
                "class": "agent",
                "createdAt": 1_700_000_000_000_u64 + index as u64,
            })).collect::<Vec<_>>(),
        })
    }

    fn replace_native_thread_artifact(directory: &Path, artifact: &Value) -> PathBuf {
        fs::create_dir_all(directory).unwrap();
        let path = directory.join("native-read-thread-test.json");
        let temporary = directory.join(format!(
            "native-read-thread-test.tmp-{}",
            std::process::id()
        ));
        fs::write(&temporary, serde_json::to_vec(artifact).unwrap()).unwrap();
        fs::rename(temporary, &path).unwrap();
        path
    }

    fn start_test_server(options: ProbeServerOptions) {
        let socket_path = options.socket_path.clone();
        thread::spawn(move || {
            let _ = serve(options);
        });
        for _ in 0..100 {
            if socket_path.exists() && UnixStream::connect(&socket_path).is_ok() {
                return;
            }
            thread::sleep(Duration::from_millis(10));
        }
        panic!("server did not create socket {}", socket_path.display());
    }

    fn request(socket_path: &Path, payload: &str) -> Value {
        let mut stream = UnixStream::connect(socket_path).unwrap();
        stream.write_all(payload.as_bytes()).unwrap();
        let _ = stream.shutdown(std::net::Shutdown::Write);
        let mut raw = String::new();
        stream.read_to_string(&mut raw).unwrap();
        serde_json::from_str(&raw).unwrap()
    }

    fn base_options(socket_path: PathBuf) -> ProbeServerOptions {
        ProbeServerOptions {
            socket_path,
            tailscale_bin: "tailscale".to_string(),
            git_bin: "git".to_string(),
            tmux_bin: "tmux".to_string(),
            zellij_bin: "zellij".to_string(),
            ps_bin: "ps".to_string(),
            lsof_bin: "lsof".to_string(),
            tailscale_status_fixture: None,
            tailscale_timeout: Duration::from_millis(1_500),
            git_timeout: Duration::from_millis(1_500),
            ps_timeout: Duration::from_millis(1_500),
            lsof_timeout: Duration::from_millis(1_500),
            tmux_probe_timeout: Duration::from_millis(1_500),
            zellij_probe_timeout: Duration::from_millis(1_500),
            ps_discovery_max_rows: 4_096,
            probe_cache_max_entries: 4_096,
            probe_cache_idle_ttl: Duration::from_secs(10 * 60),
            repo_job_timeout: Duration::from_millis(20_000),
            repo_job_response_cap_bytes: 8 * 1024 * 1024,
            repo_job_workers: 4,
            repo_job_queue: 32,
            exec_job_workers: 4,
            exec_job_queue: 32,
            connection_workers: 32,
            connection_queue: 64,
            connection_io_timeout: Duration::from_millis(5_000),
            native_read_enabled: false,
            native_read_journal_path: PathBuf::from("/nonexistent/broker-journal.jsonl"),
            native_read_cache_path: PathBuf::from("/nonexistent/native-read-agents-v1.json"),
            native_read_feed_artifact_path: PathBuf::from("/nonexistent/native-read-feed-v1.json"),
            native_read_thread_artifact_directory: PathBuf::from(
                "/nonexistent/native-read-threads-v1",
            ),
            native_read_poll_interval: Duration::from_millis(50),
            native_read_subscription_workers: 16,
        }
    }

    #[test]
    fn native_read_artifact_polling_defaults_to_one_second() {
        assert_eq!(DEFAULT_NATIVE_READ_POLL_INTERVAL, Duration::from_secs(1));
    }

    #[test]
    fn tmux_session_list_reports_window_name_and_set_pane_title() {
        let rows = super::parse_tmux_session_list(concat!(
            "work\t3\t1\t1710000000\t1710003600\tnode\t/workspace/app\teditor\tbox.local\tclaude | fix tests\n",
            "idle\t1\t0\t\t\tzsh\t/workspace\tzsh\tbox.local\tbox.local\n",
            "moved\t1\t0\t\t\tzsh\t/workspace\tzsh\tbox.lan\tBOX.local\n",
            "named\t1\t0\t\t\tzsh\t/workspace\tzsh\tbox.local\tbox build\n",
            "legacy|2|1|100|200|zsh|/workspace/foo|bar\n",
        ));
        let summary = rows
            .iter()
            .map(|row| {
                (
                    row["name"].as_str().unwrap().to_string(),
                    row["windowName"].clone(),
                    row["paneTitle"].clone(),
                )
            })
            .collect::<Vec<_>>();
        assert_eq!(
            summary,
            vec![
                (
                    "work".to_string(),
                    json!("editor"),
                    json!("claude | fix tests")
                ),
                ("idle".to_string(), json!("zsh"), Value::Null),
                ("moved".to_string(), json!("zsh"), Value::Null),
                ("named".to_string(), json!("zsh"), json!("box build")),
                ("legacy".to_string(), Value::Null, Value::Null),
            ]
        );
        assert_eq!(rows[0]["currentPath"], json!("/workspace/app"));
        assert_eq!(rows[4]["currentPath"], json!("/workspace/foo|bar"));
        assert!(rows.iter().all(|row| row.get("host").is_none()));
    }

    #[test]
    fn tmux_pane_detail_passes_utf8_flag_so_tabs_survive() {
        let dir = unique_temp_dir("scoutd-tmux-pane-detail");
        let argv_path = dir.join("argv.txt");
        let tmux = dir.join("tmux");
        // Like tmux for a client without a UTF-8 locale: the tabs in the
        // format print as "_" unless -u was passed.
        write_executable(
            &tmux,
            &format!(
                r#"#!/bin/sh
printf '%s\n' "$@" > {}
row='4242\t/dev/ttys004\t/workspace/app\n'
if [ "$1" = "-u" ]; then
  printf "$row"
else
  printf "$row" | tr '\t' '_'
fi
"#,
                shell_quote(&argv_path.to_string_lossy())
            ),
        );
        let mut options = base_options(dir.join("probes.sock"));
        options.tmux_bin = tmux.to_string_lossy().to_string();
        let engine = ProbeEngine::new(options);

        let snapshot = engine.snapshot(
            super::TMUX_PANES_ID,
            Some(r#"{"kind":"detail","socketPath":"default","target":"%1"}"#.to_string()),
            Some(0),
            Some(2_000),
        );

        assert!(snapshot.error.is_none(), "error={:?}", snapshot.error);
        assert_eq!(
            snapshot.value,
            json!({
                "panePid": 4242,
                "paneTty": "ttys004",
                "paneCurrentPath": "/workspace/app",
            })
        );
        assert_eq!(
            fs::read_to_string(&argv_path).unwrap(),
            "-u\ndisplay-message\n-p\n-t\n%1\n#{pane_pid}\t#{pane_tty}\t#{pane_current_path}\n"
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn probe_cache_enforces_max_entries_without_eviction_threads() {
        let dir = unique_temp_dir("scoutd-probe-cache-max");
        let socket_path = dir.join("probes.sock");
        let mut options = base_options(socket_path);
        options.probe_cache_max_entries = 3;
        options.probe_cache_idle_ttl = Duration::from_secs(60);
        let engine = ProbeEngine::new(options);

        for index in 0..5 {
            let _ = engine.snapshot(
                PS_CWD_ID,
                Some(format!("not-a-pid-{index}")),
                Some(0),
                Some(1_500),
            );
        }

        let (lock, _) = &*engine.state;
        let state = lock.lock().unwrap();
        assert!(state.entries.len() <= 3, "entries={}", state.entries.len());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn probe_cache_evicts_idle_entries_on_insert() {
        let dir = unique_temp_dir("scoutd-probe-cache-idle");
        let socket_path = dir.join("probes.sock");
        let mut options = base_options(socket_path);
        options.probe_cache_max_entries = 100;
        options.probe_cache_idle_ttl = Duration::from_millis(1);
        let engine = ProbeEngine::new(options);

        let _ = engine.snapshot(
            PS_CWD_ID,
            Some("not-a-pid-old".to_string()),
            Some(0),
            Some(1_500),
        );
        thread::sleep(Duration::from_millis(5));
        let _ = engine.snapshot(
            PS_CWD_ID,
            Some("not-a-pid-new".to_string()),
            Some(0),
            Some(1_500),
        );

        let (lock, _) = &*engine.state;
        let state = lock.lock().unwrap();
        assert!(!state.entries.contains_key(&ProbeCacheKey {
            probe_id: PS_CWD_ID.to_string(),
            key: Some("not-a-pid-old".to_string()),
        }));
        assert!(state.entries.contains_key(&ProbeCacheKey {
            probe_id: PS_CWD_ID.to_string(),
            key: Some("not-a-pid-new".to_string()),
        }));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn probe_panic_clears_in_flight_and_notifies_waiters() {
        let dir = unique_temp_dir("scoutd-probe-panic");
        let socket_path = dir.join("probes.sock");
        let engine = ProbeEngine::new(base_options(socket_path));
        let key = Some("panic-key".to_string());

        let first = engine.snapshot(TEST_PANIC_PROBE_ID, key.clone(), Some(0), Some(1_500));
        assert_eq!(
            first.error.as_ref().map(|error| error.code.as_str()),
            Some("panic")
        );
        {
            let (lock, _) = &*engine.state;
            let state = lock.lock().unwrap();
            let entry = state
                .entries
                .get(&ProbeCacheKey {
                    probe_id: TEST_PANIC_PROBE_ID.to_string(),
                    key: key.clone(),
                })
                .expect("panic probe should leave a cache entry");
            assert!(
                !entry.in_flight,
                "panic left the probe key wedged in-flight"
            );
        }

        let second = engine.snapshot(TEST_PANIC_PROBE_ID, key, Some(0), Some(1_500));
        assert_eq!(
            second.error.as_ref().map(|error| error.code.as_str()),
            Some("panic")
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn accepted_connections_time_out_and_release_worker_permits() {
        let dir = unique_temp_dir("scoutd-probe-connection-timeout");
        let socket_path = dir.join("probes.sock");
        let mut options = base_options(socket_path.clone());
        options.connection_workers = 1;
        options.connection_queue = 0;
        options.connection_io_timeout = Duration::from_millis(75);
        start_test_server(options);

        let stalled = UnixStream::connect(&socket_path).unwrap();
        thread::sleep(Duration::from_millis(200));
        let capabilities = request(
            &socket_path,
            r#"{"schema":"openscout.probe.capabilities/v1"}"#,
        );
        assert_eq!(
            capabilities.get("schema").and_then(Value::as_str),
            Some(CAPABILITIES_SCHEMA)
        );
        drop(stalled);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn capabilities_and_unknown_probe_use_one_json_response_per_connection() {
        let dir = unique_temp_dir("scoutd-probes-capabilities");
        let socket_path = dir.join("probes.sock");
        start_test_server(base_options(socket_path.clone()));

        let capabilities = request(
            &socket_path,
            r#"{"schema":"openscout.probe.capabilities/v1"}"#,
        );
        assert_eq!(
            capabilities.get("schema").and_then(Value::as_str),
            Some(CAPABILITIES_SCHEMA)
        );
        assert_eq!(
            capabilities
                .get("families")
                .and_then(Value::as_array)
                .unwrap()
                .len(),
            17
        );
        let family_ids = capabilities
            .get("families")
            .and_then(Value::as_array)
            .unwrap()
            .iter()
            .filter_map(|family| family.get("probeId").and_then(Value::as_str))
            .collect::<Vec<_>>();
        assert!(family_ids.contains(&"repo.scan"));
        assert!(family_ids.contains(&"repo.diff"));
        assert!(family_ids.contains(&"git.revParse"));
        assert!(family_ids.contains(&"git.diffShortstat"));
        assert!(family_ids.contains(&"git.statusPorcelain"));
        assert!(family_ids.contains(&"git.mergeBase"));
        assert!(family_ids.contains(&"git.logLastCommitUnix"));
        assert!(family_ids.contains(&"git.worktreeListPorcelain"));
        assert!(family_ids.contains(&"ps.runtime"));
        assert!(family_ids.contains(&"ps.discovery"));
        assert!(family_ids.contains(&"ps.cwd"));
        assert!(family_ids.contains(&"net.listeners"));
        assert!(family_ids.contains(&"tmux.sessions"));
        assert!(family_ids.contains(&"tmux.panes"));
        assert!(family_ids.contains(&"zellij.sessions"));
        let verb_ids = capabilities
            .get("verbs")
            .and_then(Value::as_array)
            .unwrap()
            .iter()
            .filter_map(|verb| verb.get("verb").and_then(Value::as_str))
            .collect::<Vec<_>>();
        assert!(verb_ids.contains(&"tmux.sendKeys"));
        assert!(verb_ids.contains(&"tmux.newSession"));
        assert!(verb_ids.contains(&"tailscale.cert"));

        let unknown = request(
            &socket_path,
            r#"{"schema":"openscout.probe.request/v1","probeId":"missing.probe","maxAgeMs":0}"#,
        );
        assert_eq!(
            unknown.get("schema").and_then(Value::as_str),
            Some(SNAPSHOT_SCHEMA)
        );
        assert_eq!(
            unknown.pointer("/error/code").and_then(Value::as_str),
            Some("unknown_probe")
        );

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn native_read_subscription_streams_bounded_journal_projection() {
        let dir = unique_temp_dir("scoutd-native-read-stream");
        let socket_path = dir.join("probes.sock");
        let journal_path = dir.join("broker-journal.jsonl");
        let cache_path = dir.join("native-read-agents-v1.json");
        let mut journal = String::new();
        for index in 0..12 {
            journal.push_str(
                &json!({
                    "kind": "agent.upsert",
                    "agent": {
                        "id": format!("agent-{index}"),
                        "displayName": format!("Agent {index}"),
                        "agentClass": "general",
                        "capabilities": ["chat", "invoke"],
                        "metadata": { "updatedAt": 1_700_000_000_000_u64 + index }
                    }
                })
                .to_string(),
            );
            journal.push('\n');
        }
        fs::write(&journal_path, journal).unwrap();

        let mut options = base_options(socket_path.clone());
        options.native_read_enabled = true;
        options.native_read_journal_path = journal_path.clone();
        options.native_read_cache_path = cache_path;
        options.native_read_poll_interval = Duration::from_millis(10);
        options.connection_workers = 1;
        options.connection_queue = 0;
        start_test_server(options);
        thread::sleep(Duration::from_millis(25));

        let mut stream = UnixStream::connect(&socket_path).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        stream
            .write_all(
                br#"{"schema":"openscout.native.read.request/v1","requestId":"req-1","resource":"agents","mode":"subscribe","limit":10}"#,
            )
            .unwrap();
        stream.write_all(b"\n").unwrap();
        let mut reader = BufReader::new(stream);
        let mut first = String::new();
        reader.read_line(&mut first).unwrap();
        let mut first: Value = serde_json::from_str(&first).unwrap();
        if first
            .get("agents")
            .and_then(Value::as_array)
            .is_some_and(Vec::is_empty)
        {
            let mut refreshed = String::new();
            reader.read_line(&mut refreshed).unwrap();
            first = serde_json::from_str(&refreshed).unwrap();
        }
        assert_eq!(
            first.get("schema").and_then(Value::as_str),
            Some("openscout.native.read.snapshot/v1")
        );
        assert_eq!(
            first.get("agents").and_then(Value::as_array).map(Vec::len),
            Some(10)
        );
        assert_eq!(first.get("hasMore").and_then(Value::as_bool), Some(true));

        let appended = json!({
            "kind": "agent.upsert",
            "agent": {
                "id": "agent-new",
                "displayName": "Newest Agent",
                "agentClass": "builder",
                "capabilities": ["chat"],
                "metadata": { "updatedAt": 1_800_000_000_000_u64 }
            }
        });
        let mut journal = OpenOptions::new().append(true).open(&journal_path).unwrap();
        writeln!(journal, "{appended}").unwrap();
        drop(journal);

        let mut update = String::new();
        reader.read_line(&mut update).unwrap();
        let update: Value = serde_json::from_str(&update).unwrap();
        assert_eq!(
            update.pointer("/agents/0/id").and_then(Value::as_str),
            Some("agent-new")
        );
        assert!(
            update.get("sequence").and_then(Value::as_u64)
                > first.get("sequence").and_then(Value::as_u64)
        );

        drop(reader);
        thread::sleep(Duration::from_millis(500));
        let capabilities = request(
            &socket_path,
            r#"{"schema":"openscout.probe.capabilities/v1"}"#,
        );
        assert_eq!(
            capabilities.get("schema").and_then(Value::as_str),
            Some(CAPABILITIES_SCHEMA)
        );

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn native_feed_subscription_streams_atomic_artifact_replacements_across_lineages() {
        let dir = unique_temp_dir("scoutd-native-feed-stream");
        let socket_path = dir.join("probes.sock");
        let artifact_path = dir.join("native-read-feed-v1.json");
        replace_native_feed_artifact(&artifact_path, &native_feed_artifact("lineage-a", 7, 3));

        let mut options = base_options(socket_path.clone());
        options.native_read_enabled = true;
        options.native_read_feed_artifact_path = artifact_path.clone();
        options.native_read_poll_interval = Duration::from_millis(10);
        start_test_server(options);

        let mut stream = UnixStream::connect(&socket_path).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        stream
            .write_all(
                br#"{"schema":"openscout.native.read.request/v1","requestId":"feed-1","resource":"feed","mode":"subscribe","limit":2}"#,
            )
            .unwrap();
        stream.write_all(b"\n").unwrap();
        let mut reader = BufReader::new(stream);

        let mut first = String::new();
        reader.read_line(&mut first).unwrap();
        let first: Value = serde_json::from_str(&first).unwrap();
        assert_eq!(
            first.get("schema").and_then(Value::as_str),
            Some("openscout.native.read.snapshot/v1")
        );
        assert_eq!(
            first.get("type").and_then(Value::as_str),
            Some("feed.snapshot")
        );
        assert_eq!(
            first.get("projectionId").and_then(Value::as_str),
            Some("lineage-a")
        );
        assert_eq!(first.get("sequence").and_then(Value::as_u64), Some(7));
        assert_eq!(
            first.get("items").and_then(Value::as_array).map(Vec::len),
            Some(2)
        );
        assert_eq!(first.get("total").and_then(Value::as_u64), Some(3));
        assert_eq!(first.get("hasMore").and_then(Value::as_bool), Some(true));

        replace_native_feed_artifact(&artifact_path, &native_feed_artifact("lineage-a", 8, 3));
        let mut same_lineage = String::new();
        reader.read_line(&mut same_lineage).unwrap();
        let same_lineage: Value = serde_json::from_str(&same_lineage).unwrap();
        assert_eq!(
            same_lineage.get("projectionId").and_then(Value::as_str),
            Some("lineage-a")
        );
        assert_eq!(
            same_lineage.get("sequence").and_then(Value::as_u64),
            Some(8)
        );

        // A corrupt atomic replacement is rejected without clearing the last
        // valid in-memory feed. The same-lineage monotonic rule likewise
        // rejects a later-published lower sequence.
        let corrupt = artifact_path.with_extension("corrupt-tmp");
        fs::write(&corrupt, b"not-json\n").unwrap();
        fs::rename(corrupt, &artifact_path).unwrap();
        thread::sleep(Duration::from_millis(75));
        let after_corruption = request(
            &socket_path,
            r#"{"schema":"openscout.native.read.request/v1","requestId":"after-corrupt","resource":"feed","mode":"snapshot","limit":2}"#,
        );
        assert_eq!(
            after_corruption.get("projectionId").and_then(Value::as_str),
            Some("lineage-a")
        );
        assert_eq!(
            after_corruption.get("sequence").and_then(Value::as_u64),
            Some(8)
        );

        replace_native_feed_artifact(&artifact_path, &native_feed_artifact("lineage-a", 7, 3));
        thread::sleep(Duration::from_millis(75));
        let after_regression = request(
            &socket_path,
            r#"{"schema":"openscout.native.read.request/v1","requestId":"after-regression","resource":"feed","mode":"snapshot","limit":2}"#,
        );
        assert_eq!(
            after_regression.get("sequence").and_then(Value::as_u64),
            Some(8)
        );

        // A fresh projection lineage may legitimately restart its sequence.
        // The subscriber must wake on the scoutd-local revision, not compare
        // the broker sequence across lineages.
        replace_native_feed_artifact(&artifact_path, &native_feed_artifact("lineage-b", 1, 1));
        let mut new_lineage = String::new();
        reader.read_line(&mut new_lineage).unwrap();
        let new_lineage: Value = serde_json::from_str(&new_lineage).unwrap();
        assert_eq!(
            new_lineage.get("projectionId").and_then(Value::as_str),
            Some("lineage-b")
        );
        assert_eq!(new_lineage.get("sequence").and_then(Value::as_u64), Some(1));
        assert_eq!(
            new_lineage
                .pointer("/items/0/feedId")
                .and_then(Value::as_str),
            Some("conv:lineage-b:1:0")
        );

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn native_thread_snapshot_requires_explicit_scout_identity_and_returns_newest_page() {
        let dir = unique_temp_dir("scoutd-native-thread-snapshot");
        let socket_path = dir.join("probes.sock");
        let artifact_directory = dir.join("native-read-threads-v1");
        replace_native_thread_artifact(
            &artifact_directory,
            &native_thread_artifact("lineage-a", 7, "conversation-1", 3),
        );

        let mut options = base_options(socket_path.clone());
        options.native_read_enabled = true;
        options.native_read_thread_artifact_directory = artifact_directory;
        options.native_read_poll_interval = Duration::from_millis(10);
        start_test_server(options);

        let response = request(
            &socket_path,
            r#"{"schema":"openscout.native.read.request/v1","requestId":"thread-1","resource":"thread","mode":"snapshot","feedId":"conv:conversation-1","conversationId":"conversation-1","limit":2}"#,
        );
        assert_eq!(
            response.get("type").and_then(Value::as_str),
            Some("thread.snapshot")
        );
        assert_eq!(
            response.get("feedId").and_then(Value::as_str),
            Some("conv:conversation-1")
        );
        assert_eq!(
            response.get("conversationId").and_then(Value::as_str),
            Some("conversation-1")
        );
        assert_eq!(
            response.get("cursor").and_then(Value::as_str),
            Some("message-1")
        );
        assert_eq!(
            response.get("hasEarlier").and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            response
                .get("messages")
                .and_then(Value::as_array)
                .map(|messages| messages.len()),
            Some(2)
        );

        for (payload, expected_code) in [
            (
                r#"{"schema":"openscout.native.read.request/v1","resource":"thread","mode":"snapshot","limit":2}"#,
                "invalid_request",
            ),
            (
                r#"{"schema":"openscout.native.read.request/v1","resource":"thread","mode":"snapshot","feedId":"obs:codex:session-1","limit":2}"#,
                "thread_not_available",
            ),
            (
                r#"{"schema":"openscout.native.read.request/v1","resource":"thread","mode":"snapshot","feedId":"conv:conversation-1","conversationId":"other","limit":2}"#,
                "invalid_request",
            ),
        ] {
            let rejected = request(&socket_path, payload);
            assert_eq!(
                rejected.pointer("/error/code").and_then(Value::as_str),
                Some(expected_code)
            );
        }

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn native_subscription_capacity_isolated_from_general_probe_connections() {
        let dir = unique_temp_dir("scoutd-native-feed-permits");
        let socket_path = dir.join("probes.sock");
        let artifact_directory = dir.join("native-read-threads-v1");
        replace_native_thread_artifact(
            &artifact_directory,
            &native_thread_artifact("lineage-a", 1, "conversation-1", 1),
        );

        let mut options = base_options(socket_path.clone());
        options.native_read_enabled = true;
        options.native_read_thread_artifact_directory = artifact_directory;
        options.native_read_poll_interval = Duration::from_millis(10);
        options.connection_workers = 1;
        options.connection_queue = 0;
        options.native_read_subscription_workers = 1;
        start_test_server(options);
        // Let the readiness connection used by start_test_server release the
        // intentionally single global permit before opening the held stream.
        thread::sleep(Duration::from_millis(25));

        let mut subscribed = UnixStream::connect(&socket_path).unwrap();
        subscribed
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        subscribed
            .write_all(
                br#"{"schema":"openscout.native.read.request/v1","requestId":"held","resource":"thread","mode":"subscribe","feedId":"conv:conversation-1","conversationId":"conversation-1","limit":1}"#,
            )
            .unwrap();
        subscribed.write_all(b"\n").unwrap();
        let mut subscribed_reader = BufReader::new(subscribed);
        let mut initial = String::new();
        subscribed_reader.read_line(&mut initial).unwrap();
        let initial: Value = serde_json::from_str(&initial).unwrap();
        assert_eq!(
            initial.get("type").and_then(Value::as_str),
            Some("thread.snapshot")
        );

        // The single global permit is already released even while the native
        // stream remains open.
        let capabilities = request(
            &socket_path,
            r#"{"schema":"openscout.probe.capabilities/v1"}"#,
        );
        assert_eq!(
            capabilities.get("schema").and_then(Value::as_str),
            Some(CAPABILITIES_SCHEMA)
        );

        // Saturating the dedicated class fails only another subscription.
        let busy = request(
            &socket_path,
            r#"{"schema":"openscout.native.read.request/v1","requestId":"busy","resource":"feed","mode":"subscribe","limit":1}"#,
        );
        assert_eq!(
            busy.get("schema").and_then(Value::as_str),
            Some(ERROR_SCHEMA)
        );
        assert_eq!(
            busy.pointer("/error/code").and_then(Value::as_str),
            Some("busy")
        );

        drop(subscribed_reader);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn native_feed_snapshot_reports_unavailable_without_a_valid_artifact() {
        let dir = unique_temp_dir("scoutd-native-feed-unavailable");
        let socket_path = dir.join("probes.sock");
        let mut options = base_options(socket_path.clone());
        options.native_read_enabled = true;
        options.native_read_feed_artifact_path = dir.join("missing-feed.json");
        start_test_server(options);

        let response = request(
            &socket_path,
            r#"{"schema":"openscout.native.read.request/v1","requestId":"missing","resource":"feed","mode":"snapshot","limit":160}"#,
        );
        assert_eq!(
            response.get("schema").and_then(Value::as_str),
            Some(ERROR_SCHEMA)
        );
        assert_eq!(
            response.pointer("/error/code").and_then(Value::as_str),
            Some("native_read_unavailable")
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn exec_tmux_send_keys_uses_structured_verb_envelope() {
        let dir = unique_temp_dir("scoutd-exec-send-keys");
        let socket_path = dir.join("probes.sock");
        let argv_path = dir.join("argv.txt");
        let tmux = dir.join("tmux");
        write_executable(
            &tmux,
            &format!(
                r#"#!/bin/sh
printf '%s\n' "$@" > {}
exit 0
"#,
                shell_quote(&argv_path.to_string_lossy())
            ),
        );
        let mut options = base_options(socket_path.clone());
        options.tmux_bin = tmux.to_string_lossy().to_string();
        start_test_server(options);

        let response = request(
            &socket_path,
            r#"{"schema":"openscout.exec.request/v1","verb":"tmux.sendKeys","args":{"target":"scout-test","keys":["C-c"],"timeoutMs":2000}}"#,
        );
        assert_eq!(
            response.get("schema").and_then(Value::as_str),
            Some("openscout.exec.response/v1")
        );
        assert_eq!(response.get("ok").and_then(Value::as_bool), Some(true));
        assert_eq!(
            fs::read_to_string(&argv_path).unwrap(),
            "send-keys\n-t\nscout-test\nC-c\n"
        );

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn tmux_server_env_removal_drops_instance_keys_and_keeps_the_rest() {
        // The env scoutd itself carries is simulated by `envs`; the removal
        // list is applied after it, as for the tmux.newSession verb.
        let output = super::run_capped_command_full(
            "sh",
            &["-c".to_string(), "env".to_string()],
            None,
            None,
            &[
                ("OPENSCOUT_INSTANCE", "prod"),
                ("OPENSCOUT_CLIENT_INSTANCE", "dev-leak-test"),
                ("OPENSCOUT_BROKER_PORT", "43110"),
                ("SCOUT_KEEP_ME", "1"),
            ],
            super::TMUX_SERVER_STRIPPED_ENV_KEYS,
            Duration::from_secs(5),
            64 * 1024,
            64 * 1024,
        )
        .expect("env runs");
        assert!(!output.stdout.contains("OPENSCOUT_INSTANCE="));
        assert!(!output.stdout.contains("OPENSCOUT_CLIENT_INSTANCE="));
        assert!(!output.stdout.contains("OPENSCOUT_BROKER_PORT="));
        assert!(output.stdout.contains("SCOUT_KEEP_ME=1"));
    }

    #[test]
    fn exec_tmux_new_session_runs_through_the_env_stripping_path() {
        let dir = unique_temp_dir("scoutd-exec-new-session-env");
        let socket_path = dir.join("probes.sock");
        let argv_path = dir.join("argv.txt");
        let tmux = dir.join("tmux");
        write_executable(
            &tmux,
            &format!(
                r#"#!/bin/sh
printf '%s\n' "$@" > {}
exit 0
"#,
                shell_quote(&argv_path.to_string_lossy())
            ),
        );
        let mut options = base_options(socket_path.clone());
        options.tmux_bin = tmux.to_string_lossy().to_string();
        start_test_server(options);

        let response = request(
            &socket_path,
            r#"{"schema":"openscout.exec.request/v1","verb":"tmux.newSession","args":{"sessionName":"scout-env","detached":true,"command":"sh","timeoutMs":2000}}"#,
        );
        assert_eq!(response.get("ok").and_then(Value::as_bool), Some(true));
        assert_eq!(
            fs::read_to_string(&argv_path).unwrap(),
            "new-session\n-d\n-s\nscout-env\nsh\n"
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn exec_unknown_verb_and_injection_shaped_args_are_rejected() {
        let dir = unique_temp_dir("scoutd-exec-validation");
        let socket_path = dir.join("probes.sock");
        start_test_server(base_options(socket_path.clone()));

        let unknown = request(
            &socket_path,
            r#"{"schema":"openscout.exec.request/v1","verb":"tmux.runShell","args":{}}"#,
        );
        assert_eq!(
            unknown.get("schema").and_then(Value::as_str),
            Some("openscout.exec.response/v1")
        );
        assert_eq!(unknown.get("ok").and_then(Value::as_bool), Some(false));
        assert_eq!(
            unknown.pointer("/error/code").and_then(Value::as_str),
            Some("unknown_verb")
        );

        let malformed = request(
            &socket_path,
            r#"{"schema":"openscout.exec.request/v1","verb":"tmux.killSession","args":{"target":"safe;rm -rf /"}}"#,
        );
        assert_eq!(malformed.get("ok").and_then(Value::as_bool), Some(false));
        assert_eq!(
            malformed.pointer("/error/code").and_then(Value::as_str),
            Some("invalid_request")
        );

        let option_like_key = request(
            &socket_path,
            r#"{"schema":"openscout.exec.request/v1","verb":"tmux.sendKeys","args":{"target":"scout-test","keys":["-X"]}}"#,
        );
        assert_eq!(
            option_like_key.get("ok").and_then(Value::as_bool),
            Some(false)
        );
        assert_eq!(
            option_like_key
                .pointer("/error/code")
                .and_then(Value::as_str),
            Some("invalid_request")
        );

        let bad_path = request(
            &socket_path,
            r#"{"schema":"openscout.exec.request/v1","verb":"tailscale.cert","args":{"certFile":"relative.crt","keyFile":"/tmp/key","hostname":"node.example.ts.net"}}"#,
        );
        assert_eq!(bad_path.get("ok").and_then(Value::as_bool), Some(false));
        assert_eq!(
            bad_path.pointer("/error/code").and_then(Value::as_str),
            Some("invalid_request")
        );

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn exec_timeout_returns_error_without_crashing_server() {
        let dir = unique_temp_dir("scoutd-exec-timeout");
        let socket_path = dir.join("probes.sock");
        let tmux = dir.join("tmux");
        write_executable(
            &tmux,
            r#"#!/bin/sh
sleep 1
exit 0
"#,
        );
        let mut options = base_options(socket_path.clone());
        options.tmux_bin = tmux.to_string_lossy().to_string();
        start_test_server(options);

        let timed_out = request(
            &socket_path,
            r#"{"schema":"openscout.exec.request/v1","verb":"tmux.sendKeys","args":{"target":"scout-test","keys":["Enter"],"timeoutMs":1}}"#,
        );
        assert_eq!(
            timed_out.get("schema").and_then(Value::as_str),
            Some("openscout.exec.response/v1")
        );
        assert_eq!(timed_out.get("ok").and_then(Value::as_bool), Some(false));
        assert_eq!(
            timed_out.pointer("/error/code").and_then(Value::as_str),
            Some("timeout")
        );
        assert_eq!(
            timed_out
                .pointer("/error/timed_out")
                .and_then(Value::as_bool),
            Some(true)
        );

        let capabilities = request(
            &socket_path,
            r#"{"schema":"openscout.probe.capabilities/v1"}"#,
        );
        assert_eq!(
            capabilities.get("schema").and_then(Value::as_str),
            Some(CAPABILITIES_SCHEMA)
        );

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn repo_scan_and_diff_match_one_shot_contract_over_socket() {
        let dir = unique_temp_dir("scoutd-repo-parity");
        let socket_path = dir.join("probes.sock");
        let repo = dir.join("repo");
        fs::create_dir_all(&repo).unwrap();
        run_git(&repo, &["init", "-b", "main"]);
        fs::write(repo.join("README.md"), "hello\n").unwrap();
        run_git(&repo, &["add", "README.md"]);
        run_git(
            &repo,
            &[
                "-c",
                "user.email=scout@example.test",
                "-c",
                "user.name=Scout",
                "commit",
                "-m",
                "initial",
            ],
        );
        fs::write(repo.join("README.md"), "hello\nworld\n").unwrap();
        fs::write(repo.join("scratch.md"), "scratch\n").unwrap();
        start_test_server(base_options(socket_path.clone()));

        let scan_request = json!({
            "schema": "openscout.repo.scan/v1",
            "hints": [{ "path": repo.to_string_lossy(), "source": "test" }],
            "limits": {
                "maxRoots": 4,
                "maxWorktrees": 4,
                "maxFilesPerWorktree": 12,
                "scanBudgetMs": 4_000,
                "includeDiff": true,
                "includeLastCommit": true
            }
        });
        let socket_scan = request(&socket_path, &scan_request.to_string());
        assert_eq!(
            socket_scan.get("schema").and_then(Value::as_str),
            Some("openscout.repo.response/v1")
        );
        assert_eq!(
            socket_scan.get("operation").and_then(Value::as_str),
            Some("repo.scan")
        );
        assert!(socket_scan.get("error").unwrap().is_null());
        let one_shot_scan: Value = serde_json::from_str(
            &repo_service::run_command_json("scan", &scan_request.to_string()).unwrap(),
        )
        .unwrap();
        let mut socket_scan_value = socket_scan.get("value").cloned().unwrap();
        let mut one_shot_scan_value = one_shot_scan;
        normalize_scan_timestamps(&mut socket_scan_value);
        normalize_scan_timestamps(&mut one_shot_scan_value);
        assert_eq!(socket_scan_value, one_shot_scan_value);

        let diff_request = json!({
            "schema": "openscout.repo.diff/v1",
            "worktreePath": repo.to_string_lossy(),
            "layers": ["unstaged"],
            "limits": {
                "maxPatchBytes": 200_000,
                "maxFiles": 100,
                "maxHunksPerFile": 50,
                "maxLinesPerHunk": 500,
                "timeoutMs": 5_000,
                "includeRawPatch": true,
                "includeParsedHunks": true,
                "includeBinaryPatch": true
            }
        });
        let socket_diff = request(&socket_path, &diff_request.to_string());
        assert_eq!(
            socket_diff.get("schema").and_then(Value::as_str),
            Some("openscout.repo.response/v1")
        );
        assert_eq!(
            socket_diff.get("operation").and_then(Value::as_str),
            Some("repo.diff")
        );
        assert!(socket_diff.get("error").unwrap().is_null());
        let one_shot_diff: Value = serde_json::from_str(
            &repo_service::run_command_json("diff", &diff_request.to_string()).unwrap(),
        )
        .unwrap();
        let mut socket_diff_value = socket_diff.get("value").cloned().unwrap();
        let mut one_shot_diff_value = one_shot_diff;
        normalize_generated_at(&mut socket_diff_value);
        normalize_generated_at(&mut one_shot_diff_value);
        assert_eq!(socket_diff_value, one_shot_diff_value);

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn repo_malformed_body_returns_repo_error_envelope() {
        let dir = unique_temp_dir("scoutd-repo-malformed");
        let socket_path = dir.join("probes.sock");
        start_test_server(base_options(socket_path.clone()));

        let response = request(&socket_path, r#"{"schema":"openscout.repo.diff/v1"}"#);
        assert_eq!(
            response.get("schema").and_then(Value::as_str),
            Some("openscout.repo.response/v1")
        );
        assert_eq!(
            response.get("operation").and_then(Value::as_str),
            Some("repo.diff")
        );
        assert_eq!(
            response.pointer("/error/code").and_then(Value::as_str),
            Some("invalid_request")
        );

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn repo_timeout_returns_error_without_crashing_server() {
        let dir = unique_temp_dir("scoutd-repo-timeout");
        let socket_path = dir.join("probes.sock");
        let mut options = base_options(socket_path.clone());
        options.repo_job_timeout = Duration::from_millis(0);
        start_test_server(options);

        let timed_out = request(
            &socket_path,
            r#"{"schema":"openscout.repo.scan/v1","hints":[]}"#,
        );
        assert_eq!(
            timed_out.get("schema").and_then(Value::as_str),
            Some("openscout.repo.response/v1")
        );
        assert_eq!(
            timed_out.pointer("/error/code").and_then(Value::as_str),
            Some("timeout")
        );
        assert_eq!(
            timed_out
                .pointer("/error/timed_out")
                .and_then(Value::as_bool),
            Some(true)
        );

        let capabilities = request(
            &socket_path,
            r#"{"schema":"openscout.probe.capabilities/v1"}"#,
        );
        assert_eq!(
            capabilities.get("schema").and_then(Value::as_str),
            Some(CAPABILITIES_SCHEMA)
        );

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn repo_oversized_response_returns_error_envelope() {
        let dir = unique_temp_dir("scoutd-repo-output-cap");
        let socket_path = dir.join("probes.sock");
        let mut options = base_options(socket_path.clone());
        options.repo_job_response_cap_bytes = 64;
        start_test_server(options);

        let response = request(
            &socket_path,
            r#"{"schema":"openscout.repo.scan/v1","hints":[]}"#,
        );
        assert_eq!(
            response.get("schema").and_then(Value::as_str),
            Some("openscout.repo.response/v1")
        );
        assert_eq!(
            response.pointer("/error/code").and_then(Value::as_str),
            Some("output_cap")
        );

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn probe_oversized_snapshot_returns_error_envelope() {
        let response = json!({
            "schema": SNAPSHOT_SCHEMA,
            "probeId": "ps.runtime",
            "key": null,
            "generatedAt": 0,
            "ttlMs": 5000,
            "value": { "rows": [], "commandRows": [{ "pid": 1, "command": "x".repeat(1024) }] },
            "error": null,
            "daemonVersion": "test",
        });

        let payload = serialize_response_with_cap(response, 128).unwrap();
        let capped: Value = serde_json::from_slice(&payload).unwrap();
        assert_eq!(
            capped.get("schema").and_then(Value::as_str),
            Some(SNAPSHOT_SCHEMA)
        );
        assert_eq!(
            capped.pointer("/error/code").and_then(Value::as_str),
            Some("output_cap")
        );
        assert_eq!(capped.get("value"), Some(&Value::Null));
    }

    #[test]
    fn malformed_request_returns_structured_error_response() {
        let dir = unique_temp_dir("scoutd-probes-malformed");
        let socket_path = dir.join("probes.sock");
        start_test_server(base_options(socket_path.clone()));

        let malformed = request(&socket_path, "not-json");
        assert_eq!(
            malformed.get("schema").and_then(Value::as_str),
            Some(ERROR_SCHEMA)
        );
        assert_eq!(
            malformed.pointer("/error/code").and_then(Value::as_str),
            Some("invalid_json")
        );

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn concurrent_clients_share_one_underlying_exec_per_ttl() {
        let dir = unique_temp_dir("scoutd-probes-single-flight");
        let socket_path = dir.join("probes.sock");
        let counter_path = dir.join("count");
        let tailscale = dir.join("tailscale");
        write_executable(
            &tailscale,
            &format!(
                r#"#!/bin/sh
if [ "$1" = "status" ]; then
  printf x >> {}
  sleep 0.2
  cat <<'JSON'
{{"BackendState":"Running","Health":[],"Self":{{"ID":"self-node","HostName":"workstation","TailscaleIPs":["100.64.0.10"],"Online":true}},"Peer":{{}}}}
JSON
  exit 0
fi
exit 64
"#,
                shell_quote(&counter_path.to_string_lossy())
            ),
        );
        let mut options = base_options(socket_path.clone());
        options.tailscale_bin = tailscale.to_string_lossy().to_string();
        start_test_server(options);

        let payload = r#"{"schema":"openscout.probe.request/v1","probeId":"tailscale.status","maxAgeMs":30000}"#;
        let left_path = socket_path.clone();
        let right_path = socket_path.clone();
        let left = thread::spawn(move || request(&left_path, payload));
        let right = thread::spawn(move || request(&right_path, payload));
        let left = left.join().unwrap();
        let right = right.join().unwrap();
        assert_eq!(
            left.pointer("/value/running").and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            right
                .pointer("/value/self/hostName")
                .and_then(Value::as_str),
            Some("workstation")
        );
        assert_eq!(fs::read_to_string(&counter_path).unwrap(), "x");

        let cached = request(&socket_path, payload);
        assert_eq!(
            cached.pointer("/value/running").and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(fs::read_to_string(&counter_path).unwrap(), "x");

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn probe_timeout_returns_snapshot_error_without_crashing_server() {
        let dir = unique_temp_dir("scoutd-probes-timeout");
        let socket_path = dir.join("probes.sock");
        let tailscale = dir.join("tailscale");
        write_executable(
            &tailscale,
            r#"#!/bin/sh
sleep 1
exit 0
"#,
        );
        let mut options = base_options(socket_path.clone());
        options.tailscale_bin = tailscale.to_string_lossy().to_string();
        options.tailscale_timeout = Duration::from_millis(50);
        start_test_server(options);

        let timed_out = request(
            &socket_path,
            r#"{"schema":"openscout.probe.request/v1","probeId":"tailscale.status","maxAgeMs":0}"#,
        );
        assert_eq!(
            timed_out.get("schema").and_then(Value::as_str),
            Some(SNAPSHOT_SCHEMA)
        );
        assert_eq!(
            timed_out.pointer("/error/code").and_then(Value::as_str),
            Some("timeout")
        );
        assert_eq!(
            timed_out
                .pointer("/error/timed_out")
                .and_then(Value::as_bool),
            Some(true)
        );

        let capabilities = request(
            &socket_path,
            r#"{"schema":"openscout.probe.capabilities/v1"}"#,
        );
        assert_eq!(
            capabilities.get("schema").and_then(Value::as_str),
            Some(CAPABILITIES_SCHEMA)
        );

        let _ = fs::remove_dir_all(dir);
    }

    fn shell_quote(value: &str) -> String {
        format!("'{}'", value.replace('\'', "'\\''"))
    }

    fn run_git(cwd: &Path, args: &[&str]) {
        let output = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .output()
            .unwrap();
        if !output.status.success() {
            let _ = std::io::stderr().write_all(&output.stderr);
            panic!("git {} failed", args.join(" "));
        }
    }

    fn normalize_scan_timestamps(value: &mut Value) {
        normalize_generated_at(value);
        if let Some(projects) = value.get_mut("projects").and_then(Value::as_array_mut) {
            for project in projects {
                if let Some(worktrees) = project.get_mut("worktrees").and_then(Value::as_array_mut)
                {
                    for worktree in worktrees {
                        if let Some(object) = worktree.as_object_mut() {
                            object.insert("scannedAt".to_string(), Value::from(0));
                        }
                    }
                }
            }
        }
    }

    fn normalize_generated_at(value: &mut Value) {
        if let Some(object) = value.as_object_mut() {
            object.insert("generatedAt".to_string(), Value::from(0));
        }
    }
}
