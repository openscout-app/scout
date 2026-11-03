#[cfg(not(unix))]
compile_error!("scoutd first slice requires a Unix-like platform.");

mod health_observations;
mod health_sweep;
mod health_worker;
mod probes;

use std::collections::HashSet;
use std::env;
use std::fs::{self, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::os::unix::net::UnixStream;
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitCode, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const DEFAULT_BROKER_HOST: &str = "127.0.0.1";
const DEFAULT_BROKER_HOST_MESH: &str = "0.0.0.0";
const DEFAULT_BROKER_PORT: u16 = 43_110;
const DEFAULT_OPENSCOUT_PUSH_RELAY_URL: &str = "https://mesh.oscout.net";
const RESTART_MIN_DELAY: Duration = Duration::from_secs(1);
const RESTART_MAX_DELAY: Duration = Duration::from_secs(30);
// Existing control-plane datasets can take well over 15 seconds to open before
// the broker binds its health socket. Keep service start/restart bounded, but
// allow the same readiness window used by the full restart orchestrator.
const START_TIMEOUT: Duration = Duration::from_secs(120);
const STOP_TIMEOUT: Duration = Duration::from_secs(20);
// Graceful window scoutd gives each child (base, probe) before SIGKILL. Set above
// base's worst-case subtree shutdown (~14s: broker 8s + kill wait + caddy) so base
// exits cleanly on its own, and below launchd's ExitTimeOut so scoutd itself is
// not SIGKILLed mid-shutdown.
const CHILD_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(18);
const LAUNCHD_EXIT_TIMEOUT_SECONDS: u64 = 25;
const POLL_INTERVAL: Duration = Duration::from_millis(100);
const STATE_WRITE_INTERVAL: Duration = Duration::from_secs(2);
const STATE_WRITE_RETRY_MAX: Duration = Duration::from_secs(30);
const STATE_WRITE_WARNING_INTERVAL: Duration = Duration::from_secs(30);
const PROCESS_SWEEP_INTERVAL: Duration = Duration::from_secs(5 * 60);
const ORPHAN_ADVERTISEMENT_GRACE: Duration = Duration::from_secs(5 * 60);
const CHILD_LOG_ROTATE_LIMIT: u64 = 512 * 1024;
const DEFAULT_REPO_WATCH_INTERVAL: Duration = Duration::from_secs(10 * 60);
const REPO_WATCH_WARM_START_DELAY: Duration = Duration::from_secs(2);
const REPO_WATCH_WARM_PATH: &str = "/v1/repo-watch/warm";
const SIGINT: i32 = 2;
const SIGTERM: i32 = 15;
const DAEMON_NAME: &str = "scoutd";
const BUILD_VERSION: &str = env!("CARGO_PKG_VERSION");
/// Pre-rename daemon binary name. Kept for legacy-name compatibility so doctor
/// still sees a still-running `openscout-supervisor supervise` orphan after the
/// openscout-supervisor → scoutd rename.
const LEGACY_DAEMON_NAME: &str = "openscout-supervisor";
const SHARED_SERVICE_LABEL: &str = "app.openscout";
const ALLOW_SHARED_SERVICE_REPOINT_ENV: &str = "OPENSCOUT_ALLOW_SHARED_SERVICE_REPOINT";
static SHUTDOWN_REQUESTED: AtomicBool = AtomicBool::new(false);
const OPTIONAL_LAUNCH_ENV_KEYS: &[&str] = &[
    // Persist the opt-in transport configuration across launchd restarts.
    "OPENSCOUT_EXTERNAL_SESSION_CONNECTIONS",
    "OPENSCOUT_DEVIN_CLI_BIN",
    "OPENSCOUT_JETSTREAM_ENABLED",
    "OPENSCOUT_JETSTREAM_MANAGE_SERVER",
    "OPENSCOUT_JETSTREAM_HOST",
    "OPENSCOUT_JETSTREAM_PORT",
    "OPENSCOUT_JETSTREAM_MONITOR_PORT",
    "OPENSCOUT_JETSTREAM_BINARY",
    "OPENSCOUT_JETSTREAM_HOME",
    "OPENSCOUT_JETSTREAM_STREAM",
    "OPENSCOUT_JETSTREAM_START",
    "OPENSCOUT_JETSTREAM_DUPLICATE_WINDOW_MS",
    "OPENSCOUT_JETSTREAM_MAX_AGE_MS",
    "OPENSCOUT_JETSTREAM_MAX_BYTES",
    "OPENSCOUT_JETSTREAM_CHECKPOINT_MS",
    "OPENSCOUT_MESH_ID",
    "OPENSCOUT_MESH_SEEDS",
    "OPENSCOUT_MESH_DISCOVERY_INTERVAL_MS",
    "OPENSCOUT_MESH_RENDEZVOUS_URL",
    "OPENSCOUT_MESH_RENDEZVOUS_TTL_MS",
    "OPENSCOUT_MESH_RENDEZVOUS_INTERVAL_MS",
    "OPENSCOUT_PAIRING_RELAY_URL",
    "OPENSCOUT_MOBILE_PAIRING_RELAY_URL",
    "OPENSCOUT_NODE_NAME",
    "OPENSCOUT_NODE_ID",
    "OPENSCOUT_NODE_QUALIFIER",
    "OPENSCOUT_TAILSCALE_BIN",
    "OPENSCOUT_TAILSCALE_STATUS_JSON",
    "OPENSCOUT_GIT_BIN",
    "OPENSCOUT_SSE_KEEPALIVE_MS",
    "OPENSCOUT_WEB_EDGE_SCHEME",
    "OPENSCOUT_WEB_PUBLIC_ORIGIN",
    "OPENSCOUT_WEB_PORTAL_HOST",
    "OPENSCOUT_WEB_LOCAL_NAME",
    "OPENSCOUT_WEB_ADVERTISED_HOST",
    "OPENSCOUT_WEB_TRUSTED_HOSTS",
    "OPENSCOUT_WEB_TRUSTED_ORIGINS",
    "OPENSCOUT_WEB_PORT",
    "OPENSCOUT_WEB_FLAG_BUNDLE",
    "OPENSCOUT_WEB_EXPERIENCE",
    "OPENSCOUT_WEB_AB_VARIANT",
    "OPENSCOUT_REPO_WATCH_INTERVAL_MS",
    "OPENSCOUT_REPO_WATCH_ROOTS",
    "OPENSCOUT_REPO_WATCH_NATIVE",
    "OPENSCOUT_REPO_WATCH_MAX_ROOTS",
    "OPENSCOUT_REPO_WATCH_MAX_WORKTREES",
    "OPENSCOUT_REPO_WATCH_MAX_FILES_PER_WORKTREE",
    "OPENSCOUT_REPO_WATCH_SCAN_BUDGET_MS",
    "OPENSCOUT_REPO_WATCH_CACHE_TTL_MS",
    "OPENSCOUT_REPO_WATCH_REHYDRATE_AFTER_MS",
    "OPENSCOUT_REPO_SERVICE_BIN",
    "OPENSCOUT_CLAUDE_CARDLESS_TRANSPORT",
    "OPENSCOUT_CARDLESS_SESSION_IDLE_TTL_MS",
    "OPENSCOUT_CARDLESS_SESSION_SWEEP_INTERVAL_MS",
    "OPENSCOUT_RUNTIME_BUILD_PIN",
    "OPENSCOUT_RUNTIME_BUILD_PIN_REASON",
    "OPENSCOUT_HOME",
    "OPENSCOUT_APP_BUNDLE_PATH",
    "OPENSCOUT_PAIRING_PORT",
    "OPENSCOUT_WEB_SERVER_ENTRY",
    "OPENSCOUT_PROBES_SOCKET",
    // Instance isolation (packages/runtime/src/instance.ts): a non-prod
    // instance's launchd service must keep its root and port block.
    // OPENSCOUT_INSTANCE itself is always pinned (see launch_instance()).
    "OPENSCOUT_INSTANCE_ROOT",
    "OPENSCOUT_INSTANCE_PORT_BASE",
    "OPENSCOUT_INSTANCE_MESH",
    "OPENSCOUT_SCOUT_HOME",
    "OPENSCOUT_PAIRING_HOME",
    "OPENSCOUT_RELAY_HUB",
];

unsafe extern "C" {
    fn signal(signum: i32, handler: extern "C" fn(i32)) -> usize;
}

extern "C" fn request_shutdown(_: i32) {
    SHUTDOWN_REQUESTED.store(true, Ordering::SeqCst);
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::from(1)
        }
    }
}

fn run() -> Result<(), String> {
    let args: Vec<String> = env::args().skip(1).collect();
    if args
        .iter()
        .any(|arg| arg == "-V" || arg == "--version" || arg == "version")
    {
        print_version();
        return Ok(());
    }
    if args
        .iter()
        .any(|arg| arg == "-h" || arg == "--help" || arg == "help")
    {
        print_help();
        return Ok(());
    }

    let json = args.iter().any(|arg| arg == "--json");
    let fix = args.iter().any(|arg| arg == "--fix");
    let yes = args.iter().any(|arg| arg == "--yes");
    let start_readiness = start_readiness_from_args(&args);
    let command_args: Vec<&str> = args
        .iter()
        .filter(|arg| !arg.starts_with("--"))
        .map(String::as_str)
        .collect();
    let command = command_args.first().copied().unwrap_or("status");
    let config = Config::resolve()?;

    if command_args.as_slice() == ["probes", "serve"] {
        let options = probes::ProbeServerOptions::from_env(config.probes_socket_path.clone());
        return probes::serve(options);
    }

    match command {
        "status" => {
            let status = broker_service_status(&config);
            print_status(&status, json);
            Ok(())
        }
        "doctor" => {
            let report = doctor_report(&config, DoctorOptions { fix, yes });
            print_doctor(&report, json);
            Ok(())
        }
        "install" => {
            let status = install_service(&config)?;
            print_status(&status, json);
            Ok(())
        }
        "start" => {
            let status = start_service(&config, start_readiness)?;
            print_status(&status, json);
            Ok(())
        }
        "stop" => {
            let status = stop_service(&config)?;
            print_status(&status, json);
            Ok(())
        }
        "restart" => {
            // Validate ownership before stopping the healthy tree. A rejected
            // cross-checkout takeover must never turn into an outage merely
            // because restart used to perform its stop half first.
            ensure_launch_agent(&config)?;
            stop_service(&config)?;
            let status = start_service(&config, start_readiness)?;
            print_status(&status, json);
            Ok(())
        }
        "uninstall" => {
            let status = uninstall_service(&config)?;
            print_status(&status, json);
            Ok(())
        }
        "supervise" => supervise_service(&config),
        other => Err(format!("unknown command: {other}")),
    }
}

#[derive(Clone, Debug)]
struct Config {
    label: String,
    service_mode: String,
    domain_target: String,
    service_target: String,
    launch_agent_path: PathBuf,
    support_directory: PathBuf,
    open_scout_home: PathBuf,
    runtime_directory: PathBuf,
    logs_directory: PathBuf,
    probe_logs_directory: PathBuf,
    stdout_log_path: PathBuf,
    stderr_log_path: PathBuf,
    probe_stdout_log_path: PathBuf,
    probe_stderr_log_path: PathBuf,
    control_home: PathBuf,
    runtime_package_dir: PathBuf,
    daemon_executable: PathBuf,
    daemon_state_path: PathBuf,
    host_info_path: PathBuf,
    bun_executable: String,
    advertise_scope: String,
    broker_host: String,
    broker_port: u16,
    broker_url: String,
    broker_socket_path: PathBuf,
    probes_socket_path: PathBuf,
    repo_watch_interval: Option<Duration>,
}

