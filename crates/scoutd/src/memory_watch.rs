//! Memory watch: scoutd watches the memory of every process it started, and of
//! the host, by event.
//!
//! One thread owns a kqueue. It wakes when the host's memory pressure changes
//! (a dispatch memory-pressure source triggers an `EVFILT_USER` event), when a
//! Scout process in the tree exits (`EVFILT_PROC`/`NOTE_EXIT`), and on a
//! sampling timeout that is slow at normal pressure and fast otherwise. A
//! process's size is the kernel's physical footprint, which counts compressed
//! pages that RSS leaves out.
//!
//! The watcher asks a process for a snapshot itself, and only a process that
//! registered a handler is ever signalled. Stopping a process is handed to the
//! supervisor thread, which owns the children; each parent's existing restart
//! brings the stopped process back.
use serde::Serialize;
use std::{
    collections::{HashMap, VecDeque},
    ffi::{c_void, CString},
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicI32, Ordering},
        mpsc::{self, Receiver, Sender},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

/// Set on scout-base, inherited by every Scout process under it: the folder a
/// process registers in and writes its snapshots to.
pub const SNAPSHOT_DIR_ENV: &str = "OPENSCOUT_MEMORY_SNAPSHOT_DIR";
/// The file name, in the OpenScout home, that sets tripwires by role.
pub const TRIPWIRES_FILE: &str = "memory-tripwires.json";
const MB: u64 = 1024 * 1024;
const SNAPSHOT_EVERY: Duration = Duration::from_secs(60);
const STOP_AFTER_SNAPSHOT: Duration = Duration::from_secs(2);
const KILL_AFTER_STOP: Duration = Duration::from_secs(10);
const KILL_AFTER_STOP_CRITICAL: Duration = Duration::from_secs(2);
const STOP_WINDOW: Duration = Duration::from_secs(30 * 60);
const STOPS_PER_WINDOW: usize = 2;
const SAMPLE_NORMAL: Duration = Duration::from_secs(5);
const SAMPLE_PRESSED: Duration = Duration::from_secs(1);
const FILES_KEPT: usize = 48;
const RECENT_KEPT: usize = 20;
const TREE_LIMIT: usize = 512;
const HOST_TOP: usize = 10;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Pressure {
    Normal,
    Warn,
    Critical,
}

impl Pressure {
    /// `kern.memorystatus_vm_pressure_level` uses the dispatch levels: 1, 2, 4.
    fn from_level(level: i32) -> Self {
        match level {
            4 => Pressure::Critical,
            2 => Pressure::Warn,
            _ => Pressure::Normal,
        }
    }
}

/// The size each kind of process is never expected to reach. Crossing it
/// means something is wrong, so the process is recorded and stopped.
///
/// Defaults sit about four times above what each process holds at normal
/// load. `memory-tripwires.json` in the OpenScout home sets a role's tripwire
/// in MB (`{"scout-web": 3072}`, `"default"` for any other role); an env var
/// `OPENSCOUT_MEMORY_TRIPWIRE_<ROLE>_MB` overrides the file. 0 turns one off.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Tripwires {
    file: HashMap<String, u64>,
    env: HashMap<String, u64>,
}

impl Tripwires {
    pub fn new(file_json: Option<&str>, env: impl IntoIterator<Item = (String, String)>) -> Self {
        let file = file_json
            .and_then(|text| serde_json::from_str::<HashMap<String, serde_json::Value>>(text).ok())
            .unwrap_or_default()
            .into_iter()
            .filter_map(|(role, mb)| Some((role, mb.as_u64()?)))
            .collect();
        let env = env
            .into_iter()
            .filter(|(name, _)| name.starts_with("OPENSCOUT_MEMORY_TRIPWIRE_"))
            .filter_map(|(name, mb)| Some((name, mb.trim().parse::<u64>().ok()?)))
            .collect();
        Tripwires { file, env }
    }

