//! Host observations and conservative maintenance. No discovered pid is signalled.
use super::{
    health_sweep::{self, Finding, Observation, ServiceObservation},
    Config,
};
use serde_json::Value;
use std::{
    env,
    fs::{self, OpenOptions},
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

pub const SLOW_INTERVAL: Duration = Duration::from_secs(600);
// Same surface contract as BrokerWebControlService.isHealthy. Probe only the
// loopback port reported by this instance, never a URL from remote metadata.
const WEB_HEALTH_PATH: &str = "/api/health";
#[derive(Default)]
pub struct Collector {
    level: u8,
    consumers: Vec<String>,
}
impl Collector {
    pub fn observe(
        &mut self,
        config: &Config,
        health: Option<String>,
        slow: bool,
        now: u128,
    ) -> Observation {
        let disk = health_sweep::disk_space(&config.support_directory);
        let level = health_sweep::disk_level(disk);
        if disk.is_some() && level != self.level {
            self.consumers = if level > 0 {
                top_consumers(config)
            } else {
                Vec::new()
            };
            self.level = level;
        }
        let value = health
            .as_deref()
            .and_then(|s| serde_json::from_str::<Value>(s).ok());
        let web_state = value.as_ref().and_then(|v| v.pointer("/services/web"));
        let app = app_bundle(config);
        let entry = env::var_os("OPENSCOUT_WEB_SERVER_ENTRY")
            .map(PathBuf::from)
            .or_else(|| {
                read_json(&config.support_directory.join("legacy-app-services.json")).and_then(
                    |v| {
                        v.pointer("/web/entry")
                            .and_then(Value::as_str)
                            .map(PathBuf::from)
                    },
                )
            });
        let web = collect_web(
            app.is_some(),
            web_state,
            value.is_some(),
            entry.as_deref(),
            |port| web_healthy(config, port),
        );
        let pairing = pairing_home(config);
        // No listener checks unless running is the explicit persisted intent.
        let intent = read_json(&pairing.join("supervisor.json"));
        let relay_expected = intent
            .as_ref()
            .and_then(|v| v.get("desiredState"))
            .and_then(Value::as_str)
            == Some("running");
        let relay_running = !relay_expected || relay_port(config).is_some_and(listener);
        let mut findings = Vec::new();
        if slow {
            if let Some(finding) = version_skew(config) {
                findings.push(finding);
            }
            let cleanup = maintenance(config, now, boot_time_ms());
            for (id, failures) in [
                ("stale-files", cleanup.stale_errors),
                ("temp-orphans", cleanup.temp_errors),
            ] {
                if !failures.is_empty() {
                    let action = if id == "stale-files" {
                        "Remove the named stale Scout-owned pid/lock files after verifying their holders are gone"
                    } else {
                        "Remove the named orphan journal temp after verifying it has no open holder"
                    };
                    findings.push(Finding {
                        id: id.into(),
                        cause: failures.join("; "),
                        action: action.into(),
                    });
                }
            }
        }
        Observation {
            health, disk, web,
            relay: Some(ServiceObservation {
                expected: relay_expected,
                running: relay_running,
                cause: "pairing intent is running but the relay has no listener".into(),
                action: "open Scout.app and restart phone pairing; inspect pairing claim diagnostics if it remains unavailable".into(),
            }),
            top_consumers: self.consumers.clone(),
            slow: slow.then_some(findings),
        }
    }
}
fn collect_web(
    app_installed: bool,
    web_state: Option<&Value>,
    health_known: bool,
    entry: Option<&Path>,
    probe: impl FnOnce(u16) -> bool,
) -> Option<ServiceObservation> {
    if !health_known {
        return None;
    }
    let external_healthy = web_state
        .and_then(|v| v.get("port"))
        .and_then(Value::as_u64)
        .and_then(|n| u16::try_from(n).ok())
        .is_some_and(probe);
    observe_web(
        app_installed,
        web_state,
        health_known,
        entry,
        external_healthy,
    )
}
fn observe_web(
    app_installed: bool,
    web_state: Option<&Value>,
    health_known: bool,
    entry: Option<&Path>,
    external_healthy: bool,
) -> Option<ServiceObservation> {
    if !health_known {
        return None;
    }
    let expected = app_installed
        || web_state
            .and_then(|v| v.get("expected"))
            .and_then(Value::as_bool)
            == Some(true)
        || web_state
            .and_then(|v| v.get("state"))
            .and_then(Value::as_str)
            .is_some_and(|s| matches!(s, "starting" | "running" | "unavailable"));
    let running = external_healthy
        || web_state
            .and_then(|v| v.get("state"))
            .and_then(Value::as_str)
            == Some("running");
    let (cause, action) = if entry.is_none() {
        (
            "no web entry: legacy-app-services.json is missing".into(),
            "open Scout.app once".into(),
        )
    } else if !entry.as_ref().is_some_and(|p| p.is_file()) {
        (
            "configured web entry is unavailable".into(),
            "open Scout.app once".into(),
        )
    } else {
        (
            web_state
                .and_then(|s| s.get("detail"))
                .and_then(Value::as_str)
                .unwrap_or("web expected but not running")
                .into(),
            "open Scout.app and start Web".into(),
        )
    };
    Some(ServiceObservation {
        expected,
        running,
        cause,
        action,
    })
}
fn read_bounded(path: &Path, limit: u64) -> Option<Vec<u8>> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .ok()?;
    if !file.metadata().ok()?.is_file() {
        return None;
    }
    let mut data = Vec::new();
    file.take(limit + 1).read_to_end(&mut data).ok()?;
    (data.len() as u64 <= limit).then_some(data)
}
fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_slice(&read_bounded(path, 65536)?).ok()
}
fn pairing_home(config: &Config) -> PathBuf {
    env::var_os("OPENSCOUT_PAIRING_HOME")
        .map(PathBuf::from)
        .or_else(|| env::var_os("OPENSCOUT_SCOUT_HOME").map(|p| PathBuf::from(p).join("pairing")))
        .unwrap_or_else(|| {
            if super::launch_instance(&super::env_nonempty) == "prod" {
                super::home_dir().unwrap_or_default().join(".scout/pairing")
            } else {
                config.open_scout_home.join("pairing")
            }
        })
}
fn relay_port(config: &Config) -> Option<u16> {
    let ports = read_json(&config.open_scout_home.join("config.json"));
    instance_service_port(
        env::var("OPENSCOUT_PAIRING_PORT")
            .ok()
            .and_then(|s| s.parse().ok()),
        ports
            .as_ref()
            .and_then(|v| v.pointer("/ports/pairing"))
            .and_then(Value::as_u64)
            .and_then(|n| u16::try_from(n).ok()),
        super::launch_instance(&super::env_nonempty) == "prod",
        config.broker_port,
    )
    .and_then(|p| p.checked_add(1))
}
// Named instances use broker+20 for the pairing bridge, before the relay offset.
fn instance_service_port(
    explicit: Option<u16>,
    configured: Option<u16>,
    prod: bool,
    broker: u16,
) -> Option<u16> {
    explicit.or(configured).or_else(|| {
        if prod {
            Some(43130)
        } else {
            broker.checked_add(20)
        }
    })
}
fn web_healthy(config: &Config, port: u16) -> bool {
    let token = env::var("OPENSCOUT_WEB_AUTH_TOKEN").ok().or_else(|| {
        read_bounded(&config.runtime_directory.join("web-auth-token"), 4096)
            .and_then(|b| String::from_utf8(b).ok())
    });
    probe_web(port, token.as_deref())
}
fn probe_web(port: u16, token: Option<&str>) -> bool {
    let budget = Duration::from_millis(300);
    let deadline = Instant::now() + budget;
    let Ok(mut stream) =
        TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], port)), budget)
    else {
        return false;
    };
    let token = token.unwrap_or("").trim();
    if token.contains(['\r', '\n']) {
        return false;
    }
    let request = format!("GET {WEB_HEALTH_PATH} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\nConnection: close\r\n\r\n");
    let result = (|| -> std::io::Result<Vec<u8>> {
        stream.set_write_timeout(Some(budget))?;
        stream.write_all(request.as_bytes())?;
        let mut bytes = Vec::new();
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() || bytes.len() > 16384 {
                return Err(std::io::ErrorKind::TimedOut.into());
            }
            stream.set_read_timeout(Some(remaining))?;
            let mut chunk = [0; 4096];
            let count = stream.read(&mut chunk)?;
            if count == 0 {
                break;
            }
            bytes.extend_from_slice(&chunk[..count]);
        }
        Ok(bytes)
    })();
    let Ok(bytes) = result else {
        return false;
    };
    let Ok(text) = String::from_utf8(bytes) else {
        return false;
    };
    super::parse_http_status_code(&text) == Some(200)
        && super::health_response_body(&text)
            .ok()
            .and_then(|body| serde_json::from_str::<Value>(&body).ok())
            .is_some_and(|v| v["ok"] == true && v["surface"] == "openscout-web")
}