impl Config {
    fn resolve() -> Result<Self, String> {
        let home = home_dir()?;
        let uid = user_id()?;
        let service_mode = match env_nonempty("OPENSCOUT_BROKER_SERVICE_MODE")
            .unwrap_or_else(|| "dev".to_string())
            .to_lowercase()
            .as_str()
        {
            "prod" | "production" => "prod".to_string(),
            "custom" => "custom".to_string(),
            _ => "dev".to_string(),
        };
        let label = env_nonempty("OPENSCOUT_SERVICE_LABEL")
            .or_else(|| env_nonempty("OPENSCOUT_BROKER_SERVICE_LABEL"))
            .unwrap_or_else(|| match service_mode.as_str() {
                "prod" => "app.openscout".to_string(),
                "custom" => "app.openscout.custom".to_string(),
                _ => "app.openscout".to_string(),
            });
        let default_support_directory = home.join("Library/Application Support/OpenScout");
        let support_directory = non_tmp_path_or_default(
            env_nonempty("OPENSCOUT_SUPPORT_DIRECTORY")
                .or_else(|| env_nonempty("OPENSCOUT_SUPPORT_DIR"))
                .map(PathBuf::from),
            default_support_directory,
        );
        let open_scout_home = env_nonempty("OPENSCOUT_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".openscout"));
        let runtime_directory = support_directory.join("runtime");
        let logs_directory = support_directory.join("logs/broker");
        let probe_logs_directory = support_directory.join("logs/probes");
        let control_home = non_tmp_path_or_default(
            env_nonempty("OPENSCOUT_CONTROL_HOME").map(PathBuf::from),
            home.join(".openscout/control-plane"),
        );
        let runtime_package_dir = match env_nonempty("OPENSCOUT_RUNTIME_PACKAGE_DIR") {
            Some(value) => PathBuf::from(value),
            None => {
                find_workspace_runtime_dir(&env::current_dir().map_err(|error| error.to_string())?)
                    .ok_or_else(|| {
                        "unable to resolve runtime package dir; set OPENSCOUT_RUNTIME_PACKAGE_DIR"
                            .to_string()
                    })?
            }
        };
        let daemon_executable = match env_nonempty("OPENSCOUT_SCOUTD_BIN") {
            Some(value) => PathBuf::from(value),
            None => env::current_exe().map_err(|error| error.to_string())?,
        };
        let bun_executable = env_nonempty("OPENSCOUT_BUN_BIN").unwrap_or_else(|| {
            let home_bun = home.join(".bun/bin/bun");
            if home_bun.exists() {
                home_bun.to_string_lossy().to_string()
            } else {
                "bun".to_string()
            }
        });
        let open_scout_network_enabled = open_scout_network_discovery_enabled(&support_directory);
        let advertise_scope = resolve_advertise_scope_value(
            open_scout_network_enabled,
            env_nonempty("OPENSCOUT_ADVERTISE_SCOPE"),
        );
        let broker_host =
            resolve_broker_host_value(&advertise_scope, env_nonempty("OPENSCOUT_BROKER_HOST"));
        let broker_port = env_nonempty("OPENSCOUT_BROKER_PORT")
            .and_then(|value| value.parse::<u16>().ok())
            .unwrap_or(DEFAULT_BROKER_PORT);
        let broker_url = resolve_broker_url_value(
            &advertise_scope,
            &broker_host,
            broker_port,
            env_nonempty("OPENSCOUT_BROKER_URL"),
        );
        let broker_socket_path = PathBuf::from(
            env_nonempty("OPENSCOUT_BROKER_SOCKET_PATH").unwrap_or_else(|| {
                runtime_directory
                    .join("broker.sock")
                    .to_string_lossy()
                    .to_string()
            }),
        );
        let probes_socket_path =
            PathBuf::from(env_nonempty("OPENSCOUT_PROBES_SOCKET").unwrap_or_else(|| {
                open_scout_home
                    .join("run/scoutd-probes.sock")
                    .to_string_lossy()
                    .to_string()
            }));
        let daemon_state_path = runtime_directory.join("scoutd-state.json");
        let host_info_path = support_directory.join(".host-info");
        let repo_watch_interval = repo_watch_interval_from_env();

        Ok(Self {
            label: label.clone(),
            service_mode,
            domain_target: format!("gui/{uid}"),
            service_target: format!("gui/{uid}/{label}"),
            launch_agent_path: home.join(format!("Library/LaunchAgents/{label}.plist")),
            support_directory,
            open_scout_home,
            runtime_directory,
            logs_directory: logs_directory.clone(),
            probe_logs_directory: probe_logs_directory.clone(),
            stdout_log_path: logs_directory.join("stdout.log"),
            stderr_log_path: logs_directory.join("stderr.log"),
            probe_stdout_log_path: probe_logs_directory.join("stdout.log"),
            probe_stderr_log_path: probe_logs_directory.join("stderr.log"),
            control_home,
            runtime_package_dir,
            daemon_executable,
            daemon_state_path,
            host_info_path,
            bun_executable,
            advertise_scope,
            broker_host,
            broker_port,
            broker_url,
            broker_socket_path,
            probes_socket_path,
            repo_watch_interval,
        })
    }

    fn runtime_entrypoint(&self) -> PathBuf {
        self.runtime_package_dir.join("bin/openscout-runtime.mjs")
    }
}

#[derive(Clone, Debug)]
struct LaunchctlStatus {
    loaded: bool,
    pid: Option<u32>,
    launchd_state: Option<String>,
    last_exit_status: Option<i32>,
}

#[derive(Clone, Debug)]
struct HealthStatus {
    state: &'static str,
    checked_at: u128,
    duration_ms: u128,
    reachable: bool,
    ok: bool,
    transport: Option<String>,
    status_code: Option<u16>,
    body: Option<String>,
    error: Option<String>,
}

#[derive(Clone, Debug)]
struct ServiceStatus {
    config: Config,
    launchctl: LaunchctlStatus,
    health: HealthStatus,
    effective_broker_url: Option<String>,
    effective_web_url: Option<String>,
    daemon_state: Option<String>,
    probes: probes::ProbeServerStatus,
    runtime_freshness: RuntimeFreshness,
}

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeBuildManifest {
    version: Option<String>,
    commit: Option<String>,
    source_dirty: Option<bool>,
    built_at: Option<String>,
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeArtifactIdentity {
    mode: String,
    commit: Option<String>,
    version: Option<String>,
    source_dirty: Option<bool>,
    built_at: Option<String>,
    manifest_path: Option<String>,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeFreshness {
    state: String,
    intentional: bool,
    basis: String,
    reason_code: Option<String>,
    artifact_commit: Option<String>,
    expected_commit: Option<String>,
    pin: Option<String>,
    pin_reason: Option<String>,
    manifest_path: Option<String>,
    version: Option<String>,
    actual_built_at: Option<String>,
    expected_built_at: Option<String>,
    // Backward-compatible alias for actual_built_at. New consumers should use
    // the explicitly named fields above.
    built_at: Option<String>,
    source_dirty: Option<bool>,
    detail: String,
}

#[derive(Clone, Debug)]
struct ChildExitTelemetry {
    at_ms: u128,
    code: Option<i32>,
    signal: Option<i32>,
    description: String,
}

#[derive(Clone, Debug, Default)]
struct DaemonStateTelemetry {
    base_state: Option<String>,
    restart_count: Option<u32>,
    restart_backoff_ms: Option<u64>,
    last_child_exit_description: Option<String>,
    last_child_exit_code: Option<i32>,
    last_child_exit_signal: Option<i32>,
    probe_state: Option<String>,
    probe_restart_count: Option<u32>,
    probe_restart_backoff_ms: Option<u64>,
    last_probe_child_exit_description: Option<String>,
    last_probe_child_exit_code: Option<i32>,
    last_probe_child_exit_signal: Option<i32>,
}

#[derive(Clone, Debug)]
struct ProcessInfo {
    pid: u32,
    ppid: u32,
    pcpu: String,
    pmem: String,
    elapsed: String,
    command: String,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManagedProcessLease {
    version: u32,
    kind: String,
    pid: u32,
    process_group_id: u32,
    profile_dir: PathBuf,
    #[serde(default, rename = "outputPath")]
    _output_path: PathBuf,
    #[serde(default, rename = "createdAtMs")]
    _created_at_ms: u64,
    expires_at_ms: u128,
}

#[derive(Default)]
struct ProcessSweepResult {
    expired_leases: usize,
    terminated_process_groups: usize,
    orphaned_pairing_advertisements: usize,
}

#[derive(Clone, Debug)]
struct DoctorReport {
    status: ServiceStatus,
    processes: Vec<ProcessInfo>,
    warnings: Vec<String>,
    repairs: Vec<DoctorRepair>,
    fix_requested: bool,
    yes: bool,
}

#[derive(Clone, Debug)]
struct DoctorRepair {
    id: String,
    title: String,
    status: String,
    detail: Option<String>,
    changed: bool,
}

#[derive(Clone, Copy, Debug, Default)]
struct DoctorOptions {
    fix: bool,
    yes: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum StartReadiness {
    BrokerHealthy,
    LaunchdAccepted,
}

fn start_readiness_from_args(args: &[String]) -> StartReadiness {
    if args.iter().any(|arg| arg == "--no-wait") {
        StartReadiness::LaunchdAccepted
    } else {
        StartReadiness::BrokerHealthy
    }
}

fn start_service_launchctl_command_plan<'a>(
    config: &'a Config,
) -> Result<[Vec<&'a str>; 2], String> {
    Ok([
        vec!["bootout", &config.service_target],
        vec![
            "bootstrap",
            &config.domain_target,
            path_str(&config.launch_agent_path)?,
        ],
    ])
}

fn install_service(config: &Config) -> Result<ServiceStatus, String> {
    bootout_legacy_service(config);
    ensure_launch_agent(config)?;
    Ok(broker_service_status(config))
}

fn start_service(config: &Config, readiness: StartReadiness) -> Result<ServiceStatus, String> {
    bootout_legacy_service(config);
    ensure_launch_agent(config)?;
    let [bootout_command, bootstrap_command] = start_service_launchctl_command_plan(config)?;
    let _ = run_command("/bin/launchctl", &bootout_command);
    let _ = wait_for_stopped(config);
    // The plist is RunAtLoad, so bootstrap is the start signal. Following it
    // with `kickstart -k` would immediately kill and drain the new process tree.
    run_command_checked("/bin/launchctl", &bootstrap_command)?;
    match readiness {
        StartReadiness::BrokerHealthy => wait_for_healthy(config),
        StartReadiness::LaunchdAccepted => {
            let status = launchd_accepted_service_status(config);
            if status.launchctl.loaded {
                Ok(status)
            } else {
                Err(format!(
                    "launchd did not accept service {}",
                    config.service_target,
                ))
            }
        }
    }
}

fn stop_service(config: &Config) -> Result<ServiceStatus, String> {
    let _ = run_command("/bin/launchctl", &["bootout", &config.service_target]);
    wait_for_stopped(config)
}

fn uninstall_service(config: &Config) -> Result<ServiceStatus, String> {
    let _ = stop_service(config);
    // Removes the legacy plist as well (see bootout_legacy_service).
    bootout_legacy_service(config);
    if config.launch_agent_path.exists() {
        fs::remove_file(&config.launch_agent_path).map_err(|error| error.to_string())?;
    }
    Ok(broker_service_status(config))
}

/// One pending snapshot, retried from live state; never queue stale snapshots.
struct StatePublication {
    next_attempt: Instant,
    retry_delay: Duration,
    failing: bool,
    last_warning: Option<Instant>,
}

impl StatePublication {
    fn new(now: Instant) -> Self {
        Self {
            next_attempt: now + STATE_WRITE_INTERVAL,
            retry_delay: STATE_WRITE_INTERVAL,
            failing: false,
            last_warning: None,
        }
    }

    fn is_due(&self, now: Instant) -> bool {
        now >= self.next_attempt
    }

    fn request_refresh(&mut self, now: Instant) {
        // Child lifecycle events must not turn a disk failure into a busy loop.
        if !self.failing {
            self.next_attempt = now;
        }
    }

    fn refresh(
        &mut self,
        now: Instant,
        write: impl FnOnce() -> Result<(), String>,
        mut report: impl FnMut(String),
    ) {
        if !self.is_due(now) {
            return;
        }
        match write() {
            Ok(()) => {
                if self.failing {
                    report("publication recovered".to_string());
                }
                self.failing = false;
                self.last_warning = None;
                self.retry_delay = STATE_WRITE_INTERVAL;
                self.next_attempt = now + STATE_WRITE_INTERVAL;
            }
            Err(error) => {
                if self.last_warning.map_or(true, |previous| {
                    now.duration_since(previous) >= STATE_WRITE_WARNING_INTERVAL
                }) {
                    report(format!(
                        "publication failed; supervision continues; retry in {}s: {error}",
                        self.retry_delay.as_secs()
                    ));
                    self.last_warning = Some(now);
                }
                self.failing = true;
                self.next_attempt = now + self.retry_delay;
                self.retry_delay = (self.retry_delay * 2).min(STATE_WRITE_RETRY_MAX);
            }
        }
    }
}

fn require_initial_state(
    result: Result<(), String>,
    cleanup: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    match result {
        Ok(()) => Ok(()),
        Err(error) => match cleanup() {
            Ok(()) => Err(format!("initial state publication failed: {error}")),
            Err(cleanup_error) => Err(format!(
                "initial state publication failed: {error}; cleanup failed: {cleanup_error}"
            )),
        },
    }
}

fn terminate_supervised_children(
    child: &mut Child,
    probe: &mut Option<Child>,
) -> Result<(), String> {
    // Always attempt both: one child's failure must not strand its sibling.
    let probe_result = match probe.as_mut() {
        Some(probe) => terminate_child(probe, "probe server", CHILD_SHUTDOWN_TIMEOUT),
        None => Ok(()),
    };
    let base_result = terminate_child(child, "Bun base", CHILD_SHUTDOWN_TIMEOUT);
    let errors: Vec<String> = [("probe server", probe_result), ("Bun base", base_result)]
        .into_iter()
        .filter_map(|(phase, result)| result.err().map(|error| format!("{phase}: {error}")))
        .collect();
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

fn finish_supervision(
    stopping: Result<(), String>,
    cleanup: impl FnOnce() -> Result<(), String>,
    stopped: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let cleanup_result = cleanup();
    // Never publish "stopped" if a child could still be alive.
    let stopped_result = if cleanup_result.is_ok() {
        stopped()
    } else {
        Ok(())
    };
    combine_supervision_shutdown(stopping, cleanup_result, stopped_result)
}

fn combine_supervision_shutdown(
    stopping: Result<(), String>,
    cleanup: Result<(), String>,
    stopped: Result<(), String>,
) -> Result<(), String> {
    let errors: Vec<String> = [
        ("stopping state", stopping),
        ("child cleanup", cleanup),
        ("stopped state", stopped),
    ]
    .into_iter()
    .filter_map(|(phase, result)| result.err().map(|error| format!("{phase}: {error}")))
    .collect();
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

#[cfg(test)]
struct SupervisionTestHooks {
    base: Option<Child>,
    probe: Option<Child>,
    expected_pids: (u32, u32),
    start: Instant,
    ticks: u32,
    stop_after_ticks: u32,
    fail_phase: &'static str,
    write_attempts: Vec<(&'static str, u32)>,
    observations: usize,
    sweep_samples: Vec<(u32, health_sweep::Observation)>,
    sweep_actions: Vec<(u32, String)>,
    sweep_states: Vec<(u32, Vec<health_sweep::Condition>)>,
    sweep_notifications_succeed: bool,
    sweep_probe_ticks: Vec<(u32, bool)>,
    health_worker: Option<health_worker::Worker>,
}

#[cfg(test)]
impl SupervisionTestHooks {
    fn now(&self) -> Instant {
        self.start + POLL_INTERVAL * self.ticks
    }
    fn write(
        &mut self,
        phase: &'static str,
        write: impl FnOnce() -> Result<(), String>,
    ) -> Result<(), String> {
        self.write_attempts.push((phase, self.ticks));
        if phase == self.fail_phase {
            Err("injected No space left on device (os error 28)".into())
        } else {
            write()
        }
    }
    fn observe(&mut self, base: &mut Child, probe: Option<&mut Child>) {
        let probe = probe.expect("test probe remains owned");
        assert_eq!((base.id(), probe.id()), self.expected_pids);
        assert!(base.try_wait().unwrap().is_none());
        assert!(probe.try_wait().unwrap().is_none());
        self.observations += 1;
    }
}

fn supervise_service(config: &Config) -> Result<(), String> {
    supervise_service_inner(
        config,
        #[cfg(test)]
        None,
    )
}

fn supervise_service_inner(
    config: &Config,
    #[cfg(test)] mut test_hooks: Option<&mut SupervisionTestHooks>,
) -> Result<(), String> {
    #[cfg(test)]
    let testing = test_hooks.is_some();
    #[cfg(not(test))]
    let testing = false;
    // Tests inject owned pipe children and clock/write faults; never start
    // a Scout service, process sweep, signal handler, or repo warmer.
    if !testing {
        install_signal_handlers();
        ensure_daemon_directories(config)?;
    }
    macro_rules! clock_now {
        () => {{
            #[cfg(test)]
            {
                test_hooks
                    .as_ref()
                    .map_or_else(Instant::now, |hooks| hooks.now())
            }
            #[cfg(not(test))]
            {
                Instant::now()
            }
        }};
    }
    macro_rules! write_state {
        ($phase:expr, $write:expr) => {{
            #[cfg(test)]
            {
                if let Some(hooks) = test_hooks.as_mut() {
                    hooks.write($phase, || $write)
                } else {
                    $write
                }
            }
            #[cfg(not(test))]
            {
                $write
            }
        }};
    }
    eprintln!(
        "[scoutd] starting Bun base from {}",
        config.runtime_entrypoint().display(),
    );

    let started_at_ms = epoch_ms();
    let mut restart_count = 0_u32;
    let mut restart_delay = RESTART_MIN_DELAY;
    let mut last_child_exit: Option<ChildExitTelemetry> = None;
    let mut runtime_build = configured_runtime_artifact(config);
    let mut child = {
        #[cfg(test)]
        {
            if let Some(hooks) = test_hooks.as_mut() {
                hooks.base.take().expect("test base")
            } else {
                spawn_base_process(config)?
            }
        }
        #[cfg(not(test))]
        {
            spawn_base_process(config)?
        }
    };

    let base_spawned_at_ms = if testing { started_at_ms } else { epoch_ms() };

    let mut probe_restart_count = 0_u32;
    let mut probe_restart_delay = RESTART_MIN_DELAY;
    let mut last_probe_exit: Option<ChildExitTelemetry> = None;
    let mut probe_state: String;
    let mut next_probe_restart_at: Option<Instant> = None;
    let probe_spawn = {
        #[cfg(test)]
        {
            if let Some(hooks) = test_hooks.as_mut() {
                Ok(hooks.probe.take().expect("test probe"))
            } else {
                spawn_probe_process(config)
            }
        }
        #[cfg(not(test))]
        {
            spawn_probe_process(config)
        }
    };
    let mut probe_child = match probe_spawn {
        Ok(child) => {
            eprintln!(
                "[scoutd] probe server started: pid {} socket {}",
                child.id(),
                config.probes_socket_path.display()
            );
            probe_state = "running".to_string();
            Some(child)
        }
        Err(error) => {
            eprintln!("[scoutd] probe server failed to start: {error}");
            probe_state = "failed".to_string();
            next_probe_restart_at = Some(clock_now!() + probe_restart_delay);
            probe_restart_delay = doubled_delay(probe_restart_delay);
            None
        }
    };

    let _repo_watch_warmer = if testing {
        None
    } else {
        start_repo_watch_warmer(config.clone())
    };
    require_initial_state(
        write_state!(
            "initial",
            write_daemon_state(
                config,
                &runtime_build,
                started_at_ms,
                Some(child.id()),
                "running",
                restart_count,
                Some(restart_delay),
                last_child_exit.as_ref(),
                probe_child.as_ref().map(Child::id),
                &probe_state,
                probe_restart_count,
                Some(probe_restart_delay),
                last_probe_exit.as_ref(),
            )
        ),
        || terminate_supervised_children(&mut child, &mut probe_child),
    )?;
    let mut state_publication = StatePublication::new(clock_now!());
    // State publication is diagnostic after startup. A failed write must not
    // relinquish ownership of healthy children to launchd.
    macro_rules! refresh_state {
        ($phase:expr, $write:expr) => {{
            let now = clock_now!();
            if $phase != "periodic" {
                state_publication.request_refresh(now);
            }
            state_publication.refresh(
                now,
                || $write,
                |message| {
                    let _ = writeln!(
                        io::stderr(),
                        "[scoutd] state {} ({}): {}",
                        config.daemon_state_path.display(),
                        $phase,
                        message
                    );
                },
            );
        }};
    }
    let mut next_process_sweep = clock_now!();
    let sweep_started = clock_now!();
    let mut next_health_sweep = sweep_started;
    let mut next_slow_sweep = sweep_started;
    #[cfg(test)]
    let injected_worker = test_hooks.as_mut().and_then(|h| h.health_worker.take());
    #[cfg(not(test))]
    let injected_worker = None;
    let mut health_worker = if testing {
        injected_worker
    } else {
        health_worker::Worker::start(config.clone())
    };
    let mut health_worker_backoff = health_worker::RestartBackoff::new(clock_now!());
    if !testing && health_worker.is_none() {
        let delay = health_worker_backoff.failed(clock_now!());
        eprintln!(
            "[scoutd] health worker start failed #{}; retry in {}s",
            health_worker_backoff.failures,
            delay.as_secs()
        );
    }
    let mut health_sweep = load_health_sweep(config).unwrap_or_default();
    health_sweep.base_started(base_spawned_at_ms);
    if !testing {
        prepare_health_reserve(config);
    }

    loop {
        #[cfg(test)]
        let stop = test_hooks.as_ref().map_or_else(
            || SHUTDOWN_REQUESTED.load(Ordering::SeqCst),
            |hooks| hooks.ticks >= hooks.stop_after_ticks,
        );
        #[cfg(not(test))]
        let stop = SHUTDOWN_REQUESTED.load(Ordering::SeqCst);
        if stop {
            break;
        }
        #[cfg(test)]
        if let Some(hooks) = test_hooks.as_mut() {
            hooks.observe(&mut child, probe_child.as_mut());
        }
        if clock_now!() >= next_process_sweep {
            if !testing && process_sweep_enabled() {
                match sweep_stale_managed_processes(config) {
                    Ok(result)
                        if result.expired_leases > 0
                            || result.terminated_process_groups > 0
                            || result.orphaned_pairing_advertisements > 0 =>
                    {
                        eprintln!(
                            "[scoutd] process sweep: {} expired lease(s), {} terminated group(s), {} orphaned pairing advertisement(s)",
                            result.expired_leases,
                            result.terminated_process_groups,
                            result.orphaned_pairing_advertisements,
                        );
                    }
                    Ok(_) => {}
                    Err(error) => eprintln!("[scoutd] process sweep failed: {error}"),
                }
            }
            next_process_sweep = clock_now!() + PROCESS_SWEEP_INTERVAL;
        }

        if !testing && health_worker.is_none() && health_worker_backoff.due(clock_now!()) {
            health_worker = health_worker::Worker::start(config.clone());
            if health_worker.is_some() {
                health_worker_backoff.started();
                next_health_sweep = clock_now!();
            } else {
                let delay = health_worker_backoff.failed(clock_now!());
                eprintln!(
                    "[scoutd] health worker start failed #{}; retry in {}s",
                    health_worker_backoff.failures,
                    delay.as_secs()
                );
            }
        }
        let mut collected = None;
        let mut worker_disconnected = false;
        if let Some(worker) = health_worker.as_mut() {
            while let Some(result) = worker.poll() {
                match result {
                    health_worker::Result::Disconnected => worker_disconnected = true,
                    health_worker::Result::Observed {
                        observation,
                        base_pid,
                    } => {
                        health_worker_backoff.observed(clock_now!());
                        if base_pid == child.id() {
                            collected = Some(observation);
                        }
                    }
                    health_worker::Result::Notified {
                        id,
                        since,
                        level,
                        delivered,
                    } => {
                        // A delayed delivery result must not alter a new incident.
                        if let Some(condition) = health_sweep
                            .conditions
                            .iter_mut()
                            .find(|c| c.condition == id && c.delivery_matches(since, level))
                        {
                            if !delivered {
                                condition.delivery_failed(epoch_ms());
                            }
                            if let Err(error) = publish_health_sweep(config, &health_sweep) {
                                eprintln!(
                                    "[scoutd] health delivery checkpoint unavailable: {error}"
                                );
                            }
                        }
                    }
                }
            }
        }
        if worker_disconnected {
            #[cfg(test)]
            if let Some(hooks) = test_hooks.as_mut() {
                hooks
                    .sweep_actions
                    .push((hooks.ticks, "worker-disconnected".into()));
            }
            let delay = health_worker_backoff.failed(clock_now!());
            eprintln!("[scoutd] health worker disconnected #{}; restarting in {}s; delivery reservations preserved", health_worker_backoff.failures, delay.as_secs());
            health_worker = None;
            // Lost observations must not consume the next slow sweep.
            next_slow_sweep = clock_now!();
        }
        let sweep_due = clock_now!() >= next_health_sweep;
        if sweep_due || collected.is_some() {
            let now = if testing {
                started_at_ms + clock_now!().duration_since(sweep_started).as_millis()
            } else {
                epoch_ms()
            };
            let slow = sweep_due && clock_now!() >= next_slow_sweep;
            #[cfg(test)]
            let injected = test_hooks.as_mut().and_then(|hooks| {
                hooks.sweep_probe_ticks.push((hooks.ticks, slow));
                hooks
                    .sweep_samples
                    .iter()
                    .rev()
                    .find(|(tick, _)| *tick <= hooks.ticks)
                    .map(|(_, sample)| sample.clone())
            });
            #[cfg(not(test))]
            let injected: Option<health_sweep::Observation> = None;
            let observation_scheduled = if sweep_due {
                health_worker
                    .as_mut()
                    .map_or(testing, |worker| worker.observe(slow, now, child.id()))
            } else {
                false
            };
            let observation = injected.or(collected);
            if let Some(observation) = observation {
                let restart = health_sweep.observe_all(now, &observation);
                let runtime_up = observation
                    .health
                    .as_deref()
                    .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
                    .and_then(|v| {
                        v.pointer("/startup/mutationsAdmitted")
                            .and_then(|s| s.as_bool())
                            .or_else(|| v.get("ok").and_then(|s| s.as_bool()))
                    })
                    == Some(true);
                let delivery_busy = health_worker
                    .as_ref()
                    .map_or(!testing, |w| w.notification_pending);
                for id in health_sweep
                    .due_notifications(now)
                    .into_iter()
                    .take(if delivery_busy { 0 } else { 1 })
                {
                    if SHUTDOWN_REQUESTED.load(Ordering::SeqCst) {
                        break;
                    }
                    let index = health_sweep
                        .conditions
                        .iter()
                        .position(|c| c.condition == id)
                        .unwrap();
                    // Persist the reservation before invoking any delivery path. A
                    // crash after display/recording cannot duplicate a notification.
                    health_sweep.conditions[index].reserve_notice(now);
                    let reserved =
                        write_state!("health", publish_health_sweep(config, &health_sweep)).is_ok();
                    let condition = &health_sweep.conditions[index];
                    let delivered = if reserved {
                        #[cfg(test)]
                        {
                            if let Some(hooks) = test_hooks.as_mut() {
                                hooks.sweep_actions.push((
                                    hooks.ticks,
                                    format!(
                                        "notify:{}:{}",
                                        if runtime_up { "runtime" } else { "local" },
                                        id
                                    ),
                                ));
                                hooks.sweep_notifications_succeed
                            } else {
                                health_worker
                                    .as_mut()
                                    .is_some_and(|w| w.notify(condition.clone(), runtime_up))
                            }
                        }
                        #[cfg(not(test))]
                        {
                            health_worker
                                .as_mut()
                                .is_some_and(|w| w.notify(condition.clone(), runtime_up))
                        }
                    } else {
                        false
                    };
                    if !delivered {
                        // Explicit failures retry after a persisted bounded delay.
                        health_sweep.conditions[index].delivery_failed(now);
                    }
                }
                let persisted = write_state!("health", publish_health_sweep(config, &health_sweep));
                if let Err(error) = &persisted {
                    eprintln!("[scoutd] health sweep state unavailable: {error}");
                }
                if restart && persisted.is_err() {
                    health_sweep.defer_restart(now);
                }
                #[cfg(test)]
                if let Some(hooks) = test_hooks.as_mut() {
                    hooks
                        .sweep_states
                        .push((hooks.ticks, health_sweep.conditions.clone()));
                }
                if restart && persisted.is_ok() && !SHUTDOWN_REQUESTED.load(Ordering::SeqCst) {
                    #[cfg(test)]
                    let intercepted = if let Some(hooks) = test_hooks.as_mut() {
                        hooks
                            .sweep_actions
                            .push((hooks.ticks, "restart-base".into()));
                        true
                    } else {
                        false
                    };
                    #[cfg(not(test))]
                    let intercepted = false;
                    if !intercepted {
                        // Only this retained Child carries signalling authority.
                        if let Err(error) =
                            terminate_child(&mut child, "degraded Bun base", CHILD_SHUTDOWN_TIMEOUT)
                        {
                            eprintln!("[scoutd] health sweep could not stop owned base: {error}");
                        }
                    }
                }
            }
            if slow && observation_scheduled {
                next_slow_sweep = clock_now!() + health_observations::SLOW_INTERVAL;
            }
            if sweep_due {
                next_health_sweep = clock_now!() + Duration::from_secs(30);
            }
        }

        if let Some(probe) = probe_child.as_mut() {
            if let Some(status) = probe.try_wait().map_err(|error| error.to_string())? {
                last_probe_exit = Some(child_exit_telemetry(&status));
                eprintln!("[scoutd] probe server exited: {status}");
                probe_child = None;
                probe_state = "exited".to_string();
                probe_restart_count = probe_restart_count.saturating_add(1);
                next_probe_restart_at = Some(clock_now!() + probe_restart_delay);
                refresh_state!(
                    "probe-exited",
                    write_state!(
                        "probe-exited",
                        write_daemon_state(
                            config,
                            &runtime_build,
                            started_at_ms,
                            Some(child.id()),
                            "running",
                            restart_count,
                            Some(restart_delay),
                            last_child_exit.as_ref(),
                            None,
                            &probe_state,
                            probe_restart_count,
                            Some(probe_restart_delay),
                            last_probe_exit.as_ref(),
                        )
                    )
                );
                probe_restart_delay = doubled_delay(probe_restart_delay);
            }
        }
        if probe_child.is_none() {
            if let Some(deadline) = next_probe_restart_at {
                if clock_now!() >= deadline {
                    match spawn_probe_process(config) {
                        Ok(child) => {
                            eprintln!(
                                "[scoutd] probe server restarted: pid {} socket {}",
                                child.id(),
                                config.probes_socket_path.display()
                            );
                            probe_state = "running".to_string();
                            probe_child = Some(child);
                            next_probe_restart_at = None;
                        }
                        Err(error) => {
                            eprintln!("[scoutd] probe server restart failed: {error}");
                            probe_state = "failed".to_string();
                            probe_restart_count = probe_restart_count.saturating_add(1);
                            next_probe_restart_at = Some(clock_now!() + probe_restart_delay);
                            probe_restart_delay = doubled_delay(probe_restart_delay);
                        }
                    }
                    state_publication.request_refresh(clock_now!());
                }
            }
        }

        match child.try_wait().map_err(|error| error.to_string())? {
            Some(status) => {
                last_child_exit = Some(child_exit_telemetry(&status));
                refresh_state!(
                    "base-exited",
                    write_state!(
                        "base-exited",
                        write_daemon_state(
                            config,
                            &runtime_build,
                            started_at_ms,
                            None,
                            "exited",
                            restart_count,
                            Some(restart_delay),
                            last_child_exit.as_ref(),
                            probe_child.as_ref().map(Child::id),
                            &probe_state,
                            probe_restart_count,
                            Some(probe_restart_delay),
                            last_probe_exit.as_ref(),
                        )
                    )
                );
                eprintln!("[scoutd] Bun base exited: {status}");
                restart_count = restart_count.saturating_add(1);
                sleep_until_or_shutdown(clock_now!() + restart_delay);
                if SHUTDOWN_REQUESTED.load(Ordering::SeqCst) {
                    break;
                }
                restart_delay = doubled_delay(restart_delay);
                runtime_build = configured_runtime_artifact(config);
                child = spawn_base_process(config)?;
                // Crash respawns must not postpone an open projection outage.
                // Only supervisor startup and sweep recovery grant a boot window.
                refresh_state!(
                    "base-started",
                    write_state!(
                        "base-started",
                        write_daemon_state(
                            config,
                            &runtime_build,
                            started_at_ms,
                            Some(child.id()),
                            "running",
                            restart_count,
                            Some(restart_delay),
                            last_child_exit.as_ref(),
                            probe_child.as_ref().map(Child::id),
                            &probe_state,
                            probe_restart_count,
                            Some(probe_restart_delay),
                            last_probe_exit.as_ref(),
                        )
                    )
                );
            }
            None => {
                if state_publication.is_due(clock_now!()) {
                    refresh_state!(
                        "periodic",
                        write_state!(
                            "periodic",
                            write_daemon_state(
                                config,
                                &runtime_build,
                                started_at_ms,
                                Some(child.id()),
                                "running",
                                restart_count,
                                Some(restart_delay),
                                last_child_exit.as_ref(),
                                probe_child.as_ref().map(Child::id),
                                &probe_state,
                                probe_restart_count,
                                Some(probe_restart_delay),
                                last_probe_exit.as_ref(),
                            )
                        )
                    );
                }
                #[cfg(test)]
                {
                    if let Some(hooks) = test_hooks.as_mut() {
                        hooks.ticks += 1;
                    } else {
                        thread::sleep(POLL_INTERVAL);
                    }
                }
                #[cfg(not(test))]
                thread::sleep(POLL_INTERVAL);
            }
        }
    }

    let stopping_state = write_state!(
        "stopping",
        write_daemon_state(
            config,
            &runtime_build,
            started_at_ms,
            Some(child.id()),
            "stopping",
            restart_count,
            Some(restart_delay),
            last_child_exit.as_ref(),
            probe_child.as_ref().map(Child::id),
            "stopping",
            probe_restart_count,
            Some(probe_restart_delay),
            last_probe_exit.as_ref(),
        )
    );
    finish_supervision(
        stopping_state,
        || terminate_supervised_children(&mut child, &mut probe_child),
        || {
            write_state!(
                "stopped",
                write_daemon_state(
                    config,
                    &runtime_build,
                    started_at_ms,
                    None,
                    "stopped",
                    restart_count,
                    Some(restart_delay),
                    last_child_exit.as_ref(),
                    None,
                    "stopped",
                    probe_restart_count,
                    Some(probe_restart_delay),
                    last_probe_exit.as_ref(),
                )
            )
        },
    )
}

fn install_signal_handlers() {
    unsafe {
        let _ = signal(SIGINT, request_shutdown);
        let _ = signal(SIGTERM, request_shutdown);
    }
}

/// The OpenScout instance every child scoutd launches runs as. Always set
/// explicitly (prod by default): run from a source checkout with
/// OPENSCOUT_INSTANCE unset, the broker and pairing controller would take the
/// checkout's dev default.
fn launch_instance(optional_env: impl Fn(&str) -> Option<String>) -> String {
    optional_env("OPENSCOUT_INSTANCE").unwrap_or_else(|| "prod".to_string())
}

fn spawn_base_process(config: &Config) -> Result<Child, String> {
    prepare_child_logs_for_spawn(config)?;
    let stdout_log = open_child_log(&config.stdout_log_path)?;
    let stderr_log = open_child_log(&config.stderr_log_path)?;
    let mut command = base_process_command(config, env_nonempty);
    command
        .stdout(Stdio::from(stdout_log))
        .stderr(Stdio::from(stderr_log));
    command
        .spawn()
        .map_err(|error| format!("failed to start Bun base: {error}"))
}

/// The `scout-base` command (args + env) without its log redirection, so the
/// pinned env is testable.
fn base_process_command(config: &Config, optional_env: impl Fn(&str) -> Option<String>) -> Command {
    let mut command = Command::new(&config.bun_executable);
    command
        // openscout-runtime.mjs now runs base-daemon in-process (no second bun
        // child), so this process IS scout-base; name it for ps/doctor.
        .arg0("scout-base")
        .arg(config.runtime_entrypoint())
        .arg("base")
        .current_dir(&config.runtime_package_dir)
        .env("OPENSCOUT_PARENT_PID", std::process::id().to_string())
        .env("OPENSCOUT_INSTANCE", launch_instance(&optional_env))
        .env(
            "OPENSCOUT_SUPPORT_DIRECTORY",
            config.support_directory.to_string_lossy().to_string(),
        )
        .env(
            "OPENSCOUT_RUNTIME_PACKAGE_DIR",
            config.runtime_package_dir.to_string_lossy().to_string(),
        )
        .env("OPENSCOUT_BROKER_HOST", &config.broker_host)
        .env("OPENSCOUT_BROKER_PORT", config.broker_port.to_string())
        .env("OPENSCOUT_BROKER_URL", &config.broker_url)
        .env("OPENSCOUT_ADVERTISE_SCOPE", &config.advertise_scope)
        .env(
            "OPENSCOUT_BROKER_SOCKET_PATH",
            config.broker_socket_path.to_string_lossy().to_string(),
        )
        .env(
            "OPENSCOUT_CONTROL_HOME",
            config.control_home.to_string_lossy().to_string(),
        )
        .env("OPENSCOUT_BROKER_SERVICE_MODE", &config.service_mode)
        .env("OPENSCOUT_BROKER_SERVICE_LABEL", &config.label)
        .env("OPENSCOUT_SERVICE_LABEL", &config.label);

    for &key in OPTIONAL_LAUNCH_ENV_KEYS {
        if let Some(value) = optional_env(key) {
            command.env(key, value);
        }
    }
    for (key, value) in push_relay_child_environment() {
        command.env(key, value);
    }
    if let Some(core_agents) = optional_env("OPENSCOUT_CORE_AGENTS") {
        command.env("OPENSCOUT_CORE_AGENTS", core_agents);
    }
    command
}

fn spawn_probe_process(config: &Config) -> Result<Child, String> {
    prepare_probe_logs_for_spawn(config)?;
    let stdout_log = open_child_log(&config.probe_stdout_log_path)?;
    let stderr_log = open_child_log(&config.probe_stderr_log_path)?;
    let mut command = Command::new(&config.daemon_executable);
    command
        .arg("probes")
        .arg("serve")
        .env("OPENSCOUT_PARENT_PID", std::process::id().to_string())
        .env(
            "OPENSCOUT_HOME",
            config.open_scout_home.to_string_lossy().to_string(),
        )
        .env(
            "OPENSCOUT_PROBES_SOCKET",
            config.probes_socket_path.to_string_lossy().to_string(),
        )
        .env(
            "OPENSCOUT_SUPPORT_DIRECTORY",
            config.support_directory.to_string_lossy().to_string(),
        )
        .env(
            "OPENSCOUT_RUNTIME_PACKAGE_DIR",
            config.runtime_package_dir.to_string_lossy().to_string(),
        )
        .stdout(Stdio::from(stdout_log))
        .stderr(Stdio::from(stderr_log));

    for &key in OPTIONAL_LAUNCH_ENV_KEYS {
        if let Some(value) = env_nonempty(key) {
            command.env(key, value);
        }
    }

    command
        .spawn()
        .map_err(|error| format!("failed to start probe server: {error}"))
}

fn maintain_health_sweep_logs(config: &Config) -> Result<(), String> {
    let base_logs = config.support_directory.join("logs/base");
    let mut paths = vec![
        (config.stdout_log_path.clone(), &config.logs_directory),
        (config.stderr_log_path.clone(), &config.logs_directory),
        (
            config.probe_stdout_log_path.clone(),
            &config.probe_logs_directory,
        ),
        (
            config.probe_stderr_log_path.clone(),
            &config.probe_logs_directory,
        ),
    ];
    for role in [
        "broker",
        "pairing",
        "room-listening",
        "mdns",
        "edge",
        "menu",
        "mesh-bridge",
    ] {
        for stream in ["stdout", "stderr"] {
            paths.push((base_logs.join(format!("{role}.{stream}.log")), &base_logs));
        }
    }
    let mut errors = Vec::new();
    for (path, directory) in paths {
        if let Err(error) = rotate_child_log_if_needed(&path, directory) {
            errors.push(error);
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

fn prepare_child_logs_for_spawn(config: &Config) -> Result<(), String> {
    rotate_child_log_if_needed(&config.stdout_log_path, &config.logs_directory)?;
    rotate_child_log_if_needed(&config.stderr_log_path, &config.logs_directory)
}

fn prepare_probe_logs_for_spawn(config: &Config) -> Result<(), String> {
    rotate_child_log_if_needed(&config.probe_stdout_log_path, &config.probe_logs_directory)?;
    rotate_child_log_if_needed(&config.probe_stderr_log_path, &config.probe_logs_directory)
}

fn open_child_log(path: &Path) -> Result<fs::File, String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| format!("failed to open child log {}: {error}", path.display()))
}

fn rotate_child_log_if_needed(path: &Path, logs_directory: &Path) -> Result<(), String> {
    rotate_child_log_with_guard(path, logs_directory, |file| {
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    })
}
fn rotation_guard_allows(
    result: io::Result<()>,
    warned: &AtomicBool,
    warn_unavailable: impl FnOnce(&io::Error),
) -> bool {
    match result {
        Ok(()) => true,
        Err(error) if error.kind() == io::ErrorKind::WouldBlock => false,
        Err(error) => {
            // Advisory locking is optional; preserve the pre-lock rotation
            // behavior on filesystems that cannot provide it.
            if !warned.swap(true, Ordering::Relaxed) {
                warn_unavailable(&error);
            }
            true
        }
    }
}
fn rotate_child_log_with_guard(
    path: &Path,
    logs_directory: &Path,
    lock: impl FnOnce(&fs::File) -> io::Result<()>,
) -> Result<(), String> {
    if !scoutd_owned_child_log_path(path, logs_directory) {
        return Ok(());
    }
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("failed to inspect log {}: {error}", path.display())),
    };
    if metadata.file_type().is_symlink() || !metadata.file_type().is_file() || metadata.nlink() != 1
    {
        return Ok(());
    }
    if metadata.len() <= CHILD_LOG_ROTATE_LIMIT {
        return Ok(());
    }

    let mut file = OpenOptions::new()
        .read(true)
        .write(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|error| format!("failed to read log {}: {error}", path.display()))?;
    let opened = file.metadata().map_err(|error| error.to_string())?;
    if !opened.is_file()
        || opened.uid() != unsafe { libc::geteuid() }
        || opened.nlink() != 1
        || opened.ino() != metadata.ino()
        || opened.dev() != metadata.dev()
    {
        return Ok(());
    }
    // Spawn-time rotation and the sweep share this nonblocking inode guard.
    // Append writers do not take it; only competing rotators are excluded.
    static UNAVAILABLE_WARNING: AtomicBool = AtomicBool::new(false);
    if !rotation_guard_allows(lock(&file), &UNAVAILABLE_WARNING, |error| {
        eprintln!("[scoutd] advisory log locking unavailable; rotating without a lock: {error}");
    }) {
        return Ok(());
    }
    let current_len = file.metadata().map_err(|error| error.to_string())?.len();
    if current_len <= CHILD_LOG_ROTATE_LIMIT {
        return Ok(());
    }
    file.seek(SeekFrom::Start(
        current_len.saturating_sub(CHILD_LOG_ROTATE_LIMIT),
    ))
    .map_err(|error| format!("failed to seek log {}: {error}", path.display()))?;
    let mut retained_tail = Vec::new();
    (&mut file)
        .take(CHILD_LOG_ROTATE_LIMIT)
        .read_to_end(&mut retained_tail)
        .map_err(|error| format!("failed to retain log tail {}: {error}", path.display()))?;

    let rotated_path = rotated_child_log_path(path);
    // Never follow a pre-existing rotation symlink into user data.
    if let Ok(metadata) = fs::symlink_metadata(&rotated_path) {
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Ok(());
        }
    }
    let mut rotated = match OpenOptions::new()
        .write(true)
        .create(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(&rotated_path)
    {
        Ok(file) => file,
        Err(error) if space_error(&error) => {
            // No inode/block is available for a snapshot. Scout-owned logs are
            // expendable; reclaim their space rather than latch on ENOSPC.
            return file.set_len(0).map_err(|error| error.to_string());
        }
        Err(error) => return Err(error.to_string()),
    };
    let metadata = rotated.metadata().map_err(|error| error.to_string())?;
    if !metadata.is_file() || metadata.nlink() != 1 {
        return Ok(());
    }
    retain_or_reclaim_log(&file, || write_log_tail(&mut rotated, &retained_tail)).map_err(
        |error| {
            format!(
                "failed to write rotated log {}: {error}",
                rotated_path.display()
            )
        },
    )?;
    file.set_len(0)
        .map_err(|error| format!("failed to truncate log {}: {error}", path.display()))
}

fn write_log_tail(rotated: &mut fs::File, tail: &[u8]) -> io::Result<()> {
    // set_len does not reset the cursor after a partial ENOSPC write.
    rotated.seek(SeekFrom::Start(0))?;
    rotated.set_len(0)?;
    rotated.write_all(tail)
}

fn space_error(error: &io::Error) -> bool {
    matches!(
        error.raw_os_error(),
        Some(libc::ENOSPC) | Some(libc::EDQUOT)
    )
}
fn retain_or_reclaim_log(
    source: &fs::File,
    mut write_tail: impl FnMut() -> io::Result<()>,
) -> io::Result<()> {
    match write_tail() {
        Err(error) if space_error(&error) => {
            source.set_len(0)?;
            write_tail()
        }
        result => result,
    }
}

fn scoutd_owned_child_log_path(path: &Path, logs_directory: &Path) -> bool {
    if path.parent() != Some(logs_directory) {
        return false;
    }
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    if matches!(name, "stdout.log" | "stderr.log") {
        return true;
    }
    logs_directory.file_name().and_then(|n| n.to_str()) == Some("base")
        && [
            "broker",
            "pairing",
            "room-listening",
            "mdns",
            "edge",
            "menu",
            "mesh-bridge",
        ]
        .iter()
        .any(|role| name == format!("{role}.stdout.log") || name == format!("{role}.stderr.log"))
}

fn rotated_child_log_path(path: &Path) -> PathBuf {
    let file_name = path
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| "child.log".to_string());
    path.with_file_name(format!("{file_name}.1"))
}

fn child_exit_telemetry(status: &ExitStatus) -> ChildExitTelemetry {
    ChildExitTelemetry {
        at_ms: epoch_ms(),
        code: status.code(),
        signal: status.signal(),
        description: status.to_string(),
    }
}

fn sleep_until_or_shutdown(deadline: Instant) {
    while Instant::now() < deadline && !SHUTDOWN_REQUESTED.load(Ordering::SeqCst) {
        thread::sleep(POLL_INTERVAL);
    }
}

fn start_repo_watch_warmer(config: Config) -> Option<thread::JoinHandle<()>> {
    let interval = config.repo_watch_interval?;
    match thread::Builder::new()
        .name("scoutd-repo-watch-warmer".to_string())
        .spawn(move || {
            sleep_until_or_shutdown(Instant::now() + REPO_WATCH_WARM_START_DELAY);
            while !SHUTDOWN_REQUESTED.load(Ordering::SeqCst) {
                if let Err(error) = warm_repo_watch_snapshot(&config) {
                    eprintln!("[scoutd] repo-watch warm failed: {error}");
                }
                sleep_until_or_shutdown(Instant::now() + interval);
            }
        }) {
        Ok(handle) => Some(handle),
        Err(error) => {
            eprintln!("[scoutd] failed to start repo-watch warmer: {error}");
            None
        }
    }
}

fn warm_repo_watch_snapshot(config: &Config) -> Result<(), String> {
    match warm_repo_watch_unix(&config.broker_socket_path) {
        Ok(()) => Ok(()),
        Err(socket_error) => warm_repo_watch_tcp(config)
            .map_err(|http_error| format!("{socket_error}; http fallback: {http_error}")),
    }
}

fn warm_repo_watch_unix(socket_path: &Path) -> Result<(), String> {
    let mut stream = UnixStream::connect(socket_path).map_err(|error| error.to_string())?;
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .map_err(|error| error.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
        .map_err(|error| error.to_string())?;
    warm_repo_watch_http(&mut stream, "localhost")
}

fn warm_repo_watch_tcp(config: &Config) -> Result<(), String> {
    let mut stream = TcpStream::connect((&config.broker_host[..], config.broker_port))
        .map_err(|error| error.to_string())?;
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .map_err(|error| error.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
        .map_err(|error| error.to_string())?;
    warm_repo_watch_http(&mut stream, &config.broker_host)
}

fn warm_repo_watch_http<T: Read + Write>(stream: &mut T, host: &str) -> Result<(), String> {
    let response = fetch_http_response(stream, host, REPO_WATCH_WARM_PATH, "application/json")?;
    match parse_http_status_code(&response) {
        Some(status) if (200..300).contains(&status) => Ok(()),
        Some(status) => Err(format!("repo-watch warm returned HTTP {status}")),
        None => Err("repo-watch warm response missing HTTP status".to_string()),
    }
}

fn fetch_http_response<T: Read + Write>(
    stream: &mut T,
    host: &str,
    path: &str,
    accept: &str,
) -> Result<String, String> {
    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: {host}\r\nAccept: {accept}\r\nConnection: close\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|error| error.to_string())?;
    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .map_err(|error| error.to_string())?;
    Ok(response)
}

fn parse_http_status_code(response: &str) -> Option<u16> {
    response
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|value| value.parse::<u16>().ok())
}

fn doubled_delay(delay: Duration) -> Duration {
    let doubled = delay.as_millis().saturating_mul(2);
    Duration::from_millis(doubled.min(RESTART_MAX_DELAY.as_millis()) as u64)
}

fn terminate_child(child: &mut Child, label: &str, timeout: Duration) -> Result<(), String> {
    if child
        .try_wait()
        .map_err(|error| error.to_string())?
        .is_some()
    {
        return Ok(());
    }

    let _ = send_process_signal(child.id(), "TERM");
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if child
            .try_wait()
            .map_err(|error| error.to_string())?
            .is_some()
        {
            return Ok(());
        }
        thread::sleep(POLL_INTERVAL);
    }

    eprintln!("[scoutd] {label} did not exit after SIGTERM; forcing shutdown");
    child.kill().map_err(|error| error.to_string())?;
    let _ = child.wait();
    Ok(())
}

fn send_process_signal(pid: u32, signal_name: &str) -> Result<(), String> {
    let status = Command::new("/bin/kill")
        .arg(format!("-{signal_name}"))
        .arg(pid.to_string())
        .status()
        .map_err(|error| error.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("kill -{signal_name} {pid} exited with {status}"))
    }
}

fn broker_service_status(config: &Config) -> ServiceStatus {
    let health = fetch_health(config);
    let daemon_state = read_daemon_state_json(config);
    let runtime_freshness = inspect_runtime_freshness(config, daemon_state.as_deref());
    service_status(
        config,
        health,
        probes::probe_server_status(&config.probes_socket_path),
        daemon_state,
        runtime_freshness,
    )
}

fn launchd_accepted_service_status(config: &Config) -> ServiceStatus {
    let daemon_state = read_daemon_state_json(config);
    service_status(
        config,
        HealthStatus {
            state: "unknown",
            checked_at: epoch_ms(),
            duration_ms: 0,
            reachable: false,
            ok: false,
            transport: None,
            status_code: None,
            body: None,
            error: Some("broker readiness check deferred by --no-wait".to_string()),
        },
        probes::ProbeServerStatus {
            socket_path: config.probes_socket_path.to_string_lossy().to_string(),
            socket_exists: config.probes_socket_path.exists(),
            reachable: false,
            daemon_version: None,
            families: Vec::new(),
            error: Some("probe readiness check deferred by --no-wait".to_string()),
        },
        daemon_state,
        RuntimeFreshness {
            state: "unverified".to_string(),
            intentional: false,
            basis: "deferred_start".to_string(),
            reason_code: Some("readiness_deferred".to_string()),
            artifact_commit: None,
            expected_commit: None,
            pin: None,
            pin_reason: None,
            manifest_path: None,
            version: None,
            actual_built_at: None,
            expected_built_at: None,
            built_at: None,
            source_dirty: None,
            detail: "Runtime freshness check deferred by --no-wait.".to_string(),
        },
    )
}

fn service_status(
    config: &Config,
    health: HealthStatus,
    probes: probes::ProbeServerStatus,
    daemon_state: Option<String>,
    runtime_freshness: RuntimeFreshness,
) -> ServiceStatus {
    let host_info = read_host_info_json(config);
    let effective_broker_url = host_info
        .as_deref()
        .and_then(|body| parse_json_string_field(body, "brokerUrl"))
        .or_else(|| {
            if health.reachable && health.ok {
                fetch_node_broker_url(config).ok().flatten()
            } else {
                None
            }
        });
    let effective_web_url = host_info
        .as_deref()
        .and_then(|body| parse_json_string_field(body, "webUrl"));

    ServiceStatus {
        config: config.clone(),
        launchctl: inspect_launchctl(config),
        health,
        effective_broker_url,
        effective_web_url,
        runtime_freshness,
        daemon_state,
        probes,
    }
}

fn wait_for_healthy(config: &Config) -> Result<ServiceStatus, String> {
    let deadline = Instant::now() + START_TIMEOUT;
    let mut last = broker_service_status(config);
    while Instant::now() < deadline {
        last = broker_service_status(config);
        if last.health.reachable && last.health.ok {
            return Ok(last);
        }
        thread::sleep(POLL_INTERVAL);
    }
    Err(format!(
        "broker did not become healthy: {}",
        last.health
            .error
            .clone()
            .unwrap_or_else(|| "health check failed".to_string()),
    ))
}

fn wait_for_stopped(config: &Config) -> Result<ServiceStatus, String> {
    let deadline = Instant::now() + STOP_TIMEOUT;
    let mut last = broker_service_status(config);
    while Instant::now() < deadline {
        last = broker_service_status(config);
        if !last.launchctl.loaded && !last.health.reachable {
            return Ok(last);
        }
        thread::sleep(POLL_INTERVAL);
    }
    Err(format!(
        "service did not stop within {:?}: launchd loaded={}, broker reachable={}",
        STOP_TIMEOUT, last.launchctl.loaded, last.health.reachable,
    ))
}

fn inspect_launchctl(config: &Config) -> LaunchctlStatus {
    let output = match run_command("/bin/launchctl", &["print", &config.service_target]) {
        Ok(output) => output,
        Err(_) => {
            return LaunchctlStatus {
                loaded: false,
                pid: None,
                launchd_state: None,
                last_exit_status: None,
            };
        }
    };

    if output.status != 0 {
        return LaunchctlStatus {
            loaded: false,
            pid: None,
            launchd_state: None,
            last_exit_status: None,
        };
    }

    LaunchctlStatus {
        loaded: true,
        pid: parse_launchctl_u32(&output.stdout, "pid ="),
        launchd_state: parse_launchctl_string(&output.stdout, "state ="),
        last_exit_status: parse_launchctl_i32(&output.stdout, "last exit code =")
            .or_else(|| parse_launchctl_i32(&output.stdout, "last exit status =")),
    }
}

fn fetch_health(config: &Config) -> HealthStatus {
    let started = Instant::now();
    let mut health = fetch_health_observation(config);
    health.checked_at = epoch_ms();
    health.duration_ms = started.elapsed().as_millis();
    if health.ok && health.duration_ms >= 1_000 {
        health.state = "slow";
    }
    health
}

fn fetch_health_observation(config: &Config) -> HealthStatus {
    match fetch_unix_health(&config.broker_socket_path) {
        Ok(mut health) => {
            health.transport = Some("unix_socket".to_string());
            return health;
        }
        Err(socket_error) => match fetch_tcp_health(config) {
            Ok(mut health) => {
                health.transport = Some("http".to_string());
                health
            }
            Err(http_error) => HealthStatus {
                state: if matches!(
                    http_error.kind(),
                    io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
                ) || matches!(
                    socket_error.kind(),
                    io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
                ) {
                    "timed_out"
                } else {
                    "unreachable"
                },
                checked_at: epoch_ms(),
                duration_ms: 0,
                reachable: false,
                ok: false,
                transport: None,
                status_code: None,
                body: None,
                error: Some(format!("{socket_error}; http fallback: {http_error}")),
            },
        },
    }
}

fn fetch_unix_health(socket_path: &Path) -> io::Result<HealthStatus> {
    let mut stream = UnixStream::connect(socket_path)?;
    fetch_http_health(&mut stream, "localhost").map_err(io::Error::other)
}

fn fetch_tcp_health(config: &Config) -> io::Result<HealthStatus> {
    let addresses = (&config.broker_host[..], config.broker_port).to_socket_addrs()?;
    let started = Instant::now();
    let mut last_error = io::Error::new(
        io::ErrorKind::NotFound,
        "broker host resolved to no addresses",
    );
    for address in addresses {
        let remaining = Duration::from_secs(1)
            .checked_sub(started.elapsed())
            .filter(|remaining| !remaining.is_zero())
            .ok_or_else(|| {
                io::Error::new(io::ErrorKind::TimedOut, "health connect deadline exceeded")
            })?;
        match TcpStream::connect_timeout(&address, remaining) {
            Ok(mut stream) => {
                return fetch_http_health(&mut stream, &config.broker_host)
                    .map_err(io::Error::other)
            }
            Err(error) => last_error = error,
        }
    }
    Err(last_error)
}

trait HealthStream: Read + Write + AsRawFd {
    fn health_timeout(&self, timeout: Duration) -> io::Result<()>;
}
impl HealthStream for UnixStream {
    fn health_timeout(&self, timeout: Duration) -> io::Result<()> {
        self.set_read_timeout(Some(timeout))?;
        self.set_write_timeout(Some(timeout))
    }
}
impl HealthStream for TcpStream {
    fn health_timeout(&self, timeout: Duration) -> io::Result<()> {
        self.set_read_timeout(Some(timeout))?;
        self.set_write_timeout(Some(timeout))
    }
}

// A connection that accepted the probe is reachable. A response deadline miss
// does not prove readiness, and must not trigger a second probe or socket removal.
// Apply a total read budget, rather than resetting the full timeout per chunk.
fn fetch_http_health<T: HealthStream>(stream: &mut T, host: &str) -> Result<HealthStatus, String> {
    read_http_health(stream, host, Duration::from_secs(1))
}

fn read_http_health<T: HealthStream>(
    stream: &mut T,
    host: &str,
    budget: Duration,
) -> Result<HealthStatus, String> {
    let started = Instant::now();
    let mut response = Vec::new();
    let result = (|| -> io::Result<()> {
        stream.health_timeout(budget)?;
        stream.write_all(format!("GET /health HTTP/1.1\r\nHost: {host}\r\nAccept: application/json\r\nConnection: close\r\n\r\n").as_bytes())?;
        let mut chunk = [0; 8192];
        loop {
            let remaining = budget
                .checked_sub(started.elapsed())
                .filter(|remaining| !remaining.is_zero())
                .ok_or_else(|| {
                    io::Error::new(io::ErrorKind::TimedOut, "health response deadline exceeded")
                })?;
            let mut poll_fd = libc::pollfd {
                fd: stream.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            };
            let wait_ms = remaining
                .as_millis()
                .saturating_add(1)
                .min(i32::MAX as u128) as i32;
            let ready = unsafe { libc::poll(&mut poll_fd, 1, wait_ms) };
            if ready == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "health response deadline exceeded",
                ));
            }
            if ready < 0 {
                let error = io::Error::last_os_error();
                if error.kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                return Err(error);
            }
            let count = stream.read(&mut chunk)?;
            if count == 0 {
                return Ok(());
            }
            response.extend_from_slice(&chunk[..count]);
            if response.len() > 1024 * 1024 {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "health response exceeds 1 MiB",
                ));
            }
        }
    })();
    match result {
        Ok(()) => parse_health_response(&String::from_utf8_lossy(&response)),
        Err(error) => Ok(HealthStatus {
            state: if matches!(
                error.kind(),
                io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
            ) {
                "timed_out"
            } else {
                "degraded"
            },
            checked_at: epoch_ms(),
            duration_ms: started.elapsed().as_millis(),
            reachable: true,
            ok: false,
            transport: None,
            status_code: parse_http_status_code(&String::from_utf8_lossy(&response)),
            body: None,
            error: Some(format!(
                "broker connected but health was not confirmed: {error}"
            )),
        }),
    }
}