    pub fn env_name(role: &str) -> String {
        let key: String = role
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() {
                    c.to_ascii_uppercase()
                } else {
                    '_'
                }
            })
            .collect();
        format!("OPENSCOUT_MEMORY_TRIPWIRE_{key}_MB")
    }

    fn default_mb(role: &str) -> u64 {
        match role {
            "scout-web" | "scout-broker" => 2048,
            _ if role.starts_with("scout") => 512,
            _ => 1024,
        }
    }

    /// The tripwire in MB for a role, 0 when it is off.
    pub fn mb(&self, role: &str) -> u64 {
        self.env
            .get(&Self::env_name(role))
            .or_else(|| self.file.get(role))
            .or_else(|| self.env.get("OPENSCOUT_MEMORY_TRIPWIRE_DEFAULT_MB"))
            .or_else(|| self.file.get("default"))
            .copied()
            .unwrap_or_else(|| Self::default_mb(role))
    }

    fn over(&self, proc: &Proc) -> bool {
        let mb = self.mb(&proc.role);
        mb > 0 && proc.footprint >= mb * MB
    }

    /// Each role in the tree with its tripwire, for the state file.
    pub fn table(&self, procs: &[Proc]) -> std::collections::BTreeMap<String, u64> {
        procs
            .iter()
            .map(|p| (p.role.clone(), self.mb(&p.role)))
            .collect()
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Proc {
    pub pid: i32,
    pub ppid: i32,
    pub role: String,
    pub footprint_mb: u64,
    pub resident_mb: u64,
    pub cpu_ms: u64,
    #[serde(skip)]
    pub footprint: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Reason {
    Tripwire,
    PressureWarn,
    PressureCritical,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "action", rename_all = "kebab-case")]
pub enum Decision {
    /// Record the tree and ask the process for its own snapshot.
    Snapshot {
        pid: i32,
        role: String,
        reason: Reason,
    },
    /// SIGTERM, from the supervisor thread.
    Stop {
        pid: i32,
        role: String,
        reason: Reason,
    },
    /// Still running after its grace: SIGKILL.
    Kill {
        pid: i32,
        role: String,
        reason: Reason,
    },
    /// Over its tripwire, but this role was stopped twice in 30 minutes: keep
    /// it running and keep recording, so a load that regrows at once does not
    /// become a restart loop. Never at critical pressure, where the host's
    /// survival comes first.
    Held {
        pid: i32,
        role: String,
        reason: Reason,
    },
}

impl Decision {
    pub fn target(&self) -> (i32, &str, Reason) {
        match self {
            Decision::Snapshot { pid, role, reason }
            | Decision::Stop { pid, role, reason }
            | Decision::Kill { pid, role, reason }
            | Decision::Held { pid, role, reason } => (*pid, role, *reason),
        }
    }
}

/// What to do about each process at this pressure, given what it did before.
/// Pure: the watcher thread feeds it samples, the tests feed it numbers.
pub struct Policy {
    root: i32,
    last_snapshot: HashMap<i32, Instant>,
    /// pid -> when to stop it, after its snapshot
    pending: HashMap<i32, Instant>,
    /// pid -> when to kill it if it is still there
    stopping: HashMap<i32, Instant>,
    stops: HashMap<String, VecDeque<Instant>>,
}

impl Policy {
    pub fn new(root: i32) -> Self {
        Policy {
            root,
            last_snapshot: HashMap::new(),
            pending: HashMap::new(),
            stopping: HashMap::new(),
            stops: HashMap::new(),
        }
    }

    /// Something is in progress or over a tripwire, so sample quickly.
    pub fn busy(&self, procs: &[Proc], tripwires: &Tripwires) -> bool {
        !self.pending.is_empty()
            || !self.stopping.is_empty()
            || procs
                .iter()
                .any(|p| p.pid != self.root && tripwires.over(p))
    }

    pub fn decide(
        &mut self,
        now: Instant,
        pressure: Pressure,
        procs: &[Proc],
        tripwires: &Tripwires,
    ) -> Vec<Decision> {
        let live: HashMap<i32, &Proc> = procs.iter().map(|p| (p.pid, p)).collect();
        self.last_snapshot.retain(|pid, _| live.contains_key(pid));
        self.pending.retain(|pid, _| live.contains_key(pid));
        self.stopping.retain(|pid, _| live.contains_key(pid));
        for times in self.stops.values_mut() {
            while times
                .front()
                .is_some_and(|at| now.duration_since(*at) >= STOP_WINDOW)
            {
                times.pop_front();
            }
        }
        let critical = pressure == Pressure::Critical;
        let mut out = Vec::new();
        // scoutd itself is never a target.
        let mut candidates: Vec<&Proc> = procs.iter().filter(|p| p.pid != self.root).collect();
        candidates.sort_by(|a, b| b.footprint.cmp(&a.footprint));

        // A stop that was sent and did not take.
        for (pid, kill_at) in self.stopping.iter_mut() {
            if now >= *kill_at {
                out.push(Decision::Kill {
                    pid: *pid,
                    role: live[pid].role.clone(),
                    reason: Reason::Tripwire,
                });
                *kill_at = now + KILL_AFTER_STOP;
            }
        }

        // A snapshot was asked for; now stop it, unless it shrank back under.
        let due: Vec<i32> = self
            .pending
            .iter()
            .filter(|(_, at)| now >= **at)
            .map(|(pid, _)| *pid)
            .collect();
        for pid in due {
            self.pending.remove(&pid);
            let proc = live[&pid];
            if !tripwires.over(proc) {
                continue;
            }
            self.stops
                .entry(proc.role.clone())
                .or_default()
                .push_back(now);
            let grace = if critical {
                KILL_AFTER_STOP_CRITICAL
            } else {
                KILL_AFTER_STOP
            };
            self.stopping.insert(pid, now + grace);
            out.push(Decision::Stop {
                pid,
                role: proc.role.clone(),
                reason: Reason::Tripwire,
            });
        }

        for proc in &candidates {
            if tripwires.over(proc) {
                self.trip(now, proc, critical, &mut out);
            }
        }

        // Under pressure, note the largest even when it is under its tripwire:
        // the record shows who held the host.
        if let Some(proc) = candidates.first() {
            let reason = match pressure {
                Pressure::Warn => Some(Reason::PressureWarn),
                Pressure::Critical => Some(Reason::PressureCritical),
                Pressure::Normal => None,
            };
            if let Some(reason) = reason {
                self.snapshot(now, proc, reason, false, &mut out);
            }
        }
        out
    }

    fn trip(&mut self, now: Instant, proc: &Proc, critical: bool, out: &mut Vec<Decision>) {
        if self.pending.contains_key(&proc.pid) || self.stopping.contains_key(&proc.pid) {
            return;
        }
        let recent = self.stops.get(&proc.role).map_or(0, VecDeque::len);
        if recent < STOPS_PER_WINDOW || critical {
            self.snapshot(now, proc, Reason::Tripwire, true, out);
            self.pending.insert(proc.pid, now + STOP_AFTER_SNAPSHOT);
        } else if self.snapshot(now, proc, Reason::Tripwire, false, out) {
            out.push(Decision::Held {
                pid: proc.pid,
                role: proc.role.clone(),
                reason: Reason::Tripwire,
            });
        }
    }

    /// At most one snapshot a minute per process, unless `force`.
    fn snapshot(
        &mut self,
        now: Instant,
        proc: &Proc,
        reason: Reason,
        force: bool,
        out: &mut Vec<Decision>,
    ) -> bool {
        let recent = self
            .last_snapshot
            .get(&proc.pid)
            .is_some_and(|at| now.duration_since(*at) < SNAPSHOT_EVERY);
        if recent && !force {
            return false;
        }
        self.last_snapshot.insert(proc.pid, now);
        out.push(Decision::Snapshot {
            pid: proc.pid,
            role: proc.role.clone(),
            reason,
        });
        true
    }
}

/// The log line for a decision: what tripped, what happens next, and how to
/// change it. Written for whoever reads the log, person or agent.
pub fn explain(
    decision: &Decision,
    footprint_mb: u64,
    tripwire_mb: u64,
    tripwires_path: &Path,
    record: Option<&Path>,
) -> String {
    let (pid, role, reason) = decision.target();
    let saved = record.map_or(String::new(), |p| format!(" Record: {}.", p.display()));
    let change = format!(
        "To change it, set \"{role}\": <MB> in {} or {}; 0 turns it off.",
        tripwires_path.display(),
        Tripwires::env_name(role)
    );
    let over =
        format!("{role} (pid {pid}) is at {footprint_mb} MB, over its {tripwire_mb} MB tripwire.");
    match decision {
        Decision::Snapshot { .. } if reason == Reason::Tripwire => format!(
            "[scoutd] memory tripwire: {over} Recording it, then stopping it; its parent restarts it.{saved} {change}"
        ),
        Decision::Snapshot { .. } => format!(
            "[scoutd] memory pressure {}: the largest Scout process is {role} (pid {pid}) at {footprint_mb} MB (tripwire {tripwire_mb} MB). Recorded, not stopped.{saved}",
            if reason == Reason::PressureCritical { "critical" } else { "warn" }
        ),
        Decision::Stop { .. } => format!(
            "[scoutd] memory tripwire: stopping {role} (pid {pid}) at {footprint_mb} MB with SIGTERM."
        ),
        Decision::Kill { .. } => format!(
            "[scoutd] memory tripwire: {role} (pid {pid}) did not stop; SIGKILL at {footprint_mb} MB."
        ),
        Decision::Held { .. } => format!(
            "[scoutd] memory tripwire: {over} It was already stopped twice in 30 minutes, so it keeps running; recording once a minute. {change}"
        ),
    }
}

// ---- Host and process readings -------------------------------------------

fn sysctl_by_name<T: Copy>(name: &str) -> Option<T> {
    let name = CString::new(name).ok()?;
    let mut value = std::mem::MaybeUninit::<T>::zeroed();
    let mut len = std::mem::size_of::<T>();
    let result = unsafe {
        libc::sysctlbyname(
            name.as_ptr(),
            value.as_mut_ptr().cast(),
            &mut len,
            std::ptr::null_mut(),
            0,
        )
    };
    (result == 0 && len == std::mem::size_of::<T>()).then(|| unsafe { value.assume_init() })
}

#[repr(C)]
#[derive(Clone, Copy)]
struct SwapUsage {
    total: u64,
    avail: u64,
    used: u64,
    pagesize: u32,
    encrypted: u8,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Host {
    pub pressure: Pressure,
    /// `kern.memorystatus_level`: roughly the percent of memory still available.
    pub available_percent: Option<i32>,
    pub swap_used_mb: Option<u64>,
    pub swap_total_mb: Option<u64>,
    pub memory_mb: Option<u64>,
}

pub fn host() -> Host {
    let swap = sysctl_by_name::<SwapUsage>("vm.swapusage");
    Host {
        pressure: Pressure::from_level(
            sysctl_by_name::<i32>("kern.memorystatus_vm_pressure_level").unwrap_or(1),
        ),
        available_percent: sysctl_by_name::<i32>("kern.memorystatus_level"),
        swap_used_mb: swap.map(|s| s.used / MB),
        swap_total_mb: swap.map(|s| s.total / MB),
        memory_mb: sysctl_by_name::<u64>("hw.memsize").map(|m| m / MB),
    }
}

/// Mach time units per nanosecond, for the CPU times `proc_pid_rusage` reports.
#[allow(deprecated)]
fn timebase() -> (u64, u64) {
    static TIMEBASE: std::sync::OnceLock<(u64, u64)> = std::sync::OnceLock::new();
    *TIMEBASE.get_or_init(|| {
        let mut info = libc::mach_timebase_info { numer: 0, denom: 0 };
        if unsafe { libc::mach_timebase_info(&mut info) } == 0 && info.denom != 0 {
            (info.numer as u64, info.denom as u64)
        } else {
            (1, 1)
        }
    })
}

/// (footprint bytes, resident bytes, cpu ms) from `proc_pid_rusage`.
pub fn usage(pid: i32) -> Option<(u64, u64, u64)> {
    let mut info = std::mem::MaybeUninit::<libc::rusage_info_v4>::zeroed();
    let result = unsafe {
        libc::proc_pid_rusage(
            pid,
            libc::RUSAGE_INFO_V4,
            info.as_mut_ptr() as *mut libc::rusage_info_t,
        )
    };
    if result != 0 {
        return None;
    }
    let info = unsafe { info.assume_init() };
    let (numer, denom) = timebase();
    let cpu_ns = (info.ri_user_time + info.ri_system_time) as u128 * numer as u128 / denom as u128;
    Some((
        info.ri_phys_footprint,
        info.ri_resident_size,
        (cpu_ns / 1_000_000) as u64,
    ))
}

fn pid_list(fill: impl Fn(*mut c_void, i32) -> i32) -> Vec<i32> {
    let mut buffer = vec![0i32; 4096];
    let count = fill(
        buffer.as_mut_ptr().cast(),
        (buffer.len() * std::mem::size_of::<i32>()) as i32,
    );
    if count <= 0 {
        return Vec::new();
    }
    buffer.truncate((count as usize).min(buffer.len()));
    buffer.retain(|pid| *pid > 0);
    buffer
}

pub fn child_pids(pid: i32) -> Vec<i32> {
    pid_list(|buffer, size| unsafe { libc::proc_listchildpids(pid, buffer, size) })
}

fn all_pids() -> Vec<i32> {
    pid_list(|buffer, size| unsafe { libc::proc_listallpids(buffer, size) })
}

/// A process's argv, from `KERN_PROCARGS2`: the same source `ps` reads, so a
/// process that renamed itself (`scout-web`) reads as that name.
pub fn argv(pid: i32) -> Option<Vec<String>> {
    let mut argmax: libc::c_int = 0;
    let mut len = std::mem::size_of::<libc::c_int>();
    let mut mib = [libc::CTL_KERN, libc::KERN_ARGMAX];
    if unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            2,
            (&mut argmax as *mut libc::c_int).cast(),
            &mut len,
            std::ptr::null_mut(),
            0,
        )
    } != 0
    {
        return None;
    }
    let mut buffer = vec![0u8; argmax.max(4096) as usize];
    let mut size = buffer.len();
    let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid];
    if unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            3,
            buffer.as_mut_ptr().cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    } != 0
    {
        return None;
    }
    buffer.truncate(size);
    parse_procargs(&buffer)
}

