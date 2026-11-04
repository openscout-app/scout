//! Bounded asynchronous host probes and notification delivery. Child ownership
//! and all restart decisions remain on the supervisor thread.
use super::{
    health_observations,
    health_sweep::{Condition, NoticeLevel, Observation},
    Config,
};
use std::{
    sync::mpsc::{self, Receiver, SyncSender},
    thread,
    time::{Duration, Instant},
};

const WORKER_RETRY_MIN: Duration = Duration::from_secs(30);
const WORKER_RETRY_MAX: Duration = Duration::from_secs(600);
pub struct RestartBackoff {
    pub failures: u32,
    retry_at: Instant,
    healthy_since: Option<Instant>,
}
impl RestartBackoff {
    pub fn new(now: Instant) -> Self {
        Self {
            failures: 0,
            retry_at: now,
            healthy_since: None,
        }
    }
    pub fn failed(&mut self, now: Instant) -> Duration {
        self.failures = self.failures.saturating_add(1);
        self.healthy_since = None;
        let delay = (WORKER_RETRY_MIN * (1 << self.failures.saturating_sub(1).min(5)))
            .min(WORKER_RETRY_MAX);
        self.retry_at = now + delay;
        delay
    }
    pub fn due(&self, now: Instant) -> bool {
        now >= self.retry_at
    }
    pub fn started(&mut self) {
        self.healthy_since = None;
    }
    pub fn observed(&mut self, now: Instant) {
        // One successful job between deterministic panics is not recovery.
        let since = *self.healthy_since.get_or_insert(now);
        if now.duration_since(since) >= WORKER_RETRY_MAX {
            self.failures = 0;
        }
    }
}