fn fetch_node_broker_url(config: &Config) -> Result<Option<String>, String> {
    match fetch_node_broker_url_unix(&config.broker_socket_path) {
        Ok(url) => Ok(url),
        Err(_) => fetch_node_broker_url_tcp(config),
    }
}

fn fetch_node_broker_url_unix(socket_path: &Path) -> Result<Option<String>, String> {
    let mut stream = UnixStream::connect(socket_path).map_err(|error| error.to_string())?;
    stream
        .set_read_timeout(Some(Duration::from_secs(1)))
        .map_err(|error| error.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(1)))
        .map_err(|error| error.to_string())?;
    fetch_node_broker_url_http(&mut stream, "localhost")
}

fn fetch_node_broker_url_tcp(config: &Config) -> Result<Option<String>, String> {
    let mut stream = TcpStream::connect((&config.broker_host[..], config.broker_port))
        .map_err(|error| error.to_string())?;
    stream
        .set_read_timeout(Some(Duration::from_secs(1)))
        .map_err(|error| error.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(1)))
        .map_err(|error| error.to_string())?;
    fetch_node_broker_url_http(&mut stream, &config.broker_host)
}

fn fetch_node_broker_url_http<T: Read + Write>(
    stream: &mut T,
    host: &str,
) -> Result<Option<String>, String> {
    let response = fetch_http_response(stream, host, "/v1/node", "application/json")?;
    match parse_http_status_code(&response) {
        Some(status) if (200..300).contains(&status) => {
            let body = response
                .split_once("\r\n\r\n")
                .map(|(_, body)| body)
                .unwrap_or_default();
            Ok(parse_json_string_field(body, "brokerUrl"))
        }
        Some(status) => Err(format!("broker node returned HTTP {status}")),
        None => Err("broker node response missing HTTP status".to_string()),
    }
}

fn health_response_body(response: &str) -> Result<String, String> {
    let (headers, body) = response
        .split_once("\r\n\r\n")
        .ok_or_else(|| "health response missing headers".to_string())?;
    let chunked = headers
        .lines()
        .filter_map(|line| line.split_once(':'))
        .any(|(key, value)| {
            key.eq_ignore_ascii_case("transfer-encoding")
                && value
                    .split(',')
                    .any(|encoding| encoding.trim().eq_ignore_ascii_case("chunked"))
        });
    if !chunked {
        if let Some(length) = headers
            .lines()
            .filter_map(|line| line.split_once(':'))
            .find_map(|(key, value)| {
                key.eq_ignore_ascii_case("content-length")
                    .then_some(value.trim())
            })
        {
            let length = length.parse::<usize>().map_err(|error| error.to_string())?;
            if body.len() != length {
                return Err("incomplete health response body".to_string());
            }
        }
        return Ok(body.to_string());
    }
    let mut remaining = body.as_bytes();
    let mut decoded = Vec::new();
    loop {
        let end = remaining
            .windows(2)
            .position(|pair| pair == b"\r\n")
            .ok_or_else(|| "incomplete health chunk header".to_string())?;
        let size_text =
            std::str::from_utf8(&remaining[..end]).map_err(|error| error.to_string())?;
        let size = usize::from_str_radix(size_text.split(';').next().unwrap_or("").trim(), 16)
            .map_err(|error| error.to_string())?;
        remaining = &remaining[end + 2..];
        if size == 0 {
            if !remaining.starts_with(b"\r\n") && !remaining.ends_with(b"\r\n\r\n") {
                return Err("incomplete health chunk trailer".to_string());
            }
            return String::from_utf8(decoded).map_err(|error| error.to_string());
        }
        if size > remaining.len().saturating_sub(2)
            || remaining.get(size..size + 2) != Some(b"\r\n")
        {
            return Err("incomplete health chunk".to_string());
        }
        decoded.extend_from_slice(&remaining[..size]);
        remaining = &remaining[size + 2..];
    }
}

fn parse_health_response(response: &str) -> Result<HealthStatus, String> {
    let status_code = parse_http_status_code(response);
    let decoded = health_response_body(response);
    let body = decoded.as_ref().cloned().unwrap_or_default();
    let ok = status_code == Some(200) && health_body_reports_ok(&body);
    Ok(HealthStatus {
        state: if ok { "healthy" } else { "degraded" },
        checked_at: epoch_ms(),
        duration_ms: 0,
        reachable: true,
        ok,
        transport: None,
        status_code,
        body: if body.is_empty() { None } else { Some(body) },
        error: if status_code.is_none() {
            Some("missing HTTP status".to_string())
        } else {
            decoded.err()
        },
    })
}

fn health_body_reports_ok(body: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|value| value.get("ok").and_then(serde_json::Value::as_bool))
        == Some(true)
}

fn doctor_report(config: &Config, options: DoctorOptions) -> DoctorReport {
    let status = broker_service_status(config);
    let processes = process_snapshot();
    let mut warnings = Vec::new();

    if !config.runtime_entrypoint().exists() {
        warnings.push(format!(
            "runtime entrypoint is missing: {}",
            config.runtime_entrypoint().display()
        ));
    }
    if !command_available(&config.bun_executable) {
        warnings.push(format!(
            "bun executable is not available: {}",
            config.bun_executable
        ));
    }
    if !status.health.ok {
        warnings.push(format!(
            "broker health {}: {}",
            status.health.state,
            status
                .health
                .error
                .as_deref()
                .unwrap_or("broker did not report ready")
        ));
    }
    if status.config.broker_socket_path.exists() && status.health.state == "unreachable" {
        warnings.push(format!(
            "broker socket exists but health is unreachable: {}",
            status.config.broker_socket_path.display(),
        ));
    }
    if status.launchctl.loaded && status.daemon_state.is_none() {
        warnings.push(format!(
            "launchd service is loaded but scoutd state is missing: {}",
            status.config.daemon_state_path.display(),
        ));
    }
    if let Some(raw_state) = status.daemon_state.as_deref() {
        warnings.extend(restart_telemetry_warnings(raw_state));
        if status.launchctl.loaded {
            warnings.extend(daemon_state_age_warning(raw_state, epoch_ms()));
        }
    }
    if matches!(
        status.runtime_freshness.state.as_str(),
        "stale" | "unverified"
    ) {
        warnings.push(format!(
            "runtime freshness {}: {}",
            status.runtime_freshness.state, status.runtime_freshness.detail,
        ));
    }
    if status.probes.socket_exists && !status.probes.reachable {
        warnings.push(format!(
            "probe server socket exists but capabilities are unreachable: {}",
            status.probes.socket_path,
        ));
    }

    let daemon_processes: Vec<&ProcessInfo> = processes
        .iter()
        .filter(|process| command_invokes_scoutd_daemon(&process.command))
        .collect();
    if daemon_processes.len() > 1 {
        warnings.push(format!(
            "multiple scoutd processes found: {}",
            daemon_processes.len()
        ));
    }
    for process in daemon_processes {
        if process.ppid == 1 && status.launchctl.pid != Some(process.pid) {
            warnings.push(format!("orphaned scoutd process: pid {}", process.pid));
        }
    }
    let broker_processes: Vec<&ProcessInfo> = processes
        .iter()
        .filter(|process| command_references_process(&process.command, "scout-broker"))
        .collect();
    if broker_processes.len() > 1 {
        warnings.push(format!(
            "multiple scout-broker processes found: {}",
            broker_processes.len()
        ));
    }
    for process in broker_processes {
        if process.ppid == 1 {
            warnings.push(format!(
                "orphaned scout-broker process: pid {}",
                process.pid
            ));
        }
    }
    for process in processes
        .iter()
        .filter(|process| command_references_process(&process.command, "scout-web"))
    {
        if process.ppid == 1 {
            warnings.push(format!("orphaned scout-web process: pid {}", process.pid));
        }
    }
    for pid in stale_pairing_advertisement_pids(&processes) {
        warnings.push(format!(
            "orphaned duplicate OpenScout pairing advertisement: pid {pid}"
        ));
    }

    let repairs = doctor_repairs(config, &status, options);

    DoctorReport {
        status,
        processes,
        warnings,
        repairs,
        fix_requested: options.fix,
        yes: options.yes,
    }
}

fn doctor_repairs(
    config: &Config,
    status: &ServiceStatus,
    options: DoctorOptions,
) -> Vec<DoctorRepair> {
    if !options.fix {
        return Vec::new();
    }

    let mut repairs = Vec::new();
    if status.config.broker_socket_path.exists() && status.health.state == "unreachable" {
        repairs.push(remove_file_repair(
            "stale-broker-socket",
            "Remove stale broker socket",
            &status.config.broker_socket_path,
            options,
        ));
    }

    for (id, title, path) in [
        (
            "stale-base-pid",
            "Remove stale base pid file",
            config.runtime_directory.join("base-fallback.pid"),
        ),
        (
            "stale-broker-pid",
            "Remove stale broker pid file",
            config.runtime_directory.join("broker-fallback.pid"),
        ),
    ] {
        if let Some(pid) = read_pid_file(&path) {
            if !pid_is_alive(pid) {
                repairs.push(remove_file_repair(id, title, &path, options));
            }
        }
    }

    repairs
}

fn read_pid_file(path: &Path) -> Option<u32> {
    let raw = fs::read_to_string(path).ok()?;
    raw.trim().parse::<u32>().ok()
}

fn pid_is_alive(pid: u32) -> bool {
    Command::new("/bin/kill")
        .arg("-0")
        .arg(pid.to_string())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn remove_file_repair(id: &str, title: &str, path: &Path, options: DoctorOptions) -> DoctorRepair {
    if !options.yes {
        return DoctorRepair {
            id: id.to_string(),
            title: title.to_string(),
            status: "skipped".to_string(),
            detail: Some(format!("Pass --yes to remove {}.", path.display())),
            changed: false,
        };
    }

    match fs::remove_file(path) {
        Ok(()) => DoctorRepair {
            id: id.to_string(),
            title: title.to_string(),
            status: "applied".to_string(),
            detail: Some(format!("Removed {}.", path.display())),
            changed: true,
        },
        Err(error) if error.kind() == io::ErrorKind::NotFound => DoctorRepair {
            id: id.to_string(),
            title: title.to_string(),
            status: "already-clean".to_string(),
            detail: Some(format!("Already absent: {}.", path.display())),
            changed: false,
        },
        Err(error) => DoctorRepair {
            id: id.to_string(),
            title: title.to_string(),
            status: "failed".to_string(),
            detail: Some(format!("Failed to remove {}: {error}.", path.display())),
            changed: false,
        },
    }
}

fn daemon_state_age_warning(raw_state: &str, now_ms: u128) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(raw_state).ok()?;
    let updated_at = value.get("updatedAtMs")?.as_u64()? as u128;
    let age = now_ms.saturating_sub(updated_at);
    if age > (STATE_WRITE_RETRY_MAX * 2).as_millis() {
        Some(format!("scoutd diagnostic state is stale ({}s old); persisted child and runtime metadata may be outdated; check current process and broker health separately", age / 1000))
    } else {
        None
    }
}