/// `argc`, then the exec path, NUL padding, then `argc` NUL-ended strings.
fn parse_procargs(buffer: &[u8]) -> Option<Vec<String>> {
    let argc = i32::from_ne_bytes(buffer.get(0..4)?.try_into().ok()?);
    let rest = &buffer[4..];
    let mut i = rest.iter().position(|b| *b == 0)?;
    while i < rest.len() && rest[i] == 0 {
        i += 1;
    }
    let mut args = Vec::new();
    for _ in 0..argc.max(0) {
        if i >= rest.len() {
            break;
        }
        let end = rest[i..]
            .iter()
            .position(|b| *b == 0)
            .map_or(rest.len(), |e| i + e);
        args.push(String::from_utf8_lossy(&rest[i..end]).into_owned());
        i = end + 1;
    }
    Some(args)
}

fn basename(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

/// `scout-web`, `scoutd probes`, `bun pairing-controller.ts`, `claude`.
pub fn role_of(args: &[String]) -> String {
    let Some(first) = args.first() else {
        return "?".into();
    };
    let name = basename(first);
    if name == "scoutd" {
        return match args.get(1).map(String::as_str) {
            Some("probes") => "scoutd probes".into(),
            _ => "scoutd".into(),
        };
    }
    if matches!(name, "bun" | "node") {
        if let Some(script) = args[1..]
            .iter()
            .find(|a| !a.starts_with('-') && a.as_str() != "run")
        {
            return format!("{name} {}", basename(script));
        }
    }
    name.to_string()
}

fn proc_name(pid: i32) -> String {
    let mut buffer = [0u8; 256];
    let len = unsafe { libc::proc_name(pid, buffer.as_mut_ptr().cast(), buffer.len() as u32) };
    if len <= 0 {
        return "?".into();
    }
    String::from_utf8_lossy(&buffer[..len as usize]).into_owned()
}

/// Every process under `root`, with `root` first. Roles are read once per pid.
pub fn tree(root: i32, roles: &mut HashMap<i32, String>) -> Vec<Proc> {
    let mut out = Vec::new();
    let mut queue = VecDeque::from([(root, 0)]);
    while let Some((pid, ppid)) = queue.pop_front() {
        if out.len() >= TREE_LIMIT {
            break;
        }
        let Some((footprint, resident, cpu_ms)) = usage(pid) else {
            continue;
        };
        let role = roles
            .entry(pid)
            .or_insert_with(|| argv(pid).map_or_else(|| proc_name(pid), |a| role_of(&a)))
            .clone();
        out.push(Proc {
            pid,
            ppid,
            role,
            footprint_mb: footprint / MB,
            resident_mb: resident / MB,
            cpu_ms,
            footprint,
        });
        queue.extend(child_pids(pid).into_iter().map(|child| (child, pid)));
    }
    let live: std::collections::HashSet<i32> = out.iter().map(|p| p.pid).collect();
    roles.retain(|pid, _| live.contains(pid));
    out
}

/// The host's largest processes, ours or not: who held the memory.
pub fn host_top(limit: usize) -> Vec<Proc> {
    let mut all: Vec<(i32, u64, u64, u64)> = all_pids()
        .into_iter()
        .filter_map(|pid| usage(pid).map(|(f, r, c)| (pid, f, r, c)))
        .collect();
    all.sort_by(|a, b| b.1.cmp(&a.1));
    all.truncate(limit);
    all.into_iter()
        .map(|(pid, footprint, resident, cpu_ms)| Proc {
            pid,
            ppid: 0,
            role: argv(pid).map_or_else(|| proc_name(pid), |a| role_of(&a)),
            footprint_mb: footprint / MB,
            resident_mb: resident / MB,
            cpu_ms,
            footprint,
        })
        .collect()
}

// ---- The watcher thread ---------------------------------------------------

/// The kqueue the pressure handler wakes; -1 when no watcher runs.
static PRESSURE_KQ: AtomicI32 = AtomicI32::new(-1);
const WAKE_PRESSURE: usize = 1;
const WAKE_STOP: usize = 2;

#[repr(C)]
struct DispatchSourceType {
    _private: [u8; 0],
}

extern "C" {
    static _dispatch_source_type_memorypressure: DispatchSourceType;
    fn dispatch_source_create(
        kind: *const DispatchSourceType,
        handle: usize,
        mask: usize,
        queue: *mut c_void,
    ) -> *mut c_void;
    fn dispatch_get_global_queue(identifier: isize, flags: usize) -> *mut c_void;
    fn dispatch_source_set_event_handler_f(
        source: *mut c_void,
        handler: extern "C" fn(*mut c_void),
    );
    fn dispatch_resume(object: *mut c_void);
}

extern "C" fn on_pressure(_context: *mut c_void) {
    let kq = PRESSURE_KQ.load(Ordering::SeqCst);
    if kq >= 0 {
        trigger(kq, WAKE_PRESSURE);
    }
}

fn kevent_of(ident: usize, filter: i16, flags: u16, fflags: u32) -> libc::kevent {
    libc::kevent {
        ident,
        filter,
        flags,
        fflags,
        data: 0,
        udata: std::ptr::null_mut(),
    }
}

fn trigger(kq: i32, ident: usize) {
    let change = kevent_of(ident, libc::EVFILT_USER, 0, libc::NOTE_TRIGGER);
    unsafe { libc::kevent(kq, &change, 1, std::ptr::null_mut(), 0, std::ptr::null()) };
}

pub struct WatchConfig {
    /// scoutd's pid: the tree under it is what is watched.
    pub root: i32,
    pub snapshot_dir: PathBuf,
    /// The latest reading, rewritten each sample, for atop and doctor.
    pub state_path: PathBuf,
    /// `memory-tripwires.json`; read again whenever it changes.
    pub tripwires_path: PathBuf,
    /// The env the tripwire overrides come from.
    pub env: Vec<(String, String)>,
}

pub struct Watcher {
    kq: i32,
    decisions: Receiver<Decision>,
    thread: Option<JoinHandle<()>>,
}

impl Watcher {
    pub fn start(config: WatchConfig) -> Option<Self> {
        let kq = unsafe { libc::kqueue() };
        if kq < 0 {
            eprintln!("[scoutd] memory watch: kqueue failed");
            return None;
        }
        let changes = [
            kevent_of(
                WAKE_PRESSURE,
                libc::EVFILT_USER,
                libc::EV_ADD | libc::EV_CLEAR,
                0,
            ),
            kevent_of(
                WAKE_STOP,
                libc::EVFILT_USER,
                libc::EV_ADD | libc::EV_CLEAR,
                0,
            ),
        ];
        unsafe {
            libc::kevent(
                kq,
                changes.as_ptr(),
                2,
                std::ptr::null_mut(),
                0,
                std::ptr::null(),
            )
        };
        if PRESSURE_KQ
            .compare_exchange(-1, kq, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
        {
            install_pressure_source();
        }
        let (tx, rx) = mpsc::channel();
        let thread = thread::Builder::new()
            .name("scoutd-memory-watch".into())
            .spawn(move || run(kq, config, tx))
            .ok()?;
        Some(Watcher {
            kq,
            decisions: rx,
            thread: Some(thread),
        })
    }

    /// The next stop or kill for the supervisor thread to carry out.
    pub fn poll(&mut self) -> Option<Decision> {
        self.decisions.try_recv().ok()
    }

    pub fn stop(mut self) {
        trigger(self.kq, WAKE_STOP);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        let _ = PRESSURE_KQ.compare_exchange(self.kq, -1, Ordering::SeqCst, Ordering::SeqCst);
        unsafe { libc::close(self.kq) };
    }
}

/// One process-long source; its handler only wakes whichever watcher runs.
fn install_pressure_source() {
    static INSTALLED: std::sync::Once = std::sync::Once::new();
    INSTALLED.call_once(|| unsafe {
        let source = dispatch_source_create(
            &_dispatch_source_type_memorypressure,
            0,
            0x1 | 0x2 | 0x4, // normal, warn, critical
            dispatch_get_global_queue(0, 0),
        );
        if source.is_null() {
            eprintln!("[scoutd] memory watch: no memory-pressure source; sampling only");
            return;
        }
        dispatch_source_set_event_handler_f(source, on_pressure);
        dispatch_resume(source);
    });
}

fn epoch_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Recent {
    at_ms: u128,
    #[serde(flatten)]
    decision: Decision,
    footprint_mb: u64,
    tripwire_mb: u64,
    message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct State<'a> {
    at_ms: u128,
    host: &'a Host,
    /// Each role in the tree and its tripwire in MB (0 = off).
    tripwires_mb: std::collections::BTreeMap<String, u64>,
    tripwires_file: &'a Path,
    processes: &'a [Proc],
    recent: &'a VecDeque<Recent>,
}

/// The tripwire file, read again only when its modified time changes.
struct TripwireSource {
    path: PathBuf,
    env: Vec<(String, String)>,
    modified: Option<SystemTime>,
    current: Tripwires,
}

impl TripwireSource {
    fn new(path: PathBuf, env: Vec<(String, String)>) -> Self {
        let mut source = TripwireSource {
            path,
            env,
            modified: None,
            current: Tripwires::default(),
        };
        source.load();
        source
    }

    fn load(&mut self) {
        let text = fs::read_to_string(&self.path).ok();
        if let Some(text) = text.as_deref() {
            if serde_json::from_str::<serde_json::Value>(text).is_err() {
                eprintln!(
                    "[scoutd] memory watch: {} is not valid JSON; using the default tripwires",
                    self.path.display()
                );
            }
        }
        self.current = Tripwires::new(text.as_deref(), self.env.clone());
    }

    fn get(&mut self) -> &Tripwires {
        let modified = fs::metadata(&self.path).and_then(|m| m.modified()).ok();
        if modified != self.modified {
            self.modified = modified;
            self.load();
            if modified.is_some() {
                eprintln!(
                    "[scoutd] memory watch: read tripwires from {}",
                    self.path.display()
                );
            }
        }
        &self.current
    }
}

fn run(kq: i32, config: WatchConfig, decisions: Sender<Decision>) {
    let mut policy = Policy::new(config.root);
    let mut tripwires = TripwireSource::new(config.tripwires_path.clone(), config.env.clone());
    let mut roles = HashMap::new();
    let mut watched: HashMap<i32, (String, u64)> = HashMap::new();
    let mut recent: VecDeque<Recent> = VecDeque::new();
    let mut last_pressure = Pressure::Normal;
    let mut interval = Duration::ZERO; // the first reading at once
    let _ = fs::create_dir_all(config.snapshot_dir.join("registered"));
    let mut events: [libc::kevent; 16] = unsafe { std::mem::zeroed() };
    loop {
        let timeout = libc::timespec {
            tv_sec: interval.as_secs() as libc::time_t,
            tv_nsec: interval.subsec_nanos() as libc::c_long,
        };
        let count = unsafe {
            libc::kevent(
                kq,
                std::ptr::null(),
                0,
                events.as_mut_ptr(),
                events.len() as i32,
                &timeout,
            )
        };
        for event in events.iter().take(count.max(0) as usize) {
            match (event.filter, event.ident) {
                (libc::EVFILT_USER, WAKE_STOP) => return,
                (libc::EVFILT_PROC, ident) => {
                    let pid = ident as i32;
                    if let Some((role, footprint)) = watched.remove(&pid) {
                        eprintln!(
                            "[scoutd] memory watch: {role} (pid {pid}) exited; last footprint {} MB",
                            footprint / MB
                        );
                    }
                    let _ = fs::remove_file(registration(&config.snapshot_dir, pid));
                }
                _ => {}
            }
        }

        let host = host();
        let procs = tree(config.root, &mut roles);
        watch_exits(kq, &procs, &mut watched);
        if host.pressure != last_pressure {
            eprintln!(
                "[scoutd] memory watch: pressure {:?} -> {:?} ({}% available, swap {} MB)",
                last_pressure,
                host.pressure,
                host.available_percent.unwrap_or(-1),
                host.swap_used_mb.unwrap_or(0)
            );
            last_pressure = host.pressure;
        }
        let tripwires = tripwires.get().clone();
        let now = Instant::now();
        let made = policy.decide(now, host.pressure, &procs, &tripwires);
        let mut top: Option<Vec<Proc>> = None;
        for decision in made {
            let (pid, role, reason) = decision.target();
            let role = role.to_string();
            let footprint_mb = procs
                .iter()
                .find(|p| p.pid == pid)
                .map_or(0, |p| p.footprint / MB);
            let tripwire_mb = tripwires.mb(&role);
            let record = match &decision {
                Decision::Snapshot { .. } => {
                    let top = top.get_or_insert_with(|| host_top(HOST_TOP));
                    let message = explain(
                        &decision,
                        footprint_mb,
                        tripwire_mb,
                        &config.tripwires_path,
                        None,
                    );
                    let path = write_record(
                        &config.snapshot_dir,
                        &decision,
                        reason,
                        &message,
                        &host,
                        &procs,
                        top,
                    );
                    ask_for_snapshot(&config.snapshot_dir, pid, &procs);
                    path
                }
                Decision::Stop { .. } | Decision::Kill { .. } => {
                    let _ = decisions.send(decision.clone());
                    None
                }
                Decision::Held { .. } => None,
            };
            let message = explain(
                &decision,
                footprint_mb,
                tripwire_mb,
                &config.tripwires_path,
                record.as_deref(),
            );
            eprintln!("{message}");
            recent.push_back(Recent {
                at_ms: epoch_ms(),
                decision,
                footprint_mb,
                tripwire_mb,
                message,
            });
            while recent.len() > RECENT_KEPT {
                recent.pop_front();
            }
        }
        write_state(
            &config.state_path,
            &State {
                at_ms: epoch_ms(),
                host: &host,
                tripwires_mb: tripwires.table(&procs),
                tripwires_file: &config.tripwires_path,
                processes: &procs,
                recent: &recent,
            },
        );
        interval = if host.pressure != Pressure::Normal || policy.busy(&procs, &tripwires) {
            SAMPLE_PRESSED
        } else {
            SAMPLE_NORMAL
        };
    }
}

/// Exit events for the long-lived Scout processes, so a death carries its size.
fn watch_exits(kq: i32, procs: &[Proc], watched: &mut HashMap<i32, (String, u64)>) {
    for proc in procs.iter().filter(|p| p.role.starts_with("scout")) {
        if let Some(entry) = watched.get_mut(&proc.pid) {
            entry.1 = proc.footprint;
            continue;
        }
        let change = kevent_of(
            proc.pid as usize,
            libc::EVFILT_PROC,
            libc::EV_ADD | libc::EV_ONESHOT,
            libc::NOTE_EXIT,
        );
        if unsafe { libc::kevent(kq, &change, 1, std::ptr::null_mut(), 0, std::ptr::null()) } == 0 {
            watched.insert(proc.pid, (proc.role.clone(), proc.footprint));
        }
    }
}

fn registration(dir: &Path, pid: i32) -> PathBuf {
    dir.join("registered").join(pid.to_string())
}

/// SIGUSR2 only to a live process in our tree that registered a handler:
/// to any other process the signal's default action would end it.
fn ask_for_snapshot(dir: &Path, pid: i32, procs: &[Proc]) {
    if procs.iter().any(|p| p.pid == pid) && registration(dir, pid).exists() {
        unsafe { libc::kill(pid, libc::SIGUSR2) };
    }
}

fn write_record(
    dir: &Path,
    decision: &Decision,
    reason: Reason,
    message: &str,
    host: &Host,
    procs: &[Proc],
    top: &[Proc],
) -> Option<PathBuf> {
    let reason = serde_json::to_value(reason)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default();
    let at = epoch_ms();
    let record = serde_json::json!({
        "atMs": at,
        "message": message,
        "decision": decision,
        "host": host,
        "tree": procs,
        "hostTop": top,
    });
    let path = dir.join(format!("scoutd-{at}-{reason}.json"));
    let written = serde_json::to_string_pretty(&record)
        .ok()
        .and_then(|text| fs::write(&path, text).ok());
    prune(dir);
    written.map(|_| path)
}

/// Keep the newest files: ours and the ones the processes wrote.
fn prune(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<(SystemTime, PathBuf)> = entries
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
        .collect();
    files.sort();
    let excess = files.len().saturating_sub(FILES_KEPT);
    for (_, path) in files.into_iter().take(excess) {
        let _ = fs::remove_file(path);
    }
}

fn write_state(path: &Path, state: &State) {
    let Ok(text) = serde_json::to_string(state) else {
        return;
    };
    let tmp = path.with_extension("json.tmp");
    if fs::write(&tmp, text).is_ok() {
        let _ = fs::rename(&tmp, path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn proc(pid: i32, role: &str, mb: u64) -> Proc {
        Proc {
            pid,
            ppid: 1,
            role: role.into(),
            footprint_mb: mb,
            resident_mb: 0,
            cpu_ms: 0,
            footprint: mb * MB,
        }
    }
    fn defaults() -> Tripwires {
        Tripwires::default()
    }
    fn kinds(out: &[Decision]) -> Vec<&'static str> {
        out.iter()
            .map(|d| match d {
                Decision::Snapshot { .. } => "snapshot",
                Decision::Stop { .. } => "stop",
                Decision::Kill { .. } => "kill",
                Decision::Held { .. } => "held",
            })
            .collect()
    }

    #[test]
    fn tripwires_default_by_role_and_follow_the_file_then_the_env() {
        let t = defaults();
        assert_eq!(t.mb("scout-web"), 2048);
        assert_eq!(t.mb("scout-broker"), 2048);
        assert_eq!(t.mb("scout-base"), 512);
        assert_eq!(t.mb("scoutd probes"), 512);
        assert_eq!(t.mb("bun pairing-controller.ts"), 1024);
        let file = r#"{"scout-web": 3072, "default": 700, "scout-base": "lots"}"#;
        let t = Tripwires::new(Some(file), Vec::new());
        assert_eq!(t.mb("scout-web"), 3072);
        assert_eq!(t.mb("bun x.ts"), 700);
        assert_eq!(t.mb("scout-base"), 700);
        let env = vec![
            ("OPENSCOUT_MEMORY_TRIPWIRE_SCOUT_WEB_MB".into(), "0".into()),
            ("PATH".into(), "/bin".into()),
        ];
        let t = Tripwires::new(Some(file), env);
        assert_eq!(t.mb("scout-web"), 0);
        assert_eq!(
            Tripwires::env_name("scoutd probes"),
            "OPENSCOUT_MEMORY_TRIPWIRE_SCOUTD_PROBES_MB"
        );
        assert_eq!(Tripwires::new(Some("not json"), Vec::new()), defaults());
    }

    #[test]
    fn under_its_tripwire_at_normal_pressure_nothing_happens() {
        let mut policy = Policy::new(1);
        let procs = [
            proc(1, "scoutd", 5000),
            proc(2, "scout-web", 2000),
            proc(3, "scout-base", 400),
        ];
        assert!(policy
            .decide(Instant::now(), Pressure::Normal, &procs, &defaults())
            .is_empty());
    }

    #[test]
    fn over_its_tripwire_it_records_then_stops_then_kills_if_it_lingers() {
        let mut policy = Policy::new(1);
        let t = Instant::now();
        let procs = [proc(2, "scout-broker", 2100)];
        let tw = defaults();
        assert_eq!(
            kinds(&policy.decide(t, Pressure::Normal, &procs, &tw)),
            ["snapshot"]
        );
        assert!(policy
            .decide(t + Duration::from_secs(1), Pressure::Normal, &procs, &tw)
            .is_empty());
        assert_eq!(
            kinds(&policy.decide(t + STOP_AFTER_SNAPSHOT, Pressure::Normal, &procs, &tw)),
            ["stop"]
        );
        assert!(policy
            .decide(t + Duration::from_secs(5), Pressure::Normal, &procs, &tw)
            .is_empty());
        let kill_at = t + STOP_AFTER_SNAPSHOT + KILL_AFTER_STOP;
        assert_eq!(
            kinds(&policy.decide(kill_at, Pressure::Normal, &procs, &tw)),
            ["kill"]
        );
    }

    #[test]
    fn a_small_process_trips_at_its_own_smaller_tripwire() {
        let mut policy = Policy::new(1);
        let procs = [proc(2, "scout-listening", 600), proc(3, "scout-web", 600)];
        assert_eq!(
            policy.decide(Instant::now(), Pressure::Normal, &procs, &defaults()),
            [Decision::Snapshot {
                pid: 2,
                role: "scout-listening".into(),
                reason: Reason::Tripwire
            }]
        );
    }

    #[test]
    fn a_process_that_shrinks_back_before_the_stop_is_left_alone() {
        let mut policy = Policy::new(1);
        let t = Instant::now();
        policy.decide(
            t,
            Pressure::Normal,
            &[proc(2, "scout-web", 2100)],
            &defaults(),
        );
        assert!(policy
            .decide(
                t + STOP_AFTER_SNAPSHOT,
                Pressure::Normal,
                &[proc(2, "scout-web", 900)],
                &defaults()
            )
            .is_empty());
    }

    /// Two stops of one role in the window; returns the time after them.
    fn stop_twice(policy: &mut Policy, mut t: Instant) -> Instant {
        for pid in [2, 3] {
            let procs = [proc(pid, "scout-web", 2100)];
            policy.decide(t, Pressure::Normal, &procs, &defaults());
            t += STOP_AFTER_SNAPSHOT;
            assert_eq!(
                kinds(&policy.decide(t, Pressure::Normal, &procs, &defaults())),
                ["stop"]
            );
            t += Duration::from_secs(1);
            policy.decide(t, Pressure::Normal, &[], &defaults()); // it exited; its parent restarted it
        }
        t
    }

    #[test]
    fn after_two_stops_in_the_window_a_role_is_held_not_stopped() {
        let mut policy = Policy::new(1);
        let t = stop_twice(&mut policy, Instant::now());
        let procs = [proc(4, "scout-web", 2100)];
        assert_eq!(
            kinds(&policy.decide(t, Pressure::Normal, &procs, &defaults())),
            ["snapshot", "held"]
        );
        assert!(policy
            .decide(
                t + Duration::from_secs(10),
                Pressure::Normal,
                &procs,
                &defaults()
            )
            .is_empty());
        let later = t + STOP_WINDOW;
        assert_eq!(
            kinds(&policy.decide(later, Pressure::Normal, &procs, &defaults())),
            ["snapshot"]
        );
        assert_eq!(
            kinds(&policy.decide(
                later + STOP_AFTER_SNAPSHOT,
                Pressure::Normal,
                &procs,
                &defaults()
            )),
            ["stop"]
        );
    }

    #[test]
    fn at_critical_pressure_a_held_role_is_stopped_anyway_and_killed_sooner() {
        let mut policy = Policy::new(1);
        let t = stop_twice(&mut policy, Instant::now());
        let procs = [proc(4, "scout-web", 2100)];
        assert_eq!(
            kinds(&policy.decide(t, Pressure::Critical, &procs, &defaults())),
            ["snapshot"]
        );
        let stop_at = t + STOP_AFTER_SNAPSHOT;
        assert_eq!(
            kinds(&policy.decide(stop_at, Pressure::Critical, &procs, &defaults())),
            ["stop"]
        );
        let kill_at = stop_at + KILL_AFTER_STOP_CRITICAL;
        assert_eq!(
            kinds(&policy.decide(kill_at, Pressure::Critical, &procs, &defaults())),
            ["kill"]
        );
    }

    #[test]
    fn under_pressure_the_largest_is_recorded_not_stopped() {
        let mut policy = Policy::new(1);
        let t = Instant::now();
        let procs = [proc(2, "scout-web", 900), proc(3, "scout-broker", 400)];
        assert_eq!(
            policy.decide(t, Pressure::Critical, &procs, &defaults()),
            [Decision::Snapshot {
                pid: 2,
                role: "scout-web".into(),
                reason: Reason::PressureCritical
            }]
        );
        assert!(policy
            .decide(
                t + STOP_AFTER_SNAPSHOT,
                Pressure::Critical,
                &procs,
                &defaults()
            )
            .is_empty());
    }

    #[test]
    fn scoutd_itself_is_never_a_target() {
        let mut policy = Policy::new(1);
        assert!(policy
            .decide(
                Instant::now(),
                Pressure::Critical,
                &[proc(1, "scoutd", 9000)],
                &defaults()
            )
            .is_empty());
    }

    #[test]
    fn a_trip_explains_itself_and_how_to_change_it() {
        let decision = Decision::Snapshot {
            pid: 7,
            role: "scout-web".into(),
            reason: Reason::Tripwire,
        };
        let line = explain(
            &decision,
            2100,
            2048,
            Path::new("/h/memory-tripwires.json"),
            Some(Path::new("/l/r.json")),
        );
        assert!(line.contains("scout-web (pid 7) is at 2100 MB, over its 2048 MB tripwire"));
        assert!(line.contains("Record: /l/r.json"));
        assert!(line.contains("\"scout-web\": <MB> in /h/memory-tripwires.json"));
        assert!(line.contains("OPENSCOUT_MEMORY_TRIPWIRE_SCOUT_WEB_MB"));
        assert!(line.contains("0 turns it off"));
        let held = Decision::Held {
            pid: 7,
            role: "scout-web".into(),
            reason: Reason::Tripwire,
        };
        assert!(explain(&held, 2100, 2048, Path::new("/h/t.json"), None)
            .contains("stopped twice in 30 minutes"));
    }

    #[test]
    fn procargs_parse_to_argv_and_roles() {
        let mut buffer = 3i32.to_ne_bytes().to_vec();
        buffer.extend_from_slice(b"/opt/bun\0\0\0\0scout-web\0server/index.ts\0--flag\0HOME=/x\0");
        let args = parse_procargs(&buffer).unwrap();
        assert_eq!(args, ["scout-web", "server/index.ts", "--flag"]);
        assert_eq!(role_of(&args), "scout-web");
        assert_eq!(
            role_of(&[
                "/usr/local/bin/bun".into(),
                "run".into(),
                "/a/pairing-controller.ts".into()
            ]),
            "bun pairing-controller.ts"
        );
        assert_eq!(
            role_of(&["/x/scoutd".into(), "probes".into(), "serve".into()]),
            "scoutd probes"
        );
    }

    #[test]
    fn reads_this_process_and_its_children_from_the_kernel() {
        let mut child = std::process::Command::new("/bin/sleep")
            .arg("5")
            .spawn()
            .unwrap();
        let me = std::process::id() as i32;
        assert!(child_pids(me).contains(&(child.id() as i32)));
        let mut roles = HashMap::new();
        let procs = tree(me, &mut roles);
        assert_eq!(procs[0].pid, me);
        assert!(procs[0].footprint > 0);
        assert!(procs
            .iter()
            .any(|p| p.pid == child.id() as i32 && p.role == "sleep"));
        assert!(!host_top(3).is_empty());
        assert!(host().memory_mb.unwrap_or(0) > 0);
        child.kill().unwrap();
        let _ = child.wait();
    }

    #[test]
    fn the_watcher_reads_the_tripwire_file_records_a_trip_and_stops_on_request() {
        let dir = std::env::temp_dir().join(format!("scoutd-memory-watch-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let state_path = dir.join("memory-watch.json");
        let tripwires_path = dir.join(TRIPWIRES_FILE);
        // A child that holds 8 MB, against a 4 MB tripwire for its role.
        fs::write(&tripwires_path, r#"{"perl": 4}"#).unwrap();
        let mut child = std::process::Command::new("/usr/bin/perl")
            .args(["-e", "my $x = 'a' x 8_000_000; sleep 10"])
            .spawn()
            .unwrap();
        let mut watcher = Watcher::start(WatchConfig {
            root: std::process::id() as i32,
            snapshot_dir: dir.join("memory"),
            state_path: state_path.clone(),
            tripwires_path,
            env: Vec::new(),
        })
        .unwrap();
        let tripped = || {
            fs::read_dir(dir.join("memory"))
                .map(|d| {
                    d.flatten()
                        .any(|e| e.file_name().to_string_lossy().ends_with("-tripwire.json"))
                })
                .unwrap_or(false)
        };
        let deadline = Instant::now() + Duration::from_secs(8);
        while Instant::now() < deadline && !tripped() {
            thread::sleep(Duration::from_millis(50));
        }
        assert!(tripped());
        let state: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&state_path).unwrap()).unwrap();
        assert_eq!(state["tripwiresMb"]["perl"], 4);
        // The stop comes to the supervisor side; this test carries it out itself.
        let deadline = Instant::now() + Duration::from_secs(8);
        let mut stop = None;
        while Instant::now() < deadline && stop.is_none() {
            stop = watcher
                .poll()
                .filter(|d| matches!(d, Decision::Stop { pid, .. } if *pid == child.id() as i32));
            thread::sleep(Duration::from_millis(50));
        }
        assert!(stop.is_some());
        watcher.stop();
        child.kill().unwrap();
        let _ = child.wait();
        let _ = fs::remove_dir_all(&dir);
    }
}