fn listener(port: u16) -> bool {
    TcpStream::connect_timeout(
        &SocketAddr::from(([127, 0, 0, 1], port)),
        Duration::from_millis(200),
    )
    .is_ok()
}
fn installed_plist(config: &Config) -> Option<String> {
    String::from_utf8(read_bounded(&config.launch_agent_path, 256 * 1024)?).ok()
}
fn bundle_ancestor(path: &Path) -> Option<PathBuf> {
    path.ancestors()
        .find(|p| p.file_name().is_some_and(|n| n == "Scout.app") && p.is_dir())
        .map(Path::to_path_buf)
}
fn app_bundle(config: &Config) -> Option<PathBuf> {
    let plist = installed_plist(config);
    let bundle = plist
        .as_ref()
        .and_then(|s| super::plist_string_value(s, "OPENSCOUT_APP_BUNDLE_PATH"))
        .or_else(|| env::var("OPENSCOUT_APP_BUNDLE_PATH").ok())
        .map(PathBuf::from)
        .filter(|p| p.is_dir());
    bundle
        .or_else(|| {
            plist
                .and_then(|s| super::plist_string_value(&s, "OPENSCOUT_RUNTIME_PACKAGE_DIR"))
                .and_then(|s| bundle_ancestor(Path::new(&s)))
        })
        .or_else(|| {
            installed_plist(config)
                .and_then(|s| super::plist_program_argument(&s, 0))
                .and_then(|s| bundle_ancestor(Path::new(&s)))
        })
        .or_else(|| bundle_ancestor(&config.daemon_executable))
        .or_else(|| bundle_ancestor(&config.runtime_package_dir))
        .or_else(|| {
            Path::new("/Applications/Scout.app")
                .is_dir()
                .then(|| PathBuf::from("/Applications/Scout.app"))
        })
}
fn package_version(dir: &Path) -> Option<String> {
    read_json(&dir.join("package.json"))?
        .get("version")?
        .as_str()
        .map(str::to_owned)
}
fn cli_package(path: Option<std::ffi::OsString>) -> Option<PathBuf> {
    for dir in env::split_paths(&path?) {
        let executable = dir.join("scout");
        let metadata = fs::metadata(&executable).ok();
        if !metadata.is_some_and(|m| m.is_file() && m.mode() & 0o111 != 0) {
            continue;
        }
        // The first executable on PATH is authoritative, even if unrecognised.
        let real = fs::canonicalize(executable).ok()?;
        return real
            .ancestors()
            .skip(1)
            .take(6)
            .find(|p| {
                read_json(&p.join("package.json"))
                    .and_then(|v| v.get("name").and_then(Value::as_str).map(str::to_owned))
                    .as_deref()
                    == Some("@openscout/scout")
            })
            .map(Path::to_path_buf);
    }
    None
}
fn workspace_root(dir: &Path) -> Option<PathBuf> {
    let root = dir.parent()?.parent()?;
    let runtime = read_json(&root.join("packages/runtime/package.json"))?;
    let cli = read_json(&root.join("packages/cli/package.json"))?;
    (runtime["name"] == "@openscout/runtime"
        && cli["name"] == "@openscout/scout"
        && root.join("package.json").is_file())
    .then(|| root.to_path_buf())
}
fn version_skew(config: &Config) -> Option<Finding> {
    let service_dir = installed_plist(config)
        .and_then(|s| super::plist_string_value(&s, "OPENSCOUT_RUNTIME_PACKAGE_DIR"))
        .map(PathBuf::from)
        .unwrap_or_else(|| config.runtime_package_dir.clone());
    let cli_dir = cli_package(env::var_os("PATH"))?;
    compare_packages(&service_dir, &cli_dir)
}
fn compare_packages(service_dir: &Path, cli_dir: &Path) -> Option<Finding> {
    if let Some(workspace) = workspace_root(service_dir) {
        if workspace_root(cli_dir).is_some_and(|p| super::paths_equivalent(&p, &workspace)) {
            return None;
        }
        return Some(Finding {
            id: "version-skew".into(),
            cause: "Scout service uses a source checkout different from the CLI installation".into(),
            action: "Use the CLI from the service checkout, or review the intended service ownership before changing installations".into(),
        });
    }
    // Only compare builds of the same package. App and standalone runtime
    // versions are independent; numerical inequality is not incompatibility.
    let service = read_json(&service_dir.join("package.json"))?;
    let cli = read_json(&cli_dir.join("package.json"))?;
    if service["name"] != "@openscout/scout" || cli["name"] != service["name"] {
        return None;
    }
    let moved = !super::paths_equivalent(service_dir, cli_dir);
    let service_version = package_version(service_dir);
    let cli_version = package_version(cli_dir);
    if !moved && service_version == cli_version {
        return None;
    }
    Some(Finding {
        id: "version-skew".into(),
        cause: format!("Scout package skew: service={}, CLI={}{}",
            service_version.as_deref().unwrap_or("unknown"),
            cli_version.as_deref().unwrap_or("unknown"),
            if moved { "; service and CLI install directories differ" } else { "" }),
        action: if moved {
            "From the intended installed package, run OPENSCOUT_ALLOW_SHARED_SERVICE_REPOINT=1 scoutd install"
        } else { "Update the service and CLI package, then restart Scout" }.into(),
    })
}