fn restart_telemetry_warnings(raw_state: &str) -> Vec<String> {
    let telemetry = parse_daemon_state_telemetry(raw_state);
    let mut warnings = Vec::new();
    let restart_count = telemetry.restart_count.unwrap_or(0);
    let last_child_exit = telemetry.last_child_exit_description.as_deref();

    if restart_count > 0 || last_child_exit.is_some() {
        let mut details = format!("scout-base restart telemetry: restartCount={restart_count}");
        if let Some(base_state) = telemetry.base_state.as_deref() {
            details.push_str(&format!(", baseState={base_state}"));
        }
        if let Some(backoff_ms) = telemetry.restart_backoff_ms {
            details.push_str(&format!(", restartBackoffMs={backoff_ms}"));
        }
        if let Some(description) = last_child_exit {
            details.push_str(&format!(", lastChildExit={description}"));
        }
        if let Some(code) = telemetry.last_child_exit_code {
            details.push_str(&format!(", exitCode={code}"));
        }
        if let Some(signal) = telemetry.last_child_exit_signal {
            details.push_str(&format!(", signal={signal}"));
        }
        warnings.push(details);
    }

    let probe_restart_count = telemetry.probe_restart_count.unwrap_or(0);
    let last_probe_child_exit = telemetry.last_probe_child_exit_description.as_deref();
    if probe_restart_count > 0 || last_probe_child_exit.is_some() {
        let mut details =
            format!("probe-server restart telemetry: restartCount={probe_restart_count}");
        if let Some(probe_state) = telemetry.probe_state.as_deref() {
            details.push_str(&format!(", probeState={probe_state}"));
        }
        if let Some(backoff_ms) = telemetry.probe_restart_backoff_ms {
            details.push_str(&format!(", restartBackoffMs={backoff_ms}"));
        }
        if let Some(description) = last_probe_child_exit {
            details.push_str(&format!(", lastChildExit={description}"));
        }
        if let Some(code) = telemetry.last_probe_child_exit_code {
            details.push_str(&format!(", exitCode={code}"));
        }
        if let Some(signal) = telemetry.last_probe_child_exit_signal {
            details.push_str(&format!(", signal={signal}"));
        }
        warnings.push(details);
    }

    warnings
}

fn parse_daemon_state_telemetry(raw_state: &str) -> DaemonStateTelemetry {
    let last_child_exit = json_field_object(raw_state, "lastChildExit");
    let last_probe_child_exit = json_field_object(raw_state, "lastProbeChildExit");
    DaemonStateTelemetry {
        base_state: parse_json_string_field(raw_state, "baseState"),
        restart_count: parse_json_u32_field(raw_state, "restartCount"),
        restart_backoff_ms: parse_json_u64_field(raw_state, "restartBackoffMs"),
        last_child_exit_description: last_child_exit
            .and_then(|value| parse_json_string_field(value, "description")),
        last_child_exit_code: last_child_exit.and_then(|value| parse_json_i32_field(value, "code")),
        last_child_exit_signal: last_child_exit
            .and_then(|value| parse_json_i32_field(value, "signal")),
        probe_state: parse_json_string_field(raw_state, "probeState"),
        probe_restart_count: parse_json_u32_field(raw_state, "probeRestartCount"),
        probe_restart_backoff_ms: parse_json_u64_field(raw_state, "probeRestartBackoffMs"),
        last_probe_child_exit_description: last_probe_child_exit
            .and_then(|value| parse_json_string_field(value, "description")),
        last_probe_child_exit_code: last_probe_child_exit
            .and_then(|value| parse_json_i32_field(value, "code")),
        last_probe_child_exit_signal: last_probe_child_exit
            .and_then(|value| parse_json_i32_field(value, "signal")),
    }
}

fn all_processes_snapshot() -> Vec<ProcessInfo> {
    let output = match run_command("ps", &["-axo", "pid=,ppid=,pcpu=,pmem=,etime=,command="]) {
        Ok(output) if output.status == 0 => output.stdout,
        _ => return Vec::new(),
    };

    output.lines().filter_map(parse_process_line).collect()
}

fn process_snapshot() -> Vec<ProcessInfo> {
    all_processes_snapshot()
        .into_iter()
        .filter(|process| process_snapshot_filter(&process.command))
        .collect()
}

fn process_snapshot_filter(command: &str) -> bool {
    command.contains("openscout-runtime")
        || command_references_process(command, DAEMON_NAME)
        // Legacy-name compatibility for the openscout-supervisor → scoutd rename.
        || command_references_process(command, LEGACY_DAEMON_NAME)
        || command_references_process(command, "scout-base")
        || command_references_process(command, "scout-broker")
        || command_references_process(command, "scout-web")
        || command_references_process(command, "ScoutMenu")
        || openscout_pairing_advertisement_key(command).is_some()
}

fn process_sweep_enabled() -> bool {
    !matches!(
        env::var("OPENSCOUT_PROCESS_SWEEP").ok().as_deref(),
        Some("0" | "false" | "off")
    )
}

fn process_lease_directory(config: &Config) -> PathBuf {
    config.runtime_directory.join("process-leases")
}

fn elapsed_seconds(value: &str) -> Option<u64> {
    let (days, clock) = match value.split_once('-') {
        Some((days, clock)) => (days.parse::<u64>().ok()?, clock),
        None => (0, value),
    };
    let fields = clock
        .split(':')
        .map(|field| field.parse::<u64>().ok())
        .collect::<Option<Vec<_>>>()?;
    let clock_seconds = match fields.as_slice() {
        [minutes, seconds] => minutes.saturating_mul(60).saturating_add(*seconds),
        [hours, minutes, seconds] => hours
            .saturating_mul(60 * 60)
            .saturating_add(minutes.saturating_mul(60))
            .saturating_add(*seconds),
        _ => return None,
    };
    Some(
        days.saturating_mul(24 * 60 * 60)
            .saturating_add(clock_seconds),
    )
}

fn openscout_pairing_advertisement_key(command: &str) -> Option<String> {
    if !command_references_process(command, "dns-sd") {
        return None;
    }
    let parts = command.split_whitespace().collect::<Vec<_>>();
    let register_index = parts.iter().position(|part| *part == "-R")?;
    if parts.get(register_index + 1).copied() != Some("OpenScout") {
        return None;
    }
    let fingerprint = parts.get(register_index + 2)?;
    let service_index = parts.iter().position(|part| *part == "_oscout-pair._tcp")?;
    let port = parts.get(service_index + 2)?.trim_end_matches('.');
    if fingerprint.is_empty() || port.parse::<u16>().is_err() {
        return None;
    }
    Some(format!("{fingerprint}:{port}"))
}

fn stale_pairing_advertisement_pids(processes: &[ProcessInfo]) -> Vec<u32> {
    let live_keys = processes
        .iter()
        .filter(|process| process.ppid != 1)
        .filter_map(|process| openscout_pairing_advertisement_key(&process.command))
        .collect::<HashSet<_>>();
    processes
        .iter()
        .filter(|process| process.ppid == 1)
        .filter(|process| {
            elapsed_seconds(&process.elapsed).unwrap_or(0) >= ORPHAN_ADVERTISEMENT_GRACE.as_secs()
        })
        .filter_map(|process| {
            let key = openscout_pairing_advertisement_key(&process.command)?;
            live_keys.contains(&key).then_some(process.pid)
        })
        .collect()
}

fn process_command_and_group(pid: u32) -> Option<(u32, String)> {
    let output = run_command("ps", &["-p", &pid.to_string(), "-o", "pgid=,command="]).ok()?;
    if output.status != 0 {
        return None;
    }
    let mut fields = output.stdout.trim().split_whitespace();
    let pgid = fields.next()?.parse::<u32>().ok()?;
    let command = fields.collect::<Vec<_>>().join(" ");
    Some((pgid, command))
}

fn safe_capture_profile(path: &Path) -> bool {
    path.parent() == Some(env::temp_dir().as_path())
        && path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("openscout-web-capture-"))
}

fn lease_matches_process(lease: &ManagedProcessLease, pgid: u32, command: &str) -> bool {
    lease.version == 1
        && lease.kind == "web_capture"
        && lease.process_group_id == pgid
        && safe_capture_profile(&lease.profile_dir)
        && command.contains("--headless")
        && command.contains("--screenshot=")
        && command.contains(&format!("--user-data-dir={}", lease.profile_dir.display()))
}

fn send_process_group_signal(pgid: u32, signal_name: &str) -> Result<(), String> {
    if pgid <= 1 {
        return Err(format!("refusing to signal unsafe process group {pgid}"));
    }
    let status = Command::new("/bin/kill")
        .arg(format!("-{signal_name}"))
        .arg(format!("-{pgid}"))
        .status()
        .map_err(|error| error.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("kill -{signal_name} -{pgid} exited with {status}"))
    }
}

fn cleanup_capture_profile(path: &Path) {
    if !safe_capture_profile(path) {
        return;
    }
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            let _ = fs::remove_file(path);
        }
        Ok(metadata) if metadata.is_dir() => {
            let _ = fs::remove_dir_all(path);
        }
        _ => {}
    }
}

fn sweep_expired_process_leases(config: &Config) -> Result<ProcessSweepResult, String> {
    let lease_directory = process_lease_directory(config);
    let entries = match fs::read_dir(&lease_directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(ProcessSweepResult::default())
        }
        Err(error) => return Err(format!("read {}: {error}", lease_directory.display())),
    };
    let now = epoch_ms();
    let mut result = ProcessSweepResult::default();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.file_type().is_file() => metadata,
            _ => continue,
        };
        if metadata.file_type().is_symlink() {
            continue;
        }
        let lease = fs::read_to_string(&path)
            .ok()
            .and_then(|body| serde_json::from_str::<ManagedProcessLease>(&body).ok());
        let Some(lease) = lease else {
            let _ = fs::remove_file(&path);
            continue;
        };
        if lease.expires_at_ms > now {
            continue;
        }
        result.expired_leases += 1;
        if let Some((pgid, command)) = process_command_and_group(lease.pid) {
            if lease_matches_process(&lease, pgid, &command) {
                let _ = send_process_group_signal(pgid, "TERM");
                let deadline = Instant::now() + Duration::from_millis(500);
                while Instant::now() < deadline && pid_is_alive(lease.pid) {
                    thread::sleep(Duration::from_millis(50));
                }
                if pid_is_alive(lease.pid) {
                    let _ = send_process_group_signal(pgid, "KILL");
                }
                result.terminated_process_groups += 1;
            }
        }
        cleanup_capture_profile(&lease.profile_dir);
        let _ = fs::remove_file(&path);
    }
    Ok(result)
}

fn sweep_stale_managed_processes(config: &Config) -> Result<ProcessSweepResult, String> {
    let mut result = sweep_expired_process_leases(config)?;
    let processes = all_processes_snapshot();
    for pid in stale_pairing_advertisement_pids(&processes) {
        if send_process_signal(pid, "TERM").is_ok() {
            result.orphaned_pairing_advertisements += 1;
        }
    }
    Ok(result)
}

fn legacy_service_labels(config: &Config) -> Vec<String> {
    match config.service_mode.as_str() {
        "custom" => vec![
            "com.openscout.custom".to_string(),
            "com.openscout.broker.custom".to_string(),
        ],
        _ => vec![
            "dev.openscout".to_string(),
            "com.openscout".to_string(),
            "dev.openscout.broker".to_string(),
            "dev.openscout.broker-fallback".to_string(),
            "com.openscout.broker".to_string(),
        ],
    }
}

fn legacy_service_targets(config: &Config) -> Vec<String> {
    legacy_service_labels(config)
        .into_iter()
        .map(|label| format!("{}/{}", config.domain_target, label))
        .collect()
}

fn legacy_launch_agent_paths(config: &Config) -> Vec<PathBuf> {
    let home = match home_dir() {
        Ok(home) => home,
        Err(_) => return Vec::new(),
    };
    legacy_service_labels(config)
        .into_iter()
        .map(|label| home.join(format!("Library/LaunchAgents/{label}.plist")))
        .collect()
}

fn bootout_legacy_service(config: &Config) {
    for legacy_target in legacy_service_targets(config) {
        if legacy_target != config.service_target {
            let _ = run_command("/bin/launchctl", &["bootout", &legacy_target]);
        }
    }
    // The legacy plist has RunAtLoad=true, so leaving it on disk lets launchd
    // re-bootstrap the old service at every login. Remove it best-effort,
    // consistent with the bootout above.
    for legacy_path in legacy_launch_agent_paths(config) {
        if legacy_path != config.launch_agent_path && legacy_path.exists() {
            if let Err(error) = fs::remove_file(&legacy_path) {
                eprintln!(
                    "[scoutd] failed to remove legacy launch agent {}: {error}",
                    legacy_path.display()
                );
            }
        }
    }
}

fn command_references_process(command: &str, process_name: &str) -> bool {
    command
        .split_whitespace()
        .any(|part| part == process_name || part.rsplit('/').next() == Some(process_name))
}

fn command_invokes_scoutd_daemon(command: &str) -> bool {
    let mut parts = command.split_whitespace();
    while let Some(part) = parts.next() {
        let name = part.rsplit('/').next().unwrap_or(part);
        // Legacy-name compatibility for the openscout-supervisor → scoutd rename:
        // a pre-rename `openscout-supervisor supervise` orphan still counts as a
        // daemon process so doctor's duplicate/orphan warnings include it.
        if name == DAEMON_NAME || name == LEGACY_DAEMON_NAME {
            return matches!(parts.next(), Some("supervise"));
        }
    }
    false
}

fn parse_process_line(line: &str) -> Option<ProcessInfo> {
    let mut parts = line.split_whitespace();
    let pid = parts.next()?.parse::<u32>().ok()?;
    let ppid = parts.next()?.parse::<u32>().ok()?;
    let pcpu = parts.next()?.to_string();
    let pmem = parts.next()?.to_string();
    let elapsed = parts.next()?.to_string();
    let command = parts.collect::<Vec<_>>().join(" ");
    Some(ProcessInfo {
        pid,
        ppid,
        pcpu,
        pmem,
        elapsed,
        command,
    })
}

fn ensure_launch_agent(config: &Config) -> Result<(), String> {
    ensure_daemon_directories(config)?;
    let plist = render_launch_agent_plist(config);
    if let Ok(existing) = fs::read_to_string(&config.launch_agent_path) {
        if existing == plist {
            return Ok(());
        }
        assert_launch_agent_owner_compatible(config, &existing)?;
    }
    fs::write(&config.launch_agent_path, plist).map_err(|error| error.to_string())?;
    Ok(())
}

fn assert_launch_agent_owner_compatible(
    config: &Config,
    existing_plist: &str,
) -> Result<(), String> {
    launch_agent_owner_compatible(
        config,
        existing_plist,
        env_truthy(ALLOW_SHARED_SERVICE_REPOINT_ENV),
    )
}

fn launch_agent_owner_compatible(
    config: &Config,
    existing_plist: &str,
    allow_shared_service_repoint: bool,
) -> Result<(), String> {
    if config.label != SHARED_SERVICE_LABEL || allow_shared_service_repoint {
        return Ok(());
    }

    let existing_runtime = plist_string_value(existing_plist, "OPENSCOUT_RUNTIME_PACKAGE_DIR");
    if existing_runtime
        .as_deref()
        .is_some_and(|path| paths_equivalent(Path::new(path), &config.runtime_package_dir))
    {
        return Ok(());
    }

    // Very old managed plists did not carry OPENSCOUT_RUNTIME_PACKAGE_DIR.
    // Preserve their owner when the daemon path still identifies this exact
    // installation, while failing closed for unknown or foreign plists.
    let existing_daemon = plist_program_argument(existing_plist, 0);
    if existing_runtime.is_none()
        && existing_daemon
            .as_deref()
            .is_some_and(|path| paths_equivalent(Path::new(path), &config.daemon_executable))
    {
        return Ok(());
    }

    let current_owner = existing_runtime
        .or(existing_daemon)
        .unwrap_or_else(|| "unknown owner".to_string());
    Err(format!(
        "refusing to repoint shared Scout service {label} from {current_owner} to {candidate}. \
The machine-wide service must have one stable owner. Run a checkout or worktree as its own \
instance instead (OPENSCOUT_INSTANCE=dev, or dev-<name>): it derives an isolated service label, \
homes and port set. For an intentional one-time ownership transfer, rerun with {override_key}=1.",
        label = config.label,
        candidate = config.runtime_package_dir.display(),
        override_key = ALLOW_SHARED_SERVICE_REPOINT_ENV,
    ))
}

fn env_truthy(key: &str) -> bool {
    matches!(
        env::var(key)
            .ok()
            .as_deref()
            .map(str::trim)
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("1" | "true" | "yes" | "on")
    )
}

fn paths_equivalent(left: &Path, right: &Path) -> bool {
    match (fs::canonicalize(left), fs::canonicalize(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => left == right,
    }
}

fn plist_string_value(plist: &str, key: &str) -> Option<String> {
    let key_marker = format!("<key>{}</key>", xml_escape(key));
    let after_key = plist.split_once(&key_marker)?.1;
    let after_open = after_key.split_once("<string>")?.1;
    let value = after_open.split_once("</string>")?.0;
    Some(xml_unescape(value.trim()))
}

fn plist_program_argument(plist: &str, index: usize) -> Option<String> {
    let arguments = plist.split_once("<key>ProgramArguments</key>")?.1;
    let array = arguments.split_once("<array>")?.1.split_once("</array>")?.0;
    let mut values = Vec::new();
    let mut remaining = array;
    while let Some((_, after_open)) = remaining.split_once("<string>") {
        let (value, after_close) = after_open.split_once("</string>")?;
        values.push(xml_unescape(value.trim()));
        remaining = after_close;
    }
    values.into_iter().nth(index)
}

fn xml_unescape(value: &str) -> String {
    value
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

fn ensure_daemon_directories(config: &Config) -> Result<(), String> {
    fs::create_dir_all(&config.support_directory).map_err(|error| error.to_string())?;
    fs::create_dir_all(&config.runtime_directory).map_err(|error| error.to_string())?;
    fs::create_dir_all(&config.logs_directory).map_err(|error| error.to_string())?;
    fs::create_dir_all(&config.probe_logs_directory).map_err(|error| error.to_string())?;
    fs::create_dir_all(&config.open_scout_home).map_err(|error| error.to_string())?;
    fs::create_dir_all(&config.control_home).map_err(|error| error.to_string())?;
    if let Some(parent) = config.launch_agent_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn render_launch_agent_plist(config: &Config) -> String {
    render_launch_agent_plist_with_optional_env(config, env_nonempty)
}

fn render_launch_agent_plist_with_optional_env(
    config: &Config,
    optional_env: impl Fn(&str) -> Option<String>,
) -> String {
    let mut env_entries = vec![
        ("OPENSCOUT_BROKER_PORT", config.broker_port.to_string()),
        (
            "OPENSCOUT_BROKER_SOCKET_PATH",
            config.broker_socket_path.to_string_lossy().to_string(),
        ),
        (
            "OPENSCOUT_SUPPORT_DIRECTORY",
            config.support_directory.to_string_lossy().to_string(),
        ),
        (
            "OPENSCOUT_RUNTIME_PACKAGE_DIR",
            config.runtime_package_dir.to_string_lossy().to_string(),
        ),
        (
            "OPENSCOUT_CONTROL_HOME",
            config.control_home.to_string_lossy().to_string(),
        ),
        (
            "OPENSCOUT_HOME",
            config.open_scout_home.to_string_lossy().to_string(),
        ),
        (
            "OPENSCOUT_PROBES_SOCKET",
            config.probes_socket_path.to_string_lossy().to_string(),
        ),
        ("OPENSCOUT_BROKER_HOST", config.broker_host.clone()),
        ("OPENSCOUT_BROKER_URL", config.broker_url.clone()),
        ("OPENSCOUT_ADVERTISE_SCOPE", config.advertise_scope.clone()),
        ("OPENSCOUT_BROKER_SERVICE_MODE", config.service_mode.clone()),
        ("OPENSCOUT_BROKER_SERVICE_LABEL", config.label.clone()),
        ("OPENSCOUT_SERVICE_LABEL", config.label.clone()),
        ("OPENSCOUT_INSTANCE", launch_instance(&optional_env)),
        (
            "HOME",
            home_dir()
                .map(|path| path.to_string_lossy().to_string())
                .unwrap_or_default(),
        ),
        ("PATH", launch_agent_path_env()),
    ];
    for &key in OPTIONAL_LAUNCH_ENV_KEYS {
        if let Some(value) = optional_env(key) {
            env_entries.push((key, value));
        }
    }
    if let Some(core_agents) = optional_env("OPENSCOUT_CORE_AGENTS") {
        env_entries.push(("OPENSCOUT_CORE_AGENTS", core_agents));
    }
    let env_block = env_entries
        .into_iter()
        .map(|(key, value)| {
            format!(
                "\n    <key>{}</key>\n    <string>{}</string>",
                xml_escape(key),
                xml_escape(&value),
            )
        })
        .collect::<String>();

    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{daemon}</string>
    <string>supervise</string>
  </array>
  <key>WorkingDirectory</key>
  <string>{cwd}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>ExitTimeOut</key>
  <integer>{exit_timeout}</integer>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>{stdout}</string>
  <key>StandardErrorPath</key>
  <string>{stderr}</string>
  <key>EnvironmentVariables</key>
  <dict>{env_block}
  </dict>
</dict>
</plist>
"#,
        label = xml_escape(&config.label),
        daemon = xml_escape(&config.daemon_executable.to_string_lossy()),
        cwd = xml_escape(&config.runtime_package_dir.to_string_lossy()),
        exit_timeout = LAUNCHD_EXIT_TIMEOUT_SECONDS,
        stdout = xml_escape(&config.stdout_log_path.to_string_lossy()),
        stderr = xml_escape(&config.stderr_log_path.to_string_lossy()),
    )
}

fn read_daemon_state_json(config: &Config) -> Option<String> {
    let raw = fs::read_to_string(&config.daemon_state_path).ok()?;
    let trimmed = raw.trim();
    if trimmed.starts_with('{') && trimmed.ends_with('}') {
        Some(trimmed.to_string())
    } else {
        None
    }
}

fn read_host_info_json(config: &Config) -> Option<String> {
    let raw = fs::read_to_string(&config.host_info_path).ok()?;
    let trimmed = raw.trim();
    if trimmed.starts_with('{') && trimmed.ends_with('}') {
        Some(trimmed.to_string())
    } else {
        None
    }
}

fn write_daemon_state(
    config: &Config,
    runtime_build: &RuntimeArtifactIdentity,
    started_at_ms: u128,
    base_pid: Option<u32>,
    base_state: &str,
    restart_count: u32,
    restart_backoff: Option<Duration>,
    last_child_exit: Option<&ChildExitTelemetry>,
    probe_pid: Option<u32>,
    probe_state: &str,
    probe_restart_count: u32,
    probe_restart_backoff: Option<Duration>,
    last_probe_child_exit: Option<&ChildExitTelemetry>,
) -> Result<(), String> {
    fs::create_dir_all(&config.runtime_directory).map_err(|error| error.to_string())?;
    let payload = format!(
        "{{\
\"schemaVersion\":1,\
\"daemon\":\"scoutd\",\
\"version\":{},\
\"gitSha\":{},\
\"runtimeBuild\":{},\
\"scoutdPid\":{},\
\"startedAtMs\":{},\
\"basePid\":{},\
\"baseState\":{},\
\"restartCount\":{},\
\"restartBackoffMs\":{},\
\"lastChildExit\":{},\
\"probePid\":{},\
\"probeState\":{},\
\"probeRestartCount\":{},\
\"probeRestartBackoffMs\":{},\
\"lastProbeChildExit\":{},\
\"probeSocketPath\":{},\
\"updatedAtMs\":{}\
}}\n",
        json_string(BUILD_VERSION),
        json_opt_str(build_git_sha()),
        serde_json::to_string(runtime_build).unwrap_or_else(|_| "null".to_string()),
        std::process::id(),
        started_at_ms,
        json_opt_u32(base_pid),
        json_string(base_state),
        restart_count,
        json_opt_u64(restart_backoff.map(duration_millis)),
        child_exit_json(last_child_exit),
        json_opt_u32(probe_pid),
        json_string(probe_state),
        probe_restart_count,
        json_opt_u64(probe_restart_backoff.map(duration_millis)),
        child_exit_json(last_probe_child_exit),
        json_string(&config.probes_socket_path.to_string_lossy()),
        epoch_ms(),
    );
    write_daemon_state_payload(&config.daemon_state_path, payload.as_bytes())
}

fn write_daemon_state_payload(path: &Path, payload: &[u8]) -> Result<(), String> {
    let temporary_path = path.with_extension("json.tmp");
    fs::write(&temporary_path, payload)
        .map_err(|error| format!("write {}: {error}", temporary_path.display()))?;
    fs::rename(&temporary_path, path).map_err(|error| {
        format!(
            "rename {} to {}: {error}",
            temporary_path.display(),
            path.display()
        )
    })
}

fn child_exit_json(value: Option<&ChildExitTelemetry>) -> String {
    match value {
        Some(exit) => format!(
            "{{\"atMs\":{},\"code\":{},\"signal\":{},\"description\":{}}}",
            exit.at_ms,
            json_opt_i32(exit.code),
            json_opt_i32(exit.signal),
            json_string(&exit.description),
        ),
        None => "null".to_string(),
    }
}

fn duration_millis(duration: Duration) -> u64 {
    duration.as_millis().min(u128::from(u64::MAX)) as u64
}

fn epoch_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

#[derive(Debug)]
struct CommandOutput {
    status: i32,
    stdout: String,
    stderr: String,
}

fn run_command(command: &str, args: &[&str]) -> Result<CommandOutput, String> {
    let output = Command::new(command)
        .args(args)
        .output()
        .map_err(|error| format!("{command}: {error}"))?;
    Ok(CommandOutput {
        status: output.status.code().unwrap_or(1),
        stdout: String::from_utf8_lossy(&output.stdout).trim().to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
    })
}

fn run_command_checked(command: &str, args: &[&str]) -> Result<CommandOutput, String> {
    let output = run_command(command, args)?;
    if output.status == 0 {
        Ok(output)
    } else {
        Err(first_nonempty(&output.stderr, &output.stdout))
    }
}

fn parse_launchctl_u32(raw: &str, prefix: &str) -> Option<u32> {
    parse_launchctl_string(raw, prefix).and_then(|value| value.parse::<u32>().ok())
}

fn parse_launchctl_i32(raw: &str, prefix: &str) -> Option<i32> {
    parse_launchctl_string(raw, prefix).and_then(|value| value.parse::<i32>().ok())
}

fn parse_launchctl_string(raw: &str, prefix: &str) -> Option<String> {
    raw.lines().map(str::trim).find_map(|line| {
        line.strip_prefix(prefix)
            .map(|value| value.trim().to_string())
    })
}

fn parse_json_u32_field(raw: &str, key: &str) -> Option<u32> {
    parse_json_unsigned_field(raw, key).and_then(|value| u32::try_from(value).ok())
}

fn parse_json_u64_field(raw: &str, key: &str) -> Option<u64> {
    parse_json_unsigned_field(raw, key)
}

fn parse_json_unsigned_field(raw: &str, key: &str) -> Option<u64> {
    let after_colon = json_field_after_colon(raw, key)?;
    let digits = after_colon
        .trim_start()
        .chars()
        .take_while(|character| character.is_ascii_digit())
        .collect::<String>();
    if digits.is_empty() {
        None
    } else {
        digits.parse::<u64>().ok()
    }
}

fn parse_json_i32_field(raw: &str, key: &str) -> Option<i32> {
    let after_colon = json_field_after_colon(raw, key)?;
    let value = after_colon.trim_start();
    let mut chars = value.chars();
    let mut number = String::new();
    if matches!(chars.clone().next(), Some('-')) {
        number.push('-');
        chars.next();
    }
    number.extend(chars.take_while(|character| character.is_ascii_digit()));
    if number.is_empty() || number == "-" {
        None
    } else {
        number.parse::<i32>().ok()
    }
}

fn parse_json_bool_field(raw: &str, key: &str) -> Option<bool> {
    let after_colon = json_field_after_colon(raw, key)?;
    let value = after_colon.trim_start();
    if value.starts_with("true") {
        Some(true)
    } else if value.starts_with("false") {
        Some(false)
    } else {
        None
    }
}

fn parse_json_string_field(raw: &str, key: &str) -> Option<String> {
    let after_colon = json_field_after_colon(raw, key)?;
    parse_json_string_value(after_colon.trim_start())
}

fn json_field_after_colon<'a>(raw: &'a str, key: &str) -> Option<&'a str> {
    let needle = format!("\"{}\"", json_escape(key));
    let (_, after_key) = raw.split_once(&needle)?;
    let (_, after_colon) = after_key.split_once(':')?;
    Some(after_colon)
}