pub enum Job {
    Observe {
        slow: bool,
        now: u128,
        base_pid: u32,
    },
    Notify {
        condition: Condition,
        runtime_up: bool,
    },
}
pub enum Result {
    Disconnected,
    Observed {
        observation: Observation,
        base_pid: u32,
    },
    Notified {
        id: String,
        since: u128,
        level: NoticeLevel,
        delivered: bool,
    },
}
pub struct Worker {
    jobs: SyncSender<Job>,
    results: Receiver<Result>,
    observation_pending: bool,
    pub notification_pending: bool,
    disconnected: bool,
}
impl Worker {
    pub fn start(config: Config) -> Option<Self> {
        let mut collector = health_observations::Collector::default();
        Self::start_with(move |job| match job {
            Job::Observe {
                slow,
                now,
                base_pid,
            } => {
                if let Err(error) = super::maintain_health_sweep_logs(&config) {
                    eprintln!("[scoutd] health sweep log maintenance: {error}");
                }
                let observation =
                    collector.observe(&config, super::fetch_health(&config).body, slow, now);
                if super::health_sweep::disk_level(observation.disk) == 0 {
                    super::prepare_health_reserve(&config);
                }
                Result::Observed {
                    observation,
                    base_pid,
                }
            }
            Job::Notify {
                condition,
                runtime_up,
            } => Result::Notified {
                delivered: health_observations::notify(&config, &condition, runtime_up),
                id: condition.condition,
                since: condition.since,
                level: condition.notice_level,
            },
        })
    }
    pub(super) fn start_with(
        mut execute: impl FnMut(Job) -> Result + Send + 'static,
    ) -> Option<Self> {
        // At most one observation and one notification can be outstanding.
        let (jobs, work) = mpsc::sync_channel(2);
        let (send, results) = mpsc::sync_channel(2);
        thread::Builder::new()
            .name("scoutd-health".into())
            .spawn(move || {
                while let Ok(job) = work.recv() {
                    if super::SHUTDOWN_REQUESTED.load(super::Ordering::SeqCst) {
                        break;
                    }
                    if send.send(execute(job)).is_err() {
                        break;
                    }
                }
            })
            .map_err(|e| eprintln!("[scoutd] health worker unavailable: {e}"))
            .ok()?;
        Some(Self {
            jobs,
            results,
            observation_pending: false,
            notification_pending: false,
            disconnected: false,
        })
    }
    pub fn observe(&mut self, slow: bool, now: u128, base_pid: u32) -> bool {
        if !self.observation_pending
            && self
                .jobs
                .try_send(Job::Observe {
                    slow,
                    now,
                    base_pid,
                })
                .is_ok()
        {
            self.observation_pending = true;
            return true;
        }
        false
    }
    pub fn notify(&mut self, condition: Condition, runtime_up: bool) -> bool {
        if self.notification_pending {
            return false;
        }
        self.notification_pending = self
            .jobs
            .try_send(Job::Notify {
                condition,
                runtime_up,
            })
            .is_ok();
        self.notification_pending
    }
    pub fn poll(&mut self) -> Option<Result> {
        let result = match self.results.try_recv() {
            Ok(result) => result,
            Err(mpsc::TryRecvError::Empty) => return None,
            Err(mpsc::TryRecvError::Disconnected) => {
                if self.disconnected {
                    return None;
                }
                self.disconnected = true;
                self.observation_pending = false;
                self.notification_pending = false;
                return Some(Result::Disconnected);
            }
        };
        match &result {
            Result::Observed { .. } => self.observation_pending = false,
            Result::Notified { .. } => self.notification_pending = false,
            Result::Disconnected => unreachable!("disconnect is returned above"),
        }
        Some(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};
    #[test]
    fn repeated_worker_failures_back_off_even_with_brief_successes() {
        let mut now = Instant::now();
        let mut backoff = RestartBackoff::new(now);
        for (index, seconds) in [30, 60, 120, 240, 480, 600, 600].into_iter().enumerate() {
            assert_eq!(backoff.failed(now), Duration::from_secs(seconds));
            assert_eq!(backoff.failures, index as u32 + 1);
            assert!(!backoff.due(now + Duration::from_secs(seconds - 1)));
            now += Duration::from_secs(seconds);
            assert!(backoff.due(now));
            backoff.started();
            backoff.observed(now + Duration::from_secs(1));
            assert_eq!(backoff.failures, index as u32 + 1);
        }
        backoff.observed(now + WORKER_RETRY_MAX + Duration::from_secs(1));
        assert_eq!(backoff.failures, 0);
        assert_eq!(
            backoff.failed(now + WORKER_RETRY_MAX + Duration::from_secs(1)),
            WORKER_RETRY_MIN
        );
    }
    #[test]
    fn disconnected_worker_is_not_an_empty_channel_and_a_replacement_can_observe() {
        let mut worker = Worker::start_with(|_| panic!("injected health worker failure")).unwrap();
        assert!(worker.observe(true, 0, 42));
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if matches!(worker.poll(), Some(Result::Disconnected)) {
                break;
            }
            assert!(Instant::now() < deadline);
            thread::sleep(Duration::from_millis(1));
        }
        assert!(!worker.observation_pending);
        assert!(!worker.notification_pending);
        assert!(worker.poll().is_none());
        let mut replacement = Worker::start_with(|job| match job {
            Job::Observe { base_pid, .. } => Result::Observed {
                observation: Observation::default(),
                base_pid,
            },
            _ => panic!("unexpected notification"),
        })
        .unwrap();
        assert!(replacement.observe(true, 1, 42));
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if let Some(Result::Observed { base_pid, .. }) = replacement.poll() {
                assert_eq!(base_pid, 42);
                break;
            }
            assert!(Instant::now() < deadline);
            thread::sleep(Duration::from_millis(1));
        }
    }
    #[test]
    fn held_probes_and_delivery_do_not_block_supervision_or_grow_the_queue() {
        let (release, wait) = mpsc::channel();
        let mut worker = Worker::start_with(move |_| {
            wait.recv().unwrap();
            Result::Observed {
                observation: Observation::default(),
                base_pid: 42,
            }
        })
        .unwrap();
        let started = Instant::now();
        assert!(worker.observe(true, 0, 42));
        for _ in 0..1000 {
            assert!(!worker.observe(true, 0, 42));
            assert!(worker.poll().is_none());
        }
        let condition = Condition {
            condition: "disk".into(),
            cause: "low".into(),
            action: "free space".into(),
            since: 0,
            escalated: true,
            notified_at: Some(0),
            notify_after: 0,
            notice_level: NoticeLevel::Recovery,
            notified_level: Some(NoticeLevel::Recovery),
        };
        assert!(worker.notify(condition.clone(), false));
        assert!(!worker.notify(condition, false));
        assert!(started.elapsed() < Duration::from_millis(200));
        // Dropping the worker never joins an in-flight host operation. A blocked
        // worker cannot consume launchd's child-shutdown allowance.
        drop(worker);
        assert!(started.elapsed() < Duration::from_millis(200));
        release.send(()).unwrap();
    }
}