fn top_consumers(config: &Config) -> Vec<String> {
    let candidates = [
        ("base logs", config.support_directory.join("logs/base")),
        ("supervisor logs", config.logs_directory.clone()),
        ("probe logs", config.probe_logs_directory.clone()),
        ("control plane", config.control_home.clone()),
        ("pairing", pairing_home(config)),
        ("web clients", config.support_directory.join("web")),
        ("chat", config.open_scout_home.join("chat")),
    ];
    let mut sizes = Vec::new();
    for (label, root) in candidates {
        // Fair per-root budgets keep a noisy log directory from starving the
        // control-plane observation. At most 3584 entries / ~140 ms total.
        let mut remaining = 512;
        let deadline = Instant::now() + Duration::from_millis(20);
        let (bytes, bounded) = bounded_size(&root, &mut remaining, deadline);
        if bytes > 0 {
            sizes.push((
                bytes,
                format!(
                    "{label} {} MiB{}",
                    bytes >> 20,
                    if bounded { " (bounded estimate)" } else { "" }
                ),
            ));
        }
    }
    sizes.sort_by(|a, b| b.0.cmp(&a.0));
    sizes.into_iter().take(3).map(|(_, text)| text).collect()
}
fn bounded_size(root: &Path, remaining: &mut usize, deadline: Instant) -> (u64, bool) {
    let mut stack = vec![(root.to_path_buf(), 0)];
    let mut size = 0u64;
    let mut bounded = false;
    while let Some((path, depth)) = stack.pop() {
        if *remaining == 0 || Instant::now() >= deadline {
            return (size, true);
        }
        *remaining -= 1;
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if metadata.file_type().is_symlink() {
            continue;
        }
        if metadata.is_file() {
            size = size.saturating_add(metadata.blocks() * 512);
        } else if metadata.is_dir() {
            if depth >= 6 {
                bounded = true;
                continue;
            }
            if let Ok(entries) = fs::read_dir(path) {
                for entry in entries {
                    if stack.len() >= *remaining || Instant::now() >= deadline {
                        bounded = true;
                        break;
                    }
                    if let Ok(entry) = entry {
                        stack.push((entry.path(), depth + 1));
                    }
                }
            }
        }
    }
    (size, bounded)
}
/// Bounded subprocess used only on incident entry or the slow maintenance path.
fn capture(command: &mut Command, timeout: Duration, limit: u64) -> Result<String, String> {
    capture_until(command, timeout, limit, || {
        super::SHUTDOWN_REQUESTED.load(super::Ordering::SeqCst)
    })
}
fn capture_until(
    command: &mut Command,
    timeout: Duration,
    limit: u64,
    cancelled: impl Fn() -> bool,
) -> Result<String, String> {
    if cancelled() {
        return Err("probe cancelled for shutdown".into());
    }
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    let deadline = Instant::now() + timeout;
    loop {
        if cancelled() {
            let _ = child.kill();
            let _ = child.wait();
            return Err("probe cancelled for shutdown".into());
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    return Err(format!("probe exited {status}"));
                }
                let mut bytes = Vec::new();
                if let Some(stdout) = child.stdout.take() {
                    stdout
                        .take(limit + 1)
                        .read_to_end(&mut bytes)
                        .map_err(|e| e.to_string())?;
                }
                if bytes.len() as u64 > limit {
                    return Err("probe output limit".into());
                }
                return String::from_utf8(bytes).map_err(|e| e.to_string());
            }
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(10)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("probe deadline exceeded".into());
            }
        }
    }
}
fn dead(pid: u32) -> bool {
    (unsafe { libc::kill(pid as i32, 0) }) != 0
        && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
}
fn scout_process(pid: u32) -> Option<bool> {
    if dead(pid) {
        return Some(false);
    }
    super::process_command_and_group(pid).map(|(_, cmd)| {
        super::process_snapshot_filter(&cmd)
            || cmd.contains("pairing-runtime-controller")
            || cmd.contains("scout-pairing")
    })
}
#[cfg(target_os = "macos")]
fn boot_time_ms() -> Option<u128> {
    let mut boot = std::mem::MaybeUninit::<libc::timeval>::uninit();
    let mut size = std::mem::size_of::<libc::timeval>();
    let result = unsafe {
        libc::sysctlbyname(
            c"kern.boottime".as_ptr(),
            boot.as_mut_ptr().cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if result != 0 {
        return None;
    }
    let boot = unsafe { boot.assume_init() };
    Some(boot.tv_sec as u128 * 1000 + boot.tv_usec as u128 / 1000)
}
#[cfg(not(target_os = "macos"))]
fn boot_time_ms() -> Option<u128> {
    let text = fs::read_to_string("/proc/uptime").ok()?;
    let uptime = text.split_whitespace().next()?.parse::<f64>().ok()?;
    Some(super::epoch_ms().saturating_sub((uptime * 1000.) as u128))
}
#[derive(Default)]
struct Cleanup {
    stale_errors: Vec<String>,
    temp_errors: Vec<String>,
}
fn unchanged_remove(path: &Path, original: &fs::Metadata) -> Result<(), String> {
    let current = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !current.is_file()
        || current.file_type().is_symlink()
        || current.ino() != original.ino()
        || current.dev() != original.dev()
        || current.mtime() != original.mtime()
        || current.mtime_nsec() != original.mtime_nsec()
        || current.len() != original.len()
    {
        return Err("file changed; preserving it".into());
    }
    fs::remove_file(path).map_err(|e| e.to_string())
}
fn regular_owned(path: &Path) -> Option<fs::Metadata> {
    let metadata = fs::symlink_metadata(path).ok()?;
    (metadata.is_file()
        && !metadata.file_type().is_symlink()
        && metadata.uid() == unsafe { libc::geteuid() }
        && metadata.nlink() == 1)
        .then_some(metadata)
}
fn maintenance(config: &Config, now: u128, boot: Option<u128>) -> Cleanup {
    maintenance_at(
        &pairing_home(config),
        &config.control_home,
        &config.open_scout_home.join("relay"),
        now,
        boot,
        scout_process,
        dead,
        no_holders,
    )
}
fn maintenance_at(
    pairing: &Path,
    control: &Path,
    relay: &Path,
    now: u128,
    boot: Option<u128>,
    scout: impl Fn(u32) -> Option<bool>,
    dead_pid: impl Fn(u32) -> bool,
    unheld: impl Fn(&Path) -> bool,
) -> Cleanup {
    let mut result = Cleanup::default();
    for path in [
        pairing.join("supervisor.pid"),
        pairing.join("runtime.pid"),
        relay.join("on-air.lock"),
    ] {
        let Some(metadata) = regular_owned(&path) else {
            continue;
        };
        if !boot.is_some_and(|boot| {
            metadata.mtime() >= 0
                && (metadata.mtime() as u128 * 1000 + metadata.mtime_nsec() as u128 / 1_000_000)
                    < boot
        }) {
            continue;
        }
        let pid = read_bounded(&path, 4096)
            .and_then(|bytes| String::from_utf8(bytes).ok())
            .and_then(|s| {
                s.trim().parse::<u32>().ok().or_else(|| {
                    serde_json::from_str::<Value>(&s)
                        .ok()
                        .and_then(|v| v.get("pid").and_then(Value::as_u64))
                        .and_then(|n| u32::try_from(n).ok())
                })
            })
            .filter(|p| *p > 1 && *p <= i32::MAX as u32);
        // Locks without pid ownership evidence (e.g. legacy on-air.lock) stay put.
        if pid.is_none() {
            result.stale_errors.push(format!(
                "pre-boot {} has no verifiable pid; preserving it",
                path.file_name().unwrap_or_default().to_string_lossy()
            ));
            continue;
        }
        if !pid.is_some_and(|pid| scout(pid) == Some(false)) {
            continue;
        }
        if let Err(error) = unchanged_remove(&path, &metadata) {
            result.stale_errors.push(format!(
                "stale {}: {error}",
                path.file_name().unwrap_or_default().to_string_lossy()
            ));
        }
    }
    let Ok(entries) = fs::read_dir(control) else {
        return result;
    };
    let mut checked = 0;
    let deadline = Instant::now() + Duration::from_secs(3);
    for entry in entries.take(4096).flatten() {
        if Instant::now() >= deadline {
            break;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let Some((pid, stamp)) = journal_temp(&name) else {
            continue;
        };
        if now.saturating_sub(stamp) < 600_000 || !dead_pid(pid) {
            continue;
        }
        let path = entry.path();
        let Some(metadata) = regular_owned(&path) else {
            continue;
        };
        if metadata.mtime() < 0 || now.saturating_sub(metadata.mtime() as u128 * 1000) < 600_000 {
            continue;
        }
        checked += 1;
        if checked > 20 {
            break;
        }
        // lsof exit 1 means no holders; all other failures preserve the file.
        if !unheld(&path) {
            continue;
        }
        if !dead_pid(pid) {
            continue;
        }
        if let Err(error) = unchanged_remove(&path, &metadata) {
            result.temp_errors.push(format!("orphan {name}: {error}"));
        }
    }
    result
}
fn journal_temp(name: &str) -> Option<(u32, u128)> {
    let middle = name
        .strip_prefix("broker-journal.jsonl.")?
        .strip_suffix(".tmp")?;
    let (pid, stamp) = middle.split_once('.')?;
    if !pid.bytes().all(|c| c.is_ascii_digit()) || !stamp.bytes().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let pid = pid.parse::<u32>().ok()?;
    if pid <= 1 || pid > i32::MAX as u32 {
        return None;
    }
    Some((pid, stamp.parse().ok()?))
}
fn no_holders(path: &Path) -> bool {
    if super::SHUTDOWN_REQUESTED.load(super::Ordering::SeqCst) {
        return false;
    }
    let mut child = match Command::new("/usr/sbin/lsof")
        .args(["-n", "-P", "-t", "--"])
        .arg(path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        if super::SHUTDOWN_REQUESTED.load(super::Ordering::SeqCst) {
            let _ = child.kill();
            let _ = child.wait();
            return false;
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut out = Vec::new();
                let mut errors = Vec::new();
                let read_out = child
                    .stdout
                    .take()
                    .map(|s| s.take(65537).read_to_end(&mut out));
                let read_err = child
                    .stderr
                    .take()
                    .map(|s| s.take(65537).read_to_end(&mut errors));
                return status.code() == Some(1)
                    && matches!(read_out, Some(Ok(_)))
                    && matches!(read_err, Some(Ok(_)))
                    && out.is_empty()
                    && errors.is_empty();
            }
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(10)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
        }
    }
}

pub(super) fn operator_notify_command(config: &Config, body: &str) -> Option<Command> {
    let entry = [
        config.runtime_package_dir.join("bin/scout.mjs"),
        config.runtime_package_dir.join("../cli/src/main.ts"),
    ]
    .into_iter()
    .find(|p| p.is_file())?;
    let mut cmd = Command::new(&config.bun_executable);
    cmd.arg(entry)
        .args([
            "--instance",
            &super::launch_instance(&super::env_nonempty),
            "notify",
            "--as",
            "scoutd-health",
            "--message",
            body,
            "--json",
            "--cwd",
        ])
        .arg(&config.runtime_directory)
        .current_dir(&config.runtime_directory)
        .env_remove("OPENSCOUT_CLIENT_INSTANCE")
        .env("OPENSCOUT_HOME", &config.open_scout_home)
        .env("OPENSCOUT_SUPPORT_DIRECTORY", &config.support_directory)
        .env("OPENSCOUT_BROKER_SOCKET_PATH", &config.broker_socket_path)
        .env("OPENSCOUT_BROKER_URL", &config.broker_url);
    Some(cmd)
}

/// Invoke the exact CLI operator-notify implementation used by notify_operator.
/// This keeps local-admin signing, caller registration and routing in their owner.
pub fn notify(config: &Config, condition: &health_sweep::Condition, runtime_up: bool) -> bool {
    if super::SHUTDOWN_REQUESTED.load(super::Ordering::SeqCst) {
        return false;
    }
    if super::launch_instance(&super::env_nonempty) != "prod"
        && super::env_truthy("OPENSCOUT_HEALTH_SWEEP_TEST_NO_NOTIFY")
    {
        return true;
    }
    let body = format!(
        "Scout health: {}: {}. Action: {}",
        condition.condition, condition.cause, condition.action
    );
    if runtime_up {
        if let Some(mut cmd) = operator_notify_command(config, &body) {
            if capture(&mut cmd, Duration::from_secs(10), 65536).is_ok() {
                return true;
            }
        }
    }

    if super::SHUTDOWN_REQUESTED.load(super::Ordering::SeqCst) {
        return false;
    }
    #[cfg(target_os = "macos")]
    {
        // Body travels as argv, not as executable AppleScript source.
        let mut cmd = Command::new("/usr/bin/osascript");
        cmd.args(["-e","on run argv\ndisplay notification (item 1 of argv) with title \"Scout needs attention\"\nend run","--",&body]);
        return capture(&mut cmd, Duration::from_secs(3), 4096).is_ok();
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};
    fn fixture() -> PathBuf {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let path = env::temp_dir().join(format!(
            "scout-health-{}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }
    fn age(path: &Path, now: u128, age: u128) {
        let time = UNIX_EPOCH + Duration::from_millis((now - age) as u64);
        fs::File::open(path)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(time))
            .unwrap();
    }
    #[test]
    fn temp_name_parser_is_an_exact_allowlist() {
        assert_eq!(
            journal_temp("broker-journal.jsonl.42.1700000000000.tmp"),
            Some((42, 1700000000000))
        );
        for name in [
            "broker-journal.jsonl.42.tmp",
            "other.42.1700000000000.tmp",
            "broker-journal.jsonl.0.10.tmp",
            "broker-journal.jsonl.42.10.extra.tmp",
            "broker-journal.jsonl.42.-10.tmp",
        ] {
            assert_eq!(journal_temp(name), None);
        }
    }
    #[test]
    fn cleanup_requires_preboot_unrelated_or_dead_pid_and_preserves_unknown_owners() {
        let root = fixture();
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis();
        let pid = root.join("supervisor.pid");
        fs::write(&pid, "42\n").unwrap();
        age(&pid, now, 3_600_000);
        let run = |boot, scout| {
            maintenance_at(
                &root,
                &root,
                &root,
                now,
                boot,
                move |_| scout,
                |_| true,
                |_| true,
            )
        };
        run(None, Some(false));
        assert!(pid.exists());
        run(Some(now - 7_200_000), Some(false));
        assert!(pid.exists());
        run(Some(now - 1_800_000), Some(true));
        assert!(pid.exists());
        run(Some(now - 1_800_000), None);
        assert!(pid.exists());
        run(Some(now - 1_800_000), Some(false));
        assert!(!pid.exists());
        let user = root.join("unlisted.pid");
        fs::write(&user, "42").unwrap();
        age(&user, now, 3_600_000);
        let unknown = root.join("on-air.lock");
        fs::write(&unknown, r#"{"agent":"speaker"}"#).unwrap();
        age(&unknown, now, 3_600_000);
        let result = run(Some(now - 1_800_000), Some(false));
        assert!(user.exists());
        assert!(unknown.exists());
        assert_eq!(result.stale_errors.len(), 1);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn orphan_requires_dead_pid_old_timestamp_old_mtime_and_no_holder() {
        let root = fixture();
        let now = super::super::epoch_ms();
        let old = root.join(format!("broker-journal.jsonl.42.{}.tmp", now - 1_200_000));
        fs::write(&old, "orphan").unwrap();
        age(&old, now, 1_200_000);
        let run = |dead, unheld| {
            maintenance_at(
                &root,
                &root,
                &root,
                now,
                Some(now),
                |_| Some(false),
                move |_| dead,
                move |_| unheld,
            )
        };
        run(false, true);
        assert!(old.exists());
        run(true, false);
        assert!(old.exists());
        let fresh = root.join(format!("broker-journal.jsonl.42.{now}.tmp"));
        fs::write(&fresh, "fresh").unwrap();
        let fresh_mtime = root.join(format!("broker-journal.jsonl.42.{}.tmp", now - 1_300_000));
        fs::write(&fresh_mtime, "fresh inode").unwrap();
        let user = root.join("keep.txt");
        fs::write(&user, "keep").unwrap();
        let link = root.join(format!("broker-journal.jsonl.42.{}.tmp", now - 1_400_000));
        std::os::unix::fs::symlink(&user, &link).unwrap();
        run(true, true);
        assert!(!old.exists());
        assert!(fresh.exists());
        assert!(fresh_mtime.exists());
        assert!(link.is_symlink());
        assert_eq!(fs::read_to_string(user).unwrap(), "keep");
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn bounded_inventory_never_walks_symlinks_and_honors_budget() {
        let root = fixture();
        fs::write(root.join("data"), vec![0; 8192]).unwrap();
        let sub = root.join("nested");
        fs::create_dir(&sub).unwrap();
        fs::write(sub.join("data"), vec![1; 8192]).unwrap();
        std::os::unix::fs::symlink(&root, sub.join("cycle")).unwrap();
        let mut budget = 20;
        let (size, bounded) =
            bounded_size(&root, &mut budget, Instant::now() + Duration::from_secs(1));
        assert!(size >= 16384);
        assert!(!bounded);
        let mut budget = 1;
        let (_, bounded) =
            bounded_size(&root, &mut budget, Instant::now() + Duration::from_secs(1));
        assert!(bounded);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn cli_package_follows_symlink_but_never_executes_scout() {
        let root = fixture();
        let bin = root.join("bin");
        let package = root.join("package");
        fs::create_dir(&bin).unwrap();
        fs::create_dir_all(package.join("bin")).unwrap();
        fs::write(
            package.join("package.json"),
            r#"{"name":"@openscout/scout","version":"1.2.3"}"#,
        )
        .unwrap();
        let script = package.join("bin/scout");
        fs::write(&script, "not executed").unwrap();
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
        std::os::unix::fs::symlink(&script, bin.join("scout")).unwrap();
        assert_eq!(
            cli_package(Some(bin.into_os_string())),
            Some(fs::canonicalize(package).unwrap())
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn checkout_packages_share_identity_despite_independent_versions() {
        let root = fixture();
        fs::create_dir_all(root.join("packages/runtime")).unwrap();
        fs::create_dir_all(root.join("packages/cli")).unwrap();
        fs::write(
            root.join("package.json"),
            r#"{"workspaces":["packages/*"]}"#,
        )
        .unwrap();
        fs::write(
            root.join("packages/runtime/package.json"),
            r#"{"name":"@openscout/runtime","version":"1.2.3"}"#,
        )
        .unwrap();
        fs::write(
            root.join("packages/cli/package.json"),
            r#"{"name":"@openscout/scout","version":"4.5.6"}"#,
        )
        .unwrap();
        let service = root.join("packages/runtime");
        let cli = root.join("packages/cli");
        assert!(compare_packages(&service, &cli).is_none());
        let installed = root.join("installed");
        fs::create_dir(&installed).unwrap();
        fs::copy(cli.join("package.json"), installed.join("package.json")).unwrap();
        let mismatch = compare_packages(&service, &installed).unwrap();
        assert!(!mismatch.action.contains("REPOINT"));
        assert!(compare_packages(&installed, &installed).is_none());
        let moved = compare_packages(&installed, &cli).unwrap();
        assert!(moved
            .action
            .contains("OPENSCOUT_ALLOW_SHARED_SERVICE_REPOINT=1"));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn web_discovery_skips_unknown_health_and_accepts_external_health() {
        assert!(
            !observe_web(false, None, true, None, false)
                .unwrap()
                .expected
        );
        assert!(observe_web(false, None, false, None, false).is_none());
        assert!(collect_web(true, None, false, None, |_| panic!(
            "unknown health must not probe web"
        ))
        .is_none());
        let app = observe_web(true, None, true, None, false).unwrap();
        assert!(app.expected && !app.running);
        assert_eq!(app.action, "open Scout.app once");
        let intent = serde_json::json!({"expected":true,"state":"stopped"});
        assert!(
            !observe_web(false, Some(&intent), true, None, false)
                .unwrap()
                .running
        );
        assert!(
            observe_web(false, Some(&intent), true, None, true)
                .unwrap()
                .running
        );
        let running = serde_json::json!({"expected":true,"state":"running"});
        assert!(
            observe_web(false, Some(&running), true, None, false)
                .unwrap()
                .running
        );
    }
    #[test]
    fn external_web_probe_checks_surface_not_just_a_listener() {
        for (body, healthy) in [
            (r#"{"ok":true,"surface":"openscout-web"}"#, true),
            (r#"{"ok":true}"#, false),
        ] {
            let server = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let port = server.local_addr().unwrap().port();
            let task = thread::spawn(move || {
                let (mut stream, _) = server.accept().unwrap();
                let mut request = [0; 4096];
                let count = stream.read(&mut request).unwrap();
                assert!(String::from_utf8_lossy(&request[..count]).contains("GET /api/health"));
                write!(stream, "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n{:x}\r\n{body}\r\n0\r\n\r\n", body.len()).unwrap();
            });
            let snapshot = serde_json::json!({"expected": true, "state": "stopped", "port": port});
            let web = collect_web(true, Some(&snapshot), true, None, |port| {
                probe_web(port, Some("fixture-token"))
            })
            .unwrap();
            assert_eq!(web.running, healthy);
            assert!(web.expected);
            task.join().unwrap();
        }
    }
    #[test]
    fn named_instance_pairing_uses_its_port_block_without_explicit_pairing_port() {
        assert_eq!(instance_service_port(None, None, false, 24400), Some(24420));
        assert_eq!(instance_service_port(None, None, false, 28000), Some(28020));
        assert_eq!(
            instance_service_port(None, Some(29020), false, 28000),
            Some(29020)
        );
        assert_eq!(
            instance_service_port(Some(30020), Some(29020), false, 28000),
            Some(30020)
        );
        assert_eq!(instance_service_port(None, None, true, 43110), Some(43130));
        assert_eq!(instance_service_port(None, None, false, 65530), None);
    }
    #[test]
    fn shutdown_cancels_a_held_notification_probe_promptly() {
        let start = Instant::now();
        let result = capture_until(
            Command::new("/bin/sleep").arg("10"),
            Duration::from_secs(10),
            1024,
            || start.elapsed() >= Duration::from_millis(30),
        );
        assert!(result.unwrap_err().contains("cancelled"));
        assert!(start.elapsed() < Duration::from_millis(500));
    }
    #[test]
    fn bounded_probe_deadline_terminates_only_the_spawned_probe_child() {
        let started = Instant::now();
        assert!(capture(
            Command::new("/bin/sleep").arg("2"),
            Duration::from_millis(20),
            1024
        )
        .is_err());
        assert!(started.elapsed() < Duration::from_secs(1));
    }
}