fn json_field_object<'a>(raw: &'a str, key: &str) -> Option<&'a str> {
    let after_colon = json_field_after_colon(raw, key)?;
    let trimmed = after_colon.trim_start();
    if !trimmed.starts_with('{') {
        return None;
    }
    let mut depth = 0_i32;
    let mut in_string = false;
    let mut escaped = false;
    for (index, character) in trimmed.char_indices() {
        if in_string {
            if escaped {
                escaped = false;
            } else if character == '\\' {
                escaped = true;
            } else if character == '"' {
                in_string = false;
            }
            continue;
        }
        match character {
            '"' => in_string = true,
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(&trimmed[..=index]);
                }
            }
            _ => {}
        }
    }
    None
}

fn parse_json_string_value(raw: &str) -> Option<String> {
    let mut chars = raw.chars();
    if chars.next()? != '"' {
        return None;
    }
    let mut parsed = String::new();
    while let Some(character) = chars.next() {
        match character {
            '"' => return Some(parsed),
            '\\' => match chars.next()? {
                '"' => parsed.push('"'),
                '\\' => parsed.push('\\'),
                '/' => parsed.push('/'),
                'b' => parsed.push('\u{0008}'),
                'f' => parsed.push('\u{000c}'),
                'n' => parsed.push('\n'),
                'r' => parsed.push('\r'),
                't' => parsed.push('\t'),
                'u' => {
                    let mut hex = String::new();
                    for _ in 0..4 {
                        hex.push(chars.next()?);
                    }
                    let value = u32::from_str_radix(&hex, 16).ok()?;
                    parsed.push(char::from_u32(value)?);
                }
                escaped => parsed.push(escaped),
            },
            value => parsed.push(value),
        }
    }
    None
}

fn command_available(command: &str) -> bool {
    if command.contains('/') {
        Path::new(command).exists()
    } else {
        run_command("which", &[command])
            .map(|output| output.status == 0)
            .unwrap_or(false)
    }
}

fn env_nonempty(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn push_relay_child_environment() -> Vec<(&'static str, String)> {
    resolve_push_relay_child_environment(
        env_nonempty("OPENSCOUT_PUSH_RELAY_URL"),
        env_nonempty("OPENSCOUT_PUSH_RELAY_SESSION"),
        env_nonempty("OPENSCOUT_PUSH_RELAY_MESH_ID"),
        macos_open_scout_network_session(),
    )
}

fn resolve_push_relay_child_environment(
    explicit_url: Option<String>,
    explicit_session: Option<String>,
    explicit_mesh_id: Option<String>,
    keychain_session: Option<String>,
) -> Vec<(&'static str, String)> {
    let Some(session) = explicit_session.or(keychain_session) else {
        return Vec::new();
    };

    let mut environment = vec![
        (
            "OPENSCOUT_PUSH_RELAY_URL",
            explicit_url.unwrap_or_else(|| DEFAULT_OPENSCOUT_PUSH_RELAY_URL.to_string()),
        ),
        ("OPENSCOUT_PUSH_RELAY_SESSION", session),
    ];
    if let Some(mesh_id) = explicit_mesh_id {
        environment.push(("OPENSCOUT_PUSH_RELAY_MESH_ID", mesh_id));
    }
    environment
}

#[cfg(target_os = "macos")]
fn macos_open_scout_network_session() -> Option<String> {
    let output = Command::new("/usr/bin/security")
        .args([
            "find-generic-password",
            "-s",
            "net.oscout.session",
            "-a",
            "session",
            "-w",
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8(output.stdout)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

#[cfg(not(target_os = "macos"))]
fn macos_open_scout_network_session() -> Option<String> {
    None
}

fn open_scout_network_discovery_enabled(support_directory: &Path) -> bool {
    if let Some(value) = bool_env("OPENSCOUT_NETWORK_DISCOVERY_ENABLED")
        .or_else(|| bool_env("OPENSCOUT_OSN_DISCOVERY_ENABLED"))
    {
        return value;
    }

    let settings_path = support_directory.join("settings.json");
    let Ok(raw) = fs::read_to_string(settings_path) else {
        return false;
    };
    let Some((_, network_settings)) = raw.split_once("\"openScoutNetwork\"") else {
        return false;
    };
    parse_json_bool_field(network_settings, "discoveryEnabled").unwrap_or(false)
}

fn bool_env(name: &str) -> Option<bool> {
    match env_nonempty(name)?.to_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

fn resolve_advertise_scope_value(
    open_scout_network_enabled: bool,
    explicit_scope: Option<String>,
) -> String {
    if open_scout_network_enabled {
        return "mesh".to_string();
    }
    match explicit_scope
        .unwrap_or_default()
        .trim()
        .to_lowercase()
        .as_str()
    {
        "mesh" => "mesh".to_string(),
        _ => "local".to_string(),
    }
}

fn resolve_broker_host_value(advertise_scope: &str, explicit_host: Option<String>) -> String {
    let explicit = explicit_host.unwrap_or_default().trim().to_string();
    if !explicit.is_empty() {
        if advertise_scope == "mesh" && is_loopback_host(&explicit) {
            return DEFAULT_BROKER_HOST_MESH.to_string();
        }
        return explicit;
    }
    if advertise_scope == "mesh" {
        DEFAULT_BROKER_HOST_MESH.to_string()
    } else {
        DEFAULT_BROKER_HOST.to_string()
    }
}

fn resolve_broker_url_value(
    advertise_scope: &str,
    broker_host: &str,
    broker_port: u16,
    explicit_url: Option<String>,
) -> String {
    let explicit = explicit_url.unwrap_or_default().trim().to_string();
    if !explicit.is_empty() && !(advertise_scope == "mesh" && broker_url_is_loopback(&explicit)) {
        return explicit;
    }
    format!("http://{broker_host}:{broker_port}")
}

fn broker_url_is_loopback(value: &str) -> bool {
    let Some(after_scheme) = value.split_once("://").map(|(_, rest)| rest) else {
        return false;
    };
    let host_port = after_scheme
        .split_once('/')
        .map(|(host, _)| host)
        .unwrap_or(after_scheme);
    let host = host_port
        .trim_start_matches('[')
        .split_once(']')
        .map(|(host, _)| host)
        .or_else(|| host_port.split_once(':').map(|(host, _)| host))
        .unwrap_or(host_port);
    is_loopback_host(host)
}

fn is_loopback_host(value: &str) -> bool {
    matches!(
        value.trim().to_lowercase().as_str(),
        "127.0.0.1" | "::1" | "localhost"
    )
}

fn repo_watch_interval_from_env() -> Option<Duration> {
    let Some(raw) = env_nonempty("OPENSCOUT_REPO_WATCH_INTERVAL_MS") else {
        return Some(DEFAULT_REPO_WATCH_INTERVAL);
    };
    match raw.parse::<i64>() {
        Ok(value) if value <= 0 => None,
        Ok(value) => Some(Duration::from_millis(value as u64)),
        Err(_) => Some(DEFAULT_REPO_WATCH_INTERVAL),
    }
}

fn is_tmp_path(path: &Path) -> bool {
    let value = path.to_string_lossy();
    value == "/tmp"
        || value == "/private/tmp"
        || value.starts_with("/tmp/")
        || value.starts_with("/private/tmp/")
}

fn non_tmp_path_or_default(value: Option<PathBuf>, fallback: PathBuf) -> PathBuf {
    match value {
        Some(path) if !is_tmp_path(&path) => path,
        _ => fallback,
    }
}

fn launch_agent_path_env() -> String {
    let mut entries = Vec::new();
    if let Ok(home) = home_dir() {
        entries.push(home.join(".bun/bin").to_string_lossy().to_string());
    }
    entries.extend(
        env::var("PATH")
            .unwrap_or_default()
            .split(':')
            .map(str::to_string),
    );
    entries.extend([
        "/opt/homebrew/bin".to_string(),
        "/usr/local/bin".to_string(),
        "/usr/bin".to_string(),
        "/bin".to_string(),
        "/usr/sbin".to_string(),
        "/sbin".to_string(),
    ]);

    let mut seen = HashSet::new();
    entries
        .into_iter()
        .filter(|entry| !entry.is_empty() && !is_tmp_path(Path::new(entry)))
        .filter(|entry| seen.insert(entry.clone()))
        .collect::<Vec<_>>()
        .join(":")
}

fn home_dir() -> Result<PathBuf, String> {
    env_nonempty("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "HOME is not set".to_string())
}

fn user_id() -> Result<u32, String> {
    if let Some(uid) = env_nonempty("UID").and_then(|value| value.parse::<u32>().ok()) {
        return Ok(uid);
    }
    let output = run_command_checked("id", &["-u"])?;
    output
        .stdout
        .parse::<u32>()
        .map_err(|error| error.to_string())
}

fn find_workspace_runtime_dir(start: &Path) -> Option<PathBuf> {
    let mut current = start.to_path_buf();
    loop {
        let candidate = current.join("packages/runtime");
        if candidate.join("package.json").exists()
            && candidate.join("bin/openscout-runtime.mjs").exists()
        {
            return Some(candidate);
        }
        if !current.pop() {
            return None;
        }
    }
}

fn find_runtime_workspace_root(start: &Path) -> Option<PathBuf> {
    let mut current = start.to_path_buf();
    loop {
        if current.join(".git").exists()
            && current.join("packages/runtime/package.json").exists()
            && current.join("packages/cli/package.json").exists()
        {
            return Some(current);
        }
        if !current.pop() {
            return None;
        }
    }
}

fn git_value(repo_root: &Path, args: &[&str]) -> Option<String> {
    let git = env_nonempty("OPENSCOUT_GIT_BIN").unwrap_or_else(|| "git".to_string());
    let mut command_args = vec!["-C", repo_root.to_str()?];
    command_args.extend_from_slice(args);
    let output = run_command(&git, &command_args).ok()?;
    if output.status != 0 || output.stdout.trim().is_empty() {
        None
    } else {
        Some(output.stdout.trim().to_string())
    }
}

fn git_dirty(repo_root: &Path) -> Option<bool> {
    let git = env_nonempty("OPENSCOUT_GIT_BIN").unwrap_or_else(|| "git".to_string());
    let output = run_command(
        &git,
        &[
            "-C",
            repo_root.to_str()?,
            "status",
            "--porcelain",
            "--untracked-files=normal",
        ],
    )
    .ok()?;
    (output.status == 0).then(|| !output.stdout.trim().is_empty())
}

fn runtime_manifest_candidates(config: &Config) -> Vec<PathBuf> {
    let mut candidates = vec![config.runtime_package_dir.join("dist/build-manifest.json")];
    if let Some(root) = find_runtime_workspace_root(&config.runtime_package_dir) {
        candidates.push(root.join("packages/cli/dist/build-manifest.json"));
    }
    candidates
}

fn read_runtime_build_manifest(config: &Config) -> Option<(PathBuf, RuntimeBuildManifest)> {
    for path in runtime_manifest_candidates(config) {
        let Ok(raw) = fs::read_to_string(&path) else {
            continue;
        };
        if let Ok(manifest) = serde_json::from_str::<RuntimeBuildManifest>(&raw) {
            return Some((path, manifest));
        }
    }
    None
}

fn runtime_package_version(config: &Config) -> Option<String> {
    let raw = fs::read_to_string(config.runtime_package_dir.join("package.json")).ok()?;
    let value = serde_json::from_str::<serde_json::Value>(&raw).ok()?;
    value.get("version")?.as_str().map(str::to_string)
}

fn configured_runtime_artifact(config: &Config) -> RuntimeArtifactIdentity {
    let workspace_root = find_runtime_workspace_root(&config.runtime_package_dir);
    let uses_live_source = config.service_mode == "dev"
        && config
            .runtime_package_dir
            .join("src/base-daemon.ts")
            .exists();
    if uses_live_source {
        return RuntimeArtifactIdentity {
            mode: "source".to_string(),
            commit: workspace_root
                .as_deref()
                .and_then(|root| git_value(root, &["rev-parse", "HEAD"])),
            version: runtime_package_version(config),
            source_dirty: workspace_root.as_deref().and_then(git_dirty),
            built_at: None,
            manifest_path: None,
        };
    }

    if let Some((path, manifest)) = read_runtime_build_manifest(config) {
        return RuntimeArtifactIdentity {
            mode: "bundle".to_string(),
            commit: manifest.commit,
            version: manifest.version,
            source_dirty: manifest.source_dirty,
            built_at: manifest.built_at,
            manifest_path: Some(path.to_string_lossy().to_string()),
        };
    }

    RuntimeArtifactIdentity {
        mode: "bundle".to_string(),
        commit: None,
        version: runtime_package_version(config),
        source_dirty: None,
        built_at: None,
        manifest_path: None,
    }
}

fn running_runtime_artifact(raw_daemon_state: Option<&str>) -> Option<RuntimeArtifactIdentity> {
    let value = serde_json::from_str::<serde_json::Value>(raw_daemon_state?).ok()?;
    serde_json::from_value(value.get("runtimeBuild")?.clone()).ok()
}

fn commits_match(left: &str, right: &str) -> bool {
    let left = left.trim();
    let right = right.trim();
    !left.is_empty()
        && !right.is_empty()
        && (left == right || left.starts_with(right) || right.starts_with(left))
}

fn comparable_commit(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|commit| !commit.is_empty())
}

fn is_canonical_build_timestamp(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 24
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[10] == b'T'
        && bytes[13] == b':'
        && bytes[16] == b':'
        && bytes[19] == b'.'
        && bytes[23] == b'Z'
        && [0..4, 5..7, 8..10, 11..13, 14..16, 17..19, 20..23]
            .into_iter()
            .flatten()
            .all(|index| bytes[index].is_ascii_digit())
}

fn inspect_runtime_freshness(config: &Config, raw_daemon_state: Option<&str>) -> RuntimeFreshness {
    let configured = configured_runtime_artifact(config);
    let running = running_runtime_artifact(raw_daemon_state);
    let pin = env_nonempty("OPENSCOUT_RUNTIME_BUILD_PIN");
    let pin_reason = env_nonempty("OPENSCOUT_RUNTIME_BUILD_PIN_REASON");
    let freshness = evaluate_runtime_freshness(configured, running, pin, pin_reason);
    let owner = fs::read_to_string(&config.launch_agent_path)
        .ok()
        .map(|existing| assert_launch_agent_owner_compatible(config, &existing));
    match owner {
        Some(Err(_)) => freshness_for_foreign_owner(freshness),
        _ => freshness,
    }
}

// A caller whose install does not own the shared service is comparing the
// running runtime against its own artifact, which says nothing about whether
// the service is current, and it could not restart the service anyway.
fn freshness_for_foreign_owner(freshness: RuntimeFreshness) -> RuntimeFreshness {
    if freshness.state != "stale" {
        return freshness;
    }
    RuntimeFreshness {
        state: "unverified".to_string(),
        reason_code: Some("foreign_service_owner".to_string()),
        detail: "The shared Scout service is owned by a different installation; its freshness is judged against that owner's artifact, not this one.".to_string(),
        ..freshness
    }
}

fn evaluate_runtime_freshness(
    configured: RuntimeArtifactIdentity,
    running: Option<RuntimeArtifactIdentity>,
    pin: Option<String>,
    pin_reason: Option<String>,
) -> RuntimeFreshness {
    let expected_commit = pin.clone().or_else(|| configured.commit.clone());
    let expected_built_at = if pin.is_some() {
        None
    } else {
        configured.built_at.clone()
    };
    let basis = if pin.is_some() {
        "explicit_pin"
    } else if configured.mode == "source" {
        "workspace_head"
    } else {
        "installed_artifact"
    };

    let Some(actual) = running else {
        return RuntimeFreshness {
            state: "unverified".to_string(),
            intentional: false,
            basis: basis.to_string(),
            reason_code: None,
            artifact_commit: None,
            expected_commit,
            pin,
            pin_reason,
            manifest_path: configured.manifest_path,
            version: configured.version,
            actual_built_at: None,
            expected_built_at,
            built_at: None,
            source_dirty: configured.source_dirty,
            detail: "No running runtime artifact identity is recorded; restart scoutd once to establish it.".to_string(),
        };
    };

    let actual_commit = actual.commit.clone();
    let actual_built_at = actual.built_at.clone();
    let Some((actual_commit_value, expected_commit_value)) =
        comparable_commit(actual_commit.as_deref())
            .zip(comparable_commit(expected_commit.as_deref()))
    else {
        return RuntimeFreshness {
            state: "unverified".to_string(),
            intentional: false,
            basis: basis.to_string(),
            reason_code: None,
            artifact_commit: actual_commit,
            expected_commit,
            pin,
            pin_reason,
            manifest_path: actual.manifest_path.or(configured.manifest_path),
            version: actual.version.or(configured.version),
            actual_built_at: actual_built_at.clone(),
            expected_built_at,
            built_at: actual_built_at,
            source_dirty: actual.source_dirty,
            detail: if comparable_commit(actual.commit.as_deref()).is_none() {
                "The running runtime has no artifact commit; restart scoutd once after installing a runtime manifest to establish a comparable identity."
                    .to_string()
            } else {
                "Scoutd cannot determine the expected runtime commit from the configured source or installed artifact."
                    .to_string()
            },
        };
    };
    let matches_expected = commits_match(actual_commit_value, expected_commit_value);

    let (state, intentional, reason_code, detail) = if pin.is_some() && matches_expected {
        (
            "pinned",
            true,
            None,
            format!(
                "Running the explicitly pinned runtime build{}.",
                pin_reason
                    .as_deref()
                    .map(|reason| format!(" ({reason})"))
                    .unwrap_or_default()
            ),
        )
    } else if pin.is_some() {
        (
            "unverified",
            false,
            Some("pin_mismatch"),
            format!(
                "Running runtime commit {actual_commit_value} does not match explicit pin {expected_commit_value}; automatic maintenance will not override an inconsistent pin."
            ),
        )
    } else if !matches_expected {
        (
            "stale",
            false,
            None,
            format!(
                "Running runtime commit {actual_commit_value} does not match expected commit {expected_commit_value}. Rebuild/restart, or set OPENSCOUT_RUNTIME_BUILD_PIN={actual_commit_value} with a reason to make the older build intentional."
            ),
        )
    } else if actual.mode == "bundle"
        && expected_built_at.is_some()
        && actual_built_at != expected_built_at
    {
        match (actual_built_at.as_deref(), expected_built_at.as_deref()) {
            (Some(actual_timestamp), Some(expected_timestamp))
                if is_canonical_build_timestamp(actual_timestamp)
                    && is_canonical_build_timestamp(expected_timestamp)
                    && actual_timestamp < expected_timestamp =>
            {
                (
                    "stale",
                    false,
                    None,
                    "A newer bundle with the same source commit exists on disk; restart scoutd to run it."
                        .to_string(),
                )
            }
            (Some(actual_timestamp), Some(expected_timestamp))
                if is_canonical_build_timestamp(actual_timestamp)
                    && is_canonical_build_timestamp(expected_timestamp) =>
            {
                (
                    "unverified",
                    false,
                    Some("expected_build_older_than_running"),
                    "The configured bundle is older than the running bundle with the same source commit; automatic maintenance will not downgrade it."
                        .to_string(),
                )
            }
            _ => (
                "unverified",
                false,
                Some("build_timestamp_incomparable"),
                "The running and configured bundles have different but non-comparable build timestamps; automatic maintenance cannot prove which artifact is newer."
                    .to_string(),
            ),
        }
    } else if actual.mode == "source" && actual.source_dirty == Some(true) {
        (
            "unverified",
            false,
            None,
            "The runtime started from a dirty source checkout; commit identity alone cannot prove that the currently loaded process includes every working-tree edit.".to_string(),
        )
    } else {
        (
            "current",
            false,
            None,
            "The running runtime identity matches the configured source/artifact.".to_string(),
        )
    };

    RuntimeFreshness {
        state: state.to_string(),
        intentional,
        basis: basis.to_string(),
        reason_code: reason_code.map(str::to_string),
        artifact_commit: actual_commit,
        expected_commit,
        pin,
        pin_reason,
        manifest_path: actual.manifest_path.or(configured.manifest_path),
        version: actual.version.or(configured.version),
        actual_built_at: actual_built_at.clone(),
        expected_built_at,
        built_at: actual_built_at,
        source_dirty: actual.source_dirty,
        detail,
    }
}

fn path_str(path: &Path) -> Result<&str, String> {
    path.to_str()
        .ok_or_else(|| format!("path is not valid UTF-8: {}", path.display()))
}

fn first_nonempty(first: &str, second: &str) -> String {
    if !first.trim().is_empty() {
        first.trim().to_string()
    } else {
        second.trim().to_string()
    }
}

fn build_git_sha() -> Option<&'static str> {
    option_env!("SCOUTD_GIT_SHA").filter(|value| !value.trim().is_empty())
}

fn build_identity_text() -> String {
    match build_git_sha() {
        Some(git_sha) => format!("{DAEMON_NAME} {BUILD_VERSION} ({git_sha})"),
        None => format!("{DAEMON_NAME} {BUILD_VERSION}"),
    }
}

fn build_identity_json() -> String {
    format!(
        "{{\"name\":{},\"version\":{},\"gitSha\":{}}}",
        json_string(DAEMON_NAME),
        json_string(BUILD_VERSION),
        json_opt_str(build_git_sha()),
    )
}

fn print_version() {
    println!("{}", build_identity_text());
}

fn print_help() {
    println!(
        "scoutd <status|install|start|stop|restart|uninstall|doctor|supervise|probes serve|version> [--json] [--fix] [--yes] [--no-wait]\n\n\
         Native daemon for the OpenScout local control plane.\n\n\
         --no-wait  For start/restart, return after launchd accepts the job instead of waiting for broker health."
    );
}

fn print_status(status: &ServiceStatus, json: bool) {
    if json {
        println!("{}", status_json(status));
    } else {
        println!("label: {}", status.config.label);
        println!("scoutd: {}", build_identity_text());
        println!("loaded: {}", yes_no(status.launchctl.loaded));
        println!(
            "pid: {}",
            status
                .launchctl
                .pid
                .map(|pid| pid.to_string())
                .unwrap_or_else(|| "-".to_string())
        );
        println!(
            "launchd state: {}",
            status.launchctl.launchd_state.as_deref().unwrap_or("-")
        );
        println!(
            "scoutd state: {}",
            if status.daemon_state.is_some() {
                "recorded"
            } else {
                "missing"
            }
        );
        println!(
            "broker url: {}",
            status
                .effective_broker_url
                .as_deref()
                .unwrap_or(&status.config.broker_url)
        );
        println!(
            "broker socket: {}",
            status.config.broker_socket_path.display()
        );
        println!("probe socket: {}", status.probes.socket_path);
        println!(
            "probe server: {}",
            if status.probes.reachable {
                "ok"
            } else {
                "unreachable"
            }
        );
        println!(
            "web url: {}",
            status.effective_web_url.as_deref().unwrap_or("-")
        );
        println!(
            "runtime freshness: {} ({})",
            status.runtime_freshness.state, status.runtime_freshness.basis,
        );
        println!("runtime detail: {}", status.runtime_freshness.detail);
        println!("reachable: {}", yes_no(status.health.reachable));
        println!("health: {}", status.health.state);
    }
}

fn print_doctor(report: &DoctorReport, json: bool) {
    if json {
        println!("{}", doctor_json(report));
    } else {
        print_status(&report.status, false);
        println!("probes:");
        println!("- socket: {}", report.status.probes.socket_path);
        println!("- reachable: {}", yes_no(report.status.probes.reachable));
        if let Some(version) = report.status.probes.daemon_version.as_deref() {
            println!("- daemon version: {version}");
        }
        if report.status.probes.families.is_empty() {
            println!("- families: none");
        } else {
            println!("- families:");
            for family in &report.status.probes.families {
                println!(
                    "  - {} (schema v{}, ttl {}ms)",
                    family.probe_id, family.schema_version, family.ttl_ms,
                );
            }
        }
        if let Some(error) = report.status.probes.error.as_deref() {
            println!("- error: {error}");
        }
        if report.warnings.is_empty() {
            println!("warnings: none");
        } else {
            println!("warnings:");
            for warning in &report.warnings {
                println!("- {warning}");
            }
        }
        println!("processes: {}", report.processes.len());
        if report.fix_requested {
            if report.repairs.is_empty() {
                println!("repairs: none");
            } else {
                println!("repairs:");
                for repair in &report.repairs {
                    println!(
                        "- {} [{}]{}",
                        repair.title,
                        repair.status,
                        repair
                            .detail
                            .as_deref()
                            .map(|detail| format!(" {detail}"))
                            .unwrap_or_default()
                    );
                }
            }
            if !report.yes {
                println!("repair mode: dry-run; pass --yes to apply");
            }
        }
    }
}

fn status_json(status: &ServiceStatus) -> String {
    let installed = status.config.launch_agent_path.exists();
    let uses_launch_agent = installed || status.launchctl.loaded;
    let last_log_line = if status.health.reachable {
        read_last_log_line(&[
            &status.config.stdout_log_path,
            &status.config.stderr_log_path,
        ])
    } else {
        read_last_log_line(&[
            &status.config.stderr_log_path,
            &status.config.stdout_log_path,
        ])
    };

    format!(
        "{{\
\"label\":{},\
\"mode\":{},\
\"launchAgentPath\":{},\
\"bootoutCommand\":{},\
\"brokerUrl\":{},\
\"effectiveBrokerUrl\":{},\
\"webUrl\":{},\
\"brokerSocketPath\":{},\
\"supportDirectory\":{},\
\"runtimeDirectory\":{},\
\"controlHome\":{},\
\"stdoutLogPath\":{},\
\"stderrLogPath\":{},\
\"installed\":{},\
\"loaded\":{},\
\"pid\":{},\
\"launchdState\":{},\
\"lastExitStatus\":{},\
\"usesLaunchAgent\":{},\
\"reachable\":{},\
\"health\":{},\
\"lastLogLine\":{},\
\"scoutdExecutable\":{},\
\"scoutdVersion\":{},\
\"scoutdBuild\":{},\
\"hostInfoPath\":{},\
\"scoutdStatePath\":{},\
\"scoutdState\":{},\
\"healthSweep\":{},\
\"runtimeFreshness\":{},\
\"probes\":{}\
}}",
        json_string(&status.config.label),
        json_string(&status.config.service_mode),
        json_string(&status.config.launch_agent_path.to_string_lossy()),
        json_string(&format!(
            "/bin/launchctl bootout {}",
            status.config.service_target
        )),
        json_string(&status.config.broker_url),
        json_opt_str(status.effective_broker_url.as_deref()),
        json_opt_str(status.effective_web_url.as_deref()),
        json_string(&status.config.broker_socket_path.to_string_lossy()),
        json_string(&status.config.support_directory.to_string_lossy()),
        json_string(&status.config.runtime_directory.to_string_lossy()),
        json_string(&status.config.control_home.to_string_lossy()),
        json_string(&status.config.stdout_log_path.to_string_lossy()),
        json_string(&status.config.stderr_log_path.to_string_lossy()),
        installed,
        status.launchctl.loaded,
        json_opt_u32(status.launchctl.pid),
        json_opt_str(status.launchctl.launchd_state.as_deref()),
        json_opt_i32(status.launchctl.last_exit_status),
        uses_launch_agent,
        status.health.reachable,
        health_json(&status.health),
        json_opt_str(last_log_line.as_deref()),
        json_string(&status.config.daemon_executable.to_string_lossy()),
        json_string(BUILD_VERSION),
        build_identity_json(),
        json_string(&status.config.host_info_path.to_string_lossy()),
        json_string(&status.config.daemon_state_path.to_string_lossy()),
        status.daemon_state.as_deref().unwrap_or("null"),
        health_sweep_json(&status.config),
        serde_json::to_string(&status.runtime_freshness).unwrap_or_else(|_| "null".to_string()),
        serde_json::to_string(&status.probes).unwrap_or_else(|_| "null".to_string()),
    )
}

const HEALTH_RESERVE_HEADER: &[u8] = b"SCOUT_HEALTH_RESERVE_V1\n";
fn prepare_health_reserve(config: &Config) {
    let path = config.runtime_directory.join("scoutd-health-reserve.tmp");
    if let Ok(mut file) = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
    {
        let mut bytes = vec![0; 65536];
        bytes[..HEALTH_RESERVE_HEADER.len()].copy_from_slice(HEALTH_RESERVE_HEADER);
        let _ = file.write_all(&bytes).and_then(|_| file.sync_all());
    }
}
fn release_health_reserve(config: &Config) -> bool {
    let path = config.runtime_directory.join("scoutd-health-reserve.tmp");
    let Ok(mut file) = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(&path)
    else {
        return false;
    };
    let Ok(metadata) = file.metadata() else {
        return false;
    };
    if !metadata.is_file()
        || metadata.nlink() != 1
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.len() > 65536
    {
        return false;
    }
    let mut header = vec![0; HEALTH_RESERVE_HEADER.len()];
    if file.read_exact(&mut header).is_err() || header != HEALTH_RESERVE_HEADER {
        return false;
    }
    let Ok(current) = fs::symlink_metadata(&path) else {
        return false;
    };
    if current.ino() != metadata.ino() || current.dev() != metadata.dev() {
        return false;
    }
    fs::remove_file(path).is_ok()
}
fn publish_health_sweep(config: &Config, sweep: &health_sweep::Sweep) -> Result<(), String> {
    let result = publish_health_sweep_once(config, sweep);
    if result
        .as_ref()
        .err()
        .is_some_and(|e| matches!(e.raw_os_error(), Some(libc::ENOSPC) | Some(libc::EDQUOT)))
        && release_health_reserve(config)
    {
        return publish_health_sweep_once(config, sweep).map_err(|e| e.to_string());
    }
    result.map_err(|e| e.to_string())
}
fn health_stage_path(config: &Config) -> PathBuf {
    static NONCE: std::sync::OnceLock<u128> = std::sync::OnceLock::new();
    let nonce = NONCE.get_or_init(|| {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    });
    // A recycled pid after reboot must not latch publication on an old temp.
    config.runtime_directory.join(format!(
        "scoutd-health.json.{}.{nonce}.tmp",
        std::process::id()
    ))
}
fn publish_health_sweep_once(config: &Config, sweep: &health_sweep::Sweep) -> io::Result<()> {
    let path = config.runtime_directory.join("scoutd-health.json");
    let temp = health_stage_path(config);
    let mut value = serde_json::to_value(sweep).map_err(io::Error::other)?;
    value["checkedAt"] = serde_json::json!(epoch_ms());
    let bytes = serde_json::to_vec(&value).map_err(io::Error::other)?;
    // Exclusive creation never follows or truncates an existing temp/lock.
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temp)?;
    let result = file
        .write_all(&bytes)
        .and_then(|_| file.sync_all())
        .and_then(|_| fs::rename(&temp, &path));
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

fn load_health_sweep(config: &Config) -> Option<health_sweep::Sweep> {
    let path = config.runtime_directory.join("scoutd-health.json");
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .ok()?;
    if !file.metadata().ok()?.is_file() {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(65537).read_to_end(&mut bytes).ok()?;
    if bytes.len() > 65536 {
        return None;
    }
    serde_json::from_slice(&bytes).ok()
}

fn health_sweep_json(config: &Config) -> String {
    let path = config.runtime_directory.join("scoutd-health.json");
    fs::File::open(path)
        .ok()
        .and_then(|file| {
            let mut bytes = Vec::new();
            file.take(64 * 1024).read_to_end(&mut bytes).ok()?;
            serde_json::from_slice::<serde_json::Value>(&bytes).ok()
        })
        .map(|value| value.to_string())
        .unwrap_or_else(|| "null".into())
}

fn health_json(health: &HealthStatus) -> String {
    format!(
        "{{\
\"reachable\":{},\
\"ok\":{},\
\"checkedAt\":{},\
\"state\":{},\
\"durationMs\":{},\
\"transport\":{},\
\"statusCode\":{},\
\"body\":{},\
\"error\":{}\
}}",
        health.reachable,
        health.ok,
        health.checked_at,
        json_string(health.state),
        health.duration_ms,
        json_opt_str(health.transport.as_deref()),
        json_opt_u16(health.status_code),
        json_opt_str(health.body.as_deref()),
        json_opt_str(health.error.as_deref()),
    )
}

fn read_last_log_line(paths: &[&Path]) -> Option<String> {
    for path in paths {
        if let Some(line) = read_last_log_line_from(path) {
            return Some(line);
        }
    }
    None
}

/// Window for tailing log files. Even with child log bounding, older files can
/// be large, so we only read trailing bytes rather than the whole file.
const LOG_TAIL_WINDOW: u64 = 64 * 1024;

fn read_last_log_line_from(path: &Path) -> Option<String> {
    let mut file = fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let offset = len.saturating_sub(LOG_TAIL_WINDOW);
    if offset > 0 {
        file.seek(SeekFrom::Start(offset)).ok()?;
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).ok()?;

    let tail = String::from_utf8_lossy(&bytes);
    // When we did not start at the beginning of the file, the first line may be
    // a partial line truncated by the seek; skip it.
    let mut lines = tail.lines();
    if offset > 0 {
        lines.next();
    }
    lines
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .next_back()
        .map(str::to_string)
}

fn doctor_json(report: &DoctorReport) -> String {
    let warnings = report
        .warnings
        .iter()
        .map(|warning| json_string(warning))
        .collect::<Vec<_>>()
        .join(",");
    let processes = report
        .processes
        .iter()
        .map(process_json)
        .collect::<Vec<_>>()
        .join(",");
    let repairs = report
        .repairs
        .iter()
        .map(repair_json)
        .collect::<Vec<_>>()
        .join(",");
    format!(
        "{{\"status\":{},\"warnings\":[{}],\"processes\":[{}],\"fix\":{{\"supported\":true,\"requested\":{},\"yes\":{},\"actions\":[{}]}},\"repairs\":[{}]}}",
        status_json(&report.status),
        warnings,
        processes,
        report.fix_requested,
        report.yes,
        repairs,
        repairs,
    )
}

fn repair_json(repair: &DoctorRepair) -> String {
    format!(
        "{{\"id\":{},\"title\":{},\"status\":{},\"detail\":{},\"changed\":{}}}",
        json_string(&repair.id),
        json_string(&repair.title),
        json_string(&repair.status),
        json_opt_str(repair.detail.as_deref()),
        repair.changed,
    )
}

fn process_json(process: &ProcessInfo) -> String {
    format!(
        "{{\"pid\":{},\"ppid\":{},\"pcpu\":{},\"pmem\":{},\"elapsed\":{},\"command\":{}}}",
        process.pid,
        process.ppid,
        json_string(&process.pcpu),
        json_string(&process.pmem),
        json_string(&process.elapsed),
        json_string(&process.command),
    )
}

fn yes_no(value: bool) -> &'static str {
    if value {
        "yes"
    } else {
        "no"
    }
}

fn json_opt_str(value: Option<&str>) -> String {
    value.map(json_string).unwrap_or_else(|| "null".to_string())
}

fn json_opt_u16(value: Option<u16>) -> String {
    value
        .map(|number| number.to_string())
        .unwrap_or_else(|| "null".to_string())
}

fn json_opt_u32(value: Option<u32>) -> String {
    value
        .map(|number| number.to_string())
        .unwrap_or_else(|| "null".to_string())
}

fn json_opt_u64(value: Option<u64>) -> String {
    value
        .map(|number| number.to_string())
        .unwrap_or_else(|| "null".to_string())
}

fn json_opt_i32(value: Option<i32>) -> String {
    value
        .map(|number| number.to_string())
        .unwrap_or_else(|| "null".to_string())
}

fn json_string(value: &str) -> String {
    format!("\"{}\"", json_escape(value))
}

fn json_escape(value: &str) -> String {
    let mut escaped = String::new();
    for character in value.chars() {
        match character {
            '"' => escaped.push_str("\\\""),
            '\\' => escaped.push_str("\\\\"),
            '\n' => escaped.push_str("\\n"),
            '\r' => escaped.push_str("\\r"),
            '\t' => escaped.push_str("\\t"),
            character if character.is_control() => {
                escaped.push_str(&format!("\\u{:04x}", character as u32))
            }
            character => escaped.push(character),
        }
    }
    escaped
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

#[cfg(test)]
mod tests {
    use super::{
        build_identity_json, build_identity_text, command_invokes_scoutd_daemon, commits_match,
        elapsed_seconds, evaluate_runtime_freshness, freshness_for_foreign_owner,
        health_body_reports_ok, launch_agent_owner_compatible, legacy_service_labels,
        legacy_service_targets, openscout_pairing_advertisement_key, parse_daemon_state_telemetry,
        parse_health_response, parse_http_status_code, process_snapshot_filter,
        read_last_log_line_from, resolve_advertise_scope_value, resolve_broker_host_value,
        resolve_broker_url_value, resolve_push_relay_child_environment, restart_telemetry_warnings,
        rotate_child_log_if_needed, rotated_child_log_path, running_runtime_artifact,
        scoutd_owned_child_log_path, stale_pairing_advertisement_pids, start_readiness_from_args,
        start_service_launchctl_command_plan, xml_escape, Config, ManagedProcessLease, ProcessInfo,
        RuntimeArtifactIdentity, StartReadiness, ALLOW_SHARED_SERVICE_REPOINT_ENV, BUILD_VERSION,
        CHILD_LOG_ROTATE_LIMIT, DAEMON_NAME, DEFAULT_BROKER_HOST, DEFAULT_BROKER_HOST_MESH,
        DEFAULT_BROKER_PORT, DEFAULT_OPENSCOUT_PUSH_RELAY_URL, LAUNCHD_EXIT_TIMEOUT_SECONDS,
        LEGACY_DAEMON_NAME, LOG_TAIL_WINDOW, REPO_WATCH_WARM_PATH, SHARED_SERVICE_LABEL,
    };
    use std::env;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_config(runtime_package_dir: &str, daemon_executable: &str, label: &str) -> Config {
        Config {
            label: label.to_string(),
            service_mode: "dev".to_string(),
            domain_target: "gui/501".to_string(),
            service_target: format!("gui/501/{label}"),
            launch_agent_path: PathBuf::from(format!(
                "/Users/test/Library/LaunchAgents/{label}.plist"
            )),
            support_directory: PathBuf::from("/Users/test/Library/Application Support/OpenScout"),
            open_scout_home: PathBuf::from("/Users/test/.openscout"),
            runtime_directory: PathBuf::from(
                "/Users/test/Library/Application Support/OpenScout/runtime",
            ),
            logs_directory: PathBuf::from(
                "/Users/test/Library/Application Support/OpenScout/logs/broker",
            ),
            probe_logs_directory: PathBuf::from(
                "/Users/test/Library/Application Support/OpenScout/logs/probes",
            ),
            stdout_log_path: PathBuf::from(
                "/Users/test/Library/Application Support/OpenScout/logs/broker/stdout.log",
            ),
            stderr_log_path: PathBuf::from(
                "/Users/test/Library/Application Support/OpenScout/logs/broker/stderr.log",
            ),
            probe_stdout_log_path: PathBuf::from(
                "/Users/test/Library/Application Support/OpenScout/logs/probes/stdout.log",
            ),
            probe_stderr_log_path: PathBuf::from(
                "/Users/test/Library/Application Support/OpenScout/logs/probes/stderr.log",
            ),
            control_home: PathBuf::from("/Users/test/.openscout/control-plane"),
            runtime_package_dir: PathBuf::from(runtime_package_dir),
            daemon_executable: PathBuf::from(daemon_executable),
            daemon_state_path: PathBuf::from(
                "/Users/test/Library/Application Support/OpenScout/runtime/scoutd-state.json",
            ),
            host_info_path: PathBuf::from(
                "/Users/test/Library/Application Support/OpenScout/.host-info",
            ),
            bun_executable: "/Users/test/.bun/bin/bun".to_string(),
            advertise_scope: "local".to_string(),
            broker_host: DEFAULT_BROKER_HOST.to_string(),
            broker_port: DEFAULT_BROKER_PORT,
            broker_url: "http://127.0.0.1:43110".to_string(),
            broker_socket_path: PathBuf::from(
                "/Users/test/Library/Application Support/OpenScout/runtime/broker.sock",
            ),
            probes_socket_path: PathBuf::from("/Users/test/.openscout/run/scoutd-probes.sock"),
            repo_watch_interval: None,
        }
    }

    fn owner_plist(runtime_package_dir: Option<&str>, daemon_executable: &str) -> String {
        let runtime = runtime_package_dir
            .map(|path| {
                format!(
                    "<key>OPENSCOUT_RUNTIME_PACKAGE_DIR</key><string>{}</string>",
                    xml_escape(path),
                )
            })
            .unwrap_or_default();
        format!(
            "<key>ProgramArguments</key><array><string>{}</string><string>supervise</string></array>{runtime}",
            xml_escape(daemon_executable),
        )
    }

    struct OwnedPipeChildren(Vec<u32>);
    impl Drop for OwnedPipeChildren {
        fn drop(&mut self) {
            for &pid in &self.0 {
                // Reap only a child still owned by this test process. ECHILD
                // means already reaped; never signal a potentially reused PID.
                unsafe {
                    let mut status = 0;
                    if libc::waitpid(pid as i32, &mut status, libc::WNOHANG) == 0 {
                        libc::kill(pid as i32, libc::SIGKILL);
                        libc::waitpid(pid as i32, &mut status, 0);
                    }
                }
            }
        }
    }

    #[test]
    fn supervisor_loop_keeps_children_through_periodic_enospc_and_drains_on_shutdown() {
        use std::process::{Command, Stdio};
        let base = Command::new("/bin/cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        let probe = Command::new("/bin/cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        let expected_pids = (base.id(), probe.id());
        let _guard = OwnedPipeChildren(vec![base.id(), probe.id()]);
        let directory = unique_temp_path("supervisor-loop");
        fs::create_dir_all(&directory).unwrap();
        let mut config = test_config(
            "/nonexistent-test-runtime",
            "/nonexistent-test-scoutd",
            "scoutd.test",
        );
        config.runtime_directory = directory.clone();
        config.daemon_state_path = directory.join("state.json");
        let mut hooks = super::SupervisionTestHooks {
            base: Some(base),
            probe: Some(probe),
            expected_pids,
            start: std::time::Instant::now(),
            ticks: 0,
            stop_after_ticks: 700,
            fail_phase: "periodic",
            write_attempts: Vec::new(),
            observations: 0,
            sweep_samples: Vec::new(),
            sweep_actions: Vec::new(),
            sweep_states: Vec::new(),
            sweep_notifications_succeed: true,
            sweep_probe_ticks: Vec::new(),
            health_worker: None,
        };
        // The production supervisor loop used to propagate the injected error
        // and exit on its first periodic publication. This must reach shutdown.
        super::supervise_service_inner(&config, Some(&mut hooks)).unwrap();
        assert_eq!(hooks.observations, 700);
        let attempts: Vec<_> = hooks
            .write_attempts
            .iter()
            .filter(|(phase, _)| *phase == "periodic")
            .map(|(_, tick)| *tick)
            .collect();
        assert_eq!(attempts, vec![20, 40, 80, 160, 320, 620]);
        let persisted: serde_json::Value =
            serde_json::from_slice(&fs::read(&config.daemon_state_path).unwrap()).unwrap();
        assert_eq!(persisted["baseState"], "stopped");
        assert!(persisted["basePid"].is_null());
        for pid in [expected_pids.0, expected_pids.1] {
            let mut status = 0;
            assert_eq!(
                unsafe { libc::waitpid(pid as i32, &mut status, libc::WNOHANG) },
                -1
            );
            assert_eq!(
                std::io::Error::last_os_error().raw_os_error(),
                Some(libc::ECHILD)
            );
        }
        fs::remove_dir_all(directory).unwrap();
    }

    fn run_sweep_loop(
        samples: Vec<(u32, super::health_sweep::Observation)>,
        ticks: u32,
        prior: Option<super::health_sweep::Sweep>,
    ) -> super::SupervisionTestHooks {
        run_sweep_loop_delivery(samples, ticks, prior, true)
    }
    fn run_sweep_loop_delivery(
        samples: Vec<(u32, super::health_sweep::Observation)>,
        ticks: u32,
        prior: Option<super::health_sweep::Sweep>,
        notification_success: bool,
    ) -> super::SupervisionTestHooks {
        run_sweep_loop_worker(samples, ticks, prior, notification_success, None)
    }
    fn run_sweep_loop_worker(
        samples: Vec<(u32, super::health_sweep::Observation)>,
        ticks: u32,
        prior: Option<super::health_sweep::Sweep>,
        notification_success: bool,
        worker: Option<super::health_worker::Worker>,
    ) -> super::SupervisionTestHooks {
        use std::process::{Command, Stdio};
        let owned = || {
            Command::new("/bin/cat")
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .spawn()
                .unwrap()
        };
        let base = owned();
        let probe = owned();
        let expected_pids = (base.id(), probe.id());
        let _guard = OwnedPipeChildren(vec![base.id(), probe.id()]);
        let directory = unique_temp_path("sweep-loop");
        fs::create_dir_all(&directory).unwrap();
        let mut config = test_config("/nonexistent-runtime", "/nonexistent-scoutd", "scoutd.test");
        config.runtime_directory = directory.clone();
        config.daemon_state_path = directory.join("state.json");
        if let Some(prior) = prior {
            super::publish_health_sweep(&config, &prior).unwrap();
        }
        let mut hooks = super::SupervisionTestHooks {
            base: Some(base),
            probe: Some(probe),
            expected_pids,
            start: std::time::Instant::now(),
            ticks: 0,
            stop_after_ticks: ticks,
            fail_phase: "",
            write_attempts: Vec::new(),
            observations: 0,
            sweep_samples: samples,
            sweep_actions: Vec::new(),
            sweep_states: Vec::new(),
            sweep_notifications_succeed: notification_success,
            sweep_probe_ticks: Vec::new(),
            health_worker: worker,
        };
        super::supervise_service_inner(&config, Some(&mut hooks)).unwrap();
        assert_eq!(hooks.observations, ticks as usize);
        fs::remove_dir_all(directory).unwrap();
        hooks
    }

    #[test]
    fn supervisor_keeps_polling_owned_children_and_shuts_down_during_held_health_work() {
        use super::health_worker::{Job, Result, Worker};
        let (release, wait) = std::sync::mpsc::channel();
        let mut worker = Worker::start_with(move |job| {
            wait.recv().unwrap();
            match job {
                Job::Observe { base_pid, .. } => Result::Observed {
                    observation: super::health_sweep::Observation::default(),
                    base_pid,
                },
                Job::Notify { condition, .. } => Result::Notified {
                    id: condition.condition,
                    since: condition.since,
                    level: condition.notice_level,
                    delivered: false,
                },
            }
        })
        .unwrap();
        worker.observe(true, 0, 42);
        let start = std::time::Instant::now();
        let hooks = run_sweep_loop_worker(Vec::new(), 100, None, true, Some(worker));
        assert_eq!(hooks.observations, 100);
        assert!(start.elapsed() < std::time::Duration::from_secs(2));
        // The worker remains held until after both owned children were reaped.
        release.send(()).unwrap();
    }

    #[test]
    fn pending_observation_does_not_advance_the_slow_sweep_deadline() {
        let (release, wait) = std::sync::mpsc::channel();
        let mut worker = super::health_worker::Worker::start_with(move |job| {
            wait.recv().unwrap();
            match job {
                super::health_worker::Job::Observe { base_pid, .. } => {
                    super::health_worker::Result::Observed {
                        observation: super::health_sweep::Observation::default(),
                        base_pid,
                    }
                }
                _ => panic!("unexpected notification"),
            }
        })
        .unwrap();
        assert!(worker.observe(true, 0, 42));
        let hooks = run_sweep_loop_worker(Vec::new(), 601, None, true, Some(worker));
        assert_eq!(
            hooks.sweep_probe_ticks,
            vec![(0, true), (300, true), (600, true)]
        );
        release.send(()).unwrap();
    }

    #[test]
    fn supervisor_reports_a_dead_health_worker_without_losing_child_custody() {
        let (done, dead) = std::sync::mpsc::channel::<()>();
        let mut worker = super::health_worker::Worker::start_with(move |_| {
            drop(done.clone());
            panic!("injected health worker failure");
        })
        .unwrap();
        worker.observe(true, 0, 42);
        // Wait for the injected panic to unwind; no Scout service is started.
        assert!(dead
            .recv_timeout(std::time::Duration::from_secs(2))
            .is_err());
        let hooks = run_sweep_loop_worker(Vec::new(), 100, None, true, Some(worker));
        assert_eq!(hooks.observations, 100);
        assert_eq!(
            hooks
                .sweep_actions
                .iter()
                .filter(|(_, a)| a == "worker-disconnected")
                .count(),
            1
        );
    }

    #[test]
    fn sweep_loop_long_disk_latch_recovers_without_an_outage_notice() {
        use super::health_sweep::Observation;
        let low = Observation {
            health: Some(r#"{"startup":{"phase":"degraded","error":"SQLITE_FULL"}}"#.into()),
            disk: Some((0, 100 << 30)),
            ..Observation::default()
        };
        let freed = Observation {
            disk: Some((10 << 30, 100 << 30)),
            ..low.clone()
        };
        let booting = Observation {
            disk: freed.disk,
            ..Observation::default()
        };
        let ready = Observation {
            health: Some(r#"{"startup":{"mutationsAdmitted":true}}"#.into()),
            ..booting.clone()
        };
        let hooks = run_sweep_loop(
            vec![(0, low), (6600, freed), (6900, booting), (7200, ready)],
            7501,
            None,
        );
        assert_eq!(
            hooks.sweep_actions,
            vec![
                (600, "notify:local:disk".into()),
                (1200, "notify:local:startup-projection".into()),
                (6600, "restart-base".into())
            ]
        );
        assert!(hooks.sweep_states.last().unwrap().1.is_empty());
    }
    #[test]
    fn sweep_loop_gives_a_new_child_time_to_boot_with_an_old_checkpoint() {
        use super::health_sweep::{Observation, Sweep};
        let mut prior = Sweep::default();
        prior.observe(
            super::epoch_ms() - 1_200_000,
            Some(r#"{"startup":{"phase":"degraded","error":"schema failed"}}"#),
            None,
        );
        let hooks = run_sweep_loop(vec![(0, Observation::default())], 6301, Some(prior));
        assert_eq!(
            hooks.sweep_actions,
            vec![(6000, "notify:local:startup-projection".into())]
        );
    }

    #[test]
    fn sweep_loop_reports_an_unready_successor_after_ten_minutes() {
        use super::health_sweep::Observation;
        let broken = Observation {
            health: Some(r#"{"startup":{"phase":"degraded","error":"schema failed"}}"#.into()),
            ..Observation::default()
        };
        let hooks = run_sweep_loop(
            vec![(0, broken), (1300, Observation::default())],
            7501,
            None,
        );
        assert_eq!(
            hooks.sweep_actions,
            vec![
                (1200, "restart-base".into()),
                (7200, "notify:local:startup-projection".into())
            ]
        );
    }
    #[test]
    fn sweep_loop_reports_manual_repair_after_its_space_notice_and_failed_restart() {
        use super::health_sweep::{NoticeLevel, Observation};
        let broken = Observation {
            health: Some(r#"{"startup":{"phase":"degraded","error":"SQLITE_FULL"}}"#.into()),
            disk: Some((0, 100 << 30)),
            ..Observation::default()
        };
        let space = Observation {
            disk: Some((10 << 30, 100 << 30)),
            ..broken.clone()
        };
        let hooks = run_sweep_loop(vec![(0, broken), (1500, space)], 2101, None);
        assert_eq!(
            hooks.sweep_actions,
            vec![
                (600, "notify:local:disk".into()),
                (1200, "notify:local:startup-projection".into()),
                (1500, "restart-base".into()),
                (1800, "notify:local:startup-projection".into())
            ]
        );
        let manual = hooks
            .sweep_states
            .iter()
            .find(|(tick, _)| *tick == 1800)
            .unwrap()
            .1
            .iter()
            .find(|c| c.condition == "startup-projection")
            .unwrap();
        assert_eq!(manual.notified_level, Some(NoticeLevel::Manual));
        assert!(manual.action.contains("Repair"));
    }

    #[test]
    fn sweep_loop_reports_relay_after_90_seconds_without_restarting_and_clears() {
        use super::health_sweep::{Observation, ServiceObservation};
        let broken = Observation {
            relay: Some(ServiceObservation {
                expected: true,
                running: false,
                cause: "no listener".into(),
                action: "restart phone pairing".into(),
            }),
            ..Observation::default()
        };
        let clear = Observation {
            relay: Some(ServiceObservation::default()),
            ..Observation::default()
        };
        let hooks = run_sweep_loop(vec![(0, broken), (1200, clear)], 1501, None);
        assert_eq!(
            hooks.sweep_actions,
            vec![(900, "notify:local:relay".into())]
        );
        assert!(hooks.sweep_states[0]
            .1
            .iter()
            .any(|c| c.condition == "relay"));
        assert!(hooks.sweep_states.last().unwrap().1.is_empty());
    }
    #[test]
    fn sweep_loop_headless_web_is_quiet_then_reports_missing_entry_and_clears() {
        use super::health_sweep::{Observation, ServiceObservation};
        let headless = Observation {
            web: Some(ServiceObservation::default()),
            ..Observation::default()
        };
        let broken = Observation {
            web: Some(ServiceObservation {
                expected: true,
                running: false,
                cause: "no web entry: legacy-app-services.json is missing".into(),
                action: "open Scout.app once".into(),
            }),
            ..Observation::default()
        };
        let hooks = run_sweep_loop(
            vec![(0, headless.clone()), (300, broken), (1500, headless)],
            1801,
            None,
        );
        assert!(hooks.sweep_states[0].1.is_empty());
        assert_eq!(hooks.sweep_actions, vec![(1200, "notify:local:web".into())]);
        assert!(hooks.sweep_states.last().unwrap().1.is_empty());
    }
    #[test]
    fn sweep_loop_disk_gate_owned_restart_notify_once_and_clear() {
        use super::health_sweep::Observation;
        let full = r#"{"startup":{"phase":"degraded","error":"SQLITE_FULL"}}"#;
        let ready = r#"{"startup":{"mutationsAdmitted":true}}"#;
        let low = Observation {
            health: Some(full.into()),
            disk: Some((0, 100 << 30)),
            top_consumers: vec!["base logs 999 MiB".into()],
            ..Observation::default()
        };
        let space = Observation {
            health: Some(full.into()),
            disk: Some((10 << 30, 100 << 30)),
            ..Observation::default()
        };
        let clear = Observation {
            health: Some(ready.into()),
            disk: space.disk,
            ..Observation::default()
        };
        let hooks = run_sweep_loop(vec![(0, low), (1500, space), (1800, clear)], 2101, None);
        assert_eq!(
            hooks.sweep_actions,
            vec![
                (600, "notify:local:disk".into()),
                (1200, "notify:local:startup-projection".into()),
                (1500, "restart-base".into())
            ]
        );
        assert!(hooks.sweep_states[0]
            .1
            .iter()
            .any(|c| c.cause.contains("base logs 999 MiB")));
        assert!(hooks.sweep_states.last().unwrap().1.is_empty());
    }
    #[test]
    fn sweep_loop_slow_findings_report_via_runtime_once_and_clear() {
        use super::health_sweep::{Finding, Observation};
        let health = Some(r#"{"startup":{"mutationsAdmitted":true}}"#.into());
        for id in ["version-skew", "stale-files", "temp-orphans"] {
            let broken = Observation {
                health: health.clone(),
                slow: Some(vec![Finding {
                    id: id.into(),
                    cause: "diagnosed cause".into(),
                    action: "one action".into(),
                }]),
                ..Observation::default()
            };
            let clear = Observation {
                health: health.clone(),
                slow: Some(Vec::new()),
                ..Observation::default()
            };
            let hooks = run_sweep_loop(vec![(0, broken), (600, clear)], 901, None);
            assert_eq!(
                hooks.sweep_actions,
                vec![(0, format!("notify:runtime:{id}"))]
            );
            assert!(hooks.sweep_states.last().unwrap().1.is_empty());
        }
    }
    #[test]
    fn sweep_loop_bounds_non_disk_restarts_and_clears_only_on_confirmed_readiness() {
        use super::health_sweep::Observation;
        let broken = Observation {
            health: Some(r#"{"startup":{"phase":"degraded","error":"schema failed"}}"#.into()),
            disk: Some((10 << 30, 100 << 30)),
            ..Observation::default()
        };
        let clear = Observation {
            health: Some(r#"{"startup":{"mutationsAdmitted":true}}"#.into()),
            ..Observation::default()
        };
        let hooks = run_sweep_loop(
            vec![
                (0, broken.clone()),
                (1800, Observation::default()),
                (2100, broken),
                (9000, clear),
            ],
            9301,
            None,
        );
        let restarts: Vec<u32> = hooks
            .sweep_actions
            .iter()
            .filter(|(_, a)| a == "restart-base")
            .map(|(tick, _)| *tick)
            .collect();
        assert_eq!(restarts, vec![1200, 2400, 4800]);
        assert_eq!(
            hooks
                .sweep_probe_ticks
                .iter()
                .filter(|(_, slow)| *slow)
                .map(|(tick, _)| *tick)
                .collect::<Vec<_>>(),
            vec![0, 6000]
        );
        assert_eq!(
            hooks
                .sweep_actions
                .iter()
                .filter(|(_, a)| a.starts_with("notify:"))
                .count(),
            1
        );
        assert!(!hooks
            .sweep_states
            .iter()
            .find(|(t, _)| *t == 1800)
            .unwrap()
            .1
            .is_empty());
        assert!(hooks.sweep_states.last().unwrap().1.is_empty());
    }

    #[test]
    fn sweep_loop_notification_failure_uses_persisted_retry_delay() {
        use super::health_sweep::{Observation, ServiceObservation};
        let broken = Observation {
            relay: Some(ServiceObservation {
                expected: true,
                running: false,
                cause: "no listener".into(),
                action: "restart pairing".into(),
            }),
            ..Observation::default()
        };
        let hooks = run_sweep_loop_delivery(vec![(0, broken)], 4201, None, false);
        assert_eq!(
            hooks.sweep_actions,
            vec![
                (900, "notify:local:relay".into()),
                (3900, "notify:local:relay".into())
            ]
        );
        assert!(hooks.sweep_states.last().unwrap().1[0]
            .notified_at
            .is_none());
    }

    #[test]
    fn sweep_loop_restores_notification_deduplication_after_supervisor_restart() {
        use super::health_sweep::{Observation, ServiceObservation, Sweep};
        let sample = Observation {
            relay: Some(ServiceObservation {
                expected: true,
                running: false,
                cause: "no listener".into(),
                action: "restart pairing".into(),
            }),
            ..Observation::default()
        };
        let mut prior = Sweep::default();
        prior.observe_all(super::epoch_ms() - 300_000, &sample);
        prior.conditions[0].notified_at = Some(super::epoch_ms() - 120_000);
        let hooks = run_sweep_loop(vec![(0, sample)], 1201, Some(prior));
        assert!(hooks.sweep_actions.is_empty());
        assert!(hooks.sweep_states.last().unwrap().1[0]
            .notified_at
            .is_some());
    }

    #[test]
    fn state_publication_retries_enospc_without_ending_child_supervision() {
        use std::process::{Command, Stdio};
        use std::time::{Duration, Instant};
        // A controlled pipe child, not a Scout service. It stays alive until
        // explicit cleanup and proves telemetry failures do not reap it.
        let mut child = Command::new("/bin/cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        let _guard = OwnedPipeChildren(vec![child.id()]);
        let child_id = child.id();
        let start = Instant::now();
        let mut publication = super::StatePublication::new(start);
        let mut attempts = Vec::new();
        let mut reports = Vec::new();
        let mut persisted = String::from("initial:0");
        super::require_initial_state(Ok(()), || panic!("initial success must not clean up"))
            .unwrap();
        for tick in 0..=1000 {
            let now = start + Duration::from_millis(tick * 100);
            // Even noisy lifecycle refresh requests must respect failed retry.
            if tick % 3 == 0 {
                publication.request_refresh(now);
            }
            publication.refresh(
                now,
                || {
                    attempts.push(tick * 100);
                    if tick < 930 {
                        Err("No space left on device (os error 28)".into())
                    } else {
                        persisted = format!("current:{tick}");
                        Ok(())
                    }
                },
                |message| reports.push((tick * 100, message)),
            );
            assert_eq!(child.id(), child_id);
            assert!(child.try_wait().unwrap().is_none());
            if tick < 930 {
                assert_eq!(persisted, "initial:0");
            }
        }
        assert_eq!(attempts, vec![0, 2000, 6000, 14000, 30000, 60000, 90000]);
        // Recovery is tested separately below with a controlled due instant.
        let recover_at = start + Duration::from_secs(120);
        publication.refresh(
            recover_at,
            || {
                persisted = "latest:120".into();
                Ok(())
            },
            |message| reports.push((120000, message)),
        );
        assert_eq!(persisted, "latest:120");
        let failures: Vec<_> = reports
            .iter()
            .filter(|(_, message)| message.contains("failed"))
            .collect();
        assert!(failures
            .windows(2)
            .all(|pair| pair[1].0 - pair[0].0 >= 30000));
        assert_eq!(
            reports
                .iter()
                .filter(|(_, message)| message.contains("recovered"))
                .count(),
            1
        );
        assert!(!publication.is_due(recover_at + Duration::from_secs(1)));
        assert!(publication.is_due(recover_at + Duration::from_secs(2)));
        super::terminate_supervised_children(&mut child, &mut None).unwrap();
        assert!(child.try_wait().unwrap().is_some());
    }

    #[test]
    fn initial_state_failure_reaps_both_owned_children_and_returns_error() {
        use std::process::{Command, Stdio};
        let mut base = Command::new("/bin/cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        let mut probe = Some(
            Command::new("/bin/cat")
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .spawn()
                .unwrap(),
        );
        let _guard = OwnedPipeChildren(vec![base.id(), probe.as_ref().unwrap().id()]);
        let result = super::require_initial_state(Err("injected ENOSPC".into()), || {
            super::terminate_supervised_children(&mut base, &mut probe)
        });
        assert!(result
            .unwrap_err()
            .contains("initial state publication failed"));
        assert!(base.try_wait().unwrap().is_some());
        assert!(probe.as_mut().unwrap().try_wait().unwrap().is_some());
    }

    #[test]
    fn stopping_state_failure_cannot_skip_cleanup_or_final_publication() {
        use std::cell::RefCell;
        let calls = RefCell::new(Vec::new());
        let result = super::finish_supervision(
            Err("ENOSPC stopping".into()),
            || {
                calls.borrow_mut().push("cleanup");
                Ok(())
            },
            || {
                calls.borrow_mut().push("stopped");
                Err("ENOSPC stopped".into())
            },
        );
        assert_eq!(*calls.borrow(), vec!["cleanup", "stopped"]);
        let error = result.unwrap_err();
        assert!(error.contains("ENOSPC stopping") && error.contains("ENOSPC stopped"));
    }

    #[test]
    fn failed_cleanup_does_not_publish_a_false_stopped_snapshot() {
        let result = super::finish_supervision(
            Ok(()),
            || Err("child still alive".into()),
            || panic!("must not publish stopped after failed cleanup"),
        );
        assert!(result.unwrap_err().contains("child still alive"));
    }

    #[test]
    fn failed_snapshot_write_preserves_last_valid_timestamp_then_recovers() {
        let directory = unique_temp_path("state-publication");
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("scoutd-state.json");
        let original = br#"{"updatedAtMs":1,"basePid":123}"#;
        super::write_daemon_state_payload(&path, original).unwrap();
        let temporary = path.with_extension("json.tmp");
        // Filesystem fault without filling disk: a directory blocks temp write.
        fs::create_dir(&temporary).unwrap();
        assert!(super::write_daemon_state_payload(&path, br#"{"updatedAtMs":2}"#).is_err());
        assert_eq!(fs::read(&path).unwrap(), original);
        fs::remove_dir(&temporary).unwrap();
        let recovered = br#"{"updatedAtMs":3,"basePid":456}"#;
        super::write_daemon_state_payload(&path, recovered).unwrap();
        assert_eq!(fs::read(&path).unwrap(), recovered);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn diagnostic_state_age_warning_does_not_claim_broker_unhealthy() {
        let state = r#"{"updatedAtMs":1000}"#;
        assert!(super::daemon_state_age_warning(state, 61000).is_none());
        let warning = super::daemon_state_age_warning(state, 62000).unwrap();
        assert!(warning.contains("diagnostic state is stale"));
        assert!(warning.contains("health separately"));
        assert!(super::daemon_state_age_warning(state, 0).is_none());
        assert!(super::daemon_state_age_warning("{}", 62000).is_none());
    }

    #[test]
    fn start_waits_for_broker_health_by_default() {
        assert_eq!(
            start_readiness_from_args(&["start".to_string()]),
            StartReadiness::BrokerHealthy,
        );
    }

    #[test]
    fn start_can_return_after_launchd_accepts_the_job() {
        assert_eq!(
            start_readiness_from_args(&["start".to_string(), "--no-wait".to_string()]),
            StartReadiness::LaunchdAccepted,
        );
    }

    #[test]
    fn start_bootstraps_the_run_at_load_job_without_kickstarting_it() {
        let config = test_config(
            "/stable/packages/cli",
            "/stable/packages/cli/bin/scoutd",
            SHARED_SERVICE_LABEL,
        );

        assert_eq!(
            start_service_launchctl_command_plan(&config).unwrap(),
            [
                vec!["bootout", "gui/501/app.openscout"],
                vec![
                    "bootstrap",
                    "gui/501",
                    "/Users/test/Library/LaunchAgents/app.openscout.plist",
                ],
            ],
        );
    }

    #[test]
    fn launch_agent_allows_the_supervisor_to_finish_its_child_drain() {
        let config = test_config(
            "/stable/packages/cli",
            "/stable/packages/cli/bin/scoutd",
            SHARED_SERVICE_LABEL,
        );
        let plist = super::render_launch_agent_plist(&config);

        assert!(plist.contains(&format!(
            "<key>ExitTimeOut</key>\n  <integer>{LAUNCHD_EXIT_TIMEOUT_SECONDS}</integer>",
        )));
    }

    #[test]
    fn base_process_spawn_always_pins_the_instance() {
        let config = test_config(
            "/checkout/packages/runtime",
            "/checkout/packages/runtime/bin/scoutd",
            SHARED_SERVICE_LABEL,
        );
        let instance_of = |command: &std::process::Command| {
            command
                .get_envs()
                .find(|(key, _)| *key == std::ffi::OsStr::new("OPENSCOUT_INSTANCE"))
                .and_then(|(_, value)| value.map(|value| value.to_string_lossy().to_string()))
        };
        let unset = super::base_process_command(&config, |_| None);
        assert_eq!(instance_of(&unset).as_deref(), Some("prod"));
        let dev = super::base_process_command(&config, |key| match key {
            "OPENSCOUT_INSTANCE" => Some("dev".into()),
            _ => None,
        });
        assert_eq!(instance_of(&dev).as_deref(), Some("dev"));
    }

    #[test]
    fn launch_agent_always_pins_the_instance() {
        let config = test_config(
            "/checkout/packages/runtime",
            "/checkout/packages/runtime/bin/scoutd",
            SHARED_SERVICE_LABEL,
        );
        let default_plist = super::render_launch_agent_plist_with_optional_env(&config, |_| None);
        assert!(default_plist.contains("<key>OPENSCOUT_INSTANCE</key>\n    <string>prod</string>"));
        let dev_plist =
            super::render_launch_agent_plist_with_optional_env(&config, |key| match key {
                "OPENSCOUT_INSTANCE" => Some("dev".into()),
                _ => None,
            });
        assert!(dev_plist.contains("<key>OPENSCOUT_INSTANCE</key>\n    <string>dev</string>"));
        assert_eq!(
            dev_plist.matches("<key>OPENSCOUT_INSTANCE</key>").count(),
            1
        );
    }

    #[test]
    fn launch_agent_preserves_jetstream_opt_in_without_enabling_it_by_default() {
        let config = test_config(
            "/stable/packages/cli",
            "/stable/packages/cli/bin/scoutd",
            SHARED_SERVICE_LABEL,
        );
        let default_plist = super::render_launch_agent_plist_with_optional_env(&config, |_| None);
        assert!(!default_plist.contains("OPENSCOUT_JETSTREAM_"));

        let plist = super::render_launch_agent_plist_with_optional_env(&config, |key| match key {
            "OPENSCOUT_JETSTREAM_ENABLED" => Some("1".into()),
            "OPENSCOUT_JETSTREAM_PORT" => Some("43150".into()),
            "OPENSCOUT_JETSTREAM_HOME" => Some("/data/scout & events".into()),
            "OPENSCOUT_JETSTREAM_START" => Some("now".into()),
            _ => None,
        });
        assert!(plist.contains("<key>OPENSCOUT_JETSTREAM_ENABLED</key>\n    <string>1</string>"));
        assert!(plist.contains("<key>OPENSCOUT_JETSTREAM_PORT</key>\n    <string>43150</string>"));
        assert!(plist.contains(
            "<key>OPENSCOUT_JETSTREAM_HOME</key>\n    <string>/data/scout &amp; events</string>"
        ));
        assert!(plist.contains("<key>OPENSCOUT_JETSTREAM_START</key>\n    <string>now</string>"));
        assert!(!plist.contains("<key>OPENSCOUT_JETSTREAM_MANAGE_SERVER</key>"));
    }

    #[test]
    fn launch_agent_preserves_external_session_cli_configuration() {
        let config = test_config(
            "/stable/packages/cli",
            "/stable/packages/cli/bin/scoutd",
            SHARED_SERVICE_LABEL,
        );
        let default_plist = super::render_launch_agent_plist_with_optional_env(&config, |_| None);
        assert!(!default_plist.contains("OPENSCOUT_EXTERNAL_SESSION_CONNECTIONS"));
        assert!(!default_plist.contains("OPENSCOUT_DEVIN_CLI_BIN"));

        let connections = r#"[{"id":"devin-cloud-cli","deliveryMode":"cloud_cli"}]"#;
        let plist = super::render_launch_agent_plist_with_optional_env(&config, |key| match key {
            "OPENSCOUT_EXTERNAL_SESSION_CONNECTIONS" => Some(connections.into()),
            "OPENSCOUT_DEVIN_CLI_BIN" => Some("/tools/Devin & Scout/devin".into()),
            _ => None,
        });
        assert!(plist.contains(&format!(
            "<key>OPENSCOUT_EXTERNAL_SESSION_CONNECTIONS</key>\n    <string>{}</string>",
            super::xml_escape(connections)
        )));
        assert!(plist.contains(
            "<key>OPENSCOUT_DEVIN_CLI_BIN</key>\n    <string>/tools/Devin &amp; Scout/devin</string>"
        ));
    }

    #[test]
    fn shared_launch_agent_preserves_its_existing_runtime_owner() {
        let config = test_config(
            "/stable/packages/cli",
            "/stable/packages/cli/bin/scoutd",
            SHARED_SERVICE_LABEL,
        );
        let same_owner = owner_plist(
            Some("/stable/packages/cli"),
            "/stable/packages/cli/bin/older-scoutd",
        );
        assert!(launch_agent_owner_compatible(&config, &same_owner, false).is_ok());

        let other_owner = owner_plist(
            Some("/worktrees/experiment/packages/cli"),
            "/worktrees/experiment/packages/cli/bin/scoutd",
        );
        let error = launch_agent_owner_compatible(&config, &other_owner, false)
            .expect_err("cross-owner takeover must fail");
        assert!(error.contains("refusing to repoint shared Scout service"));
        assert!(error.contains(ALLOW_SHARED_SERVICE_REPOINT_ENV));
    }

    #[test]
    fn shared_launch_agent_allows_explicit_transfer_and_isolated_labels() {
        let shared = test_config(
            "/stable/packages/cli",
            "/stable/packages/cli/bin/scoutd",
            SHARED_SERVICE_LABEL,
        );
        let other_owner = owner_plist(
            Some("/worktrees/experiment/packages/cli"),
            "/worktrees/experiment/packages/cli/bin/scoutd",
        );
        assert!(launch_agent_owner_compatible(&shared, &other_owner, true).is_ok());

        let isolated = test_config(
            "/worktrees/experiment/packages/cli",
            "/worktrees/experiment/packages/cli/bin/scoutd",
            "app.openscout.experiment",
        );
        assert!(launch_agent_owner_compatible(&isolated, &other_owner, false).is_ok());
    }

    #[test]
    fn shared_launch_agent_recognizes_legacy_owner_by_daemon_path() {
        let config = test_config(
            "/stable/packages/cli",
            "/stable/packages/cli/bin/scoutd",
            SHARED_SERVICE_LABEL,
        );
        let legacy = owner_plist(None, "/stable/packages/cli/bin/scoutd");
        assert!(launch_agent_owner_compatible(&config, &legacy, false).is_ok());
    }

    #[test]
    fn push_relay_uses_keychain_session_without_persisting_it_in_launchd_config() {
        let environment = resolve_push_relay_child_environment(
            None,
            None,
            None,
            Some("osn_session_private".to_string()),
        );

        assert_eq!(
            environment,
            vec![
                (
                    "OPENSCOUT_PUSH_RELAY_URL",
                    DEFAULT_OPENSCOUT_PUSH_RELAY_URL.to_string(),
                ),
                (
                    "OPENSCOUT_PUSH_RELAY_SESSION",
                    "osn_session_private".to_string(),
                ),
            ]
        );
    }

    #[test]
    fn push_relay_explicit_environment_overrides_keychain_defaults() {
        let environment = resolve_push_relay_child_environment(
            Some("https://push.example.test".to_string()),
            Some("explicit-session".to_string()),
            Some("mesh-private".to_string()),
            Some("keychain-session".to_string()),
        );

        assert_eq!(
            environment,
            vec![
                (
                    "OPENSCOUT_PUSH_RELAY_URL",
                    "https://push.example.test".to_string(),
                ),
                (
                    "OPENSCOUT_PUSH_RELAY_SESSION",
                    "explicit-session".to_string(),
                ),
                ("OPENSCOUT_PUSH_RELAY_MESH_ID", "mesh-private".to_string(),),
            ]
        );
    }

    #[test]
    fn push_relay_is_disabled_without_a_session() {
        assert!(resolve_push_relay_child_environment(None, None, None, None).is_empty());
    }

    #[test]
    fn connected_health_timeout_is_not_unreachable_or_ready() {
        let (mut client, _server) = std::os::unix::net::UnixStream::pair().unwrap();
        let health = super::read_http_health(
            &mut client,
            "localhost",
            std::time::Duration::from_millis(20),
        )
        .unwrap();
        assert!(health.reachable);
        assert!(!health.ok);
        assert_eq!(health.state, "timed_out");
        assert!(health.duration_ms < 500);
        let json: serde_json::Value = serde_json::from_str(&super::health_json(&health)).unwrap();
        assert_eq!(
            json["checkedAt"].as_u64().unwrap() as u128,
            health.checked_at
        );
        assert_eq!(json["state"], "timed_out");
    }

    #[test]
    fn health_deadline_bounds_a_dribbling_response_and_recovers() {
        use std::io::{Read, Write};
        let (mut client, mut server) = std::os::unix::net::UnixStream::pair().unwrap();
        let writer = std::thread::spawn(move || {
            let mut request = [0; 1024];
            assert!(server.read(&mut request).unwrap() > 0);
            for _ in 0..20 {
                if server.write_all(b"x").is_err() {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
        });
        let health = super::read_http_health(
            &mut client,
            "localhost",
            std::time::Duration::from_millis(30),
        )
        .unwrap();
        assert_eq!(health.state, "timed_out");
        assert!(!health.ok);
        assert!(health.duration_ms < 500);
        drop(client);
        writer.join().unwrap();

        let (mut client, mut server) = std::os::unix::net::UnixStream::pair().unwrap();
        let writer = std::thread::spawn(move || {
            let mut request = [0; 1024];
            assert!(server.read(&mut request).unwrap() > 0);
            server
                .write_all(b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n{\"ok\":true}")
                .unwrap();
        });
        let health = super::read_http_health(
            &mut client,
            "localhost",
            std::time::Duration::from_millis(500),
        )
        .unwrap();
        assert!(health.ok, "{health:?}");
        assert_eq!(health.state, "healthy");
        writer.join().unwrap();
    }

    #[test]
    fn health_decodes_chunked_json_and_rejects_incomplete_framing() {
        let response =
            "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nb\r\n{\"ok\":true}\r\n0\r\n\r\n";
        let health = parse_health_response(response).unwrap();
        assert!(health.ok);
        assert_eq!(health.body.as_deref(), Some(r#"{"ok":true}"#));
        let truncated = response.trim_end_matches("0\r\n\r\n");
        let health = parse_health_response(truncated).unwrap();
        assert!(!health.ok);
        assert!(health.reachable);
        assert_eq!(health.state, "degraded");
        let health =
            parse_health_response("HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n{\"ok\":true}")
                .unwrap();
        assert!(!health.ok);
    }

    #[test]
    fn health_requires_valid_top_level_readiness() {
        assert!(!health_body_reports_ok(
            r#"{"nested":{"ok":true},"ok":false}"#
        ));
        assert!(!health_body_reports_ok(r#"{"ok":trueish}"#));
        let health =
            parse_health_response("HTTP/1.1 503 Unavailable\r\n\r\n{\"ok\":true}").unwrap();
        assert!(health.reachable);
        assert!(!health.ok);
        assert_eq!(health.state, "degraded");
    }

    #[test]
    fn health_body_reports_ok_accepts_compact_and_pretty_json() {
        assert!(health_body_reports_ok(r#"{"ok":true}"#));
        assert!(health_body_reports_ok(
            r#"{
  "ok": true,
  "status": "ready"
}"#
        ));
    }

    #[test]
    fn health_body_reports_ok_rejects_missing_or_false_values() {
        assert!(!health_body_reports_ok(r#"{"ok":false}"#));
        assert!(!health_body_reports_ok(r#"{"status":"ready"}"#));
    }

    #[test]
    fn parse_health_response_marks_pretty_ok_body_healthy() {
        let response =
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\n  \"ok\": true\n}";
        let health = parse_health_response(response).expect("health response parses");

        assert!(health.reachable);
        assert!(health.ok);
        assert_eq!(health.status_code, Some(200));
    }

    #[test]
    fn parse_http_status_code_reads_status_line() {
        assert_eq!(
            parse_http_status_code("HTTP/1.1 202 Accepted\r\ncontent-length: 0\r\n\r\n"),
            Some(202)
        );
        assert_eq!(parse_http_status_code("not an http response"), None);
    }

    #[test]
    fn repo_watch_warm_path_is_a_runtime_nudge() {
        assert_eq!(REPO_WATCH_WARM_PATH, "/v1/repo-watch/warm");
    }

    #[test]
    fn osn_enabled_overrides_stale_local_network_env() {
        let scope = resolve_advertise_scope_value(true, Some("local".to_string()));
        let host = resolve_broker_host_value(&scope, Some("127.0.0.1".to_string()));
        let url = resolve_broker_url_value(
            &scope,
            &host,
            65_535,
            Some("http://127.0.0.1:65535".to_string()),
        );

        assert_eq!(scope, "mesh");
        assert_eq!(host, DEFAULT_BROKER_HOST_MESH);
        assert_eq!(url, "http://0.0.0.0:65535");
    }

    #[test]
    fn mesh_scope_keeps_non_loopback_explicit_host_and_url() {
        let host = resolve_broker_host_value("mesh", Some("100.64.0.10".to_string()));
        let url = resolve_broker_url_value(
            "mesh",
            &host,
            65_535,
            Some("http://mini.tailnet.test:65535".to_string()),
        );

        assert_eq!(host, "100.64.0.10");
        assert_eq!(url, "http://mini.tailnet.test:65535");
    }

    #[test]
    fn primary_legacy_service_labels_include_previous_dev_and_prod_jobs() {
        let config = test_config(
            "/repo/packages/runtime",
            "/repo/packages/cli/bin/scoutd",
            SHARED_SERVICE_LABEL,
        );

        assert_eq!(
            legacy_service_labels(&config),
            vec![
                "dev.openscout".to_string(),
                "com.openscout".to_string(),
                "dev.openscout.broker".to_string(),
                "dev.openscout.broker-fallback".to_string(),
                "com.openscout.broker".to_string(),
            ]
        );
        assert_eq!(
            legacy_service_targets(&config),
            vec![
                "gui/501/dev.openscout".to_string(),
                "gui/501/com.openscout".to_string(),
                "gui/501/dev.openscout.broker".to_string(),
                "gui/501/dev.openscout.broker-fallback".to_string(),
                "gui/501/com.openscout.broker".to_string(),
            ]
        );
    }

    #[test]
    fn command_invokes_scoutd_daemon_only_matches_daemon_commands() {
        assert!(command_invokes_scoutd_daemon(
            "/Users/arach/dev/openscout/target/debug/scoutd supervise"
        ));
        assert!(!command_invokes_scoutd_daemon(
            "target/debug/scoutd doctor --json"
        ));
        assert!(!command_invokes_scoutd_daemon("scoutd status --json"));
    }

    #[test]
    fn command_invokes_scoutd_daemon_matches_legacy_supervisor_name() {
        // Legacy-name compatibility: a still-running pre-rename daemon must be
        // recognized so doctor's orphan/duplicate warnings include it.
        assert!(command_invokes_scoutd_daemon(
            "/usr/local/bin/openscout-supervisor supervise"
        ));
        assert!(command_invokes_scoutd_daemon(
            "openscout-supervisor supervise"
        ));
        assert!(!command_invokes_scoutd_daemon(
            "openscout-supervisor status --json"
        ));
    }

    #[test]
    fn process_snapshot_filter_matches_legacy_supervisor_name() {
        assert!(process_snapshot_filter(
            "/usr/local/bin/openscout-supervisor supervise"
        ));
        assert!(process_snapshot_filter("scoutd supervise"));
        assert!(!process_snapshot_filter("/bin/zsh -l"));
    }

    #[test]
    fn process_snapshot_filter_matches_openscout_pairing_advertisements() {
        let command = "/usr/bin/dns-sd -R OpenScout abc123 _oscout-pair._tcp local. 43131 v=1";
        assert!(process_snapshot_filter(command));
        assert_eq!(
            openscout_pairing_advertisement_key(command).as_deref(),
            Some("abc123:43131")
        );
        assert!(openscout_pairing_advertisement_key(
            "/usr/bin/dns-sd -R Talkie Bridge _talkie-bridge._tcp local. 8765"
        )
        .is_none());
    }

    #[test]
    fn elapsed_seconds_parses_ps_elapsed_shapes() {
        assert_eq!(elapsed_seconds("04:12"), Some(252));
        assert_eq!(elapsed_seconds("03:04:12"), Some(11_052));
        assert_eq!(elapsed_seconds("02-03:04:12"), Some(183_852));
        assert_eq!(elapsed_seconds("bad"), None);
    }

    #[test]
    fn stale_pairing_advertisements_require_a_live_replacement() {
        let process = |pid, ppid, elapsed: &str, fingerprint: &str| ProcessInfo {
            pid,
            ppid,
            pcpu: "0.0".to_string(),
            pmem: "0.0".to_string(),
            elapsed: elapsed.to_string(),
            command: format!(
                "/usr/bin/dns-sd -R OpenScout {fingerprint} _oscout-pair._tcp local. 43131 v=1"
            ),
        };
        let processes = vec![
            process(10, 200, "00:30", "current"),
            process(11, 1, "01-00:00:00", "current"),
            process(12, 1, "01-00:00:00", "only-orphan"),
            process(13, 1, "00:30", "current"),
        ];

        assert_eq!(stale_pairing_advertisement_pids(&processes), vec![11]);
    }

    #[test]
    fn managed_capture_lease_requires_exact_process_markers() {
        let profile_dir = env::temp_dir().join("openscout-web-capture-test-profile");
        let lease = ManagedProcessLease {
            version: 1,
            kind: "web_capture".to_string(),
            pid: 200,
            process_group_id: 200,
            profile_dir: profile_dir.clone(),
            _output_path: PathBuf::new(),
            _created_at_ms: 0,
            expires_at_ms: 1,
        };
        let command = format!(
            "/Applications/Google Chrome --headless=new --screenshot=/tmp/page.png --user-data-dir={}",
            profile_dir.display(),
        );

        assert!(super::lease_matches_process(&lease, 200, &command));
        assert!(!super::lease_matches_process(&lease, 201, &command));
        assert!(!super::lease_matches_process(
            &lease,
            200,
            "/Applications/Google Chrome --headless=new --screenshot=/tmp/page.png",
        ));
        assert!(!super::safe_capture_profile(
            &env::temp_dir()
                .join("..")
                .join("openscout-web-capture-escape")
        ));
    }

    #[test]
    fn build_identity_reports_package_version() {
        assert!(build_identity_text().starts_with(&format!("{DAEMON_NAME} {BUILD_VERSION}")));
        assert!(build_identity_json().contains(&format!(r#""version":"{BUILD_VERSION}""#)));
        assert!(build_identity_json().contains(r#""gitSha":"#));
    }

    #[test]
    fn runtime_commit_comparison_accepts_full_and_short_git_ids() {
        assert!(commits_match("abcdef1234567890", "abcdef1"));
        assert!(commits_match("abcdef1", "abcdef1234567890"));
        assert!(!commits_match("abcdef1", "1234567"));
    }

    #[test]
    fn daemon_state_runtime_identity_round_trips() {
        let state = r#"{"runtimeBuild":{"mode":"bundle","commit":"abcdef1","version":"0.2.73","sourceDirty":false,"builtAt":"2026-07-15T20:00:00.000Z","manifestPath":"/opt/openscout/dist/build-manifest.json"}}"#;
        let identity = running_runtime_artifact(Some(state)).expect("runtime identity");
        assert_eq!(identity.mode, "bundle");
        assert_eq!(identity.commit.as_deref(), Some("abcdef1"));
        assert_eq!(identity.source_dirty, Some(false));
    }

    fn runtime_artifact(
        mode: &str,
        commit: Option<&str>,
        built_at: Option<&str>,
        source_dirty: Option<bool>,
    ) -> RuntimeArtifactIdentity {
        RuntimeArtifactIdentity {
            mode: mode.to_string(),
            commit: commit.map(str::to_string),
            version: Some("0.2.78".to_string()),
            source_dirty,
            built_at: built_at.map(str::to_string),
            manifest_path: (mode == "bundle")
                .then(|| "/opt/openscout/dist/build-manifest.json".to_string()),
        }
    }

    #[test]
    fn foreign_service_owner_is_never_reported_stale() {
        let stale = evaluate_runtime_freshness(
            RuntimeArtifactIdentity {
                mode: "bundle".to_string(),
                commit: Some("new".to_string()),
                version: None,
                source_dirty: None,
                built_at: None,
                manifest_path: None,
            },
            Some(RuntimeArtifactIdentity {
                mode: "bundle".to_string(),
                commit: Some("old".to_string()),
                version: None,
                source_dirty: None,
                built_at: None,
                manifest_path: None,
            }),
            None,
            None,
        );
        assert_eq!(stale.state, "stale");
        let foreign = freshness_for_foreign_owner(stale);
        assert_eq!(foreign.state, "unverified");
        assert_eq!(
            foreign.reason_code.as_deref(),
            Some("foreign_service_owner")
        );
    }

    #[test]
    fn runtime_freshness_marks_installed_artifact_update_stale_before_restart() {
        let freshness = evaluate_runtime_freshness(
            runtime_artifact(
                "bundle",
                Some("new-runtime-commit"),
                Some("2026-08-02T12:00:00.000Z"),
                Some(false),
            ),
            Some(runtime_artifact(
                "bundle",
                Some("old-runtime-commit"),
                Some("2026-08-01T12:00:00.000Z"),
                Some(false),
            )),
            None,
            None,
        );

        assert_eq!(freshness.state, "stale");
        assert!(!freshness.intentional);
        assert_eq!(freshness.basis, "installed_artifact");
        assert_eq!(
            freshness.expected_commit.as_deref(),
            Some("new-runtime-commit")
        );
        assert_eq!(freshness.reason_code, None);
        assert_eq!(
            freshness.actual_built_at.as_deref(),
            Some("2026-08-01T12:00:00.000Z")
        );
        assert_eq!(
            freshness.expected_built_at.as_deref(),
            Some("2026-08-02T12:00:00.000Z")
        );
    }

    #[test]
    fn runtime_freshness_marks_same_commit_installed_artifact_rebuild_stale() {
        let freshness = evaluate_runtime_freshness(
            runtime_artifact(
                "bundle",
                Some("same-runtime-commit"),
                Some("2026-08-02T12:00:00.000Z"),
                Some(false),
            ),
            Some(runtime_artifact(
                "bundle",
                Some("same-runtime-commit"),
                Some("2026-08-01T12:00:00.000Z"),
                Some(false),
            )),
            None,
            None,
        );

        assert_eq!(freshness.state, "stale");
        assert_eq!(freshness.basis, "installed_artifact");
        assert!(freshness.detail.contains("newer bundle"));
        assert_eq!(
            freshness.actual_built_at.as_deref(),
            Some("2026-08-01T12:00:00.000Z")
        );
        assert_eq!(
            freshness.expected_built_at.as_deref(),
            Some("2026-08-02T12:00:00.000Z")
        );
        assert_eq!(freshness.built_at, freshness.actual_built_at);
        let serialized = serde_json::to_value(&freshness).expect("serialize freshness");
        assert_eq!(serialized["actualBuiltAt"], "2026-08-01T12:00:00.000Z");
        assert_eq!(serialized["expectedBuiltAt"], "2026-08-02T12:00:00.000Z");
    }

    #[test]
    fn runtime_freshness_does_not_downgrade_same_commit_bundle() {
        let freshness = evaluate_runtime_freshness(
            runtime_artifact(
                "bundle",
                Some("same-runtime-commit"),
                Some("2026-08-01T12:00:00.000Z"),
                Some(false),
            ),
            Some(runtime_artifact(
                "bundle",
                Some("same-runtime-commit"),
                Some("2026-08-02T12:00:00.000Z"),
                Some(false),
            )),
            None,
            None,
        );

        assert_eq!(freshness.state, "unverified");
        assert_eq!(
            freshness.reason_code.as_deref(),
            Some("expected_build_older_than_running")
        );
        assert!(freshness.detail.contains("will not downgrade"));
    }

    #[test]
    fn runtime_freshness_rejects_incomparable_same_commit_build_timestamps() {
        let freshness = evaluate_runtime_freshness(
            runtime_artifact(
                "bundle",
                Some("same-runtime-commit"),
                Some("not-a-timestamp"),
                Some(false),
            ),
            Some(runtime_artifact(
                "bundle",
                Some("same-runtime-commit"),
                Some("2026-08-01T12:00:00.000Z"),
                Some(false),
            )),
            None,
            None,
        );

        assert_eq!(freshness.state, "unverified");
        assert_eq!(
            freshness.reason_code.as_deref(),
            Some("build_timestamp_incomparable")
        );
    }

    #[test]
    fn runtime_freshness_marks_matching_explicit_pin_intentional() {
        let freshness = evaluate_runtime_freshness(
            runtime_artifact(
                "bundle",
                Some("configured-runtime-commit"),
                Some("2026-08-02T12:00:00.000Z"),
                Some(false),
            ),
            Some(runtime_artifact(
                "bundle",
                Some("pinned-runtime-commit"),
                Some("2026-08-01T12:00:00.000Z"),
                Some(false),
            )),
            Some("pinned-runtime-commit".to_string()),
            Some("bisecting a regression".to_string()),
        );

        assert_eq!(freshness.state, "pinned");
        assert!(freshness.intentional);
        assert_eq!(freshness.basis, "explicit_pin");
        assert_eq!(freshness.reason_code, None);
    }

    #[test]
    fn runtime_freshness_keeps_explicit_pin_mismatch_unverified() {
        let freshness = evaluate_runtime_freshness(
            runtime_artifact(
                "bundle",
                Some("configured-runtime-commit"),
                Some("2026-08-02T12:00:00.000Z"),
                Some(false),
            ),
            Some(runtime_artifact(
                "bundle",
                Some("running-runtime-commit"),
                Some("2026-08-01T12:00:00.000Z"),
                Some(false),
            )),
            Some("pinned-runtime-commit".to_string()),
            Some("operator hold".to_string()),
        );

        assert_eq!(freshness.state, "unverified");
        assert!(!freshness.intentional);
        assert_eq!(freshness.basis, "explicit_pin");
        assert_eq!(freshness.reason_code.as_deref(), Some("pin_mismatch"));
        assert!(freshness.detail.contains("will not override"));
        let serialized = serde_json::to_value(&freshness).expect("serialize freshness");
        assert_eq!(serialized["reasonCode"], "pin_mismatch");
    }

    #[test]
    fn runtime_freshness_keeps_missing_commit_unverified() {
        let freshness = evaluate_runtime_freshness(
            runtime_artifact("bundle", None, None, None),
            Some(runtime_artifact(
                "bundle",
                Some("running-runtime-commit"),
                Some("2026-08-01T12:00:00.000Z"),
                Some(false),
            )),
            None,
            None,
        );

        assert_eq!(freshness.state, "unverified");
        assert!(!freshness.intentional);
        assert_eq!(freshness.basis, "installed_artifact");
        assert_eq!(freshness.expected_commit, None);
    }

    #[test]
    fn runtime_freshness_keeps_blank_commit_unverified() {
        let freshness = evaluate_runtime_freshness(
            runtime_artifact("bundle", Some("   "), None, Some(false)),
            Some(runtime_artifact(
                "bundle",
                Some("running-runtime-commit"),
                Some("2026-08-01T12:00:00.000Z"),
                Some(false),
            )),
            None,
            None,
        );

        assert_eq!(freshness.state, "unverified");
        assert_eq!(freshness.expected_commit.as_deref(), Some("   "));
    }

    #[test]
    fn runtime_freshness_does_not_alias_expected_timestamp_as_running() {
        let freshness = evaluate_runtime_freshness(
            runtime_artifact(
                "bundle",
                Some("configured-runtime-commit"),
                Some("2026-08-02T12:00:00.000Z"),
                Some(false),
            ),
            None,
            None,
            None,
        );

        assert_eq!(freshness.state, "unverified");
        assert_eq!(freshness.actual_built_at, None);
        assert_eq!(freshness.built_at, None);
        assert_eq!(
            freshness.expected_built_at.as_deref(),
            Some("2026-08-02T12:00:00.000Z")
        );
    }

    #[test]
    fn runtime_freshness_keeps_dirty_source_checkout_unverified() {
        let freshness = evaluate_runtime_freshness(
            runtime_artifact("source", Some("workspace-head"), None, Some(true)),
            Some(runtime_artifact(
                "source",
                Some("workspace-head"),
                None,
                Some(true),
            )),
            None,
            None,
        );

        assert_eq!(freshness.state, "unverified");
        assert_eq!(freshness.basis, "workspace_head");
    }

    #[test]
    fn parse_daemon_state_telemetry_reads_restart_fields() {
        let telemetry = parse_daemon_state_telemetry(
            r#"{"baseState":"running","restartCount":2,"restartBackoffMs":4000,"lastChildExit":{"atMs":123,"code":1,"signal":null,"description":"exit status: 1"}}"#,
        );

        assert_eq!(telemetry.base_state.as_deref(), Some("running"));
        assert_eq!(telemetry.restart_count, Some(2));
        assert_eq!(telemetry.restart_backoff_ms, Some(4000));
        assert_eq!(
            telemetry.last_child_exit_description.as_deref(),
            Some("exit status: 1")
        );
        assert_eq!(telemetry.last_child_exit_code, Some(1));
        assert_eq!(telemetry.last_child_exit_signal, None);
    }

    #[test]
    fn restart_telemetry_warnings_include_backoff_and_exit_context() {
        let warnings = restart_telemetry_warnings(
            r#"{"baseState":"exited","restartCount":1,"restartBackoffMs":1000,"lastChildExit":{"atMs":123,"code":null,"signal":9,"description":"signal: 9"}}"#,
        );

        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("restartCount=1"));
        assert!(warnings[0].contains("baseState=exited"));
        assert!(warnings[0].contains("restartBackoffMs=1000"));
        assert!(warnings[0].contains("lastChildExit=signal: 9"));
        assert!(warnings[0].contains("signal=9"));
    }

    #[test]
    fn restart_telemetry_warnings_ignore_quiet_state() {
        let warnings = restart_telemetry_warnings(
            r#"{"baseState":"running","restartCount":0,"restartBackoffMs":1000,"lastChildExit":null}"#,
        );

        assert!(warnings.is_empty());
    }

    fn unique_temp_path(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0);
        env::temp_dir().join(format!("scoutd-test-{name}-{nanos}.log"))
    }

    #[test]
    fn read_last_log_line_from_returns_trimmed_last_nonempty_line() {
        let path = unique_temp_path("small");
        fs::write(&path, "first line\nsecond line\n  \n").expect("write log");
        let line = read_last_log_line_from(&path);
        let _ = fs::remove_file(&path);
        assert_eq!(line.as_deref(), Some("second line"));
    }

    #[test]
    fn read_last_log_line_from_reads_only_a_bounded_tail() {
        let path = unique_temp_path("large");
        // Build a file much larger than the tail window so the early lines fall
        // outside it; only the final line should be returned.
        let filler = "x".repeat(200);
        let mut contents = String::new();
        while contents.len() < (LOG_TAIL_WINDOW as usize) * 3 {
            contents.push_str(&filler);
            contents.push('\n');
        }
        contents.push_str("final marker line\n");
        fs::write(&path, &contents).expect("write large log");

        let line = read_last_log_line_from(&path);
        let _ = fs::remove_file(&path);
        assert_eq!(line.as_deref(), Some("final marker line"));
    }

    #[test]
    fn read_last_log_line_from_handles_non_utf8_bytes() {
        let path = unique_temp_path("non-utf8");
        // Invalid UTF-8 (0xFF) on an earlier line, valid final line.
        let mut bytes = b"corrupt \xff line\n".to_vec();
        bytes.extend_from_slice(b"good final line\n");
        fs::write(&path, &bytes).expect("write non-utf8 log");

        let line = read_last_log_line_from(&path);
        let _ = fs::remove_file(&path);
        assert_eq!(line.as_deref(), Some("good final line"));
    }

    #[test]
    fn rotate_child_log_if_needed_retains_tail_and_truncates_current_log() {
        let dir = unique_temp_path("rotate-dir");
        fs::create_dir_all(&dir).expect("create log dir");
        let path = dir.join("stdout.log");
        let marker = b"tail marker line\n";
        let mut contents = vec![b'x'; CHILD_LOG_ROTATE_LIMIT as usize + 32];
        contents.extend_from_slice(marker);
        fs::write(&path, &contents).expect("write large log");

        rotate_child_log_if_needed(&path, &dir).expect("rotate log");

        assert_eq!(fs::metadata(&path).expect("current log metadata").len(), 0);
        let rotated = fs::read(rotated_child_log_path(&path)).expect("read rotated log");
        assert!(rotated.len() <= CHILD_LOG_ROTATE_LIMIT as usize);
        assert!(rotated.ends_with(marker));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn unsupported_rotation_locks_warn_once_and_allow_the_existing_rotation_path() {
        let warned = std::sync::atomic::AtomicBool::new(false);
        let count = std::cell::Cell::new(0);
        for code in [libc::ENOTSUP, libc::EOPNOTSUPP, libc::ENOSYS, libc::EINVAL] {
            assert!(super::rotation_guard_allows(
                Err(std::io::Error::from_raw_os_error(code)),
                &warned,
                |_| count.set(count.get() + 1)
            ));
        }
        assert_eq!(count.get(), 1);
        assert!(!super::rotation_guard_allows(
            Err(std::io::Error::from_raw_os_error(libc::EWOULDBLOCK)),
            &warned,
            |_| panic!("contention is not an unsupported lock")
        ));
        let root = unique_temp_path("health-unsupported-lock");
        fs::create_dir_all(&root).unwrap();
        let path = root.join("stdout.log");
        fs::write(&path, vec![b'x'; (CHILD_LOG_ROTATE_LIMIT * 2) as usize]).unwrap();
        super::rotate_child_log_with_guard(&path, &root, |_| {
            Err(std::io::Error::from_raw_os_error(libc::ENOTSUP))
        })
        .unwrap();
        assert_eq!(fs::metadata(&path).unwrap().len(), 0);
        assert_eq!(
            fs::read(rotated_child_log_path(&path)).unwrap(),
            vec![b'x'; CHILD_LOG_ROTATE_LIMIT as usize]
        );
        fs::remove_dir_all(root).unwrap();
    }

    fn rotate_child_log_eventually(path: &std::path::Path, directory: &std::path::Path) {
        // A concurrent spawn can retain a locked file description until exec,
        // even after this thread drops the handle from an earlier rotation.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        loop {
            rotate_child_log_if_needed(path, directory).unwrap();
            if fs::metadata(path).unwrap().len() == 0 {
                return;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "log rotation remained contended after dropping the lock"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }

    #[test]
    fn competing_log_rotation_skips_without_blocking_or_overwriting_the_tail() {
        use std::os::fd::AsRawFd;
        let root = unique_temp_path("health-rotation-guard");
        fs::create_dir_all(&root).unwrap();
        let path = root.join("stdout.log");
        fs::write(&path, vec![b'x'; (CHILD_LOG_ROTATE_LIMIT * 2) as usize]).unwrap();
        let held = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&path)
            .unwrap();
        assert_eq!(
            unsafe { libc::flock(held.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
            0
        );
        let start = std::time::Instant::now();
        rotate_child_log_if_needed(&path, &root).unwrap();
        assert!(start.elapsed() < std::time::Duration::from_secs(1));
        assert_eq!(held.metadata().unwrap().len(), CHILD_LOG_ROTATE_LIMIT * 2);
        assert!(!rotated_child_log_path(&path).exists());
        drop(held);
        rotate_child_log_eventually(&path, &root);
        rotate_child_log_if_needed(&path, &root).unwrap();
        assert_eq!(fs::metadata(&path).unwrap().len(), 0);
        assert_eq!(
            fs::read(rotated_child_log_path(&path)).unwrap(),
            vec![b'x'; CHILD_LOG_ROTATE_LIMIT as usize]
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn health_sweep_rotates_only_base_allowlist_and_preserves_rotation_symlink() {
        let root = unique_temp_path("health-logs");
        let dir = root.join("base");
        fs::create_dir_all(&dir).unwrap();
        let contents = vec![b'x'; CHILD_LOG_ROTATE_LIMIT as usize + 32];
        let path = dir.join("broker.stderr.log");
        fs::write(&path, &contents).unwrap();
        let user_data = root.join("keep.txt");
        fs::write(&user_data, "keep").unwrap();
        std::os::unix::fs::symlink(&user_data, rotated_child_log_path(&path)).unwrap();
        rotate_child_log_if_needed(&path, &dir).unwrap();
        assert_eq!(fs::read_to_string(&user_data).unwrap(), "keep");
        assert_eq!(fs::metadata(&path).unwrap().len(), contents.len() as u64);
        fs::remove_file(rotated_child_log_path(&path)).unwrap();
        rotate_child_log_eventually(&path, &dir);
        assert_eq!(fs::metadata(&path).unwrap().len(), 0);
        assert!(!scoutd_owned_child_log_path(&dir.join("user.log"), &dir));
        assert!(!scoutd_owned_child_log_path(
            &root.join("broker.stderr.log"),
            &root
        ));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn notification_command_uses_owned_instance_and_runtime_context_not_a_project() {
        let root = unique_temp_path("notify-command");
        fs::create_dir_all(root.join("bin")).unwrap();
        fs::write(root.join("bin/scout.mjs"), "").unwrap();
        let mut config = test_config("/nonexistent-runtime", "/nonexistent-scoutd", "scoutd.test");
        config.runtime_package_dir = root.clone();
        config.runtime_directory = root.join("run");
        let command =
            super::health_observations::operator_notify_command(&config, "cause and action")
                .unwrap();
        let args: Vec<_> = command
            .get_args()
            .map(|s| s.to_string_lossy().into_owned())
            .collect();
        assert!(args
            .windows(3)
            .any(|a| a == ["notify", "--as", "scoutd-health"]));
        assert!(args
            .windows(2)
            .any(|a| a == ["--cwd", config.runtime_directory.to_str().unwrap()]));
        assert_eq!(
            command.get_current_dir(),
            Some(config.runtime_directory.as_path())
        );
        assert!(command
            .get_envs()
            .any(|(key, value)| key == "OPENSCOUT_CLIENT_INSTANCE" && value.is_none()));
        assert!(!args.iter().any(|a| a == "install" || a == "restart"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn full_disk_log_rotation_reclaims_owned_space_but_other_errors_do_not() {
        let path = unique_temp_path("emergency-log");
        fs::write(&path, "owned log").unwrap();
        let file = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&path)
            .unwrap();
        let mut attempts = 0;
        super::retain_or_reclaim_log(&file, || {
            attempts += 1;
            if attempts == 1 {
                Err(std::io::Error::from_raw_os_error(libc::ENOSPC))
            } else {
                Ok(())
            }
        })
        .unwrap();
        assert_eq!(attempts, 2);
        assert_eq!(file.metadata().unwrap().len(), 0);
        fs::write(&path, "keep").unwrap();
        assert!(
            super::retain_or_reclaim_log(&file, || Err(std::io::Error::from_raw_os_error(
                libc::EACCES
            )))
            .is_err()
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), "keep");
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn log_tail_retry_rewinds_after_partial_enospc_write() {
        let root = unique_temp_path("health-partial-tail");
        fs::create_dir_all(&root).unwrap();
        let source = fs::File::create(root.join("active")).unwrap();
        let mut rotated = fs::File::create(root.join("rotated")).unwrap();
        let mut first = true;
        super::retain_or_reclaim_log(&source, || {
            if first {
                first = false;
                use std::io::Write;
                rotated.write_all(b"partial").unwrap();
                Err(std::io::Error::from_raw_os_error(libc::ENOSPC))
            } else {
                super::write_log_tail(&mut rotated, b"retained tail")
            }
        })
        .unwrap();
        assert_eq!(fs::read(root.join("rotated")).unwrap(), b"retained tail");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn emergency_health_reserve_is_scout_owned_and_never_follows_links() {
        let root = unique_temp_path("health-reserve");
        fs::create_dir_all(&root).unwrap();
        let mut config = test_config("/nonexistent-runtime", "/nonexistent-scoutd", "scoutd.test");
        config.runtime_directory = root.clone();
        super::prepare_health_reserve(&config);
        let path = root.join("scoutd-health-reserve.tmp");
        assert_eq!(fs::metadata(&path).unwrap().len(), 65536);
        assert!(super::release_health_reserve(&config));
        assert!(!path.exists());
        let user = root.join("keep.txt");
        fs::write(&user, "keep").unwrap();
        std::os::unix::fs::symlink(&user, &path).unwrap();
        super::prepare_health_reserve(&config);
        assert!(!super::release_health_reserve(&config));
        assert_eq!(fs::read_to_string(user).unwrap(), "keep");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn health_sweep_publication_is_atomic_and_does_not_follow_existing_temp_files() {
        let root = unique_temp_path("health-publication");
        fs::create_dir_all(&root).unwrap();
        let mut config = test_config("/nonexistent-runtime", "/nonexistent-scoutd", "scoutd.test");
        config.runtime_directory = root.clone();
        let sweep = super::health_sweep::Sweep::default();
        super::publish_health_sweep(&config, &sweep).unwrap();
        let value: serde_json::Value =
            serde_json::from_str(&super::health_sweep_json(&config)).unwrap();
        assert!(value["conditions"].as_array().unwrap().is_empty());
        let user = root.join("keep.txt");
        fs::write(&user, "keep").unwrap();
        let temp = super::health_stage_path(&config);
        std::os::unix::fs::symlink(&user, temp).unwrap();
        assert!(super::publish_health_sweep(&config, &sweep).is_err());
        assert_eq!(fs::read_to_string(user).unwrap(), "keep");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rotation_does_not_truncate_active_symlinks_or_hardlinks() {
        let root = unique_temp_path("health-log-links");
        fs::create_dir_all(&root).unwrap();
        let user = root.join("keep.txt");
        let contents = vec![b'x'; CHILD_LOG_ROTATE_LIMIT as usize + 32];
        fs::write(&user, &contents).unwrap();
        let log = root.join("stderr.log");
        std::os::unix::fs::symlink(&user, &log).unwrap();
        rotate_child_log_if_needed(&log, &root).unwrap();
        assert_eq!(fs::read(&user).unwrap(), contents);
        fs::remove_file(&log).unwrap();
        fs::hard_link(&user, &log).unwrap();
        rotate_child_log_if_needed(&log, &root).unwrap();
        assert_eq!(fs::read(&user).unwrap(), contents);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rotate_child_log_if_needed_ignores_unowned_log_names() {
        let dir = unique_temp_path("rotate-ignore-dir");
        fs::create_dir_all(&dir).expect("create log dir");
        let path = dir.join("other.log");
        let contents = vec![b'x'; CHILD_LOG_ROTATE_LIMIT as usize + 32];
        fs::write(&path, &contents).expect("write large log");

        rotate_child_log_if_needed(&path, &dir).expect("skip unowned log");

        assert_eq!(
            fs::metadata(&path).expect("current log metadata").len(),
            contents.len() as u64
        );
        assert!(!rotated_child_log_path(&path).exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn scoutd_owned_child_log_path_accepts_only_expected_child_logs() {
        let dir = PathBuf::from("/Users/example/Library/Application Support/OpenScout/logs/broker");

        assert!(scoutd_owned_child_log_path(&dir.join("stdout.log"), &dir));
        assert!(scoutd_owned_child_log_path(&dir.join("stderr.log"), &dir));
        assert!(!scoutd_owned_child_log_path(&dir.join("other.log"), &dir));
        assert!(!scoutd_owned_child_log_path(
            &dir.join("nested/stdout.log"),
            &dir
        ));
    }

    #[test]
    fn legacy_daemon_name_is_pre_rename_binary() {
        assert_eq!(LEGACY_DAEMON_NAME, "openscout-supervisor");
    }
}
